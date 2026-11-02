import type {Context} from 'hono';

import {config as site} from '../../../platform/config';
import {fromB64} from '../kit/crypto';

/**
 * Who may post mail to the inbound webhook (`POST /site-api/crm/inbound/:token`): only the mail
 * service, proven with a secret the owner added in the site dashboard (docs/agent/site-api.md: a
 * webhook INTO the site verifies the sender before it reads the body). The token in the URL is kept
 * as well; it says which site, the secret says who.
 *
 *   Resend      signs its webhooks (Svix)            RESEND_WEBHOOK_SECRET        (whsec_…)
 *   Mailgun     signs every route post               MAILGUN_WEBHOOK_SIGNING_KEY
 *   Postmark,   no signature: HTTP Basic credentials INBOUND_BASIC_AUTH           (user:password, also
 *   SendGrid    in the webhook URL (user:pass@host)                                written into the URL)
 */
export const INBOUND_SECRETS = ['RESEND_WEBHOOK_SECRET', 'MAILGUN_WEBHOOK_SIGNING_KEY', 'INBOUND_BASIC_AUTH'] as const;

/** Signed requests older (or newer) than this are refused: a captured request cannot be replayed later. */
const TOLERANCE_S = 5 * 60;

const enc = new TextEncoder();

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fresh = (seconds: number) => Number.isFinite(seconds) && Math.abs(Date.now() / 1000 - seconds) <= TOLERANCE_S;

type Verified = {ok: true; body: Record<string, unknown>} | {ok: false; reason: string};

/** Checks the sender, then gives the parsed body (JSON, form or multipart). Never throws. */
export async function verifyInbound(c: Context): Promise<Verified> {
  try {
    // Resend (Svix): the signature covers the raw body.
    const svixId = c.req.header('svix-id');
    if (svixId) {
      const secret = site.ownerSecret('RESEND_WEBHOOK_SECRET');
      if (!secret) return {ok: false, reason: 'RESEND_WEBHOOK_SECRET is not added'};
      const timestamp = c.req.header('svix-timestamp') ?? '';
      if (!fresh(Number(timestamp))) return {ok: false, reason: 'stale signature'};
      const raw = await c.req.text();
      const expected = b64(await hmac(fromB64(secret.replace(/^whsec_/, '')), `${svixId}.${timestamp}.${raw}`));
      const given = (c.req.header('svix-signature') ?? '').split(' ').map((s) => s.split(',')[1] ?? '');
      if (!given.some((s) => sameText(s, expected))) return {ok: false, reason: 'bad signature'};
      return {ok: true, body: JSON.parse(raw) as Record<string, unknown>};
    }

    // Postmark / SendGrid: Basic credentials from the webhook URL, checked before the body is read.
    const authorization = c.req.header('authorization') ?? '';
    if (/^Basic\s/i.test(authorization)) {
      const secret = site.ownerSecret('INBOUND_BASIC_AUTH');
      if (!secret) return {ok: false, reason: 'INBOUND_BASIC_AUTH is not added'};
      let given = '';
      try {
        given = atob(authorization.replace(/^Basic\s+/i, '').trim());
      } catch {
        return {ok: false, reason: 'bad credentials'};
      }
      if (!sameText(given, secret)) return {ok: false, reason: 'bad credentials'};
      return {ok: true, body: await readBody(c)};
    }

    // Mailgun: the signature is over the post's own timestamp + token fields.
    const body = await readBody(c);
    const sig = (body.signature && typeof body.signature === 'object' ? body.signature : body) as Record<string, unknown>;
    if (typeof sig.signature === 'string' && typeof sig.timestamp === 'string' && typeof sig.token === 'string') {
      const key = site.ownerSecret('MAILGUN_WEBHOOK_SIGNING_KEY');
      if (!key) return {ok: false, reason: 'MAILGUN_WEBHOOK_SIGNING_KEY is not added'};
      if (!fresh(Number(sig.timestamp))) return {ok: false, reason: 'stale signature'};
      if (!sameText(hex(await hmac(key, `${sig.timestamp}${sig.token}`)), sig.signature)) return {ok: false, reason: 'bad signature'};
      return {ok: true, body};
    }
    return {ok: false, reason: 'unsigned request'};
  } catch {
    return {ok: false, reason: 'unreadable request'};
  }
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  return type.includes('json') ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>);
}
