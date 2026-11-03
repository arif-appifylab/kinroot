// Ported from Kinroot's scripts/test-lists.mjs
// Lists and segments: every segment rule type, group logic, cycles, static list changes and their
// events, forms, import / export into lists, snapshots, merges, owner-only scope and webhooks.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../../src/server/background'; // job handlers: form follow-ups, imports, exports, webhook deliveries
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {app} from '../../../src/server/app';
import {fakeStorage, resetCrm, storedFiles, teammate} from '../support/crm';
import {crm, download, HOOK_URL, meOf, must, settle, stubHooks, uploadCsv, workspace, type Crm, type Me} from './support-lists';

type Row = {id: string; [k: string]: unknown};
type Field = {id: string; key: string; label: string};
type Rules = {match: string; groups: {match: string; rules: Record<string, unknown>[]}[]};

const DAY = 86_400_000;
const TAG = 'segtest';
const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);

let owner: Crm;
let me: Me;
let A: Row, B: Row, C: Row;
let NAME: Record<string, string>;
let f: Record<'ref' | 'score' | 'renewal' | 'tier' | 'interests' | 'vip', Field>;
let pipe: {id: string; stages: {id: string}[]};
let form: Row;
let formList: Row, L1: Row, S1: Row, S2: Row;
const fixture = {match: 'all', rules: [{field: 'tags', op: 'has_any', values: [TAG]}]};

