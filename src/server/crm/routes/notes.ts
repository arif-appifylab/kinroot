import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Db} from '../kit/db';
import {currentUser, isAdmin, type AppEnv} from '../kit/guards';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {notFound, valid} from '../lib/http';
import {linkFor, mentionedUsers, notifyMentions, notifyWatchers} from '../lib/notify';
import {userSelect} from '../lib/users';

const link = {contactId: z.string().nullish(), companyId: z.string().nullish(), dealId: z.string().nullish()};

/**
 * A note by `author` on one or more records: timeline entry, `note.created`,
 * @mention and follower notifications. Shared by this route and the Data in API.
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

export const notes = new Hono<AppEnv>()
  .get('/', valid('query', z.object(link)), async (c) => {
    const q = c.req.valid('query');
    const rows = await c.var.db.note.findMany({
      where: {OR: [q.contactId && {contactId: q.contactId}, q.companyId && {companyId: q.companyId}, q.dealId && {dealId: q.dealId}].filter(Boolean) as object[]},
      include: {author: {select: userSelect}},
      orderBy: [{pinned: 'desc'}, {createdAt: 'desc'}],
    });
    return c.json({rows});
  })

  .post('/', valid('json', z.object({body: z.string().trim().min(1).max(20000), pinned: z.boolean().optional(), ...link})), async (c) => {
    const me = currentUser(c);
    const body = c.req.valid('json');
    if (!body.contactId && !body.companyId && !body.dealId) throw new HTTPException(400, {message: 'A note must belong to a record'});
    const note = await createNote(c.var.db, body, me);
    return c.json({note}, 201);
  })

  .patch('/:id', valid('json', z.object({body: z.string().trim().min(1).max(20000).optional(), pinned: z.boolean().optional()})), async (c) => {
    const me = currentUser(c);
    const existing = await c.var.db.note.findUnique({where: {id: c.req.param('id')}});
    if (!existing) throw notFound('Note');
    const patch = c.req.valid('json');
    if (patch.body && existing.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the author can edit this note'});
    const note = await c.var.db.note.update({where: {id: existing.id}, data: patch, include: {author: {select: userSelect}}});
    await c.var.db.activity.updateMany({where: {type: 'note', refId: note.id}, data: {data: {body: note.body.slice(0, 2000), pinned: note.pinned}, text: note.body.slice(0, 5000)}});
    if (patch.body) {
      // Only people newly mentioned by the edit hear about it.
      const already = new Set(await mentionedUsers(c.var.db, existing.body));
      const added = (await mentionedUsers(c.var.db, note.body)).filter((id) => !already.has(id));
      if (added.length) await notifyMentions(c.var.db, note.body, {actorId: me.id, actorName: me.name, where: 'in a note', link: linkFor(note), only: added});
    }
    return c.json({note});
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    const existing = await c.var.db.note.findUnique({where: {id: c.req.param('id')}});
    if (!existing) throw notFound('Note');
    if (existing.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the author can delete this note'});
    await c.var.db.note.delete({where: {id: existing.id}});
    await c.var.db.activity.deleteMany({where: {type: 'note', refId: existing.id}});
    return c.json({ok: true});
  });
