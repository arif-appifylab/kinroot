import {AsyncLocalStorage} from 'node:async_hooks';

import type {Prisma} from '../../../generated/prisma/client';
import {DontRetry, JobRejected, runsJobsLocally, sendJobs, type JobInfo, type SendOptions} from '../../../platform/background';
import {config as site} from '../../../platform/config';
import {getDb} from '../../../platform/db';
import {forwardReply} from '../email/replies';
import {formAfterSubmit} from './form-emails';
import {checkSla} from './ticket-sla';
import {sendCsat} from './tickets';
import {bookingEmail, bookingReminder} from '../scheduling/emails';
import {deliverWebhook} from './webhooks';
import {sendBroadcastBatch, startBroadcast} from './broadcasts';
import {recalcJob, rescoreContacts, scoreEvents} from './scoring';
import {pruneAudit} from './audit';
import {scanDuplicates} from './duplicates';
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
 * Kinroot code queues work exactly as before, `enqueue(db, 'webhook.deliver', {deliveryId})`; each
 * job type is a platform list (`crm-webhook-deliver`, see `listOf`) whose handler is registered in
 * src/server/background.ts. Jobs queued during a request (or a job run) are collected and sent
 * together when it ends (`withOutbox`), so a job never starts before the transaction that queued
 * it has committed, and one request makes one send call. A send the platform refuses lands in
 * `JobBacklog` and the `crm-tick` schedule sends it again: no work is lost.
 */
type Handler = (db: Db, payload: Record<string, unknown>, job: JobRun) => Promise<void>;

