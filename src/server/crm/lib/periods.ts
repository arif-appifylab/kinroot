import {HTTPException} from 'hono/http-exception';

import {RANGE_PRESETS, type Bucket, type DateRange} from '@/lib/reports';

/**
 * Calendar maths in the viewer's time zone (reports, goals, forecast). The
 * browser sends its IANA zone; "this month" starts at local midnight there.
 * Wall-clock dates are plain {y, m, d} (m is 0-based, may overflow: Date.UTC
 * normalises it).
 */
export type Wall = {y: number; m: number; d: number};

export function safeTz(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: tz});
    return tz;
  } catch {
    return 'UTC';
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string, at: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return {y: +p.year!, m: +p.month! - 1, d: +p.day!, h: +p.hour! % 24, min: +p.minute!, s: +p.second!};
}

/** Wall clock minus UTC at an instant, in ms. */
function offsetMs(tz: string, at: number) {
  const p = parts(tz, at);
  return Date.UTC(p.y, p.m, p.d, p.h, p.min, p.s) - Math.floor(at / 1000) * 1000;
}

/** The instant of local midnight on a wall date. */
export function zoned(tz: string, w: Wall): Date {
  const guess = Date.UTC(w.y, w.m, w.d);
  const first = guess - offsetMs(tz, guess);
  return new Date(guess - offsetMs(tz, first)); // second pass settles DST edges
}

export function wallOf(tz: string, at: Date | number = Date.now()): Wall {
  const p = parts(tz, typeof at === 'number' ? at : at.getTime());
  return {y: p.y, m: p.m, d: p.d};
}

const norm = (w: Wall): Wall => {
  const t = new Date(Date.UTC(w.y, w.m, w.d));
  return {y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate()};
};
export const addDays = (w: Wall, n: number) => norm({...w, d: w.d + n});
export const addMonths = (w: Wall, n: number) => norm({y: w.y, m: w.m + n, d: w.d});
const dow = (w: Wall) => new Date(Date.UTC(w.y, w.m, w.d)).getUTCDay();

/** Start of the bucket a wall date falls in (weeks start on Monday, like Postgres). */
export function bucketStart(w: Wall, b: Bucket): Wall {
  if (b === 'day') return w;
  if (b === 'week') return addDays(w, -((dow(w) + 6) % 7));
  if (b === 'month') return {y: w.y, m: w.m, d: 1};
  if (b === 'quarter') return {y: w.y, m: Math.floor(w.m / 3) * 3, d: 1};
  return {y: w.y, m: 0, d: 1};
}

export function nextBucket(w: Wall, b: Bucket): Wall {
  if (b === 'day') return addDays(w, 1);
  if (b === 'week') return addDays(w, 7);
  return addMonths(w, b === 'month' ? 1 : b === 'quarter' ? 3 : 12);
}

