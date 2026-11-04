import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {actionLabel, AUDIT_CATEGORIES, AUDIT_RETENTION_DAYS, type AuditCategory} from '@/lib/hygiene';
import {requireRole, type AppEnv} from '../kit/guards';
import {audit, getAuditSettings, saveAuditSettings} from '../lib/audit';
import {intParam, MAX_PAGE, valid} from '../lib/http';
import {csv} from './import-export';

const filters = z.object({
  actorId: z.string().optional(),
  category: z.enum(Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]]).optional(),
  action: z.string().max(80).optional(),
  entity: z.string().max(40).optional(),
  recordId: z.string().max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().trim().max(200).optional(),
});

function auditWhere(f: z.infer<typeof filters>): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.actorId) and.push({actorId: f.actorId});
  if (f.category) and.push({category: f.category});
  if (f.action) and.push({action: f.action});
  if (f.entity) and.push({entity: f.entity});
  if (f.recordId) and.push({recordId: f.recordId});
  // Dates are whole days in UTC; "to" includes that day.
  if (f.from) and.push({createdAt: {gte: new Date(`${f.from}T00:00:00Z`)}});
  if (f.to) and.push({createdAt: {lt: new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)}});
  if (f.q) {
    and.push({
      OR: [
        {label: {contains: f.q, mode: 'insensitive'}},
        {action: {contains: f.q, mode: 'insensitive'}},
        {actorName: {contains: f.q, mode: 'insensitive'}},
        {actorEmail: {contains: f.q, mode: 'insensitive'}},
        {ip: {startsWith: f.q}},
        {recordId: f.q},
      ],
    });
  }
  return {AND: and};
}

/** Settings → Audit log. Admins only. */
export const auditRoutes = new Hono<AppEnv>()
  .use('*', requireRole('ADMIN'))

  .get('/', valid('query', filters.extend({page: intParam(1, MAX_PAGE).default(1), pageSize: intParam(1, 200).default(50)})), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const where = auditWhere(q);
    const [rows, total, actions, settings] = await Promise.all([
      db.auditLog.findMany({where, orderBy: {createdAt: 'desc'}, skip: (q.page - 1) * q.pageSize, take: q.pageSize}),
      db.auditLog.count({where}),
      db.auditLog.groupBy({by: ['action'], _count: {_all: true}, orderBy: {action: 'asc'}}),
      getAuditSettings(db),
    ]);
    // Import / export entries link to their files (uploads, error rows, exports) while those still exist (7 days).
    const fileIds = rows.flatMap((r) => (/^(import|export)\./.test(r.action) ? (['fileId', 'errorFileId'] as const).flatMap((k) => {
      const v = (r.meta as Record<string, unknown>)[k];
      return typeof v === 'string' ? [v] : [];
    }) : []));
    const liveFiles = fileIds.length ? (await db.file.findMany({where: {id: {in: fileIds}}, select: {id: true}})).map((f) => f.id) : [];
    return c.json({rows, total, page: q.page, pageSize: q.pageSize, actions: actions.map((a) => a.action), settings, liveFiles});
  })

  .get('/export.csv', valid('query', filters), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const rows = await db.auditLog.findMany({where: auditWhere(q), orderBy: {createdAt: 'desc'}, take: 50_000});
    await audit(db, c, {action: 'export.csv', entity: 'audit', label: 'Audit log', meta: {rows: rows.length, filters: q}});
    const body = csv(
      rows.map((r) => ({...r, what: actionLabel(r.action), meta: JSON.stringify(r.meta)})),
      ['createdAt', 'actorName', 'actorEmail', 'category', 'action', 'what', 'entity', 'recordId', 'label', 'ip', 'userAgent', 'meta'],
    );
    return new Response(body, {
      headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`},
    });
  })

  .put('/settings', valid('json', z.object({retentionDays: z.number().int().refine((d) => (AUDIT_RETENTION_DAYS as readonly number[]).includes(d), 'pick one of the offered periods')})), async (c) => {
    const db = c.var.db;
    const before = await getAuditSettings(db);
    const next = {retentionDays: c.req.valid('json').retentionDays};
    await saveAuditSettings(db, next);
    await audit(db, c, {action: 'settings.audit', meta: {from: before.retentionDays, to: next.retentionDays}});
    return c.json({settings: next});
  });


