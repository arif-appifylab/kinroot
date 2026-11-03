import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {EVENT_TYPES, eventExample} from '@/lib/events';
import {WEBHOOK_SERVICE_NAMES, webhookLabel, webhookTarget} from '@/lib/webhook-targets';
import {runsJobsLocally} from '../../../platform/background';
import {config} from '../kit/config';
import {decryptJson, encryptJson, randomToken} from '../kit/crypto';
import {requireRole, type AppEnv} from '../kit/guards';
import {audit, fingerprint} from '../lib/audit';
import {notFound, valid} from '../lib/http';
import {enqueue, kickJobs} from '../lib/jobs';
import {deliverWebhook, TEST_ENTITY} from '../lib/webhooks';
import {JOBS_LAST_RUN_KEY} from '../lib/ticks';

const eventList = z.array(z.union([z.literal('*'), z.enum(EVENT_TYPES as [string, ...string[]])])).min(1, 'pick at least one event');
const hookBody = z.object({
  // Only the webhook services written in code (src/crm/lib/webhook-targets.ts): never any URL typed in.
  url: z.string().trim().max(2000).refine((u) => !!webhookTarget(u), `use a webhook URL from ${WEBHOOK_SERVICE_NAMES}`),
  description: z.string().trim().max(200).nullish(),
  events: eventList,
  active: z.boolean().optional(),
});

/** Status numbers stop at this many (shown as "99+"). */
const CAP = 100;

const newSecret = () => `whsec_${randomToken(24)}`;

const hookSelect = {
  id: true,
  url: true,
  description: true,
  events: true,
  active: true,
  failures: true,
  lastStatus: true,
  lastDeliveryAt: true,
  createdAt: true,
} as const;

