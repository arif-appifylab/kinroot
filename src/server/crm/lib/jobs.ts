import {AsyncLocalStorage} from 'node:async_hooks';

import type {Prisma} from '../../../generated/prisma/client';
import {DontRetry, JobRejected, runsJobsLocally, sendJobs, type JobInfo, type SendOptions} from '../../../platform/background';
import {config as site} from '../../../platform/config';
import {getDb} from '../../../platform/db';
import {forwardReply} from '../email/replies';
import {syncAccountJob} from '../email/sync';
import {syncConnectionJob} from '../calendar/service';
import {formAfterSubmit} from './form-emails';
import {checkSla} from './ticket-sla';
import {sendCsat} from './tickets';
import {bookingEmail, bookingReminder} from '../scheduling/emails';
import {deliverWebhooks} from './webhooks';
import {sendBroadcastBatch, startBroadcast} from './broadcasts';
import {recalcJob, rescoreContacts, scoreEvents} from './scoring';
import {pruneAudit} from './audit';
import {deleteInChunks} from './chunked-delete';
import {checkDuplicates, scanJob} from './duplicates';
import {purgeExpiredBin} from './recycle-bin';
import {advanceRun, matchEvents, pruneAutomations, runBatch, type Origin} from './automations';
import {importJob} from './imports';
import {exportJob} from './exports';
import {pruneImportExport} from './io-prune';
import {pruneScheduleSends, sendJob as sendScheduledReport} from './report-schedules';
import {wakeConversation} from '../inbox/conversations';
import {emailVisitor} from '../inbox/chat';
import {pruneRateHits} from './rate-limit';
import {processIncoming, pruneIncomingRequests} from './incoming-webhooks';
import {pruneDataIn} from './data-in-prune';
import {REQUEST_KEEP_DAYS} from '@/lib/incoming-webhooks';
import type {Db} from '../kit/db';
import type {JobRun} from '../kit/job-run';
import {purgeFiles} from '../kit/storage';

/**
 * Kinroot's background jobs, run by the PLATFORM's background jobs (docs/agent/background-jobs.md).
 *
 * Kinroot code queues work with `enqueue(db, 'webhook.deliver', {eventId})`; each job type is a
 * platform list (`crm-webhook-deliver`, see `listOf`) whose handler is registered in
 * src/server/background.ts. Jobs queued during a request (or a job run) are collected and sent
 * together when it ends (`withOutbox`), so a job never starts before the transaction that queued
 * it has committed, and one request makes one send call.
 *
 * The platform takes JOBS_PER_MINUTE new jobs a minute (10 unless the owner raised it in the Jobs
 * tab) and refuses a batch over that whole. So a send never asks for more than this minute has left
 * (`reserve`, one counter row shared by every Worker); the rest waits in `JobBacklog` and `crm-tick`
 * sends it as the minutes turn (`drainBacklog`). A refusal never loses a job: a rate limit pushes
 * the rows past the minute, a job the platform refuses for good (too large, a bad list…) is set
 * aside alone (`failedAt`, shown in Settings → Webhooks) and the others go on. Waiting rows are
 * never deleted; set-aside ones after 30 days.
 */
type Handler = (db: Db, payload: Record<string, unknown>, job: JobRun) => Promise<void>;

const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

