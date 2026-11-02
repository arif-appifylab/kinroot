import {CalendarOff, Plus, X} from 'lucide-react';

import {WEEKDAYS, type Availability, type TimeRange} from '@/lib/scheduling';

import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {Checkbox, Input, Switch} from '../ui/form';

/** Weekly hours and date overrides (booking links, chat office hours). Times are wall-clock in the caller's time zone. */

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function RangeRow({range, onChange, onRemove}: {range: TimeRange; onChange: (r: TimeRange) => void; onRemove: () => void}) {
  return (
    <div className="flex items-center gap-2">
      <Input type="time" aria-label="From" className="h-9 w-32" value={range.start} onChange={(e) => onChange({...range, start: e.target.value})} />
      <span className="text-slate-400">–</span>
      <Input type="time" aria-label="To" className="h-9 w-32" value={range.end === '24:00' ? '23:59' : range.end} onChange={(e) => onChange({...range, end: e.target.value === '23:59' ? '24:00' : e.target.value})} />
      <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove hours"><X /></Button>
    </div>
  );
}

export function WeeklyHours({value, onChange}: {value: Availability; onChange: (a: Availability) => void}) {
  const setDay = (day: number, ranges: TimeRange[]) => onChange({...value, weekly: {...value.weekly, [String(day)]: ranges}});
  return (
    <div className="grid divide-y divide-slate-100 rounded-xl border border-slate-100">
      {DAY_ORDER.map((day) => {
        const ranges = value.weekly[String(day)] ?? [];
        const on = ranges.length > 0;
        const last = ranges.at(-1);
        return (
          <div key={day} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
            <label className="flex w-36 shrink-0 items-center gap-2.5 pt-1.5 text-sm font-semibold text-slate-800">
              <Switch checked={on} onCheckedChange={(v) => setDay(day, v ? [{start: '09:00', end: '17:00'}] : [])} aria-label={`Available on ${WEEKDAYS[day]}`} />
              {WEEKDAYS[day]}
            </label>
            {on ? (
              <div className="grid gap-2">
                {ranges.map((r, i) => (
                  <RangeRow key={i} range={r} onChange={(next) => setDay(day, ranges.map((x, j) => (j === i ? next : x)))} onRemove={() => setDay(day, ranges.filter((_, j) => j !== i))} />
                ))}
                {ranges.length < 6 && (
                  <button
                    type="button"
                    className="flex w-fit cursor-pointer items-center gap-1 text-xs font-semibold text-primary hover:underline"
                    onClick={() => setDay(day, [...ranges, {start: last && last.end < '22:00' ? addHour(last.end) : '18:00', end: last && last.end < '22:00' ? addHour(last.end, 2) : '19:00'}])}
                  >
                    <Plus className="size-3.5" /> Add hours
                  </button>
                )}
              </div>
            ) : (
              <p className="pt-1.5 text-sm text-muted-foreground">Unavailable</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const addHour = (t: string, n = 1) => `${String(Math.min(23, Number(t.slice(0, 2)) + n)).padStart(2, '0')}:${t.slice(3)}`;

export function Overrides({value, onChange}: {value: Availability; onChange: (a: Availability) => void}) {
  const list = [...value.overrides].sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);
  const put = (overrides: Availability['overrides']) => onChange({...value, overrides});
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">Date overrides</p>
          <p className="text-xs text-muted-foreground">Days off, holidays, or different hours on a specific date.</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            let d = today;
            while (list.some((o) => o.date === d)) d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
            put([...value.overrides, {date: d, ranges: []}]);
          }}
        >
          <Plus /> Add date
        </Button>
      </div>
      {list.map((o) => {
        const update = (patch: Partial<Availability['overrides'][number]>) => put(value.overrides.map((x) => (x.date === o.date ? {...x, ...patch} : x)));
        return (
          <Card key={o.date} className="flex flex-col gap-3 p-3 shadow-none sm:flex-row sm:items-start">
            <Input type="date" aria-label="Date" className="h-9 w-44" min={today} value={o.date} onChange={(e) => e.target.value && !list.some((x) => x.date === e.target.value) && update({date: e.target.value})} />
            <div className="grid flex-1 gap-2">
              <label className="flex items-center gap-2 pt-1.5 text-sm font-medium text-slate-700">
                <Checkbox checked={!o.ranges.length} onCheckedChange={(v) => update({ranges: v === true ? [] : [{start: '09:00', end: '17:00'}]})} />
                <CalendarOff className="size-4 text-slate-400" /> Unavailable all day
              </label>
              {o.ranges.map((r, i) => (
                <RangeRow key={i} range={r} onChange={(next) => update({ranges: o.ranges.map((x, j) => (j === i ? next : x))})} onRemove={() => update({ranges: o.ranges.filter((_, j) => j !== i)})} />
              ))}
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => put(value.overrides.filter((x) => x.date !== o.date))} aria-label={`Remove ${o.date}`}><X /></Button>
          </Card>
        );
      })}
    </div>
  );
}
