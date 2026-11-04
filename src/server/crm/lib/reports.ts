import {HTTPException} from 'hono/http-exception';

import {Prisma, type EntityType} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {
  MEASURE_OPS,
  type Bucket,
  type CatalogueField,
  type CatalogueObject,
  type FieldKind,
  type ReportCondition,
  type ReportConfig,
  type ReportOverrides,
  type ReportResult,
  type ReportRow,
} from '@/lib/reports';
import {bucketLabel, bucketStart, nextBucket, parseKey, resolveRange, wallKey, wallOf, type Span} from './periods';
import {strings} from './json-list';

/**
 * Report engine. Every reportable object is declared in a catalogue: a table,
 * the SQL expression behind each field, and how owner / pipeline scoping
 * applies. The builder only ever sends catalogue keys; SQL is assembled from
 * these declarations and every value goes in as a bind parameter, so a report
 * can never run arbitrary SQL.
 *
 * Later modules (tickets, lists, bookings…) add their objects with
 * `registerReportObject()` from their own server file; see AGENTS.md.
 */

export type ReportFieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  /** SQL expression over the object's row alias `t`: a constant written in code, or `Prisma.sql` when it carries a value. Never built from input. */
  sql: string | Prisma.Sql;
  options?: {value: string; label: string}[];
  /** ref fields: key in REFS used to turn ids into labels */
  ref?: string;
  /** default: true for string/enum/ref/tags/boolean/date, false for numbers */
  groupable?: boolean;
  /** date fields holding a calendar date (no time of day), compared as wall dates */
  dateOnly?: boolean;
  /** label for the empty group, e.g. "No owner" */
  empty?: string;
};

export type ReportObjectDef = {
  key: string;
  label: string;
  noun: [string, string];
  /** quoted table name, e.g. '"Deal"' */
  table: string;
  /** extra base condition over `t`, e.g. only closed tickets */
  where?: string;
  /** expression giving the owning user's id; members with owner-only visibility see their rows only */
  ownerSql?: string;
  ownerLabel?: string;
  /** owner-only visibility when it is wider than `ownerSql = me` (e.g. tickets: mine or unassigned); `me` is bound as a parameter */
  scopeSql?: (me: string) => Prisma.Sql;
  /** expression giving the pipeline id, enables the pipeline filter */
  pipelineSql?: string;
  /** field key used by the date-range filter by default */
  defaultDate: string;
  /** adds the custom fields of this entity (custom.<key>) */
  customEntity?: EntityType;
  fields: ReportFieldDef[];
};

/** id → label lookups for ref fields. `sql` gets the ids (never empty; bound one by one with `IN (…)`); `list` feeds filter pickers. */
export type RefDef = {sql: (ids: string[]) => Prisma.Sql; list?: Prisma.Sql};

const REFS: Record<string, RefDef> = {
  user: {
    sql: (ids) => Prisma.sql`SELECT id, name AS label, NULL::float8 AS ord, NULL::text AS ctx FROM "Member" WHERE id IN (${Prisma.join(ids)})`,
    list: Prisma.sql`SELECT id, name AS label FROM "Member" WHERE active ORDER BY name LIMIT 500`,
  },
  pipeline: {
    sql: (ids) => Prisma.sql`SELECT id, name AS label, position::float8 AS ord, NULL::text AS ctx FROM "Pipeline" WHERE id IN (${Prisma.join(ids)})`,
    list: Prisma.sql`SELECT id, name AS label FROM "Pipeline" ORDER BY position LIMIT 500`,
  },
  stage: {
    sql: (ids) => Prisma.sql`SELECT s.id, s.name AS label, (p.position * 1000 + s.position)::float8 AS ord, p.name AS ctx FROM "Stage" s JOIN "Pipeline" p ON p.id = s."pipelineId" WHERE s.id IN (${Prisma.join(ids)})`,
    list: Prisma.sql`SELECT s.id, p.name || ' · ' || s.name AS label FROM "Stage" s JOIN "Pipeline" p ON p.id = s."pipelineId" ORDER BY p.position, s.position LIMIT 500`,
  },
  company: {
    sql: (ids) => Prisma.sql`SELECT id, name AS label, NULL::float8 AS ord, NULL::text AS ctx FROM "Company" WHERE id IN (${Prisma.join(ids)})`,
    list: Prisma.sql`SELECT id, name AS label FROM "Company" ORDER BY name LIMIT 500`,
  },
  form: {
    sql: (ids) => Prisma.sql`SELECT id, name AS label, NULL::float8 AS ord, NULL::text AS ctx FROM "Form" WHERE id IN (${Prisma.join(ids)})`,
    list: Prisma.sql`SELECT id, name AS label FROM "Form" ORDER BY name LIMIT 500`,
  },
};

const OBJECTS = new Map<string, ReportObjectDef>();

export function registerReportObject(def: ReportObjectDef) {
  OBJECTS.set(def.key, def);
}

export function registerReportRef(key: string, def: RefDef) {
  REFS[key] = def;
}

const EXTRA_FIELDS = new Map<string, ((db: Db) => Promise<ReportFieldDef[]>)[]>();

