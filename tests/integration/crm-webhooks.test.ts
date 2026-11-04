import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {owner, resetCrm} from './support/crm';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's webhooks on the site's rules: outgoing ones only to the webhook services written in code
 * (src/crm/lib/webhook-targets.ts); incoming ones only from a sender that proves itself with the
 * secret in an owner-added site secret, and their log never keeps the sender's address.
 */

const SECRET = 'a-long-shared-secret-from-the-sending-tool';

async function admin() {
  const browser = await owner();
  await browser.get('/site-api/crm/auth/state');
  return browser;
}

/** Posts to an incoming webhook's URL from outside (no session, no CSRF: the sender is another service). */
const send = (url: string, headers: Record<string, string>, body: unknown) =>
  app.request(url, {method: 'POST', headers: {'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '198.51.100.20', ...headers}, body: JSON.stringify(body)});

describe.skipIf(!DATABASE_URL)('Kinroot webhooks (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);
  afterEach(() => {
    delete env.INCOMING_LEADS_SECRET;
  });

  it('saves outgoing webhooks only for the listed services, and keeps the hook path out of the audit log', async () => {
    const browser = await admin();
    const refused = await browser.post('/site-api/crm/webhooks', {url: 'https://example.com/hooks/crm', events: ['contact.created']});
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.json)).toMatch(/Zapier/);

    const saved = await browser.post('/site-api/crm/webhooks', {url: 'https://hooks.zapier.com/hooks/catch/123/s3cr3tpath/', events: ['contact.created']});
    expect(saved.status).toBe(201);
    const entries = await db.auditLog.findMany({where: {entity: 'webhook'}, select: {label: true}});
    expect(entries.map(e => e.label)).toEqual(['Zapier (hooks.zapier.com)']);

    // A URL edited into the database later is refused at send time, never fetched.
    const hook = await db.webhook.findFirstOrThrow();
    await db.webhook.update({where: {id: hook.id}, data: {url: 'https://example.com/elsewhere'}});
    const test = await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {});
    expect(test.status).toBe(200);
    expect((test.json.delivery as {status: string; error: string}).status).toBe('FAILED');
    expect((test.json.delivery as {error: string}).error).toMatch(/Not a webhook service/);
  });

  it('accepts an incoming request only with the secret from the named site secret', async () => {
    const browser = await admin();
    const created = await browser.post('/site-api/crm/incoming-webhooks', {name: 'Leads', action: 'contact'});
    expect(created.status).toBe(201);
    const hook = created.json.webhook as {id: string; url: string; verify: string; verifyHeader: string; secretName: string; secretAdded: boolean};
    // A sender check from the start, with a suggested site secret that is not added yet.
    expect(hook).toMatchObject({verify: 'header', verifyHeader: 'X-Webhook-Secret', secretName: 'INCOMING_LEADS_SECRET', secretAdded: false});
    const url = new URL(hook.url).pathname;

    const early = await send(url, {'x-webhook-secret': SECRET}, {email: 'lead@example.com'});
    expect(early.status).toBe(401);
    expect(((await early.json()) as {error: string}).error).toMatch(/INCOMING_LEADS_SECRET is not added/);

    env.INCOMING_LEADS_SECRET = SECRET;
    expect((await browser.get(`/site-api/crm/incoming-webhooks/${hook.id}`)).json.webhook).toMatchObject({secretAdded: true});
    expect((await send(url, {'x-webhook-secret': 'wrong'}, {email: 'lead@example.com'})).status).toBe(401);
    expect((await send(url, {}, {email: 'lead@example.com'})).status).toBe(401);
    expect((await send(url, {'x-webhook-secret': SECRET}, {email: 'lead@example.com'})).status).toBe(200);

    // The request log keeps no address of the sender, and redacts the secret header.
    const logged = await db.incomingWebhookRequest.findMany({select: {headers: true}});
    for (const row of logged) {
      const headers = row.headers as Record<string, string>;
      expect(headers['cf-connecting-ip']).toBeUndefined();
      expect(headers['x-forwarded-for']).toBeUndefined();
      if (headers['x-webhook-secret']) expect(headers['x-webhook-secret']).toBe('[redacted]');
    }

    // Only INCOMING_ names: never another service's key.
    expect((await browser.request('PATCH', `/site-api/crm/incoming-webhooks/${hook.id}`, {secretName: 'RESEND_API_KEY'})).status).toBe(422);
  });

  it('refuses a request to a webhook saved without a sender check', async () => {
    const browser = await admin();
    const created = await browser.post('/site-api/crm/incoming-webhooks', {name: 'Old', action: 'contact'});
    const hook = created.json.webhook as {id: string; url: string};
    await db.incomingWebhook.update({where: {id: hook.id}, data: {verify: 'none'}});
    const res = await send(new URL(hook.url).pathname, {}, {email: 'x@example.com'});
    expect(res.status).toBe(401);
  });
});
