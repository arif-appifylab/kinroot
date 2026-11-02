import {Hono} from 'hono';
import {afterEach, describe, expect, it} from 'vitest';

import {verifyInbound} from '../src/server/crm/email/inbound-auth';
import {env} from './integration/support/cloudflare-workers';

/** Kinroot's inbound email webhook only takes mail its service signed (src/server/crm/email/inbound-auth.ts). */
const app = new Hono().post('/inbound', async c => {
  const v = await verifyInbound(c);
  return v.ok ? c.json({ok: true, body: v.body}) : c.json({ok: false, reason: v.reason}, 401);
});

const enc = new TextEncoder();
async function hmac(key: Uint8Array | string, data: string) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const now = () => String(Math.floor(Date.now() / 1000));

describe('Kinroot inbound email: sender checks', () => {
  afterEach(() => {
    delete env.RESEND_WEBHOOK_SECRET;
    delete env.MAILGUN_WEBHOOK_SIGNING_KEY;
    delete env.INBOUND_BASIC_AUTH;
  });

  it('takes a Resend (Svix) post signed with the secret, refuses a wrong or stale one', async () => {
    const key = crypto.getRandomValues(new Uint8Array(24));
    env.RESEND_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...key))}`;
    const body = JSON.stringify({type: 'email.received', data: {email_id: 'e1'}});
    const sign = async (ts: string) => `v1,${btoa(String.fromCharCode(...(await hmac(key, `msg_1.${ts}.${body}`))))}`;
    const post = (ts: string, sig: string) =>
      app.request('/inbound', {method: 'POST', body, headers: {'content-type': 'application/json', 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': sig}});

    expect((await post(now(), await sign(now()))).status).toBe(200);
    expect((await post(now(), 'v1,AAAA')).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await post(old, await sign(old))).status).toBe(401);
  });

  it('takes a Mailgun post signed with the signing key', async () => {
    env.MAILGUN_WEBHOOK_SIGNING_KEY = 'key-test-signing';
    const ts = now();
    const form = (signature: string) => new URLSearchParams({timestamp: ts, token: 'tok123', signature, sender: 'a@b.co'});
    const good = await app.request('/inbound', {method: 'POST', body: form(Array.from(await hmac('key-test-signing', `${ts}tok123`), b => b.toString(16).padStart(2, '0')).join(''))});
    expect(good.status).toBe(200);
    expect((await app.request('/inbound', {method: 'POST', body: form('0'.repeat(64))})).status).toBe(401);
  });

  it('takes Postmark / SendGrid with the Basic credentials from the URL, and nothing unsigned', async () => {
    env.INBOUND_BASIC_AUTH = 'kinroot:a-long-random-password';
    const body = JSON.stringify({FromFull: {Email: 'a@b.co'}, Subject: 'Hi'});
    const post = (auth?: string) => app.request('/inbound', {method: 'POST', body, headers: {'content-type': 'application/json', ...(auth ? {authorization: auth} : {})}});
    expect((await post(`Basic ${btoa('kinroot:a-long-random-password')}`)).status).toBe(200);
    expect((await post(`Basic ${btoa('kinroot:wrong')}`)).status).toBe(401);
    expect((await post()).status).toBe(401);
  });

  it('refuses everything when the owner added no secret', async () => {
    const res = await app.request('/inbound', {
      method: 'POST',
      body: '{}',
      headers: {'content-type': 'application/json', authorization: `Basic ${btoa('a:b')}`},
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as {reason: string}).reason).toMatch(/INBOUND_BASIC_AUTH/);
  });
});