/** Fields another module adds to an existing object, resolved per request (e.g. lead score bands, which come from settings). */
export function registerReportFields(objectKey: string, fields: (db: Db) => Promise<ReportFieldDef[]>) {
  EXTRA_FIELDS.set(objectKey, [...(EXTRA_FIELDS.get(objectKey) ?? []), fields]);
}

export const refList = (key: string) => REFS[key]?.list;

const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({value, label}));
const owner = (sql: string, label = 'Owner', empty = 'No owner'): ReportFieldDef => ({key: 'owner', label, kind: 'ref', ref: 'user', sql, empty});
const date = (key: string, label: string, sql = `t."${key}"`): ReportFieldDef => ({key, label, kind: 'date', sql});
const text = (key: string, label: string, empty?: string): ReportFieldDef => ({key, label, kind: 'string', sql: `NULLIF(t."${key}", '')`, empty});
const stageProbability = '(SELECT s.probability FROM "Stage" s WHERE s.id = t."stageId")';

// ─── Built-in objects ───

registerReportObject({
  key: 'deals',
  label: 'Deals',
  noun: ['deal', 'deals'],
  table: '"Deal"',
  ownerSql: 't."ownerId"',
  pipelineSql: 't."pipelineId"',
  defaultDate: 'createdAt',
  customEntity: 'DEAL',
  fields: [
    {key: 'value', label: 'Deal value', kind: 'currency', sql: 't."value"'},
    {key: 'weighted', label: 'Weighted value (open)', kind: 'currency', sql: `CASE WHEN t."status" = 'OPEN' THEN t."value" * ${stageProbability} / 100.0 ELSE 0 END`},
    {key: 'probability', label: 'Stage probability (%)', kind: 'number', sql: `${stageProbability}::float8`},
    {key: 'cycleDays', label: 'Days to close', kind: 'number', sql: `CASE WHEN t."closedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM t."closedAt" - t."createdAt") / 86400.0 END`},
    {key: 'status', label: 'Status', kind: 'enum', sql: 't."status"::text', options: opts({OPEN: 'Open', WON: 'Won', LOST: 'Lost'})},
    {key: 'pipeline', label: 'Pipeline', kind: 'ref', ref: 'pipeline', sql: 't."pipelineId"'},
    {key: 'stage', label: 'Stage', kind: 'ref', ref: 'stage', sql: 't."stageId"'},
    owner('t."ownerId"'),
    {key: 'company', label: 'Company', kind: 'ref', ref: 'company', sql: 't."companyId"', empty: 'No company'},
    {
      key: 'forecast',
      label: 'Forecast category',
      kind: 'enum',
      sql: `CASE WHEN t."status" = 'WON' THEN 'CLOSED_WON' WHEN t."status" = 'LOST' THEN 'CLOSED_LOST' WHEN t."forecastCategory" IS NOT NULL THEN t."forecastCategory"
        ELSE (SELECT CASE WHEN s.probability >= 80 THEN 'COMMIT' WHEN s.probability >= 50 THEN 'BEST_CASE' ELSE 'PIPELINE' END FROM "Stage" s WHERE s.id = t."stageId") END`,
      options: opts({PIPELINE: 'Pipeline', BEST_CASE: 'Best case', COMMIT: 'Commit', CLOSED_WON: 'Closed won', OMIT: 'Omitted', CLOSED_LOST: 'Closed lost'}),
    },
    text('type', 'Deal type'),
    text('priority', 'Priority'),
    text('lostReason', 'Lost reason', 'No reason'),
    text('currency', 'Currency'),
    {key: 'tags', label: 'Tags', kind: 'tags', sql: 't."tags"', empty: 'No tags'},
    date('createdAt', 'Create date'),
    date('expectedCloseDate', 'Expected close date'),
    date('closedAt', 'Close date'),
    date('stageEnteredAt', 'Entered current stage'),
    date('lastActivityAt', 'Last activity'),
  ],
});

registerReportObject({
  key: 'contacts',
  label: 'Contacts',
  noun: ['contact', 'contacts'],
  table: '"Contact"',
  ownerSql: 't."ownerId"',
  defaultDate: 'createdAt',
  customEntity: 'CONTACT',
  fields: [
    {key: 'deals', label: 'Number of deals', kind: 'number', sql: '(SELECT COUNT(*) FROM "DealContact" dc WHERE dc."contactId" = t.id)::float8'},
    {key: 'lifecycleStage', label: 'Lifecycle stage', kind: 'enum', sql: 't."lifecycleStage"::text', options: opts({LEAD: 'Lead', QUALIFIED: 'Qualified', OPPORTUNITY: 'Opportunity', CUSTOMER: 'Customer', CHURNED: 'Churned', OTHER: 'Other'})},
    text('leadStatus', 'Lead status'),
    text('source', 'Source', 'No source'),
    text('buyingRole', 'Buying role'),
    text('title', 'Job title'),
    text('city', 'City'),
    text('country', 'Country'),
    owner('t."ownerId"'),
    {key: 'company', label: 'Primary company', kind: 'ref', ref: 'company', empty: 'No company', sql: '(SELECT cc."companyId" FROM "ContactCompany" cc WHERE cc."contactId" = t.id AND cc."isPrimary" LIMIT 1)'},
    {key: 'emailOptOut', label: 'Unsubscribed from email', kind: 'boolean', sql: 't."emailOptOut"'},
    {key: 'tags', label: 'Tags', kind: 'tags', sql: 't."tags"', empty: 'No tags'},
    date('createdAt', 'Create date'),
    date('lastActivityAt', 'Last activity'),
  ],
});

