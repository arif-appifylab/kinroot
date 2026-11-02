import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma, Report} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import type {Db} from '../kit/db';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {
  FORECAST_CATEGORIES,
  FORECAST_OVERRIDES,
  categoryFromProbability,
  rangePreset,
  reportConfigSchema,
  type ForecastCategory,
  type ReportConfig,
  type ReportOverrides,
  type ReportResult,
} from '@/lib/reports';
import {logActivity} from '../lib/activity';
import {audit} from '../lib/audit';
import {emit} from '../lib/events';
import {notFound, ownerScope, valid} from '../lib/http';
import {periodSpan, safeTz, wallKey, wallOf} from '../lib/periods';
import {catalogue, refList, runReport} from '../lib/reports';
import {userSelect} from '../lib/users';
import {csv} from './import-export';

/** Query params every run / export accepts: viewer time zone + dashboard overrides. */
const runQuery = z.object({
  tz: z.string().max(64).optional(),
  range: rangePreset.optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  ownerId: z.string().max(40).optional(),
});

const configParam = z.object({config: z.string().max(20_000)});

function parseConfig(raw: string): ReportConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HTTPException(400, {message: 'Report definition is not valid JSON'});
  }
  const parsed = reportConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HTTPException(400, {message: `${issue?.path.join('.') || 'report'}: ${issue?.message ?? 'invalid'}`});
  }
  return parsed.data;
}

function overridesOf(q: z.infer<typeof runQuery>): ReportOverrides {
  return {range: q.range ? {preset: q.range, from: q.from, to: q.to} : undefined, ownerId: q.ownerId || undefined};
}

export async function runFor(c: AppContext, config: ReportConfig, q: z.infer<typeof runQuery>) {
  const scope = await ownerScope(c);
  return runReport(c.var.db, config, {tz: safeTz(q.tz), scopeOwnerId: scope.ownerId, overrides: overridesOf(q)});
}

/** A report's numbers as CSV (formula-safe, see import-export.ts). Also attached to scheduled report emails. */
export function resultCsv(r: ReportResult) {
  const multi = r.series.length > 1 || r.series[0]?.key !== 'value';
  const columns = [r.groupLabel ?? 'Report', ...r.series.map((s) => (multi ? s.label : r.measureLabel)), ...(multi ? ['Total'] : []), `Number of ${r.noun[1]}`];
  const rows = r.rows.map((row) => {
    const out: Record<string, unknown> = {[columns[0]!]: row.label};
    r.series.forEach((s, i) => (out[columns[i + 1]!] = round(row.values[s.key] ?? 0)));
    if (multi) out.Total = round(row.total);
    out[columns[columns.length - 1]!] = row.count;
    return out;
  });
  return csv(rows, [...new Set(columns)]);
}

const round = (n: number) => Math.round(n * 100) / 100;

const fileName = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}-${new Date().toISOString().slice(0, 10)}.csv`;
const csvResponse = (body: string, name: string) =>
  new Response(body, {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${fileName(name)}"`}});

export const reportSelect = {owner: {select: userSelect}, _count: {select: {widgets: true}}} satisfies Prisma.ReportInclude;

/** Shared reports, plus the user's own private ones. */
export const visibleReports = (me: User): Prisma.ReportWhereInput => ({OR: [{shared: true}, {ownerId: me.id}]});

export async function findReport(db: Db, me: User, id: string) {
  const report = await db.report.findFirst({where: {id, ...visibleReports(me)}});
  if (!report) throw notFound('Report');
  return report;
}

function assertCanEdit(me: User, report: Pick<Report, 'ownerId'>, what = 'report') {
  if (report.ownerId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: `Only the creator or an admin can change this ${what}`});
}

const reportBody = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  description: z.string().trim().max(500).nullish(),
  shared: z.boolean().optional(),
  config: reportConfigSchema,
});

// ─── Forecast ───

const forecastQuery = z.object({
  tz: z.string().max(64).optional(),
  pipelineId: z.string().max(40).optional(),
  ownerId: z.string().max(40).optional(),
  months: z.coerce.number().int().min(1).max(12).default(3),
});

type ForecastRow = Record<ForecastCategory, number> & {key: string; label: string; weighted: number; count: number};

