/**
 * Automation engine. Shapes and catalogues live in src/lib/automations.ts,
 * step executors in automation-steps.ts, records / conditions / merge fields
 * in automation-records.ts.
 *
 *   events      emit() → queueAutomations() (automation-hook.ts) → `automation.events`
 *               job → matchEvents(): one run per (automation, event)
 *   dates       automationTick() from the `crm-tick` schedule: records whose trigger
 *               moment fell between the last check and now (missed ticks caught up),
 *               exactly once per (automation, record, value) via the run's dedupe key
 *               and AutomationFire; a capped number per tick, advanced inline
 *   manual      runOnRecord() / runOnList() (`automation.batch`, LIST_STEP contacts a
 *               job, each run advanced inline while the job has time)
 *   runs        `automation.run` job → advanceRun(): executes steps in order, one
 *               AutomationRunStep row each; waits re-queue the job with runAt;
 *               transient errors retry the job (finished steps are skipped). Every
 *               run job is keyed `run-<id>-<point>` (at most one waiting per point
 *               of a run) and a run lease keeps two jobs off the same run
 *   dry runs    testAutomation(): same executors with `dry`, nothing written
 *   test runs   startTestRun(): a flagged run of the editor's draft (kept in
 *               `definition`) through the same job; simulations (`quick`,
 *               `timed`) run every executor with `dry`, `quick` shortens waits
 *               to QUICK_TEST_WAIT_MS; tests stay out of stats, failure
 *               streaks, re-enrollment and rate limits
 *
 * Loop protection: events written by a step carry the run's chain (depth,
 * chain id); runs they start are one deeper and stop at MAX_CHAIN_DEPTH, an
 * automation never re-triggers itself directly, and each automation runs at
 * most RUNS_PER_RECORD_PER_HOUR times per record per hour.
 */
import {Prisma, type Automation, type AutomationRun, type Event} from '../../../generated/prisma/client';
import type {JobRun} from '../kit/job-run';
import {
  branchStart,
  EVENT_TRIGGERS,
  findStep,
  INACTIVITY_RULES,
  MAX_CHAIN_DEPTH,
  MAX_STEPS_PER_RUN,
  nextAfter,
  QUICK_TEST_WAIT_MS,
  TEST_MODES,
  RUNS_PER_RECORD_PER_HOUR,
  UNIT_MS,
  type AutoObject,
  type EventFilter,
  type Step,
  type Target,
  type TestMode,
  type Trigger,
} from '@/lib/automations';
import {addDays, isTimeZone, localDate, zonedTime} from '@/lib/scheduling';
import {randomToken} from '../kit/crypto';
import type {Db} from '../kit/db';
import {withAutomation} from './automation-context';
import {evaluateConditions, fieldsFor, labelOf, loadRecords, ownerIdOf, primaryOf, type Records} from './automation-records';
import {executeStep, isPermanent, StepError, type StepCtx, type StepResult} from './automation-steps';
import {emit} from './events';
import {userScope} from './http';
import {deleteInChunks} from './chunked-delete';
import {enqueue} from './jobs';
import {notify} from './notify';
import {listContactWhere} from './segments';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Origin = {automationId: string; runId: string; chainId: string; depth: number};

const triggerOf = (a: Pick<Automation, 'trigger'>) => a.trigger as unknown as Trigger;
export const stepsOf = (a: Pick<Automation, 'steps'>) => (Array.isArray(a.steps) ? (a.steps as unknown as Step[]) : []);
const objectOf = (a: Pick<Automation, 'object'>) => a.object as AutoObject;
const tzOf = (a: Pick<Automation, 'timezone'>) => (isTimeZone(a.timezone) ? a.timezone : 'UTC');
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as Prisma.InputJsonValue;
const newChain = () => `c${randomToken(9)}`;

// ─── Starting runs ──────────────────────────────────────────────────────────

type StartInput = {
  recordId: string | null;
  source: 'event' | 'date' | 'inactivity' | 'manual' | 'list';
  eventType?: string | null;
  dedupeKey?: string | null;
  context?: unknown;
  origin?: Origin | null;
  startedById?: string | null;
  /** Records already loaded by the caller. */
  records?: Records;
  /** Single manual runs skip the re-enrollment and rate limits (someone asked for it). */
  explicit?: boolean;
  /** The caller advances the run itself (`advanceInline`): no job is queued for it. */
  inline?: boolean;
};

export type StartResult = {run: AutomationRun | null; reason?: string};

/** A run that never started, kept so the history explains why (chain limit, rate limit). */
async function skippedRun(db: Db, a: Automation, input: StartInput, records: Records, depth: number, reason: string) {
  const primary = primaryOf(objectOf(a), records);
  return db.automationRun
    .create({
      data: {
        automationId: a.id,
        object: a.object,
        recordId: input.recordId,
        recordLabel: primary ? labelOf(objectOf(a), primary) : null,
        ownerId: primary ? ownerIdOf(objectOf(a), primary) : null,
        status: 'skipped',
        source: input.source,
        eventType: input.eventType ?? null,
        dedupeKey: input.dedupeKey ?? null,
        chainId: input.origin?.chainId ?? newChain(),
        depth,
        context: json(input.context),
        error: reason,
        startedById: input.startedById ?? null,
        finishedAt: new Date(),
      },
    })
    .catch(() => null);
}

/**
 * Starts a run if the automation is on and in its active window, the record
 * matches the trigger conditions, and re-enrollment, rate and chain limits
 * allow it. Idempotent per `dedupeKey`.
 */
