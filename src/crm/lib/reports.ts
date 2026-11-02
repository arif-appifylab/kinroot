/**
 * Report definitions, shared by the builder, dashboards and the server.
 * A report is one JSON document (`ReportConfig`): an object from the report
 * catalogue (src/server/lib/reports.ts), a measure, up to two group-bys,
 * filters and a chart. Keep this file free of React and server imports.
 */
import {z} from 'zod';

export type MeasureOp = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ChartType = 'bar' | 'stacked' | 'line' | 'area' | 'donut' | 'table' | 'kpi';
export type FieldKind = 'string' | 'enum' | 'number' | 'currency' | 'date' | 'boolean' | 'tags' | 'ref';
export type CondOp = 'is' | 'is_not' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'before' | 'after' | 'empty' | 'not_empty' | 'is_true' | 'is_false';

export const RANGE_PRESETS = {
  all: 'All time',
  today: 'Today',
  last_7: 'Last 7 days',
  last_30: 'Last 30 days',
  last_90: 'Last 90 days',
  last_365: 'Last 12 months',
  this_week: 'This week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year: 'This year',
  last_year: 'Last year',
  next_30: 'Next 30 days',
  next_quarter: 'Next quarter',
  custom: 'Custom range',
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS;

export const BUCKETS: Record<Bucket, string> = {day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year'};
export const MEASURE_OPS: Record<MeasureOp, string> = {count: 'Count', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum'};
export const CHARTS: Record<ChartType, string> = {bar: 'Bar', stacked: 'Stacked bar', line: 'Line', area: 'Area', donut: 'Donut', table: 'Table', kpi: 'Single number'};

const key = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.]+$/, 'unknown field');
const groupBy = z.object({field: key, bucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional()});

export const rangePreset = z.enum(Object.keys(RANGE_PRESETS) as [RangePreset, ...RangePreset[]]);
export const rangeSchema = z.object({
  preset: rangePreset.default('all'),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

export const conditionSchema = z.object({
  field: key,
  op: z.enum(['is', 'is_not', 'contains', 'gt', 'gte', 'lt', 'lte', 'before', 'after', 'empty', 'not_empty', 'is_true', 'is_false']),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(100)]).optional(),
});

export const reportConfigSchema = z.object({
  object: key,
  measure: z.object({op: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: key.optional()}),
  groupBy: groupBy.nullish(),
  breakdown: groupBy.nullish(),
  filters: z
    .object({
      dateField: key.optional(),
      range: rangeSchema.optional(),
      ownerId: z.string().max(40).optional(),
      pipelineId: z.string().max(40).optional(),
      conditions: z.array(conditionSchema).max(20).default([]),
    })
    .default({conditions: []}),
  chart: z.enum(['bar', 'stacked', 'line', 'area', 'donut', 'table', 'kpi']).default('bar'),
  /** KPI: compare with the previous period of the same length. */
  compare: z.boolean().optional(),
  /** Bars / donut / table ordering when not grouped by date. */
  sort: z.enum(['value', 'label']).optional(),
});

export type ReportConfig = z.infer<typeof reportConfigSchema>;
export type ReportCondition = z.infer<typeof conditionSchema>;
export type DateRange = z.infer<typeof rangeSchema>;
export type GroupBy = z.infer<typeof groupBy>;

/** Dashboard-level overrides applied on top of a saved report's own filters. */
export type ReportOverrides = {range?: DateRange; ownerId?: string};

// ─── Catalogue (what the server says can be reported on) ───

export type CatalogueField = {
  key: string;
  label: string;
  kind: FieldKind;
  /** enum fields: allowed values in display order */
  options?: {value: string; label: string}[];
  /** ref fields: which lookup the picker uses (user, pipeline, stage, company, form…) */
  ref?: string;
  groupable: boolean;
  /** can be summed / averaged */
  numeric: boolean;
  custom?: boolean;
};

export type CatalogueObject = {
  key: string;
  label: string;
  /** "deal" / "deals" */
  noun: [string, string];
  defaultDate: string;
  hasOwner: boolean;
  ownerLabel: string;
  hasPipeline: boolean;
  fields: CatalogueField[];
};

// ─── Result ───

export type ReportSeries = {key: string; label: string};
export type ReportRow = {key: string; label: string; values: Record<string, number>; total: number; count: number};

export type ReportResult = {
  /** "Sum of value" */
  measureLabel: string;
  format: 'number' | 'currency';
  /** count / sum: rows and series add up to the total */
  additive: boolean;
  /** Present when grouped by a date bucket: rows are chronological and gap-filled. */
  bucket?: Bucket;
  groupLabel?: string;
  breakdownLabel?: string;
  /** One series ("value") without a breakdown. */
  series: ReportSeries[];
  rows: ReportRow[];
  total: {value: number; count: number};
  /** KPI comparison with the previous period. */
  previous?: {value: number; count: number; from: string; to: string} | null;
  range: {from: string | null; to: string | null; label: string};
  truncated: boolean;
  noun: [string, string];
};

/** Which charts make sense for this shape of report. */
export function chartsFor(config: Pick<ReportConfig, 'groupBy' | 'breakdown' | 'measure'>): ChartType[] {
  if (!config.groupBy) return ['kpi', 'table'];
  const time = !!config.groupBy.bucket;
  const additive = config.measure.op === 'count' || config.measure.op === 'sum';
  if (config.breakdown) return time ? ['line', 'stacked', 'bar', 'area', 'table'].filter((c) => additive || (c !== 'stacked' && c !== 'area')) as ChartType[] : (['stacked', 'bar', 'table'] as ChartType[]).filter((c) => additive || c !== 'stacked');
  if (time) return ['line', 'bar', 'area', 'table'];
  return additive ? ['bar', 'donut', 'table'] : ['bar', 'table'];
}

// ─── Forecast & goals ───

export const FORECAST_CATEGORIES = {
  PIPELINE: 'Pipeline',
  BEST_CASE: 'Best case',
  COMMIT: 'Commit',
  CLOSED_WON: 'Closed won',
} as const;
export type ForecastCategory = keyof typeof FORECAST_CATEGORIES;
/** What a rep can set on an open deal ("Omit" leaves it out of the forecast). */
export const FORECAST_OVERRIDES = ['PIPELINE', 'BEST_CASE', 'COMMIT', 'OMIT'] as const;
export type ForecastOverride = (typeof FORECAST_OVERRIDES)[number];

/** Default category of an open deal from its stage probability. */
export const categoryFromProbability = (p: number): ForecastCategory => (p >= 80 ? 'COMMIT' : p >= 50 ? 'BEST_CASE' : 'PIPELINE');

export const GOAL_METRICS = {
  won_revenue: {label: 'Won revenue', unit: 'currency'},
  deals_won: {label: 'Deals won', unit: 'number'},
  activities: {label: 'Activities logged', unit: 'number'},
} as const;
export type GoalMetric = keyof typeof GOAL_METRICS;
export const ACTIVITY_KINDS = {CALL: 'Calls', MEETING: 'Meetings', EMAIL: 'Emails'} as const;
