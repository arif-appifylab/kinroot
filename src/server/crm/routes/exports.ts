import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Export} from '../../../generated/prisma/client';
import {ACTIVE_EXPORT, IO_ENTITIES, type ExportRun} from '@/lib/import-export';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, requireRole, type AppEnv} from '../kit/guards';
import {countExport, exportDownloadPath, startExport} from '../lib/exports';
import {kickJobs} from '../lib/jobs';
import {notFound, valid} from '../lib/http';

export const exportJson = (exp: Export): ExportRun => ({
  ...JSON.parse(JSON.stringify(exp)),
  downloadUrl: exp.status === 'done' && exp.fileId ? exportDownloadPath(exp.fileId) : null,
});

const scopeBody = z.object({
  entity: z.enum(['contact', 'company', 'deal']),
  filters: z.record(z.string(), z.string().max(500)).default({}),
  listId: z.string().nullish(),
});

const clean = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v));

/**
 * CSV exports from the list pages. Mounted before the viewer write guard:
 * viewers may export what they can see (everything is scoped by userScope).
 */
export const exports = new Hono<AppEnv>()
  .use('*', requireRole('VIEWER'))

  .get('/', valid('query', z.object({entity: z.enum(['contact', 'company', 'deal']).optional()})), async (c) => {
    const me = currentUser(c);
    const q = c.req.valid('query');
    const rows = await c.var.db.export.findMany({where: {userId: me.id, ...(q.entity ? {entity: q.entity} : {})}, orderBy: {createdAt: 'desc'}, take: 10});
    return c.json({rows: rows.map(exportJson)});
  })

  // How many rows an export with these filters would have (the drawer's summary).
  .post('/count', valid('json', scopeBody), async (c) => {
    const body = c.req.valid('json');
    const count = await countExport(c.var.db, {entity: body.entity, filters: clean(body.filters), listId: body.listId ?? null} as Export, currentUser(c));
    return c.json({count});
  })

  .post('/', valid('json', scopeBody.extend({
    columns: z.array(z.string().max(80)).min(1, 'Pick at least one column').max(200),
    emailMe: z.boolean().default(false),
  })), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const body = c.req.valid('json');
    let listName: string | null = null;
    if (body.listId) {
      if (body.entity !== 'contact') throw new HTTPException(400, {message: 'Only contacts are in lists'});
      const list = await db.contactList.findUnique({where: {id: body.listId}, select: {name: true}});
      if (!list) throw notFound('List');
      listName = list.name;
    }
    const slug = (listName ?? IO_ENTITIES[body.entity].many).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'export';
    const exp = await startExport(db, c, me, {
      entity: body.entity,
      filters: clean(body.filters),
      listId: body.listId ?? null,
      columns: body.columns,
      emailMe: body.emailMe,
      origin: publicOrigin(c.req.raw),
      fileName: `${slug}-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    return c.json({export: exportJson(exp)}, 201);
  })

  .get('/:id', async (c) => {
    const me = currentUser(c);
    const exp = await c.var.db.export.findUnique({where: {id: c.req.param('id')}});
    if (!exp || (exp.userId !== me.id && !isAdmin(me))) throw notFound('Export');
    if (ACTIVE_EXPORT.has(exp.status)) kickJobs();
    return c.json({export: exportJson(exp)});
  });