async function forecast(c: AppContext, q: z.infer<typeof forecastQuery>) {
  const db = c.var.db;
  const tz = safeTz(q.tz);
  const scope: Prisma.DealWhereInput = {...(await ownerScope(c))};
  // ANDed with the visibility scope, so the owner filter can only narrow it.
  if (q.ownerId) scope.AND = [{ownerId: q.ownerId === 'none' ? null : q.ownerId}];
  if (q.pipelineId) scope.pipelineId = q.pipelineId;
  const first = periodSpan('MONTH', tz, 0);
  const end = periodSpan('MONTH', tz, q.months - 1).to;

  const [open, won, undated] = await Promise.all([
    db.deal.findMany({
      where: {...scope, status: 'OPEN', expectedCloseDate: {lt: end}},
      include: {stage: true, owner: {select: userSelect}, company: {select: {id: true, name: true}}},
      orderBy: {expectedCloseDate: 'asc'},
      take: 2000,
    }),
    db.deal.findMany({where: {...scope, status: 'WON', closedAt: {gte: first.from, lt: end}}, select: {value: true, closedAt: true}}),
    db.deal.aggregate({where: {...scope, status: 'OPEN', expectedCloseDate: null}, _count: {_all: true}, _sum: {value: true}}),
  ]);

  const empty = (key: string, label: string): ForecastRow => ({key, label, PIPELINE: 0, BEST_CASE: 0, COMMIT: 0, CLOSED_WON: 0, weighted: 0, count: 0});
  const months: ForecastRow[] = [];
  for (let i = 0; i < q.months; i++) {
    const p = periodSpan('MONTH', tz, i);
    months.push(empty(p.key, p.label));
  }
  // Open deals whose close date has passed are still in play: they sit in an "Overdue" row.
  const overdue = empty('overdue', 'Overdue');
  const monthOf = (d: Date) => {
    if (d < first.from) return overdue;
    const w = wallOf(tz, d);
    return months.find((m) => m.key === wallKey({y: w.y, m: w.m, d: 1}));
  };

  const deals = open.map((d) => {
    const auto = categoryFromProbability(d.stage.probability);
    const override = FORECAST_OVERRIDES.includes(d.forecastCategory as never) ? (d.forecastCategory as (typeof FORECAST_OVERRIDES)[number]) : null;
    const category = override ?? auto;
    const weighted = (d.value * d.stage.probability) / 100;
    if (category !== 'OMIT') {
      const row = monthOf(d.expectedCloseDate!);
      if (row) {
        row[category] += d.value;
        row.weighted += weighted;
        row.count++;
      }
    }
    return {
      id: d.id,
      title: d.title,
      value: d.value,
      currency: d.currency,
      expectedCloseDate: d.expectedCloseDate,
      stage: {id: d.stage.id, name: d.stage.name, probability: d.stage.probability, color: d.stage.color},
      owner: d.owner,
      company: d.company,
      category,
      auto,
      override,
      weighted,
    };
  });
  for (const d of won) {
    const row = monthOf(d.closedAt!);
    if (row && row !== overdue) {
      row.CLOSED_WON += d.value;
      row.weighted += d.value;
      row.count++;
    }
  }
  const rows = [...(overdue.count ? [overdue] : []), ...months];
  const totals = rows.reduce((t, r) => {
    for (const k of [...(Object.keys(FORECAST_CATEGORIES) as ForecastCategory[]), 'weighted', 'count'] as const) t[k] += r[k];
    return t;
  }, empty('total', 'Total'));
  return {rows, totals, deals, noCloseDate: {count: undated._count._all, value: undated._sum.value ?? 0}, range: {from: first.from, to: end}};
}