const HANDLERS = {
  'webhook.deliver': (db, p, job) =>
    deliverWebhooks(
      db,
      {deliveryId: p.deliveryId ? String(p.deliveryId) : undefined, deliveryIds: p.deliveryIds ? ids(p.deliveryIds) : undefined, eventId: p.eventId ? String(p.eventId) : undefined, eventIds: p.eventIds ? ids(p.eventIds) : undefined},
      job.attempts >= job.maxAttempts,
    ),
  'form.after_submit': (db, p) => formAfterSubmit(db, String(p.submissionId)),
  'ticket.sla_check': (db, p) => checkSla(db, p),
  'ticket.csat': (db, p) => sendCsat(db, p),
  'email.forward_reply': (db, p) => forwardReply(db, String(p.messageId), String(p.origin ?? '')),
  'email.sync_account': (db, p) => syncAccountJob(db, String(p.accountId)),
  'calendar.sync_connection': (db, p) => syncConnectionJob(db, String(p.connectionId), p.force === true),
  'booking.email': (db, p) => bookingEmail(db, p as Parameters<typeof bookingEmail>[1]),
  'booking.reminder': (db, p) => bookingReminder(db, p as Parameters<typeof bookingReminder>[1]),
  'broadcast.start': (db, p) => startBroadcast(db, p),
  'broadcast.batch': (db, p) => sendBroadcastBatch(db, p),
  'scoring.events': (db, p) => scoreEvents(db, ids(p.eventIds)),
  'scoring.rescore': async (db, p) => void (await rescoreContacts(db, ids(p.contactIds))),
  'scoring.recalc': (db, p) => recalcJob(db, {runId: String(p.runId), after: typeof p.after === 'string' ? p.after : null}),
  'duplicates.scan': (db, p, job) => scanJob(db, p.entity === 'company' ? 'company' : 'contact', p.manual === true, job.attempts >= job.maxAttempts),
  'duplicates.check': (db, p) => checkDuplicates(db, p.entity === 'company' ? 'company' : 'contact', String(p.id)),
  'automation.events': (db, p) => matchEvents(db, ids(p.eventIds), (p.origin ?? null) as Origin | null),
  'automation.run': (db, p, job) => advanceRun(db, String(p.runId), job),
  'automation.batch': (db, p) => runBatch(db, p),
  'import.validate': (db, p, job) => importJob(db, 'validate', {importId: String(p.importId), token: String(p.token)}, job),
  'import.run': (db, p, job) => importJob(db, 'run', {importId: String(p.importId), token: String(p.token)}, job),
  'export.run': (db, p, job) => exportJob(db, {exportId: String(p.exportId)}, job),
  'report.send': (db, p, job) => sendScheduledReport(db, String(p.sendId), job),
  'inbox.wake': (db, p) => wakeConversation(db, String(p.threadId)),
  'chat.email_visitor': (db, p) => emailVisitor(db, p),
  'incoming_webhook.process': (db, p, job) => processIncoming(db, String(p.requestId), job.attempts >= job.maxAttempts),
} satisfies Record<string, Handler>;

export type JobType = keyof typeof HANDLERS;

/** `webhook.deliver` → `crm-webhook-deliver`: platform list names are `a-z0-9-`. */
const listOf = (type: JobType) => `crm-${type.replace(/[._]/g, '-')}`;

/** What the owner reads in the platform's Jobs tab: the kind of work, never personal data. */
const LABELS: Record<JobType, string> = {
  'webhook.deliver': 'Webhook delivery',
  'form.after_submit': 'Form submission emails',
  'ticket.sla_check': 'Ticket SLA check',
  'ticket.csat': 'Ticket satisfaction survey',
  'email.forward_reply': 'Forward an email reply',
  'email.sync_account': 'Mailbox sync',
  'calendar.sync_connection': 'Calendar sync',
  'booking.email': 'Booking email',
  'booking.reminder': 'Booking reminder',
  'broadcast.start': 'Broadcast start',
  'broadcast.batch': 'Broadcast batch',
  'scoring.events': 'Lead scoring',
  'scoring.rescore': 'Lead scoring · rescore',
  'scoring.recalc': 'Lead scoring · recalculate',
  'duplicates.scan': 'Duplicate scan',
  'duplicates.check': 'Duplicate check',
  'automation.events': 'Automation triggers',
  'automation.run': 'Automation run',
  'automation.batch': 'Automation on a list',
  'import.validate': 'Import check',
  'import.run': 'Import',
  'export.run': 'Export',
  'report.send': 'Scheduled report email',
  'inbox.wake': 'Snoozed conversation',
  'chat.email_visitor': 'Chat transcript email',
  'incoming_webhook.process': 'Incoming webhook',
};
const LIST_LABELS = new Map(Object.entries(LABELS).map(([type, label]) => [listOf(type as JobType), label]));