registerReportObject({
  key: 'companies',
  label: 'Companies',
  noun: ['company', 'companies'],
  table: '"Company"',
  ownerSql: 't."ownerId"',
  defaultDate: 'createdAt',
  customEntity: 'COMPANY',
  fields: [
    {key: 'annualRevenue', label: 'Annual revenue', kind: 'currency', sql: 't."annualRevenue"'},
    {key: 'employees', label: 'Employees', kind: 'number', sql: 't."employees"::float8'},
    {key: 'contacts', label: 'Number of contacts', kind: 'number', sql: '(SELECT COUNT(*) FROM "ContactCompany" cc WHERE cc."companyId" = t.id)::float8'},
    text('industry', 'Industry'),
    text('size', 'Company size'),
    text('type', 'Company type'),
    text('city', 'City'),
    text('country', 'Country'),
    owner('t."ownerId"'),
    {key: 'tags', label: 'Tags', kind: 'tags', sql: 't."tags"', empty: 'No tags'},
    date('createdAt', 'Create date'),
    date('lastActivityAt', 'Last activity'),
  ],
});

registerReportObject({
  key: 'tasks',
  label: 'Tasks',
  noun: ['task', 'tasks'],
  table: '"Task"',
  ownerSql: 't."assigneeId"',
  ownerLabel: 'Assignee',
  defaultDate: 'dueAt',
  fields: [
    {key: 'status', label: 'Status', kind: 'enum', sql: `CASE WHEN t."done" THEN 'DONE' WHEN t."dueAt" < now() AT TIME ZONE 'UTC' THEN 'OVERDUE' ELSE 'OPEN' END`, options: opts({OPEN: 'Open', OVERDUE: 'Overdue', DONE: 'Done'})},
    {key: 'type', label: 'Task type', kind: 'enum', sql: 't."type"::text', options: opts({TODO: 'To-do', CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting', DEADLINE: 'Deadline'})},
    {key: 'priority', label: 'Priority', kind: 'enum', sql: 't."priority"::text', options: opts({HIGH: 'High', NORMAL: 'Medium', LOW: 'Low', NONE: 'None'})},
    text('queue', 'Queue', 'No queue'),
    owner('t."assigneeId"', 'Assignee', 'Unassigned'),
    {key: 'creator', label: 'Created by', kind: 'ref', ref: 'user', sql: 't."creatorId"', empty: 'Unknown'},
    {key: 'done', label: 'Completed', kind: 'boolean', sql: 't."done"'},
    date('dueAt', 'Due date'),
    date('doneAt', 'Completed date'),
    date('createdAt', 'Create date'),
  ],
});

registerReportObject({
  key: 'interactions',
  label: 'Logged activities',
  noun: ['activity', 'activities'],
  table: '"Interaction"',
  ownerSql: 't."authorId"',
  ownerLabel: 'Logged by',
  defaultDate: 'occurredAt',
  fields: [
    {key: 'durationMin', label: 'Duration (minutes)', kind: 'number', sql: 't."durationMin"::float8'},
    {key: 'kind', label: 'Activity type', kind: 'enum', sql: 't."kind"::text', options: opts({CALL: 'Call', MEETING: 'Meeting', EMAIL: 'Email', SMS: 'SMS', LINKEDIN: 'LinkedIn', WHATSAPP: 'WhatsApp', POSTAL: 'Postal mail'})},
    text('outcome', 'Outcome', 'No outcome'),
    {key: 'direction', label: 'Direction', kind: 'enum', sql: 't."direction"', options: opts({OUTBOUND: 'Outbound', INBOUND: 'Inbound'})},
    {key: 'locationType', label: 'Meeting location', kind: 'enum', sql: 't."locationType"', options: opts({VIDEO: 'Video call', PHONE: 'Phone', IN_PERSON: 'In person', OTHER: 'Other'})},
    owner('t."authorId"', 'Logged by', 'Unknown'),
    {key: 'company', label: 'Company', kind: 'ref', ref: 'company', sql: 't."companyId"', empty: 'No company'},
    date('occurredAt', 'Activity date'),
    date('createdAt', 'Logged on'),
  ],
});

registerReportObject({
  key: 'emails',
  label: 'Emails',
  noun: ['email', 'emails'],
  table: '"EmailMessage"',
  // Inbound mail has no sender; it belongs to the contact's owner.
  ownerSql: 'COALESCE(t."senderId", (SELECT c."ownerId" FROM "Contact" c WHERE c.id = t."contactId"))',
  ownerLabel: 'Sent by',
  defaultDate: 'sentAt',
  fields: [
    {key: 'openCount', label: 'Opens', kind: 'number', sql: 't."openCount"::float8'},
    {key: 'clickCount', label: 'Clicks', kind: 'number', sql: 't."clickCount"::float8'},
    {key: 'direction', label: 'Direction', kind: 'enum', sql: 't."direction"::text', options: opts({OUTBOUND: 'Sent', INBOUND: 'Received'})},
    {key: 'status', label: 'Delivery status', kind: 'enum', sql: 't."status"::text', options: opts({SENT: 'Sent', RECEIVED: 'Received', QUEUED: 'Queued', FAILED: 'Failed'})},
    owner('t."senderId"', 'Sent by', 'Received'),
    {key: 'opened', label: 'Opened', kind: 'boolean', sql: 't."openCount" > 0'},
    {key: 'clicked', label: 'Clicked', kind: 'boolean', sql: 't."clickCount" > 0'},
    date('sentAt', 'Date'),
    date('firstOpenedAt', 'First opened'),
  ],
});

registerReportObject({
  key: 'submissions',
  label: 'Form submissions',
  noun: ['submission', 'submissions'],
  table: '"FormSubmission"',
  ownerSql: '(SELECT c."ownerId" FROM "Contact" c WHERE c.id = t."contactId")',
  ownerLabel: 'Contact owner',
  defaultDate: 'createdAt',
  fields: [
    {key: 'form', label: 'Form', kind: 'ref', ref: 'form', sql: 't."formId"'},
    {key: 'utm_source', label: 'UTM source', kind: 'string', sql: `NULLIF(t."meta"->>'utm_source', '')`, empty: 'No source'},
    {key: 'utm_medium', label: 'UTM medium', kind: 'string', sql: `NULLIF(t."meta"->>'utm_medium', '')`, empty: 'No medium'},
    {key: 'utm_campaign', label: 'UTM campaign', kind: 'string', sql: `NULLIF(t."meta"->>'utm_campaign', '')`, empty: 'No campaign'},
    {key: 'hasContact', label: 'Linked to a contact', kind: 'boolean', sql: 't."contactId" IS NOT NULL'},
    {key: 'hasDeal', label: 'Created a deal', kind: 'boolean', sql: 't."dealId" IS NOT NULL'},
    date('createdAt', 'Submitted'),
  ],
});

// ─── Catalogue ───

/** Custom field definitions become report fields `custom.<key>`; the key is bound as a parameter. */
async function customFields(db: Db, entity: EntityType): Promise<ReportFieldDef[]> {
  const defs = await db.customFieldDef.findMany({where: {entity}, orderBy: {position: 'asc'}});
  return defs
    .filter((d) => /^[a-z0-9_]+$/.test(d.key))
    .flatMap((d): ReportFieldDef[] => {
      const key = `custom.${d.key}`;
      const json = Prisma.sql`t."custom"->${d.key}::text`;
      const raw = Prisma.sql`NULLIF(t."custom"->>${d.key}::text, '')`;
      switch (d.type) {
        case 'NUMBER':
        case 'CURRENCY':
          return [{key, label: d.label, kind: d.type === 'NUMBER' ? 'number' : 'currency', sql: Prisma.sql`CASE WHEN jsonb_typeof(${json}) = 'number' THEN (${json})::text::float8 END`}];
        case 'DATE':
          return [{key, label: d.label, kind: 'date', dateOnly: true, sql: Prisma.sql`CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substring(${raw} from 1 for 10)::timestamp END`}];
        case 'SELECT':
          return [{key, label: d.label, kind: 'enum', sql: raw, options: strings(d.options).map((o) => ({value: o, label: o}))}];
        case 'MULTISELECT':
          // A `tags` expression is a jsonb array (like the built-in tags columns).
          return [{key, label: d.label, kind: 'tags', options: strings(d.options).map((o) => ({value: o, label: o})), sql: Prisma.sql`(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ELSE '[]'::jsonb END)`}];
        case 'CHECKBOX':
          return [{key, label: d.label, kind: 'boolean', sql: Prisma.sql`CASE WHEN jsonb_typeof(${json}) = 'boolean' THEN (${json})::text::boolean END`}];
        case 'TEXT':
          return [{key, label: d.label, kind: 'string', sql: raw}];
        default:
          return [{key, label: d.label, kind: 'string', sql: raw, groupable: false}];
      }
    });
}

type ResolvedObject = ReportObjectDef & {byKey: Map<string, ReportFieldDef & {custom?: boolean}>};

async function resolveObject(db: Db, key: string): Promise<ResolvedObject> {
  const def = OBJECTS.get(key);
  if (!def) throw new HTTPException(400, {message: `Unknown report object "${key}"`});
  const custom = def.customEntity ? (await customFields(db, def.customEntity)).map((f) => ({...f, custom: true})) : [];
  const extra = (await Promise.all((EXTRA_FIELDS.get(key) ?? []).map((fields) => fields(db)))).flat();
  const all = [...def.fields, ...extra, ...custom];
  return {...def, fields: all, byKey: new Map(all.map((f) => [f.key, f]))};
}

const isNumeric = (k: FieldKind) => k === 'number' || k === 'currency';
const isGroupable = (f: ReportFieldDef) => f.groupable ?? !isNumeric(f.kind);

export async function catalogue(db: Db): Promise<CatalogueObject[]> {
  const out: CatalogueObject[] = [];
  for (const key of OBJECTS.keys()) {
    const o = await resolveObject(db, key);
    out.push({
      key: o.key,
      label: o.label,
      noun: o.noun,
      defaultDate: o.defaultDate,
      hasOwner: !!o.ownerSql,
      ownerLabel: o.ownerLabel ?? 'Owner',
      hasPipeline: !!o.pipelineSql,
      fields: o.fields.map(
        (f): CatalogueField => ({key: f.key, label: f.label, kind: f.kind, options: f.options, ref: f.ref, groupable: isGroupable(f), numeric: isNumeric(f.kind), custom: (f as {custom?: boolean}).custom}),
      ),
    });
  }
  return out;
}

// ─── Query building ───
//
// Every query is ONE `Prisma.sql` run with the tagged `$queryRaw`: values (ids, dates, the zone,
// filter values) are bound parameters. The only text pasted in is the constant SQL written in this
// file and the modules that register objects (`code()`), never anything from a request.

/** A constant SQL fragment from a definition in code. */
const code = (fragment: string) => Prisma.raw(fragment);
/** A field's expression, constant or carrying its own parameters (custom fields). */
const expr = (f: ReportFieldDef) => (typeof f.sql === 'string' ? code(f.sql) : f.sql);

export type RunContext = {
  tz: string;
  /** from ownerScope(): members limited to their own rows */
  scopeOwnerId?: string;
  overrides?: ReportOverrides;
  now?: number;
};

/** Caps that keep one report from scanning or returning too much. */
const MAX_CELLS = 5000;
const MAX_BUCKETS = 400;
const MAX_GROUPS = 100;
const MAX_SERIES = 8;

function field(o: ResolvedObject, key: string | undefined, what: string) {
  const f = key ? o.byKey.get(key) : undefined;
  if (!f) throw new HTTPException(400, {message: `${what}: pick a field from the list`});
  return f;
}

/** A timestamp column as wall-clock time in the viewer's zone. */
function wall(f: ReportFieldDef, tz: string) {
  return f.dateOnly ? Prisma.sql`(${expr(f)})` : Prisma.sql`((${expr(f)}) AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text`;
}

/** An instant in the column's terms (UTC timestamp, or wall time for date-only fields). */
function instant(f: ReportFieldDef, at: Date, tz: string) {
  const iso = at.toISOString();
  return f.dateOnly ? Prisma.sql`(${iso}::timestamptz AT TIME ZONE ${tz}::text)` : Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
}

function condition(f: ReportFieldDef, c: ReportCondition, tz: string): Prisma.Sql {
  const e = Prisma.sql`(${expr(f)})`;
  // A typed list arrives as one comma-separated string.
  const list = () => (Array.isArray(c.value) ? c.value.map(String) : String(c.value ?? '').split(',')).map((v) => v.trim()).filter(Boolean);
  const num = () => {
    const n = Number(c.value);
    if (!Number.isFinite(n)) throw new HTTPException(400, {message: `${f.label}: enter a number`});
    return Prisma.sql`${n}::float8`;
  };
  // `tags` expressions are jsonb arrays (the tags columns, a multi-select custom field).
  const empty = f.kind === 'tags' ? Prisma.sql`jsonb_array_length(${e}) = 0` : Prisma.sql`${e} IS NULL`;
  switch (c.op) {
    case 'empty':
      return empty;
    case 'not_empty':
      return Prisma.sql`NOT (${empty})`;
    case 'is_true':
      return Prisma.sql`${e} IS TRUE`;
    case 'is_false':
      return Prisma.sql`${e} IS NOT TRUE`;
    case 'is':
    case 'is_not': {
      if (isNumeric(f.kind)) return c.op === 'is' ? Prisma.sql`${e} = ${num()}` : Prisma.sql`${e} IS DISTINCT FROM ${num()}`;
      const values = list();
      if (!values.length) return Prisma.sql`TRUE`;
      // Values are bound one by one (never as an array parameter: the live driver can't bind one).
      if (f.kind === 'tags') {
        // Has any of them: one containment test per value (GIN-indexed on the tags columns).
        const any = Prisma.join(values.map((v) => Prisma.sql`${e} @> jsonb_build_array(${v}::text)`), ' OR ');
        return c.op === 'is' ? Prisma.sql`(${any})` : Prisma.sql`NOT (${any})`;
      }
      const set = Prisma.join(values);
      return c.op === 'is' ? Prisma.sql`${e}::text IN (${set})` : Prisma.sql`(${e} IS NULL OR NOT (${e}::text IN (${set})))`;
    }
    case 'contains': {
      const s = String(c.value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
      return s ? Prisma.sql`${e}::text ILIKE ${`%${s}%`}` : Prisma.sql`TRUE`;
    }
    case 'gt':
      return Prisma.sql`${e} > ${num()}`;
    case 'gte':
      return Prisma.sql`${e} >= ${num()}`;
    case 'lt':
      return Prisma.sql`${e} < ${num()}`;
    case 'lte':
      return Prisma.sql`${e} <= ${num()}`;
    case 'before':
    case 'after': {
      const s = String(c.value ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HTTPException(400, {message: `${f.label}: pick a date`});
      const at = Prisma.sql`${s}::date`;
      // Calendar date in the viewer's zone, compared on wall time.
      return c.op === 'before' ? Prisma.sql`${wall(f, tz)} < ${at}` : Prisma.sql`${wall(f, tz)} >= (${at} + 1)`;
    }
  }
}

type GroupSql = {select: Prisma.Sql; join: Prisma.Sql};

function groupSql(f: ReportFieldDef, bucket: Bucket | undefined, alias: 'g1' | 'g2', tz: string): GroupSql {
  if (f.kind === 'date') {
    const b = bucket ?? 'month';
    return {select: Prisma.sql`to_char(date_trunc(${b}::text, ${wall(f, tz)}), 'YYYY-MM-DD')`, join: Prisma.empty};
  }
  if (f.kind === 'tags') {
    // One row per tag (records without tags land in the empty group). `alias` is one of two constants.
    const a = code(alias);
    return {select: Prisma.sql`${a}.k`, join: Prisma.sql`LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_array_length(${expr(f)}) > 0 THEN ${expr(f)} ELSE '[null]'::jsonb END) AS ${a}(k) ON TRUE`};
  }
  if (f.kind === 'boolean') return {select: Prisma.sql`CASE WHEN (${expr(f)}) THEN 'true' ELSE 'false' END`, join: Prisma.empty};
  return {select: Prisma.sql`(${expr(f)})::text`, join: Prisma.empty};
}

const AGGREGATES = {sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX'} as const;

function measureSql(o: ResolvedObject, m: ReportConfig['measure']) {
  if (m.op === 'count') return {sql: Prisma.sql`COUNT(DISTINCT t.id)::float8`, label: `Number of ${o.noun[1]}`, format: 'number' as const};
  const f = field(o, m.field, 'Measure');
  if (!isNumeric(f.kind)) throw new HTTPException(400, {message: `${f.label} is not a number field`});
  const fn = code(AGGREGATES[m.op]);
  return {sql: Prisma.sql`${fn}((${expr(f)})::float8)::float8`, label: `${MEASURE_OPS[m.op]} of ${f.label.toLowerCase()}`, format: f.kind === 'currency' ? ('currency' as const) : ('number' as const)};
}

/** WHERE clause for the report's filters within one date span. */
function whereSql(o: ResolvedObject, config: ReportConfig, ctx: RunContext, span: Span) {
  const tz = ctx.tz;
  const parts: Prisma.Sql[] = [];
  if (o.where) parts.push(Prisma.sql`(${code(o.where)})`);
  const owner = o.ownerSql ? code(o.ownerSql) : null;
  if (ctx.scopeOwnerId && owner) parts.push(o.scopeSql ? Prisma.sql`(${o.scopeSql(ctx.scopeOwnerId)})` : Prisma.sql`(${owner}) = ${ctx.scopeOwnerId}`);
  const ownerId = ctx.overrides?.ownerId || config.filters.ownerId;
  if (ownerId && owner) parts.push(ownerId === 'none' ? Prisma.sql`(${owner}) IS NULL` : Prisma.sql`(${owner}) = ${ownerId}`);
  if (config.filters.pipelineId && o.pipelineSql) parts.push(Prisma.sql`(${code(o.pipelineSql)}) = ${config.filters.pipelineId}`);
  const df = field(o, config.filters.dateField ?? o.defaultDate, 'Date range');
  if (df.kind !== 'date') throw new HTTPException(400, {message: `${df.label} is not a date field`});
  if (span.from) parts.push(Prisma.sql`(${expr(df)}) >= ${instant(df, span.from, tz)}`);
  if (span.to) parts.push(Prisma.sql`(${expr(df)}) < ${instant(df, span.to, tz)}`);
  for (const c of config.filters.conditions) parts.push(condition(field(o, c.field, 'Filter'), c, tz));
  return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
}

type Labeller = (key: string | null) => {label: string; ord: number | null};

/** Turns raw group keys into labels and a natural sort order. */
async function labeller(db: Db, f: ReportFieldDef, keys: (string | null)[], bucket: Bucket | undefined): Promise<Labeller> {
  const none = f.empty ?? (f.kind === 'tags' ? 'No value' : '(No value)');
  if (f.kind === 'date') {
    const b = bucket ?? 'month';
    return (k) => (k ? {label: bucketLabel(k, b), ord: null} : {label: 'No date', ord: null});
  }
  if (f.kind === 'boolean') return (k) => ({label: k === 'true' ? 'Yes' : 'No', ord: k === 'true' ? 0 : 1});
  if (f.options && (f.kind === 'enum' || f.kind === 'tags')) {
    const order = new Map(f.options.map((o, i) => [o.value, i]));
    const labels = new Map(f.options.map((o) => [o.value, o.label]));
    return (k) => (k === null ? {label: none, ord: 9999} : {label: labels.get(k) ?? k, ord: order.get(k) ?? 9998});
  }
  if (f.kind === 'ref' && f.ref && REFS[f.ref]) {
    const ids = keys.filter((k): k is string => !!k);
    const rows = ids.length ? await db.$queryRaw<{id: string; label: string; ord: number | null; ctx: string | null}[]>(REFS[f.ref]!.sql(ids)) : [];
    const multi = new Set(rows.map((r) => r.ctx)).size > 1;
    const map = new Map(rows.map((r) => [r.id, {label: multi && r.ctx ? `${r.ctx} · ${r.label}` : r.label, ord: r.ord}]));
    return (k) => (k === null ? {label: none, ord: Number.MAX_SAFE_INTEGER} : map.get(k) ?? {label: 'Deleted', ord: null});
  }
  return (k) => ({label: k ?? none, ord: k === null ? Number.MAX_SAFE_INTEGER : null});
}

/** Every bucket key between two keys (inclusive), for gap-free time series. */
function bucketKeys(first: string, last: string, b: Bucket) {
  const out: string[] = [];
  let w = bucketStart(parseKey(first), b);
  const end = wallKey(bucketStart(parseKey(last), b));
  while (wallKey(w) <= end) {
    out.push(wallKey(w));
    if (out.length > MAX_BUCKETS) {
      throw new HTTPException(400, {message: `That is more than ${MAX_BUCKETS} ${b}s. Pick a bigger date bucket or a shorter date range.`});
    }
    w = nextBucket(w, b);
  }
  return out;
}

type Cell = {k1: string | null; k2: string | null; v: number | null; n: number};

export async function runReport(db: Db, config: ReportConfig, ctx: RunContext): Promise<ReportResult> {
  const o = await resolveObject(db, config.object);
  const tz = ctx.tz;
  const range = resolveRange(ctx.overrides?.range ?? config.filters.range, tz, ctx.now);
  const measure = measureSql(o, config.measure);
  const additive = config.measure.op === 'count' || config.measure.op === 'sum';

  const g1f = config.groupBy ? field(o, config.groupBy.field, 'Group by') : null;
  const g2f = config.groupBy && config.breakdown ? field(o, config.breakdown.field, 'Breakdown') : null;
  for (const g of [g1f, g2f]) if (g && !isGroupable(g)) throw new HTTPException(400, {message: `Reports can't be grouped by ${g.label}`});
  const b1 = g1f?.kind === 'date' ? (config.groupBy?.bucket ?? 'month') : undefined;
  const b2 = g2f?.kind === 'date' ? (config.breakdown?.bucket ?? 'month') : undefined;

  // Time series must stay readable: check the bucket count before querying.
  if (b1 && range.from && range.to) bucketKeys(wallKey(wallOf(tz, range.from)), wallKey(wallOf(tz, range.to.getTime() - 1)), b1);

  const totalOf = async (span: Span) => {
    const where = whereSql(o, config, ctx, span);
    const [row] = await db.$queryRaw<{v: number | null; n: number}[]>(Prisma.sql`SELECT ${measure.sql} AS v, COUNT(DISTINCT t.id)::float8 AS n FROM ${code(o.table)} t WHERE ${where}`);
    return {value: Number(row?.v ?? 0), count: Number(row?.n ?? 0)};
  };

  const total = await totalOf(range);
  const previous = config.chart === 'kpi' && config.compare && range.previous ? {...(await totalOf(range.previous)), from: range.previous.from!.toISOString(), to: range.previous.to!.toISOString()} : null;

  const base = {
    measureLabel: measure.label,
    format: measure.format,
    additive,
    total,
    previous,
    noun: o.noun,
    range: {from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null, label: range.label},
  };

  if (!g1f) {
    return {...base, series: [{key: 'value', label: measure.label}], rows: [{key: 'total', label: 'Total', values: {value: total.value}, total: total.value, count: total.count}], truncated: false};
  }

  const s1 = groupSql(g1f, b1, 'g1', tz);
  const s2 = g2f ? groupSql(g2f, b2, 'g2', tz) : null;
  const where = whereSql(o, config, ctx, range);
  const sql = Prisma.sql`SELECT ${s1.select} AS k1, ${s2 ? s2.select : Prisma.sql`NULL::text`} AS k2, ${measure.sql} AS v, COUNT(DISTINCT t.id)::float8 AS n
    FROM ${code(o.table)} t ${s1.join} ${s2?.join ?? Prisma.empty}
    WHERE ${where}
    GROUP BY 1, 2
    ORDER BY 3 DESC NULLS LAST
    LIMIT ${MAX_CELLS + 1}`;
  let cells = (await db.$queryRaw<Cell[]>(sql)).map((c) => ({...c, v: Number(c.v ?? 0), n: Number(c.n)}));
  let truncated = cells.length > MAX_CELLS;
  cells = cells.slice(0, MAX_CELLS);

  // Series (breakdown values): natural order, at most 8 (the rest fold into "Other" when they can be added up).
  const seriesTotals = new Map<string | null, number>();
  for (const c of cells) seriesTotals.set(c.k2, (seriesTotals.get(c.k2) ?? 0) + Math.abs(c.v));
  const L2 = g2f ? await labeller(db, g2f, [...seriesTotals.keys()], b2) : null;
  let seriesKeys = [...seriesTotals.keys()];
  if (L2) {
    seriesKeys.sort((a, b) => {
      const la = L2(a);
      const lb = L2(b);
      if (g2f!.kind === 'date') return (a ?? '￿').localeCompare(b ?? '￿');
      if (la.ord !== null || lb.ord !== null) return (la.ord ?? 1e15) - (lb.ord ?? 1e15);
      return seriesTotals.get(b)! - seriesTotals.get(a)!;
    });
  }
  const OTHER = '__other__';
  if (seriesKeys.length > MAX_SERIES) {
    const byWeight = [...seriesKeys].sort((a, b) => seriesTotals.get(b)! - seriesTotals.get(a)!);
    const keep = new Set(byWeight.slice(0, MAX_SERIES - (additive ? 1 : 0)));
    seriesKeys = seriesKeys.filter((k) => keep.has(k));
    if (additive) seriesKeys.push(OTHER);
    else truncated = true;
    cells = cells.flatMap((c) => (keep.has(c.k2) ? [c] : additive ? [{...c, k2: OTHER}] : []));
  }
  const seriesKey = (k: string | null) => (g2f ? (k === OTHER ? OTHER : (k ?? '__none__')) : 'value');
  const series = g2f ? seriesKeys.map((k) => ({key: seriesKey(k), label: k === OTHER ? 'Other' : L2!(k).label})) : [{key: 'value', label: measure.label}];

  // Rows (group-by values). Counts per row come from a per-row query only when needed (tags double-count).
  const rowMap = new Map<string | null, ReportRow & {raw: string | null}>();
  for (const c of cells) {
    let row = rowMap.get(c.k1);
    if (!row) {
      row = {raw: c.k1, key: c.k1 ?? '__none__', label: '', values: Object.fromEntries(series.map((s) => [s.key, 0])), total: 0, count: 0};
      rowMap.set(c.k1, row);
    }
    const sk = seriesKey(c.k2);
    row.values[sk] = (row.values[sk] ?? 0) + c.v;
    row.count += c.n;
  }
  // A row's total is the measure over the whole group: summed for count/sum, otherwise taken from a breakdown-free query.
  if (!additive && g2f) {
    const r = groupSql(g1f, b1, 'g1', tz);
    const w2 = whereSql(o, config, ctx, range);
    const totals = await db.$queryRaw<{k1: string | null; v: number | null; n: number}[]>(
      Prisma.sql`SELECT ${r.select} AS k1, ${measure.sql} AS v, COUNT(DISTINCT t.id)::float8 AS n FROM ${code(o.table)} t ${r.join} WHERE ${w2} GROUP BY 1 LIMIT ${MAX_CELLS}`,
    );
    for (const t of totals) {
      const row = rowMap.get(t.k1);
      if (row) {
        row.total = Number(t.v ?? 0);
        row.count = Number(t.n);
      }
    }
  } else {
    for (const row of rowMap.values()) row.total = Object.values(row.values).reduce((a, b) => a + b, 0);
  }

  const L1 = await labeller(db, g1f, [...rowMap.keys()], b1);
  let rows = [...rowMap.values()];
  for (const r of rows) r.label = L1(r.raw).label;

  if (b1) {
    // Chronological and gap-free across the date range (or the data's own span for "all time").
    const present = rows.filter((r) => r.raw).map((r) => r.raw!) as string[];
    const first = range.from ? wallKey(wallOf(tz, range.from)) : present.sort()[0];
    const last = range.to ? wallKey(wallOf(tz, range.to.getTime() - 1)) : present.sort()[present.length - 1];
    const filled = first && last ? bucketKeys(first, last, b1) : [];
    const byKey = new Map(rows.map((r) => [r.raw, r]));
    rows = filled.map(
      (k) => byKey.get(k) ?? {raw: k, key: k, label: bucketLabel(k, b1), values: Object.fromEntries(series.map((s) => [s.key, 0])), total: 0, count: 0},
    );
    const undated = byKey.get(null);
    if (undated) rows.push(undated);
  } else {
    const sortByLabel = config.sort === 'label';
    rows.sort((a, b) => {
      if (sortByLabel) return a.label.localeCompare(b.label);
      const la = L1(a.raw);
      const lb = L1(b.raw);
      if (la.ord !== null || lb.ord !== null) return (la.ord ?? 1e15) - (lb.ord ?? 1e15);
      return b.total - a.total;
    });
    if (rows.length > MAX_GROUPS) {
      const keep = [...rows].sort((a, b) => b.total - a.total).slice(0, MAX_GROUPS - (additive ? 1 : 0));
      const keepSet = new Set(keep);
      const rest = rows.filter((r) => !keepSet.has(r));
      rows = rows.filter((r) => keepSet.has(r));
      if (additive) {
        const other = {raw: OTHER, key: OTHER, label: 'Other', values: Object.fromEntries(series.map((s) => [s.key, 0])), total: 0, count: 0};
        for (const r of rest) {
          for (const s of series) other.values[s.key]! += r.values[s.key] ?? 0;
          other.total += r.total;
          other.count += r.count;
        }
        rows.push(other);
      } else truncated = true;
    }
  }

  return {
    ...base,
    bucket: b1,
    groupLabel: g1f.label,
    breakdownLabel: g2f?.label,
    series,
    rows: rows.map(({raw: _raw, ...r}) => r),
    truncated,
  };
}
