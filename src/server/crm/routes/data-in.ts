import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {DATA_IN_PATH, dataInBaseUrl, type ApiKeyRow, type DataInLogRow, type DataInOverview, type DataInRecord} from '@/lib/data-in';
import {publicOrigin} from '../kit/config';
import {requireRole, type AppEnv} from '../kit/guards';
import {audit, clientIp, fingerprint} from '../lib/audit';
import {dataInSettings, handleDataIn, maskSecret, newApiKey, rotateSigningSecret, saveRateLimit, signingSecret} from '../lib/data-in';
import {notFound, valid} from '../lib/http';

type KeyWithCreator = Prisma.ApiKeyGetPayload<{include: {createdBy: {select: {id: true; name: true; active: true}}}}>;

const keyRow = (k: KeyWithCreator): ApiKeyRow => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdBy: k.createdBy,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
});

const creator = {createdBy: {select: {id: true, name: true, active: true}}} as const;

function logRow(r: Prisma.DataInRequestGetPayload<object>): DataInLogRow {
  return {
    id: r.id,
    action: r.action,
    method: r.method,
    path: r.path,
    status: r.status,
    errorCode: r.errorCode,
    error: r.error,
    durationMs: r.durationMs,
    key: {id: r.apiKeyId, name: r.keyName, prefix: r.keyPrefix},
    idempotencyKey: r.idempotencyKey,
    replayed: r.replayed,
    records: (r.records as DataInRecord[] | null) ?? [],
    body: r.body,
    response: r.response,
    createdAt: r.createdAt.toISOString(),
  };
}

