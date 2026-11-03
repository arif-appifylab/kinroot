// Ported from Kinroot's scripts/test-webhooks.mjs
// Covers Settings → Webhooks "Send test event": a signed example of the picked event, the delivery log, the jobs status.
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {resetCrm} from '../support/crm';
import {configureEnv, DATABASE_URL, db} from '../support/harness';
import {crmOwner, fakeOutbound, must, outbound, signatureValid, ZAPIER} from './support';

type Delivery = {id: string; status: string; responseStatus: number | null; eventType: string; event: {entity: string}};

describe.skipIf(!DATABASE_URL)('Ported: outgoing webhook test events (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
    fakeOutbound();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    outbound.reset();
  });

  it('reports the job runner in the webhooks status', async () => {
    const {browser} = await crmOwner();
    const status = await browser.get('/site-api/crm/webhooks');
    expect(status.status).toBe(200);
    const jobs = status.json.jobs as {devTicker: unknown};
    expect(typeof jobs.devTicker).toBe('boolean');
    // Tests run jobs in-process, as the Preview and a dev machine do.
    expect(jobs.devTicker).toBe(true);
  });

  it('sends a signed example of the picked event, logs it as a test, and refuses when off', async () => {
    const {browser} = await crmOwner();
    const created = await browser.post('/site-api/crm/webhooks', {url: `${ZAPIER}/kr-test/`, description: 'kr test receiver', events: ['deal.won', 'contact.created']});
    expect(created.status).toBe(201);
    const {webhook: hook, secret} = created.json as {webhook: {id: string}; secret: string};
    expect(secret.startsWith('whsec_')).toBe(true);

    const t1 = must<{delivery: Delivery}>(await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {type: 'deal.won'}), 'test deal.won');
    expect(t1.delivery).toMatchObject({status: 'SUCCESS', responseStatus: 200});
    const hit = outbound.hooks.at(-1)!;
    expect(hit, 'the receiver got a request').toBeTruthy();
    const body = JSON.parse(hit.body) as {type: string; data: {status?: string; title?: string; stage?: {name?: string}}};
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'data', 'id', 'type']);
    expect(body.type).toBe('deal.won');
    expect(hit.headers['x-webhook-event']).toBe('deal.won');
    expect(body.data.status).toBe('WON');
    expect(body.data.title).toBeTruthy();
    expect(body.data.stage?.name).toBeTruthy();
    expect(hit.headers['x-webhook-id']).toBe(t1.delivery.id);
    expect(hit.headers['x-webhook-test']).toBe('true');
    expect(hit.headers['content-type']).toMatch(/^application\/json/);
    expect(await signatureValid(hit.body, hit.headers['x-webhook-signature'] ?? '', secret)).toBe(true);
    expect(await signatureValid(hit.body, hit.headers['x-webhook-signature'] ?? '', 'whsec_wrong')).toBe(false);
    expect(await signatureValid(hit.body.replace('WON', 'LOST'), hit.headers['x-webhook-signature'] ?? '', secret)).toBe(false);

    // No type: the first subscribed event.
    const t2 = await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {});
    expect(t2.status).toBe(200);
    expect((JSON.parse(outbound.hooks.at(-1)!.body) as {type: string}).type).toBe('deal.won');

    // A failing endpoint is reported; any event type can be tested.
    outbound.answer = () => 500;
    const t3 = must<{delivery: Delivery}>(await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {type: 'ticket.created'}), 'test ticket.created');
    expect(t3.delivery).toMatchObject({status: 'FAILED', responseStatus: 500});
    expect((JSON.parse(outbound.hooks.at(-1)!.body) as {data: {number?: number}}).data.number).toBe(1042);
    outbound.answer = () => 200;

    expect((await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {type: 'nope.never'})).status).toBe(400);

    const log = must<{rows: Delivery[]}>(await browser.get(`/site-api/crm/webhooks/${hook.id}/deliveries`), 'deliveries').rows;
    expect(log.filter((d) => d.event.entity === 'webhook')).toHaveLength(3);
    expect(log[0]).toMatchObject({eventType: 'ticket.created', responseStatus: 500});

    must(await browser.request('PATCH', `/site-api/crm/webhooks/${hook.id}`, {active: false}), 'turn off');
    expect((await browser.post(`/site-api/crm/webhooks/${hook.id}/test`, {type: 'deal.won'})).status).toBe(400);
    expect(outbound.hooks).toHaveLength(3);

    expect((await browser.delete(`/site-api/crm/webhooks/${hook.id}`)).status).toBe(200);
  });
});
