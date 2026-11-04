import {Hono} from 'hono';
import {z} from 'zod';

import {currentUser, isAdmin, type AppEnv} from '../kit/guards';
import {notFound, valid} from '../lib/http';

const entity = z.enum(['CONTACT', 'COMPANY', 'DEAL']);

export const views = new Hono<AppEnv>()
  .get('/', valid('query', z.object({entity})), async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.savedView.findMany({
      where: {entity: c.req.valid('query').entity, OR: [{ownerId: me.id}, {shared: true}]},
      orderBy: {createdAt: 'asc'},
    });
    return c.json({rows});
  })

  .post('/', valid('json', z.object({entity, name: z.string().trim().min(1).max(60), filters: z.record(z.string().max(60), z.string().max(2000)), shared: z.boolean().default(false)})), async (c) => {
    const me = currentUser(c);
    const view = await c.var.db.savedView.create({data: {...c.req.valid('json'), ownerId: me.id}});
    return c.json({view}, 201);
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    // Only its creator or an admin; anyone else gets 404 (the owner condition is in the query).
    const view = await c.var.db.savedView.findFirst({where: {id: c.req.param('id'), ...(isAdmin(me) ? {} : {ownerId: me.id})}, select: {id: true}});
    if (!view) throw notFound('View');
    await c.var.db.savedView.delete({where: {id: view.id}});
    return c.json({ok: true});
  });