const day = (v: string | undefined, end = false) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`) : undefined);

/** Data in API settings (Settings → Webhooks → Incoming). Admins only. */
export const dataIn = new Hono<AppEnv>()
  .use('*', requireRole('ADMIN'))

  .get('/', async (c) => {
    const db = c.var.db;
    const [secret, settings, keys, recent] = await Promise.all([
      signingSecret(db),
      dataInSettings(db),
      db.apiKey.findMany({include: creator, orderBy: [{revokedAt: {sort: 'asc', nulls: 'first'}}, {createdAt: 'desc'}]}),
      db.dataInRequest.groupBy({by: ['status'], where: {createdAt: {gte: new Date(Date.now() - 86_400_000)}}, _count: {_all: true}}),
    ]);
    const overview: DataInOverview = {
      baseUrl: dataInBaseUrl(publicOrigin(c.req.raw)),
      secret: {masked: maskSecret(secret), rotatedAt: settings.rotatedAt},
      rateLimit: settings.rateLimit,
      keys: keys.map(keyRow),
      stats: {day: recent.reduce((n, r) => n + r._count._all, 0), failed: recent.filter((r) => r.status >= 400).reduce((n, r) => n + r._count._all, 0)},
    };
    return c.json(overview);
  })

  /** Shows the signing secret (fetched on demand, never in the overview); audited with a fingerprint. */
  .post('/secret/reveal', async (c) => {
    const secret = await signingSecret(c.var.db);
    await audit(c.var.db, c, {action: 'data_in.secret_revealed', category: 'security', entity: 'data_in', label: 'Signing secret', meta: {fingerprint: await fingerprint(secret)}});
    return c.json({secret});
  })

  /** A new signing secret: requests signed with the old one are refused at once. */
  .post('/secret/regenerate', async (c) => {
    const db = c.var.db;
    const old = await signingSecret(db);
    const secret = await rotateSigningSecret(db);
    await audit(db, c, {action: 'data_in.secret_regenerated', category: 'security', entity: 'data_in', label: 'Signing secret', meta: {fingerprint: await fingerprint(secret), previousFingerprint: await fingerprint(old)}});
    const settings = await dataInSettings(db);
    return c.json({secret: {masked: maskSecret(secret), rotatedAt: settings.rotatedAt}});
  })

  .patch('/settings', valid('json', z.object({rateLimit: z.number().int().min(1).max(1000)})), async (c) => {
    const db = c.var.db;
    const {rateLimit} = c.req.valid('json');
    const before = await dataInSettings(db);
    await saveRateLimit(db, rateLimit);
    if (before.rateLimit !== rateLimit) await audit(db, c, {action: 'data_in.settings_updated', category: 'settings', entity: 'data_in', label: 'Rate limit', meta: {changes: [{field: 'rateLimit', from: before.rateLimit, to: rateLimit}]}});
    return c.json({rateLimit});
  })

  /** A new API key. The full key is in this answer only; the database keeps its SHA-256 and prefix. */
  .post('/keys', valid('json', z.object({name: z.string().trim().min(1, 'is required').max(80)})), async (c) => {
    const db = c.var.db;
    const {name} = c.req.valid('json');
    const made = await newApiKey();
    const key = await db.apiKey.create({data: {name, prefix: made.prefix, keyHash: made.hash, createdById: c.var.user!.id}, include: creator});
    await audit(db, c, {action: 'api_key.created', category: 'security', entity: 'api_key', recordId: key.id, label: key.name, meta: {prefix: key.prefix, fingerprint: await fingerprint(made.key)}});
    return c.json({key: keyRow(key), plain: made.key}, 201);
  })

  .delete('/keys/:id', async (c) => {
    const db = c.var.db;
    const found = await db.apiKey.findUnique({where: {id: c.req.param('id')}});
    if (!found) throw notFound('API key');
    const key = found.revokedAt ? await db.apiKey.findUniqueOrThrow({where: {id: found.id}, include: creator}) : await db.apiKey.update({where: {id: found.id}, data: {revokedAt: new Date()}, include: creator});
    if (!found.revokedAt) await audit(db, c, {action: 'api_key.revoked', category: 'security', entity: 'api_key', recordId: key.id, label: key.name, meta: {prefix: key.prefix}});
    return c.json({key: keyRow(key)});
  })

  .get(
    '/logs',
    valid('query', z.object({
      action: z.string().max(40).optional(),
      status: z.enum(['ok', 'failed']).optional(),
      keyId: z.string().max(60).optional(),
      q: z.string().trim().max(100).optional(),
      from: z.string().max(10).optional(),
      to: z.string().max(10).optional(),
      cursor: z.string().max(60).optional(),
    })),
    async (c) => {
      const q = c.req.valid('query');
      const from = day(q.from);
      const to = day(q.to, true);
      const where: Prisma.DataInRequestWhereInput = {
        ...(q.action ? {action: q.action} : {}),
        ...(q.status === 'ok' ? {status: {lt: 400}} : q.status === 'failed' ? {status: {gte: 400}} : {}),
        ...(q.keyId ? {apiKeyId: q.keyId} : {}),
        ...(from || to ? {createdAt: {...(from ? {gte: from} : {}), ...(to ? {lte: to} : {})}} : {}),
        ...(q.q ? {OR: [{errorCode: {contains: q.q, mode: 'insensitive'}}, {error: {contains: q.q, mode: 'insensitive'}}, {body: {contains: q.q, mode: 'insensitive'}}, {keyName: {contains: q.q, mode: 'insensitive'}}, {idempotencyKey: q.q}]} : {}),
      };
      const take = 50;
      const rows = await c.var.db.dataInRequest.findMany({where, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: take + 1, ...(q.cursor ? {cursor: {id: q.cursor}, skip: 1} : {})});
      return c.json({rows: rows.slice(0, take).map(logRow), nextCursor: rows.length > take ? rows[take - 1]!.id : null});
    },
  );

/** POST /site-api/crm/public/data-in/v1/*: anyone with an API key and the signing secret. */
export const dataInPublic = new Hono<AppEnv>().all('/data-in/v1/*', async (c) => {
  const url = new URL(c.req.url);
  const r = await handleDataIn(c.var.db, {
    method: c.req.method,
    path: url.pathname.slice(DATA_IN_PATH.length) || '/',
    headers: c.req.raw.headers,
    body: () => c.req.arrayBuffer(),
    ip: clientIp(c),
    origin: publicOrigin(c.req.raw),
  });
  return c.json(r.body as object, r.status as 200, r.headers);
});