export async function startRun(db: Db, a: Automation, input: StartInput): Promise<StartResult> {
  const now = new Date();
  if (!a.enabled) return {run: null, reason: 'The automation is off'};
  if ((a.activeFrom && now < a.activeFrom) || (a.activeUntil && now > a.activeUntil)) return {run: null, reason: 'Outside the automation\'s active dates'};
  if (input.origin?.automationId === a.id) return {run: null, reason: 'An automation never triggers itself'};
  if (input.dedupeKey) {
    const existing = await db.automationRun.findUnique({where: {dedupeKey: input.dedupeKey}, select: {id: true, status: true}});
    if (existing) {
      // A retried job may find the run it created before failing: make sure it has its job.
      await ensureJob(db, existing);
      return {run: null, reason: 'Already started'};
    }
  }

  const object = objectOf(a);
  const records = input.records ?? (await loadRecords(db, object, input.recordId, (input.context as {data?: Record<string, unknown>} | null)?.data ?? null));
  if (object !== 'none' && records.missing && !input.eventType?.endsWith('.deleted')) return {run: null, reason: 'The record no longer exists'};
  const depth = input.origin ? input.origin.depth + 1 : 0;
  if (depth > MAX_CHAIN_DEPTH) {
    await skippedRun(db, a, input, records, depth, `Stopped: automations triggered each other ${MAX_CHAIN_DEPTH} times in a row`);
    return {run: null, reason: 'Chain limit reached'};
  }

  if (input.recordId && !input.explicit) {
    if (a.reenroll === 'never' || (a.reenroll === 'after' && a.reenrollDays)) {
      const since = a.reenroll === 'after' ? new Date(now.getTime() - (a.reenrollDays ?? 0) * DAY) : undefined;
      const before = await db.automationRun.findFirst({where: {automationId: a.id, recordId: input.recordId, status: {not: 'skipped'}, test: null, ...(since ? {startedAt: {gte: since}} : {})}, select: {id: true}});
      if (before) return {run: null, reason: a.reenroll === 'never' ? 'Already ran for this record (re-enrollment is off)' : `Already ran for this record in the last ${a.reenrollDays} days`};
    }
  }

  const conditions = await evaluateConditions(db, triggerOf(a).conditions, records);
  if (!conditions.ok) return {run: null, reason: 'The record doesn\'t match the trigger conditions'};

  if (input.recordId && !input.explicit) {
    const hourAgo = new Date(now.getTime() - HOUR);
    const recent = await db.automationRun.count({where: {automationId: a.id, recordId: input.recordId, startedAt: {gte: hourAgo}, status: {not: 'skipped'}, test: null}});
    if (recent >= RUNS_PER_RECORD_PER_HOUR) {
      const noted = await db.automationRun.findFirst({where: {automationId: a.id, recordId: input.recordId, status: 'skipped', startedAt: {gte: hourAgo}, error: {startsWith: 'Rate limit'}}, select: {id: true}});
      if (!noted) await skippedRun(db, a, input, records, depth, `Rate limit: ${RUNS_PER_RECORD_PER_HOUR} runs for this record in the last hour`);
      return {run: null, reason: 'Rate limit reached'};
    }
  }

  const primary = primaryOf(object, records);
  const steps = stepsOf(a);
  let run: AutomationRun;
  try {
    run = await db.automationRun.create({
      data: {
        automationId: a.id,
        object: a.object,
        recordId: input.recordId,
        recordLabel: primary ? labelOf(object, primary) : null,
        ownerId: primary ? ownerIdOf(object, primary) : null,
        status: 'running',
        source: input.source,
        eventType: input.eventType ?? null,
        dedupeKey: input.dedupeKey ?? null,
        chainId: input.origin?.chainId ?? newChain(),
        depth,
        context: json(input.context),
        cursor: steps[0]?.id ?? null,
        startedById: input.startedById ?? null,
      },
    });
  } catch {
    return {run: null, reason: 'Already started'}; // dedupeKey taken by a concurrent attempt
  }
  if (!input.inline) await queueRun(db, run.id, 'start');
  await db.automation.update({where: {id: a.id}, data: {lastRunAt: now}}).catch(() => null);
  return {run};
}

/**
 * Queues the `automation.run` job of a run at one point of its progress (`start`, a wait's time,
 * the step it goes on from…). The key is `run-<id>-<point>`: one job waits per point, and a
 * second queueing of the same point (a retried job, a rescue) is the platform's dedupe, not a
 * second run. A run's key is never reused for a later point (the platform keeps keys 24 h).
 */
export function queueRun(db: Db, runId: string, point: string, runAt?: Date) {
  return enqueue(db, 'automation.run', {runId}, {key: `run-${runId}-${point}`.slice(0, 120), ...(runAt ? {runAt} : {})});
}

/** Queues the job of a running run that has none (its job was lost to an error between the two writes). */
async function ensureJob(db: Db, run: {id: string; status: string}) {
  if (run.status !== 'running') return;
  // The start job's own key: when that job still waits (or ran), this is a no-op; a stalled run is rescueRuns()'.
  await queueRun(db, run.id, 'start');
}

/** A run with no progress for this long is rescued; one whose job is retrying waits out the platform's backoff (1, 2, 10, 60 min). */
const STALLED_MS = 5 * 60_000;
const RETRYING_STALLED_MS = 90 * 60_000;

/**
 * Safety net from the `crm-tick` schedule: runs left without a job are queued again. "Stalled" is
 * measured from the run's last progress (its newest step, else its start), never its start alone:
 * a long run that keeps moving is left alone. Runs whose job still waits here for the job rate are
 * skipped. Finished steps are never repeated and the run lease keeps two jobs apart, so a rescue is
 * always safe; its key is one per run per progress point per hour.
 */
async function rescueRuns(db: Db) {
  // Cut-offs are bound from here: the columns hold UTC wall times, and now() would follow the database's zone.
  const now = Date.now();
  const stalled = new Date(now - STALLED_MS);
  const retrying = new Date(now - RETRYING_STALLED_MS);
  const stuck = await db.$queryRaw<{id: string; progress: Date}[]>`
    SELECT r.id, COALESCE(p.at, r."startedAt") AS progress FROM "AutomationRun" r
    LEFT JOIN LATERAL (
      SELECT max(GREATEST(s."startedAt", COALESCE(s."finishedAt", s."startedAt"))) AS at FROM "AutomationRunStep" s WHERE s."runId" = r.id
    ) p ON true
    WHERE (
      (r.status = 'running' AND COALESCE(p.at, r."startedAt") < CASE WHEN r.error LIKE 'Retrying:%' THEN ${retrying}::timestamp ELSE ${stalled}::timestamp END)
      OR (r.status = 'waiting' AND r."waitUntil" < ${stalled}::timestamp)
    )
    AND NOT EXISTS (SELECT 1 FROM "JobBacklog" b WHERE b.list = 'crm-automation-run' AND b."failedAt" IS NULL AND b.data ->> 'runId' = r.id)
    ORDER BY progress
    LIMIT 50`;
  const hour = Math.floor(now / 3_600_000);
  for (const r of stuck) await queueRun(db, r.id, `p${new Date(r.progress).getTime()}-${hour}`);
  return stuck.length;
}

// ─── Event triggers ─────────────────────────────────────────────────────────

type EventData = Record<string, unknown> & {
  changes?: {field: string}[];
  form?: {id?: string};
  list?: {id?: string};
  deal?: {id?: string; pipelineId?: string};
  ticket?: Record<string, unknown>;
  message?: {direction?: string};
  from?: {id?: string} | string;
  to?: {id?: string} | string;
  newBand?: {key?: string};
  link?: {id?: string};
};