/**
 * Which jobs go first when the rate holds some back (AUDIT-2 M-11): 0 = someone is waiting for it
 * (a booking or form email, an SLA check, a survey, a forwarded reply, a report, a chat transcript,
 * a snoozed conversation), 2 = bulk work an import or a merge queues by the hundred (scoring,
 * duplicate checks, webhook deliveries), 1 = the rest. The rate itself is unchanged.
 */
const URGENT: JobType[] = ['booking.email', 'booking.reminder', 'form.after_submit', 'ticket.sla_check', 'ticket.csat', 'email.forward_reply', 'report.send', 'chat.email_visitor', 'inbox.wake'];
const BULK: JobType[] = ['scoring.events', 'scoring.rescore', 'scoring.recalc', 'duplicates.check', 'duplicates.scan', 'webhook.deliver'];
const PRIORITY = new Map<string, number>([...URGENT.map((t) => [listOf(t), 0] as const), ...BULK.map((t) => [listOf(t), 2] as const)]);
export const priorityOf = (list: string) => PRIORITY.get(list) ?? 1;
const LABEL_MAX = 80;

// ─── Queueing ───────────────────────────────────────────────────────────────

type Outgoing = {list: string; data: Prisma.InputJsonObject} & Pick<SendOptions, 'at' | 'key' | 'label'>;
type Outbox = {jobs: Outgoing[]};

const outboxes = new AsyncLocalStorage<Outbox>();

/**
 * Queues a job. `runAt` = not before then (up to a year ahead); `key` = at most one such job
 * waiting (the platform's dedupe: also for 24 h after it ran, so a key must name one piece of
 * work, never a record forever); `label` replaces the type's label in the Jobs tab (no personal
 * data). Tries per job come from its list (background.json). The `db` argument is kept for the
 * call sites written for Kinroot's old runner: nothing is written through it.
 */
export async function enqueue(_db: Db, type: JobType, payload: Prisma.InputJsonObject, opts: {runAt?: Date; key?: string; label?: string} = {}) {
  const job: Outgoing = {
    list: listOf(type),
    data: payload,
    label: (opts.label ?? LABELS[type]).slice(0, LABEL_MAX),
    ...(opts.runAt ? {at: opts.runAt} : {}),
    ...(opts.key ? {key: opts.key} : {}),
  };
  const outbox = outboxes.getStore();
  if (outbox) outbox.jobs.push(job);
  else await flush([job]);
}

/** Runs `work` collecting the jobs it queues, then sends them (also when `work` throws). */
export async function withOutbox<T>(work: () => Promise<T>): Promise<T> {
  const outbox: Outbox = {jobs: []};
  try {
    return await outboxes.run(outbox, work);
  } finally {
    if (outbox.jobs.length) await flush(outbox.jobs);
  }
}

/** The address the platform is called on (it only needs an origin; `SITE_URL` wins when set). */
const origin = () => site.siteUrl ?? 'http://localhost';

// ─── The job rate ───────────────────────────────────────────────────────────

/** New jobs a minute the platform takes by default; the owner can raise it to 50 in the Jobs tab. */
const JOBS_PER_MINUTE = 10;
/** Settings row: the rate the owner set in the platform's Jobs tab (Settings → Webhooks). */
const JOBS_RATE_SETTING = 'jobs.perMinute';
export const MAX_JOBS_PER_MINUTE = 1000;
/** Settings row: jobs sent this minute (`{minute, count}`), shared by every Worker. */
const RATE_COUNTER = 'jobs.rate';
/** The platform takes at most this many in one call. */
const MAX_BATCH = 100;
/** `lastError` of rows that wait only for the next minute (Settings → Webhooks counts them). */
export const RATE_WAIT = 'Waiting for the job rate limit';
/** Tries for a row that keeps failing for another reason (the platform down…), then it is set aside. */
const MAX_BACKLOG_ATTEMPTS = 12;
/** Set-aside rows are kept this long for admins to see, then pruned. */
export const FAILED_KEEP_DAYS = 30;

