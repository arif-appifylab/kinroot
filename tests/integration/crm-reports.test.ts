import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {owner, resetCrm, teammate, userId} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's report builder (src/server/crm/lib/reports.ts) on real Postgres: every query is one
 * tagged `Prisma.sql` with bound values, so this runs each kind of piece once: date buckets in a
 * zone, tags, custom fields (their key a parameter), every filter, a breakdown with a
 * non-additive measure, the ref labels and picker list, and a member limited to their own records.
 */

type Row = {key: string; label: string; total: number; count: number; values: Record<string, number>};
type Result = {total: {value: number; count: number}; rows: Row[]; series: {key: string; label: string}[]; previous: unknown};

const run = async (browser: Browser, config: Record<string, unknown>, query = '') => {
  const res = await browser.get(`/site-api/crm/reports/run?tz=Asia%2FDhaka${query}&config=${encodeURIComponent(JSON.stringify(config))}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as Result;
};
const totals = (r: Result) => Object.fromEntries(r.rows.map(row => [row.label, row.total]));

let ownerBrowser: Browser;
let memberBrowser: Browser;
let stages: {early: string; late: string};

async function seed() {
  ownerBrowser = await owner();
  await ownerBrowser.get('/site-api/crm/auth/state'); // the owner's first visit makes their team row
  ({browser: memberBrowser} = await teammate(ownerBrowser, 'maya@example.com'));
  const me = await db.member.findUniqueOrThrow({where: {userId: await userId('owner@example.com')}});
  const maya = await db.member.findUniqueOrThrow({where: {userId: await userId('maya@example.com')}});

  const pipeline = await db.pipeline.create({data: {name: 'Sales', position: 0}});
  const early = await db.stage.create({data: {pipelineId: pipeline.id, name: 'Qualified', position: 0, probability: 20}});
  const late = await db.stage.create({data: {pipelineId: pipeline.id, name: 'Proposal', position: 1, probability: 60}});
  stages = {early: early.id, late: late.id};
  await db.customFieldDef.createMany({
    data: [
      {entity: 'DEAL', key: 'region', label: 'Region', type: 'SELECT', options: ['EU', 'US'], position: 0},
      {entity: 'DEAL', key: 'score', label: 'Score', type: 'NUMBER', position: 1},
      {entity: 'DEAL', key: 'launch', label: 'Launch', type: 'DATE', position: 2},
    ],
  });
  const deal = (title: string, value: number, createdAt: string, extra: Record<string, unknown>) =>
    db.deal.create({data: {title, value, pipelineId: pipeline.id, stageId: early.id, createdAt: new Date(createdAt), ...extra}});
  await deal('Acme renewal', 100, '2026-01-15T12:00:00Z', {ownerId: me.id, tags: ['vip', 'new'], custom: {region: 'EU', score: 5, launch: '2026-03-10'}});
  await deal('Globex pilot', 300, '2026-02-20T12:00:00Z', {ownerId: maya.id, stageId: late.id, custom: {region: 'US', score: 7, launch: '2026-05-01'}});
  await deal('Initech upgrade', 200, '2026-02-25T12:00:00Z', {status: 'LOST', lostReason: 'Chose a pilot elsewhere', closedAt: new Date('2026-03-01T12:00:00Z'), tags: ['vip'], custom: {region: 'EU'}});

  await db.ticket.createMany({data: [{subject: 'Maya’s', assigneeId: maya.id}, {subject: 'Nobody’s'}, {subject: 'Owner’s', assigneeId: me.id}]});
}

describe.skipIf(!DATABASE_URL)('Kinroot reports (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    await seed();
  });

  it('groups by month in the viewer’s zone, by tags and by a custom field', async () => {
    const months = await run(ownerBrowser, {object: 'deals', measure: {op: 'count'}, groupBy: {field: 'createdAt', bucket: 'month'}});
    expect(months.rows.map(r => [r.key, r.total])).toEqual([
      ['2026-01-01', 1],
      ['2026-02-01', 2],
    ]);

    const tags = await run(ownerBrowser, {object: 'deals', measure: {op: 'sum', field: 'value'}, groupBy: {field: 'tags'}});
    expect(totals(tags)).toEqual({vip: 300, new: 100, 'No tags': 300});

    const region = await run(ownerBrowser, {object: 'deals', measure: {op: 'sum', field: 'value'}, groupBy: {field: 'custom.region'}});
    expect(totals(region)).toEqual({EU: 300, US: 300});
    expect(region.total).toEqual({value: 600, count: 3});
  });

  it('applies every kind of filter with its value bound', async () => {
    const count = async (conditions: unknown[]) => (await run(ownerBrowser, {object: 'deals', measure: {op: 'count'}, filters: {conditions}})).total.count;
    expect(await count([{field: 'lostReason', op: 'contains', value: 'pilot'}])).toBe(1);
    expect(await count([{field: 'lostReason', op: 'contains', value: "'; DROP TABLE \"Deal\"; --"}])).toBe(0);
    expect(await count([{field: 'custom.region', op: 'is', value: ['EU']}])).toBe(2);
    expect(await count([{field: 'custom.region', op: 'is_not', value: 'EU'}])).toBe(1);
    expect(await count([{field: 'value', op: 'gt', value: 150}])).toBe(2);
    expect(await count([{field: 'createdAt', op: 'after', value: '2026-02-01'}])).toBe(2);
    expect(await count([{field: 'custom.launch', op: 'before', value: '2026-04-01'}])).toBe(1);
    expect(await count([{field: 'tags', op: 'is', value: ['vip']}])).toBe(2);
    expect(await count([{field: 'tags', op: 'empty'}])).toBe(1);
    expect(await count([{field: 'custom.score', op: 'not_empty'}])).toBe(2);
    expect(await count([{field: 'status', op: 'is', value: 'LOST'}])).toBe(1);

    // The pipeline filter and a custom range (bound instants).
    const ranged = await run(ownerBrowser, {object: 'deals', measure: {op: 'count'}, filters: {pipelineId: (await db.pipeline.findFirstOrThrow()).id, range: {preset: 'custom', from: '2026-02-01', to: '2026-02-28'}, conditions: []}});
    expect(ranged.total.count).toBe(2);
  });

  it('labels refs, breaks down a non-additive measure and answers the picker list', async () => {
    const avg = await run(ownerBrowser, {object: 'deals', measure: {op: 'avg', field: 'value'}, groupBy: {field: 'stage'}, breakdown: {field: 'owner'}});
    expect(totals(avg)).toEqual({Qualified: 150, Proposal: 300});
    expect(avg.series.map(s => s.label).sort()).toEqual(['No owner', 'maya', 'owner'].sort());

    const kpi = await run(ownerBrowser, {object: 'deals', measure: {op: 'sum', field: 'custom.score'}, chart: 'kpi', compare: true, filters: {range: {preset: 'last_30'}, conditions: []}});
    expect(kpi.total).toBeDefined();

    const stagesList = await ownerBrowser.get('/site-api/crm/reports/refs/stage');
    expect((stagesList.json.rows as {id: string}[]).map(r => r.id)).toEqual([stages.early, stages.late]);
    expect((await ownerBrowser.get('/site-api/crm/reports/refs/nothing')).status).toBe(404);
  });

  it('limits a member to their own records when visibility is owner-only', async () => {
    await db.setting.upsert({where: {key: 'workspace'}, create: {key: 'workspace', value: {recordVisibility: 'owner'}}, update: {value: {recordVisibility: 'owner'}}});
    expect((await run(memberBrowser, {object: 'deals', measure: {op: 'count'}})).total.count).toBe(1);
    // Tickets: their own and unassigned ones (the object's own scope).
    expect((await run(memberBrowser, {object: 'tickets', measure: {op: 'count'}})).total.count).toBe(2);
    expect((await run(ownerBrowser, {object: 'tickets', measure: {op: 'count'}})).total.count).toBe(3);
  });
});
