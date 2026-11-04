/**
 * Booking links: shapes and slot maths, shared by the editor, the public
 * booking page and the server. Keep this file free of React and server
 * imports. Timezone maths uses Intl only (no tz database to ship).
 */

/** "HH:mm" wall-clock times in the link's timezone; end may be "24:00". */
export type TimeRange = {start: string; end: string};

export type Availability = {
  /** "0" = Sunday … "6" = Saturday. Missing or empty = unavailable. */
  weekly: Record<string, TimeRange[]>;
  /** Specific dates (YYYY-MM-DD) that replace the weekly hours; no ranges = day off. */
  overrides: {date: string; ranges: TimeRange[]}[];
};

export type QuestionMode = 'off' | 'optional' | 'required';
/** Name and email are always asked; these are extra. */
export type BookingQuestions = {phone: QuestionMode; company: QuestionMode; notes: QuestionMode};

export type LocationType = 'VIDEO' | 'PHONE' | 'IN_PERSON' | 'OTHER';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const defaultAvailability = (): Availability => ({
  weekly: Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, [{start: '09:00', end: '17:00'}]])),
  overrides: [],
});

export const defaultQuestions = (): BookingQuestions => ({phone: 'optional', company: 'optional', notes: 'optional'});

export const availabilityOf = (v: unknown): Availability => {
  const a = (v ?? {}) as Partial<Availability>;
  return {weekly: a.weekly ?? defaultAvailability().weekly, overrides: a.overrides ?? []};
};

export const questionsOf = (v: unknown): BookingQuestions => ({...defaultQuestions(), ...((v ?? {}) as Partial<BookingQuestions>)});

/** Handles that would collide with fixed /book/… routes. */
export const RESERVED_HANDLES = ['team', 'manage', 'embed', 'new'];

/** What a booking page needs to know about a link (nothing private). */
export type PublicBookingLink = {
  id: string;
  kind: 'personal' | 'team';
  path: string; // "handle/slug" or "team/slug"
  name: string;
  description: string | null;
  durations: number[];
  locationType: LocationType;
  /** Shown before booking for phone / in person; video links are only sent after. */
  locationLabel: string;
  questions: BookingQuestions;
  hosts: {name: string; color: string; avatarUrl?: string | null}[];
  maxDaysAhead: number;
  active: boolean;
};

