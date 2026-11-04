import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {owner, resetCrm, teammate} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * List columns are jsonb (`Json`), not Postgres arrays: the live driver (src/platform/db-socket.ts)
 * can't write, read or bind arrays. Everything that filtered, grouped or edited the old `String[]`
 * columns must give the same answers: segment tag rules, the list `?tag=` filter, the tag picker,
 * report grouping and filters on tags and on a multi-select custom field, bulk tag / untag (one
 * statement, visibility kept), meeting attendees on a contact merge, and the API still sending lists.
 */

const API = '/site-api/crm';
type Json = Record<string, unknown>;
type Res = {status: number; json: Json};
type Contact = {id: string; firstName: string; tags: string[]};
type ReportRow = {label: string; total: number};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  return res.json as T;
};

let own: Browser;
let amy: Browser;
let ben: Browser;
const NAME: Record<string, string> = {};
const id = {} as Record<'A' | 'B' | 'C', string>;

const make = async (b: Browser, firstName: string, tags: string[]) => {
  const c = ok<{contact: Contact}>(await b.post(`${API}/contacts`, {firstName, tags}), 201).contact;
  NAME[c.id] = firstName;
  return c;
};
const report = async (config: Json) => {
  const res = await own.get(`${API}/reports/run?tz=UTC&config=${encodeURIComponent(JSON.stringify(config))}`);
  return ok<{total: {count: number}; rows: ReportRow[]}>(res);
};
const visibility = async (v: 'owner' | 'everyone') => ok(await own.request('PATCH', `${API}/settings`, {recordVisibility: v}));

