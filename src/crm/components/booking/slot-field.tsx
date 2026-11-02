import {useQuery} from '@tanstack/react-query';
import {CalendarCheck2, Loader2} from 'lucide-react';
import {useEffect} from 'react';

import {api} from '@/lib/api';
import type {AnswerValue, FormField} from '@/lib/forms';
import {durationLabel, whenIn, type PublicBookingLink} from '@/lib/scheduling';
import {cn} from '@/lib/utils';

import {SlotPicker, useVisitorTimeZone} from './slot-picker';

type Value = {start?: string; duration?: string; timezone?: string} | null;

/** The forms "Booking slot" field: pick an open time of the chosen booking link. */
export function BookingSlotField({field, value, onChange}: {field: FormField; value: AnswerValue | undefined; onChange: (v: AnswerValue) => void}) {
  const v = (value ?? null) as Value;
  const [detected, setDetected] = useVisitorTimeZone();
  const tz = v?.timezone || detected;
  const link = useQuery({
    queryKey: ['public-booking-link-id', field.bookingLinkId],
    queryFn: () => api.get<{link: PublicBookingLink}>(`/public/booking/links/${field.bookingLinkId}`).then((r) => r.link),
    enabled: !!field.bookingLinkId,
    staleTime: 60_000,
  });
  const durations = link.data?.durations ?? [30];
  const duration = Number(v?.duration) || durations[0]!;

  // Remember the visitor's timezone with the answer, so emails and the timeline show their time.
  useEffect(() => {
    if (v?.start && !v.timezone && detected) onChange({start: v.start, duration: String(duration), timezone: detected});
  }, [v?.start, v?.timezone, detected, duration, onChange]);

  if (!field.bookingLinkId) return <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-muted-foreground">Choose a booking link for this field.</p>;
  if (link.isLoading || !tz) return <div className="flex justify-center py-6 text-slate-400"><Loader2 className="size-5 animate-spin" /></div>;
  if (!link.data?.active) return <p className="text-sm text-muted-foreground">Online booking is not available right now.</p>;

  const set = (patch: {start?: string | null; duration?: number; timezone?: string}) => {
    const start = patch.start === undefined ? v?.start : patch.start;
    const next = {start: start ?? '', duration: String(patch.duration ?? duration), timezone: patch.timezone ?? tz};
    onChange(next.start ? next : null);
  };

  return (
    <div className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:p-4">
      {durations.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Duration">
          {durations.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={d === duration}
              onClick={() => set({duration: d, start: null})}
              className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-all', d === duration ? 'border-primary bg-accent text-primary' : 'border-border text-slate-600 hover:border-slate-300')}
            >
              {durationLabel(d)}
            </button>
          ))}
        </div>
      )}
      <SlotPicker
        linkId={field.bookingLinkId}
        duration={duration}
        timezone={tz}
        onTimezone={(t) => (setDetected(t), set({timezone: t}))}
        value={v?.start || null}
        onChange={(start) => set({start})}
        maxDaysAhead={link.data.maxDaysAhead}
        compact
      />
      {v?.start && (
        <p className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground">
          <CalendarCheck2 className="size-4 shrink-0" /> {whenIn(v.start, tz)} · {durationLabel(duration)}
        </p>
      )}
    </div>
  );
}