async function seed() {
  ({c: owner, me} = await workspace(false));
  const field = async (label: string, type: string, options: string[] = []) => must<{field: Field}>(await owner.post('/fields', {entity: 'CONTACT', label, type, options}), `field ${label}`).field;
  f = {
    ref: await field('Ref code', 'TEXT'),
    score: await field('Score', 'NUMBER'),
    renewal: await field('Renewal', 'DATE'),
    tier: await field('Tier', 'SELECT', ['Gold', 'Silver']),
    interests: await field('Interests', 'MULTISELECT', ['A', 'B', 'C']),
    vip: await field('VIP', 'CHECKBOX'),
  };
  const company = async (body: Record<string, unknown>) => must<{company: Row}>(await owner.post('/companies', body), 'company').company;
  const acme = await company({name: 'Acme', industry: 'Software', type: 'Customer', size: '11-50', employees: 40, country: 'Germany'});
  const globex = await company({name: 'Globex', industry: 'Retail', employees: 500});
  const contact = async (body: Record<string, unknown>) => must<{contact: Row}>(await owner.post('/contacts', body), 'contact').contact;
  A = await contact({
    firstName: 'Ann', lastName: 'Alpha', email: 'ann@alpha.test', title: 'CEO', city: 'Berlin', country: 'Germany', source: 'Web', leadStatus: 'New',
    lifecycleStage: 'LEAD', tags: [TAG, 'vip-tag'], companyId: acme.id,
    custom: {[f.ref.key]: 'AB-1', [f.score.key]: 10, [f.renewal.key]: '2026-01-15', [f.tier.key]: 'Gold', [f.interests.key]: ['A', 'B'], [f.vip.key]: true},
  });
  B = await contact({
    firstName: 'Bob', lastName: 'Beta', email: 'bob-1@beta.test', city: 'Paris', country: 'France', lifecycleStage: 'CUSTOMER', tags: [TAG], emailOptOut: true, ownerId: null, companyId: globex.id,
    custom: {[f.score.key]: 50, [f.tier.key]: 'Silver', [f.interests.key]: ['C'], [f.vip.key]: false},
  });
  C = await contact({firstName: 'Cara', lifecycleStage: 'QUALIFIED', tags: [TAG], ownerId: null});
  NAME = {[A.id]: 'A', [B.id]: 'B', [C.id]: 'C'};

  const pipes = must<{rows: {id: string; isDefault: boolean; stages: {id: string}[]}[]}>(await owner.get('/pipelines'), 'pipelines').rows;
  pipe = pipes.find((p) => p.isDefault) ?? pipes[0]!;
  const deal = async (body: Record<string, unknown>) => must<{deal: Row}>(await owner.post('/deals', body), 'deal').deal;
  const firstStage = pipe.stages[0]!;
  const lastStage = pipe.stages.at(-1)!;
  await deal({title: 'Open', value: 300, pipelineId: pipe.id, stageId: firstStage.id, contactIds: [A.id]});
  const w1 = await deal({title: 'Won1', value: 5000, pipelineId: pipe.id, stageId: lastStage.id, contactIds: [B.id]});
  const w2 = await deal({title: 'Won2', value: 2000, pipelineId: pipe.id, stageId: lastStage.id, contactIds: [B.id]});
  must(await owner.post(`/deals/${w1.id}/status`, {status: 'WON'}), 'won1');
  must(await owner.post(`/deals/${w2.id}/status`, {status: 'WON'}), 'won2');

  must(await owner.post('/interactions', {kind: 'MEETING', title: 'Intro', contactId: C.id, occurredAt: new Date(Date.now() - 2 * DAY).toISOString()}), 'meeting');
  must(await owner.post('/interactions', {kind: 'CALL', title: 'Call', contactId: C.id, occurredAt: new Date(Date.now() - 40 * DAY).toISOString()}), 'call');
  must(await owner.post('/interactions', {kind: 'MEETING', title: 'Future', contactId: A.id, occurredAt: new Date(Date.now() + 5 * DAY).toISOString()}), 'future meeting');

  // Emails: outbound to B opened today, inbound from C.
  const thread = await db.emailThread.create({data: {subject: 'Hi', contactId: B.id as string}});
  const out = await db.emailMessage.create({data: {threadId: thread.id, direction: 'OUTBOUND', status: 'SENT', fromEmail: 'me@x.test', to: ['b@x.test'], subject: 'Hi', contactId: B.id as string}});
  await db.trackingEvent.create({data: {messageId: out.id, type: 'open'}});
  await db.emailMessage.create({data: {threadId: thread.id, direction: 'INBOUND', status: 'RECEIVED', fromEmail: 'c@x.test', to: ['me@x.test'], subject: 'Re: Hi', contactId: C.id as string, sentAt: new Date(Date.now() - 3 * DAY)}});

  // Form: A submits; the form also adds respondents to a static list.
  formList = must<{list: Row}>(await owner.post('/lists', {name: 'Form leads', kind: 'STATIC'}), 'form list').list;
  form = must<{form: Row}>(await owner.post('/forms', {name: 'Seg form', templateId: 'contact'}), 'form').form;
  type FormField = {id: string; type: string; required?: boolean};
  const detail = must<{form: {slug: string; settings: Record<string, unknown>; fields: FormField[]}}>(await owner.get(`/forms/${form.id}`), 'form detail').form;
  must(await owner.patch(`/forms/${form.id}`, {settings: {...detail.settings, listIds: [formList.id]}}), 'form settings');
  must(await owner.post(`/forms/${form.id}/status`, {status: 'PUBLISHED'}), 'publish');
  const answers: Record<string, unknown> = {[detail.fields.find((x) => x.type === 'email')!.id]: A.email};
  const nameField = detail.fields.find((x) => x.type === 'name');
  if (nameField) answers[nameField.id] = {first: 'Ann', last: 'Alpha'};
  for (const x of detail.fields) if (x.required && !(x.id in answers)) answers[x.id] = x.type === 'consent' ? true : 'Hello there';
  const visitor = new Browser(app, '198.51.100.77');
  const sub = await visitor.post(`/site-api/crm/public/forms/${detail.slug}/submit`, {answers, startedAt: Date.now() - 10_000});
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);

  // Dates (set last, after everything that bumps lastActivityAt).
  await db.contact.update({where: {id: A.id}, data: {createdAt: new Date(Date.now() - 100 * DAY), lastActivityAt: new Date(Date.now() - 5 * DAY)}});
  await db.contact.update({where: {id: B.id}, data: {lastActivityAt: new Date(Date.now() - 60 * DAY)}});
  await db.contact.update({where: {id: C.id}, data: {lastActivityAt: null}});

  // Lists used by rules.
  L1 = must<{list: Row}>(await owner.post('/lists', {name: 'Static', kind: 'STATIC', contactIds: [A.id, B.id]}), 'L1').list;
  S1 = must<{list: Row}>(await owner.post('/lists', {name: 'Customers', kind: 'DYNAMIC', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'lifecycleStage', op: 'is_any', values: ['CUSTOMER']}, {field: 'tags', op: 'has_any', values: [TAG]}]}]}}), 'S1').list;
  S2 = must<{list: Row}>(await owner.post('/lists', {name: 'Nested', kind: 'DYNAMIC', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'list', op: 'in', value: S1.id}]}]}}), 'S2').list;
}

