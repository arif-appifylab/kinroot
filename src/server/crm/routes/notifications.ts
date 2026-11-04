import {Hono} from 'hono';
import {z} from 'zod';

import {currentUser, type AppContext, type AppEnv} from '../kit/guards';
import {assertVisible, notFound, valid} from '../lib/http';
import {userSelect} from '../lib/users';

const entity = z.enum(['CONTACT', 'COMPANY', 'DEAL']);

/**
 * The `:entity/:id` record, when the user may see it (owner-only visibility): following a record
 * sends its notes and changes to the follower, so it must be one they could open. Else 404.
 */
async function followable(c: AppContext) {
  const e = entity.safeParse(c.req.param('entity')?.toUpperCase());
  if (!e.success) throw notFound();
  const id = c.req.param('id')!;
  await assertVisible(c, e.data === 'CONTACT' ? {contactId: id} : e.data === 'COMPANY' ? {companyId: id} : {dealId: id});
  return e.data;
}

/** The signed-in user's bell, plus following records. */
export const notifications = new Hono<AppEnv>()
  .get('/', valid('query', z.object({unread: z.enum(['1']).optional()})), async (c) => {
    const me = currentUser(c);
    const q = c.req.valid('query');
    const [rows, unread] = await Promise.all([
      c.var.db.notification.findMany({
        where: {userId: me.id, ...(q.unread ? {readAt: null} : {})},
        include: {actor: {select: userSelect}},
        orderBy: {createdAt: 'desc'},
        take: 50,
      }),
      c.var.db.notification.count({where: {userId: me.id, readAt: null}}),
    ]);
    return c.json({rows, unread});
  })

  .get('/count', async (c) => {
    const me = currentUser(c);
    const [unread, latest] = await Promise.all([
      c.var.db.notification.count({where: {userId: me.id, readAt: null}}),
      c.var.db.notification.findFirst({where: {userId: me.id}, orderBy: {createdAt: 'desc'}, select: {id: true}}),
    ]);
    return c.json({unread, latestId: latest?.id ?? null});
  })

  /** Marks the given notifications (or all of them) as read. */
  .post('/read', valid('json', z.object({ids: z.array(z.string()).max(200).optional()})), async (c) => {
    const me = currentUser(c);
    const {ids} = c.req.valid('json');
    await c.var.db.notification.updateMany({where: {userId: me.id, readAt: null, ...(ids ? {id: {in: ids}} : {})}, data: {readAt: new Date()}});
    return c.json({ok: true});
  })

  .delete('/', async (c) => {
    await c.var.db.notification.deleteMany({where: {userId: currentUser(c).id, readAt: {not: null}}});
    return c.json({ok: true});
  })

  .get('/follow/:entity/:id', async (c) => {
    const me = currentUser(c);
    const e = await followable(c);
    const followers = await c.var.db.follow.findMany({where: {entity: e, recordId: c.req.param('id')}, include: {user: {select: userSelect}}, take: 200});
    return c.json({following: followers.some((f) => f.userId === me.id), followers: followers.map((f) => f.user)});
  })

  .post('/follow/:entity/:id', async (c) => {
    const me = currentUser(c);
    const e = await followable(c);
    const key = {userId: me.id, entity: e, recordId: c.req.param('id')};
    await c.var.db.follow.upsert({where: {userId_entity_recordId: key}, create: key, update: {}});
    return c.json({following: true});
  })

  .delete('/follow/:entity/:id', async (c) => {
    const me = currentUser(c);
    // Unfollowing is always allowed (it only removes the user's own row).
    const e = entity.safeParse(c.req.param('entity').toUpperCase());
    if (!e.success) throw notFound();
    await c.var.db.follow.deleteMany({where: {userId: me.id, entity: e.data, recordId: c.req.param('id')}});
    return c.json({following: false});
  });
