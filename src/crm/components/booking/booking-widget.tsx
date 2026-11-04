import {useQuery} from '@tanstack/react-query';
import {ArrowLeft, CalendarCheck2, CalendarPlus, Clock, Download, Loader2, MapPin, Phone, Video} from 'lucide-react';
import {useRef, useState, type ReactNode} from 'react';

import {api, ApiError} from '@/lib/api';
import {sendAttempt} from '@/lib/attempt';
import {durationLabel, whenIn, type LocationType, type PublicBookingLink} from '@/lib/scheduling';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';
import {Field, Input, Textarea} from '../ui/form';
import {is, useFormState} from '../ui/form-state';
import {Avatar, IconBadge} from '../ui/misc';
import {SlotPicker, useVisitorTimeZone} from './slot-picker';

/** What /site-api/crm/public/booking returns for a booking (same shape the manage page uses). */
export type BookedMeeting = {
  id: string;
  status: 'CONFIRMED' | 'CANCELED';
  title: string;
  linkId: string | null;
  durations: number[];
  duration: number;
  hostName: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  name: string;
  email: string;
  locationType: string | null;
  location: string | null;
  cancelReason: string | null;
  past: boolean;
  icsUrl: string | null;
};

export const LOCATION_ICONS: Record<LocationType, typeof Video> = {VIDEO: Video, PHONE: Phone, IN_PERSON: MapPin, OTHER: MapPin};

const icsStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export const googleCalendarLink = (b: Pick<BookedMeeting, 'title' | 'startAt' | 'endAt' | 'location'>) =>
  `https://calendar.google.com/calendar/render?${new URLSearchParams({action: 'TEMPLATE', text: b.title, dates: `${icsStamp(b.startAt)}/${icsStamp(b.endAt)}`, ...(b.location ? {location: b.location} : {})})}`;

/** Where the meeting happens, as the invitee should read it. */
export function MeetingPlace({type, location}: {type: string | null; location: string | null}) {
  const Icon = LOCATION_ICONS[(type ?? 'OTHER') as LocationType] ?? MapPin;
  const url = location && /^https?:\/\//.test(location);
  return (
    <span className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" />
      {url ? (
        <a href={location!} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-semibold text-primary hover:underline">{location}</a>
      ) : (
        <span className="min-w-0">{location || (type === 'VIDEO' ? 'Video call, the link arrives with your calendar invitation' : type === 'PHONE' ? 'Phone call' : 'Details in your confirmation email')}</span>
      )}
    </span>
  );
}

/** Confirmation details + calendar buttons, shared by the booking flow and the manage page. */
export function BookingSummary({booking, timezone, children}: {booking: BookedMeeting; timezone: string; children?: ReactNode}) {
  return (
    <div className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4 text-sm text-slate-700">
      <p className="text-base font-bold text-slate-900">{booking.title}{booking.hostName ? ` with ${booking.hostName}` : ''}</p>
      <span className="flex items-start gap-2"><Clock className="mt-0.5 size-4 shrink-0 text-slate-400" /> {whenIn(booking.startAt, timezone)} · {durationLabel(booking.duration)}</span>
      <MeetingPlace type={booking.locationType} location={booking.location} />
      {children}
    </div>
  );
}

export function CalendarButtons({booking}: {booking: BookedMeeting}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="secondary" size="sm">
        <a href={googleCalendarLink(booking)} target="_blank" rel="noopener noreferrer"><CalendarPlus /> Google Calendar</a>
      </Button>
      {booking.icsUrl && (
        <Button asChild variant="secondary" size="sm">
          <a href={booking.icsUrl}><Download /> Outlook / Apple (.ics)</a>
        </Button>
      )}
    </div>
  );
}

