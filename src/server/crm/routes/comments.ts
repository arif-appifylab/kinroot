import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {currentUser, isAdmin, type AppEnv} from '../kit/guards';
import {notFound, valid} from '../lib/http';
import {linkFor, notify, notifyMentions} from '../lib/notify';
import {userSelect} from '../lib/users';

/** Comment threads on any timeline event (notes, calls, meetings, emails…). */
export const comments = new Hono<AppEnv>()
  .get('/activity/:activityId', async (c) => {
    const rows = await c.var.db.activityComment.findMany({
      where: {activityId: c.req.param('activityId')},
      include: {author: {select: userSelect}},
      orderBy: {createdAt: 'asc'},
    });
    return c.json({rows});
  })

  .post('/activity/:activityId', valid('json', z.object({body: z.string().trim().min(1).max(5000)})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const activity = await db.activity.findUnique({where: {id: c.req.param('activityId')}, include: {comments: {select: {authorId: true}}}});
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
    const comment = await c.var.db.activityComment.findUnique({where: {id: c.req.param('id')}});
    if (!comment) throw notFound('Comment');
    if (comment.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the author can delete this comment'});
    await c.var.db.activityComment.delete({where: {id: comment.id}});
    return c.json({ok: true});
  });
