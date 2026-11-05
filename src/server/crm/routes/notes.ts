import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {assertVisible, attachedWhere, notFound, ownerScope, valid} from '../lib/http';
import {linkFor, mentionedUsersIn, notifyMentions, notifyWatchers} from '../lib/notify';
import {userSelect} from '../lib/users';

const link = {contactId: z.string().max(40).nullish(), companyId: z.string().max(40).nullish(), dealId: z.string().max(40).nullish()};

/**
 * A note by `author` on one or more records: timeline entry, `note.created`,
 * @mention and follower notifications. Shared by this route and the Data in webhook.
 */
export async function createNote(
  db: Db,
  input: {body: string; pinned?: boolean; contactId?: string | null; companyId?: string | null; dealId?: string | null},
  author: {id: string; name: string},
  opts: {source?: {kind: string; name: string}} = {},
) {
  const note = await db.note.create({data: {...input, authorId: author.id}, include: {author: {select: userSelect}}});
  const records = {contactId: input.contactId, companyId: input.companyId, dealId: input.dealId};
  await logActivity(db, {type: 'note', title: 'Note added', refId: note.id, actorId: author.id, ...records, data: {body: note.body.slice(0, 2000), ...(opts.source ? {source: opts.source} : {})}, text: note.body});
  await emit(db, 'note.created', {recordId: note.id, actorId: author.id, data: note});
  const mentioned = await notifyMentions(db, note.body, {actorId: author.id, actorName: author.name, where: 'in a note', link: linkFor(note)});
  await notifyWatchers(db, note, {type: 'activity', title: (record) => `${author.name} added a note on ${record}`, body: note.body, actorId: author.id, except: mentioned});
  return note;
}

/** Notes the user may act on: on records they may see, and (`own`) their own unless they are an admin. */
async function noteWhere(c: AppContext, id: string, own: boolean): Promise<Prisma.NoteWhereInput> {
  const me = currentUser(c);
  return {id, AND: [attachedWhere(await ownerScope(c))], ...(own && !isAdmin(me) ? {authorId: me.id} : {})};
}

export const notes = new Hono<AppEnv>()
  .get('/', valid('query', z.object(link)), async (c) => {
    const q = c.req.valid('query');
    const or = [q.contactId && {contactId: q.contactId}, q.companyId && {companyId: q.companyId}, q.dealId && {dealId: q.dealId}].filter((x) => !!x);
    if (!or.length) return c.json({rows: []});
    await assertVisible(c, q);
    const rows = await c.var.db.note.findMany({
      where: {OR: or},
      include: {author: {select: userSelect}},
      orderBy: [{pinned: 'desc'}, {createdAt: 'desc'}],
      take: 500,
    });
    return c.json({rows});
  })

  .post('/', valid('json', z.object({body: z.string().trim().min(1).max(20000), pinned: z.boolean().optional(), ...link})), async (c) => {
    const me = currentUser(c);
    const body = c.req.valid('json');
    if (!body.contactId && !body.companyId && !body.dealId) throw new HTTPException(400, {message: 'A note must belong to a record'});
    await assertVisible(c, body);
    const note = await createNote(c.var.db, body, me);
    return c.json({note}, 201);
  })

  .patch('/:id', valid('json', z.object({body: z.string().trim().min(1).max(20000).optional(), pinned: z.boolean().optional()})), async (c) => {
    const me = currentUser(c);
    const patch = c.req.valid('json');
    // Pinning is open to anyone who sees the note; editing its words only to its author or an admin (404 otherwise).
    const existing = await c.var.db.note.findFirst({where: await noteWhere(c, c.req.param('id'), !!patch.body)});
    if (!existing) throw notFound('Note');
    const note = await c.var.db.note.update({where: {id: existing.id}, data: patch, include: {author: {select: userSelect}}});
    await c.var.db.activity.updateMany({where: {type: 'note', refId: note.id}, data: {data: {body: note.body.slice(0, 2000), pinned: note.pinned}, text: note.body.slice(0, 5000)}});
    if (patch.body) {
      // Only people newly mentioned by the edit hear about it.
      const [before, after] = await mentionedUsersIn(c.var.db, [existing.body, note.body]);
      const already = new Set(before);
      const added = after!.filter((id) => !already.has(id));
      if (added.length) await notifyMentions(c.var.db, note.body, {actorId: me.id, actorName: me.name, where: 'in a note', link: linkFor(note), only: added});
    }
    return c.json({note});
  })

  .delete('/:id', async (c) => {
    const existing = await c.var.db.note.findFirst({where: await noteWhere(c, c.req.param('id'), true), select: {id: true}});
    if (!existing) throw notFound('Note');
    await c.var.db.note.delete({where: {id: existing.id}});
    await c.var.db.activity.deleteMany({where: {type: 'note', refId: existing.id}});
    return c.json({ok: true});
  });
