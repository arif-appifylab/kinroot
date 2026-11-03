// Ported from Kinroot's scripts/test-incoming-webhooks.mjs
// Covers incoming webhooks: every action, mapping, blanks, body formats, sender checks (site secrets), idempotency, limits, capture, log, retry, audit.
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {env} from '../support/cloudflare-workers';
import {resetCrm} from '../support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {crmOwner, hmacBase64, hmacHex, must, outside} from './support';

/**
 * What changed from the original (PLAN.md › Decisions phase 8): the URL lives under
 * /site-api/crm/public/hooks/; every hook proves its sender with a secret kept in an owner-added
 * site secret named INCOMING_… (so every request here carries it); "URL only" and the stored
 * secret are gone; requests are processed by the job as the request ends (no runner to wait for).
 */

const SECRET = 'a-long-shared-secret-from-the-sending-tool';
const PHONE = '+1 415 555 0142';
const PHONE_FORMATTED = '(415) 555-0142';

type Hook = {id: string; name: string; url: string; secretName: string | null; secretAdded: boolean; listening: boolean; listenUntil: string | null; sample: {payload: any; headers: Record<string, string>} | null};
type Row = {status: string; result: any; error: string | null};
type SendOpts = {json?: unknown; raw?: string; contentType?: string; headers?: Record<string, string>; method?: string; query?: string; secret?: boolean};

const secretNames = new Set<string>();

