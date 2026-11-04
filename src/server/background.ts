import {defineBackground} from '../platform/background';
import {crmJob, runJob} from './crm/lib/jobs';
import {crmPrune, crmSync, crmTick} from './crm/lib/ticks';

/**
 * This site's BACKGROUND JOBS: one handler per list (docs/agent/background-jobs.md).
 *
 *   send:      sendJob(c.req.url, 'booking-reminders', {bookingId}, {at, key: `remind-${id}`, label})
 *   schedule:  background.json  {"schedules": {"daily-summary": {"every": "day", "at": "07:00", "tz": "Europe/London"}}}
 *
 * A handler gets the job's data (JSON) and returns when done. Throw to try again later;
 * throw `DontRetry` (from ../platform/background) when trying again cannot help. It may run more
 * than once: make it safe to repeat. Load what you need by id from the Site Database here; never
 * put a whole record (or a secret) in the data.
 *
 * Kinroot: one list per job type (`crm-…`, src/server/crm/lib/jobs.ts) and three schedules
 * (src/server/crm/lib/ticks.ts; no retries, one at a time). Each list is written out: the platform
 * checks this file's keys.
 */
export const background = defineBackground({
  'crm-webhook-deliver': crmJob('webhook.deliver'),
  'crm-form-after-submit': crmJob('form.after_submit'),
  'crm-ticket-sla-check': crmJob('ticket.sla_check'),
  'crm-ticket-csat': crmJob('ticket.csat'),
  'crm-email-forward-reply': crmJob('email.forward_reply'),
  'crm-email-sync-account': crmJob('email.sync_account'),
  'crm-calendar-sync-connection': crmJob('calendar.sync_connection'),
  'crm-booking-email': crmJob('booking.email'),
  'crm-booking-reminder': crmJob('booking.reminder'),
  'crm-broadcast-start': crmJob('broadcast.start'),
  'crm-broadcast-batch': crmJob('broadcast.batch'),
  'crm-scoring-events': crmJob('scoring.events'),
  'crm-scoring-rescore': crmJob('scoring.rescore'),
  'crm-scoring-recalc': crmJob('scoring.recalc'),
  'crm-duplicates-scan': crmJob('duplicates.scan'),
  'crm-duplicates-check': crmJob('duplicates.check'),
  'crm-automation-events': crmJob('automation.events'),
  'crm-automation-run': crmJob('automation.run'),
  'crm-automation-batch': crmJob('automation.batch'),
  'crm-import-validate': crmJob('import.validate'),
  'crm-import-run': crmJob('import.run'),
  'crm-export-run': crmJob('export.run'),
  'crm-report-send': crmJob('report.send'),
  'crm-inbox-wake': crmJob('inbox.wake'),
  'crm-chat-email-visitor': crmJob('chat.email_visitor'),
  'crm-incoming-webhook-process': crmJob('incoming_webhook.process'),
  'crm-tick': () => runJob(async db => void (await crmTick(db))),
  'crm-sync': () => runJob(async db => void (await crmSync(db))),
  'crm-prune': () => runJob(async db => void (await crmPrune(db))),
});