describe.skipIf(!DATABASE_URL)('list columns stored as jsonb (integration, real Postgres)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    own = await owner();
    await own.get(`${API}/auth/state`);
    ok(await own.post(`${API}/auth/setup`, {brandName: 'Acme', demoData: false}));
    // A: alpha + beta, B: beta, C: no tags.
    id.A = (await make(own, 'Ann', ['alpha', 'beta'])).id;
    id.B = (await make(own, 'Bob', ['beta'])).id;
    id.C = (await make(own, 'Cara', [])).id;
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  it('stores and sends tags as a list', async () => {
    expect((await db.contact.findUniqueOrThrow({where: {id: id.A}})).tags).toEqual(['alpha', 'beta']);
    const got = ok<{contact: Contact}>(await own.get(`${API}/contacts/${id.A}`)).contact;
    expect(got.tags).toEqual(['alpha', 'beta']);
  });

  it('segment tag rules: has any / all / none, empty, not empty', async () => {
    const members = async (rule: Json) => {
      const r = ok<{count: number; sample: {id: string}[]}>(await own.post(`${API}/lists/preview`, {rules: {match: 'all', groups: [{match: 'all', rules: [rule]}]}}));
      expect(r.sample.length, 'all members fit the sample').toBe(r.count);
      return r.sample.map((c) => NAME[c.id]?.[0] ?? '?').sort().join('');
    };
    const cases: [Json, string][] = [
      [{field: 'tags', op: 'has_any', values: ['alpha', 'zeta']}, 'A'],
      [{field: 'tags', op: 'has_any', values: ['alpha', 'beta']}, 'AB'],
      [{field: 'tags', op: 'has_all', values: ['alpha', 'beta']}, 'A'],
      [{field: 'tags', op: 'has_all', values: ['beta']}, 'AB'],
      [{field: 'tags', op: 'has_all', values: ['beta', 'zeta']}, ''],
      [{field: 'tags', op: 'has_none', values: ['alpha']}, 'BC'],
      [{field: 'tags', op: 'has_none', values: ['alpha', 'beta']}, 'C'],
      [{field: 'tags', op: 'empty'}, 'C'],
      [{field: 'tags', op: 'not_empty'}, 'AB'],
    ];
    for (const [rule, want] of cases) expect(await members(rule), JSON.stringify(rule)).toBe(want);
  });

  it('filters the contact list by a tag and counts tags for the picker', async () => {
    const rows = ok<{rows: Contact[]}>(await own.get(`${API}/contacts?tag=beta`)).rows;
    expect(rows.map((r) => r.firstName).sort()).toEqual(['Ann', 'Bob']);
    expect(rows.find((r) => r.id === id.A)?.tags).toEqual(['alpha', 'beta']);
    const picker = ok<{rows: {tag: string; n: number}[]}>(await own.get(`${API}/tags?entity=CONTACT`)).rows;
    expect(picker).toEqual([{tag: 'beta', n: 2}, {tag: 'alpha', n: 1}]);
  });

  it('reports: groups by tags (untagged in the empty group) and filters on them; the same for a multi-select field', async () => {
    const byLabel = (r: {rows: ReportRow[]}) => Object.fromEntries(r.rows.map((row) => [row.label, row.total]));
    expect(byLabel(await report({object: 'contacts', measure: {op: 'count'}, groupBy: {field: 'tags'}}))).toEqual({alpha: 1, beta: 2, 'No tags': 1});
    const count = async (conditions: unknown[]) => (await report({object: 'contacts', measure: {op: 'count'}, filters: {conditions}})).total.count;
    expect(await count([{field: 'tags', op: 'is', value: ['alpha', 'zeta']}])).toBe(1);
    expect(await count([{field: 'tags', op: 'is', value: 'alpha, beta'}]), 'a typed comma list').toBe(2);
    expect(await count([{field: 'tags', op: 'is_not', value: ['alpha']}])).toBe(2);
    expect(await count([{field: 'tags', op: 'empty'}])).toBe(1);
    expect(await count([{field: 'tags', op: 'not_empty'}])).toBe(2);

    await db.customFieldDef.create({data: {entity: 'CONTACT', key: 'channels', label: 'Channels', type: 'MULTISELECT', options: ['web', 'phone'], position: 0}});
    await db.contact.update({where: {id: id.A}, data: {custom: {channels: ['web', 'phone']}}});
    await db.contact.update({where: {id: id.B}, data: {custom: {channels: ['web']}}});
    const grouped = byLabel(await report({object: 'contacts', measure: {op: 'count'}, groupBy: {field: 'custom.channels'}}));
    expect(grouped).toEqual({web: 2, phone: 1, 'No value': 1});
    expect(await count([{field: 'custom.channels', op: 'is', value: ['phone']}])).toBe(1);
    expect(await count([{field: 'custom.channels', op: 'empty'}])).toBe(1);
    const fields = ok<{rows: {key: string; options: string[]}[]}>(await own.get(`${API}/fields?entity=CONTACT`)).rows;
    expect(fields.find((f) => f.key === 'channels')?.options, 'options are sent as a list').toEqual(['web', 'phone']);
  });

  it('bulk tag / untag: one statement for the selection, only records the member may see, never a tag twice', async () => {
    ({browser: amy} = await teammate(own, 'amy@example.com'));
    ({browser: ben} = await teammate(own, 'ben@example.com'));
    const a1 = await make(amy, 'Amy1', ['old']);
    const a2 = await make(amy, 'Amy2', ['old', 'vip']);
    const b1 = await make(ben, 'Ben1', []);
    await visibility('owner');
    try {
      const stamp = async (cid: string) => (await db.contact.findUniqueOrThrow({where: {id: cid}})).updatedAt.getTime();
      const [a2Before, b1Before] = [await stamp(a2.id), await stamp(b1.id)];
      ok(await amy.post(`${API}/contacts/bulk`, {ids: [a1.id, a2.id, b1.id], action: 'tag', value: 'vip'}));
      const tags = async (cid: string) => (await db.contact.findUniqueOrThrow({where: {id: cid}})).tags;
      expect(await tags(a1.id)).toEqual(['old', 'vip']);
      expect(await tags(a2.id), 'already tagged: left as it was').toEqual(['old', 'vip']);
      expect(await stamp(a2.id), 'and not rewritten').toBe(a2Before);
      expect(await tags(b1.id), "another member's contact is skipped").toEqual([]);
      expect(await stamp(b1.id)).toBe(b1Before);
      expect(await db.auditLog.count({where: {action: 'contact.bulk_updated', recordId: {in: [a1.id, a2.id]}}}), 'one audit row per visible record').toBe(2);
      expect(await db.auditLog.count({where: {action: 'contact.bulk_updated', recordId: b1.id}})).toBe(0);

      ok(await amy.post(`${API}/contacts/bulk`, {ids: [a1.id, a2.id, b1.id], action: 'untag', value: 'old'}));
      expect(await tags(a1.id)).toEqual(['vip']);
      expect(await tags(a2.id)).toEqual(['vip']);
      const audit = await db.auditLog.findFirstOrThrow({where: {action: 'contact.bulk_updated', recordId: a1.id, meta: {path: ['action'], equals: 'untag'}}});
      expect((audit.meta as {changes: unknown[]}).changes).toEqual([{field: 'tags', from: ['old', 'vip'], to: ['vip']}]);

      // Ben (owner-only) can't touch Amy's records either way.
      ok(await ben.post(`${API}/contacts/bulk`, {ids: [a1.id], action: 'untag', value: 'vip'}));
      expect(await tags(a1.id)).toEqual(['vip']);
    } finally {
      await visibility('everyone');
    }
  });

  it('merging contacts moves meeting attendees to the survivor (once) and leaves other meetings alone', async () => {
    const x = await make(own, 'Xena', []);
    const y = await make(own, 'Yuri', []);
    const z = await make(own, 'Zoe', []);
    const meeting = async (title: string, contactId: string, attendeeIds: string[]) =>
      ok<{interaction: {id: string}}>(await own.post(`${API}/interactions`, {kind: 'MEETING', title, contactId, attendeeIds}), 201).interaction.id;
    const all3 = await meeting('All three', z.id, [x.id, y.id]);
    const onlyY = await meeting('Only Yuri', y.id, []);
    const onlyZ = await meeting('Only Zoe', z.id, []);
    const attendees = async (iid: string) => [...((await db.interaction.findUniqueOrThrow({where: {id: iid}})).attendeeIds as string[])].sort();
    expect(await attendees(all3)).toEqual([x.id, y.id, z.id].sort());

    ok(await own.post(`${API}/contacts/${x.id}/merge`, {otherId: y.id, keep: 'this'}));
    expect(await attendees(all3)).toEqual([x.id, z.id].sort());
    expect(await attendees(onlyY)).toEqual([x.id]);
    expect(await attendees(onlyZ)).toEqual([z.id]);

    // The survivor's timeline finds the meetings it attended (attendee filter on jsonb).
    const rows = ok<{rows: {id: string; attendees?: {id: string}[]}[]}>(await own.get(`${API}/interactions?contactId=${x.id}`)).rows;
    expect(rows.map((r) => r.id).sort()).toEqual([all3, onlyY].sort());
  });
});
