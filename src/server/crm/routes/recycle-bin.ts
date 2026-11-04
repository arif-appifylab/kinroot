import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {DeletedRecord, Prisma} from '../../../generated/prisma/client';
import {BIN_ENTITIES, type BinEntity} from '@/lib/hygiene';
import {currentUser, isAdmin, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {audit, auditMany} from '../lib/audit';
import {checkDuplicates} from '../lib/duplicates';
import {notFound, valid} from '../lib/http';
import {purgeBinEntries, RestoreConflict, restoreFromBin} from '../lib/recycle-bin';

const entity = z.enum(Object.keys(BIN_ENTITIES) as [BinEntity, ...BinEntity[]]);
const ids = z.array(z.string()).min(1).max(200);

/** Members see (and restore) what they deleted; admins see everything. */
const binScope = (c: AppContext): Prisma.DeletedRecordWhereInput => (isAdmin(currentUser(c)) ? {} : {deletedById: currentUser(c).id});

const listSelect = {id: true, entity: true, recordId: true, label: true, detail: true, counts: true, deletedById: true, deletedByName: true, deletedAt: true, expiresAt: true} as const;

/** In-app path of a restored record. */
function recordPath(entry: Pick<DeletedRecord, 'entity' | 'recordId' | 'label'>) {
  const id = entry.recordId;
  switch (entry.entity as BinEntity) {
    case 'contact': return `/contacts/${id}`;
    case 'company': return `/companies/${id}`;
    case 'deal': return `/deals/${id}`;
    case 'ticket': return `/tickets/${entry.label.match(/^#(\d+)/)?.[1] ?? id}`;
    case 'form': return `/forms/${id}`;
    case 'list': return `/lists/${id}`;
    case 'conversation': return `/inbox?thread=${id}`;
  }
}

async function restoreOne(c: AppContext, entry: DeletedRecord) {
  const me = currentUser(c);
  const db = c.var.db;
  try {
    const result = await restoreFromBin(db, entry, {id: me.id, name: me.name});
    await audit(db, c, {action: `${entry.entity}.restored`, entity: entry.entity, recordId: entry.recordId, label: entry.label, meta: {deletedAt: entry.deletedAt, deletedBy: entry.deletedByName, ...(Object.keys(result.skipped).length ? {skipped: result.skipped} : {})}});
    if (entry.entity === 'contact' || entry.entity === 'company') await checkDuplicates(db, entry.entity, entry.recordId);
    return {id: entry.id, entity: entry.entity, recordId: entry.recordId, label: entry.label, path: recordPath(entry), warning: result.warning};
  } catch (e) {
    if (e instanceof RestoreConflict) throw new HTTPException(409, {message: `${entry.label}: ${e.message}`});
    throw e;
  }
}

/** Settings → Recycle bin. */
export const recycleBin = new Hono<AppEnv>()
  .get('/', valid('query', z.object({entity: entity.optional(), q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50)})), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const scope = binScope(c);
    const where: Prisma.DeletedRecordWhereInput = {
      ...scope,
      ...(q.entity ? {entity: q.entity} : {}),
      ...(q.q ? {OR: [{label: {contains: q.q, mode: 'insensitive'}}, {detail: {contains: q.q, mode: 'insensitive'}}]} : {}),
    };
    const [rows, total, byEntity] = await Promise.all([
      db.deletedRecord.findMany({where, select: listSelect, orderBy: {deletedAt: 'desc'}, skip: (q.page - 1) * q.pageSize, take: q.pageSize}),
      db.deletedRecord.count({where}),
      db.deletedRecord.groupBy({by: ['entity'], where: scope, _count: {_all: true}}),
    ]);
    return c.json({rows, total, page: q.page, pageSize: q.pageSize, counts: Object.fromEntries(byEntity.map((g) => [g.entity, g._count._all]))});
  })

  .post('/:id/restore', async (c) => {
    const entry = await c.var.db.deletedRecord.findFirst({where: {id: c.req.param('id'), ...binScope(c)}});
    if (!entry) throw notFound('Deleted record');
    return c.json({restored: await restoreOne(c, entry)});
  })

  /** Several at once. Each restores on its own, so one conflict doesn't block the rest. */
  .post('/restore', valid('json', z.object({ids})), async (c) => {
    const entries = await c.var.db.deletedRecord.findMany({where: {id: {in: c.req.valid('json').ids}, ...binScope(c)}, orderBy: {deletedAt: 'asc'}});
    const restored = [];
    const failed: {id: string; error: string}[] = [];
    for (const entry of entries) {
      try {
        restored.push(await restoreOne(c, entry));
      } catch (e) {
        // Our own words (a conflict says what is in the way); never a database error's text.
        if (e instanceof HTTPException) failed.push({id: entry.id, error: e.message});
        else {
          console.error('[bin] restore', entry.entity, String((e as Error)?.message ?? e).slice(0, 200));
          failed.push({id: entry.id, error: `${entry.label}: could not be restored. Try again, or ask an admin.`});
        }
      }
    }
    return c.json({restored, failed});
  })

  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const entry = await db.deletedRecord.findUnique({where: {id: c.req.param('id')}, select: {id: true, entity: true, recordId: true, label: true, fileIds: true}});
    if (!entry) throw notFound('Deleted record');
    await purgeBinEntries(db, [entry]);
    await audit(db, c, {action: 'bin.purged', entity: entry.entity, recordId: entry.recordId, label: entry.label});
    return c.json({ok: true});
  })

  .post('/purge', requireRole('ADMIN'), valid('json', z.object({ids})), async (c) => {
    const db = c.var.db;
    const entries = await db.deletedRecord.findMany({where: {id: {in: c.req.valid('json').ids}}, select: {id: true, entity: true, recordId: true, label: true, fileIds: true}});
    await purgeBinEntries(db, entries);
    await auditMany(db, c, entries.map((e) => ({action: 'bin.purged', entity: e.entity, recordId: e.recordId, label: e.label})));
    return c.json({purged: entries.length});
  });