/** Refused for good: the same job would be refused again. */
const PERMANENT = new Set(['E_JOBS_PAYLOAD_TOO_LARGE', 'E_JOBS_BAD_LIST', 'E_JOBS_BAD_TIME', 'E_JOBS_TOO_FAR', 'E_JOBS_KEY', 'E_JOBS_LABEL', 'E_JOBS_GROUP', 'E_JOBS_TOO_MANY_LISTS']);
const RATE_LIMITED = new Set(['E_JOBS_RATE_LIMITED', 'E_TOO_MANY_REQUESTS']);
/** The owner has to act (paused jobs, a full queue): wait without counting tries. */
const ON_HOLD = new Set(['E_JOBS_PAUSED', 'E_JOBS_BACKLOG', 'E_JOBS_SITE_BACKLOG']);

/** The rate in force: the owner's setting, else the platform's default. */
async function jobsPerMinute(db: Db) {
  const row = await db.setting.findUnique({where: {key: JOBS_RATE_SETTING}, select: {value: true}});
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_JOBS_PER_MINUTE) : JOBS_PER_MINUTE;
}

export async function setJobsPerMinute(db: Db, n: number) {
  await db.setting.upsert({where: {key: JOBS_RATE_SETTING}, create: {key: JOBS_RATE_SETTING, value: n}, update: {value: n}});
}

const minuteOf = (ms: number) => Math.floor(ms / 60_000);
/** A moment just past the start of the next minute (the platform counts per minute). */
const nextMinute = () => new Date((minuteOf(Date.now()) + 1) * 60_000 + 2_000);

/**
 * Takes up to `want` of this minute's sends; returns how many were granted. One statement on one
 * row: concurrent Workers queue on the row lock, so together they never exceed the rate.
 */
async function reserve(db: Db, want: number): Promise<number> {
  if (want <= 0) return 0;
  const minute = minuteOf(Date.now());
  const rows = await db.$queryRaw<{granted: number}[]>`
    WITH lim AS (
      SELECT COALESCE(
        (SELECT LEAST(GREATEST(floor((value #>> '{}')::numeric)::int, 1), ${MAX_JOBS_PER_MINUTE}::int) FROM "Setting" WHERE key = ${JOBS_RATE_SETTING} AND jsonb_typeof(value) = 'number'),
        ${JOBS_PER_MINUTE}::int) AS n
    )
    INSERT INTO "Setting" (key, value, "updatedAt")
    SELECT ${RATE_COUNTER}, jsonb_build_object('minute', ${minute}::bigint, 'count', LEAST(${want}::int, lim.n), 'granted', LEAST(${want}::int, lim.n)), ${new Date()} FROM lim
    ON CONFLICT (key) DO UPDATE SET
      value = (
        SELECT jsonb_build_object('minute', ${minute}::bigint, 'count', u.used + u.g, 'granted', u.g)
        FROM (
          SELECT x.used, LEAST(${want}::int, GREATEST((SELECT n FROM lim) - x.used, 0)) AS g
          FROM (SELECT CASE WHEN ("Setting".value ->> 'minute')::bigint = ${minute}::bigint THEN COALESCE(("Setting".value ->> 'count')::int, 0) ELSE 0 END AS used) x
        ) u
      ),
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING (value ->> 'granted')::int AS granted`;
  return Number(rows[0]?.granted ?? 0);
}

/** The platform said this minute is full: no Worker tries again before it turns. */
async function markFull(db: Db) {
  const minute = minuteOf(Date.now());
  await db.$executeRaw`UPDATE "Setting" SET value = jsonb_build_object('minute', ${minute}::bigint, 'count', ${MAX_JOBS_PER_MINUTE * 100}::int, 'granted', 0) WHERE key = ${RATE_COUNTER}`.catch(() => 0);
}

