import {createHash, createHmac} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import {app} from '../../../src/server/app';
import {owner, resetCrm, teammate, userId} from '../support/crm';
import {type Browser, configureEnv, DATABASE_URL, db, ORIGIN} from '../support/harness';

/**
 * Ported from Kinroot's scripts/test-data-in.mjs
 * The Data in API: keys (shown once, hashed, last used, revoked, owner deactivated), every
 * X-Signature error, the signing secret (Show audited, regenerate), every action with its update
 * path and field errors, Idempotency-Key replays, rate limit, body size, the request log (no keys or
 * secrets), timeline / history / audit entries and automations started by a custom event.
 */

const API = '/site-api/crm/public/data-in/v1';
const now = () => Math.floor(Date.now() / 1000);
const sign = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

type Res = {status: number; data: any; headers: Headers; sig?: string};

/** A request from another service: no session, no CSRF (the route sits before them), its own address. */
async function hook(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return inRequestScope(async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
    const res = await app.request(`${ORIGIN}${path}`, {method, headers: {'cf-connecting-ip': '198.51.100.30', ...headers}, body}, {}, ctx as never);
    while (pending.length) await pending.shift();
    const text = await res.text();
    await getDb()?.$disconnect();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return {status: res.status, data, headers: res.headers};
  });
}

let own: Browser;
let me: {id: string};
let KEY = '';
let SECRET = '';
let keyId = '';
let n = 0;

type CallOpt = {raw?: string; t?: number; key?: string | null; signature?: string | null; secret?: string; signedBody?: string; idem?: string; method?: string};
/** Bearer key + X-Signature over "<t>.<raw body>"; options override any part to test the refusals. */
async function call(path: string, body?: unknown, opt: CallOpt = {}): Promise<Res> {
  const raw = opt.raw ?? JSON.stringify(body ?? {});
  const t = opt.t ?? now();
  const headers: Record<string, string> = {'content-type': 'application/json'};
  const key = opt.key === undefined ? KEY : opt.key;
  if (key) headers.authorization = `Bearer ${key}`;
  if (opt.signature !== null) headers['x-signature'] = opt.signature ?? `t=${t},v1=${sign(opt.secret ?? SECRET, t, opt.signedBody ?? raw)}`;
  if (opt.idem) headers['idempotency-key'] = opt.idem;
  const method = opt.method ?? 'POST';
  const res = await hook(method, API + path, headers, method === 'GET' ? undefined : raw);
  return {...res, sig: headers['x-signature']};
}
const code = (r: Res) => r.data?.error?.code;
const field = (r: Res) => r.data?.error?.field;
const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};
const canon = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const EMAIL = 'maya@northwind-port.io';
const maya = () => ({
  email: EMAIL.toUpperCase(),
  firstName: 'Maya',
  lastName: 'Patel',
  jobTitle: 'Head of Ops',
  phone: '+1 415 555 0199',
  company: 'Northwind Port',
  companyDomain: 'https://www.northwind-port.io/about',
  lifecycleStage: 'lead',
  tags: ['Trial', 'api-port'],
});