/** The record an event is about, for an automation of `object`. */
async function subjectId(db: Db, event: Event, object: AutoObject): Promise<string | null> {
  if (object === 'none') return null;
  const d = (event.data ?? {}) as EventData;
  const entity = event.type.split('.')[0];
  if (event.type.endsWith('.merged')) return String(d.keptId ?? event.recordId ?? '') || null;
  if (entity === object) return event.recordId;
  const key = `${object}Id`;
  const direct = (d[key] ?? d.ticket?.[key] ?? (object === 'deal' ? d.deal?.id : null)) as string | null | undefined;
  if (direct) return direct;
  // Meetings, emails, forms: the contact's latest open deal.
  const contactId = (d.contactId ?? d.ticket?.contactId) as string | undefined;
  if (object === 'deal' && contactId) {
    const deal = await db.deal.findFirst({where: {status: 'OPEN', contacts: {some: {contactId}}}, orderBy: {lastActivityAt: 'desc'}, select: {id: true}});
    return deal?.id ?? null;
  }
  return null;
}

const idOf = (v: unknown) => (typeof v === 'string' ? v : (v as {id?: string} | null | undefined)?.id);

/** Event-specific trigger filters ("this form", "moved to stage X", "field Y changed"…). */
export function filterMatches(filter: EventFilter | undefined, event: Pick<Event, 'type' | 'data'>) {
  if (!filter) return true;
  const d = (event.data ?? {}) as EventData;
  if (filter.field && !(d.changes ?? []).some((c) => c.field === filter.field)) return false;
  if (filter.formId && d.form?.id !== filter.formId) return false;
  if (filter.listId && d.list?.id !== filter.listId) return false;
  if (filter.pipelineId && (d.pipelineId ?? d.deal?.pipelineId) !== filter.pipelineId) return false;
  if (filter.stageId && idOf(d.to) !== filter.stageId) return false;
  if (filter.fromStageId && idOf(d.from) !== filter.fromStageId) return false;
  if (filter.status && d.to !== filter.status) return false;
  if (filter.direction && d.message?.direction !== filter.direction) return false;
  if (filter.band && d.newBand?.key !== filter.band) return false;
  if (filter.bandDirection && d.direction !== filter.bandDirection) return false;
  if (filter.linkId && d.link?.id !== filter.linkId) return false;
  if (filter.kind && d.kind !== filter.kind) return false;
  if (filter.webhookId && d.webhookId !== filter.webhookId) return false;
  if (filter.dataInEvent && String(d.event ?? '').toLowerCase() !== filter.dataInEvent.trim().toLowerCase()) return false;
  return true;
}

/**
 * `automation.events` job: starts one run per (automation, event) that matches, and advances each
 * here while the job has time (a run costs a job of its own only when it waits or time is up).
 * Safe to run twice.
 */
export async function matchEvents(db: Db, eventIds: string[], origin: Origin | null, until = Date.now() + 40_000) {
  const events = await db.event.findMany({where: {id: {in: eventIds}}, orderBy: {createdAt: 'asc'}});
  if (!events.length) return;
  const autos = await db.automation.findMany({where: {enabled: true, triggerKind: 'event', triggerEvent: {in: [...new Set(events.map((e) => e.type))]}}});
  for (const event of events) {
    for (const a of autos.filter((x) => x.triggerEvent === event.type)) {
      const t = triggerOf(a);
      if (t.kind !== 'event' || !EVENT_TRIGGERS[event.type]?.objects.includes(objectOf(a))) continue;
      if (!filterMatches(t.filter, event)) continue;
      const recordId = await subjectId(db, event, objectOf(a));
      if (objectOf(a) !== 'none' && !recordId) continue;
      const {run} = await startRun(db, a, {
        recordId,
        source: 'event',
        eventType: event.type,
        dedupeKey: `${a.id}:${event.id}`,
        context: {eventId: event.id, type: event.type, data: event.data},
        origin,
        inline: true,
      });
      if (run) await advanceInline(db, run.id, until);
    }
  }
}

// ─── Date and inactivity triggers ───────────────────────────────────────────

type Candidate = {recordId: string; value: string; moment: number; context: Record<string, unknown>};

const TABLES: Record<Target, string> = {contact: '"Contact"', company: '"Company"', deal: '"Deal"', ticket: '"Ticket"'};
const OWNER_COLUMN: Record<Target, string> = {contact: '"ownerId"', company: '"ownerId"', deal: '"ownerId"', ticket: '"assigneeId"'};

/** When a date trigger fires for a date value (ms of a timestamp, or a YYYY-MM-DD calendar date). */
function triggerMoment(t: Extract<Trigger, {kind: 'date'}>, value: Date | string, dateOnly: boolean, tz: string) {
  const sign = t.direction === 'before' ? -1 : 1;
  const dayUnits = t.unit === 'days' || t.unit === 'weeks';
  const ms = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value).getTime() : value.getTime();
  const day = dateOnly ? new Date(ms).toISOString().slice(0, 10) : localDate(ms, tz);
  if (dayUnits && (t.time || dateOnly)) {
    const days = t.amount * (t.unit === 'weeks' ? 7 : 1);
    return zonedTime(addDays(day, sign * days), t.time || '09:00', tz);
  }
  const base = dateOnly ? zonedTime(day, t.time || '00:00', tz) : ms;
  return base + sign * t.amount * UNIT_MS[t.unit];
}

async function ownerZones(db: Db, ownerIds: (string | null)[]) {
  const ids = [...new Set(ownerIds.filter((x): x is string => !!x))];
  const rows = ids.length ? await db.schedulingProfile.findMany({where: {userId: {in: ids}}, select: {userId: true, timezone: true}}) : [];
  return new Map(rows.filter((r) => isTimeZone(r.timezone)).map((r) => [r.userId, r.timezone]));
}

/** Rows one page of a trigger scan reads. */
const LIMIT = 500;
/** Pages one tick reads per automation at most (the rest waits for the next tick). */
const MAX_PAGES = 20;

/** What a scan found, and the moment up to which every due record is in it (the safe cursor). */
type Scan = {found: Candidate[]; safeUntil: number};
type Key = {v: Date | string; id: string};

const valueMs = (v: Date | string) => (typeof v === 'string' ? new Date(v.length === 10 ? `${v}T00:00:00Z` : v).getTime() : v.getTime());

/**
 * Reads rows in (value, id) order from the start of the window, each page right after the last row
 * of the page before (keyset: a burst of rows sharing one value is never cut off), until a short
 * page says there is no more, MAX_PAGES, or the time is up. Keeps the rows whose trigger moment is
 * in (from, to]. Stopped early: `safeUntil` is the earliest moment a row not read yet can have.
 */
async function scanPages<R>(
  read: (after: Key | null) => Promise<R[]>,
  keyOf: (r: R) => Key,
  toCandidates: (rows: R[]) => Promise<Candidate[]> | Candidate[],
  earliestAfter: (v: Date | string) => number,
  from: Date,
  to: Date,
  stopAt: number,
): Promise<Scan> {
  const found: Candidate[] = [];
  let after: Key | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await read(after);
    for (const c of await toCandidates(rows)) if (c.moment > from.getTime() && c.moment <= to.getTime()) found.push(c);
    // "More to come" from the rows read, not from the ones kept.
    if (rows.length < LIMIT) return {found, safeUntil: to.getTime()};
    after = keyOf(rows.at(-1)!);
    if (Date.now() > stopAt) break;
  }
  return {found, safeUntil: earliestAfter(after!.v)};
}