// ─── Sending ────────────────────────────────────────────────────────────────

type Outcome = {state: 'sent'} | {state: 'failed'; reason: string} | {state: 'wait'; until: Date; reason: string; counts: boolean; rate?: boolean};
const SENT: Outcome = {state: 'sent'};

const reasonOf = (e: unknown) => (e instanceof JobRejected ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)).slice(0, 500);

/** Seconds the platform asks to wait (its message may say; the minute turns within 60 s anyway). */
function retryAfterMs(e: JobRejected) {
  const said = /(\d{1,3})\s*(?:s\b|sec|second)/i.exec(e.message);
  return (said ? Math.min(Number(said[1]), 120) + 1 : 61) * 1000;
}

/** Backoff for rows that failed for another reason: 1, 2, 4… minutes, at most an hour. */
const backoff = (attempts: number) => new Date(Date.now() + Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000);

function classify(e: unknown): {kind: 'permanent' | 'rate' | 'hold' | 'transient'; outcome: Outcome} {
  const reason = reasonOf(e);
  const code = e instanceof JobRejected ? e.code : '';
  if (PERMANENT.has(code)) return {kind: 'permanent', outcome: {state: 'failed', reason}};
  if (RATE_LIMITED.has(code)) return {kind: 'rate', outcome: {state: 'wait', until: new Date(Date.now() + retryAfterMs(e as JobRejected)), reason: `${RATE_WAIT} (${reason})`.slice(0, 500), counts: false, rate: true}};
  if (ON_HOLD.has(code)) return {kind: 'hold', outcome: {state: 'wait', until: new Date(Date.now() + 5 * 60_000), reason, counts: false}};
  return {kind: 'transient', outcome: {state: 'wait', until: backoff(1), reason, counts: true}};
}

type Sendable = {list: string; data: Prisma.InputJsonObject; at?: SendOptions['at']; key?: string; label?: string};
const toSend = (j: Sendable) => ({list: j.list, data: j.data, ...(j.at ? {at: j.at} : {}), ...(j.key ? {key: j.key} : {}), ...(j.label ? {label: j.label} : {})});

/**
 * Sends one batch (≤ 100). A permanent refusal names no job, so the batch is sent again one by one:
 * only the bad job fails. A rate limit or an outage stops at once; the rest waits.
 */
async function deliver(jobs: Sendable[]): Promise<Outcome[]> {
  try {
    await sendJobs(origin(), jobs.map(toSend));
    return jobs.map(() => SENT);
  } catch (e) {
    const first = classify(e);
    if (first.kind !== 'permanent' || jobs.length === 1) return jobs.map(() => first.outcome);
  }
  const out: Outcome[] = [];
  for (const [i, job] of jobs.entries()) {
    try {
      await sendJobs(origin(), [toSend(job)]);
      out.push(SENT);
    } catch (e) {
      const r = classify(e);
      if (r.kind === 'permanent') {
        out.push(r.outcome);
        continue;
      }
      // Rate limit, on hold or an outage: everything not sent yet waits the same.
      for (let k = i; k < jobs.length; k++) out.push(r.outcome);
      break;
    }
  }
  return out;
}

/** Fields of a backlog row that are not the job's own data (kept under one key, stripped on drain). */
const META = '__job';
type Meta = {label?: string; at?: string};

/** A backlog row sent again from `runAt`; a job planned later than that keeps its time (`meta.at`) for the platform. */
function toRow(j: Outgoing, runAt: Date, extra: {lastError?: string | null; failedAt?: Date | null} = {}): Prisma.JobBacklogCreateManyInput {
  const at = j.at ? new Date(j.at) : null;
  const meta: Meta = {};
  if (j.label && j.label !== LIST_LABELS.get(j.list)) meta.label = j.label;
  if (at && at.getTime() > runAt.getTime() + 60_000) meta.at = at.toISOString();
  return {
    list: j.list,
    data: Object.keys(meta).length ? ({...j.data, [META]: meta} as Prisma.InputJsonObject) : j.data,
    runAt,
    priority: priorityOf(j.list),
    key: j.key ?? null,
    lastError: extra.lastError ?? null,
    failedAt: extra.failedAt ?? null,
    ...(extra.failedAt ? {attempts: 1} : {}),
  };
}

