---
title: Background jobs: queues, delays, ordered lists and schedules
read-when: before anything that happens outside the visitor's request: later, on a timetable, in order, with retries (reminders, follow-ups, receipts, summaries, cleanups, imports, processing)
---
The platform runs this site's background jobs. It keeps every job, calls this site back when it is
due, tries again when it fails, keeps what didn't work, and shows the owner every run in the Jobs
tab (history, charts, run again). Nothing to set up, no key or secret to ask for, nothing to
install. Not the `/jobs` job board (that is site data in the Site Database).

## Pick the kind
| You need | Use | Starts |
| --- | --- | --- |
| Do it now, but not in the visitor's request (receipt, sync, processing) | `sendJob(url, list, data)` | within ~1–2 s |
| Do it later (a reminder before a booking, a follow-up in 2 days) | `sendJob(…, {at})` or `{delay: seconds}` | at that time (≤ 1 year) |
| Do it on a timetable (every morning at 7, every Monday) | a schedule in `background.json` | at each time, in its time zone |
| Do things one at a time, in order (per customer, per order) | an ordered list (`"ordered": true`) + `{group}` | in send order per group |
| Big work (an import of 10,000 rows) | many small jobs (`sendJobs`, ≤ 100 a call) | in parallel, each retried alone |

## The three pieces
| Piece | File | Who edits |
| --- | --- | --- |
| Handlers: what a job does | `src/server/background.ts` (`defineBackground({...})`) | you |
| Schedules + list settings | `background.json` (repo root) | you |
| Sending, delivery, signature, local runs | `src/platform/background.ts` | MANAGED, never edit |

