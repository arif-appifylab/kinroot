import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../../src/server/app';
import {owner, ownerAccountId, resetCrm, teammate, userId} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';

/**
 * Ported from Kinroot's scripts/integration/test-reports.mjs
 * The Tickets and Bookings report objects: catalogue, every grouping and measure, date fields, owner
 * scope, dashboards widgets and their filters, checked against hand-computed values on fixtures.
 */

type Row = {key: string; label: string; total: number; values: Record<string, number>};
type Result = {total: {value: number; count: number}; rows: Row[]; series: {key: string; label: string}[]};

const TAG = 'rpt-port';
const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse('2026-03-10T10:00:00Z');
const at = (ms: number | null) => (ms == null ? null : new Date(ms));
const tagFilter = {field: 'tags', op: 'is', value: [TAG]};

let own: Browser;
let mem: Browser;
let me: {id: string; name: string};
let mu: {id: string; name: string};
let links: {intro: string; demo: string};
let company: {id: string; name: string};

async function seed() {
  own = await owner();
  await own.get('/site-api/crm/auth/state');
  ({browser: mem} = await teammate(own, 'report.member@example.com'));
  me = await db.member.findUniqueOrThrow({where: {userId: await ownerAccountId()}, select: {id: true, name: true}});
  mu = await db.member.findUniqueOrThrow({where: {userId: await userId('report.member@example.com')}, select: {id: true, name: true}});

  company = await db.company.create({data: {name: 'Acme Port'}, select: {id: true, name: true}});
  const c1 = await db.contact.create({data: {firstName: 'Rita', lastName: 'Report', email: 'rita@client-port.io'}});
  const c2 = await db.contact.create({data: {firstName: 'Sam', email: 'sam@client-port.io'}});

  type T = [string, string, string | null, string | null, string, string[], string | null, string | null, string | null, number, number | null, number | null, number | null, number | null, number | null, number | null];
  // status, priority, category, queue, source, tags, assignee, contact, company, created, fr, resolved, csat, frDue, frBreached, resBreached-due
  const tickets: T[] = [
    ['NEW', 'URGENT', 'Bug', 'Tech', 'EMAIL', [TAG, 'vip'], me.id, c1.id, company.id, T0, null, null, null, T0 + H, null, null],
    ['WAITING_ON_CONTACT', 'HIGH', 'Bug', 'Tech', 'PORTAL', [TAG], mu.id, c2.id, null, T0 + D, T0 + D + 2 * H, null, null, null, null, null],
    ['RESOLVED', 'NORMAL', 'Billing', 'Billing', 'FORM', [TAG], me.id, c1.id, company.id, T0 + 2 * D, T0 + 2 * D + 4 * H, T0 + 2 * D + 10 * H, 4, T0 + 2 * D + H, T0 + 2 * D + H, null],
    ['CLOSED', 'LOW', null, null, 'MANUAL', [TAG, 'vip'], null, null, null, T0 + 3 * D, T0 + 3 * D + H, T0 + 3 * D + 25 * H, 5, null, null, T0 + 3 * D + 24 * H],
    ['WAITING_ON_US', 'NORMAL', 'Question', 'Support', 'EMAIL', [TAG], mu.id, null, null, Date.parse('2026-04-05T09:00:00Z'), null, null, null, Date.parse('2027-06-01T00:00:00Z'), null, null],
    ['RESOLVED', 'HIGH', 'Bug', 'Tech', 'EMAIL', [TAG], mu.id, null, null, T0 + 4 * D, T0 + 4 * D + 3 * H, T0 + 4 * D + 6 * H, 2, null, null, null],
  ];
  for (const [i, t] of tickets.entries()) {
    await db.ticket.create({
      data: {
        subject: `Report ticket ${i}`,
        status: t[0] as never,
        priority: t[1] as never,
        category: t[2],
        queue: t[3],
        source: t[4] as never,
        tags: t[5],
        assigneeId: t[6],
        contactId: t[7],
        companyId: t[8],
        createdAt: at(t[9])!,
        lastMessageAt: at(t[9])!,
        firstResponseAt: at(t[10]),
        resolvedAt: at(t[11]),
        csatRating: t[12],
        firstResponseDueAt: at(t[13]),
        firstResponseBreachedAt: at(t[14]),
        resolutionDueAt: at(t[15]),
      },
    });
  }

  const intro = await db.bookingLink.create({data: {kind: 'personal', userId: me.id, slug: 'intro-port', name: 'Intro call'}});
  const demo = await db.bookingLink.create({data: {kind: 'team', userId: me.id, slug: 'demo-port', name: 'Demo'}});
  links = {intro: intro.id, demo: demo.id};
  const bookings: [string, string, string, string, string, number, string][] = [
    [intro.id, me.id, 'CONFIRMED', 'page', '2026-05-04T09:00:00Z', 30, '2026-04-20T12:00:00Z'],
    [intro.id, me.id, 'CANCELED', 'widget', '2026-05-05T10:00:00Z', 60, '2026-04-21T12:00:00Z'],
    [demo.id, mu.id, 'CONFIRMED', 'form', '2026-05-20T14:00:00Z', 45, '2026-05-01T12:00:00Z'],
    [demo.id, mu.id, 'CONFIRMED', 'page', '2026-06-02T08:00:00Z', 30, '2026-05-02T12:00:00Z'],
  ];
  for (const b of bookings) {
    const start = Date.parse(b[4]);
    await db.booking.create({
      data: {linkId: b[0], hostId: b[1], status: b[2], source: b[3], title: 'Meeting', startAt: new Date(start), endAt: new Date(start + b[5] * 60_000), name: 'Guest', email: 'guest@client-port.io', createdAt: new Date(b[6])},
    });
  }
}

