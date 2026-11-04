import {useQuery} from '@tanstack/react-query';
import {ChevronLeft, ChevronRight, Globe, Loader2} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {api} from '@/lib/api';
import {timeZones} from '@/lib/format';
import {addDays, localDate, timeIn, weekdayOf, zonedTime} from '@/lib/scheduling';
import {cn} from '@/lib/utils';

import {NativeSelect} from '../ui/form';

/** The visitor's timezone; UTC during server rendering. */
export function useVisitorTimeZone() {
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    } catch {
      setTz('UTC');
    }
  }, []);
  return [tz, setTz] as const;
}

export function TimeZoneSelect({value, onChange, className}: {value: string; onChange: (tz: string) => void; className?: string}) {
  const zones = useMemo(() => {
    const all = timeZones();
    const list = all.includes(value) ? all : [value, ...all];
    return list.map((z) => ({z, label: `${z.replace(/_/g, ' ')} (${timeIn(Date.now(), z)})`}));
  }, [value]);
  return (
    <label className={cn('relative flex items-center', className)}>
      <Globe className="pointer-events-none absolute left-3 size-4 text-slate-400" />
      <span className="sr-only">Time zone</span>
      <NativeSelect className="h-9 pl-9 text-[13px]" value={value} onChange={(e) => onChange(e.target.value)}>
        {zones.map(({z, label}) => <option key={z} value={z}>{label}</option>)}
      </NativeSelect>
    </label>
  );
}

const monthStart = (ms: number, tz: string) => `${localDate(ms, tz).slice(0, 7)}-01`;
const nextMonth = (ym01: string) => {
  const [y, m] = ym01.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const prevMonth = (ym01: string) => {
  const [y, m] = ym01.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};

/**
 * Month calendar + open times of a booking link, shown in the visitor's
 * timezone. `value` is the chosen start (ISO). With `reschedule` (a manage
 * token) the booking's own host and time are taken into account.
 */
export function SlotPicker({
  linkId,
  duration,
  timezone,
  onTimezone,
  value,
  onChange,
  maxDaysAhead = 60,
  reschedule,
  compact,
}: {
  linkId: string;
  duration: number;
  timezone: string;
  onTimezone: (tz: string) => void;
  value: string | null;
  onChange: (start: string | null) => void;
  maxDaysAhead?: number;
  reschedule?: string;
  compact?: boolean;
}) {
  const today = localDate(Date.now(), timezone);
  const [month, setMonth] = useState(() => monthStart(value ? Date.parse(value) : Date.now(), timezone));
  const [day, setDay] = useState<string | null>(() => (value ? localDate(Date.parse(value), timezone) : null));
  const lastMonth = monthStart(Date.now() + (maxDaysAhead + 1) * 86_400_000, timezone);
  const firstMonth = monthStart(Date.now(), timezone);

  const slots = useQuery({
    queryKey: ['booking-slots', linkId, duration, month, timezone, reschedule ?? ''],
    queryFn: () =>
      api.get<{slots: string[]}>('/public/booking/slots', {
        linkId,
        duration,
        from: new Date(zonedTime(month, '00:00', timezone)).toISOString(),
        to: new Date(zonedTime(nextMonth(month), '00:00', timezone)).toISOString(),
        reschedule,
      }),
    staleTime: 30_000,
  });

  const byDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots.data?.slots ?? []) {
      const d = localDate(Date.parse(s), timezone);
      map.set(d, [...(map.get(d) ?? []), s]);
    }
    return map;
  }, [slots.data, timezone]);

  // Jump to the first open day of the month (and to next month when this one is full).
  const [autoAdvanced, setAutoAdvanced] = useState(false);
  useEffect(() => {
    if (!slots.data) return;
    if (day && byDay.has(day)) return;
    const first = [...byDay.keys()].sort()[0];
    if (first) setDay(first);
    else if (!autoAdvanced && month < lastMonth && !value) {
      setAutoAdvanced(true);
      setMonth(nextMonth(month));
    }
  }, [slots.data, byDay, day, month, lastMonth, autoAdvanced, value]);

  // Keep the picked day when the timezone changes.
  useEffect(() => {
    if (value) setDay(localDate(Date.parse(value), timezone));
  }, [timezone]);

  const cells = useMemo(() => {
    const lead = weekdayOf(month); // Sunday-first grid
    const out: (string | null)[] = Array.from({length: lead}, () => null);
    for (let d = month; d < nextMonth(month); d = addDays(d, 1)) out.push(d);
    return out;
  }, [month]);
  const times = day ? byDay.get(day) ?? [] : [];
  const monthLabel = new Date(`${month}T12:00:00Z`).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});

  return (
    <div className={cn('grid grid-cols-1 gap-5', !compact && 'md:grid-cols-[minmax(0,1fr)_200px]')}>
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-bold text-slate-900">{monthLabel}</p>
          <div className="flex gap-1">
            <button type="button" aria-label="Previous month" disabled={month <= firstMonth} onClick={() => (setMonth(prevMonth(month)), setDay(null))} className="cursor-pointer rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-default disabled:opacity-30">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" aria-label="Next month" disabled={month >= lastMonth} onClick={() => (setMonth(nextMonth(month)), setDay(null))} className="cursor-pointer rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-default disabled:opacity-30">
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={monthLabel}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="pb-1 text-[11px] font-semibold text-muted-foreground">{d}</span>)}
          {cells.map((d, i) => {
            if (!d) return <span key={`e${i}`} />;
            const open = byDay.has(d);
            const on = d === day;
            return (
              <button
                key={d}
                type="button"
                disabled={!open}
                onClick={() => setDay(d)}
                aria-pressed={on}
                aria-label={`${d}${open ? `, ${byDay.get(d)!.length} times` : ', unavailable'}`}
                className={cn(
                  'relative mx-auto flex aspect-square w-full max-w-11 cursor-pointer items-center justify-center rounded-full text-sm font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  on ? 'bg-brand text-white shadow-btn' : open ? 'bg-accent text-primary hover:ring-2 hover:ring-primary/30' : 'cursor-default text-slate-300',
                  d === today && !on && 'underline decoration-2 underline-offset-4',
                )}
              >
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
        <TimeZoneSelect value={timezone} onChange={onTimezone} className="mt-4" />
      </div>
      <div className="min-w-0">
        <p className="mb-3 text-sm font-bold text-slate-900">
          {day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC'}) : 'Pick a day'}
        </p>
        {slots.isLoading ? (
          <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : slots.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {(slots.error as Error).message}{' '}
            <button type="button" onClick={() => slots.refetch()} className="cursor-pointer rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/30">Retry</button>
          </p>
        ) : !byDay.size ? (
          <p className="text-sm text-muted-foreground">No open times this month.{month < lastMonth && ' Try the next one.'}</p>
        ) : (
          <div className={cn('grid gap-2 overflow-y-auto pr-1 scrollbar-thin', compact ? 'max-h-60 grid-cols-3 sm:grid-cols-4' : 'max-h-[340px] grid-cols-2 md:grid-cols-1')}>
            {times.map((t) => {
              const on = t === value;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onChange(on ? null : t)}
                  aria-pressed={on}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2 text-sm font-semibold tabular-nums transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    on ? 'border-primary bg-brand text-white shadow-btn' : 'border-primary/30 text-primary hover:border-primary hover:bg-accent',
                  )}
                >
                  {timeIn(t, timezone)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
