import {defineBackground} from '../platform/background';

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
 */
export const background = defineBackground({
  // 'booking-reminders': async ({bookingId}, job) => { ... },
});