async function dateCandidates(db: Db, a: Automation, t: Extract<Trigger, {kind: 'date'}>, from: Date, to: Date, stopAt: number): Promise<Scan> {
  const none: Scan = {found: [], safeUntil: to.getTime()};
  const object = objectOf(a);
  if (object === 'none') return none;
  if (t.source === 'booking' && object !== 'contact') return none;
  const field = t.source === 'booking' ? null : (await fieldsFor(db, object)).find((f) => f.key === t.field && f.kind === 'date');
  if (t.source !== 'booking' && !field) return none;
  const dateOnly = !!field?.dateOnly;
  const sign = t.direction === 'before' ? -1 : 1;
  const offset = t.amount * UNIT_MS[t.unit];
  // The value lies at (moment - offset); when a time of day or a time zone moves the moment, two
  // days either side cover it.
  const margin = ((t.unit === 'days' || t.unit === 'weeks') && t.time) || dateOnly ? 2 * DAY : 0;
  const lo = new Date(from.getTime() - sign * offset - margin);
  const hi = new Date(to.getTime() - sign * offset + margin);
  // Rows at or after a value fire no earlier than this (the same value may still hold unread rows).
  const earliestAfter = (v: Date | string) => valueMs(v) + sign * offset - (margin || 1);
  const tz = tzOf(a);
  if (t.source === 'booking') {
    return scanPages(
      (after) =>
        db.booking.findMany({
          where: {status: 'CONFIRMED', contactId: {not: null}, startAt: {gte: lo, lte: hi}, ...(after ? {OR: [{startAt: {gt: after.v as Date}}, {startAt: after.v as Date, id: {gt: after.id}}]} : {})},
          orderBy: [{startAt: 'asc'}, {id: 'asc'}],
          take: LIMIT,
          select: {id: true, contactId: true, startAt: true, title: true},
        }),
      (b) => ({v: b.startAt, id: b.id}),
      (rows) => rows.map((b) => ({recordId: b.contactId!, value: `${b.id}@${b.startAt.toISOString()}`, moment: triggerMoment(t, b.startAt, false, tz), context: {bookingId: b.id, startAt: b.startAt.toISOString(), title: b.title}})),
      earliestAfter,
      from,
      to,
      stopAt,
    );
  }
  const key = field!.key;
  // Table and owner column from fixed maps; values bound as parameters.
  const table = Prisma.raw(TABLES[object]);
  const owner = Prisma.raw(OWNER_COLUMN[object]);
  type Row = {id: string; value: Date | string; ownerId: string | null};
  let read: (after: Key | null) => Promise<Row[]>;
  if (key.startsWith('custom.')) {
    // Custom dates are stored as "YYYY-MM-DD" strings, which compare in order.
    const value = Prisma.sql`custom->>${key.slice(7)}::text`;
    read = (after) =>
      db.$queryRaw<Row[]>(
        Prisma.sql`SELECT id, ${value} AS value, ${owner} AS "ownerId" FROM ${table} WHERE ${value} >= ${lo.toISOString().slice(0, 10)} AND ${value} <= ${hi.toISOString().slice(0, 10)} ${after ? Prisma.sql`AND (${value}, id) > (${after.v as string}::text, ${after.id}::text)` : Prisma.empty} ORDER BY ${value}, id LIMIT ${LIMIT}`,
      );
  } else {
    // A built-in date field: its key is the column's name (the field list is written in code).
    if (!/^[a-zA-Z]+$/.test(key)) return none;
    const column = Prisma.raw(`"${key}"`);
    read = (after) =>
      db.$queryRaw<Row[]>(
        Prisma.sql`SELECT id, ${column} AS value, ${owner} AS "ownerId" FROM ${table} WHERE ${column} >= ${lo} AND ${column} <= ${hi} ${after ? Prisma.sql`AND (${column}, id) > (${after.v}, ${after.id}::text)` : Prisma.empty} ORDER BY ${column}, id LIMIT ${LIMIT}`,
      );
  }
  const toCandidates = async (rows: Row[]) => {
    const dated = rows.filter((r) => typeof r.value !== 'string' || /^\d{4}-\d{2}-\d{2}/.test(r.value));
    const zones = t.zone === 'owner' ? await ownerZones(db, dated.map((r) => r.ownerId)) : new Map<string, string>();
    return dated.map((r) => {
      const value = typeof r.value === 'string' ? r.value.slice(0, 10) : dateOnly ? r.value.toISOString().slice(0, 10) : r.value.toISOString();
      const zone = (r.ownerId && zones.get(r.ownerId)) || tz;
      return {recordId: r.id, value, moment: triggerMoment(t, r.value, dateOnly, zone), context: {field: key, value}};
    });
  };
  return scanPages(read, (r) => ({v: r.value, id: r.id}), toCandidates, earliestAfter, from, to, stopAt);
}