function fromRow(r: {list: string; data: Prisma.JsonValue; key: string | null}): Sendable {
  const {[META]: meta, ...data} = (r.data ?? {}) as Record<string, unknown> & {[META]?: Meta};
  const at = meta?.at && Date.parse(meta.at) > Date.now() + 60_000 ? meta.at : undefined;
  return {list: r.list, data: data as Prisma.InputJsonObject, label: meta?.label ?? LIST_LABELS.get(r.list), ...(at ? {at} : {}), ...(r.key ? {key: r.key} : {})};
}

async function spill(rows: Prisma.JobBacklogCreateManyInput[]) {
  if (!rows.length) return;
  const db = getDb();
  if (!db) return console.error(`[jobs] ${rows.length} job(s) lost: no Site Database`);
  try {
    await db.jobBacklog.createMany({data: rows});
  } catch (e) {
    console.error(`[jobs] ${rows.length} job(s) lost: ${reasonOf(e)}`);
  }
}

const rowOf = (j: Outgoing, o: Outcome) =>
  o.state === 'failed' ? toRow(j, new Date(), {lastError: o.reason, failedAt: new Date()}) : toRow(j, o.state === 'wait' ? o.until : new Date(), {lastError: o.state === 'wait' ? o.reason : null});

/** Never throws: what is not sent waits in `JobBacklog` for the next `crm-tick`. */
async function flush(queued: Outgoing[]) {
  if (runsJobsLocally()) return flushLocally(queued);
  // Urgent first when the rate lets only some go now (stable: queue order within a priority).
  const jobs = queued.map((j, i) => ({j, i, p: priorityOf(j.list)})).sort((a, b) => a.p - b.p || a.i - b.i).map((x) => x.j);
  const db = getDb();
  let granted = jobs.length;
  if (db) {
    try {
      granted = await reserve(db, Math.min(jobs.length, MAX_BATCH));
    } catch (e) {
      // The counter could not be read: send nothing now rather than risk a refused batch.
      console.warn(`[jobs] rate counter: ${reasonOf(e)}`);
      granted = 0;
    }
  }
  const now = jobs.slice(0, Math.min(granted, MAX_BATCH));
  const rows: Prisma.JobBacklogCreateManyInput[] = [];
  let rateLimited = false;
  if (now.length) {
    const outcomes = await deliver(now);
    outcomes.forEach((o, i) => {
      if (o.state === 'wait' && o.rate) rateLimited = true;
      if (o.state !== 'sent') rows.push(rowOf(now[i]!, o));
    });
    const lost = outcomes.filter((o) => o.state !== 'sent').length;
    if (lost) console.warn(`[jobs] ${lost} of ${now.length} job(s) not sent; kept for the next crm-tick`);
  }
  if (rateLimited && db) await markFull(db);
  // Over this minute's share: they wait for the next minute, by priority then in the order they were queued.
  const slot = nextMinute();
  for (const j of jobs.slice(now.length)) rows.push(toRow(j, slot, {lastError: RATE_WAIT}));
  await spill(rows);
}

/** On your machine: the platform runs a job the moment it is sent; jobs planned for later wait here instead. */
async function flushLocally(jobs: Outgoing[]) {
  const later = jobs.filter((j) => j.at && new Date(j.at).getTime() > Date.now() + 1000);
  const now = jobs.filter((j) => !later.includes(j));
  const rows = later.map((j) => toRow(j, new Date(j.at!)));
  for (let k = 0; k < now.length; k += MAX_BATCH) {
    const batch = now.slice(k, k + MAX_BATCH);
    const outcomes = await deliver(batch);
    outcomes.forEach((o, i) => o.state !== 'sent' && rows.push(rowOf(batch[i]!, o)));
  }
  await spill(rows);
}

