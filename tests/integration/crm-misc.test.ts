import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {owner, resetCrm, teammate, userId} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot routes that had no integration test (AUDIT P3-11): notifications, saved views, goals,
 * tags, search, the dashboard and dashboard widgets. Each one: the owner is allowed, another
 * member's row answers 404 (or is simply not there), a viewer cannot write.
 */

const API = '/site-api/crm';
type Json = Record<string, unknown>;
type Res = {status: number; json: Json};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  return res.json as T;
};

let own: Browser;
let amy: Browser;
let ben: Browser;
let vic: Browser; // viewer
let amyId: string;
let benId: string;

const get = (b: Browser, path: string) => b.get(`${API}${path}`);
const post = (b: Browser, path: string, body: unknown = {}) => b.post(`${API}${path}`, body);
const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', `${API}${path}`, body);
const del = (b: Browser, path: string) => b.delete(`${API}${path}`);
const visibility = async (v: 'owner' | 'everyone') => ok(await patch(own, '/settings', {recordVisibility: v}));
const memberId = async (email: string) => (await db.member.findUniqueOrThrow({where: {userId: await userId(email)}})).id;

describe.skipIf(!DATABASE_URL)('Kinroot notifications, views, goals, tags, search, dashboard (integration)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    own = await owner();
    await own.get(`${API}/auth/state`);
    ok(await post(own, '/auth/setup', {brandName: 'Acme', demoData: false}));
    ({browser: amy} = await teammate(own, 'amy@example.com'));
    ({browser: ben} = await teammate(own, 'ben@example.com'));
    ({browser: vic} = await teammate(own, 'vic@example.com', 'VIEWER'));
    [amyId, benId] = [await memberId('amy@example.com'), await memberId('ben@example.com')];
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  it('notifications: each member reads and clears only their own', async () => {
    ok(await post(own, '/contacts', {firstName: 'Nia', ownerId: amyId, tags: ['notify']}), 201);
    const mine = ok<{rows: {id: string; type: string; readAt: string | null}[]; unread: number}>(await get(amy, '/notifications'));
    expect(mine.rows.map((r) => r.type)).toContain('assigned');
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    expect(ok<{unread: number}>(await get(amy, '/notifications/count')).unread).toBe(mine.unread);
    expect(ok<{rows: unknown[]}>(await get(ben, '/notifications')).rows, "nobody sees another member's bell").toHaveLength(0);

    const id = mine.rows[0]!.id;
    ok(await post(ben, '/notifications/read', {ids: [id]}));
    ok(await del(ben, '/notifications'));
    expect(await db.notification.findUnique({where: {id}, select: {readAt: true}}), "another member can't read or clear it").toEqual({readAt: null});
    ok(await post(amy, '/notifications/read', {ids: [id]}));
    expect(ok<{unread: number}>(await get(amy, '/notifications/count')).unread).toBe(mine.unread - 1);
    ok(await del(amy, '/notifications'));
    expect(await db.notification.count({where: {id}})).toBe(0);
    // Viewers may still clear their own bell and follow records they can see (src/server/crm/app.ts).
    ok(await post(vic, '/notifications/read', {}));
    const nia = await db.contact.findFirstOrThrow({where: {firstName: 'Nia'}});
    expect(ok<{following: boolean}>(await post(vic, `/notifications/follow/contact/${nia.id}`)).following).toBe(true);
    expect((await post(vic, '/notifications/follow/contact/nope')).status, 'an unknown record').toBe(404);
    expect((await post(vic, `/notifications/follow/widget/${nia.id}`)).status, 'an unknown kind').toBe(404);
  });

  it('saved views: private ones stay private, "not yours" is 404, viewers cannot write', async () => {
    const priv = ok<{view: {id: string}}>(await post(amy, '/views', {entity: 'CONTACT', name: 'My leads', filters: {lifecycleStage: 'LEAD'}}), 201).view;
    const shared = ok<{view: {id: string}}>(await post(amy, '/views', {entity: 'CONTACT', name: 'Team', filters: {}, shared: true}), 201).view;
    const benViews = ok<{rows: {id: string}[]}>(await get(ben, '/views?entity=CONTACT')).rows.map((v) => v.id);
    expect(benViews).toContain(shared.id);
    expect(benViews).not.toContain(priv.id);
    expect((await del(ben, `/views/${priv.id}`)).status).toBe(404);
    expect((await del(ben, `/views/${shared.id}`)).status, 'a shared view is still not his to delete').toBe(404);
    expect((await post(vic, '/views', {entity: 'CONTACT', name: 'x', filters: {}})).status).toBe(403);
    expect((await get(amy, '/views?entity=WIDGET')).status).toBe(422);
    ok(await del(amy, `/views/${priv.id}`));
    ok(await del(own, `/views/${shared.id}`)); // admins may
    expect(await db.savedView.count()).toBe(0);
  });

  it('goals: admins set them; members see only their own with owner-only visibility', async () => {
    const goal = ok<{goal: {id: string}}>(await post(own, '/goals', {metric: 'deals_won', period: 'MONTH', target: 5, userId: amyId}), 201).goal;
    const team = ok<{goal: {id: string}}>(await post(own, '/goals', {metric: 'won_revenue', period: 'QUARTER', target: 1000, userId: null}), 201).goal;
    expect((await post(ben, '/goals', {metric: 'deals_won', period: 'MONTH', target: 5, userId: benId})).status).toBe(403);
    expect((await patch(ben, `/goals/${goal.id}`, {target: 1})).status).toBe(403);
    expect((await del(vic, `/goals/${goal.id}`)).status).toBe(403);
    expect((await patch(own, '/goals/nope', {target: 1})).status).toBe(404);
    expect((await get(amy, '/goals?offset=1.5')).status).toBe(422);
    expect(ok<{rows: {goal: {id: string}}[]}>(await get(ben, '/goals')).rows.map((r) => r.goal.id).sort()).toEqual([goal.id, team.id].sort());
    await visibility('owner');
    try {
      expect(ok<{rows: unknown[]}>(await get(ben, '/goals')).rows, "Amy's goal is hers").toHaveLength(0);
      expect(ok<{rows: {goal: {id: string}}[]}>(await get(amy, '/goals')).rows.map((r) => r.goal.id)).toEqual([goal.id]);
    } finally {
      await visibility('everyone');
    }
  });

  it('tags and search: everyone on the team may read them; bad input is a 422', async () => {
    const tags = ok<{rows: {tag: string; n: number}[]}>(await get(vic, '/tags?entity=CONTACT')).rows;
    expect(tags.find((t) => t.tag === 'notify')?.n).toBe(1);
    expect((await get(own, '/tags?entity=WIDGET')).status).toBe(422);
    const found = ok<{contacts: {id: string; firstName: string}[]}>(await get(vic, '/search?q=Nia'));
    expect(found.contacts.map((r) => r.firstName)).toEqual(['Nia']);
    expect((await get(own, '/search?q=')).status).toBe(422);
    await visibility('owner');
    try {
      expect(ok<{contacts: unknown[]}>(await get(ben, '/search?q=Nia')).contacts, "Amy's contact").toHaveLength(0);
    } finally {
      await visibility('everyone');
    }
  });

  it('dashboard: numbers aggregated in SQL, scoped to what the member may see', async () => {
    const pipeline = await db.pipeline.findFirstOrThrow({include: {stages: {orderBy: {position: 'asc'}}}});
    const [first, second] = pipeline.stages;
    const deal = async (b: Browser, title: string, value: number, stageId = first!.id) => ok<{deal: {id: string}}>(await post(b, '/deals', {title, value, stageId}), 201).deal.id;
    await deal(amy, 'Open A', 100);
    const moved = await deal(amy, 'Moved', 50);
    ok(await post(amy, `/deals/${moved}/move`, {stageId: second!.id}));
    const won = await deal(ben, 'Won B', 300);
    ok(await post(ben, `/deals/${won}/status`, {status: 'WON'}));
    const lost = await deal(ben, 'Lost B', 70);
    ok(await post(ben, `/deals/${lost}/status`, {status: 'LOST', lostReason: 'Price'}));

    type Dash = {totals: Record<string, number | null>; byStage: {id: string; count: number; value: number}[]; funnel: {reached: number}[]; months: {won: number; lost: number}[]; lostReasons: {reason: string; count: number}[]};
    const all = ok<Dash>(await get(own, '/dashboard'));
    expect(all.totals).toMatchObject({openCount: 2, openValue: 150, wonCount: 1, wonValue: 300, lostCount: 1, lostValue: 70, winRate: 0.5, avgDealSize: 300, rotting: 0});
    expect(all.byStage.find((s) => s.id === second!.id)).toMatchObject({count: 1, value: 50});
    expect(all.funnel[0]!.reached, 'every deal created in range reaches the first stage').toBe(4);
    expect(all.funnel[1]!.reached, 'moved + won').toBe(2);
    expect(all.months.at(-1), 'this month').toEqual(expect.objectContaining({won: 300, lost: 70}));
    expect(all.lostReasons).toEqual([expect.objectContaining({reason: 'Price', count: 1})]);
    expect(typeof all.totals.avgCycleDays).toBe('number');
    expect(ok<Dash>(await get(own, `/dashboard?ownerId=${amyId}`)).totals).toMatchObject({openCount: 2, wonCount: 0});
    expect(ok<Dash>(await get(vic, '/dashboard')).totals.openCount, 'viewers read it').toBe(2);
    expect((await get(own, '/dashboard?days=1e3')).status).toBe(422);

    await visibility('owner');
    try {
      expect(ok<Dash>(await get(ben, '/dashboard')).totals, 'only his deals').toMatchObject({openCount: 0, wonCount: 1, lostCount: 1});
      expect(ok<Dash>(await get(ben, `/dashboard?ownerId=${amyId}`)).totals.openCount, 'the owner filter never widens it').toBe(0);
    } finally {
      await visibility('everyone');
    }
  });

  it('dashboards: reorder widgets in one go; another member’s private dashboard is 404', async () => {
    const reports = await Promise.all(['R1', 'R2', 'R3'].map((name) => db.report.create({data: {name, ownerId: amyId, shared: false, config: {}}})));
    const dash = ok<{dashboard: {id: string}}>(await post(amy, '/dashboards', {name: 'Mine'}), 201).dashboard;
    for (const r of reports) ok(await post(amy, `/dashboards/${dash.id}/widgets`, {reportId: r.id}), 201);
    const widgets = await db.dashboardWidget.findMany({where: {dashboardId: dash.id}, orderBy: {position: 'asc'}});
    const order = [widgets[2]!.id, widgets[0]!.id, widgets[1]!.id];
    ok(await post(amy, `/dashboards/${dash.id}/reorder`, {ids: order}));
    expect((await db.dashboardWidget.findMany({where: {dashboardId: dash.id}, orderBy: {position: 'asc'}})).map((w) => w.id)).toEqual(order);

    expect((await get(ben, `/dashboards/${dash.id}`)).status).toBe(404);
    expect((await post(ben, `/dashboards/${dash.id}/reorder`, {ids: [...order].reverse()})).status).toBe(404);
    expect((await post(vic, `/dashboards/${dash.id}/reorder`, {ids: order})).status).toBe(403);
    expect((await db.dashboardWidget.findMany({where: {dashboardId: dash.id}, orderBy: {position: 'asc'}})).map((w) => w.id), 'unchanged').toEqual(order);
    // Ids from another dashboard are ignored.
    const other = ok<{dashboard: {id: string}}>(await post(amy, '/dashboards', {name: 'Other'}), 201).dashboard;
    ok(await post(amy, `/dashboards/${other.id}/reorder`, {ids: [order[0]!]}));
    expect((await db.dashboardWidget.findUniqueOrThrow({where: {id: order[0]!}})).position).toBe(0);
  });
});
