import {decryptJson} from '../kit/crypto';
import type {Db} from '../kit/db';

/** A webhook is switched off after this many deliveries in a row fail for good. */
export const DISABLE_AFTER = 20;

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

export function webhookBody(event: {id: string; type: string; createdAt: Date; data: unknown}) {
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

  const body = webhookBody(event);
  const secret = await decryptJson<string>(webhook.secret);
  const started = Date.now();
  let status: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(webhook.url, {
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
    const failures = webhook.failures + 1;
    await db.webhook.update({
      where: {id: webhook.id},
      data: {failures, lastStatus: status, lastDeliveryAt: new Date(), active: failures < DISABLE_AFTER},
    });
  } else {
    await db.webhook.update({where: {id: webhook.id}, data: {lastStatus: status, lastDeliveryAt: new Date()}});
  }
  throw new Error(error ?? 'Delivery failed');
}