## Send (from a Site API route)
```ts
import {sendJob, sendJobs, cancelJob, JobRejected} from '../../platform/background';

// later: 24 h before the booking; the key makes a second send return the first job
await sendJob(c.req.url, 'booking-reminders', {bookingId: booking.id}, {
  at: new Date(booking.startsAt.getTime() - 24 * 3600_000),
  key: `remind-${booking.id}`,
  label: `Reminder · ${booking.service}, ${booking.startsAt.toISOString().slice(0, 16)}`,
});
// now (no option), or after a delay in seconds
await sendJob(c.req.url, 'receipts', {orderId: order.id});
await sendJob(c.req.url, 'follow-ups', {bookingId: booking.id}, {delay: 2 * 24 * 3600});
// many at once (all or none accepted)
await sendJobs(c.req.url, rows.map(r => ({list: 'import-rows', data: {rowId: r.id}})));
// ordered: one at a time per customer, in send order
await sendJob(c.req.url, 'payments', {paymentId: p.id}, {group: `customer-${p.customerId}`});
// booking cancelled → cancel its reminder (only a waiting job can be cancelled)
await cancelJob(c.req.url, {list: 'booking-reminders', key: `remind-${booking.id}`});
```
- `data`: JSON up to 32 KB. Send ids; load the record in the handler. Never secrets, tokens or
  passwords (the owner sees the data of a job that didn't work).
- `label`: what the owner reads in the Jobs tab. Short, human, no personal data beyond a first name.
- `key`: dedupe (a resend returns the first job, `deduplicated: true`) for as long as that job
  waits, and for 24 h after it was sent once it ran; also what `cancelJob` finds a job by, however
  far ahead it was sent. Use one for anything a visitor's double click could send twice.
- `at` in the past runs now. `at` / `delay` up to 1 year. Times are kept to the minute: a job due
  less than 60 s ahead runs now (never use a short delay to pace work; jobs run one by one anyway).
- A refused send throws `JobRejected` (`code`): answer the visitor with a normal error; never loop.

| `code` | Means | Fix |
| --- | --- | --- |
| `E_JOBS_BAD_LIST` | list name not `a-z0-9-` (≤ 63) | rename the list |
| `E_JOBS_PAYLOAD_TOO_LARGE` | data over 32 KB | send ids |
| `E_JOBS_BAD_TIME`, `E_JOBS_TOO_FAR` | `at` not ISO, `delay` not seconds, over 1 year | fix the time |
| `E_JOBS_KEY`, `E_JOBS_GROUP`, `E_JOBS_LABEL` | over the length limit | shorten |
| `E_JOBS_BATCH_TOO_LARGE` | more than 100 in `sendJobs` | split |
| `E_JOBS_TOO_MANY_LISTS` | a new list past 100 per site | reuse a list; put the variety in `data` (never one list per user or record) |
| `E_JOBS_BACKLOG`, `E_JOBS_SITE_BACKLOG` | 50,000 waiting in one list, 200,000 in the site | stop sending; find out why jobs are not running (Jobs tab) |
| `E_JOBS_RATE_LIMITED` (429) | the site added more jobs this minute than its limit (default 10 a minute; the owner can raise it in the Jobs tab) | send fewer: one job per real event, never in a loop; `Retry-After` says when the minute turns. If the site truly needs more, tell the owner to raise the limit |
| `E_JOBS_PAUSED` (423) | the platform paused this site's jobs because something looked wrong (a flood of sends, almost every run failing) | find and fix the cause; the owner resumes jobs in the Jobs tab |
| `E_TOO_MANY_REQUESTS` (429) | more than 300 send calls a minute | batch with `sendJobs` (100 a call) |
| `E_JOBS_BACKLOG` | 50,000 jobs already waiting in that list | something is not running: tell the owner |
| `E_JOBS_UNREACHABLE` | The platform did not answer | nothing was sent; try again |

## Handle (`src/server/background.ts`)
```ts
import {defineBackground, DontRetry} from '../platform/background';
import {getDb} from '../platform/db';

export const background = defineBackground({
  'booking-reminders': async ({bookingId}, job) => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');            // tried again later
    const booking = await db.booking.findUnique({where: {id: bookingId}, select: {id: true, status: true, remindedAt: true}});
    if (!booking || booking.status === 'cancelled') return;          // nothing to do = done
    if (booking.remindedAt) return;                                   // ran before: safe to repeat
    // ... the work (database writes, a relayed email to the owner, …)
    await db.booking.update({where: {id: booking.id}, data: {remindedAt: new Date()}});
  },
});
```
- **Return = done. Throw = try again later** (1 min, 2 min, 10 min, 1 h; 5 tries by default).
  `throw new DontRetry('Phone number is missing')` when trying again cannot help: it fails now.
  Your message is shown to the owner: words for people, never stack traces or secrets.
- **At-least-once:** a job MAY run twice (a lost answer, a retry). Make every handler safe to
  repeat: check a column (`remindedAt`), use `job.id`, upsert instead of insert.
- **60 seconds per run**, and the Worker's normal limits (bounded queries, `performance.md`). Never
  wait inside a handler (`setTimeout`, polling): send another job with a `delay`.
- **Big work:** one job per item, or a job that handles 100 items and sends the next one with the
  cursor. Each piece retries on its own.
- `job` = `{id, list, attempt, maxAttempts, scheduledFor, group, local}`.
- **Reach:** a job can do database work, platform calls (relayed emails to the owner) and calls
  to public APIs with an owner's key (`security.md` › Calling other services), each with a
  timeout well inside the 60 seconds. The platform's internal network is never reachable.

## Lists, ordered lists and schedules (`background.json`)
```json
{
  "lists": {
    "booking-reminders": {"retries": 4, "concurrency": 5},
    "payments": {"ordered": true, "retries": 9}
  },
  "schedules": {
    "daily-summary": {"every": "day", "at": "07:00", "tz": "Europe/London", "label": "Morning bookings email"},
    "weekly-report": {"list": "reports", "every": "week", "day": 1, "at": "08:30", "tz": "Europe/London"},
    "cleanup":       {"list": "cleanup", "cron": "0 3 * * 0", "data": {"keepDays": 30}}
  }
}
```
- **A list** exists as soon as a job is sent to it (default: 5 tries, the site's concurrency).
  `retries` 0–9, `concurrency` 1–100 (jobs of that list running at once).
- **An ordered list** (`"ordered": true`) runs one job at a time per `group`, in the order sent. A
  job that is retrying holds its group (later jobs of that group wait); other groups go on. A job
  sent for LATER does not hold jobs of its group that are due before it. An ordered job planned for
  later runs within a minute of its time (normal lists: on time). `group` is any text up to
  128 characters. Use it only when order matters (money, a state machine per record): it is slower
  than a normal list.
- **A schedule** sends one job to its `list` (default: its own name) at each time, with its `data`.
  `every`: minute, hour, day, weekday, week (`day` 0 = Sunday … 6), month (the 1st). Or a 5-field
  `cron` with a day of the month OR a weekday, not both (two schedules instead). `tz` is an IANA
  zone (default UTC). Avoid 01:00–03:00 local: summer time skips or repeats that hour.
- Schedules change when the owner PUBLISHES. A bad file fails the publish with every problem
  listed. Check first: `npm run platform -- jobs` (also checks every list has a handler).
  The plan limits how many schedules a site has. The owner can pause schedules and lists in the
  Jobs tab; a publish keeps their choice.

## Limits
| | |
| --- | --- |
| Data per job | 32 KB |
| Delay / `at` | up to 1 year |
| Run time | 60 s |
| Tries | 1–10 per list (default 5) |
| Running at once | per site, by plan: App 10, Business and agency plans 50, Agency SaaS 100 (each list may set less); more wait their turn |
| Lists per site | 100 |
| Waiting per site | 200,000 |
| Jobs added per minute | 10 by default; the owner can raise it to 50, more on request. Retries, schedules and the owner's Run again do not count. A batch over the limit is refused whole |
| Send calls per minute | 300 |
| Waiting per list | 50,000 |
| Send batch | 100 |
| Dedupe window | while the job waits, and 24 h after it was sent |

## In the editor Preview and on your machine
Jobs run LOCALLY: `sendJob` runs the handler right away, in this process, once, and logs
`[jobs] <list> <id> done …` or `failed …` with what the live site would do (when, how many tries).
Nothing is sent to the platform and no key is needed. Schedules do not tick locally: test a schedule
by sending its list a job yourself. Only the live site's jobs appear in the owner's Jobs tab.

## What the owner sees (say it in your summary)
The Jobs tab: runs this month against the plan, a 30-day chart, what is coming up, schedules and
lists (pause, resume, run now), history (search, filters, every try), and "Didn't work" (the
reason, the data, run again one or all, discard). Failures notify the owner at most once an hour.

## Never
- Edit `src/platform/background.ts`, add a route under `/site-api/_platform/`, or check the delivery
  signature yourself (the managed code does).
- `setTimeout`/`setInterval` for later work, a "cron" page someone has to visit, a loop that waits,
  or a queue table you poll: send a job.
- Put a whole record, a secret, a token or a password in a job's data or label.
- Assume a job runs exactly once, or (outside ordered lists) in order.
