import {CalendarClock, CalendarX2, CheckCircle2, Loader2} from 'lucide-react';
import {useState} from 'react';

import {BookingSummary, CalendarButtons, type BookedMeeting} from '@/components/booking/booking-widget';
import {SlotPicker, useVisitorTimeZone} from '@/components/booking/slot-picker';
import {PublicCard} from '@/components/public-layout';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/form';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import type {Brand} from '@/lib/brand';
import {PublicPage} from './public-page';
import {durationLabel, whenIn} from '@/lib/scheduling';

/**
 * /book/manage/<token>: the signed link from the confirmation email, to reschedule or cancel without
 * signing in (src/pages/book/manage/[token].astro loads the booking).
 */
export default function ManageBookingPage({brand, token, booking, action}: {brand: Brand; token: string; booking: BookedMeeting | null; action?: 'reschedule' | 'cancel'}) {
  return (
    <PublicPage brand={brand}>
      <Manage token={token} initial={booking} action={action} />
    </PublicPage>
  );
}

function Manage({token, initial, action}: {token: string; initial: BookedMeeting | null; action?: 'reschedule' | 'cancel'}) {
  const [booking, setBooking] = useState<BookedMeeting | null>(initial);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>(action ?? 'view');
  const [tz, setTz] = useVisitorTimeZone();
  const [start, setStart] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!booking) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="rose" className="mx-auto"><CalendarX2 /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">This link isn't valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">Use the link from your latest confirmation email, or reply to that email.</p>
      </PublicCard>
    );
  }
  const zone = tz ?? booking.timezone;

  async function run(path: 'cancel' | 'reschedule', body: object, message: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{booking: BookedMeeting}>(`/public/booking/manage/${token}/${path}`, body);
      setBooking(r.booking);
      setMode('view');
      setStart(null);
      setDone(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canceled = booking.status === 'CANCELED';
  const locked = canceled || booking.past;

  return (
    <PublicCard className={mode === 'reschedule' ? 'max-w-3xl' : 'max-w-lg'}>
      <div className="text-center">
        <IconBadge tone={canceled ? 'rose' : done ? 'green' : 'blue'} className="mx-auto">{canceled ? <CalendarX2 /> : done ? <CheckCircle2 /> : <CalendarClock />}</IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">
          {canceled ? 'Meeting canceled' : done ?? (booking.past ? 'This meeting already took place' : 'Your meeting')}
        </h1>
        {canceled && booking.cancelReason && <p className="mt-1 text-sm text-muted-foreground">Reason: {booking.cancelReason}</p>}
      </div>
      <div className="mt-5">
        <BookingSummary booking={booking} timezone={zone} />
      </div>
      {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">{error}</p>}

      {!locked && mode === 'view' && (
        <div className="mt-5 grid gap-4">
          <div className="flex justify-center"><CalendarButtons booking={booking} /></div>
          <div className="flex flex-col justify-center gap-2 sm:flex-row">
            {booking.linkId && <Button onClick={() => setMode('reschedule')}><CalendarClock /> Reschedule</Button>}
            <Button variant="secondary" onClick={() => setMode('cancel')}><CalendarX2 /> Cancel meeting</Button>
          </div>
        </div>
      )}

      {!locked && mode === 'cancel' && (
        <form onSubmit={(e) => (e.preventDefault(), run('cancel', {reason: reason || undefined}, 'Meeting canceled'))} className="mt-5 grid gap-3">
          <Textarea aria-label="Reason for canceling" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Let them know why (optional)" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setMode('view')}>Keep it</Button>
            <Button type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Cancel meeting</Button>
          </div>
        </form>
      )}

      {!locked && mode === 'reschedule' && booking.linkId && tz && (
        <div className="mt-6 grid gap-4">
          <h2 className="text-base font-bold text-slate-900">Pick a new time · {durationLabel(booking.duration)}</h2>
          <SlotPicker linkId={booking.linkId} duration={booking.duration} timezone={tz} onTimezone={setTz} value={start} onChange={setStart} reschedule={token} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {start && <p className="text-sm font-semibold text-slate-700 sm:mr-auto">{whenIn(start, tz)}</p>}
            <Button variant="secondary" onClick={() => setMode('view')}>Back</Button>
            <Button disabled={!start || busy} onClick={() => run('reschedule', {start, timezone: tz}, 'Meeting rescheduled')}>
              {busy && <Loader2 className="animate-spin" />} Confirm new time
            </Button>
          </div>
        </div>
      )}
    </PublicCard>
  );
}