const HANDLERS = {
  'webhook.deliver': (db, p, job) => deliverWebhook(db, String(p.deliveryId), job.attempts >= job.maxAttempts),
  'form.after_submit': (db, p) => formAfterSubmit(db, String(p.submissionId)),
  'ticket.sla_check': (db, p) => checkSla(db, p),
  'ticket.csat': (db, p) => sendCsat(db, p),
  'email.forward_reply': (db, p) => forwardReply(db, String(p.messageId), String(p.origin ?? '')),
  'booking.email': (db, p) => bookingEmail(db, p as Parameters<typeof bookingEmail>[1]),
  'booking.reminder': (db, p) => bookingReminder(db, p as Parameters<typeof bookingReminder>[1]),
  'broadcast.start': (db, p) => startBroadcast(db, p),
  'broadcast.batch': (db, p) => sendBroadcastBatch(db, p),
  'scoring.events': (db, p) => scoreEvents(db, Array.isArray(p.eventIds) ? p.eventIds.map(String) : []),
  'scoring.rescore': async (db, p) => void (await rescoreContacts(db, Array.isArray(p.contactIds) ? p.contactIds.map(String) : [])),
  'scoring.recalc': (db, p) => recalcJob(db, {runId: String(p.runId), after: typeof p.after === 'string' ? p.after : null}),
  'duplicates.scan': async (db, p) => void (await scanDuplicates(db, p.entity === 'company' ? 'company' : 'contact')),
  'automation.events': (db, p) => matchEvents(db, Array.isArray(p.eventIds) ? p.eventIds.map(String) : [], (p.origin ?? null) as Origin | null),
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
export const listOf = (type: JobType) => `crm-${type.replace(/[._]/g, '-')}`;

// ─── Queueing ───────────────────────────────────────────────────────────────

type Outgoing = {list: string; data: Prisma.InputJsonObject} & Pick<SendOptions, 'at' | 'key' | 'label'>;
type Outbox = {jobs: Outgoing[]};

const outboxes = new AsyncLocalStorage<Outbox>();

/**
 * Queues a job. `runAt` = not before then (up to a year ahead); `key` = at most one such job
 * waiting (the platform's dedupe). Tries per job come from its list (background.json);
 * `maxAttempts` is accepted for the call sites written for Kinroot's old runner and ignored.
 * The `db` argument is kept for those call sites too: nothing is written through it.
 */
export async function enqueue(
  _db: Db,
  type: JobType,
  payload: Prisma.InputJsonObject,
  opts: {runAt?: Date; maxAttempts?: number; key?: string} = {},
) {
  const job: Outgoing = {list: listOf(type), data: payload, ...(opts.runAt ? {at: opts.runAt} : {}), ...(opts.key ? {key: opts.key} : {})};
  const outbox = outboxes.getStore();
  if (outbox) outbox.jobs.push(job);
  else await flush([job]);
}

/** Kept for the call sites written for Kinroot's old runner: sending happens when the request ends. */
export function kickJobs() {}

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

/** Never throws: what is not sent waits in `JobBacklog` for the next `crm-tick`. */
async function flush(jobs: Outgoing[]) {
  const local = runsJobsLocally();
  // Locally the platform runs a job the moment it is sent; jobs planned for later wait here instead.
  const later = local ? jobs.filter((j) => j.at && new Date(j.at).getTime() > Date.now() + 1000) : [];
  const now = jobs.filter((j) => !later.includes(j));
  if (later.length) await spill(later, null);
  for (let k = 0; k < now.length; k += 100) {
    const batch = now.slice(k, k + 100);
    try {
      await sendJobs(origin(), batch);
    } catch (e) {
      const reason = e instanceof JobRejected ? `${e.code}: ${e.message}` : (e as Error).message;
      console.warn(`[jobs] ${batch.length} job(s) not sent (${reason}); kept for the next crm-tick`);
      await spill(batch, reason);
    }
  }
}

async function spill(jobs: Outgoing[], reason: string | null) {
  const db = getDb();
  if (!db) return console.error(`[jobs] ${jobs.length} job(s) lost: no Site Database`);
  try {
    await db.jobBacklog.createMany({
      data: jobs.map((j) => ({
        list: j.list,
        data: j.data,
        runAt: j.at ? new Date(j.at) : new Date(),
        key: j.key ?? null,
        lastError: reason,
      })),
    });
  } catch (e) {
    console.error(`[jobs] ${jobs.length} job(s) lost: ${(e as Error).message}`);
  }
}

/**
 * From `crm-tick` (and, on your machine, after each request): sends what is due in the backlog.
 * Bounded; rows are removed only once the platform took them.
 */
export async function drainBacklog(db: Db, limit = 100) {
  const due = await db.jobBacklog.findMany({where: {runAt: {lte: new Date()}}, orderBy: {runAt: 'asc'}, take: limit});
  if (!due.length) return 0;
  const jobs = due.map((r) => ({list: r.list, data: r.data as Prisma.InputJsonObject, ...(r.key ? {key: r.key} : {})}));
  try {
    await sendJobs(origin(), jobs);
  } catch (e) {
    const reason = e instanceof JobRejected ? `${e.code}: ${e.message}` : (e as Error).message;
    await db.jobBacklog.updateMany({where: {id: {in: due.map((r) => r.id)}}, data: {attempts: {increment: 1}, lastError: reason.slice(0, 500)}});
    return 0;
  }
  // Sent first, removed after: a crash in between sends a job twice (handlers are safe to repeat), never zero times.
  await db.jobBacklog.deleteMany({where: {id: {in: due.map((r) => r.id)}}});
  return due.length;
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

/**
 * Keeps tables small: the job backlog after 7 days, events (and deliveries) after 90, abandoned form / chat uploads and rate-limit hits after 1,
 * recycle-bin entries after 30 (with their files), audit entries after the retention set in Settings → Audit log,
 * finished automation runs and scheduled report sends after 90, import / export files after 7 (see io-prune.ts),
 * incoming webhook and Data in requests after 30 (Data in idempotency keys after 1, used signatures after 10 minutes).
 */
export async function pruneJobs(db: Db) {
  const day = 86_400_000;
  // Uploads never confirmed, and form / chat uploads never sent: their rows and their stored bytes.
  await purgeFiles(db, {OR: [{ready: false}, {purpose: {in: ['form_pending', 'chat_pending']}}], createdAt: {lt: new Date(Date.now() - day)}});
  await pruneRateHits(db);
  await db.jobBacklog.deleteMany({where: {createdAt: {lt: new Date(Date.now() - 7 * day)}}});
  await db.event.deleteMany({where: {createdAt: {lt: new Date(Date.now() - 90 * day)}}});
  await purgeExpiredBin(db);
  await pruneAudit(db);
  await pruneAutomations(db);
  await pruneImportExport(db);
  await pruneScheduleSends(db);
  await pruneIncomingRequests(db, REQUEST_KEEP_DAYS);
  await pruneDataIn(db);
}
