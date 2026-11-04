/**
 * Scheduled report emails, shared by the drawer, the "Scheduled emails" tab
 * and the server (src/server/lib/report-schedules.ts). A schedule emails one
 * saved report or a whole dashboard daily, weekly or monthly at a wall-clock
 * time in its own time zone. Keep this file free of React and server imports.
 */
import {z} from 'zod';

export const SCHEDULE_FREQUENCIES = {daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'} as const;
export type ScheduleFrequency = keyof typeof SCHEDULE_FREQUENCIES;

/** 0 = Sunday, like Date#getDay(). Pickers list Monday first. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const SCHEDULE_RANGES = {
  report: "The report's own date range",
  previous: 'The period since the last send',
} as const;
export type ScheduleRange = keyof typeof SCHEDULE_RANGES;

export const SCHEDULE_STATUS = {
  sent: 'Sent',
  partial: 'Partly sent',
  failed: 'Failed',
  no_mailbox: 'No mailbox to send from',
} as const;
export type ScheduleStatus = keyof typeof SCHEDULE_STATUS;

export const MAX_RECIPIENTS = 20;
/** Failed sends in a row (after retries) before a schedule pauses itself. */
export const PAUSE_AFTER_FAILURES = 3;
/** Grouped results show this many rows in the email; the CSV has all of them. */
export const EMAIL_TOP_ROWS = 10;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'pick a time');

export const scheduleTimingSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  weekday: z.number().int().min(0).max(6).nullish(),
  monthDay: z.number().int().min(-1).max(31).nullish(),
  time,
  timezone: z.string().trim().min(1).max(64),
});
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

const fields = {
  userIds: z.array(z.string().max(40)).max(MAX_RECIPIENTS),
  emails: z.array(z.email('enter valid email addresses').max(200)).max(MAX_RECIPIENTS),
  subject: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(2000).nullish(),
  range: z.enum(['report', 'previous']),
  active: z.boolean(),
};

export const scheduleBodySchema = scheduleTimingSchema.extend({
  reportId: z.string().max(40).nullish(),
  dashboardId: z.string().max(40).nullish(),
  ...fields,
  userIds: fields.userIds.default([]),
  emails: fields.emails.default([]),
  range: fields.range.default('report'),
  active: fields.active.default(true),
});
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

/** PATCH: only the fields sent (no defaults, so a partial update never resets recipients). The target never changes. */
export const schedulePatchSchema = scheduleTimingSchema.extend(fields).partial();

/** Rules zod can't say per field: the first problem and the field it is about (null: not one field), or null. */
export function scheduleIssue(b: Partial<ScheduleBody>): {field: 'weekday' | 'monthDay' | 'userIds' | null; message: string} | null {
  if (!!b.reportId === !!b.dashboardId) return {field: null, message: 'Pick a report or a dashboard'};
  if (b.frequency === 'weekly' && (b.weekday === null || b.weekday === undefined)) return {field: 'weekday', message: 'Pick a weekday'};
  if (b.frequency === 'monthly' && (!b.monthDay || b.monthDay < -1)) return {field: 'monthDay', message: 'Pick a day of the month'};
  const count = new Set([...(b.userIds ?? []), ...(b.emails ?? []).map((e) => e.toLowerCase())]).size;
  if (!count) return {field: 'userIds', message: 'Add at least one recipient'};
  if (count > MAX_RECIPIENTS) return {field: 'userIds', message: `Up to ${MAX_RECIPIENTS} recipients`};
  return null;
}

/** scheduleIssue()'s words only. */
export const scheduleProblem = (b: Partial<ScheduleBody>): string | null => scheduleIssue(b)?.message ?? null;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** "Every Monday at 09:00 (Europe/Berlin)". */
export function describeSchedule(s: Pick<ScheduleTiming, 'weekday' | 'monthDay' | 'time' | 'timezone'> & {frequency: string}, {zone = true} = {}) {
  const when =
    s.frequency === 'daily'
      ? 'Every day'
      : s.frequency === 'weekly'
        ? `Every ${WEEKDAYS[s.weekday ?? 1]}`
        : s.monthDay === -1
          ? 'On the last day of every month'
          : `On the ${ordinal(s.monthDay ?? 1)} of every month`;
  return `${when} at ${s.time}${zone ? ` (${s.timezone})` : ''}`;
}