async function inactivityCandidates(db: Db, a: Automation, t: Extract<Trigger, {kind: 'inactivity'}>, from: Date, to: Date, stopAt: number): Promise<Scan> {
  const object = objectOf(a);
  const span = t.amount * (t.unit === 'hours' ? HOUR : DAY);
  // "Inactive for N" fires when (since + N) falls in (from, to], i.e. since in (from - N, to - N].
  const lo = new Date(from.getTime() - span);
  const hi = new Date(to.getTime() - span);
  const at = (since: Date) => since.getTime() + span;
  const earliestAfter = (v: Date | string) => valueMs(v) + span - 1;
  const scan = <R>(read: (after: Key | null) => Promise<R[]>, keyOf: (r: R) => Key, toCandidates: (rows: R[]) => Candidate[]) => scanPages(read, keyOf, toCandidates, earliestAfter, from, to, stopAt);
  if (t.rule === 'no_activity' && (object === 'contact' || object === 'company' || object === 'deal')) {
    return scan(
      (after) =>
        db.$queryRaw<{id: string; since: Date}[]>(
          Prisma.sql`SELECT id, "lastActivityAt" AS since FROM ${Prisma.raw(TABLES[object])} WHERE "lastActivityAt" > ${lo} AND "lastActivityAt" <= ${hi} ${after ? Prisma.sql`AND ("lastActivityAt", id) > (${after.v}, ${after.id}::text)` : Prisma.empty} ORDER BY "lastActivityAt", id LIMIT ${LIMIT}`,
        ),
      (r) => ({v: r.since, id: r.id}),
      (rows) => rows.map((r) => ({recordId: r.id, value: r.since.toISOString(), moment: at(r.since), context: {lastActivityAt: r.since.toISOString()}})),
    );
  }
  if (t.rule === 'ticket_waiting' && object === 'ticket') {
    // Waiting since the last move to "waiting on us" (or since it was opened, for new tickets).
    return scan(
      (after) => db.$queryRaw<{id: string; since: Date}[]>`
        SELECT t.id, s.since FROM "Ticket" t
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT max(m."createdAt") FROM "TicketMessage" m WHERE m."ticketId" = t.id AND m.kind = 'event' AND m.data->>'type' = 'status' AND m.data->>'to' = 'WAITING_ON_US'), t."createdAt") AS since
        ) s
        WHERE t.status IN ('NEW', 'WAITING_ON_US') AND s.since > ${lo} AND s.since <= ${hi} ${after ? Prisma.sql`AND (s.since, t.id) > (${after.v}, ${after.id}::text)` : Prisma.empty}
        ORDER BY s.since, t.id LIMIT ${LIMIT}`,
      (r) => ({v: r.since, id: r.id}),
      (rows) => rows.map((r) => ({recordId: r.id, value: r.since.toISOString(), moment: at(r.since), context: {waitingSince: r.since.toISOString()}})),
    );
  }
  if (t.rule === 'task_overdue' && (object === 'contact' || object === 'company' || object === 'deal')) {
    const key = `${object}Id` as 'contactId' | 'companyId' | 'dealId';
    return scan(
      (after) =>
        db.task.findMany({
          where: {done: false, dueAt: {gt: lo, lte: hi}, [key]: {not: null}, ...(after ? {OR: [{dueAt: {gt: after.v as Date}}, {dueAt: after.v as Date, id: {gt: after.id}}]} : {})},
          orderBy: [{dueAt: 'asc'}, {id: 'asc'}],
          take: LIMIT,
          select: {id: true, title: true, dueAt: true, assigneeId: true, contactId: true, companyId: true, dealId: true},
        }),
      (task) => ({v: task.dueAt!, id: task.id}),
      (tasks) => tasks.map((task) => ({recordId: task[key]!, value: `${task.id}@${task.dueAt!.toISOString()}`, moment: at(task.dueAt!), context: {task: {id: task.id, title: task.title, dueAt: task.dueAt!.toISOString(), assigneeId: task.assigneeId}}})),
    );
  }
  if (t.rule === 'in_list' && object === 'contact' && t.listId) {
    const listId = t.listId;
    return scan(
      (after) =>
        db.contactListMember.findMany({
          where: {listId, createdAt: {gt: lo, lte: hi}, ...(after ? {OR: [{createdAt: {gt: after.v as Date}}, {createdAt: after.v as Date, contactId: {gt: after.id}}]} : {})},
          orderBy: [{createdAt: 'asc'}, {contactId: 'asc'}],
          take: LIMIT,
          select: {contactId: true, createdAt: true},
        }),
      (m) => ({v: m.createdAt, id: m.contactId}),
      (members) => members.map((m) => ({recordId: m.contactId, value: m.createdAt.toISOString(), moment: at(m.createdAt), context: {listId, addedAt: m.createdAt.toISOString()}})),
    );
  }
  return {found: [], safeUntil: to.getTime()};
}

/** How far back a tick looks when the scheduler was down (or the automation was just switched on). */
const MAX_CATCH_UP = 30 * DAY;
/** Runs one tick starts at most (each may need a job: the platform takes only so many a minute). */
const FIRES_PER_TICK = 50;

/**
 * Starts a run the caller advances itself while it has time (`until`), saving the job a run
 * would cost. Out of time, or a step that must be retried later: the run gets its job.
 */
async function advanceInline(db: Db, runId: string, until: number) {
  if (Date.now() >= until) return queueRun(db, runId, 'start');
  try {
    // Not the last try: a transient error throws here instead of failing the run.
    await advanceRun(db, runId, {attempts: 1, maxAttempts: 2});
  } catch (e) {
    console.warn('[automations] run', runId, String((e as Error)?.message ?? e).slice(0, 200));
    await queueRun(db, runId, 'inline');
  }
}

/**
 * Date and inactivity triggers, from the `crm-tick` schedule. For each automation: the records
 * whose trigger moment is in (last check, now] start one run each. The run's dedupe key makes it
 * exactly-once even when ticks overlap or one stops midway, and AutomationFire (written after the
 * run exists) remembers it was handled. Candidates are read in keyset pages (value, id), so a burst
 * of records sharing one timestamp is read whole. The time budget is checked for every record, at
 * most FIRES_PER_TICK runs start per tick, and the cursor is saved just before the first moment not
 * handled (never past what the scan read), so the next tick goes on from there.
 */
export async function automationTick(db: Db, opts: {budgetMs?: number; until?: number; cap?: number} = {}) {
  const until = opts.until ?? Date.now() + (opts.budgetMs ?? 8_000);
  const cap = opts.cap ?? FIRES_PER_TICK;
  const autos = await db.automation.findMany({where: {enabled: true, triggerKind: {in: ['date', 'inactivity']}}, orderBy: {cursorAt: {sort: 'asc', nulls: 'first'}}});
  let fired = 0;
  let checked = 0;
  // Half the time for starting runs, the rest for advancing them inline.
  const startUntil = Date.now() + (until - Date.now()) / 2;
  for (const a of autos) {
    if (Date.now() > startUntil || fired >= cap) break;
    const now = new Date();
    const fromMs = Math.max((a.cursorAt ?? a.enabledAt ?? now).getTime(), now.getTime() - MAX_CATCH_UP);
    if (fromMs >= now.getTime()) continue;
    const from = new Date(fromMs);
    const t = triggerOf(a);
    let scan: Scan = {found: [], safeUntil: now.getTime()};
    try {
      if (t.kind === 'date') scan = await dateCandidates(db, a, t, from, now, startUntil);
      else if (t.kind === 'inactivity' && INACTIVITY_RULES[t.rule]) scan = await inactivityCandidates(db, a, t, from, now, startUntil);
    } catch (e) {
      console.error('[automations] tick', a.id, String((e as Error)?.message ?? e).slice(0, 200));
      continue;
    }
    // In moment order; records of one moment in a fixed order.
    const found = scan.found.sort((x, y) => x.moment - y.moment || (x.recordId < y.recordId ? -1 : x.recordId > y.recordId ? 1 : 0));
    checked++;
    // Never past what the scan fully read (a scan that stopped early leaves rows for the next tick).
    let cursor = Math.min(now.getTime(), scan.safeUntil);
    let stopped = false;
    const source = t.kind === 'date' ? 'date' : 'inactivity';
    for (let i = 0; i < found.length && !stopped; i += LIMIT) {
      const chunk = found.slice(i, i + LIMIT);
      // Handled before (an earlier tick that stopped midway, or records of the same moment): one query a chunk.
      const done = new Set((await db.automationFire.findMany({where: {automationId: a.id, recordId: {in: [...new Set(chunk.map((c) => c.recordId))]}}, select: {recordId: true, value: true}})).map((f) => `${f.recordId}|${f.value}`));
      for (const c of chunk) {
        if (Date.now() > startUntil || fired >= cap) {
          // Stopped midway: the next tick starts just before this moment (records of the same moment are not skipped).
          cursor = Math.min(cursor, c.moment - 1);
          stopped = true;
          break;
        }
        if (done.has(`${c.recordId}|${c.value}`)) continue;
        const {run} = await startRun(db, a, {recordId: c.recordId, source, dedupeKey: `${a.id}:fire:${c.recordId}:${c.value}`, context: {...c.context, moment: new Date(c.moment).toISOString()}, inline: true});
        // Only now: a tick that dies before this line leaves no mark, and the dedupe key stops a second run.
        await db.automationFire.createMany({data: [{automationId: a.id, recordId: c.recordId, value: c.value}], skipDuplicates: true});
        if (run) {
          fired++;
          await advanceInline(db, run.id, until);
        }
      }
    }
    cursor = Math.max(fromMs, cursor);
    await db.automation.update({where: {id: a.id}, data: {cursorAt: new Date(cursor)}});
  }
  const rescued = await rescueRuns(db).catch((e) => {
    console.error('[automations] rescue', String((e as Error)?.message || (e as {code?: string})?.code || e).slice(0, 200));
    return 0;
  });
  return {automations: checked, fired, rescued};
}