describe.skipIf(!DATABASE_URL)('Ported: incoming webhooks (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);
  afterEach(() => {
    for (const name of secretNames) delete env[name];
    secretNames.clear();
  });

  let browser: Browser;

  /** A hook with its own site secret (added), so requests that carry the secret header are accepted. */
  async function hook(body: Record<string, unknown>): Promise<Hook> {
    const secretName = `INCOMING_${String(body.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SECRET`;
    const created = must<{webhook: Hook}>(await browser.post('/site-api/crm/incoming-webhooks', {...body, secretName}), `create ${body.name}`).webhook;
    env[secretName] = SECRET;
    secretNames.add(secretName);
    return created;
  }
  const patch = async (h: Hook, body: Record<string, unknown>) => must<{webhook: Hook}>(await browser.request('PATCH', `/site-api/crm/incoming-webhooks/${h.id}`, body), 'patch hook').webhook;

  /** A request to a webhook URL the way another tool would send it (with the hook's secret header unless `secret: false`). */
  function send(url: string, {json, raw, contentType, headers = {}, method = 'POST', query = '', secret = true}: SendOpts = {}) {
    const body = raw ?? (json === undefined ? undefined : JSON.stringify(json));
    return outside(`${new URL(url).pathname}${query}`, {
      method,
      body,
      headers: {...(body !== undefined ? {'content-type': contentType ?? 'application/json'} : {}), ...(secret ? {'x-webhook-secret': SECRET} : {}), ...headers},
    });
  }
  /** Sends and reads the request row (the job ran before the answer came back). */
  async function deliver(url: string, opts?: SendOpts) {
    const http = await send(url, opts);
    if (http.status !== 200 || typeof http.json.id !== 'string') return {http, row: null};
    const row = (await db.incomingWebhookRequest.findUnique({where: {id: http.json.id}, select: {status: true, result: true, error: true}})) as Row | null;
    return {http, row};
  }
  const contactRow = (id: string | undefined) => db.contact.findUnique({where: {id: id ?? ''}});

  async function setup() {
    browser = (await crmOwner()).browser;
    must(await browser.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}), 'setup');
    const plan = must(await browser.post('/site-api/crm/fields', {entity: 'CONTACT', label: 'Plan', type: 'SELECT', options: ['Free', 'Pro']}), 'plan field').field as {key: string};
    const seats = must(await browser.post('/site-api/crm/fields', {entity: 'CONTACT', label: 'Seats', type: 'NUMBER'}), 'seats field').field as {key: string};
    const list = must(await browser.post('/site-api/crm/lists', {name: 'Webhook leads', kind: 'STATIC'}), 'list').list as {id: string};
    return {plan, seats, list};
  }

  const TAG = 'inhook';
  const email1 = 'maya@northwind.example';

  async function contactHookWithMaya() {
    const {plan, seats, list} = await setup();
    const contactHook = await hook({
      name: 'Stripe checkouts',
      action: 'contact',
      config: {
        mapping: [
          {path: 'data.customer.email', target: 'contact.email'},
          {path: 'data.customer.first_name', target: 'contact.firstName'},
          {path: 'data.customer.last_name', target: 'contact.lastName'},
          {path: 'data.customer.phone', target: 'contact.phone'},
          {path: 'items[0].name', target: 'contact.title'},
          {path: 'data.plan', target: `contact.custom.${plan.key}`},
          {path: 'data.seats', target: `contact.custom.${seats.key}`},
          {path: 'data.customer.company', target: 'contact.company'},
        ],
        fixed: [
          {target: 'contact.source', value: 'Stripe'},
          {target: 'contact.lifecycleStage', value: 'CUSTOMER'},
        ],
        tags: [TAG],
        listId: list.id,
        idempotencyPath: 'id',
      },
    });
    const payload1 = {id: 'evt_1', data: {customer: {email: email1.toUpperCase(), first_name: 'Maya', last_name: 'Patel', phone: PHONE, company: 'Northwind'}, plan: 'pro', seats: '12'}, items: [{name: 'Head of Ops'}]};
    const c1 = await deliver(contactHook.url, {json: payload1});
    return {plan, seats, list, contactHook, payload1, c1, contactId: c1.row?.result.recordId as string};
  }

  it('creates a contact from nested JSON: custom fields, fixed values, tags, list, company, timeline, events, audit', async () => {
    const {plan, seats, list, contactHook, payload1, c1} = await contactHookWithMaya();
    expect(contactHook.url).toContain('/site-api/crm/public/hooks/');
    expect(contactHook.url.split('/').pop()!.length).toBeGreaterThanOrEqual(40);
    expect(c1.http.status).toBe(200);
    expect(c1.http.json.ok).toBe(true);
    expect(typeof c1.http.json.id).toBe('string');
    expect(c1.row).toMatchObject({status: 'processed', result: {outcome: 'created', entity: 'contact'}});

    const contact = await contactRow(c1.row?.result.recordId);
    expect(contact).toMatchObject({email: email1, firstName: 'Maya', lastName: 'Patel', title: 'Head of Ops', source: 'Stripe', lifecycleStage: 'CUSTOMER'});
    const custom = contact!.custom as Record<string, unknown>;
    expect(custom[plan.key]).toBe('Pro');
    expect(custom[seats.key]).toBe(12);
    expect(contact!.tags).toContain(TAG);
    expect(await db.contactListMember.findFirst({where: {listId: list.id, contactId: contact!.id}})).toBeTruthy();
    const link = await db.contactCompany.findFirst({where: {contactId: contact!.id}, select: {company: {select: {name: true}}}});
    expect(link?.company.name).toBe('Northwind');

    const act = await db.activity.findFirst({where: {contactId: contact!.id, type: 'contact_created'}});
    expect(act?.title).toBe(`Created by incoming webhook ${contactHook.name}`);
    expect((act?.data as {source?: {kind?: string}})?.source?.kind).toBe('webhook');
    expect(await db.event.findFirst({where: {type: 'contact.created', recordId: contact!.id}})).toBeTruthy();
    const received = await db.event.findFirst({where: {type: 'webhook.received', data: {path: ['requestId'], equals: c1.http.json.id as string}}});
    expect(received?.entity).toBe('incoming_webhook');
    expect(received?.data).toMatchObject({webhookId: contactHook.id, contactId: contact!.id, recordId: contact!.id, data: {id: payload1.id}});
    expect(await db.auditLog.findFirst({where: {action: 'contact.created', recordId: contact!.id, meta: {path: ['webhookId'], equals: contactHook.id}}})).toBeTruthy();
  });

  it('updates the same contact, keeps blanks out, matches by phone, and names the webhook in the history', async () => {
    const {contactHook, contactId} = await contactHookWithMaya();
    const c2 = await deliver(contactHook.url, {json: {id: 'evt_2', data: {customer: {email: email1, first_name: 'Maya-Lee', phone: '', last_name: null}}}});
    expect(c2.row?.result).toMatchObject({outcome: 'updated', recordId: contactId});
    expect(await contactRow(contactId)).toMatchObject({firstName: 'Maya-Lee', phone: PHONE, lastName: 'Patel'});
    const upd = await db.activity.findFirst({where: {contactId, type: 'field_changed'}, orderBy: {createdAt: 'desc'}});
    expect(upd?.title).toBe(`Updated by incoming webhook ${contactHook.name}`);
    expect((upd?.data as {changes: {field: string; from: unknown}[]}).changes.some((c) => c.field === 'firstName' && c.from === 'Maya')).toBe(true);
    expect(await db.event.findFirst({where: {type: 'contact.updated', recordId: contactId}})).toBeTruthy();

    await patch(contactHook, {config: {skipBlanks: false}});
    const c3 = await deliver(contactHook.url, {json: {id: 'evt_3', data: {customer: {email: email1, last_name: ''}}}});
    expect(c3.row?.result.outcome).toBe('updated');
    expect((await contactRow(contactId))?.lastName).toBeNull();
    await patch(contactHook, {config: {skipBlanks: true}});

    // No email: matched by phone, formatting ignored.
    const c4 = await deliver(contactHook.url, {json: {id: 'evt_4', data: {customer: {phone: PHONE_FORMATTED}}, items: [{name: 'COO'}]}});
    expect(c4.row?.result.recordId).toBe(contactId);
    expect((await contactRow(contactId))?.title).toBe('COO');
    // Another email with the same phone is a new contact: never overwrites someone's email.
    const c5 = await deliver(contactHook.url, {json: {id: 'evt_5', data: {customer: {email: 'other@northwind.example', phone: PHONE}}}});
    expect(c5.row?.result.outcome).toBe('created');
    expect(c5.row?.result.recordId).not.toBe(contactId);
    expect((await contactRow(contactId))?.email).toBe(email1);

    const hist = must<{rows: {field: string; to: unknown; actor: {kind: string; name: string}}[]}>(await browser.get(`/site-api/crm/history?entity=contact&id=${contactId}&take=100`), 'history');
    const byHook = hist.rows.find((r) => r.field === 'title' && r.to === 'COO');
    expect(byHook?.actor).toMatchObject({kind: 'webhook', name: `Webhook: ${contactHook.name}`});
  });

  it('dedupes repeats (payload id, Idempotency-Key) and honours create-only / update-only', async () => {
    const {contactHook, payload1, c1, contactId} = await contactHookWithMaya();
    const dupe = await send(contactHook.url, {json: payload1});
    expect(dupe.status).toBe(200);
    expect(dupe.json).toMatchObject({duplicate: true, id: c1.http.json.id});
    expect(await db.incomingWebhookRequest.count({where: {webhookId: contactHook.id, status: 'duplicate'}})).toBe(1);

    const hdr = await deliver(contactHook.url, {json: {data: {customer: {email: email1}}}, headers: {'Idempotency-Key': 'key-1'}});
    const hdr2 = await send(contactHook.url, {json: {data: {customer: {email: email1}}}, headers: {'Idempotency-Key': 'key-1'}});
    expect(hdr.row?.status).toBe('processed');
    expect(hdr2.json.duplicate).toBe(true);
    expect(await db.contact.count({where: {email: email1}})).toBe(1);

    await patch(contactHook, {config: {mode: 'create'}});
    const m1 = await deliver(contactHook.url, {json: {data: {customer: {email: email1, first_name: 'Nope'}}}});
    expect(m1.row?.result.outcome).toBe('skipped');
    expect((await contactRow(contactId))?.firstName).toBe('Maya');
    await patch(contactHook, {config: {mode: 'update'}});
    const m2 = await deliver(contactHook.url, {json: {data: {customer: {email: 'nobody@northwind.example'}}}});
    expect(m2.row?.result.outcome).toBe('skipped');
    expect(await db.contact.findFirst({where: {email: 'nobody@northwind.example'}})).toBeNull();
  });

  it('reads form-urlencoded and query-string bodies, and refuses invalid JSON', async () => {
    await setup();
    const formHook = await hook({
      name: 'Website form',
      action: 'contact',
      config: {mapping: [{path: 'email', target: 'contact.email'}, {path: 'customer.first_name', target: 'contact.firstName'}, {path: 'labels', target: 'contact.tags'}, {path: 'first_name', target: 'contact.firstName'}]},
    });
    const formEmail = 'form@northwind.example';
    const f1 = await deliver(formHook.url, {raw: `email=${encodeURIComponent(formEmail)}&customer%5Bfirst_name%5D=Formy&labels%5B%5D=web&labels%5B%5D=Trial`, contentType: 'application/x-www-form-urlencoded'});
    expect(f1.row?.status).toBe('processed');
    const formContact = await db.contact.findFirst({where: {email: formEmail}});
    expect(formContact?.firstName).toBe('Formy');
    expect(formContact?.tags).toEqual(expect.arrayContaining(['web', 'trial']));

    const queryEmail = 'query@northwind.example';
    const q1 = await deliver(formHook.url, {query: `?email=${encodeURIComponent(queryEmail)}&first_name=Query`});
    expect(q1.row?.status).toBe('processed');
    expect((await db.contact.findFirst({where: {email: queryEmail}}))?.firstName).toBe('Query');

    const bad = await send(formHook.url, {raw: '{"email": ', contentType: 'application/json'});
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/valid JSON/);
  });

  it('creates companies, matching by domain then by name', async () => {
    await setup();
    const companyHook = await hook({
      name: 'Company sync',
      action: 'company',
      config: {mapping: [{path: 'company.name', target: 'company.name'}, {path: 'company.domain', target: 'company.domain'}, {path: 'company.employees', target: 'company.employees'}, {path: 'company.industry', target: 'company.industry'}], tags: [TAG]},
    });
    const domain = 'acme.example';
    const co1 = await deliver(companyHook.url, {json: {company: {name: 'Acme', domain: `https://www.${domain}/about`, employees: '1,200'}}});
    expect(co1.row?.result.outcome).toBe('created');
    const company = await db.company.findUnique({where: {id: co1.row?.result.recordId}});
    expect(company).toMatchObject({domain, employees: 1200});
    expect(company?.tags).toContain(TAG);
    expect(await db.activity.findFirst({where: {companyId: company!.id, type: 'company_created', title: {startsWith: 'Created by incoming webhook'}}})).toBeTruthy();

    const co2 = await deliver(companyHook.url, {json: {company: {domain: domain.toUpperCase(), employees: 1300}}});
    expect(co2.row?.result).toMatchObject({recordId: company!.id, outcome: 'updated'});
    expect((await db.company.findUnique({where: {id: company!.id}}))?.employees).toBe(1300);
    const co3 = await deliver(companyHook.url, {json: {company: {name: 'ACME', industry: 'Robotics'}}});
    expect(co3.row?.result.recordId).toBe(company!.id);
    expect((await db.company.findUnique({where: {id: company!.id}}))?.industry).toBe('Robotics');
  });

  it('creates deals linked to a contact found or created by email, and tickets from the customer email', async () => {
    const {contactId} = await contactHookWithMaya();
    const pipeline = await db.pipeline.findFirstOrThrow({orderBy: [{isDefault: 'desc'}, {position: 'asc'}], select: {id: true, stages: {orderBy: {position: 'asc'}, select: {id: true}}}});
    const stage = pipeline.stages[1]!.id;
    const dealHook = await hook({
      name: 'Orders',
      action: 'deal',
      config: {
        mapping: [
          {path: 'customer.email', target: 'contact.email'},
          {path: 'customer.first_name', target: 'contact.firstName'},
          {path: 'order.title', target: 'deal.title'},
          {path: 'order.amount', target: 'deal.value'},
          {path: 'order.currency', target: 'deal.currency'},
        ],
        deal: {pipelineId: pipeline.id, stageId: stage, title: ''},
        tags: [TAG],
      },
    });
    const dealEmail = 'buyer@northwind.example';
    const d1 = await deliver(dealHook.url, {json: {customer: {email: dealEmail, first_name: 'Bea'}, order: {title: 'Annual plan', amount: '$1,800.00', currency: 'eur'}}});
    expect(d1.row?.result.entity).toBe('deal');
    const deal = await db.deal.findUnique({where: {id: d1.row?.result.recordId}});
    expect(deal).toMatchObject({title: 'Annual plan', value: 1800, currency: 'EUR', stageId: stage});
    expect(deal?.tags).toContain(TAG);
    const buyer = await db.contact.findFirst({where: {email: dealEmail}});
    expect(buyer?.firstName).toBe('Bea');
    expect(await db.dealContact.findFirst({where: {dealId: deal!.id, contactId: buyer!.id}})).toBeTruthy();
    expect(d1.row?.result.contactId).toBe(buyer!.id);
    expect(await db.activity.findFirst({where: {dealId: deal!.id, type: 'deal_created', title: {startsWith: 'Deal created by incoming webhook'}}})).toBeTruthy();
    expect(await db.event.findFirst({where: {type: 'deal.created', recordId: deal!.id}})).toBeTruthy();

    const d2 = await deliver(dealHook.url, {json: {customer: {email: dealEmail}, order: {amount: 50}}});
    const deal2 = await db.deal.findUnique({where: {id: d2.row?.result.recordId}});
    expect(deal2?.id).not.toBe(deal!.id);
    expect(d2.row?.result.contactId).toBe(buyer!.id);
    expect(deal2?.title).toBe(`${dealHook.name}: Bea`);

    const ticketHook = await hook({
      name: 'Support form',
      action: 'ticket',
      config: {mapping: [{path: 'from', target: 'contact.email'}, {path: 'subject', target: 'ticket.subject'}, {path: 'message', target: 'ticket.description'}, {path: 'urgency', target: 'ticket.priority'}]},
    });
    const t1 = await deliver(ticketHook.url, {json: {from: email1, subject: 'Invoice wrong', message: 'Old address on the invoice.', urgency: 'high'}});
    const ticket = await db.ticket.findUnique({where: {id: t1.row?.result.recordId}});
    expect(ticket).toMatchObject({subject: 'Invoice wrong', source: 'WEBHOOK', priority: 'HIGH', contactId, description: 'Old address on the invoice.'});
    expect(await db.event.findFirst({where: {type: 'ticket.created', recordId: ticket!.id}})).toBeTruthy();
  });

  it('"Only start automations": webhook.received starts the automation filtered on this webhook, writes nothing', async () => {
    const {contactHook, contactId} = await contactHookWithMaya();
    const autoHook = await hook({name: 'Trial events', action: 'automations', config: {mapping: [{path: 'customer.email', target: 'contact.email'}]}});
    const step = (id: string, type: string, rest: Record<string, unknown> = {}) => ({id, type, ...rest});
    const automation = async (name: string, webhookId: string, tag: string) => {
      const a = must(await browser.post('/site-api/crm/automations', {timezone: 'UTC', name, object: 'contact', trigger: {kind: 'event', event: 'webhook.received', filter: {webhookId}}, steps: [step('t', 'add_tag', {target: 'contact', tag})]}), name).automation as {id: string};
      must(await browser.post(`/site-api/crm/automations/${a.id}/enable`, {enabled: true}), `enable ${name}`);
    };
    await automation('Incoming hook', autoHook.id, 'auto-yes');
    await automation('Other hook', contactHook.id, 'auto-wrong');
    const before = await db.contact.count();
    const a1 = await deliver(autoHook.url, {json: {event: 'trial.started', customer: {email: email1}}});
    expect(a1.row?.status).toBe('processed');
    expect(a1.row?.result).toMatchObject({outcome: 'none', contactId});
    const tags = (await contactRow(contactId))!.tags;
    expect(tags).toContain('auto-yes');
    expect(tags).not.toContain('auto-wrong');
    expect(await db.contact.count()).toBe(before);
  });

  it('checks the URL token, the method, the on/off switch, the secret header and HMAC signatures', async () => {
    await setup();
    const unknown = await outside(`/site-api/crm/public/hooks/${'x'.repeat(43)}`, {headers: {'content-type': 'application/json'}, body: '{"a":1}'});
    expect(unknown.status).toBe(404);
    expect(String(unknown.json.error)).toMatch(/Unknown webhook URL/);

    const secHook = await hook({name: 'Secured', action: 'contact', config: {mapping: [{path: 'email', target: 'contact.email'}]}});
    expect((await send(secHook.url, {method: 'GET'})).status).toBe(405);

    await patch(secHook, {active: false});
    const off = await send(secHook.url, {json: {email: 'off@northwind.example'}});
    expect(off.status).toBe(403);
    expect(String(off.json.error)).toMatch(/turned off/);
    await patch(secHook, {active: true});

    // Adapted: the secret's value lives in a site secret; the check needs that secret's name.
    expect((await browser.request('PATCH', `/site-api/crm/incoming-webhooks/${secHook.id}`, {verify: 'header', verifyHeader: 'X-Hook-Secret', secretName: null})).status).toBe(400);
    await patch(secHook, {verify: 'header', verifyHeader: 'X-Hook-Secret', secretName: 'INCOMING_SECURED_SECRET'});
    const s0 = await send(secHook.url, {json: {email: 's0@northwind.example'}, secret: false});
    const s1 = await send(secHook.url, {json: {email: 's1@northwind.example'}, secret: false, headers: {'X-Hook-Secret': 'wrong'}});
    const s2 = await deliver(secHook.url, {json: {email: 's2@northwind.example'}, secret: false, headers: {'X-Hook-Secret': SECRET}});
    expect(s0.status).toBe(401);
    expect(String(s0.json.error)).toMatch(/Missing the X-Hook-Secret header/);
    expect(s1.status).toBe(401);
    expect(String(s1.json.error)).toMatch(/does not match/);
    expect(s2.http.status).toBe(200);
    expect(s2.row?.status).toBe('processed');
    expect(await db.incomingWebhookRequest.findFirst({where: {webhookId: secHook.id, status: 'rejected', error: {contains: 'does not match'}}})).toBeTruthy();

    const KEY = 'hmac-signing-key-from-the-tool';
    env.INCOMING_SECURED_KEY = KEY;
    secretNames.add('INCOMING_SECURED_KEY');
    await patch(secHook, {verify: 'hmac', verifyHeader: 'X-Signature', verifyEncoding: 'hex', secretName: 'INCOMING_SECURED_KEY'});
    const body = JSON.stringify({email: 'h1@northwind.example'});
    const hex = await hmacHex(KEY, body);
    const h1 = await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': `sha256=${hex}`}});
    const h2 = await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': hex.toUpperCase()}});
    const h3 = await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': `sha256=${await hmacHex('other', body)}`}});
    const h4 = await send(secHook.url, {raw: body.replace('h1@', 'h9@'), secret: false, headers: {'X-Signature': `sha256=${hex}`}});
    const h5 = await send(secHook.url, {raw: body, secret: false});
    expect([h1.status, h2.status]).toEqual([200, 200]);
    expect(h3.status).toBe(401);
    expect(String(h3.json.error)).toMatch(/does not match the body/);
    expect(h4.status).toBe(401);
    expect(h5.status).toBe(401);
    expect(String(h5.json.error)).toMatch(/Missing the X-Signature header/);
    await patch(secHook, {verifyEncoding: 'base64'});
    const b64 = await hmacBase64(KEY, body);
    expect((await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': b64}})).status).toBe(200);
    expect((await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': hex}})).status).toBe(401);

    // Regenerate: the old URL stops working, the new one works.
    const regen = must<{webhook: Hook}>(await browser.post(`/site-api/crm/incoming-webhooks/${secHook.id}/regenerate`, {}), 'regenerate').webhook;
    const oldRes = await send(secHook.url, {raw: body, secret: false, headers: {'X-Signature': b64}});
    const newRes = await send(regen.url, {raw: body, secret: false, headers: {'X-Signature': b64}});
    expect(regen.url).not.toBe(secHook.url);
    expect([oldRes.status, newRes.status]).toEqual([404, 200]);
  });

  it('rate limits per URL and refuses bodies over 256 KB', async () => {
    await setup();
    const rateHook = await hook({name: 'Rate', action: 'automations', config: {rateLimit: 3}});
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await send(rateHook.url, {json: {i}})).status);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const formHook = await hook({name: 'Website form', action: 'contact', config: {mapping: [{path: 'email', target: 'contact.email'}]}});
    const big = await send(formHook.url, {json: {email: 'big@northwind.example', blob: 'x'.repeat(300 * 1024)}});
    expect(big.status).toBe(413);
    expect(String(big.json.error)).toMatch(/larger than 256 KB/);
    expect(await db.incomingWebhookRequest.findFirst({where: {webhookId: formHook.id, status: 'rejected', error: {contains: '256 KB'}}})).toBeTruthy();
  });

  it('captures the next request as a sample while listening (even when off), redacted, writing nothing', async () => {
    await setup();
    const capHook = await hook({name: 'Capture', action: 'contact', config: {mapping: [{path: 'customer.email', target: 'contact.email'}]}});
    await patch(capHook, {active: false});
    const listening = must<{webhook: Hook}>(await browser.post(`/site-api/crm/incoming-webhooks/${capHook.id}/listen`, {on: true}), 'listen').webhook;
    expect(listening.listening).toBe(true);
    expect(listening.listenUntil).toBeTruthy();
    const capEmail = 'capture@northwind.example';
    const cap = await send(capHook.url, {json: {customer: {email: capEmail, first_name: 'Cap'}, items: [{sku: 'A1'}]}, headers: {Authorization: 'Bearer top-secret', 'X-Api-Key': 'abc123'}});
    expect(cap.status).toBe(200);
    expect(cap.json.captured).toBe(true);
    const capRow = must<{webhook: Hook}>(await browser.get(`/site-api/crm/incoming-webhooks/${capHook.id}`), 'get hook').webhook;
    expect(capRow.listening).toBe(false);
    expect(capRow.sample?.payload?.customer?.email).toBe(capEmail);
    expect(capRow.sample?.payload?.items[0].sku).toBe('A1');
    expect(capRow.sample?.headers.authorization).toBe('[redacted]');
    expect(capRow.sample?.headers['x-api-key']).toBe('[redacted]');
    expect(capRow.sample?.headers['x-webhook-secret']).toBe('[redacted]');
    expect(await db.contact.findFirst({where: {email: capEmail}})).toBeNull();
    expect((await send(capHook.url, {json: {customer: {email: capEmail}}})).status).toBe(403);
  });

  it('logs requests (secrets redacted), filters failures, and retries a failed one with the fixed mapping', async () => {
    await setup();
    const failHook = await hook({name: 'Needs fixing', action: 'contact', config: {mapping: [{path: 'job', target: 'contact.title'}]}});
    const fr = await deliver(failHook.url, {json: {job: 'CTO', mail: 'retry@northwind.example'}, headers: {'X-Api-Key': 'k-123', 'X-Request-Source': 'test'}});
    expect(fr.row?.status).toBe('failed');
    expect(fr.row?.error).toMatch(/Nothing identifies the contact/);
    const log = must<{rows: {status: string; body: string; headers: Record<string, string>}[]}>(await browser.get(`/site-api/crm/incoming-webhooks/${failHook.id}/requests`), 'log').rows;
    expect(log[0]?.status).toBe('failed');
    expect(log[0]?.body).toContain('"job": "CTO"');
    expect(log[0]?.headers['x-api-key']).toBe('[redacted]');
    expect(log[0]?.headers['x-request-source']).toBe('test');
    expect(must<{rows: unknown[]}>(await browser.get(`/site-api/crm/incoming-webhooks/${failHook.id}/requests?status=failed`), 'failed log').rows).toHaveLength(1);

    await patch(failHook, {config: {mapping: [{path: 'job', target: 'contact.title'}, {path: 'mail', target: 'contact.email'}]}});
    must(await browser.post(`/site-api/crm/incoming-webhooks/requests/${fr.http.json.id}/retry`, {}), 'retry');
    const retried = await db.incomingWebhookRequest.findUnique({where: {id: fr.http.json.id as string}});
    expect(retried?.status).toBe('processed');
    expect((retried?.result as {outcome: string}).outcome).toBe('created');
    expect((await db.contact.findFirst({where: {email: 'retry@northwind.example'}}))?.title).toBe('CTO');
    expect((await browser.post(`/site-api/crm/incoming-webhooks/requests/${fr.http.json.id}/retry`, {})).status).toBe(400);
  });

  it('audits config changes, secret-name changes, URL regeneration and retries without any secret or URL token', async () => {
    await setup();
    const secHook = await hook({name: 'Secured', action: 'contact', config: {mapping: [{path: 'email', target: 'contact.email'}]}});
    await patch(secHook, {config: {tags: ['x']}});
    await patch(secHook, {secretName: 'INCOMING_OTHER_SECRET'});
    env.INCOMING_OTHER_SECRET = SECRET;
    secretNames.add('INCOMING_OTHER_SECRET');
    const regen = must<{webhook: Hook}>(await browser.post(`/site-api/crm/incoming-webhooks/${secHook.id}/regenerate`, {}), 'regenerate').webhook;
    const failed = await send(regen.url, {json: {nothing: true}});
    must(await browser.post(`/site-api/crm/incoming-webhooks/requests/${failed.json.id}/retry`, {}), 'retry');

    const audits = await db.auditLog.findMany({where: {entity: 'incoming_webhook', recordId: secHook.id}, select: {action: true, category: true, meta: true}});
    const actions = new Set(audits.map((a) => a.action));
    for (const a of ['incoming_webhook.created', 'incoming_webhook.updated', 'incoming_webhook.url_regenerated', 'incoming_webhook.request_retried']) expect(actions, a).toContain(a);
    // Adapted: the secret itself is an owner secret now; changing which one is a settings change naming it.
    expect(audits.some((a) => a.action === 'incoming_webhook.updated' && ((a.meta as {changed?: string[]}).changed ?? []).includes('secretName'))).toBe(true);
    expect(audits.filter((a) => a.action === 'incoming_webhook.url_regenerated').every((a) => a.category === 'security')).toBe(true);
    const blob = JSON.stringify(audits);
    expect(blob).not.toContain(SECRET);
    for (const token of [secHook, regen].map((h) => h.url.split('/').pop()!)) expect(blob).not.toContain(token);

    // The token is stored encrypted; no secret value is stored at all, only its site secret's name.
    const stored = await db.incomingWebhook.findUniqueOrThrow({where: {id: secHook.id}, select: {secret: true, token: true, secretName: true}});
    expect(stored.token.startsWith('v1.')).toBe(true);
    expect(stored.secret).toBeNull();
    expect(stored.secretName).toBe('INCOMING_OTHER_SECRET');
    const listed = must<{rows: (Hook & Record<string, unknown>)[]}>(await browser.get('/site-api/crm/incoming-webhooks'), 'list').rows.find((h) => h.id === secHook.id);
    expect(listed?.secretAdded).toBe(true);
    expect(listed && 'secret' in listed).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });
});