describe.skipIf(!DATABASE_URL)('Ported: Data in API (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    own = await owner();
    await own.get('/site-api/crm/auth/state');
    await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
    me = await db.member.findUniqueOrThrow({where: {userId: await userId('owner@example.com')}, select: {id: true}});
    const k1 = await ok(own.post('/site-api/crm/data-in/keys', {name: 'Website'}), 201);
    KEY = k1.plain;
    keyId = k1.key.id;
    SECRET = (await ok(own.post('/site-api/crm/data-in/secret/reveal', {}))).secret;
  });

  it('shows a key once, stores only its hash and prefix, and audits it and the secret’s Show', async () => {
    const overview = await ok(own.get('/site-api/crm/data-in'));
    expect(overview.baseUrl.endsWith('/site-api/crm/public/data-in/v1')).toBe(true);
    expect(overview.secret.masked.startsWith('crm_sig_') && overview.secret.masked.includes('•')).toBe(true);
    expect(KEY.startsWith('crm_live_') && KEY.length > 30).toBe(true);
    const row = await db.apiKey.findUniqueOrThrow({where: {id: keyId}});
    expect(row.prefix).toBe(KEY.slice(0, 15));
    expect(row.keyHash).toBe(createHash('sha256').update(`apikey:${KEY}`).digest('hex'));
    expect(Object.values(row).some(v => typeof v === 'string' && v.includes(KEY))).toBe(false);
    const listed = overview.keys.find((k: {id: string}) => k.id === keyId);
    expect(listed.createdBy?.id).toBe(me.id);
    expect(listed.lastUsedAt).toBeNull();
    expect(JSON.stringify(overview)).not.toContain(KEY);
    const keyAudit = await db.auditLog.findFirstOrThrow({where: {action: 'api_key.created', recordId: keyId}});
    expect(keyAudit.category).toBe('security');
    expect(JSON.stringify(keyAudit.meta)).not.toContain(KEY);
    expect((keyAudit.meta as {fingerprint: string}).fingerprint).toHaveLength(12);

    // The signing secret: Show returns it, the overview never does; stored encrypted.
    expect(SECRET.startsWith('crm_sig_') && SECRET.length > 40).toBe(true);
    expect(JSON.stringify(overview)).not.toContain(SECRET);
    const revealAudit = await db.auditLog.findFirstOrThrow({where: {action: 'data_in.secret_revealed'}, orderBy: {createdAt: 'desc'}});
    expect(revealAudit.category).toBe('security');
    expect((revealAudit.meta as {fingerprint: string}).fingerprint).toBe(createHash('sha256').update(SECRET).digest('hex').slice(0, 12));
    expect(JSON.stringify(revealAudit.meta)).not.toContain(SECRET);
    expect(revealAudit.actorId).toBe(me.id);
    const setting = await db.setting.findUniqueOrThrow({where: {key: 'data-in'}});
    expect((setting.value as {secret: string}).secret.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(setting.value)).not.toContain(SECRET);
  });

  it('refuses missing or unknown keys, every signature problem, bad JSON and unknown routes', async () => {
    const sample = {email: 'sig@client-port.io'};
    const noKey = await call('/contacts', sample, {key: null});
    expect([noKey.status, code(noKey)]).toEqual([401, 'E_UNAUTHORIZED']);
    expect(noKey.data.error.message).toMatch(/Bearer/);
    const badKey = await call('/contacts', sample, {key: `crm_live_${'x'.repeat(32)}`});
    expect([badKey.status, code(badKey)]).toEqual([401, 'E_UNAUTHORIZED']);
    const noSig = await call('/contacts', sample, {signature: null});
    expect([noSig.status, code(noSig)]).toEqual([401, 'E_SIGNATURE_MISSING']);
    expect(code(await call('/contacts', sample, {signature: 'sha256=abc'}))).toBe('E_SIGNATURE_INVALID');
    expect(code(await call('/contacts', sample, {secret: 'crm_sig_not-the-secret'}))).toBe('E_SIGNATURE_INVALID');
    expect(code(await call('/contacts', sample, {signedBody: JSON.stringify({email: 'other@client-port.io'})}))).toBe('E_SIGNATURE_INVALID');
    const expired = await call('/contacts', sample, {t: now() - 400});
    expect([expired.status, code(expired)]).toEqual([401, 'E_SIGNATURE_EXPIRED']);
    expect(code(await call('/contacts', sample, {t: now() + 400}))).toBe('E_SIGNATURE_EXPIRED');
    const first = await call('/contacts', sample);
    const replay = await call('/contacts', sample, {signature: first.sig});
    expect(first.status).toBe(201);
    expect([replay.status, code(replay)]).toEqual([401, 'E_SIGNATURE_REUSED']);
    expect((await db.apiKey.findUniqueOrThrow({where: {id: keyId}})).lastUsedAt).not.toBeNull();
    const notJson = await call('/contacts', undefined, {raw: '{"email": '});
    expect([notJson.status, code(notJson)]).toEqual([400, 'E_INVALID_JSON']);
    expect(code(await call('/contacts', undefined, {raw: '[1,2]'}))).toBe('E_INVALID_JSON');
    const unknown = await call('/nope', {});
    expect([unknown.status, code(unknown)]).toEqual([404, 'E_NOT_FOUND']);
    expect(await db.dataInRequest.count({where: {path: '/nope'}})).toBe(0);
    const get = await call('/contacts', undefined, {method: 'GET'});
    expect([get.status, code(get)]).toEqual([404, 'E_NOT_FOUND']);
  });

  it('POST /contacts creates, updates only what is sent, matches by email or phone, and names the bad field', async () => {
    const plan = (await ok(own.post('/site-api/crm/fields', {entity: 'CONTACT', label: 'Plan', type: 'SELECT', options: ['Free', 'Pro']}), 201)).field;
    const list = (await ok(own.post('/site-api/crm/lists', {name: 'API leads', kind: 'STATIC'}), 201)).list;
    const body = {...maya(), lists: [list.name], custom: {[plan.key]: 'Pro'}, note: 'Signed up from the pricing page.'};
    const pwd = await call('/contacts', {...body, password: 'hunter2-must-not-be-logged'});
    expect([pwd.status, code(pwd), field(pwd)]).toEqual([422, 'E_INVALID_FIELD', 'password']);

    const created = await call('/contacts', body);
    const r1 = created.data.result;
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ok: true, action: 'contacts.upsert', result: {outcome: 'created'}});
    expect(r1.url.endsWith(`/contacts/${r1.id}`)).toBe(true);
    const contact = await db.contact.findUniqueOrThrow({where: {id: r1.id}});
    expect(contact).toMatchObject({email: EMAIL, title: 'Head of Ops', lifecycleStage: 'LEAD', ownerId: me.id, source: 'API: Website'});
    expect(contact.tags).toEqual(expect.arrayContaining(['trial', 'api-port']));
    expect((contact.custom as Record<string, unknown>)[plan.key]).toBe('Pro');
    const link = await db.contactCompany.findFirstOrThrow({where: {contactId: contact.id}, include: {company: true}});
    expect(link.company).toMatchObject({name: 'Northwind Port', domain: 'northwind-port.io'});
    expect(r1.companyId).toBe(link.company.id);
    expect(await db.contactListMember.count({where: {listId: list.id, contactId: contact.id}})).toBe(1);
    expect(r1.lists?.[0]).toBe(list.id);
    expect(await db.note.findFirst({where: {contactId: contact.id}})).toMatchObject({body: 'Signed up from the pricing page.', authorId: me.id});
    const act = await db.activity.findFirstOrThrow({where: {contactId: contact.id, type: 'contact_created'}});
    expect(act.title).toBe('Created by API key Website');
    expect((act.data as {source?: {kind: string}}).source?.kind).toBe('api');
    expect(act.actorId).toBe(me.id);
    expect((await db.event.findFirstOrThrow({where: {type: 'contact.created', recordId: contact.id}})).actorId).toBe(me.id);
    const au = await db.auditLog.findFirstOrThrow({where: {action: 'contact.created', recordId: contact.id}});
    expect(au.actorId).toBe(me.id);
    expect(au.meta).toMatchObject({dataInKey: {id: keyId}, source: {kind: 'api'}});

    // Same email: only the sent fields change; null clears; tags are added.
    const upd = await call('/contacts', {email: EMAIL, jobTitle: 'COO', phone: null, tags: ['vip']});
    expect([upd.status, upd.data.result.outcome, upd.data.result.id]).toEqual([200, 'updated', contact.id]);
    const after = await db.contact.findUniqueOrThrow({where: {id: contact.id}});
    expect(after).toMatchObject({title: 'COO', phone: null, lastName: 'Patel'});
    expect(after.tags).toEqual(expect.arrayContaining(['vip', 'trial']));
    const changed = await db.activity.findFirstOrThrow({where: {contactId: contact.id, type: 'field_changed'}, orderBy: {createdAt: 'desc'}});
    expect(changed.title).toBe('Updated by API key Website');
    expect((changed.data as {changes: {field: string; from: unknown; to: unknown}[]}).changes).toContainEqual(expect.objectContaining({field: 'title', from: 'Head of Ops', to: 'COO'}));
    const hist = await ok(own.get(`/site-api/crm/history?entity=contact&id=${contact.id}&take=100`));
    const histRow = hist.rows?.find((r: {field: string; to: unknown}) => r.field === 'title' && r.to === 'COO');
    expect(histRow?.actor).toMatchObject({kind: 'api', name: 'API: Website'});
    expect(await db.auditLog.count({where: {action: 'contact.updated', recordId: contact.id, meta: {path: ['dataInKey', 'id'], equals: keyId}}})).toBe(1);
    const same = await call('/contacts', {email: EMAIL, jobTitle: 'COO'});
    expect([same.status, same.data.result.outcome]).toEqual([200, 'unchanged']);

    const phoneOnly = await call('/contacts', {phone: '+1 (212) 555-1234', firstName: 'Phone'});
    expect(phoneOnly.status).toBe(201);
    const phoneMatch = await call('/contacts', {phone: '2125551234', lastName: 'Match'});
    expect([phoneMatch.status, phoneMatch.data.result.id]).toEqual([200, phoneOnly.data.result.id]);

    const v1 = await call('/contacts', {firstName: 'Nobody'});
    expect([v1.status, field(v1)]).toEqual([422, 'email']);
    expect(v1.data.error.message).toMatch(/email, phone/);
    expect(field(await call('/contacts', {email: EMAIL, tags: ['a', 'b', 7]}))).toBe('tags.2');
    expect(field(await call('/contacts', {email: 'not-an-email'}))).toBe('email');
    expect(field(await call('/contacts', {email: EMAIL, custom: {nope: 1}}))).toBe('custom.nope');
    expect(field(await call('/contacts', {email: EMAIL, custom: {[plan.key]: 'Enterprise'}}))).toBe('custom');
    const v6 = await call('/contacts', {email: EMAIL, lifecycleStage: 'ALIEN'});
    expect(field(v6)).toBe('lifecycleStage');
    expect(v6.data.error.message).toMatch(/LEAD/);
    const v7 = await call('/contacts', {email: EMAIL, owner: 'ghost@client-port.io'});
    expect([v7.status, code(v7), field(v7)]).toEqual([404, 'E_NOT_FOUND', 'owner']);
    const v8 = await call('/contacts', {email: EMAIL, lists: ['No such list']});
    expect([v8.status, field(v8)]).toEqual([404, 'lists.0']);
    expect((await db.contact.findUniqueOrThrow({where: {id: contact.id}})).title).toBe('COO');
  });

  it('answers a url that opens the record in the CRM (/crm/contacts/<id>)', async () => {
    const created = await call('/contacts', maya());
    expect(created.data.result.url).toMatch(new RegExp(`/crm/contacts/${created.data.result.id}$`));
  });

  it('POST /companies creates by domain, matches by name, and names the bad field', async () => {
    const co1 = await call('/companies', {domain: 'https://www.acme-port.example/', employees: 120, industry: 'Logistics', tags: ['Partner']});
    expect([co1.status, co1.data.result.outcome]).toEqual([201, 'created']);
    const company = await db.company.findUniqueOrThrow({where: {id: co1.data.result.id}});
    expect(company).toMatchObject({domain: 'acme-port.example', name: 'Acme Port', employees: 120});
    expect(company.tags).toContain('partner');
    expect(await db.activity.count({where: {companyId: company.id, type: 'company_created', title: 'Created by API key Website'}})).toBe(1);
    const co2 = await call('/companies', {name: company.name.toUpperCase(), city: 'Berlin'});
    expect([co2.status, co2.data.result.id, co2.data.result.outcome]).toEqual([200, company.id, 'updated']);
    expect(field(await call('/companies', {domain: 'acme-port.example', employees: 'many'}))).toBe('employees');
    expect(field(await call('/companies', {city: 'Paris'}))).toBe('domain');
  });

  it('POST /deals creates in the pipeline and stage named, with its contact and company', async () => {
    const pipe = (await ok(own.get('/site-api/crm/pipelines'))).rows.find((p: {stages: unknown[]}) => p.stages.length >= 2);
    const stage = pipe.stages[1];
    const buyer = 'buyer@client-port.io';
    const d1 = await call('/deals', {title: 'Annual plan', value: 1800, currency: 'eur', pipeline: pipe.name.toLowerCase(), stage: stage.name, contactEmail: buyer, contactFirstName: 'Bea', company: 'Buyer Co', tags: ['inbound']});
    expect(d1.status, JSON.stringify(d1.data)).toBe(201);
    const deal = await db.deal.findUniqueOrThrow({where: {id: d1.data.result.id}});
    expect(deal).toMatchObject({title: 'Annual plan', value: 1800, currency: 'EUR', pipelineId: pipe.id, stageId: stage.id, ownerId: me.id});
    const bea = await db.contact.findFirstOrThrow({where: {email: buyer}});
    expect(bea.firstName).toBe('Bea');
    expect(d1.data.result.contactOutcome).toBe('created');
    expect(await db.dealContact.count({where: {dealId: deal.id, contactId: bea.id}})).toBe(1);
    expect((await db.company.findUniqueOrThrow({where: {id: deal.companyId!}})).name).toBe('Buyer Co');
    expect(await db.activity.count({where: {dealId: deal.id, type: 'deal_created', title: {startsWith: 'Deal created by API key'}}})).toBe(1);
    expect(await db.event.count({where: {type: 'deal.created', recordId: deal.id}})).toBe(1);
    const d2 = await call('/deals', {title: 'Won deal', contactEmail: buyer, status: 'won'});
    expect(d2.status).toBe(201);
    expect(d2.data.result).toMatchObject({contactOutcome: 'found', contactId: bea.id, status: 'WON'});
    expect(await db.event.count({where: {type: 'deal.won', recordId: d2.data.result.id}})).toBe(1);
    const d3 = await call('/deals', {title: 'x', pipeline: 'No pipeline'});
    expect([d3.status, code(d3), field(d3)]).toEqual([404, 'E_NOT_FOUND', 'pipeline']);
    const d4 = await call('/deals', {value: 10});
    expect([d4.status, field(d4)]).toEqual([422, 'title']);
    expect(d4.data.error.message).toMatch(/required/);
  });

  it('POST /tickets, /notes and /activities land on the right records', async () => {
    const contactId = (await call('/contacts', maya())).data.result.id;
    const companyId = (await call('/companies', {domain: 'acme-port.example'})).data.result.id;
    const pipe = (await ok(own.get('/site-api/crm/pipelines'))).rows[0];
    const dealId = (await call('/deals', {title: 'Deal', pipeline: pipe.name})).data.result.id;

    const t1 = await call('/tickets', {subject: 'Invoice wrong', description: 'Old address on the invoice.', priority: 'high', contactEmail: EMAIL, category: 'Billing'});
    const ticket = await db.ticket.findUniqueOrThrow({where: {id: t1.data.result.id}});
    expect(t1.status).toBe(201);
    expect(ticket).toMatchObject({source: 'API', priority: 'HIGH', contactId});
    expect(t1.data.result.number).toBe(ticket.number);
    expect(await db.activity.count({where: {refId: ticket.id, type: 'ticket_created'}})).toBe(1);
    expect(await db.auditLog.count({where: {action: 'ticket.created', recordId: ticket.id}})).toBe(1);
    const t2 = await call('/tickets', {subject: 'New customer', contactEmail: 'newcust@client-port.io'});
    expect(t2.status).toBe(201);
    expect((await db.contact.findUniqueOrThrow({where: {id: t2.data.result.contactId}})).email).toBe('newcust@client-port.io');
    expect(field(await call('/tickets', {subject: 'x', priority: 'asap'}))).toBe('priority');

    const n1 = await call('/notes', {contactEmail: EMAIL, body: 'Asked for 20 more seats'});
    expect(n1.status).toBe(201);
    expect(await db.note.findUniqueOrThrow({where: {id: n1.data.result.id}})).toMatchObject({contactId, authorId: me.id});
    expect(await db.activity.count({where: {refId: n1.data.result.id, type: 'note'}})).toBe(1);
    const n2 = await call('/notes', {companyDomain: 'acme-port.example', dealId, body: 'Two records'});
    expect(n2.status).toBe(201);
    expect(n2.data.result).toMatchObject({companyId, dealId});
    const n3 = await call('/notes', {contactEmail: 'ghost@client-port.io', body: 'x'});
    expect([n3.status, field(n3)]).toEqual([404, 'contactEmail']);
    const n4 = await call('/notes', {body: 'x'});
    expect([n4.status, field(n4)]).toEqual([422, 'contactId']);

    const a1 = await call('/activities', {kind: 'call', title: 'Renewal call', durationMin: 20, outcome: 'Connected', direction: 'OUTBOUND', contactEmail: EMAIL});
    expect(a1.status).toBe(201);
    const inter = await db.interaction.findUniqueOrThrow({where: {id: a1.data.result.id}});
    expect(inter).toMatchObject({kind: 'CALL', contactId, authorId: me.id, durationMin: 20});
    expect(await db.activity.count({where: {refId: inter.id, type: 'interaction_CALL'}})).toBe(1);
    expect(await db.event.count({where: {type: 'interaction.logged', recordId: inter.id}})).toBe(1);
    const a2 = await call('/activities', {kind: 'MEETING', contactId, dealId, title: 'Kickoff', occurredAt: '2026-01-15T10:00:00Z'});
    expect([a2.status, a2.data.result.dealId]).toEqual([201, dealId]);
    expect(field(await call('/activities', {kind: 'MEETING', contactEmail: EMAIL}))).toBe('title');
    expect(field(await call('/activities', {kind: 'CALL', contactEmail: EMAIL, occurredAt: 'yesterday'}))).toBe('occurredAt');
  });

  it('POST /lists/{list}/members adds by name or id, creates missing contacts, refuses dynamic lists', async () => {
    const list = (await ok(own.post('/site-api/crm/lists', {name: 'API leads', kind: 'STATIC'}), 201)).list;
    await call('/contacts', {...maya(), lists: [list.name]});
    const buyer = 'buyer@client-port.io';
    expect((await call('/contacts', {email: buyer})).status).toBe(201);
    const stranger = 'stranger@client-port.io';
    const l1 = await call(`/lists/${encodeURIComponent(list.name)}/members`, {emails: [buyer, stranger, EMAIL]});
    expect(l1.status).toBe(200);
    expect(l1.data.result).toMatchObject({listId: list.id, added: 1, alreadyMembers: 1, notFound: [stranger]});
    const l2 = await call(`/lists/${list.id}/members`, {emails: [stranger, buyer], createMissing: true});
    expect(l2.data.result).toMatchObject({created: 1, added: 1, alreadyMembers: 1});
    const strangerRow = await db.contact.findFirstOrThrow({where: {email: stranger}});
    expect(await db.contactListMember.count({where: {listId: list.id, contactId: strangerRow.id}})).toBe(1);
    expect(await db.activity.count({where: {contactId: strangerRow.id, type: 'list_added'}})).toBe(1);
    const dyn = (await ok(own.post('/site-api/crm/lists', {name: 'Dynamic', kind: 'DYNAMIC', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'lifecycleStage', op: 'is_any', values: ['CUSTOMER']}]}]}}), 201)).list;
    const l3 = await call(`/lists/${dyn.id}/members`, {emails: [buyer]});
    expect([l3.status, field(l3)]).toEqual([422, 'list']);
    const l4 = await call('/lists/nothing-here/members', {emails: [buyer], createMissing: false});
    expect([l4.status, field(l4)]).toEqual([404, 'list']);
    const l5 = await call(`/lists/${list.id}/members`, {emails: ['nope']});
    expect([l5.status, field(l5)]).toEqual([422, 'emails.0']);
  });

  it('POST /events records the event and starts only the automations filtered on its name', async () => {
    const contactId = (await call('/contacts', maya())).data.result.id;
    const step = (tag: string) => [{id: 't', type: 'add_tag', target: 'contact', tag}];
    for (const [name, event, tag] of [['Trial started', 'trial.started', 'trial-auto'], ['Order shipped', 'order.shipped', 'wrong-auto']]) {
      const a = (await ok(own.post('/site-api/crm/automations', {timezone: 'UTC', name, object: 'contact', trigger: {kind: 'event', event: 'data_in.received', filter: {dataInEvent: event}}, steps: step(tag!)}), 201)).automation;
      await ok(own.post(`/site-api/crm/automations/${a.id}/enable`, {enabled: true}));
    }
    const e1 = await call('/events', {event: 'trial.started', contactEmail: EMAIL, properties: {plan: 'Pro', seats: 12}});
    expect(e1.status, JSON.stringify(e1.data)).toBe(201);
    const ev = await db.event.findUniqueOrThrow({where: {id: e1.data.result.eventId}});
    expect(ev.type).toBe('data_in.received');
    expect(ev.data).toMatchObject({event: 'trial.started', contactId, properties: {seats: 12}, key: {id: keyId}});
    expect(await db.activity.count({where: {contactId, type: 'data_in_event', title: 'Event: trial.started'}})).toBe(1);
    // Jobs run as they are sent here: the automation has run by the time the answer is back.
    let tags: string[] = [];
    for (let i = 0; i < 20 && !tags.includes('trial-auto'); i++) {
      tags = (await db.contact.findUniqueOrThrow({where: {id: contactId}})).tags;
      if (!tags.includes('trial-auto')) await new Promise(r => setTimeout(r, 50));
    }
    expect(tags).toContain('trial-auto');
    expect(tags).not.toContain('wrong-auto');
    const e2 = await call('/events', {event: 'trial.started', contactEmail: 'nobody@client-port.io'});
    expect([e2.status, e2.data.result.contactId]).toEqual([201, null]);
    expect(field(await call('/events', {event: 'trial started!'}))).toBe('event');
  });

  it('answers a repeated Idempotency-Key with the stored answer and runs the action once', async () => {
    const idemEmail = 'idem@client-port.io';
    const body = {email: idemEmail, firstName: 'Ida'};
    const i1 = await call('/contacts', body, {idem: 'order-1'});
    // Re-signed with another time (the same body signed in the same second is a reused signature).
    const i2 = await call('/contacts', body, {idem: 'order-1', t: now() - 1});
    expect([i1.status, i2.status]).toEqual([201, 201]);
    expect(canon(i2.data)).toBe(canon(i1.data));
    expect(i2.headers.get('idempotent-replayed')).toBe('true');
    expect(await db.contact.count({where: {email: idemEmail}})).toBe(1);
    expect(await db.activity.count({where: {type: 'contact_created', contact: {email: idemEmail}}})).toBe(1);
    expect(await db.dataInRequest.count({where: {idempotencyKey: 'order-1', replayed: true}})).toBe(1);
    const i3 = await call('/notes', {contactEmail: idemEmail, body: 'x'}, {idem: 'order-1'});
    expect([i3.status, field(i3)]).toEqual([422, 'Idempotency-Key']);
    // A refused request does not burn its key.
    expect((await call('/contacts', {email: 'bad'}, {idem: 'bad-1'})).status).toBe(422);
    expect((await call('/contacts', {email: 'fixed@client-port.io'}, {idem: 'bad-1'})).status).toBe(201);
  });

  it('refuses a body over the limit and a key over its rate limit (per key), and audits the change', async () => {
    const big = await call('/contacts', {email: 'big@client-port.io', note: 'x'.repeat(300 * 1024)});
    expect([big.status, code(big)]).toEqual([413, 'E_PAYLOAD_TOO_LARGE']);
    const k2 = await ok(own.post('/site-api/crm/data-in/keys', {name: 'Limited'}), 201);
    await ok(own.request('PATCH', '/site-api/crm/data-in/settings', {rateLimit: 3}));
    const limited: Res[] = [];
    for (let i = 0; i < 4; i++) limited.push(await call('/events', {event: 'ping', properties: {n: n++}}, {key: k2.plain}));
    expect(limited.map(r => r.status)).toEqual([201, 201, 201, 429]);
    expect(code(limited[3]!)).toBe('E_RATE_LIMITED');
    const k3 = await ok(own.post('/site-api/crm/data-in/keys', {name: 'Other'}), 201);
    expect((await call('/events', {event: 'ping', properties: {n: n++}}, {key: k3.plain})).status).toBe(201);
    await ok(own.request('PATCH', '/site-api/crm/data-in/settings', {rateLimit: 120}));
    expect(await db.auditLog.count({where: {action: 'data_in.settings_updated', category: 'settings'}})).toBeGreaterThan(0);
  });

  it('acts as the key’s creator, refuses it once they are deactivated, and refuses a revoked key', async () => {
    const {browser: admin2} = await teammate(own, 'admin.two@example.com', 'ADMIN');
    const adminId = (await db.member.findUniqueOrThrow({where: {userId: await userId('admin.two@example.com')}})).id;
    const k3 = await ok(admin2.post('/site-api/crm/data-in/keys', {name: 'Admin two'}), 201);
    const owned = await call('/contacts', {email: 'owned@client-port.io'}, {key: k3.plain});
    expect(owned.status).toBe(201);
    expect((await db.contact.findUniqueOrThrow({where: {id: owned.data.result.id}})).ownerId).toBe(adminId);
    await ok(own.request('PATCH', `/site-api/crm/team/${adminId}`, {active: false}));
    const inactive = await call('/contacts', {email: 'owned2@client-port.io'}, {key: k3.plain});
    expect([inactive.status, code(inactive)]).toEqual([403, 'E_KEY_OWNER_INACTIVE']);

    const k2 = await ok(own.post('/site-api/crm/data-in/keys', {name: 'Soon revoked'}), 201);
    const revoked = await ok(own.delete(`/site-api/crm/data-in/keys/${k2.key.id}`));
    expect(revoked.key.revokedAt).toBeTruthy();
    const after = await call('/events', {event: 'ping', properties: {n: n++}}, {key: k2.plain});
    expect([after.status, code(after)]).toEqual([401, 'E_UNAUTHORIZED']);
    expect(after.data.error.message).toMatch(/revoked/);
    expect(await db.auditLog.count({where: {action: 'api_key.revoked', recordId: k2.key.id, category: 'security'}})).toBe(1);
  });

  it('regenerates the signing secret: old signatures are refused at once, the new secret works', async () => {
    const oldSecret = SECRET;
    const regen = await ok(own.post('/site-api/crm/data-in/secret/regenerate', {}));
    expect(JSON.stringify(regen)).not.toContain(oldSecret);
    expect(regen.secret.masked.startsWith('crm_sig_')).toBe(true);
    const oldSig = await call('/events', {event: 'ping', properties: {n: n++}}, {secret: oldSecret});
    expect([oldSig.status, code(oldSig)]).toEqual([401, 'E_SIGNATURE_INVALID']);
    SECRET = (await ok(own.post('/site-api/crm/data-in/secret/reveal', {}))).secret;
    expect(SECRET).not.toBe(oldSecret);
    expect((await call('/events', {event: 'ping', properties: {n: n++}})).status).toBe(201);
    expect(await db.auditLog.count({where: {action: 'data_in.secret_regenerated', category: 'security'}})).toBe(1);
  });

  it('logs requests with their key, records and outcome, filters them, and never keeps keys, secrets or Authorization', async () => {
    const created = await call('/contacts', maya());
    const contactId = created.data.result.id;
    await call('/contacts', maya(), {signature: created.sig}); // the same request again: a reused signature
    await call('/contacts', {email: 'big@client-port.io', note: 'x'.repeat(300 * 1024)});
    await call('/contacts', {email: 'x@client-port.io'}, {key: `crm_live_${'y'.repeat(32)}`});

    const logs = await ok(own.get('/site-api/crm/data-in/logs?action=contacts.upsert'));
    expect(logs.rows.length).toBeGreaterThan(0);
    expect(logs.rows.every((r: {action: string}) => r.action === 'contacts.upsert')).toBe(true);
    const createdLog = logs.rows.find((r: {status: number; records: {entity: string; id: string}[]}) => r.status === 201 && r.records.some(x => x.entity === 'contact' && x.id === contactId));
    const k = await db.apiKey.findUniqueOrThrow({where: {id: keyId}});
    expect(createdLog.key).toMatchObject({name: 'Website', prefix: k.prefix});
    expect(createdLog.durationMs).toBeGreaterThanOrEqual(0);
    expect(createdLog.response?.ok).toBe(true);
    expect(createdLog.body).toContain(EMAIL.toUpperCase());
    const failed = await ok(own.get('/site-api/crm/data-in/logs?status=failed'));
    expect(failed.rows.length).toBeGreaterThan(0);
    expect(failed.rows.every((r: {status: number}) => r.status >= 400)).toBe(true);
    expect(failed.rows.some((r: {errorCode: string}) => r.errorCode === 'E_SIGNATURE_REUSED')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const dated = await ok(own.get(`/site-api/crm/data-in/logs?from=${today}&to=${today}&q=E_PAYLOAD`));
    expect(dated.rows.length).toBeGreaterThanOrEqual(1);
    expect(dated.rows.every((r: {errorCode: string}) => r.errorCode === 'E_PAYLOAD_TOO_LARGE')).toBe(true);

    const pwd = await call('/contacts', {email: EMAIL, custom: {password: 'p4ss-should-not-log'}});
    expect(pwd.status).toBe(422);
    const pwdLog = await db.dataInRequest.findFirstOrThrow({orderBy: {createdAt: 'desc'}, select: {body: true}});
    expect(pwdLog.body).toContain('[redacted]');
    expect(pwdLog.body).not.toContain('p4ss-should-not-log');
    const rows = await db.dataInRequest.findMany({select: {body: true, response: true}});
    const all = JSON.stringify(rows);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/Bearer |authorization/i);
    const unauth = await db.dataInRequest.findFirstOrThrow({where: {errorCode: 'E_UNAUTHORIZED'}, orderBy: {createdAt: 'desc'}});
    expect(unauth.body).toBeNull();
  });
});
