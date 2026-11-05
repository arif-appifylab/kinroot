import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {WEBHOOK_REFUSED} from '../../src/crm/lib/webhook-targets';
import {owner, resetCrm} from './support/crm';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's outgoing webhooks on the site's rules: only to the webhook services written in code
 * (src/crm/lib/webhook-targets.ts), named in the product by their host only (never a tool's name).
 * Incoming data has one way in, the Data in webhook (crm-data-in-url.test.ts).
 */

async function admin() {
  const browser = await owner();
  await browser.get('/site-api/crm/auth/state');
  return browser;
}

describe.skipIf(!DATABASE_URL)('Kinroot webhooks (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);

  it('saves outgoing webhooks only for the listed services, and keeps the hook path out of the audit log', async () => {
    const browser = await admin();
    const refused = await browser.post('/site-api/crm/webhooks', {url: 'https://example.com/hooks/crm', events: ['contact.created']});
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.json)).toContain(WEBHOOK_REFUSED.slice(0, 30));
    expect(JSON.stringify(refused.json)).not.toMatch(/Zapier|Slack|Make|n8n|Pabbly/);

    const saved = await browser.post('/site-api/crm/webhooks', {url: 'https://hooks.zapier.com/hooks/catch/123/s3cr3tpath/', events: ['contact.created']});
    expect(saved.status).toBe(201);
    const entries = await db.auditLog.findMany({where: {entity: 'webhook'}, select: {label: true}});
    expect(entries.map(e => e.label)).toEqual(['hooks.zapier.com']);

    // A URL edited into the database later is refused at send time, never fetched.
    const hook = await db.webhook.findFirstOrThrow();
    await db.webhook.update({where: {id: hook.id}, data: {url: 'https://example.com/elsewhere'}});
    const test = await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {});
    expect(test.status).toBe(200);
    expect((test.json.delivery as {status: string; error: string}).status).toBe('FAILED');
    expect((test.json.delivery as {error: string}).error).toBe(WEBHOOK_REFUSED);
  });

  it('has no custom incoming webhooks any more: their routes and URLs are gone', async () => {
    const browser = await admin();
    expect((await browser.get('/site-api/crm/incoming-webhooks')).status).toBe(404);
    expect((await browser.post('/site-api/crm/incoming-webhooks', {name: 'Leads', action: 'contact'})).status).toBe(404);
  });
});
