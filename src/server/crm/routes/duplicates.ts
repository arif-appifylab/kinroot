import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {Prisma} from '../../../generated/prisma/client';
import {currentUser, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {findLikelyDuplicates, lastScans, manualScanRunning, queueManualScan, type DupEntity} from '../lib/duplicates';
import {intParam, MAX_PAGE, notFound, ownerScope, valid} from '../lib/http';
import {userSelect} from '../lib/users';

const entity = z.enum(['contact', 'company']);

const contactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  title: true,
  createdAt: true,
  lastActivityAt: true,
  owner: {select: userSelect},
  companies: {select: {isPrimary: true, company: {select: {id: true, name: true}}}, orderBy: {isPrimary: 'desc'}},
  _count: {select: {deals: true, notes: true}},
} satisfies Prisma.ContactSelect;

const companySelect = {
  id: true,
  name: true,
  domain: true,
  website: true,
  phone: true,
  city: true,
  country: true,
  createdAt: true,
  lastActivityAt: true,
  owner: {select: userSelect},
  _count: {select: {contacts: true, deals: true}},
} satisfies Prisma.CompanySelect;

/** The queue hides low-confidence pairs (e.g. a shared switchboard number) unless asked. */
const MIN_SCORE = 60;

/** Pairs where both records still exist and are visible to the signed-in user. */
async function visiblePairs(c: AppContext, kind: DupEntity, status: 'open' | 'dismissed', page: number, pageSize: number, minScore = MIN_SCORE) {
  const scope = await ownerScope(c);
  const table = Prisma.raw(kind === 'contact' ? '"Contact"' : '"Company"');
  const owner = scope.ownerId ? Prisma.sql`AND a."ownerId" = ${scope.ownerId} AND b."ownerId" = ${scope.ownerId}` : Prisma.empty;
  const from = Prisma.sql`FROM "DuplicatePair" p JOIN ${table} a ON a.id = p."aId" JOIN ${table} b ON b.id = p."bId" WHERE p.entity = ${kind} AND p.status = ${status} AND p.score >= ${minScore} ${owner}`;
  const [rows, [count]] = await Promise.all([
    c.var.db.$queryRaw<{id: string}[]>`SELECT p.id ${from} ORDER BY p.score DESC, p."createdAt" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    c.var.db.$queryRaw<{n: number}[]>`SELECT count(*)::int AS n ${from}`,
  ]);
  return {ids: rows.map((r) => r.id), total: count?.n ?? 0};
}

/**
 * One pair this person may act on: with owner-only visibility both records are theirs, checked in
 * the query (AUDIT-2 L-5), as the queue lists them. Else 404.
 */
async function visiblePair(c: AppContext, id: string) {
  const db = c.var.db;
  const scope = await ownerScope(c);
  if (!scope.ownerId) {
    const pair = await db.duplicatePair.findUnique({where: {id}});
    if (!pair) throw notFound('Duplicate pair');
    return pair;
  }
  const [row] = await db.$queryRaw<{id: string}[]>`
    SELECT p.id FROM "DuplicatePair" p
    LEFT JOIN "Contact" ca ON p.entity = 'contact' AND ca.id = p."aId" LEFT JOIN "Contact" cb ON p.entity = 'contact' AND cb.id = p."bId"
    LEFT JOIN "Company" oa ON p.entity = 'company' AND oa.id = p."aId" LEFT JOIN "Company" ob ON p.entity = 'company' AND ob.id = p."bId"
    WHERE p.id = ${id} AND COALESCE(ca."ownerId", oa."ownerId") = ${scope.ownerId} AND COALESCE(cb."ownerId", ob."ownerId") = ${scope.ownerId}`;
  const pair = row ? await db.duplicatePair.findUnique({where: {id: row.id}}) : null;
  if (!pair) throw notFound('Duplicate pair');
  return pair;
}

/** Duplicate queue (Settings → Duplicates) and the "Possible duplicate" hint in the create dialogs. */
export const duplicates = new Hono<AppEnv>()
  .get('/', valid('query', z.object({entity: entity.default('contact'), status: z.enum(['open', 'dismissed']).default('open'), low: z.enum(['1']).optional(), page: intParam(1, MAX_PAGE).default(1), pageSize: intParam(1, 100).default(25)})), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const {ids, total} = await visiblePairs(c, q.entity, q.status, q.page, q.pageSize, q.low || q.status === 'dismissed' ? 0 : MIN_SCORE);
    const pairs = await db.duplicatePair.findMany({where: {id: {in: ids}}});
    const recordIds = pairs.flatMap((p) => [p.aId, p.bId]);
    const found: {id: string}[] =
      q.entity === 'contact' ? await db.contact.findMany({where: {id: {in: recordIds}}, select: contactSelect}) : await db.company.findMany({where: {id: {in: recordIds}}, select: companySelect});
    const records = new Map(found.map((r) => [r.id, r]));
    const byId = new Map(pairs.map((p) => [p.id, p]));
    const rows = ids.map((id) => byId.get(id)!).map((p) => ({id: p.id, score: p.score, reasons: p.reasons, status: p.status, dismissedAt: p.dismissedAt, a: records.get(p.aId), b: records.get(p.bId)}));
    return c.json({rows, total, page: q.page, pageSize: q.pageSize});
  })

  .get('/counts', async (c) => {
    const [contact, company, low, scans, scanning] = await Promise.all([
      visiblePairs(c, 'contact', 'open', 1, 1),
      visiblePairs(c, 'company', 'open', 1, 1),
      Promise.all([visiblePairs(c, 'contact', 'open', 1, 1, 0), visiblePairs(c, 'company', 'open', 1, 1, 0)]),
      lastScans(c.var.db),
      manualScanRunning(c.var.db),
    ]);
    return c.json({contact: contact.total, company: company.total, lowConfidence: {contact: low[0].total - contact.total, company: low[1].total - company.total}, lastScan: scans, scanning});
  })

  /**
   * "Scan now": a full scan as background jobs (it also runs on its own every few hours), one at a
   * time. Admins only: it compares every record. A click while one is queued or running changes nothing.
   */
  .post('/scan', requireRole('ADMIN'), valid('json', z.object({entity: entity.optional()})), async (c) => {
    const which = c.req.valid('json').entity;
    const queued = await queueManualScan(c.var.db, which ? [which] : ['contact', 'company']);
    if (!queued) return c.json({queued: false, running: true, message: 'A duplicate scan is already running. New matches appear here when it finishes.'});
    return c.json({queued: true}, 202);
  })

  /** Non-blocking hint while creating a record: the best few likely matches. */
  .post(
    '/check',
    valid('json', z.object({
      entity,
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).nullish(),
      email: z.string().max(200).nullish(),
      phone: z.string().max(60).nullish(),
      companyId: z.string().nullish(),
      name: z.string().max(200).optional(),
      domain: z.string().max(200).nullish(),
    })),
    async (c) => {
      const db = c.var.db;
      const body = c.req.valid('json');
      const scope = await ownerScope(c);
      const input = body.entity === 'contact' ? {...body, companyIds: body.companyId ? [body.companyId] : []} : {name: body.name, domain: body.domain};
      const matches = (await findLikelyDuplicates(db, body.entity, input, {ownerId: scope.ownerId, min: 45})).slice(0, 3);
      const ids = matches.map((m) => m.id);
      const labels = new Map<string, {label: string; detail: string | null}>(
        body.entity === 'contact'
          ? (await db.contact.findMany({where: {id: {in: ids}}, select: {id: true, firstName: true, lastName: true, email: true, phone: true}})).map((r) => [r.id, {label: [r.firstName, r.lastName].filter(Boolean).join(' '), detail: r.email ?? r.phone}])
          : (await db.company.findMany({where: {id: {in: ids}}, select: {id: true, name: true, domain: true}})).map((r) => [r.id, {label: r.name, detail: r.domain}]),
      );
      return c.json({matches: matches.map((m) => ({...m, ...labels.get(m.id)}))});
    },
  )

  .post('/:id/dismiss', async (c) => {
    const db = c.var.db;
    const pair = await visiblePair(c, c.req.param('id'));
    if (pair.status === 'dismissed') throw new HTTPException(400, {message: 'Already marked as not a duplicate'});
    await db.duplicatePair.update({where: {id: pair.id}, data: {status: 'dismissed', dismissedById: currentUser(c).id, dismissedAt: new Date()}});
    await audit(db, c, {action: 'duplicate.dismissed', entity: pair.entity, recordId: pair.aId, meta: {pair: [pair.aId, pair.bId], reasons: pair.reasons, score: pair.score}});
    return c.json({ok: true});
  })

  .post('/:id/reopen', async (c) => {
    const db = c.var.db;
    const pair = await visiblePair(c, c.req.param('id'));
    await db.duplicatePair.update({where: {id: pair.id}, data: {status: 'open', dismissedById: null, dismissedAt: null}});
    await audit(db, c, {action: 'duplicate.reopened', entity: pair.entity, recordId: pair.aId, meta: {pair: [pair.aId, pair.bId]}});
    return c.json({ok: true});
  });