/** `error`: the server's words about the duration (`fields.duration`), shown under the choices. */
function LinkHeader({link, duration, onDuration, error}: {link: PublicBookingLink; duration: number; onDuration: (d: number) => void; error?: string | null}) {
  const Icon = LOCATION_ICONS[link.locationType] ?? MapPin;
  return (
    <div className="min-w-0">
      <div className="flex -space-x-2">
        {link.hosts.slice(0, 4).map((h) => <Avatar key={h.name} name={h.name} color={h.color} src={h.avatarUrl} />)}
      </div>
      <p className="mt-3 text-sm font-semibold text-muted-foreground">{link.kind === 'team' ? 'Our team' : link.hosts[0]?.name}</p>
      <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-slate-900">{link.name}</h1>
      <div className="mt-3 grid gap-2 text-sm text-slate-600">
        <span className="flex items-center gap-2"><Clock className="size-4 text-slate-400" /> {durationLabel(duration)}</span>
        <span className="flex items-center gap-2"><Icon className="size-4 text-slate-400" /> {link.locationLabel}</span>
      </div>
      {link.durations.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Duration" aria-invalid={error ? true : undefined} aria-describedby={error ? 'bk-duration-error' : undefined}>
          {link.durations.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={d === duration}
              onClick={() => onDuration(d)}
              className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-all', d === duration ? 'border-primary bg-accent text-primary' : 'border-border text-slate-600 hover:border-slate-300')}
            >
              {durationLabel(d)}
            </button>
          ))}
        </div>
      )}
      {error && link.durations.length > 1 && <p id="bk-duration-error" role="alert" className="mt-2 text-xs font-medium text-destructive">{error}</p>}
      {link.description && <p className="mt-4 text-sm whitespace-pre-wrap text-muted-foreground">{link.description}</p>}
    </div>
  );
}

/**
 * The whole booking flow (pick a time → details → confirmation) for one link.
 * Used by the public pages /book/:handle/:slug and /book/team/:slug, and by
 * pages built in this app:
 *
 *   import {BookingWidget} from '@/components/booking/booking-widget';
 *   <Card className="p-6"><BookingWidget link="sales/intro-call" /></Card>
 *
 * `link` is the path after /book/ (a user's handle + slug, or "team/<slug>").
 */