// ─── Manual runs ────────────────────────────────────────────────────────────

export async function runOnRecord(db: Db, a: Automation, recordId: string, userId: string) {
  return startRun(db, a, {recordId, source: 'manual', dedupeKey: null, context: {by: userId}, startedById: userId, explicit: true});
}

/** Contacts one `automation.batch` job starts runs for (each advanced inline while the job has time). */
const LIST_STEP = 10;

/** Queues "run on a list / segment": contacts the user can see, LIST_STEP per job. */
export async function runOnList(db: Db, a: Automation, listId: string, userId: string) {
  const batchId = randomToken(6);
  await enqueue(db, 'automation.batch', {automationId: a.id, listId, userId, batchId, after: null}, {key: `auto-list-${batchId}-start`});
  return batchId;
}

/**
 * One step of "run on a list": up to LIST_STEP contacts after the cursor, each run advanced here
 * while the job has time (runs that wait, or are out of time, get their own job), then the next
 * step with the cursor. Stops when the automation is off or the member who started it is gone.
 */
export async function runBatch(db: Db, p: Record<string, unknown>, until = Date.now() + 40_000) {
  const a = await db.automation.findUnique({where: {id: String(p.automationId)}});
  const user = await db.member.findUnique({where: {id: String(p.userId)}, select: {id: true, role: true, active: true}});
  if (!a || !a.enabled || !user?.active) return;
  const after = typeof p.after === 'string' ? p.after : null;
  const where = {AND: [await listContactWhere(db, String(p.listId)), ...(after ? [{id: {gt: after}}] : [])], ...(await userScope(db, user))};
  const contacts = await db.contact.findMany({where, orderBy: {id: 'asc'}, take: LIST_STEP, select: {id: true}});
  for (const c of contacts) {
    const {run} = await startRun(db, a, {recordId: c.id, source: 'list', dedupeKey: `${a.id}:list:${p.batchId}:${c.id}`, context: {listId: p.listId, by: user.id}, startedById: user.id, inline: true});
    if (run) await advanceInline(db, run.id, until);
  }
  if (contacts.length === LIST_STEP) {
    const next = contacts.at(-1)!.id;
    await enqueue(db, 'automation.batch', {...(p as Prisma.InputJsonObject), after: next}, {key: `auto-list-${p.batchId}-${next}`});
  }
}

// ─── Executing runs ─────────────────────────────────────────────────────────

/** Steps per job before the run hands over to a fresh job (keeps each job short). */
const STEPS_PER_JOB = 25;

async function finish(db: Db, run: AutomationRun, status: 'done' | 'failed' | 'canceled', error: string | null = null) {
  await db.automationRun.update({where: {id: run.id}, data: {status, error, finishedAt: new Date(), cursor: null, waitUntil: null}});
  if (run.test) return; // tests never touch the failure streak, events or notifications
  if (status === 'done') await db.automation.update({where: {id: run.automationId}, data: {failureStreak: 0}});
  if (status !== 'failed') return;
  const a = await db.automation.update({where: {id: run.automationId}, data: {failureStreak: {increment: 1}}});
  await emit(db, 'automation.run_failed', {
    entity: 'automation',
    recordId: a.id,
    data: {automation: {id: a.id, name: a.name}, run: {id: run.id, object: run.object, recordId: run.recordId, record: run.recordLabel, source: run.source, error}},
  });
  // The creator hears about repeated failures (3 in a row, then every 25).
  if (a.createdById && (a.failureStreak === 3 || a.failureStreak % 25 === 0)) {
    await notify(db, [a.createdById], {type: 'automation', title: `Automation "${a.name}" failed ${a.failureStreak} times in a row`, body: error, link: `/automations/${a.id}?tab=runs`});
  }
}

// ─── Run lease ──────────────────────────────────────────────────────────────

/**
 * One job at a time per run. A lease row in Settings (`lock:run:<id>`), taken with one
 * INSERT … ON CONFLICT and renewed while the run goes on: a transaction-scoped advisory lock would
 * be let go the moment its statement commits (each query is its own transaction over the Site
 * Database's HTTP driver), and a session lock needs a connection the run does not keep. A lease
 * left by a run that died ends after LEASE_MS (a job has 60 s).
 */
const LEASE_MS = 70_000;
const RENEW_AFTER_MS = 20_000;
const LEASE_PREFIX = 'lock:run:';

async function takeLease(db: Db, runId: string) {
  const now = new Date();
  const rows = await db.$queryRaw<{key: string}[]>`
    INSERT INTO "Setting" (key, value, "updatedAt") VALUES (${LEASE_PREFIX + runId}, '{}'::jsonb, ${now})
    ON CONFLICT (key) DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt" WHERE "Setting"."updatedAt" < ${new Date(now.getTime() - LEASE_MS)}
    RETURNING key`;
  return rows.length > 0;
}

const renewLease = (db: Db, runId: string) => db.$executeRaw`UPDATE "Setting" SET "updatedAt" = ${new Date()} WHERE key = ${LEASE_PREFIX + runId}`;
const releaseLease = (db: Db, runId: string) => db.$executeRaw`DELETE FROM "Setting" WHERE key = ${LEASE_PREFIX + runId}`;

