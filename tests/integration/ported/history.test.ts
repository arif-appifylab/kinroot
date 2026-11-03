// Ported from Kinroot's scripts/test-history.mjs
// Property history and the activity tab counts: every change source shows up once, formatted, with the
// right actor; the per-property filter, search and paging; owner-only visibility; counts match the feed.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../../src/server/background';
import {configureEnv, DATABASE_URL, db} from '../support/harness';
import {resetCrm, teammate} from '../support/crm';
import {crm, meOf, must, workspace, type Crm, type Me} from './support-lists';

type Entry = {id: string; kind: string; field: string | null; label: string; from: string | null; to: string | null; note: string | null; at: string; actor: {kind: string; name: string; by?: string}};
type Page = {rows: Entry[]; nextCursor: string | null; total: number; fieldLabel: string | null; fields: {field: string; label: string; count: number}[]};
type Row = {id: string; [k: string]: unknown};

/** Every page of a record's property history. */
async function history(c: Crm, entity: string, id: string, extra = '') {
  const rows: Entry[] = [];
  let cursor = '';
  let first: Page | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await c.get(`/history?entity=${entity}&id=${id}&take=100${extra}${cursor ? `&cursor=${cursor}` : ''}`);
    if (r.status !== 200) return {status: r.status, rows: [] as Entry[], fields: [] as Page['fields'], total: 0, fieldLabel: null};
    const page = r.json as unknown as Page;
    first ??= page;
    rows.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return {status: 200, rows, fields: first!.fields, total: first!.total, fieldLabel: first!.fieldLabel};
}
const changesOf = (rows: Entry[], field: string) => rows.filter((r) => r.kind === 'change' && r.field === field);
const one = (rows: Entry[], field: string, to: string) => rows.filter((r) => r.kind === 'change' && r.field === field && r.to === to);

let o: Crm;
let me: Me;
let member: Crm;
let viewer: Crm;
let memberUser: Me;
let maya: Row;
let A: Row;
let D: Row;
let Co: Row;
let stages: {id: string; name: string}[];
let fields: Record<'region' | 'products' | 'renewal' | 'vip', {key: string; label: string}>;

