/**
 * Automation engine. Shapes and catalogues live in src/lib/automations.ts,
 * step executors in automation-steps.ts, records / conditions / merge fields
 * in automation-records.ts.
 *
 *   events      emit() → queueAutomations() (automation-hook.ts) → `automation.events`
 *               job → matchEvents(): one run per (automation, event)
 *   dates       automationTick() from /jobs/run: records whose trigger moment fell
 *               between the last check and now (missed ticks caught up), exactly
 *               once per (automation, record, value) via AutomationFire
 *   manual      runOnRecord() / runOnList() (`automation.batch`, 100 contacts a job)
 *   runs        `automation.run` job → advanceRun(): executes steps in order, one
 *               AutomationRunStep row each; waits re-queue the job with runAt;
 *               transient errors retry the job (finished steps are skipped)
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
import {enqueue, kickJobs} from './jobs';
import {notify} from './notify';
import {listContactWhere} from './segments';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Origin = {automationId: string; runId: string; chainId: string; depth: number};

export const triggerOf = (a: Pick<Automation, 'trigger'>) => a.trigger as unknown as Trigger;
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
  await enqueue(db, 'automation.run', {runId: run.id});
  await db.automation.update({where: {id: a.id}, data: {lastRunAt: now}}).catch(() => null);
  return {run};
}

/** Queues the job of a running run that has none (its job was lost to an error between the two writes). */
async function ensureJob(db: Db, run: {id: string; status: string}) {
  if (run.status !== 'running') return;
  // The key keeps it to one such job per run every ten minutes; a duplicate run is harmless (steps never repeat).
  await enqueue(db, 'automation.run', {runId: run.id}, {key: `ensure-${run.id}-${Math.floor(Date.now() / 600_000)}`});
}

/**
 * Safety net from the `crm-tick` schedule: runs left without a job (running for over two
 * minutes, or waiting past their time) are queued again. Finished steps are never repeated, so
 * this is always safe; the key keeps it to one rescue per run every ten minutes.
 */
async function rescueRuns(db: Db) {
  const stuck = await db.$queryRaw<{id: string}[]>`
    SELECT r.id FROM "AutomationRun" r
    WHERE (r.status = 'running' AND r."startedAt" < now() - interval '2 minutes') OR (r.status = 'waiting' AND r."waitUntil" < now() - interval '2 minutes')
    LIMIT 50`;
  const slot = Math.floor(Date.now() / 600_000);
  for (const r of stuck) await enqueue(db, 'automation.run', {runId: r.id}, {key: `rescue-${r.id}-${slot}`});
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

/** `automation.events` job: starts one run per (automation, event) that matches. Safe to run twice. */
export async function matchEvents(db: Db, eventIds: string[], origin: Origin | null) {
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
      await startRun(db, a, {
        recordId,
        source: 'event',
        eventType: event.type,
        dedupeKey: `${a.id}:${event.id}`,
        context: {eventId: event.id, type: event.type, data: event.data},
        origin,
      });
    }
  }
}

// ─── Date and inactivity triggers ───────────────────────────────────────────

type Candidate = {recordId: string; value: string; moment: number; context: Record<string, unknown>};

const TABLES: Record<Target, string> = {contact: '"Contact"', company: '"Company"', deal: '"Deal"', ticket: '"Ticket"'};
const OWNER_COLUMN: Record<Target, string> = {contact: '"ownerId"', company: '"ownerId"', deal: '"ownerId"', ticket: '"assigneeId"'};