export const reports = new Hono<AppEnv>()
  /** Objects and fields the builder can use (custom fields included). */
  .get('/catalogue', async (c) => c.json({objects: await catalogue(c.var.db)}))

  /** Options for ref filters (companies, forms…). */
  .get('/refs/:ref', async (c) => {
    const sql = refList(c.req.param('ref'));
    if (!sql) throw notFound('List');
    return c.json({rows: await c.var.db.$queryRaw<{id: string; label: string}[]>(sql)});
  })

  // GET so viewers can run reports too; the definition travels as JSON in `config`.
  .get('/run', valid('query', configParam.extend(runQuery.shape)), async (c) => {
    const q = c.req.valid('query');
    return c.json(await runFor(c, parseConfig(q.config), q));
  })

  .get('/export.csv', valid('query', configParam.extend(runQuery.shape).extend({name: z.string().max(120).optional()})), async (c) => {
    const q = c.req.valid('query');
    await audit(c.var.db, c, {action: 'export.csv', entity: 'report', label: q.name ?? 'Unsaved report', meta: {object: parseConfig(q.config).object}});
    return csvResponse(resultCsv(await runFor(c, parseConfig(q.config), q)), q.name ?? 'report');
  })

  .get('/forecast', valid('query', forecastQuery), async (c) => c.json(await forecast(c, c.req.valid('query'))))

  .get('/forecast.csv', valid('query', forecastQuery), async (c) => {
    const f = await forecast(c, c.req.valid('query'));
    const cols = ['Month', ...Object.values(FORECAST_CATEGORIES), 'Weighted', 'Deals'];
    const rows = [...f.rows, f.totals].map((r) => ({
      Month: r.label,
      ...Object.fromEntries((Object.keys(FORECAST_CATEGORIES) as ForecastCategory[]).map((k) => [FORECAST_CATEGORIES[k], round(r[k])])),
      Weighted: round(r.weighted),
      Deals: r.count,
    }));
    await audit(c.var.db, c, {action: 'export.csv', entity: 'report', label: 'Forecast', meta: c.req.valid('query')});
    return csvResponse(csv(rows, cols), 'forecast');
  })

  /** Per-deal override of the forecast category (null = back to the stage default). */
  .post('/forecast/deals/:id', valid('json', z.object({category: z.enum(FORECAST_OVERRIDES).nullable()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const deal = await db.deal.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}, include: {stage: true}});
    if (!deal) throw notFound('Deal');
    const {category} = c.req.valid('json');
    const label = (v: string | null) => (v === 'OMIT' ? 'Omitted' : v ? FORECAST_CATEGORIES[v as ForecastCategory] : `Automatic (${FORECAST_CATEGORIES[categoryFromProbability(deal.stage.probability)]})`);
    if ((deal.forecastCategory ?? null) !== category) {
      const updated = await db.deal.update({where: {id: deal.id}, data: {forecastCategory: category}});
      const changes = [{field: 'forecast category', from: label(deal.forecastCategory), to: label(category)}];
      await logActivity(db, {type: 'field_changed', title: 'Deal updated', actorId: me.id, dealId: deal.id, data: {changes}});
      await emit(db, 'deal.updated', {recordId: deal.id, actorId: me.id, data: {...updated, changes}});
    }
    return c.json({ok: true});
  })

  .get('/', async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.report.findMany({where: visibleReports(me), include: reportSelect, orderBy: {updatedAt: 'desc'}});
    return c.json({rows});
  })

  .post('/', valid('json', reportBody), async (c) => {
    const me = currentUser(c);
    const {config, ...body} = c.req.valid('json');
    const report = await c.var.db.report.create({data: {...body, config: config as Prisma.InputJsonValue, ownerId: me.id}, include: reportSelect});
    return c.json({report}, 201);
  })

  .get('/:id', async (c) => {
    const me = currentUser(c);
    const report = await c.var.db.report.findFirst({where: {id: c.req.param('id'), ...visibleReports(me)}, include: reportSelect});
    if (!report) throw notFound('Report');
    return c.json({report});
  })

  .patch('/:id', valid('json', reportBody.partial()), async (c) => {
    const me = currentUser(c);
    const found = await findReport(c.var.db, me, c.req.param('id'));
    assertCanEdit(me, found);
    const {config, ...body} = c.req.valid('json');
    const report = await c.var.db.report.update({where: {id: found.id}, data: {...body, config: config as Prisma.InputJsonValue | undefined}, include: reportSelect});
    return c.json({report});
  })

  .post('/:id/duplicate', async (c) => {
    const me = currentUser(c);
    const found = await findReport(c.var.db, me, c.req.param('id'));
    const report = await c.var.db.report.create({
      data: {name: `${found.name} (copy)`.slice(0, 120), description: found.description, config: found.config as Prisma.InputJsonValue, shared: false, ownerId: me.id},
      include: reportSelect,
    });
    return c.json({report}, 201);
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    const found = await findReport(c.var.db, me, c.req.param('id'));
    assertCanEdit(me, found);
    await c.var.db.report.delete({where: {id: found.id}});
    return c.json({ok: true});
  })

  .get('/:id/run', valid('query', runQuery), async (c) => {
    const report = await findReport(c.var.db, currentUser(c), c.req.param('id'));
    return c.json(await runFor(c, parseConfig(JSON.stringify(report.config)), c.req.valid('query')));
  })

  .get('/:id/export.csv', valid('query', runQuery), async (c) => {
    const report = await findReport(c.var.db, currentUser(c), c.req.param('id'));
    await audit(c.var.db, c, {action: 'export.csv', entity: 'report', recordId: report.id, label: report.name});
    return csvResponse(resultCsv(await runFor(c, parseConfig(JSON.stringify(report.config)), c.req.valid('query'))), report.name);
  });

export {assertCanEdit, parseConfig, runQuery};