/** Outbound webhooks (Settings → Webhooks). Admins only. */
export const webhooks = new Hono<AppEnv>()
  .use('*', requireRole('ADMIN'))

  .get('/', async (c) => {
    const db = c.var.db;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [rows, lastRun, waiting] = await Promise.all([
      db.webhook.findMany({orderBy: {createdAt: 'asc'}, select: hookSelect, take: 100}),
      db.setting.findUnique({where: {key: JOBS_LAST_RUN_KEY}}),
      // Jobs run on the platform (its Jobs tab has the history); here: what waits to be sent again. Capped, never count().
      db.jobBacklog.findMany({select: {id: true}, take: CAP}),
    ]);
    const failed = rows.length
      ? await db.webhookDelivery.findMany({where: {webhookId: {in: rows.map((r) => r.id)}, createdAt: {gte: since}, status: 'FAILED'}, select: {id: true}, take: CAP})
      : [];
    return c.json({
      rows,
      jobs: {cronConfigured: true, lastRunAt: (lastRun?.value as string | undefined) ?? null, pending: waiting.length, failed: failed.length, capped: CAP, devTicker: runsJobsLocally()},
    });
  })

  .post('/', valid('json', hookBody), async (c) => {
    const body = c.req.valid('json');
    const secret = newSecret();
    const hook = await c.var.db.webhook.create({
      data: {url: body.url, description: body.description ?? null, events: body.events, active: body.active ?? true, secret: await encryptJson(secret)},
      select: hookSelect,
    });
    await audit(c.var.db, c, {action: 'webhook.created', entity: 'webhook', recordId: hook.id, label: webhookLabel(hook.url), meta: {events: hook.events, signingKey: await fingerprint(secret)}});
    return c.json({webhook: hook, secret}, 201);
  })

  .patch('/:id', valid('json', hookBody.partial()), async (c) => {
    const body = c.req.valid('json');
    const found = await c.var.db.webhook.findUnique({where: {id: c.req.param('id')}, select: {id: true}});
    if (!found) throw notFound('Webhook');
    // Turning a webhook back on gives it a clean slate.
    const data: Prisma.WebhookUpdateInput = {};
    if (body.url !== undefined) data.url = body.url;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.events !== undefined) data.events = body.events;
    if (body.active !== undefined) data.active = body.active;
    const hook = await c.var.db.webhook.update({where: {id: found.id}, data: {...data, ...(body.active ? {failures: 0} : {})}, select: hookSelect});
    await audit(c.var.db, c, {action: 'webhook.updated', entity: 'webhook', recordId: hook.id, label: webhookLabel(hook.url), meta: {changed: Object.keys(data), ...(body.events ? {events: body.events} : {}), ...(body.active !== undefined ? {active: body.active} : {})}});
    return c.json({webhook: hook});
  })

  .delete('/:id', async (c) => {
    const gone = await c.var.db.webhook.findUnique({where: {id: c.req.param('id')}, select: {id: true, url: true, events: true}});
    await c.var.db.webhook.deleteMany({where: {id: c.req.param('id')}});
    if (gone) await audit(c.var.db, c, {action: 'webhook.deleted', entity: 'webhook', recordId: gone.id, label: webhookLabel(gone.url), meta: {events: gone.events}});
    return c.json({ok: true});
  })

  .get('/:id/secret', async (c) => {
    const hook = await c.var.db.webhook.findUnique({where: {id: c.req.param('id')}, select: {id: true, url: true, secret: true}});
    if (!hook) throw notFound('Webhook');
    const secret = await decryptJson<string>(hook.secret);
    await audit(c.var.db, c, {action: 'webhook.secret_revealed', category: 'security', entity: 'webhook', recordId: hook.id, label: webhookLabel(hook.url), meta: {signingKey: await fingerprint(secret)}});
    return c.json({secret});
  })

  .post('/:id/rotate', async (c) => {
    const secret = newSecret();
    const hook = await c.var.db.webhook.update({where: {id: c.req.param('id')}, data: {secret: await encryptJson(secret)}, select: {id: true, url: true}}).catch(() => null);
    if (!hook) throw notFound('Webhook');
    await audit(c.var.db, c, {action: 'webhook.secret_rotated', category: 'security', entity: 'webhook', recordId: hook.id, label: webhookLabel(hook.url), meta: {signingKey: await fingerprint(secret)}});
    return c.json({secret});
  })

  /**
   * Sends a signed example of one event type right away (the same body the
   * payload preview shows, plus `X-Webhook-Test: true`) and reports what the
   * endpoint answered. It lands in the delivery log like any other delivery.
   */
  .post('/:id/test', valid('json', z.object({type: z.enum(EVENT_TYPES as [string, ...string[]]).optional()})), async (c) => {
    const db = c.var.db;
    const hook = await db.webhook.findUnique({where: {id: c.req.param('id')}});
    if (!hook) throw notFound('Webhook');
    if (!hook.active) throw new HTTPException(400, {message: 'Turn the webhook on first'});
    const type = c.req.valid('json').type ?? hook.events.find((e) => e !== '*') ?? 'contact.created';
    const data = JSON.parse(JSON.stringify(eventExample(type) ?? {})) as Prisma.InputJsonValue;
    // Stored as an Event so the log can show it, but never emit()ted: automations and scoring don't see it.
    const event = await db.event.create({data: {type, entity: TEST_ENTITY, recordId: hook.id, data}});
    const delivery = await db.webhookDelivery.create({data: {webhookId: hook.id, eventId: event.id, eventType: event.type}});
    await deliverWebhook(db, delivery.id, true).catch(() => {});
    const result = await db.webhookDelivery.findUniqueOrThrow({where: {id: delivery.id}});
    return c.json({delivery: result});
  })

  .get('/:id/deliveries', async (c) => {
    const rows = await c.var.db.webhookDelivery.findMany({
      where: {webhookId: c.req.param('id')},
      orderBy: {createdAt: 'desc'},
      take: 50,
      include: {event: {select: {data: true, createdAt: true, entity: true}}},
    });
    return c.json({rows});
  })

  .post('/deliveries/:id/redeliver', async (c) => {
    const db = c.var.db;
    const delivery = await db.webhookDelivery.findUnique({where: {id: c.req.param('id')}});
    if (!delivery) throw notFound('Delivery');
    await db.webhookDelivery.update({where: {id: delivery.id}, data: {status: 'PENDING', error: null}});
    await enqueue(db, 'webhook.deliver', {deliveryId: delivery.id});
    kickJobs();
    return c.json({ok: true});
  });