describe.skipIf(!DATABASE_URL)('ported: property history and tab counts (scripts/test-history.mjs)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    ({c: o, me} = await workspace(true));
    member = crm((await teammate(o.browser, 'history-member@example.com', 'MEMBER')).browser);
    viewer = crm((await teammate(o.browser, 'history-viewer@example.com', 'VIEWER')).browser);
    memberUser = await meOf(member);
    maya = must<{rows: Row[]}>(await o.get('/contacts?q=Maya%20Chen'), 'maya').rows[0]!;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('demo data: Maya Chen has a property history out of the box', async () => {
    const h = await history(o, 'contact', maya.id);
    expect(h.status).toBe(200);
    expect(h.rows.length, 'Maya has history entries').toBeGreaterThanOrEqual(5);
    expect(h.rows.filter((r) => r.kind === 'created'), 'exactly one "Created" entry').toHaveLength(1);
    expect(one(h.rows, 'lifecycleStage', 'Qualified').some((r) => r.from === 'Lead'), 'lifecycle shown as labels: Lead → Qualified').toBe(true);
    expect(h.rows.every((r, i) => i === 0 || r.at <= h.rows[i - 1]!.at), 'newest first').toBe(true);
    expect(h.fields.some((f) => f.field === 'lifecycleStage' && f.label === 'Lifecycle stage' && f.count === 2), 'property filter lists Lifecycle stage (2)').toBe(true);
  });

  it('contact edits: single fields, custom select / multiselect / date / checkbox, owner', async () => {
    const mk = async (body: Record<string, unknown>) => must<{field: {key: string; label: string}}>(await o.post('/fields', body), 'field').field;
    fields = {
      region: await mk({entity: 'CONTACT', label: 'Region', type: 'SELECT', options: ['EMEA', 'Americas', 'APAC']}),
      products: await mk({entity: 'CONTACT', label: 'Products', type: 'MULTISELECT', options: ['CRM', 'Support', 'Billing']}),
      renewal: await mk({entity: 'CONTACT', label: 'Renewal', type: 'DATE'}),
      vip: await mk({entity: 'CONTACT', label: 'VIP', type: 'CHECKBOX'}),
    };
    const {region, products, renewal, vip} = fields;
    A = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Hist', lastName: 'A', email: 'hist-a@example.test', lifecycleStage: 'LEAD'}), 'A').contact;
    await o.patch(`/contacts/${A.id}`, {title: 'Buyer'});
    await o.patch(`/contacts/${A.id}`, {custom: {[region.key]: 'EMEA'}});
    await o.patch(`/contacts/${A.id}`, {custom: {[region.key]: 'APAC', [products.key]: ['CRM', 'Billing'], [renewal.key]: '2027-03-05', [vip.key]: true}});
    await o.patch(`/contacts/${A.id}`, {ownerId: memberUser.id});
    await o.patch(`/contacts/${A.id}`, {lifecycleStage: 'QUALIFIED', emailOptOut: true});

    const h = await history(o, 'contact', A.id);
    const title = one(h.rows, 'title', 'Buyer');
    expect(title, 'job title: empty → Buyer, once').toHaveLength(1);
    expect(title[0]!.from).toBeNull();
    expect(title[0]!.label, 'built-in label "Job title"').toBe('Job title');
    const regionRows = changesOf(h.rows, `custom.${region.key}`);
    expect(regionRows.map((r) => [r.from, r.to, r.label]), 'custom select by its label: EMEA → APAC (and empty → EMEA)').toEqual([
      ['EMEA', 'APAC', region.label],
      [null, 'EMEA', region.label],
    ]);
    expect(one(h.rows, `custom.${products.key}`, 'CRM, Billing'), 'multiselect shown as "CRM, Billing"').toHaveLength(1);
    expect(one(h.rows, `custom.${renewal.key}`, 'Mar 5, 2027'), 'custom date shown as "Mar 5, 2027"').toHaveLength(1);
    expect(one(h.rows, `custom.${vip.key}`, 'Yes'), 'checkbox shown as Yes').toHaveLength(1);
    const owners = changesOf(h.rows, 'ownerId');
    expect(owners.map((r) => [r.from, r.to]), 'owner by name: owner → member').toEqual([[me.name, memberUser.name]]);
    expect([owners[0]!.actor.kind, owners[0]!.actor.name], 'actor is the signed-in user').toEqual(['user', me.name]);
    const optOut = one(h.rows, 'emailOptOut', 'Yes');
    expect(optOut.map((r) => r.from), 'boolean: No → Yes').toEqual(['No']);
    expect(one(h.rows, 'lifecycleStage', 'Qualified'), 'lifecycle change once (timeline + audit deduplicated)').toHaveLength(1);
    const created = h.rows.filter((r) => r.kind === 'created');
    expect(created.map((r) => r.actor.name), '"Created" once, by the owner').toEqual([me.name]);
  });

  it('per-property filter, search and pagination', async () => {
    const {region, products} = fields;
    const h = await history(o, 'contact', A.id);
    const f = await history(o, 'contact', A.id, `&field=custom.${region.key}`);
    expect(f.rows).toHaveLength(3);
    expect(f.rows.slice(0, 2).every((r) => r.field === `custom.${region.key}`), 'filter: only that property, plus its creation row').toBe(true);
    expect([f.rows.at(-1)?.kind, f.rows.at(-1)?.to], 'creation row carries the initial value (empty)').toEqual(['created', null]);
    expect(f.fieldLabel, 'filter label comes back for the drawer').toBe(region.label);
    const fLast = await history(o, 'contact', A.id, '&field=lastName');
    expect(fLast.rows.map((r) => [r.kind, r.to]), 'unchanged property: creation row shows its current value').toEqual([['created', 'A']]);
    const s = await history(o, 'contact', A.id, '&q=billing');
    expect(s.rows.map((r) => r.field), 'search matches values').toEqual([`custom.${products.key}`]);
    const p1 = (await o.get(`/history?entity=contact&id=${A.id}&take=3`)).json as unknown as Page;
    const p2 = (await o.get(`/history?entity=contact&id=${A.id}&take=3&cursor=${p1.nextCursor}`)).json as unknown as Page;
    const ids = [...p1.rows, ...p2.rows].map((r) => r.id);
    expect([p1.rows.length, p1.nextCursor, p2.rows.length, new Set(ids).size], 'pages of 3 with a cursor, no repeats').toEqual([3, '3', 3, 6]);
    expect(ids, 'pages line up with the full list').toEqual(h.rows.slice(0, 6).map((r) => r.id));
  });

  it('bulk edit: old → new per record', async () => {
    await o.post('/contacts/bulk', {ids: [A.id], action: 'stage', value: 'CUSTOMER'});
    await o.post('/contacts/bulk', {ids: [A.id], action: 'assign', value: me.id});
    await o.post('/contacts/bulk', {ids: [A.id], action: 'tag', value: 't-bulk'});
    const h = await history(o, 'contact', A.id);
    const stage = one(h.rows, 'lifecycleStage', 'Customer');
    expect(stage.map((r) => [r.from, r.note]), 'bulk lifecycle: Qualified → Customer, noted as bulk edit').toEqual([['Qualified', 'Bulk edit']]);
    const own = changesOf(h.rows, 'ownerId')[0];
    expect([own?.from, own?.to], 'bulk assign: member → owner').toEqual([memberUser.name, me.name]);
    expect(one(h.rows, 'tags', 't-bulk'), 'bulk tag shows the tag list').toHaveLength(1);
  });

  it('merge: changed properties as "Merge", the dropped record’s own history stays out', async () => {
    const B = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Hist', lastName: 'B', phone: '+1 555 0199', city: 'Porto'}), 'B').contact;
    await o.patch(`/contacts/${B.id}`, {title: 'Ops lead'});
    const merge = await o.post(`/contacts/${A.id}/merge`, {otherId: B.id, keep: 'this', fields: {phone: 'other', city: 'other'}});
    expect(merge.status, JSON.stringify(merge.json)).toBe(200);
    const h = await history(o, 'contact', A.id);
    expect(h.rows.filter((r) => r.kind === 'merged').map((r) => r.note), 'one "Merged" entry naming the other contact').toEqual(['Merged with Hist B']);
    const phone = one(h.rows, 'phone', '+1 555 0199');
    expect(phone.map((r) => [r.actor.kind, r.actor.by]), 'phone change by "Merge" (by the owner)').toEqual([['merge', me.name]]);
    expect(h.rows.filter((r) => r.kind === 'created'), 'still one "Created"').toHaveLength(1);
    expect(one(h.rows, 'title', 'Ops lead'), 'the dropped contact’s own edits are not here').toHaveLength(0);
    const feed = must<{rows: {type: string; data: unknown}[]}>(await o.get(`/timeline?contactId=${A.id}&take=100`), 'feed');
    expect(feed.rows.some((r) => r.type === 'field_changed' && JSON.stringify(r.data).includes('Ops lead')), 'but they still show on the timeline').toBe(true);
  });

  it('restore from the recycle bin shows one "Restored" entry', async () => {
    const C = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Hist', lastName: 'C'}), 'C').contact;
    const del = must<{binId: string}>(await o.del(`/contacts/${C.id}`), 'delete');
    must(await o.post(`/recycle-bin/${del.binId}/restore`), 'restore');
    const h = await history(o, 'contact', C.id);
    const r = h.rows.filter((x) => x.kind === 'restored');
    expect(r.map((x) => x.actor.name), 'one "Restored" entry by the owner (timeline + audit merged)').toEqual([me.name]);
  });

  it('automation, form and import sources', async () => {
    const now = new Date(Date.now() - 10_000);
    const at = (ms: number) => new Date(now.getTime() + ms);
    // An automation step: a timeline entry stamped with the automation and an audit row with automationId.
    await db.activity.create({data: {type: 'field_changed', title: 'Contact updated', data: {changes: [{field: 'city', from: 'Porto', to: 'Lisbon'}], automation: {id: 'auto1', name: 'Welcome flow', runId: 'r1'}}, contactId: A.id, createdAt: now}});
    await db.auditLog.create({data: {action: 'contact.updated', category: 'record', entity: 'contact', recordId: A.id, meta: {changes: [{field: 'city', from: 'Porto', to: 'Lisbon'}], automationId: 'auto1', automation: 'Welcome flow'}, createdAt: at(300)}});
    // An audit-only automation change (no timeline row).
    await db.auditLog.create({data: {action: 'contact.updated', category: 'record', entity: 'contact', recordId: A.id, meta: {changes: [{field: 'leadStatus', from: null, to: 'Connected'}], automationId: 'auto2', automation: 'Lead router'}, createdAt: at(1000)}});
    // A form submission and an import.
    await db.activity.create({data: {type: 'field_changed', title: 'Updated from Demo request', data: {changes: [{field: 'country', from: null, to: 'Portugal'}], source: {kind: 'form', name: 'Demo request'}}, contactId: A.id, createdAt: at(2000)}});
    await db.auditLog.create({data: {action: 'contact.updated', category: 'record', entity: 'contact', recordId: A.id, actorId: me.id, actorName: me.name, meta: {changes: [{field: 'buyingRole', from: null, to: 'Champion'}], source: 'import'}, createdAt: at(3000)}});

    const h = await history(o, 'contact', A.id);
    const city = one(h.rows, 'city', 'Lisbon');
    expect(city.map((r) => [r.actor.kind, r.actor.name]), 'automation change once, as "Automation: Welcome flow"').toEqual([['automation', 'Automation: Welcome flow']]);
    expect(one(h.rows, 'leadStatus', 'Connected').map((r) => r.actor.name), 'audit-only change with meta.automationId').toEqual(['Automation: Lead router']);
    expect(one(h.rows, 'country', 'Portugal').map((r) => r.actor.name), 'form change as "Form: Demo request"').toEqual(['Form: Demo request']);
    const role = one(h.rows, 'buyingRole', 'Champion');
    expect(role.map((r) => [r.actor.kind, r.actor.name, r.actor.by]), 'import change as "Import" (by the owner)').toEqual([['import', 'Import', me.name]]);
  });

  it('deal: stage moves, pipeline names, value, close date, status', async () => {
    const pipes = must<{rows: {id: string; stages: {id: string; name: string}[]}[]}>(await o.get('/pipelines'), 'pipelines').rows;
    const pipeline = pipes[0]!;
    stages = pipeline.stages;
    D = must<{deal: Row}>(await o.post('/deals', {title: 'Hist deal', value: 1000, pipelineId: pipeline.id, stageId: stages[0]!.id}), 'deal').deal;
    await o.patch(`/deals/${D.id}`, {stageId: stages[1]!.id});
    await o.post(`/deals/${D.id}/move`, {stageId: stages[2]!.id});
    await o.patch(`/deals/${D.id}`, {value: 2500, expectedCloseDate: '2027-01-15'});
    await o.post(`/deals/${D.id}/status`, {status: 'WON'});

    const h = await history(o, 'deal', D.id);
    const st = changesOf(h.rows, 'stageId');
    expect(st.map((x) => `${x.from}→${x.to}`), 'two stage moves, each once, by name, newest first').toEqual([`${stages[1]!.name}→${stages[2]!.name}`, `${stages[0]!.name}→${stages[1]!.name}`]);
    expect(st.every((x) => x.label === 'Stage' && x.actor.name === me.name), 'labelled Stage, by the owner').toBe(true);
    expect(one(h.rows, 'value', '$2,500').map((r) => r.from), 'value as currency: $1,000 → $2,500').toEqual(['$1,000']);
    expect(one(h.rows, 'expectedCloseDate', 'Jan 15, 2027'), 'close date formatted').toHaveLength(1);
    expect(changesOf(h.rows, 'status').map((r) => [r.from, r.to]), 'status Open → Won once').toEqual([['Open', 'Won']]);
    const f = await history(o, 'deal', D.id, '&field=stageId');
    expect([f.rows.at(-1)?.kind, f.rows.at(-1)?.to], 'stage filter ends with the stage it was created in').toEqual(['created', stages[0]!.name]);
    expect((await history(o, 'contact', maya.id)).status, 'contact history still loads').toBe(200);
  });

  it('company: edit and bulk assign', async () => {
    Co = must<{company: Row}>(await o.post('/companies', {name: 'Hist Co'}), 'company').company;
    await o.patch(`/companies/${Co.id}`, {industry: 'Software', annualRevenue: 1200000});
    await o.post('/companies/bulk', {ids: [Co.id], action: 'assign', value: memberUser.id});
    const h = await history(o, 'company', Co.id);
    expect(one(h.rows, 'industry', 'Software'), 'industry change once').toHaveLength(1);
    expect(one(h.rows, 'annualRevenue', '$1,200,000'), 'annual revenue as currency').toHaveLength(1);
    expect(changesOf(h.rows, 'ownerId').map((r) => [r.from, r.to, r.note]), 'bulk assign with old owner').toEqual([[me.name, memberUser.name, 'Bulk edit']]);
    expect(h.rows.filter((r) => r.kind === 'created'), 'one "Created"').toHaveLength(1);
  });

  it('ticket: status, priority, assignee, category', async () => {
    const T = must<{ticket: Row}>(await o.post('/tickets', {subject: 'Hist ticket', contactId: A.id}), 'ticket').ticket;
    await o.patch(`/tickets/${T.id}`, {priority: 'HIGH'});
    await o.patch(`/tickets/${T.id}`, {status: 'WAITING_ON_US', category: 'Billing'});
    await o.patch(`/tickets/${T.id}`, {assigneeId: memberUser.id});
    const h = await history(o, 'ticket', T.id);
    expect(one(h.rows, 'priority', 'High').map((r) => r.from), 'priority Normal → High once').toEqual(['Normal']);
    expect(one(h.rows, 'status', 'Waiting on us').map((r) => r.from), 'status New → Waiting on us once').toEqual(['New']);
    expect(one(h.rows, 'category', 'Billing'), 'category once').toHaveLength(1);
    expect(changesOf(h.rows, 'assigneeId').map((r) => [r.from, r.to]), 'assignee owner → member once').toEqual([[me.name, memberUser.name]]);
    expect(h.rows.filter((r) => r.kind === 'created'), 'one "Created"').toHaveLength(1);
  });

  it('permissions and owner-only visibility', async () => {
    const mine = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Hist', lastName: 'Private'}), 'private').contact; // owned by the owner
    expect((await viewer.get(`/history?entity=contact&id=${mine.id}`)).status, 'viewers can read history').toBe(200);
    expect((await member.get(`/history?entity=contact&id=${mine.id}`)).status, 'members can read with "everyone" visibility').toBe(200);
    must(await o.patch('/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      expect((await member.get(`/history?entity=contact&id=${mine.id}`)).status, 'owner-only: member gets 404 for someone else’s contact').toBe(404);
      expect((await member.get(`/timeline/counts?contactId=${mine.id}`)).status, 'owner-only: counts are scoped too').toBe(404);
      expect((await member.get(`/timeline?contactId=${mine.id}`)).status, 'owner-only: the feed is scoped too').toBe(404);
      expect((await member.get(`/history?entity=company&id=${Co.id}`)).status, 'owner-only: member sees their own company').toBe(200);
      expect((await member.get(`/history?entity=deal&id=${D.id}`)).status, 'owner-only: member gets 404 for the owner’s deal').toBe(404);
      expect((await o.get(`/history?entity=contact&id=${mine.id}`)).status, 'admins see everything').toBe(200);
    } finally {
      must(await o.patch('/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
    expect((await o.get('/history?entity=contact&id=nope')).status, 'unknown record → 404').toBe(404);
    expect((await o.get(`/history?entity=widget&id=${A.id}`)).status, 'unknown entity → 400').toBe(400);
  });

  it('tab counts match the feed', async () => {
    const GROUPS = ['all', 'notes', 'emails', 'calls', 'meetings', 'messages', 'tasks', 'forms', 'tickets'];
    const northwind = must<{rows: Row[]}>(await o.get('/companies?q=Northwind'), 'northwind').rows[0]!;
    for (const [label, q] of [['Maya', `contactId=${maya.id}`], ['contact A', `contactId=${A.id}`], ['deal', `dealId=${D.id}`], ['company', `companyId=${northwind.id}`]] as const) {
      const counts = must<{counts: Record<string, number>}>(await o.get(`/timeline/counts?${q}`), 'counts').counts;
      const bad: {g: string; n: number; count: number | undefined}[] = [];
      for (const g of GROUPS) {
        let n = 0;
        let before = '';
        for (let i = 0; i < 20; i++) {
          const r = must<{rows: unknown[]; nextCursor: string | null}>(await o.get(`/timeline?${q}&group=${g}&take=100${before ? `&before=${encodeURIComponent(before)}` : ''}`), 'feed');
          n += r.rows.length;
          if (!r.nextCursor) break;
          before = r.nextCursor;
        }
        if (n !== counts[g]) bad.push({g, n, count: counts[g]});
      }
      expect(bad, `${label}: every tab count equals its feed`).toEqual([]);
    }
  });
});