/**
 * From `crm-tick` (and, on your machine, after each request): sends what is due in the backlog,
 * within this minute's share of the rate, urgent jobs first (`priority`, then the order they came
 * in). Bounded; rows are removed only once the platform took them, set aside (`failedAt`) when it
 * refused them for good, and never deleted for their age.
 */
export async function drainBacklog(db: Db, limit = MAX_BATCH) {
  const due = await db.jobBacklog.findMany({
    where: {failedAt: null, runAt: {lte: new Date()}},
    orderBy: [{priority: 'asc'}, {runAt: 'asc'}, {createdAt: 'asc'}],
    take: Math.min(limit, MAX_BATCH),
    select: {id: true, list: true, data: true, key: true, attempts: true},
  });
  if (!due.length) return 0;
  const granted = runsJobsLocally() ? due.length : await reserve(db, due.length).catch(() => 0);
  const batch = due.slice(0, granted);
  const waiting = due.slice(granted);
  if (waiting.length) await db.jobBacklog.updateMany({where: {id: {in: waiting.map((r) => r.id)}}, data: {runAt: nextMinute(), lastError: RATE_WAIT}});
  if (!batch.length) return 0;

  const outcomes = await deliver(batch.map(fromRow));
  const sent: string[] = [];
  const pushed = new Map<string, {ids: string[]; until: Date; reason: string}>();
  const now = new Date();
  for (const [i, o] of outcomes.entries()) {
    const row = batch[i]!;
    if (o.state === 'sent') sent.push(row.id);
    else if (o.state === 'failed') {
      await db.jobBacklog.update({where: {id: row.id}, data: {failedAt: now, lastError: o.reason, attempts: {increment: 1}}});
    } else if (!o.counts) {
      const k = `${o.until.getTime()}|${o.reason}`;
      const group = pushed.get(k) ?? {ids: [], until: o.until, reason: o.reason};
      group.ids.push(row.id);
      pushed.set(k, group);
    } else {
      // Another failure (the platform did not answer…): tries are capped, then the row is set aside.
      const attempts = row.attempts + 1;
      await db.jobBacklog.update({
        where: {id: row.id},
        data: {attempts, lastError: o.reason, ...(attempts >= MAX_BACKLOG_ATTEMPTS ? {failedAt: now} : {runAt: backoff(attempts)})},
      });
    }
  }
  for (const g of pushed.values()) await db.jobBacklog.updateMany({where: {id: {in: g.ids}}, data: {runAt: g.until, lastError: g.reason}});
  if (outcomes.some((o) => o.state === 'wait' && o.rate)) await markFull(db);
  // Sent first, removed after: a crash in between sends a job twice (handlers are safe to repeat), never zero times.
  if (sent.length) await db.jobBacklog.deleteMany({where: {id: {in: sent}}});
  return sent.length;
}

/** What Settings → Webhooks shows about the jobs waiting here (capped counts, never count()). */
export async function backlogStatus(db: Db, cap: number) {
  const [waiting, failed, rate, perMinute] = await Promise.all([
    db.jobBacklog.findMany({where: {failedAt: null}, select: {id: true}, take: cap}),
    db.jobBacklog.findMany({where: {failedAt: {not: null}}, select: {id: true}, take: cap}),
    db.jobBacklog.findMany({where: {failedAt: null, lastError: {startsWith: RATE_WAIT}}, select: {id: true}, take: cap}),
    jobsPerMinute(db),
  ]);
  return {waiting: waiting.length, failed: failed.length, rateLimited: rate.length, perMinute};
}

// ─── Running (the platform delivers; src/server/background.ts registers these) ───