/** When a date trigger fires for a date value (ms of a timestamp, or a YYYY-MM-DD calendar date). */
export function triggerMoment(t: Extract<Trigger, {kind: 'date'}>, value: Date | string, dateOnly: boolean, tz: string) {
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

const LIMIT = 500;

async function dateCandidates(db: Db, a: Automation, t: Extract<Trigger, {kind: 'date'}>, from: Date, to: Date): Promise<Candidate[]> {
  const object = objectOf(a);
  if (object === 'none') return [];
  const sign = t.direction === 'before' ? -1 : 1;
  const offset = t.amount * UNIT_MS[t.unit];
  // The value lies near (moment - offset); two days either side cover time zones and time of day.
  const lo = new Date(from.getTime() - sign * offset - 2 * DAY);
  const hi = new Date(to.getTime() - sign * offset + 2 * DAY);
  const tz = tzOf(a);
  let rows: {id: string; value: Date | string; ownerId: string | null; context?: Record<string, unknown>}[] = [];
  let dateOnly = false;
  if (t.source === 'booking') {
    if (object !== 'contact') return [];
    const bookings = await db.booking.findMany({where: {status: 'CONFIRMED', contactId: {not: null}, startAt: {gte: lo, lte: hi}}, orderBy: {startAt: 'asc'}, take: LIMIT, select: {id: true, contactId: true, startAt: true, hostId: true, title: true}});
    return bookings
      .map((b) => ({recordId: b.contactId!, value: `${b.id}@${b.startAt.toISOString()}`, moment: triggerMoment(t, b.startAt, false, tz), context: {bookingId: b.id, startAt: b.startAt.toISOString(), title: b.title}}))
      .filter((c) => c.moment > from.getTime() && c.moment <= to.getTime());
  }
  const field = (await fieldsFor(db, object)).find((f) => f.key === t.field && f.kind === 'date');
  if (!field) return [];
  dateOnly = !!field.dateOnly;
  // Table and owner column from fixed maps; values bound as parameters.
  const table = Prisma.raw(TABLES[object]);
  const owner = Prisma.raw(OWNER_COLUMN[object]);
  if (field.key.startsWith('custom.')) {
    const key = field.key.slice(7);
    // Custom dates are stored as "YYYY-MM-DD" strings, which compare in order.
    const value = Prisma.sql`custom->>${key}::text`;
    const found = await db.$queryRaw<{id: string; value: string; ownerId: string | null}[]>(
      Prisma.sql`SELECT id, ${value} AS value, ${owner} AS "ownerId" FROM ${table} WHERE ${value} >= ${lo.toISOString().slice(0, 10)} AND ${value} <= ${hi.toISOString().slice(0, 10)} ORDER BY ${value} LIMIT ${LIMIT}`,
    );
    rows = found.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.value));
  } else {
    // A built-in date field: its key is the column's name (the field list is written in code).
    if (!/^[a-zA-Z]+$/.test(field.key)) return [];
    const column = Prisma.raw(`"${field.key}"`);
    rows = await db.$queryRaw<{id: string; value: Date; ownerId: string | null}[]>(
      Prisma.sql`SELECT id, ${column} AS value, ${owner} AS "ownerId" FROM ${table} WHERE ${column} >= ${lo} AND ${column} <= ${hi} ORDER BY ${column} LIMIT ${LIMIT}`,
    );
  }
  const zones = t.zone === 'owner' ? await ownerZones(db, rows.map((r) => r.ownerId)) : new Map<string, string>();
  return rows
    .map((r) => {
      const value = typeof r.value === 'string' ? r.value.slice(0, 10) : dateOnly ? r.value.toISOString().slice(0, 10) : r.value.toISOString();
      const zone = (r.ownerId && zones.get(r.ownerId)) || tz;
      return {recordId: r.id, value, moment: triggerMoment(t, r.value, dateOnly, zone), context: {field: field.key, value}};
    })
    .filter((c) => c.moment > from.getTime() && c.moment <= to.getTime());
}