/** A job that wakes a wait this much early goes on (the platform keeps job times to the minute). */
const EARLY_OK_MS = 60_000;

/**
 * `automation.run` job: executes the run from its cursor. Finished steps are
 * never repeated (their rows say so); a transient error re-throws so the job
 * runner retries with backoff, a permanent one (or the last attempt) fails the run.
 * Another job already running this run: this one has nothing to do.
 */
export async function advanceRun(db: Db, runId: string, job: Pick<JobRun, 'attempts' | 'maxAttempts'>) {
  if (!(await takeLease(db, runId))) return;
  try {
    await advance(db, runId, job);
  } finally {
    await releaseLease(db, runId).catch(() => 0);
  }
}

async function advance(db: Db, runId: string, job: Pick<JobRun, 'attempts' | 'maxAttempts'>) {
  let run = await db.automationRun.findUnique({where: {id: runId}});
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
  const saved = await db.automation.findUnique({where: {id: run.automationId}});
  if (!saved) return;
  const a = definitionOf(saved, run);
  const dry = !!run.test && !!TEST_MODES[run.test as TestMode]?.dry;
  if (run.status === 'waiting') {
    // Woken early (a duplicate job): sleep again until it's time, under the wait's own key.
    if (run.waitUntil && run.waitUntil.getTime() > Date.now() + EARLY_OK_MS) {
      await queueRun(db, runId, `w${run.waitUntil.getTime()}`, run.waitUntil);
      return;
    }
    if (!a.enabled && !run.test) return finish(db, run, 'canceled', 'The automation was turned off while this run was waiting');
    run = await db.automationRun.update({where: {id: run.id}, data: {status: 'running', waitUntil: null}});
  }

  const steps = stepsOf(a);
  const object = objectOf(a);
  const tagged = withAutomation(db, {automationId: a.id, name: a.name, runId: run.id, chainId: run.chainId, depth: run.depth});
  const context = run.context as {data?: Record<string, unknown>} | null;
  let cursor = run.cursor;
  let count = 0;
  let renewed = Date.now();
  while (cursor) {
    if (++count > STEPS_PER_JOB) {
      await queueRun(db, run.id, `c${cursor}`);
      return;
    }
    if (Date.now() - renewed > RENEW_AFTER_MS) {
      await renewLease(db, run.id);
      renewed = Date.now();
    }
    const step = findStep(steps, cursor);
    if (!step) return finish(db, run, 'canceled', 'The automation was edited and this step no longer exists');
    if ((await db.automationRunStep.count({where: {runId: run.id}})) >= MAX_STEPS_PER_RUN) return finish(db, run, 'failed', `Stopped after ${MAX_STEPS_PER_RUN} steps`);

    const prev = await db.automationRunStep.findUnique({where: {runId_stepId: {runId: run.id, stepId: step.id}}});
    if (prev && (prev.status === 'done' || prev.status === 'skipped')) {
      // Finished on an earlier attempt: move on without repeating it.
      const out = prev.output as {branch?: 'then' | 'else'};
      cursor = step.type === 'if' ? branchStart(steps, step, out.branch ?? 'else') : nextAfter(steps, step.id);
      continue;
    }
    const row = prev
      ? await db.automationRunStep.update({where: {id: prev.id}, data: {attempts: {increment: 1}, status: 'running', error: null}})
      : await db.automationRunStep.create({data: {runId: run.id, stepId: step.id, type: step.type}});
    let memory = (row.input ?? {}) as Record<string, unknown>;
    const ctx: StepCtx = {
      db: tagged,
      automation: a,
      run: {id: run.id, object, recordId: run.recordId, source: run.source, eventType: run.eventType, context: run.context},
      // Fresh every step: earlier steps (or a long wait) may have changed the records.
      records: await loadRecords(db, object, run.recordId, context?.data ?? null),
      dry,
      attempt: row.attempts,
      stepStartedAt: row.startedAt,
      memo: async (key, fn) => {
        if (key in memory) return memory[key] as never;
        const value = await fn();
        memory = {...memory, [key]: value};
        await db.automationRunStep.update({where: {id: row.id}, data: {input: json(memory)}});
        return value;
      },
    };
    let result: StepResult;
    try {
      if (object !== 'none' && ctx.records.missing && step.type !== 'notify' && step.type !== 'webhook' && step.type !== 'wait' && step.type !== 'stop' && step.type !== 'if') {
        throw new StepError('The record no longer exists');
      }
      result = await executeStep(ctx, step);
      if (run.test === 'quick' && result.waitUntil && result.waitUntil.getTime() > Date.now()) {
        // Quick test: every wait lasts a few seconds, so the whole run can be watched now.
        result = {...result, waitUntil: new Date(Date.now() + QUICK_TEST_WAIT_MS), summary: `${result.summary} (test: ${QUICK_TEST_WAIT_MS / 1000} seconds)`, output: {...result.output, testWaitMs: QUICK_TEST_WAIT_MS}};
      }
    } catch (e) {
      const message = (e as Error).message?.slice(0, 1000) || 'Step failed';
      const final = isPermanent(e) || job.attempts >= job.maxAttempts;
      await db.automationRunStep.update({where: {id: row.id}, data: {status: final ? 'failed' : 'running', error: message, finishedAt: final ? new Date() : null}});
      if (final) return finish(db, run, 'failed', message);
      await db.automationRun.update({where: {id: run.id}, data: {error: `Retrying: ${message}`}});
      throw e;
    }
    await db.automationRunStep.update({
      where: {id: row.id},
      data: {status: result.status, output: json({summary: result.summary, branch: result.branch, ...result.output}), finishedAt: new Date(), error: null},
    });
    if (result.stop) return finish(db, run, 'done');
    cursor = step.type === 'if' ? branchStart(steps, step, result.branch ?? 'else') : nextAfter(steps, step.id);
    if (result.waitUntil && result.waitUntil.getTime() > Date.now()) {
      // Only a run still going starts waiting (it may have been canceled meanwhile).
      const {count: waiting} = await db.automationRun.updateMany({where: {id: run.id, status: 'running'}, data: {status: 'waiting', cursor, waitUntil: result.waitUntil, error: null}});
      if (waiting) await queueRun(db, run.id, `w${result.waitUntil.getTime()}`, result.waitUntil);
      return;
    }
    run = await db.automationRun.update({where: {id: run.id}, data: {cursor, error: null}});
    // Canceled (or a test stopped) while this step ran: go no further.
    if (run.status === 'canceled') return;
  }
  return finish(db, run, 'done');
}

// ─── Dry runs ───────────────────────────────────────────────────────────────

export type TestStep = {stepId: string; type: Step['type']; status: 'done' | 'skipped' | 'error'; summary: string; branch?: 'then' | 'else'};