/** The platform handler of one Kinroot job type (its list is `listOf(type)`). */
export function crmJob(type: JobType) {
  return (data: unknown, job: JobInfo) =>
    runJob(async (db) => {
      const handler: Handler = HANDLERS[type];
      await handler(db, (data ?? {}) as Record<string, unknown>, {id: job.id, attempts: job.attempt, maxAttempts: job.maxAttempts});
    });
}

/**
 * Runs Kinroot work outside a request (a job or a schedule): the Site Database, an outbox for
 * the jobs it queues, and the old runner's "refused = fails now" rule as `DontRetry`.
 */
export async function runJob(work: (db: Db) => Promise<void>) {
  const db = getDb();
  if (!db) throw new Error('The Site Database is off.');
  try {
    await withOutbox(() => work(db));
  } catch (e) {
    // A refused request (e.g. a provider's 4xx) fails now; retrying can't fix it.
    if ((e as {permanent?: boolean}).permanent === true) throw new DontRetry((e as Error).message);
    throw e;
  }
}

// ─── Schedules: steps and clean-ups ─────────────────────────────────────────

/**
 * One step of a schedule (`crm-tick`, `crm-sync`, `crm-prune`): its own try/catch, so one failure
 * never skips the steps after it, and the time it may use (`until`, within the run's deadline).
 * The log names the step and the message only.
 */
export async function runStep<T>(name: string, deadline: number, work: (until: number) => Promise<T>, capMs = Infinity): Promise<T | {error: string} | {skipped: string}> {
  const left = deadline - Date.now();
  if (left < 1_000) return {skipped: 'out of time'};
  try {
    return await work(Date.now() + Math.min(capMs, left));
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 200);
    console.error(`[jobs] ${name}: ${message}`);
    return {error: message};
  }
}


/**
 * Keeps tables small: job backlog rows set aside after 30 days (waiting ones are never deleted),
 * events (and deliveries) after 90, abandoned form / chat uploads and rate-limit hits after 1,
 * recycle-bin entries after 30 (with their files), audit entries after the retention set in Settings → Audit log,
 * finished automation runs and scheduled report sends after 90, import / export files after 7 (see io-prune.ts),
 * incoming webhook and Data in requests after 30 (Data in idempotency keys after 1, used signatures after 10 minutes),
 * expired automation run locks after a day.
 * Each part is a step of its own within `deadline`; big tables go in chunks.
 */
export async function pruneJobs(db: Db, deadline = Date.now() + 45_000) {
  const day = 86_400_000;
  const steps: [string, (until: number) => Promise<unknown>][] = [
    // Uploads never confirmed, and form / chat uploads never sent: their rows and their stored bytes.
    ['files', () => purgeFiles(db, {OR: [{ready: false}, {purpose: {in: ['form_pending', 'chat_pending']}}], createdAt: {lt: new Date(Date.now() - day)}})],
    ['rate hits', (until) => pruneRateHits(db, until)],
    [
      'job backlog',
      (until) => {
        const cut = new Date(Date.now() - FAILED_KEEP_DAYS * day);
        return deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "JobBacklog" WHERE id IN (SELECT id FROM "JobBacklog" WHERE "failedAt" < ${cut} LIMIT ${n})`);
      },
    ],
    [
      'events',
      (until) => {
        const cut = new Date(Date.now() - 90 * day);
        return deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "Event" WHERE id IN (SELECT id FROM "Event" WHERE "createdAt" < ${cut} LIMIT ${n})`);
      },
    ],
    ['recycle bin', (until) => purgeExpiredBin(db, until)],
    ['audit log', (until) => pruneAudit(db, until)],
    ['automations', (until) => pruneAutomations(db, until)],
    ['imports and exports', () => pruneImportExport(db)],
    ['report sends', (until) => pruneScheduleSends(db, until)],
    ['incoming webhooks', (until) => pruneIncomingRequests(db, REQUEST_KEEP_DAYS, until)],
    ['data in', (until) => pruneDataIn(db, until)],
  ];
  const out: Record<string, unknown> = {};
  for (const [name, work] of steps) out[name] = await runStep(`prune ${name}`, deadline, work);
  return out;
}