const run = async (client: Browser, config: Record<string, unknown>, extra = '') => {
  const full = {measure: {op: 'count'}, chart: 'table', ...config, filters: {conditions: [], ...((config.filters as object) ?? {})}};
  const res = await client.get(`/site-api/crm/reports/run?tz=UTC&config=${encodeURIComponent(JSON.stringify(full))}${extra}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as Result;
};
const byLabel = (r: Result) => Object.fromEntries(r.rows.map(row => [row.label, row.values.value]));
const tickets = (cfg: Record<string, unknown>) => ({object: 'tickets', ...cfg, filters: {conditions: [tagFilter], ...((cfg.filters as object) ?? {})}});
const bookings = (cfg: Record<string, unknown>) => ({object: 'bookings', ...cfg, filters: {conditions: [{field: 'link', op: 'is', value: [links.intro, links.demo]}], ...((cfg.filters as object) ?? {})}});
const setVisibility = async (v: 'owner' | 'everyone') => expect((await own.request('PATCH', '/site-api/crm/settings', {recordVisibility: v})).status).toBe(200);

describe.skipIf(!DATABASE_URL)('Ported: tickets and bookings report objects (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    await seed();
  });

  it('lists both objects with their fields in the catalogue, and the booking link picker', async () => {
    const cat = await own.get('/site-api/crm/reports/catalogue');
    type Obj = {key: string; ownerLabel: string; fields: {key: string; numeric?: boolean}[]};
    const objects = cat.json.objects as Obj[];
    const t = objects.find(o => o.key === 'tickets')!;
    const b = objects.find(o => o.key === 'bookings')!;
    expect(t && b).toBeTruthy();
    expect([t.ownerLabel, b.ownerLabel]).toEqual(['Assignee', 'Host']);
    for (const k of ['status', 'priority', 'category', 'queue', 'source', 'owner', 'contact', 'company', 'createdAt', 'firstResponseAt', 'resolvedAt', 'firstResponseHours', 'resolutionHours', 'csatRating', 'slaBreached', 'tags']) {
      expect(t.fields.some(f => f.key === k), `ticket field ${k}`).toBe(true);
    }
    for (const k of ['link', 'owner', 'status', 'source', 'startAt', 'createdAt', 'durationMin']) expect(b.fields.some(f => f.key === k), `booking field ${k}`).toBe(true);
    expect(t.fields.find(f => f.key === 'firstResponseHours')!.numeric && t.fields.find(f => f.key === 'resolutionHours')!.numeric).toBe(true);
    const refs = await own.get('/site-api/crm/reports/refs/bookingLink');
    expect((refs.json.rows as {id: string}[]).some(r => r.id === links.intro)).toBe(true);
  });

  it('counts tickets by status in pipeline order and computes the hour and CSAT measures', async () => {
    expect((await run(own, tickets({}))).total.value).toBe(6);
    const st = await run(own, tickets({groupBy: {field: 'status'}}));
    expect(byLabel(st)).toEqual({New: 1, 'Waiting on contact': 1, 'Waiting on us': 1, Resolved: 2, Closed: 1});
    expect(st.rows.map(x => x.label)).toEqual(['New', 'Waiting on contact', 'Waiting on us', 'Resolved', 'Closed']);

    expect((await run(own, tickets({measure: {op: 'avg', field: 'firstResponseHours'}}))).total.value).toBeCloseTo(2.5);
    const pr = byLabel(await run(own, tickets({measure: {op: 'avg', field: 'firstResponseHours'}, groupBy: {field: 'priority'}})));
    expect(pr.High).toBeCloseTo(2.5);
    expect(pr.Normal).toBeCloseTo(4);
    expect(pr.Low).toBeCloseTo(1);
    expect((await run(own, tickets({measure: {op: 'sum', field: 'resolutionHours'}}))).total.value).toBeCloseTo(41);
    expect((await run(own, tickets({measure: {op: 'avg', field: 'resolutionHours'}}))).total.value).toBeCloseTo(41 / 3);
    expect((await run(own, tickets({measure: {op: 'max', field: 'resolutionHours'}}))).total.value).toBeCloseTo(25);
    expect((await run(own, tickets({measure: {op: 'avg', field: 'csatRating'}}))).total.value).toBeCloseTo(11 / 3);
    expect(byLabel(await run(own, tickets({groupBy: {field: 'csatRating'}})))).toMatchObject({'4': 1, '5': 1, '2': 1, 'No rating': 3});
  });

  it('groups tickets by SLA, assignee, queue, category, source, tag, contact, company and month', async () => {
    expect(byLabel(await run(own, tickets({groupBy: {field: 'slaBreached'}})))).toEqual({Yes: 2, No: 4});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'owner'}})))).toEqual({[me.name]: 2, [mu.name]: 3, Unassigned: 1});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'queue'}})))).toEqual({Tech: 3, Billing: 1, Support: 1, 'No queue': 1});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'category'}})))).toEqual({Bug: 3, Billing: 1, Question: 1, 'No category': 1});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'source'}})))).toEqual({Email: 3, Portal: 1, Form: 1, Manual: 1});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'tags'}})))).toMatchObject({[TAG]: 6, vip: 2});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'contact'}})))).toEqual({'Rita Report': 2, Sam: 1, 'No contact': 3});
    expect(byLabel(await run(own, tickets({groupBy: {field: 'company'}})))[company.name]).toBe(2);
    const months = await run(own, tickets({groupBy: {field: 'createdAt', bucket: 'month'}, filters: {range: {preset: 'custom', from: '2026-03-01', to: '2026-04-30'}}}));
    expect(months.rows.map(x => x.values.value)).toEqual([5, 1]);
  });

  it('filters tickets on other date fields and on combined conditions', async () => {
    expect((await run(own, tickets({filters: {dateField: 'firstResponseAt', range: {preset: 'custom', from: '2026-03-01', to: '2026-03-31'}}}))).total.value).toBe(4);
    // t3 resolved on the 12th is excluded; t4 (13th/14th) and t6 (14th) are in.
    expect((await run(own, tickets({filters: {dateField: 'resolvedAt', range: {preset: 'custom', from: '2026-03-13', to: '2026-03-14'}}}))).total.value).toBe(2);
    const breachedUrgent = await run(own, tickets({filters: {conditions: [tagFilter, {field: 'slaBreached', op: 'is_true'}, {field: 'priority', op: 'is', value: ['URGENT']}]}}));
    expect(breachedUrgent.total.value).toBe(1);
  });

  it('limits a member to their own and unassigned tickets and their own bookings under owner-only visibility', async () => {
    await setVisibility('owner');
    const r = await run(mem, tickets({groupBy: {field: 'owner'}}));
    expect(r.total.value).toBe(4);
    expect(byLabel(r)).toEqual({[mu.name]: 3, Unassigned: 1});
    expect((await run(mem, tickets({}), `&ownerId=${me.id}`)).total.value).toBe(0);
    expect((await run(mem, bookings({}))).total.value).toBe(2);
    expect((await run(own, tickets({}))).total.value).toBe(6);
    await setVisibility('everyone');
    expect((await run(mem, tickets({}))).total.value).toBe(6);
  });

  it('counts and groups bookings: status, duration, host, link, source, month, date fields, breakdown', async () => {
    expect((await run(own, bookings({}))).total.value).toBe(4);
    expect((await run(own, bookings({filters: {range: {preset: 'all'}}}))).total.value).toBe(4);
    expect(byLabel(await run(own, bookings({groupBy: {field: 'status'}})))).toEqual({Confirmed: 3, Canceled: 1});
    expect((await run(own, bookings({measure: {op: 'avg', field: 'durationMin'}}))).total.value).toBeCloseTo(41.25);
    expect((await run(own, bookings({measure: {op: 'sum', field: 'durationMin'}}))).total.value).toBeCloseTo(165);
    expect(byLabel(await run(own, bookings({groupBy: {field: 'durationMin'}})))).toEqual({'30': 2, '45': 1, '60': 1});
    expect(byLabel(await run(own, bookings({groupBy: {field: 'owner'}})))).toEqual({[me.name]: 2, [mu.name]: 2});
    const byLink = await run(own, bookings({groupBy: {field: 'link'}}));
    expect(byLink.rows).toHaveLength(2);
    expect(byLink.rows.every(x => x.values.value === 2)).toBe(true);
    expect(byLink.rows.some(x => /Intro call/.test(x.label)) && byLink.rows.some(x => /Demo/.test(x.label))).toBe(true);
    expect(byLabel(await run(own, bookings({groupBy: {field: 'source'}})))).toEqual({'Booking page': 2, 'Embedded widget': 1, Form: 1});
    expect(byLabel(await run(own, bookings({groupBy: {field: 'startAt', bucket: 'month'}})))).toEqual({'May 2026': 3, 'Jun 2026': 1});
    expect((await run(own, bookings({filters: {range: {preset: 'custom', from: '2026-05-01', to: '2026-05-31'}}}))).total.value).toBe(3);
    expect((await run(own, bookings({filters: {dateField: 'createdAt', range: {preset: 'custom', from: '2026-04-01', to: '2026-04-30'}}}))).total.value).toBe(2);
    const stacked = await run(own, bookings({groupBy: {field: 'owner'}, breakdown: {field: 'status'}, chart: 'stacked'}));
    expect(stacked.series).toHaveLength(2);
    expect(stacked.rows.find(x => x.label === me.name)!.total).toBe(2);
  });

  it('runs saved reports as dashboard widgets with the owner and date filters, and exports only when signed in', async () => {
    const rep = await own.post('/site-api/crm/reports', {name: 'Tickets by status', shared: true, config: {...tickets({groupBy: {field: 'status'}}), measure: {op: 'count'}, chart: 'bar'}});
    const rep2 = await own.post('/site-api/crm/reports', {name: 'Bookings by host', shared: true, config: {...bookings({groupBy: {field: 'owner'}}), measure: {op: 'count'}, chart: 'donut'}});
    expect([rep.status, rep2.status]).toEqual([201, 201]);
    const r1 = (rep.json.report as {id: string}).id;
    const r2 = (rep2.json.report as {id: string}).id;
    const dash = await own.post('/site-api/crm/dashboards', {name: 'Support', shared: true});
    const dashId = (dash.json.dashboard as {id: string}).id;
    expect((await own.post(`/site-api/crm/dashboards/${dashId}/widgets`, {reportId: r1})).status).toBe(201);
    const w2 = await own.post(`/site-api/crm/dashboards/${dashId}/widgets`, {reportId: r2, size: 'small'});
    const widgets = (w2.json.dashboard as {widgets: {id: string; reportId: string}[]}).widgets;
    const wid = (reportId: string) => widgets.find(w => w.reportId === reportId)!.id;
    const widget = async (id: string, query: string) => {
      const res = await own.get(`/site-api/crm/dashboards/${dashId}/widgets/${id}/run?tz=UTC${query}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return (res.json as unknown as Result).total.value;
    };
    expect(await widget(wid(r1), '')).toBe(6);
    expect(await widget(wid(r1), `&ownerId=${mu.id}`)).toBe(3); // owner filter → assignee
    expect(await widget(wid(r2), `&ownerId=${mu.id}`)).toBe(2); // owner filter → host
    expect(await widget(wid(r2), '&range=custom&from=2026-05-15&to=2026-06-30')).toBe(2);
    const signedOut = await new Browser(app).get(`/site-api/crm/reports/${r1}/export.csv?tz=UTC`);
    expect([401, 403]).toContain(signedOut.status);
  });

  it('matches SQL over the whole tickets table', async () => {
    const sqlStatus = Object.fromEntries((await db.$queryRaw<{s: string; n: number}[]>`SELECT status::text AS s, COUNT(*)::int AS n FROM "Ticket" GROUP BY 1`).map(x => [x.s, x.n]));
    const r = await run(own, {object: 'tickets', groupBy: {field: 'status'}});
    expect(r.rows.every(x => sqlStatus[x.key] === x.values.value)).toBe(true);
    expect(r.total.value).toBe(Object.values(sqlStatus).reduce((a, b) => a + b, 0));
    const [avg] = await db.$queryRaw<{v: number}[]>`SELECT AVG(EXTRACT(EPOCH FROM "firstResponseAt" - "createdAt") / 3600)::float8 AS v FROM "Ticket"`;
    expect((await run(own, {object: 'tickets', measure: {op: 'avg', field: 'firstResponseHours'}})).total.value).toBeCloseTo(avg!.v);
  });
});
