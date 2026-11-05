import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {attachedWhere, notFound, ownerScope, valid} from '../lib/http';
import {linkFor, notify, notifyMentions} from '../lib/notify';
import {getSettings} from '../lib/settings';
import {ENTRY_OWNERS, shownEntry} from '../lib/shown-activity';
import {userSelect} from '../lib/users';

/** A timeline entry on records the user may see (owner-only visibility), else 404. */
async function visibleActivity(c: AppContext, id: string): Promise<Prisma.ActivityWhereInput> {
  return {id, AND: [attachedWhere(await ownerScope(c))]};
}

/** Comment threads on any timeline event (notes, calls, meetings, emails…). */
export const comments = new Hono<AppEnv>()
  .get('/activity/:activityId', async (c) => {
    const activity = await c.var.db.activity.findFirst({where: await visibleActivity(c, c.req.param('activityId')), select: {id: true}});
    if (!activity) throw notFound('Activity');
    const rows = await c.var.db.activityComment.findMany({
      where: {activityId: activity.id},
      include: {author: {select: userSelect}},
      orderBy: {createdAt: 'asc'},
      take: 500,
    });
    return c.json({rows});
  })

  .post('/activity/:activityId', valid('json', z.object({body: z.string().trim().min(1).max(5000)})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const activity = await db.activity.findFirst({where: await visibleActivity(c, c.req.param('activityId')), include: {comments: {select: {authorId: true}}, ...ENTRY_OWNERS}});
    if (!activity) throw notFound('Activity');
    const comment = await db.activityComment.create({
      data: {activityId: activity.id, authorId: me.id, body: c.req.valid('json').body},
      include: {author: {select: userSelect}},
    });
    const link = linkFor(activity);
    const mentioned = await notifyMentions(db, comment.body, {actorId: me.id, actorName: me.name, where: 'in a comment', link});
    // The author of the activity and everyone already in the thread.
    const thread = [activity.actorId, ...activity.comments.map((x) => x.authorId)].filter((id): id is string => !!id && id !== me.id && !mentioned.includes(id));
    // Each reader gets the entry as their timeline shows it: its stored title can name a deal or
    // company a member can't see under owner-only visibility (AUDIT-2 L-2).
    const ownerOnly = thread.length > 0 && (await getSettings(db)).recordVisibility === 'owner';
    const members = ownerOnly ? await db.member.findMany({where: {id: {in: thread}}, select: {id: true, role: true}}) : [];
    const readers = ownerOnly ? members.map((m) => ({id: m.id, scope: isAdmin(m) ? {} : {ownerId: m.id}})) : [...new Set(thread)].map((id) => ({id, scope: {}}));
    const groups = new Map<string, {title: string; link: string | null; ids: string[]}>();
    for (const r of readers) {
      const shown = shownEntry(activity, r.scope);
      const entry = {title: `${me.name} commented on ${shown.title}`, link: linkFor(shown)};
      const key = `${entry.title}\n${entry.link}`;
      if (!groups.has(key)) groups.set(key, {...entry, ids: []});
      groups.get(key)!.ids.push(r.id);
    }
    await Promise.all([...groups.values()].map((g) => notify(db, g.ids, {type: 'comment', title: g.title, body: comment.body, link: g.link, actorId: me.id})));
    return c.json({comment}, 201);
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    // Only its author or an admin, on an entry they may see: anyone else gets 404.
    const comment = await c.var.db.activityComment.findFirst({
      where: {id: c.req.param('id'), activity: {AND: [attachedWhere(await ownerScope(c))]}, ...(isAdmin(me) ? {} : {authorId: me.id})},
      select: {id: true},
    });
    if (!comment) throw notFound('Comment');
    await c.var.db.activityComment.delete({where: {id: comment.id}});
    return c.json({ok: true});
  });