const pad = (n: number) => String(n).padStart(2, '0');
export const wallKey = (w: Wall) => `${w.y}-${pad(w.m + 1)}-${pad(w.d)}`;
export function parseKey(key: string): Wall {
  const [y, m, d] = key.split('-').map(Number);
  return {y: y!, m: m! - 1, d: d!};
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function bucketLabel(key: string, b: Bucket) {
  const w = parseKey(key);
  if (b === 'day' || b === 'week') return `${MONTHS[w.m]} ${w.d}, ${w.y}`;
  if (b === 'month') return `${MONTHS[w.m]} ${w.y}`;
  if (b === 'quarter') return `Q${Math.floor(w.m / 3) + 1} ${w.y}`;
  return String(w.y);
}

export type Span = {from: Date | null; to: Date | null};
export type ResolvedRange = Span & {label: string; previous: Span | null};

/** Presets → [from, to) instants in the zone, plus the period before it for comparisons. */
export function resolveRange(range: DateRange | undefined, tz: string, now = Date.now()): ResolvedRange {
  const preset = range?.preset ?? 'all';
  const today = wallOf(tz, now);
  const quarter = bucketStart(today, 'quarter');
  // [from, to) as wall dates, and how to step back one period.
  let span: [Wall, Wall] | null = null;
  let back: {days?: number; months?: number} = {};
  let label = '';
  const days = (n: number) => {
    span = [addDays(today, -(n - 1)), addDays(today, 1)];
    back = {days: n};
  };
  switch (preset) {
    case 'all':
      return {from: null, to: null, label: 'All time', previous: null};
    case 'today':
      days(1);
      break;
    case 'last_7':
      days(7);
      break;
    case 'last_30':
      days(30);
      break;
    case 'last_90':
      days(90);
      break;
    case 'last_365':
      days(365);
      break;
    case 'this_week': {
      const s = bucketStart(today, 'week');
      span = [s, addDays(s, 7)];
      back = {days: 7};
      break;
    }
    case 'this_month':
      span = [bucketStart(today, 'month'), addMonths(bucketStart(today, 'month'), 1)];
      back = {months: 1};
      break;
    case 'last_month':
      span = [addMonths(bucketStart(today, 'month'), -1), bucketStart(today, 'month')];
      back = {months: 1};
      break;
    case 'this_quarter':
      span = [quarter, addMonths(quarter, 3)];
      back = {months: 3};
      break;
    case 'last_quarter':
      span = [addMonths(quarter, -3), quarter];
      back = {months: 3};
      break;
    case 'next_quarter':
      span = [addMonths(quarter, 3), addMonths(quarter, 6)];
      back = {months: 3};
      break;
    case 'this_year':
      span = [{y: today.y, m: 0, d: 1}, {y: today.y + 1, m: 0, d: 1}];
      back = {months: 12};
      break;
    case 'last_year':
      span = [{y: today.y - 1, m: 0, d: 1}, {y: today.y, m: 0, d: 1}];
      back = {months: 12};
      break;
    case 'next_30':
      span = [today, addDays(today, 30)];
      back = {days: 30};
      break;
    case 'custom': {
      const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!ok(range?.from) && !ok(range?.to)) return {from: null, to: null, label: 'All time', previous: null};
      const from = ok(range?.from) ? zoned(tz, parseKey(range!.from!)) : null;
      const to = ok(range?.to) ? zoned(tz, addDays(parseKey(range!.to!), 1)) : null;
      if (from && to && to <= from) throw new HTTPException(400, {message: 'The date range ends before it starts'});
      const previous = from && to ? {from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from} : null;
      return {from, to, label: `${range?.from ?? '…'} – ${range?.to ?? '…'}`, previous};
    }
  }
  const [a, b] = span! as [Wall, Wall];
  const shift = (w: Wall) => (back.months ? addMonths(w, -back.months) : addDays(w, -(back.days ?? 0)));
  const from = zoned(tz, a);
  const to = zoned(tz, b);
  const prevFrom = zoned(tz, shift(a));
  // A period still running is compared with the same stretch of the one before it.
  const elapsed = now > from.getTime() && now < to.getTime() ? now - from.getTime() : null;
  const prevTo = elapsed !== null ? new Date(prevFrom.getTime() + elapsed) : zoned(tz, shift(b));
  label = RANGE_PRESETS[preset];
  return {from, to, label, previous: {from: prevFrom, to: prevTo}};
}

/** The month / quarter containing `at` (offset 0), or the ones before / after it. */
export function periodSpan(period: 'MONTH' | 'QUARTER', tz: string, offset = 0, at = Date.now()) {
  const start = addMonths(bucketStart(wallOf(tz, at), period === 'MONTH' ? 'month' : 'quarter'), offset * (period === 'MONTH' ? 1 : 3));
  const end = addMonths(start, period === 'MONTH' ? 1 : 3);
  const label = period === 'MONTH' ? `${MONTHS[start.m]} ${start.y}` : `Q${Math.floor(start.m / 3) + 1} ${start.y}`;
  return {from: zoned(tz, start), to: zoned(tz, end), label, key: wallKey(start)};
}
