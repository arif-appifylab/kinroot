import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {IncomingWebhook, Prisma} from '../../../generated/prisma/client';
import {
  IN_ACTION_KEYS,
  inConfig,
  LISTEN_MINUTES,
  type IncomingRequestRow,
  type IncomingWebhookRow,
  type InConfig,
  type InRequestStatus,
  type InResult,
} from '@/lib/incoming-webhooks';
import {publicOrigin} from '../kit/config';
import {decryptJson, encryptJson, randomToken} from '../kit/crypto';
import {requireRole, type AppEnv} from '../kit/guards';
import {audit, clientIp, fingerprint} from '../lib/audit';
import {notFound, valid} from '../lib/http';
import {enqueue, kickJobs} from '../lib/jobs';
import {receiveIncoming, tokenHash} from '../lib/incoming-webhooks';

const id = z.string().max(60);
const configSchema = z.object({
  mapping: z.array(z.object({path: z.string().trim().max(200), target: z.string().max(80)})).max(100),
  fixed: z.array(z.object({target: z.string().max(80), value: z.string().max(2000)})).max(50),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20),
  listId: id.nullable(),
  owner: z.object({mode: z.enum(['none', 'user', 'round_robin']), userId: id.nullish(), userIds: z.array(id).max(50).optional(), next: z.number().int().min(0).optional()}),
  mode: z.enum(['upsert', 'create', 'update']),
  skipBlanks: z.boolean(),
  deal: z.object({pipelineId: id.nullable(), stageId: id.nullable(), title: z.string().max(200)}),
  ticket: z.object({subject: z.string().max(300), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']), category: z.string().max(100).nullable()}),
  idempotencyPath: z.string().trim().max(200),
  rateLimit: z.number().int().min(1).max(1000),
});

const hookBody = z.object({
  name: z.string().trim().min(1, 'is required').max(100),
  action: z.enum(IN_ACTION_KEYS as [string, ...string[]]),
  active: z.boolean().optional(),
  config: configSchema.partial().optional(),
  verify: z.enum(['none', 'header', 'hmac']).optional(),
  verifyHeader: z.string().trim().max(100).regex(/^[A-Za-z0-9-]*$/, 'letters, digits and dashes only').nullish(),
  verifyEncoding: z.enum(['hex', 'base64']).nullish(),
  /** Write-only: a new shared secret / HMAC key, or null to remove it. Never returned. */
  secret: z.string().min(8, 'use at least 8 characters').max(500).nullish(),
});

const newToken = () => randomToken(32);
const hookUrl = (origin: string, token: string) => `${origin}/site-api/crm/public/hooks/${token}`;

async function toRow(origin: string, h: IncomingWebhook, stats: {day: number; failed: number} = {day: 0, failed: 0}): Promise<IncomingWebhookRow> {
  const token = await decryptJson<string>(h.token).catch(() => '');
  const listening = !!h.listenUntil && h.listenUntil > new Date();
  return {
    id: h.id,
    name: h.name,
    active: h.active,
    action: h.action as IncomingWebhookRow['action'],
    config: inConfig(h.config),
    verify: (h.verify as IncomingWebhookRow['verify']) ?? 'none',
    verifyHeader: h.verifyHeader,
    verifyEncoding: (h.verifyEncoding as IncomingWebhookRow['verifyEncoding']) ?? null,
    hasSecret: !!h.secret,
    url: token ? hookUrl(origin, token) : '',
    listening,
    listenUntil: listening ? h.listenUntil!.toISOString() : null,
    sample: (h.sample as IncomingWebhookRow['sample']) ?? null,
    sampleAt: h.sampleAt?.toISOString() ?? null,
    lastRequestAt: h.lastRequestAt?.toISOString() ?? null,
    lastStatus: (h.lastStatus as InRequestStatus | null) ?? null,
    createdAt: h.createdAt.toISOString(),
    stats,
  };
}

const BODY_PREVIEW = 4000;

function requestRow(r: Prisma.IncomingWebhookRequestGetPayload<object>): IncomingRequestRow {
  const pretty = r.payload === null ? null : JSON.stringify(r.payload, null, 2);
  return {
    id: r.id,
    status: r.status as InRequestStatus,
    createdAt: r.createdAt.toISOString(),
    processedAt: r.processedAt?.toISOString() ?? null,
    contentType: r.contentType,
    size: r.size,
    error: r.error,
    attempts: r.attempts,
    result: (r.result as InResult | null) ?? null,
    headers: (r.headers as Record<string, string>) ?? {},
    body: pretty === null ? null : pretty.slice(0, BODY_PREVIEW),
    truncated: (pretty?.length ?? 0) > BODY_PREVIEW,
  };
}

/** Readable audit meta for a config change: which settings changed, never a secret. */
function configChanges(before: InConfig, after: InConfig) {
  return (Object.keys(after) as (keyof InConfig)[]).filter((k) => k !== 'owner' || JSON.stringify({...before.owner, next: 0}) !== JSON.stringify({...after.owner, next: 0})).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/** Incoming webhooks (Settings → Webhooks → Incoming). Admins only. */
export const incomingWebhooks = new Hono<AppEnv>()
  .use('*', requireRole('ADMIN'))

  .get('/', async (c) => {
    const db = c.var.db;
    const rows = await db.incomingWebhook.findMany({orderBy: {createdAt: 'asc'}});
    const since = new Date(Date.now() - 86_400_000);
    const counts = rows.length
      ? await db.incomingWebhookRequest.groupBy({by: ['webhookId', 'status'], where: {createdAt: {gte: since}, webhookId: {in: rows.map((r) => r.id)}}, _count: {_all: true}})
      : [];
    const origin = publicOrigin(c.req.raw);
    const stats = (hookId: string) => {
      const mine = counts.filter((x) => x.webhookId === hookId && x.status !== 'captured');
      return {day: mine.reduce((n, x) => n + x._count._all, 0), failed: mine.filter((x) => x.status === 'failed' || x.status === 'rejected').reduce((n, x) => n + x._count._all, 0)};
    };
    return c.json({rows: await Promise.all(rows.map((r) => toRow(origin, r, stats(r.id))))});
  })

  .post('/', valid('json', hookBody), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const token = newToken();
    const config = {...inConfig({}), ...body.config} as InConfig;
    const hook = await db.incomingWebhook.create({
      data: {
        name: body.name,
        action: body.action,
        active: body.active ?? true,
        config: config as Prisma.InputJsonValue,
        token: await encryptJson(token),
        tokenHash: await tokenHash(token),
        verify: body.verify ?? 'none',
        verifyHeader: body.verifyHeader || null,
        verifyEncoding: body.verifyEncoding || null,
        secret: body.secret ? await encryptJson(body.secret) : null,
        createdById: c.var.user?.id ?? null,
      },
    });
    await audit(db, c, {action: 'incoming_webhook.created', category: 'settings', entity: 'incoming_webhook', recordId: hook.id, label: hook.name, meta: {action: hook.action, verify: hook.verify, url: await fingerprint(token)}});
    return c.json({webhook: await toRow(publicOrigin(c.req.raw), hook)}, 201);
  })

  .get('/:id', async (c) => {
    const hook = await c.var.db.incomingWebhook.findUnique({where: {id: c.req.param('id')}});
    if (!hook) throw notFound('Incoming webhook');
    return c.json({webhook: await toRow(publicOrigin(c.req.raw), hook)});
  })

  .patch('/:id', valid('json', hookBody.partial()), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const before = await db.incomingWebhook.findUnique({where: {id: c.req.param('id')}});
    if (!before) throw notFound('Incoming webhook');
    const oldConfig = inConfig(before.config);
    const config = body.config ? ({...oldConfig, ...body.config, owner: {...body.config.owner, next: body.config.owner?.next ?? oldConfig.owner.next}} as InConfig) : undefined;
    const verify = body.verify ?? before.verify;
    const header = body.verifyHeader === undefined ? before.verifyHeader : body.verifyHeader || null;
    const hasSecret = body.secret === undefined ? !!before.secret : !!body.secret;
    if (verify !== 'none' && (!header || !hasSecret)) throw new HTTPException(400, {message: verify === 'hmac' ? 'Name the signature header and set the signing key' : 'Name the header and set the secret'});
    const hook = await db.incomingWebhook.update({
      where: {id: before.id},
      data: {
        name: body.name,
        action: body.action,
        active: body.active,
        config: config as Prisma.InputJsonValue | undefined,
        verify: body.verify,
        verifyHeader: body.verifyHeader === undefined ? undefined : body.verifyHeader || null,
        verifyEncoding: body.verifyEncoding === undefined ? undefined : body.verifyEncoding || null,
        secret: body.secret === undefined ? undefined : body.secret ? await encryptJson(body.secret) : null,
      },
    });
    const changed = [
      ...(['name', 'action', 'active', 'verify', 'verifyHeader', 'verifyEncoding'] as const).filter((k) => body[k] !== undefined && (body[k] ?? null) !== (before[k] ?? null)),
      ...(config ? configChanges(oldConfig, config).map((k) => `config.${k}`) : []),
    ];
    if (changed.length) {
      const basic = Object.fromEntries((['name', 'action', 'active', 'verify', 'verifyHeader', 'verifyEncoding'] as const).filter((k) => changed.includes(k)).map((k) => [k, {from: before[k], to: hook[k]}]));
      await audit(db, c, {action: 'incoming_webhook.updated', category: 'settings', entity: 'incoming_webhook', recordId: hook.id, label: hook.name, meta: {changed, ...basic}});
    }
    if (body.secret !== undefined) {
      await audit(db, c, {action: 'incoming_webhook.secret_changed', category: 'security', entity: 'incoming_webhook', recordId: hook.id, label: hook.name, meta: {verify: hook.verify, signingKey: body.secret ? await fingerprint(body.secret) : null, removed: !body.secret}});
    }
    return c.json({webhook: await toRow(publicOrigin(c.req.raw), hook)});
  })

  .delete('/:id', async (c) => {
    const db = c.var.db;
    const gone = await db.incomingWebhook.findUnique({where: {id: c.req.param('id')}, select: {id: true, name: true, action: true}});
    await db.incomingWebhook.deleteMany({where: {id: c.req.param('id')}});
    if (gone) await audit(db, c, {action: 'incoming_webhook.deleted', category: 'settings', entity: 'incoming_webhook', recordId: gone.id, label: gone.name, meta: {action: gone.action}});
    return c.json({ok: true});
  })

  /** A new secret URL; the old one stops working at once. */
  .post('/:id/regenerate', async (c) => {
    const db = c.var.db;
    const token = newToken();
    const hook = await db.incomingWebhook.update({where: {id: c.req.param('id')}, data: {token: await encryptJson(token), tokenHash: await tokenHash(token)}}).catch(() => null);
    if (!hook) throw notFound('Incoming webhook');
    await audit(db, c, {action: 'incoming_webhook.url_regenerated', category: 'security', entity: 'incoming_webhook', recordId: hook.id, label: hook.name, meta: {url: await fingerprint(token)}});
    return c.json({webhook: await toRow(publicOrigin(c.req.raw), hook)});
  })

  /** "Listen for a test request": the next request to the URL is kept as the sample and writes nothing. */
  .post('/:id/listen', valid('json', z.object({on: z.boolean()})), async (c) => {
    const {on} = c.req.valid('json');
    const hook = await c.var.db.incomingWebhook
      .update({where: {id: c.req.param('id')}, data: {listenUntil: on ? new Date(Date.now() + LISTEN_MINUTES * 60_000) : null}})
      .catch(() => null);
    if (!hook) throw notFound('Incoming webhook');
    return c.json({webhook: await toRow(publicOrigin(c.req.raw), hook)});
  })

  .delete('/:id/sample', async (c) => {
    const n = await c.var.db.$executeRaw`UPDATE "IncomingWebhook" SET sample = NULL, "sampleAt" = NULL WHERE id = ${c.req.param('id')}`;
    if (!n) throw notFound('Incoming webhook');
    return c.json({ok: true});
  })

  .get('/:id/requests', valid('query', z.object({status: z.string().max(20).optional()})), async (c) => {
    const {status} = c.req.valid('query');
    const rows = await c.var.db.incomingWebhookRequest.findMany({
      where: {webhookId: c.req.param('id'), ...(status ? {status} : {})},
      orderBy: {createdAt: 'desc'},
      take: 50,
    });
    return c.json({rows: rows.map(requestRow)});
  })

  .post('/requests/:id/retry', async (c) => {
    const db = c.var.db;
    const req = await db.incomingWebhookRequest.findUnique({where: {id: c.req.param('id')}, include: {webhook: {select: {id: true, name: true}}}});
    if (!req) throw notFound('Request');
    if (req.status !== 'failed') throw new HTTPException(400, {message: 'Only failed requests can be retried'});
    await db.incomingWebhookRequest.update({where: {id: req.id}, data: {status: 'accepted', error: null, processedAt: null}});
    await enqueue(db, 'incoming_webhook.process', {requestId: req.id});
    kickJobs();
    await audit(db, c, {action: 'incoming_webhook.request_retried', category: 'settings', entity: 'incoming_webhook', recordId: req.webhook.id, label: req.webhook.name, meta: {requestId: req.id}});
    return c.json({ok: true});
  });

/** POST /site-api/crm/public/hooks/:token: anyone with the secret URL. */
export const incomingHooksPublic = new Hono<AppEnv>()
  .post('/hooks/:token', async (c) => {
    const r = await receiveIncoming(c.var.db, {
      token: c.req.param('token'),
      headers: c.req.raw.headers,
      body: () => c.req.arrayBuffer(),
      query: new URL(c.req.url).searchParams,
      ip: clientIp(c),
    });
    return c.json(r.body, r.status);
  })
  .on(['GET', 'PUT', 'PATCH', 'DELETE'], '/hooks/:token', (c) => c.json({ok: false, error: 'Send a POST request to this URL'}, 405));