export function BookingWidget({link, initial, onBooked, className}: {link: string; initial?: PublicBookingLink | null; onBooked?: (b: BookedMeeting) => void; className?: string}) {
  const q = useQuery({
    queryKey: ['public-booking-link', link],
    queryFn: () => api.get<{link: PublicBookingLink}>(`/public/booking/links/${link.split('/').map(encodeURIComponent).join('/')}`).then((r) => r.link),
    initialData: initial ?? undefined,
    staleTime: 60_000,
    retry: 1,
  });
  if (q.isLoading) return <div className="flex justify-center py-10 text-slate-400"><Loader2 className="size-5 animate-spin" /></div>;
  if (!q.data) return <p className="py-6 text-center text-sm text-muted-foreground">{(q.error as Error | null)?.message ?? 'Booking unavailable'}</p>;
  if (!q.data.active) {
    return (
      <div className={cn('py-8 text-center', className)}>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{q.data.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Online booking for this meeting is turned off right now.</p>
      </div>
    );
  }
  return <Flow link={q.data} onBooked={onBooked} className={className} />;
}

function Flow({link, onBooked, className}: {link: PublicBookingLink; onBooked?: (b: BookedMeeting) => void; className?: string}) {
  const [tz, setTz] = useVisitorTimeZone();
  const [duration, setDuration] = useState(link.durations[0] ?? 30);
  const [start, setStart] = useState<string | null>(null);
  const [step, setStep] = useState<'pick' | 'details' | 'done'>('pick');
  const [form, setForm] = useState({name: '', email: '', phone: '', company: '', notes: ''});
  const [hp, setHp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationError, setDurationError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{booking: BookedMeeting; token: string} | null>(null);
  const startedAt = useRef(Date.now());
  const qs = link.questions;
  const f = useFormState(form, {
    name: [is.required('Enter your name.'), is.maxLength(200)],
    email: [is.required('Enter your email address.'), is.email(), is.maxLength(200)],
    phone: [(v) => qs.phone === 'required' && !v.trim() && 'Enter your phone number.', is.maxLength(40)],
    company: [(v) => qs.company === 'required' && !v.trim() && 'Enter your company.', is.maxLength(200)],
    notes: [(v) => qs.notes === 'required' && !v.trim() && 'Tell us a little about the meeting.', is.maxLength(5000)],
  });

  async function submit() {
    if (!start || !tz) return;
    setBusy(true);
    setError(null);
    setDurationError(null);
    try {
      // One key per attempt at this time: a retry after a lost answer gets the same booking, never a second.
      const r = await sendAttempt(['booking', link.id, start, duration], (headers) => api.post<{booking: BookedMeeting; token: string}>('/public/booking/book', {
        linkId: link.id,
        start,
        duration,
        timezone: tz,
        name: form.name,
        email: form.email,
        phone: qs.phone !== 'off' ? form.phone || null : null,
        company: qs.company !== 'off' ? form.company || null : null,
        notes: qs.notes !== 'off' ? form.notes || null : null,
        source: window.location.pathname.startsWith('/book/') && !/[?&]embed=1/.test(window.location.search) ? 'page' : 'widget',
        hp,
        startedAt: startedAt.current,
      }, headers));
      f.reset();
      setBooked(r);
      setStep('done');
      onBooked?.(r.booking);
    } catch (e) {
      if (f.fail(e)) return;
      const fields = e instanceof ApiError ? e.fields : {};
      // The duration or the time (`fields.duration` / `fields.start`) is picked on the calendar step: back there.
      if (fields.duration || fields.start) {
        if (fields.duration && link.durations.length > 1) setDurationError(fields.duration);
        else setError((e as Error).message);
        setStart(null);
        setStep('pick');
        return;
      }
      setError((e as Error).message);
      // The slot was taken meanwhile: back to the calendar.
      if (/no longer available/.test((e as Error).message)) {
        setStart(null);
        setStep('pick');
      }
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done' && booked && tz) {
    return (
      <div className={cn('mx-auto grid max-w-lg gap-5 py-2 text-center', className)}>
        <IconBadge tone="green" className="mx-auto size-12 [&_svg]:size-6"><CalendarCheck2 /></IconBadge>
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">You're booked</h2>
          <p className="mt-1 text-sm text-muted-foreground">We sent the details to {booked.booking.email}.</p>
        </div>
        <div className="text-left">
          <BookingSummary booking={booked.booking} timezone={tz} />
        </div>
        <div className="flex justify-center"><CalendarButtons booking={booked.booking} /></div>
        <p className="text-xs text-muted-foreground">
          Need to change something? <a href={`/book/manage/${booked.token}`} className="font-semibold text-primary hover:underline">Reschedule or cancel</a>
        </p>
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8', className)}>
      <LinkHeader link={link} duration={duration} error={durationError} onDuration={(d) => (setDuration(d), setStart(null), setDurationError(null))} />
      <div className="min-w-0 border-slate-100 lg:border-l lg:pl-8">
        {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">{error}</p>}
        {step === 'pick' && (
          !tz ? (
            <div className="flex justify-center py-10 text-slate-400"><Loader2 className="size-5 animate-spin" /></div>
          ) : (
            <>
              <h2 className="mb-4 text-base font-bold text-slate-900">Select a date & time</h2>
              <SlotPicker linkId={link.id} duration={duration} timezone={tz} onTimezone={setTz} value={start} onChange={setStart} maxDaysAhead={link.maxDaysAhead} />
              <div className="mt-5 flex justify-end">
                <Button disabled={!start} onClick={() => (setError(null), setStep('details'))}>Next</Button>
              </div>
            </>
          )
        )}
        {step === 'details' && start && tz && (
          <form {...f.form(() => void submit())} className="grid gap-4">
            <button type="button" disabled={busy} onClick={() => setStep('pick')} className="flex w-fit disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
              <ArrowLeft className="size-4" /> Back
            </button>
            <p className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground">{whenIn(start, tz)} · {durationLabel(duration)}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Your name" htmlFor="bk-name" error={f.error('name')}>
                <Input id="bk-name" autoComplete="name" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} onBlur={f.blur('name')} />
              </Field>
              <Field label="Email" htmlFor="bk-email" error={f.error('email')}>
                <Input id="bk-email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} onBlur={f.blur('email')} />
              </Field>
              {qs.phone !== 'off' && (
                <Field label={`Phone${qs.phone === 'optional' ? ' (optional)' : ''}`} htmlFor="bk-phone" error={f.error('phone')}>
                  <Input id="bk-phone" type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({...form, phone: e.target.value})} onBlur={f.blur('phone')} />
                </Field>
              )}
              {qs.company !== 'off' && (
                <Field label={`Company${qs.company === 'optional' ? ' (optional)' : ''}`} htmlFor="bk-company" error={f.error('company')}>
                  <Input id="bk-company" autoComplete="organization" value={form.company} onChange={(e) => setForm({...form, company: e.target.value})} onBlur={f.blur('company')} />
                </Field>
              )}
            </div>
            {qs.notes !== 'off' && (
              <Field label={`Anything we should know?${qs.notes === 'optional' ? ' (optional)' : ''}`} htmlFor="bk-notes" error={f.error('notes')}>
                <Textarea id="bk-notes" rows={3} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} onBlur={f.blur('notes')} />
              </Field>
            )}
            {/* Honeypot: hidden from people, filled by bots. */}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden value={hp} onChange={(e) => setHp(e.target.value)} className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            <div className="flex justify-end">
              <Button type="submit" pending={busy} pendingLabel="Booking…">Confirm booking</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
