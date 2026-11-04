import type {Prisma} from '../../../generated/prisma/client';
import {WEBHOOK_SERVICE_NAMES, webhookTarget} from '@/lib/webhook-targets';
import {decryptJson} from '../kit/crypto';
import type {Db} from '../kit/db';
import {enqueue} from './jobs';

/** A webhook is switched off after this many deliveries in a row fail for good. */
const DISABLE_AFTER = 20;

/** Event.entity of test deliveries: no real record behind them, never emitted to automations or scoring. */
export const TEST_ENTITY = 'webhook';

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Body: {id, type, createdAt, data}. Signature header:
 *   X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * Receivers recompute it with the webhook's secret and reject old timestamps.
 */
export async function signPayload(secret: string, body: string, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${await hmacHex(secret, `${at}.${body}`)}`;
}

function webhookBody(event: {id: string; type: string; createdAt: Date; data: unknown}) {
  return JSON.stringify({id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: event.data});
}

/** One HTTP attempt. Throws on failure so the job runner retries with backoff. */
export async function deliverWebhook(db: Db, deliveryId: string, final: boolean) {
  const delivery = await db.webhookDelivery.findUnique({where: {id: deliveryId}, include: {webhook: true, event: true}});
  if (!delivery || delivery.status === 'SUCCESS') return;
  const {webhook, event} = delivery;
  if (!webhook.active) {
    await db.webhookDelivery.update({where: {id: delivery.id}, data: {status: 'FAILED', error: 'Webhook is turned off'}});
    return;
  }

  // Saved before the service list, or edited in the database: refused for good, never retried.
  const target = webhookTarget(webhook.url);
  if (!target) {
    await db.webhookDelivery.update({where: {id: delivery.id}, data: {status: 'FAILED', attempts: {increment: 1}, error: `Not a webhook service Kinroot sends to (${WEBHOOK_SERVICE_NAMES})`}});
    return;
  }

  const body = webhookBody(event);
  const secret = await decryptJson<string>(webhook.secret);
  const started = Date.now();
  let status: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(target.url.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'CRM-Webhooks/1.0',
        'x-webhook-id': delivery.id,
        'x-webhook-event': event.type,
        'x-webhook-signature': await signPayload(secret, body),
        // Test deliveries (Settings → Webhooks → Send test event) carry example data.
        ...(event.entity === TEST_ENTITY ? {'x-webhook-test': 'true'} : {}),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    responseBody = (await res.text().catch(() => '')).slice(0, 1000);
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).name === 'TimeoutError' ? 'Timed out after 10 s' : (e as Error).message;
  }

  const ok = !error;
  const durationMs = Date.now() - started;
  await db.webhookDelivery.update({
    where: {id: delivery.id},
    data: {
      attempts: {increment: 1},
      status: ok ? 'SUCCESS' : final ? 'FAILED' : 'PENDING',
      responseStatus: status,
      responseBody,
      error,
      durationMs,
      deliveredAt: ok ? new Date() : undefined,
    },
  });

  if (ok) {
    await db.webhook.update({where: {id: webhook.id}, data: {failures: 0, lastStatus: status, lastDeliveryAt: new Date()}});
    return;
  }
  if (final) {
    // Increment in the database: one job delivers several events, so deliveries to a hook can run side by side.
    const hook = await db.webhook.update({where: {id: webhook.id}, data: {failures: {increment: 1}, lastStatus: status, lastDeliveryAt: new Date()}, select: {failures: true}});
    if (hook.failures >= DISABLE_AFTER) await db.webhook.update({where: {id: webhook.id}, data: {active: false}});
  } else {
    await db.webhook.update({where: {id: webhook.id}, data: {lastStatus: status, lastDeliveryAt: new Date()}});
  }
  throw new Error(error ?? 'Delivery failed');
}

/** Deliveries one job sends side by side (each waits at most 10 s for its answer). */
const PARALLEL = 10;
/** Pending deliveries one job looks at; more go to a follow-up job. */
const PER_JOB = 100;

export type DeliverTarget = {deliveryId?: string; deliveryIds?: string[]; eventId?: string; eventIds?: string[]};

/**
 * `webhook.deliver` job: every pending delivery of one event (all its hooks), of a few events
 * (`emitMany`), or the ones named. One job per event instead of one per hook keeps Kinroot within
 * the platform's job rate. Deliveries that succeeded are never sent again; when some fail the job
 * throws so the platform retries it, and only the failed ones go again (on the last try they are
 * marked failed for good). Out of time: the rest goes to a follow-up job.
 */
export async function deliverWebhooks(db: Db, target: DeliverTarget, final: boolean, deadline = Date.now() + 45_000) {
  const where: Prisma.WebhookDeliveryWhereInput = target.deliveryId
    ? {id: target.deliveryId}
    : target.deliveryIds
      ? {id: {in: target.deliveryIds.slice(0, PER_JOB)}}
      : target.eventId
        ? {eventId: target.eventId}
        : {eventId: {in: (target.eventIds ?? []).slice(0, PER_JOB)}};
  const pending = await db.webhookDelivery.findMany({where: {...where, status: 'PENDING'}, orderBy: {createdAt: 'asc'}, take: PER_JOB, select: {id: true}});
  let failed = 0;
  for (let i = 0; i < pending.length; i += PARALLEL) {
    // Leave room for one more round of 10-second answers inside the job's 60 seconds.
    if (Date.now() > deadline - 12_000) {
      await enqueue(db, 'webhook.deliver', {deliveryIds: pending.slice(i).map((d) => d.id)});
      break;
    }
    const results = await Promise.allSettled(pending.slice(i, i + PARALLEL).map((d) => deliverWebhook(db, d.id, final)));
    failed += results.filter((r) => r.status === 'rejected').length;
  }
  if (failed) throw new Error(`${failed} of ${pending.length} webhook deliveries failed; trying again later`);
}
