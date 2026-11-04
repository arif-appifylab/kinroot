import {queueCalendarSyncs} from '../calendar/service';
import {queueMailboxSyncs} from '../email/sync';
import {inboxTick} from '../inbox/conversations';
import type {Db} from '../kit/db';
import {automationTick} from './automations';
import {scheduleDuplicateScans} from './duplicates';
import {drainBacklog, pruneJobs, runStep} from './jobs';
import {reportScheduleTick} from './report-schedules';
import {scoringTick} from './scoring';

/** Settings → Webhooks shows when the background work last ran. */
export const JOBS_LAST_RUN_KEY = 'jobs.lastRun';

/** A schedule run has 60 seconds; its steps share this much, leaving room to send the jobs they queued. */
const DEADLINE_MS = 45_000;
const SECOND = 1000;

/**
 * The work Kinroot's old job runner did, split over three PLATFORM schedules (background.json;
 * handlers in src/server/background.ts; no retries and one at a time, so a slow minute never
 * overlaps the next):
 *
 *   crm-tick   every minute     backlog, scoring decay, date / inactivity automations,
 *                               scheduled report emails, snoozed conversations, duplicate scans due
 *   crm-sync   every 5 minutes  one job per Gmail / Outlook mailbox and per calendar
 *   crm-prune  daily            retention clean-ups
 *
 * Each step runs on its own (one that fails is logged by name and the rest go on), within a shared
 * deadline and its own cap.
 */
export async function crmTick(db: Db, deadline = Date.now() + DEADLINE_MS) {
  const backlog = await runStep('backlog', deadline, () => drainBacklog(db), 8 * SECOND);
  const scoring = await runStep('scoring', deadline, (until) => scoringTick(db, until - Date.now()), 8 * SECOND);
  const automations = await runStep('automations', deadline, (until) => automationTick(db, {until}), 12 * SECOND);
  const reportEmails = await runStep('report emails', deadline, (until) => reportScheduleTick(db, Date.now(), until), 5 * SECOND);
  const inbox = await runStep('inbox', deadline, (until) => inboxTick(db, {until}), 8 * SECOND);
  const duplicates = await runStep('duplicate scans', deadline, () => scheduleDuplicateScans(db), 2 * SECOND);
  const at = new Date().toISOString();
  await runStep('last run', deadline + 5 * SECOND, () => db.setting.upsert({where: {key: JOBS_LAST_RUN_KEY}, create: {key: JOBS_LAST_RUN_KEY, value: at}, update: {value: at}}));
  return {backlog, scoring, automations, reportEmails, inbox, duplicates};
}

/** Queues the syncs: one keyed job per mailbox and per calendar connection (each has its own 60 seconds). */
export async function crmSync(db: Db, deadline = Date.now() + DEADLINE_MS) {
  return {
    email: await runStep('mailbox syncs', deadline, () => queueMailboxSyncs(db)),
    calendar: await runStep('calendar syncs', deadline, () => queueCalendarSyncs(db)),
  };
}

export async function crmPrune(db: Db, deadline = Date.now() + DEADLINE_MS) {
  return runStep('prune', deadline, (until) => pruneJobs(db, until));
}