async function inactivityCandidates(db: Db, a: Automation, t: Extract<Trigger, {kind: 'inactivity'}>, from: Date, to: Date): Promise<Candidate[]> {
  const object = objectOf(a);
  const span = t.amount * (t.unit === 'hours' ? HOUR : DAY);
  // "Inactive for N" fires when (since + N) falls in (from, to], i.e. since in (from - N, to - N].
  const lo = new Date(from.getTime() - span);
  const hi = new Date(to.getTime() - span);
  const at = (since: Date) => since.getTime() + span;
  if (t.rule === 'no_activity' && (object === 'contact' || object === 'company' || object === 'deal')) {
    const rows = await db.$queryRaw<{id: string; since: Date}[]>(
      Prisma.sql`SELECT id, "lastActivityAt" AS since FROM ${Prisma.raw(TABLES[object])} WHERE "lastActivityAt" > ${lo} AND "lastActivityAt" <= ${hi} ORDER BY "lastActivityAt" LIMIT ${LIMIT}`,
    );
    return rows.map((r) => ({recordId: r.id, value: r.since.toISOString(), moment: at(r.since), context: {lastActivityAt: r.since.toISOString()}}));
  }
  if (t.rule === 'ticket_waiting' && object === 'ticket') {
    // Waiting since the last move to "waiting on us" (or since it was opened, for new tickets).
    const rows = await db.$queryRaw<{id: string; since: Date}[]>`
      SELECT t.id, s.since FROM "Ticket" t
      CROSS JOIN LATERAL (
        SELECT COALESCE((SELECT max(m."createdAt") FROM "TicketMessage" m WHERE m."ticketId" = t.id AND m.kind = 'event' AND m.data->>'type' = 'status' AND m.data->>'to' = 'WAITING_ON_US'), t."createdAt") AS since
      ) s
      WHERE t.status IN ('NEW', 'WAITING_ON_US') AND s.since > ${lo} AND s.since <= ${hi}
      ORDER BY s.since LIMIT ${LIMIT}`;
    return rows.map((r) => ({recordId: r.id, value: r.since.toISOString(), moment: at(r.since), context: {waitingSince: r.since.toISOString()}}));
  }
  if (t.rule === 'task_overdue' && (object === 'contact' || object === 'company' || object === 'deal')) {
    const key = `${object}Id` as 'contactId' | 'companyId' | 'dealId';
    const tasks = await db.task.findMany({where: {done: false, dueAt: {gt: lo, lte: hi}, [key]: {not: null}}, orderBy: {dueAt: 'asc'}, take: LIMIT, select: {id: true, title: true, dueAt: true, assigneeId: true, contactId: true, companyId: true, dealId: true}});
    return tasks.map((task) => ({recordId: task[key]!, value: `${task.id}@${task.dueAt!.toISOString()}`, moment: at(task.dueAt!), context: {task: {id: task.id, title: task.title, dueAt: task.dueAt!.toISOString(), assigneeId: task.assigneeId}}}));
  }
  if (t.rule === 'in_list' && object === 'contact' && t.listId) {
    const members = await db.contactListMember.findMany({where: {listId: t.listId, createdAt: {gt: lo, lte: hi}}, orderBy: {createdAt: 'asc'}, take: LIMIT, select: {contactId: true, createdAt: true}});
    return members.map((m) => ({recordId: m.contactId, value: m.createdAt.toISOString(), moment: at(m.createdAt), context: {listId: t.listId, addedAt: m.createdAt.toISOString()}}));
  }
  return [];
}

/** How far back a tick looks when the scheduler was down (or the automation was just switched on). */
const MAX_CATCH_UP = 30 * DAY;

/**
 * Date and inactivity triggers, from /jobs/run. For each automation: the
 * records whose trigger moment is in (last check, now] start one run each;
 * AutomationFire makes it exactly-once even when ticks overlap.
 */
export async function automationTick(db: Db, {budgetMs = 8_000} = {}) {
  const started = Date.now();
  const autos = await db.automation.findMany({where: {enabled: true, triggerKind: {in: ['date', 'inactivity']}}, orderBy: {cursorAt: {sort: 'asc', nulls: 'first'}}});
  let fired = 0;
  let checked = 0;
  for (const a of autos) {
    if (Date.now() - started > budgetMs) break;
    const now = new Date();
    const fromMs = Math.max((a.cursorAt ?? a.enabledAt ?? now).getTime(), now.getTime() - MAX_CATCH_UP);
    if (fromMs >= now.getTime()) continue;
    const from = new Date(fromMs);
    const t = triggerOf(a);
    let found: Candidate[] = [];
    try {
      if (t.kind === 'date') found = await dateCandidates(db, a, t, from, now);
      else if (t.kind === 'inactivity' && INACTIVITY_RULES[t.rule]) found = await inactivityCandidates(db, a, t, from, now);
    } catch (e) {
      console.error('[automations] tick', a.id, e);
      continue;
    }
    found.sort((x, y) => x.moment - y.moment);
    // A full page means there may be more: resume after the last moment handled.
    const cursor = found.length >= LIMIT ? new Date(found.at(-1)!.moment) : now;
    checked++;
    for (const c of found) {
      const fresh = await db.automationFire.create({data: {automationId: a.id, recordId: c.recordId, value: c.value}}).then(() => true, () => false);
      if (!fresh) continue;
      const {run} = await startRun(db, a, {recordId: c.recordId, source: t.kind === 'date' ? 'date' : 'inactivity', dedupeKey: `${a.id}:fire:${c.recordId}:${c.value}`, context: {...c.context, moment: new Date(c.moment).toISOString()}});
      if (run) fired++;
    }
    await db.automation.update({where: {id: a.id}, data: {cursorAt: cursor}});
  }
  const rescued = await rescueRuns(db).catch(() => 0);
  if (fired || rescued) kickJobs();
  return {automations: checked, fired, rescued};
}

