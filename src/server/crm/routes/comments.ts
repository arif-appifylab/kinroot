import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {attachedWhere, notFound, ownerScope, valid} from '../lib/http';
import {linkFor, notify, notifyMentions} from '../lib/notify';
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
    const activity = await db.activity.findFirst({where: await visibleActivity(c, c.req.param('activityId')), include: {comments: {select: {authorId: true}}}});
    if (!activity) throw notFound('Activity');
    const comment = await db.activityComment.create({
      data: {activityId: activity.id, authorId: me.id, body: c.req.valid('json').body},
      include: {author: {select: userSelect}},
    });
    const link = linkFor(activity);
    const mentioned = await notifyMentions(db, comment.body, {actorId: me.id, actorName: me.name, where: 'in a comment', link});
    // The author of the activity and everyone already in the thread.
    const thread = [activity.actorId, ...activity.comments.map((x) => x.authorId)].filter((id) => id && !mentioned.includes(id));
    await notify(db, thread, {type: 'comment', title: `${me.name} commented on ${activity.title}`, body: comment.body, link, actorId: me.id});
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