export const durationLabel = (min: number) => (min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} hour${min > 60 ? 's' : ''}`);

// ─── Timezones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a timezone. */
function wall(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return {year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second!};
}

/** Minutes the timezone is ahead of UTC at that instant (e.g. +120 for Berlin in summer). */
function tzOffsetMin(ms: number, tz: string) {
  const w = wall(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The instant a wall-clock time happens in a timezone. Across a DST change the
 * offset is re-checked once; a time that doesn't exist (spring forward) lands
 * after the gap, an ambiguous one (fall back) on its first occurrence.
 */
export function zonedTime(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMin(guess, tz) * 60_000;
  const second = guess - tzOffsetMin(first, tz) * 60_000;
  if (first === second) return first;
  // Ambiguous: prefer the earlier instant if it still shows the asked-for wall time.
  const earlier = Math.min(first, second);
  const w = wall(earlier, tz);
  return w.hour === hh % 24 && w.minute === mm ? earlier : Math.max(first, second);
}

/** YYYY-MM-DD of an instant in a timezone. */
export function localDate(ms: number, tz: string) {
  const w = wall(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** "9:30 AM" in a timezone. */
export const timeIn = (ms: number | string | Date, tz: string, opts: Intl.DateTimeFormatOptions = {hour: 'numeric', minute: '2-digit'}) =>
  new Intl.DateTimeFormat('en-US', {timeZone: tz, ...opts}).format(new Date(ms));

/** "Tuesday, October 28, 2026 at 9:30 AM (Europe/Berlin)" */
export const whenIn = (ms: number | string | Date, tz: string) =>
  `${new Intl.DateTimeFormat('en-US', {timeZone: tz, dateStyle: 'full', timeStyle: 'short'}).format(new Date(ms))} (${tz.replace(/_/g, ' ')})`;

// ─── Slots ──────────────────────────────────────────────────────────────────

export type Interval = {start: number; end: number};

export type SlotInput = {
  availability: Availability;
  timezone: string;
  duration: number;
  /** Start times every N minutes; defaults to the duration. */
  step?: number | null;
  bufferBefore?: number;
  bufferAfter?: number;
  minNoticeMin?: number;
  maxDaysAhead?: number;
  dailyLimit?: number | null;
  /** Calendar busy blocks and existing meetings. */
  busy: Interval[];
  /** Existing bookings on this link per local date (link timezone), for the daily limit. */
  bookedPerDay?: Record<string, number>;
  from: number;
  to: number;
  now: number;
};

const overlaps = (a: Interval, b: Interval) => a.start < b.end && a.end > b.start;

/** Open ranges on one local date: an override replaces the weekly hours. */
export function rangesOn(a: Availability, date: string): TimeRange[] {
  const o = a.overrides.find((x) => x.date === date);
  return o ? o.ranges : a.weekly[String(weekdayOf(date))] ?? [];
}

/**
 * Bookable start times (ms, ascending) in [from, to). A slot must fit inside
 * an open range, start after the minimum notice, fall within `maxDaysAhead`
 * days (counted in the host's timezone), keep its buffers clear of every busy
 * block, and its day must be under the daily limit.
 */
export function computeSlots(i: SlotInput): number[] {
  const dur = i.duration * 60_000;
  const step = Math.max(5, i.step || i.duration) * 60_000;
  const before = (i.bufferBefore ?? 0) * 60_000;
  const after = (i.bufferAfter ?? 0) * 60_000;
  const earliest = i.now + (i.minNoticeMin ?? 0) * 60_000;
  const today = localDate(i.now, i.timezone);
  const lastDate = addDays(today, i.maxDaysAhead ?? 60);
  const busy = [...i.busy].sort((a, b) => a.start - b.start);

  const out = new Set<number>();
  // One extra day on each side: the visitor's day can straddle two host days.
  let date = addDays(localDate(Math.max(i.from, i.now), i.timezone), -1);
  const endDate = addDays(localDate(i.to, i.timezone), 1);
  for (let guard = 0; date <= endDate && date <= lastDate && guard < 400; guard++, date = addDays(date, 1)) {
    if (date < today) continue;
    if (i.dailyLimit && (i.bookedPerDay?.[date] ?? 0) >= i.dailyLimit) continue;
    for (const r of rangesOn(i.availability, date)) {
      const rs = zonedTime(date, r.start, i.timezone);
      const re = r.end === '24:00' ? zonedTime(addDays(date, 1), '00:00', i.timezone) : zonedTime(date, r.end, i.timezone);
      for (let t = rs; t + dur <= re; t += step) {
        if (t < earliest || t < i.from || t >= i.to) continue;
        const padded = {start: t - before, end: t + dur + after};
        if (busy.some((b) => overlaps(b, padded))) continue;
        out.add(t);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Problems with a weekly schedule, for the editor. */
export function availabilityError(a: Availability): string | null {
  const check = (ranges: TimeRange[], where: string) => {
    const sorted = [...ranges].sort((x, y) => x.start.localeCompare(y.start));
    for (const [n, r] of sorted.entries()) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(r.end)) return `${where}: use HH:MM times`;
      if (r.end <= r.start) return `${where}: ${r.start}–${r.end} ends before it starts`;
      const next = sorted[n + 1];
      if (next && next.start < r.end) return `${where}: ranges overlap`;
    }
    return null;
  };
  for (const [day, ranges] of Object.entries(a.weekly)) {
    const e = check(ranges, WEEKDAYS[Number(day)] ?? day);
    if (e) return e;
  }
  for (const o of a.overrides) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return 'Date overrides need a date';
    const e = check(o.ranges, o.date);
    if (e) return e;
  }
  return null;
}