// ─── Manual runs ────────────────────────────────────────────────────────────

export async function runOnRecord(db: Db, a: Automation, recordId: string, userId: string) {
  return startRun(db, a, {recordId, source: 'manual', dedupeKey: null, context: {by: userId}, startedById: userId, explicit: true});
}

/** Queues "run on a list / segment": contacts the user can see, 100 per job. */
export async function runOnList(db: Db, a: Automation, listId: string, userId: string) {
  const batchId = randomToken(6);
  await enqueue(db, 'automation.batch', {automationId: a.id, listId, userId, batchId, after: null});
  kickJobs();
  return batchId;
}

export async function runBatch(db: Db, p: Record<string, unknown>) {
  const a = await db.automation.findUnique({where: {id: String(p.automationId)}});
  const user = await db.member.findUnique({where: {id: String(p.userId)}});
  if (!a || !user || !a.enabled) return;
  const after = typeof p.after === 'string' ? p.after : null;
  const where = {AND: [await listContactWhere(db, String(p.listId)), ...(after ? [{id: {gt: after}}] : [])], ...(await userScope(db, user))};
  const contacts = await db.contact.findMany({where, orderBy: {id: 'asc'}, take: 100, select: {id: true}});
  for (const c of contacts) {
    await startRun(db, a, {recordId: c.id, source: 'list', dedupeKey: `${a.id}:list:${p.batchId}:${c.id}`, context: {listId: p.listId, by: user.id}, startedById: user.id});
  }
  if (contacts.length === 100) await enqueue(db, 'automation.batch', {...(p as Prisma.InputJsonObject), after: contacts.at(-1)!.id});
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

/**
 * `automation.run` job: executes the run from its cursor. Finished steps are
 * never repeated (their rows say so); a transient error re-throws so the job
 * runner retries with backoff, a permanent one (or the last attempt) fails the run.
 */
export async function advanceRun(db: Db, runId: string, job: Pick<JobRun, 'attempts' | 'maxAttempts'>) {
  let run = await db.automationRun.findUnique({where: {id: runId}});
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
  const saved = await db.automation.findUnique({where: {id: run.automationId}});
  if (!saved) return;
  const a = definitionOf(saved, run);
  const dry = !!run.test && !!TEST_MODES[run.test as TestMode]?.dry;
  if (run.status === 'waiting') {
    // Woken early (a duplicate job): sleep again until it's time.
    if (run.waitUntil && run.waitUntil.getTime() > Date.now() + 1000) {
      await enqueue(db, 'automation.run', {runId}, {runAt: run.waitUntil, key: `wake-${runId}-${run.waitUntil.getTime()}`});
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
  while (cursor) {
    if (++count > STEPS_PER_JOB) {
      await enqueue(db, 'automation.run', {runId: run.id});
      return;
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
      if (waiting) await enqueue(db, 'automation.run', {runId: run.id}, {runAt: result.waitUntil});
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
  await enqueue(db, 'automation.run', {runId: run.id});
  return {run, conditions};
}

/** Finished runs (and their steps) are kept 90 days (test simulations 30); fire logs a year after the date passed. From pruneJobs(). */
export async function pruneAutomations(db: Db) {
  await db.automationRun.deleteMany({where: {test: {in: ['quick', 'timed']}, status: {in: ['done', 'failed', 'canceled']}, finishedAt: {lt: new Date(Date.now() - 30 * DAY)}}});
  await db.automationRun.deleteMany({where: {status: {in: ['done', 'failed', 'skipped', 'canceled']}, finishedAt: {lt: new Date(Date.now() - 90 * DAY)}}});
  await db.automationFire.deleteMany({where: {createdAt: {lt: new Date(Date.now() - 400 * DAY)}}});
}
