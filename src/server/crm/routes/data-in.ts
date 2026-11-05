import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {DataInLogRow, DataInRecord} from '@/lib/data-in';
import {publicOrigin} from '../kit/config';
import {requireRole, type AppEnv} from '../kit/guards';
import {audit, clientIp, fingerprint} from '../lib/audit';
import {DATA_IN_URL_PATH} from '@/lib/data-in-url';
import {dataInSettings, dataInUrlState, handleDataInUrl, regenerateDataInUrl, revealDataInUrl, saveRateLimit, setDataInUrlEnabled} from '../lib/data-in';
import {notFound, valid} from '../lib/http';

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
    key: {name: r.keyName, prefix: r.keyPrefix},
    idempotencyKey: r.idempotencyKey,
    replayed: r.replayed,
    records: (r.records as DataInRecord[] | null) ?? [],
    body: r.body,
    response: r.response,
    createdAt: r.createdAt.toISOString(),
  };
}

const day = (v: string | undefined, end = false) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`) : undefined);

/** The Data in webhook's settings and log (Settings → Webhooks → Incoming). Admins only. */
export const dataIn = new Hono<AppEnv>()
  .use('*', requireRole('ADMIN'))

  /**
   * The Data in URL: an access token in the URL and a signature token as a header. The overview
   * holds masks only; the tokens come from "Show tokens" (audited).
   */
  .get('/url', async (c) => {
    const [state, settings] = await Promise.all([dataInUrlState(c.var.db), dataInSettings(c.var.db)]);
    return c.json({...state, origin: publicOrigin(c.req.raw), rateLimit: settings.rateLimit});
  })

  .post('/url/reveal', async (c) => {
    const db = c.var.db;
    const tokens = await revealDataInUrl(db);
    if (!tokens) throw notFound('Data in URL');
    await audit(db, c, {action: 'data_in.url_revealed', category: 'security', entity: 'data_in', label: 'Data in URL tokens', meta: {fingerprint: await fingerprint(tokens.access), signatureFingerprint: await fingerprint(tokens.signature)}});
    return c.json({accessToken: tokens.access, signatureToken: tokens.signature});
  })

  /** New access and signature tokens: the old URL and header stop working at once. Acts as this admin from now on. */
  .post('/url/regenerate', async (c) => {
    const db = c.var.db;
    const made = await regenerateDataInUrl(db, c.var.user!.id);
    await audit(db, c, {
      action: 'data_in.url_regenerated',
      category: 'security',
      entity: 'data_in',
      label: 'Data in URL',
      meta: {fingerprint: await fingerprint(made.access), ...(made.previous ? {previousFingerprint: await fingerprint(made.previous.access)} : {})},
    });
    return c.json(await dataInUrlState(db));
  })

  /** On (its tokens are made the first time; requests act as this admin) or off (its URLs answer 404). */
  .patch('/url', valid('json', z.object({enabled: z.boolean()})), async (c) => {
    const db = c.var.db;
    const {enabled} = c.req.valid('json');
    const before = await dataInUrlState(db);
    await setDataInUrlEnabled(db, c.var.user!.id, enabled);
    if (before.enabled !== enabled) await audit(db, c, {action: enabled ? 'data_in.url_enabled' : 'data_in.url_disabled', category: 'security', entity: 'data_in', label: 'Data in URL'});
    return c.json(await dataInUrlState(db));
  })

  .patch('/settings', valid('json', z.object({rateLimit: z.number().int().min(1).max(1000)})), async (c) => {
    const db = c.var.db;
    const {rateLimit} = c.req.valid('json');
    const before = await dataInSettings(db);
    await saveRateLimit(db, rateLimit);
    if (before.rateLimit !== rateLimit) await audit(db, c, {action: 'data_in.settings_updated', category: 'settings', entity: 'data_in', label: 'Rate limit', meta: {changes: [{field: 'rateLimit', from: before.rateLimit, to: rateLimit}]}});
    return c.json({rateLimit});
  })

  .get(
    '/logs',
    valid('query', z.object({
      action: z.string().max(40).optional(),
      status: z.enum(['ok', 'failed']).optional(),
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
        ...(from || to ? {createdAt: {...(from ? {gte: from} : {}), ...(to ? {lte: to} : {})}} : {}),
        ...(q.q ? {OR: [{errorCode: {contains: q.q, mode: 'insensitive'}}, {error: {contains: q.q, mode: 'insensitive'}}, {body: {contains: q.q, mode: 'insensitive'}}, {idempotencyKey: q.q}]} : {}),
      };
      const take = 50;
      const rows = await c.var.db.dataInRequest.findMany({where, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: take + 1, ...(q.cursor ? {cursor: {id: q.cursor}, skip: 1} : {})});
      return c.json({rows: rows.slice(0, take).map(logRow), nextCursor: rows.length > take ? rows[take - 1]!.id : null});
    },
  );

/**
 * POST /site-api/crm/public/data-in/<action path>/<access token> with the X-Signature-Token header:
 * the Data in webhook (src/crm/lib/data-in-url.ts). Anything else under /data-in answers 404.
 */
export const dataInPublic = new Hono<AppEnv>().all('/data-in/*', async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const r = await handleDataInUrl(c.var.db, {
    method: c.req.method,
    path: pathname.slice(DATA_IN_URL_PATH.length) || '/',
    headers: c.req.raw.headers,
    body: () => c.req.arrayBuffer(),
    ip: clientIp(c),
    origin: publicOrigin(c.req.raw),
  });
  return c.json(r.body as object, r.status as 200, r.headers);
});