/**
 * "Test run" on a record: evaluates the trigger conditions and walks the steps
 * with every executor in dry mode. Reads only: nothing is created, sent or
 * changed, and waits are described instead of waited for.
 */
export async function testAutomation(db: Db, a: Automation, recordId: string | null) {
  const object = objectOf(a);
  const records = await loadRecords(db, object, recordId);
  if (object !== 'none' && records.missing) return {record: null, conditions: {ok: false, blocks: []}, steps: [] as TestStep[]};
  const conditions = await evaluateConditions(db, triggerOf(a).conditions, records);
  const steps = stepsOf(a);
  const out: TestStep[] = [];
  const ctx: StepCtx = {
    db,
    automation: a,
    run: {id: 'test', object, recordId, source: 'manual', eventType: null, context: {}},
    records,
    dry: true,
    attempt: 1,
    stepStartedAt: new Date(),
    memo: (_key, fn) => fn(),
  };
  let cursor = steps[0]?.id ?? null;
  while (cursor && out.length < MAX_STEPS_PER_RUN) {
    const step = findStep(steps, cursor);
    if (!step) break;
    try {
      const r = await executeStep(ctx, step);
      out.push({stepId: step.id, type: step.type, status: r.status, summary: r.summary, branch: r.branch});
      if (r.stop) break;
      cursor = step.type === 'if' ? branchStart(steps, step, r.branch ?? 'else') : nextAfter(steps, step.id);
    } catch (e) {
      out.push({stepId: step.id, type: step.type, status: 'error', summary: (e as Error).message});
      break;
    }
  }
  const primary = primaryOf(object, records);
  return {record: primary ? {id: (primary as {id: string}).id, label: labelOf(object, primary)} : null, conditions, steps: out};
}

// ─── Test runs ──────────────────────────────────────────────────────────────

/** What a test run keeps of the editor's draft, and executes instead of the saved automation. */
export type TestDefinition = Pick<Automation, 'name' | 'object' | 'trigger' | 'steps' | 'timezone'>;

/** The automation as a run executes it: a test run's draft, else the saved automation. */
export function definitionOf(a: Automation, run: Pick<AutomationRun, 'test' | 'definition'>): Automation {
  if (!run.test || !run.definition || typeof run.definition !== 'object') return a;
  const d = run.definition as unknown as Partial<TestDefinition>;
  return {...a, name: d.name ?? a.name, object: d.object ?? a.object, trigger: d.trigger ?? a.trigger, steps: d.steps ?? a.steps, timezone: d.timezone ?? a.timezone};
}

/**
 * The record a simulation runs on when none was picked: the most recent one
 * (of those the user can see) that matches the trigger conditions, else the
 * most recent one.
 */
export async function sampleRecord(db: Db, a: Automation, scope: Record<string, unknown>): Promise<{id: string; matches: boolean} | null> {
  const object = objectOf(a);
  if (object === 'none') return null;
  const args = {where: scope, orderBy: {createdAt: 'desc' as const}, take: 30, select: {id: true}};
  const rows: {id: string}[] =
    object === 'contact' ? await db.contact.findMany(args) : object === 'company' ? await db.company.findMany(args) : object === 'deal' ? await db.deal.findMany(args) : await db.ticket.findMany(args);
  if (!rows.length) return null;
  const conditions = triggerOf(a).conditions;
  if (!conditions?.blocks.length) return {id: rows[0]!.id, matches: true};
  for (const r of rows) {
    if ((await evaluateConditions(db, conditions, await loadRecords(db, object, r.id))).ok) return {id: r.id, matches: true};
  }
  return {id: rows[0]!.id, matches: false};
}

/**
 * Starts a test run of `a` (the editor's draft laid over the saved
 * automation) on a record. It runs whether or not the automation is on, in
 * its active dates or the record matches the conditions (the result says);
 * the draft is kept on the run, so later edits don't change it. A new
 * simulation replaces the person's simulations of this automation still
 * going; tests for real carry on.
 */
export async function startTestRun(db: Db, a: Automation, input: {mode: TestMode; recordId: string | null; userId: string}) {
  const object = objectOf(a);
  const records = await loadRecords(db, object, input.recordId);
  if (object !== 'none' && records.missing) return {run: null, reason: 'The record no longer exists'};
  const conditions = await evaluateConditions(db, triggerOf(a).conditions, records);
  const now = new Date();
  await db.automationRun.updateMany({
    where: {automationId: a.id, startedById: input.userId, test: {in: ['quick', 'timed']}, status: {in: ['running', 'waiting']}},
    data: {status: 'canceled', error: 'Replaced by a newer test', finishedAt: now, cursor: null, waitUntil: null},
  });
  const primary = primaryOf(object, records);
  const steps = stepsOf(a);
  const definition: TestDefinition = {name: a.name, object: a.object, trigger: a.trigger, steps: a.steps, timezone: a.timezone};
  const run = await db.automationRun.create({
    data: {
      automationId: a.id,
      object: a.object,
      recordId: input.recordId,
      recordLabel: primary ? labelOf(object, primary) : null,
      ownerId: primary ? ownerIdOf(object, primary) : null,
      status: 'running',
      source: 'test',
      chainId: newChain(),
      depth: 0,
      context: json({test: input.mode, by: input.userId, conditions}),
      cursor: steps[0]?.id ?? null,
      startedById: input.userId,
      test: input.mode,
      definition: json(definition),
    },
  });
  await queueRun(db, run.id, 'start');
  return {run, conditions};
}

/**
 * Finished runs (and their steps) are kept 90 days (test simulations 30); fire logs a year after the
 * date passed; run leases a day after they ended. From pruneJobs(), in chunks until `until`.
 */
export async function pruneAutomations(db: Db, until = Date.now() + 20_000) {
  const tests = new Date(Date.now() - 30 * DAY);
  const runs = new Date(Date.now() - 90 * DAY);
  const fires = new Date(Date.now() - 400 * DAY);
  const leases = new Date(Date.now() - DAY);
  await deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "AutomationRun" WHERE id IN (SELECT id FROM "AutomationRun" WHERE test IN ('quick', 'timed') AND status IN ('done', 'failed', 'canceled') AND "finishedAt" < ${tests} LIMIT ${n})`);
  await deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "AutomationRun" WHERE id IN (SELECT id FROM "AutomationRun" WHERE status IN ('done', 'failed', 'skipped', 'canceled') AND "finishedAt" < ${runs} LIMIT ${n})`);
  await deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "AutomationFire" WHERE ctid IN (SELECT ctid FROM "AutomationFire" WHERE "createdAt" < ${fires} LIMIT ${n})`);
  await db.$executeRaw`DELETE FROM "Setting" WHERE key LIKE ${LEASE_PREFIX + '%'} AND "updatedAt" < ${leases}`;
}
