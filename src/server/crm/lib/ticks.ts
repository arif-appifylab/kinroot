import {syncAllCalendars} from '../calendar/service';
import {syncAll} from '../email/sync';
import {inboxTick} from '../inbox/conversations';
import type {Db} from '../kit/db';
import {automationTick} from './automations';
import {scheduleDuplicateScans} from './duplicates';
import {drainBacklog, pruneJobs} from './jobs';
import {reportScheduleTick} from './report-schedules';
import {scoringTick} from './scoring';

/** Settings → Webhooks shows when the background work last ran. */
export const JOBS_LAST_RUN_KEY = 'jobs.lastRun';

/**
 * The work Kinroot's old `POST /site-api/crm/jobs/run` did, split over three PLATFORM schedules
 * (background.json; handlers in src/server/background.ts):
 *
 *   crm-tick   every minute     backlog, scoring decay, date / inactivity automations,
 *                               scheduled report emails, snoozed conversations
 *   crm-sync   every 5 minutes  Gmail / Outlook mailboxes and calendars
 *   crm-prune  daily            retention clean-ups and duplicate scans
 *
 * Each step is bounded, as before; a run has 60 seconds.
 */
export async function crmTick(db: Db) {
  const backlog = await drainBacklog(db);
  const scoring = await scoringTick(db);
  const automations = await automationTick(db);
  const reportEmails = await reportScheduleTick(db);
  const inbox = await inboxTick(db);
  const at = new Date().toISOString();
  await db.setting.upsert({where: {key: JOBS_LAST_RUN_KEY}, create: {key: JOBS_LAST_RUN_KEY, value: at}, update: {value: at}});
  return {backlog, scoring, automations, reportEmails, inbox};
}

export async function crmSync(db: Db) {
  return {email: await syncAll(db), calendar: await syncAllCalendars(db)};
}

export async function crmPrune(db: Db) {
  await pruneJobs(db);
  await scheduleDuplicateScans(db);
}