/** Members of a throwaway segment with these rules (as fixture letters), checking the live preview agrees. */
async function members(rules: Rules) {
  const list = must<{list: Row}>(await owner.post('/lists', {name: 't', kind: 'DYNAMIC', rules}), 'segment').list;
  const r = must<{rows: Row[]; total: number}>(await owner.get(`/lists/${list.id}/members?pageSize=200`), 'members');
  const preview = must<{count: number}>(await owner.post('/lists/preview', {rules}), 'preview');
  await owner.del(`/lists/${list.id}`);
  expect(preview.count, 'preview count equals the members').toBe(r.total);
  return r.rows.map((c) => NAME[c.id] ?? '?').sort().join('');
}
const one = (rule: Record<string, unknown>) => members({match: 'all', groups: [fixture, {match: 'all', rules: [rule]}]});

/** Each [rule, wanted members, label?] checked in turn. */
async function cases(list: [Record<string, unknown>, string, string?][]) {
  for (const [rule, want, label] of list) {
    expect(await one(rule), label ?? `${rule.field} ${rule.op} ${JSON.stringify(rule.value ?? rule.values ?? rule.days ?? '')}`).toBe(want);
  }
}

describe.skipIf(!DATABASE_URL)('ported: lists and segments (scripts/test-lists.mjs)', () => {
  beforeAll(async () => {
    configureEnv();
    fakeStorage();
    await resetCrm();
    storedFiles.clear();
    await seed();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('adds form respondents to the form’s static list', async () => {
    const r = must<{rows: Row[]}>(await owner.get(`/lists/${formList.id}/members`), 'form list members');
    expect(r.rows.map((x) => x.id)).toEqual([A.id]);
  });

  it('segment rules: text fields', async () => {
    await cases([
      [{field: 'firstName', op: 'is', value: 'ann'}, 'A'],
      [{field: 'firstName', op: 'is_not', value: 'Ann'}, 'BC'],
      [{field: 'firstName', op: 'contains', value: 'ar'}, 'C'],
      [{field: 'firstName', op: 'not_contains', value: 'a'}, 'B'],
      [{field: 'firstName', op: 'starts_with', value: 'b'}, 'B'],
      [{field: 'lastName', op: 'empty'}, 'C'],
      [{field: 'lastName', op: 'not_empty'}, 'AB'],
      [{field: 'email', op: 'is_not', value: A.email}, 'BC'],
      [{field: 'email', op: 'starts_with', value: 'bob-'}, 'B'],
      [{field: 'title', op: 'contains', value: 'ce'}, 'A'],
      [{field: 'city', op: 'is', value: 'PARIS'}, 'B'],
      [{field: 'country', op: 'is_not', value: 'germany'}, 'BC'],
      [{field: 'leadStatus', op: 'is', value: 'new'}, 'A'],
      [{field: 'source', op: 'is', value: 'web'}, 'A'],
      [{field: 'phone', op: 'empty'}, 'ABC'],
    ]);
  });

  it('segment rules: choices, owner, tags, booleans', async () => {
    await cases([
      [{field: 'lifecycleStage', op: 'is_any', values: ['LEAD', 'CUSTOMER']}, 'AB'],
      [{field: 'lifecycleStage', op: 'is_none', values: ['LEAD']}, 'BC'],
      [{field: 'ownerId', op: 'is_any', values: [me.id]}, 'A'],
      [{field: 'ownerId', op: 'is_none', values: [me.id]}, 'BC'],
      [{field: 'ownerId', op: 'empty'}, 'BC'],
      [{field: 'ownerId', op: 'not_empty'}, 'A'],
      [{field: 'tags', op: 'has_any', values: ['vip-tag']}, 'A'],
      [{field: 'tags', op: 'has_all', values: [TAG, 'vip-tag']}, 'A'],
      [{field: 'tags', op: 'has_none', values: ['vip-tag']}, 'BC'],
      [{field: 'tags', op: 'empty'}, ''],
      [{field: 'tags', op: 'not_empty'}, 'ABC'],
      [{field: 'emailOptOut', op: 'is_true'}, 'B'],
      [{field: 'emailOptOut', op: 'is_false'}, 'AC'],
    ]);
  });

  it('segment rules: dates', async () => {
    await cases([
      [{field: 'createdAt', op: 'more_than', days: 30}, 'A'],
      [{field: 'createdAt', op: 'in_last', days: 30}, 'BC'],
      [{field: 'createdAt', op: 'before', value: ymd(Date.now() - 50 * DAY)}, 'A'],
      [{field: 'createdAt', op: 'after', value: ymd(Date.now() - 50 * DAY)}, 'BC'],
      [{field: 'lastActivityAt', op: 'in_last', days: 30}, 'A'],
      [{field: 'lastActivityAt', op: 'more_than', days: 30}, 'B'],
      [{field: 'lastActivityAt', op: 'empty'}, 'C'],
      [{field: 'lastActivityAt', op: 'not_empty'}, 'AB'],
    ]);
  });

  it('segment rules: custom fields of every type', async () => {
    const k = (x: Field) => `custom.${x.key}`;
    await cases([
      [{field: k(f.ref), op: 'is', value: 'ab-1'}, 'A'],
      [{field: k(f.ref), op: 'is_not', value: 'AB-1'}, 'BC'],
      [{field: k(f.ref), op: 'contains', value: 'b-'}, 'A'],
      [{field: k(f.ref), op: 'not_contains', value: 'AB'}, 'BC'],
      [{field: k(f.ref), op: 'starts_with', value: 'ab'}, 'A'],
      [{field: k(f.ref), op: 'empty'}, 'BC'],
      [{field: k(f.ref), op: 'not_empty'}, 'A'],
      [{field: k(f.score), op: 'eq', value: '10'}, 'A'],
      [{field: k(f.score), op: 'gt', value: '20'}, 'B'],
      [{field: k(f.score), op: 'lt', value: '20'}, 'A'],
      [{field: k(f.score), op: 'empty'}, 'C'],
      [{field: k(f.score), op: 'not_empty'}, 'AB'],
      [{field: k(f.renewal), op: 'before', value: '2026-02-01'}, 'A'],
      [{field: k(f.renewal), op: 'after', value: '2026-01-01'}, 'A'],
      [{field: k(f.renewal), op: 'after', value: '2026-01-20'}, ''],
      [{field: k(f.renewal), op: 'in_last', days: 3650}, 'A'],
      [{field: k(f.renewal), op: 'in_last', days: 10}, ''],
      [{field: k(f.renewal), op: 'more_than', days: 30}, 'A'],
      [{field: k(f.renewal), op: 'empty'}, 'BC'],
      [{field: k(f.tier), op: 'is_any', values: ['Gold']}, 'A'],
      [{field: k(f.tier), op: 'is_any', values: ['Gold', 'Silver']}, 'AB'],
      [{field: k(f.tier), op: 'is_none', values: ['Gold']}, 'BC'],
      [{field: k(f.tier), op: 'empty'}, 'C'],
      [{field: k(f.interests), op: 'has_any', values: ['B']}, 'A'],
      [{field: k(f.interests), op: 'has_any', values: ['B', 'C']}, 'AB'],
      [{field: k(f.interests), op: 'has_all', values: ['A', 'B']}, 'A'],
      [{field: k(f.interests), op: 'has_all', values: ['A', 'C']}, ''],
      [{field: k(f.interests), op: 'has_none', values: ['A']}, 'BC'],
      [{field: k(f.interests), op: 'empty'}, 'C'],
      [{field: k(f.interests), op: 'not_empty'}, 'AB'],
      [{field: k(f.vip), op: 'is_true'}, 'A'],
      [{field: k(f.vip), op: 'is_false'}, 'BC'],
    ]);
  });

  it('segment rules: company fields', async () => {
    await cases([
      [{field: 'company.name', op: 'is', value: 'acme'}, 'A'],
      [{field: 'company.industry', op: 'is', value: 'retail'}, 'B'],
      [{field: 'company.industry', op: 'is_not', value: 'Software'}, 'BC'],
      [{field: 'company.industry', op: 'empty'}, 'C'],
      [{field: 'company.industry', op: 'not_empty'}, 'AB'],
      [{field: 'company.type', op: 'contains', value: 'cust'}, 'A'],
      [{field: 'company.size', op: 'is', value: '11-50'}, 'A'],
      [{field: 'company.employees', op: 'gt', value: '100'}, 'B'],
      [{field: 'company.employees', op: 'lt', value: '100'}, 'A'],
      [{field: 'company.employees', op: 'eq', value: '40'}, 'A'],
      [{field: 'company.employees', op: 'empty'}, 'C'],
      [{field: 'company.country', op: 'is', value: 'germany'}, 'A'],
    ]);
  });

  it('segment rules: deals', async () => {
    await cases([
      [{field: 'deal.open', op: 'is_true'}, 'A'],
      [{field: 'deal.open', op: 'is_false'}, 'BC'],
      [{field: 'deal.won', op: 'is_true'}, 'B'],
      [{field: 'deal.won', op: 'is_false'}, 'AC'],
      [{field: 'deal.pipeline', op: 'has', value: pipe.id}, 'AB'],
      [{field: 'deal.pipeline', op: 'has', value: pipe.id, stageId: pipe.stages[0]!.id}, 'A'],
      [{field: 'deal.pipeline', op: 'has_not', value: pipe.id}, 'C'],
      [{field: 'deal.wonValue', op: 'gt', value: '6000'}, 'B'],
      [{field: 'deal.wonValue', op: 'gt', value: '8000'}, ''],
      [{field: 'deal.wonValue', op: 'lt', value: '1000'}, 'AC'],
      [{field: 'deal.wonValue', op: 'eq', value: '0'}, 'AC'],
      [{field: 'deal.wonValue', op: 'eq', value: '7000'}, 'B'],
    ]);
  });

  it('segment rules: activity (forms, email opens and replies, meetings, calls)', async () => {
    await cases([
      [{field: 'activity.form', op: 'ever', value: form.id}, 'A'],
      [{field: 'activity.form', op: 'ever'}, 'A'],
      [{field: 'activity.form', op: 'never', value: form.id}, 'BC'],
      [{field: 'activity.form', op: 'in_last', days: 30, value: form.id}, 'A'],
      [{field: 'activity.form', op: 'not_in_last', days: 30}, 'BC'],
      [{field: 'activity.emailOpened', op: 'in_last', days: 7}, 'B'],
      [{field: 'activity.emailOpened', op: 'never'}, 'AC'],
      [{field: 'activity.emailReplied', op: 'in_last', days: 7}, 'C'],
      [{field: 'activity.emailReplied', op: 'in_last', days: 1}, ''],
      [{field: 'activity.meeting', op: 'in_last', days: 30}, 'C'],
      [{field: 'activity.meeting', op: 'never'}, 'AB'], // A's meeting is in the future
      [{field: 'activity.call', op: 'in_last', days: 30}, ''],
      [{field: 'activity.call', op: 'ever'}, 'C'],
      [{field: 'activity.call', op: 'not_in_last', days: 30}, 'ABC'],
    ]);
  });

  it('segment rules: other lists, nested segments, a deleted list', async () => {
    await cases([
      [{field: 'list', op: 'in', value: L1.id}, 'AB'],
      [{field: 'list', op: 'not_in', value: L1.id}, 'C'],
      [{field: 'list', op: 'in', value: S1.id}, 'B'],
      [{field: 'list', op: 'in', value: S2.id}, 'B', 'nested segment'],
      [{field: 'list', op: 'not_in', value: S2.id}, 'AC', 'not in nested segment'],
      [{field: 'list', op: 'in', value: 'missing-list'}, '', 'deleted list matches nobody'],
    ]);
  });

  it('group logic: any / all, top level any, incomplete and unknown rules', async () => {
    expect(await members({match: 'all', groups: [fixture, {match: 'any', rules: [{field: 'firstName', op: 'is', value: 'Ann'}, {field: 'firstName', op: 'is', value: 'Bob'}]}]}), 'group any').toBe('AB');
    expect(await members({match: 'all', groups: [fixture, {match: 'all', rules: [{field: 'lastName', op: 'not_empty'}, {field: 'emailOptOut', op: 'is_true'}]}]}), 'group all').toBe('B');
    expect(await members({match: 'any', groups: [{match: 'all', rules: [...fixture.rules, {field: 'firstName', op: 'is', value: 'Ann'}]}, {match: 'all', rules: [...fixture.rules, {field: 'firstName', op: 'is', value: 'Cara'}]}]}), 'top-level any').toBe('AC');
    expect(await members({match: 'all', groups: [fixture, {match: 'all', rules: [{field: 'firstName', op: 'is', value: 'Ann'}, {field: 'lastName', op: 'is', value: ''}]}]}), 'incomplete rule ignored').toBe('A');
    expect(await members({match: 'all', groups: [{match: 'all', rules: [{field: 'lastName', op: 'is', value: ''}]}]}), 'only incomplete rules → nobody').toBe('');
    expect(await members({match: 'all', groups: []}), 'no groups → nobody').toBe('');
    expect(await members({match: 'all', groups: [fixture, {match: 'all', rules: [{field: 'custom.deleted_field', op: 'empty'}]}]}), 'unknown custom field → nobody').toBe('');
  });

  it('rejects cycles, self references and invalid rules', async () => {
    const cyc = await owner.patch(`/lists/${S1.id}`, {rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'list', op: 'in', value: S2.id}]}]}});
    expect(cyc.status, JSON.stringify(cyc.json)).toBe(400);
    const self = await owner.post('/lists/preview', {listId: S1.id, rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'list', op: 'in', value: S1.id}]}]}});
    expect(self.status).toBe(400);
    const bad = await owner.post('/lists/preview', {rules: {match: 'maybe', groups: []}});
    expect(bad.status).toBe(400);
  });

  it('static lists: count, add / remove, events and timeline entries', async () => {
    expect(must<{list: {count: number}}>(await owner.get(`/lists/${L1.id}`), 'L1 detail').list.count).toBe(2);
    expect(must<{added: number}>(await owner.post(`/lists/${L1.id}/members`, {contactIds: [A.id, C.id]}), 'add').added, 'add skips existing members').toBe(1);
    expect(must<{removed: number}>(await owner.post(`/lists/${L1.id}/members/remove`, {contactIds: [C.id]}), 'remove').removed).toBe(1);
    expect((await owner.post(`/lists/${S1.id}/members`, {contactIds: [A.id]})).status, 'cannot add members to a segment').toBe(400);

    const events = await db.event.findMany({where: {recordId: L1.id}, orderBy: {createdAt: 'asc'}, select: {type: true, data: true}});
    expect(events.filter((e) => e.type === 'list.member_added')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'list.member_removed')).toHaveLength(1);
    const first = events[0]?.data as {contactId?: string; list?: {id: string}} | undefined;
    expect(first?.contactId, 'event payload has the contact').toBeTruthy();
    expect(first?.list?.id, 'event payload has the list').toBe(L1.id);
    expect(await db.activity.count({where: {contactId: C.id, type: {startsWith: 'list_'}}}), 'timeline entries for add / remove').toBe(2);
    expect((await db.contact.findUniqueOrThrow({where: {id: C.id}})).lastActivityAt, 'list change does not bump lastActivityAt').toBeNull();
  });

  it('lists a contact belongs to, and filters contacts and members by list', async () => {
    const names = must<{rows: {name: string}[]}>(await owner.get(`/lists/for-contact/${B.id}`), 'for-contact').rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([L1.name, S1.name, S2.name]));

    const filtered = must<{rows: Row[]; total: number}>(await owner.get(`/contacts?listId=${S1.id}&tag=${TAG}`), 'contacts listId');
    expect([filtered.total, filtered.rows[0]?.id], 'contacts ?listId= (segment)').toEqual([1, B.id]);
    const filtered2 = must<{rows: Row[]; total: number}>(await owner.get(`/contacts?listId=${L1.id}&q=ann`), 'contacts listId q');
    expect([filtered2.total, filtered2.rows[0]?.id], 'contacts ?listId= with search').toEqual([1, A.id]);
    expect(must<{total: number}>(await owner.get(`/lists/${L1.id}/members?q=bob`), 'members search').total).toBe(1);
  });

  it('exports a list’s members (signed in only)', async () => {
    const anonymous = new Browser(app, '198.51.100.78');
    expect((await anonymous.post('/site-api/crm/exports', {entity: 'contact', listId: L1.id, columns: ['email']})).status, 'export needs auth').toBe(401);
    const exp = must<{export: {id: string}}>(await owner.post('/exports', {entity: 'contact', listId: L1.id, columns: ['email']}), 'export').export;
    const done = await settle(async () => must<{export: {status: string; downloadUrl: string | null}}>(await owner.get(`/exports/${exp.id}`), 'export').export, ['done', 'failed']);
    expect(done.status).toBe('done');
    const csv = await download(owner, done.downloadUrl!);
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes(String(A.email)))).toBe(true);
  });

  it('imports into a static list, snapshots a segment, and merging moves memberships', async () => {
    const up = must<{import: {id: string; mapping: (string | null)[]}}>(
      await uploadCsv(owner, 'contact', 'into-list.csv', `Email,Full name,Tags\n${A.email},,\ndee@delta.test,Dee Delta,${TAG}\n`),
      'upload',
    );
    const options = {mode: 'create', skipBlanks: true, dateOrder: 'mdy', listId: formList.id, tag: null, defaultOwner: 'me', createCompanies: true, pipelineId: null, emailMe: false, valueMap: {}};
    must(await owner.post(`/imports/${up.import.id}/validate`, {mapping: up.import.mapping, options}), 'validate');
    type Imp = {status: string; created: number; skipped: number; stats: {listAdded?: number}};
    const read = async () => must<{import: Imp}>(await owner.get(`/imports/${up.import.id}`), 'import').import;
    expect((await settle(read, ['ready', 'failed'])).status).toBe('ready');
    must(await owner.post(`/imports/${up.import.id}/start`), 'start');
    const imp = await settle(read, ['done', 'failed']);
    expect({created: imp.created, skipped: imp.skipped, listAdded: imp.stats.listAdded}, 'import into list').toEqual({created: 1, skipped: 1, listAdded: 1});
    const after = must<{rows: Row[]; total: number}>(await owner.get(`/lists/${formList.id}/members`), 'after import');
    expect(after.total, 'imported contact in list').toBe(2);

    const snap = must<{added: number; list: Row & {kind: string}}>(await owner.post(`/lists/${S1.id}/snapshot`, {name: 'Snap'}), 'snapshot');
    expect([snap.added, snap.list.kind]).toEqual([1, 'STATIC']);

    // Dee (in formList) merged into C (in the snapshot only).
    const dee = after.rows.find((r) => r.firstName === 'Dee')!;
    must(await owner.post(`/lists/${snap.list.id}/members`, {contactIds: [C.id]}), 'C into snap');
    must(await owner.post(`/contacts/${C.id}/merge`, {otherId: dee.id, keep: 'this'}), 'merge');
    const cLists = must<{rows: Row[]}>(await owner.get(`/lists/for-contact/${C.id}`), 'C lists').rows.map((r) => r.id);
    expect(cLists, 'merge moved list memberships').toEqual(expect.arrayContaining([formList.id, snap.list.id]));
  });

  it('the index shows each list with its count and owner', async () => {
    const index = must<{rows: (Row & {count: number; owner?: {id: string}})[]}>(await owner.get('/lists'), 'index');
    const row = index.rows.find((r) => r.id === S1.id);
    expect(row?.count).toBe(1);
    expect(row?.owner?.id).toBe(me.id);
  });

  it('owner-only visibility scopes what a member sees and changes', async () => {
    const {browser} = await teammate(owner.browser, 'member@example.com', 'MEMBER');
    const member = crm(browser);
    await meOf(member);
    must(await owner.patch('/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      const mine = must<{contact: Row}>(await member.post('/contacts', {firstName: 'Mo', tags: [TAG]}), 'member contact').contact;
      expect(must<{list: {count: number}}>(await member.get(`/lists/${L1.id}`), 'member list').list.count, 'member sees only own contacts in count').toBe(0);
      expect(must<{added: number}>(await member.post(`/lists/${L1.id}/members`, {contactIds: [mine.id, B.id]}), 'member add').added, 'member can only add visible contacts').toBe(1);
      const mMembers = must<{rows: Row[]; total: number}>(await member.get(`/lists/${L1.id}/members`), 'member members');
      expect([mMembers.total, mMembers.rows[0]?.id], 'member members scoped').toEqual([1, mine.id]);
      expect(must<{list: {count: number}}>(await owner.get(`/lists/${L1.id}`), 'owner count').list.count, 'owner sees everyone').toBe(3);
      expect(must<{count: number}>(await member.post('/lists/preview', {rules: {match: 'all', groups: [fixture]}}), 'member preview').count, 'member preview scoped').toBe(1);
      expect((await member.get(`/lists/for-contact/${B.id}`)).status, 'member cannot read lists of hidden contact').toBe(404);
      expect((await member.patch(`/lists/${L1.id}`, {name: 'hijack'})).status, 'member cannot rename owner list').toBe(403);
      const own = must<{list: Row}>(await member.post('/lists', {name: 'Mine'}), 'member list create').list;
      expect((await member.patch(`/lists/${own.id}`, {name: 'Mine2'})).status, 'member renames own list').toBe(200);
      expect((await member.del(`/lists/${own.id}`)).status, 'member deletes own list').toBe(200);
    } finally {
      must(await owner.patch('/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
  });

  it('sends one webhook delivery per added member (bulk list events)', async () => {
    const hooks = stubHooks();
    try {
      const hook = must<{webhook: Row}>(await owner.post('/webhooks', {url: HOOK_URL, events: ['list.member_added']}), 'webhook').webhook;
      const W = must<{list: Row}>(await owner.post('/lists', {name: 'Hooked', kind: 'STATIC'}), 'W').list;
      must(await owner.post(`/lists/${W.id}/members`, {contactIds: [A.id, B.id]}), 'W add');
      const deliveries = await db.webhookDelivery.findMany({where: {webhookId: hook.id}, select: {status: true}});
      expect(deliveries, 'one webhook delivery per added member').toHaveLength(2);
      // The delivery jobs ran (in-process here; the old runner queued them in its Job table).
      expect(hooks.calls.filter((call) => call.url.href === HOOK_URL), 'delivery jobs ran').toHaveLength(2);
      await owner.del(`/webhooks/${hook.id}`);
    } finally {
      hooks.restore();
    }
  });

  it('deletes a segment', async () => {
    expect((await owner.del(`/lists/${S2.id}`)).status).toBe(200);
    expect((await owner.get(`/lists/${S2.id}`)).status).toBe(404);
  });
});
