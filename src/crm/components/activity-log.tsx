import {BriefcaseBusiness, Building2, CalendarClock, Handshake, Mail, Mailbox, MapPin, MessageCircle, MessageSquare, Phone, User, Video, X} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {CALL_OUTCOMES, MEETING_OUTCOMES, toLocalInput} from '@/lib/format';
import {recordKeys, useApiMutation, useEmailAccounts} from '@/lib/queries';
import type {ContactLite, InteractionKind} from '@/lib/types';
import {cn} from '@/lib/utils';

import {useCalendarState} from './booking/hooks';
import {ContactsPicker} from './pickers';
import {Button} from './ui/button';
import {Checkbox, Field, Input, Label, NativeSelect, Textarea} from './ui/form';
import {is, useFormState} from './ui/form-state';

/** Per-channel copy and icon, shared by the composer and the timeline. */
export const KINDS: Record<InteractionKind, {label: string; log: string; icon: typeof Phone; cls: string}> = {
  CALL: {label: 'Call', log: 'Log call', icon: Phone, cls: 'bg-green-50 text-green-600'},
  MEETING: {label: 'Meeting', log: 'Log meeting', icon: CalendarClock, cls: 'bg-violet-50 text-violet-600'},
  EMAIL: {label: 'Email', log: 'Log email', icon: Mail, cls: 'bg-blue-50 text-blue-600'},
  SMS: {label: 'SMS', log: 'Log SMS', icon: MessageSquare, cls: 'bg-sky-50 text-sky-600'},
  LINKEDIN: {label: 'LinkedIn', log: 'Log LinkedIn message', icon: BriefcaseBusiness, cls: 'bg-blue-50 text-blue-600'},
  WHATSAPP: {label: 'WhatsApp', log: 'Log WhatsApp message', icon: MessageCircle, cls: 'bg-green-50 text-green-600'},
  POSTAL: {label: 'Postal mail', log: 'Log postal mail', icon: Mailbox, cls: 'bg-amber-50 text-amber-600'},
};

/** Records an activity can be attached to, as known by the page that opens the form. */
export type RecordLinks = {
  contact?: {id: string; name: string} | null;
  company?: {id: string; name: string} | null;
  deal?: {id: string; title: string} | null;
  /** Deals the user may also attach (e.g. a contact's open deals). */
  dealOptions?: {id: string; title: string}[];
  /** Pre-filled meeting attendees. */
  attendees?: ContactLite[];
  /** Defaults for phone / in-person meetings. */
  phone?: string | null;
  address?: string | null;
};

function Associations({links, value, onChange}: {links: RecordLinks; value: {companyId: string | null; dealId: string | null}; onChange: (v: {companyId: string | null; dealId: string | null}) => void}) {
  const chip = 'inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground';
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2">
      <span className="mr-1 text-xs font-semibold text-muted-foreground">Associated with</span>
      {links.contact && <span className={chip}><User className="size-3" /> {links.contact.name}</span>}
      {links.company && value.companyId && (
        <span className={chip}>
          <Building2 className="size-3" /> {links.company.name}
          {links.contact && <button type="button" aria-label="Remove company" className="cursor-pointer" onClick={() => onChange({...value, companyId: null})}><X className="size-3" /></button>}
        </span>
      )}
      {links.deal && <span className={chip}><Handshake className="size-3" /> {links.deal.title}</span>}
      {!links.deal && (links.dealOptions?.length ?? 0) > 0 && (
        <NativeSelect aria-label="Attach to deal" className="h-7 w-auto rounded-full py-0 pr-7 text-xs" value={value.dealId ?? ''} onChange={(e) => onChange({...value, dealId: e.target.value || null})}>
          <option value="">+ Deal</option>
          {links.dealOptions!.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
        </NativeSelect>
      )}
    </div>
  );
}

function FollowUp({value, onChange}: {value: {on: boolean; days: number; type: string}; onChange: (v: {on: boolean; days: number; type: string}) => void}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
      <Checkbox id="fu-on" checked={value.on} onCheckedChange={(v) => onChange({...value, on: v === true})} />
      <Label htmlFor="fu-on" className="font-medium">Create a</Label>
      <NativeSelect aria-label="Follow-up type" className="h-8 w-auto" value={value.type} onChange={(e) => onChange({...value, on: true, type: e.target.value})}>
        <option value="TODO">To-do</option>
        <option value="CALL">Call</option>
        <option value="EMAIL">Email</option>
      </NativeSelect>
      <span>task to follow up in</span>
      <NativeSelect aria-label="Follow-up delay" className="h-8 w-auto" value={value.days} onChange={(e) => onChange({...value, on: true, days: Number(e.target.value)})}>
        {[1, 2, 3, 5, 10].map((d) => <option key={d} value={d}>{d} business day{d > 1 ? 's' : ''}</option>)}
      </NativeSelect>
    </div>
  );
}

/** Log a call / email / SMS / LinkedIn / WhatsApp / postal mail that already happened. */
export function LogForm({kind, links, onDone}: {kind: Exclude<InteractionKind, 'MEETING'>; links: RecordLinks; onDone?: () => void}) {
  const meta = KINDS[kind];
  const [form, setForm] = useState({
    occurredAt: toLocalInput(new Date().toISOString()),
    body: '',
    outcome: '',
    direction: 'OUTBOUND',
    durationMin: '',
  });
  const [assoc, setAssoc] = useState({companyId: links.company?.id ?? null, dealId: links.deal?.id ?? null});
  const [followUp, setFollowUp] = useState({on: false, days: 3, type: 'TODO'});

  const save = useApiMutation(
    () =>
      api.post('/interactions', {
        kind,
        body: form.body || null,
        occurredAt: new Date(form.occurredAt).toISOString(),
        outcome: kind === 'CALL' ? form.outcome || null : null,
        direction: kind === 'POSTAL' ? null : form.direction,
        durationMin: kind === 'CALL' && form.durationMin ? Number(form.durationMin) : null,
        contactId: links.contact?.id ?? null,
        companyId: assoc.companyId,
        dealId: assoc.dealId,
        followUp: followUp.on ? {days: followUp.days, type: followUp.type} : undefined,
      }),
    {invalidate: recordKeys, success: `${meta.label} logged`, onSuccess: () => (setForm((f) => ({...f, body: '', outcome: '', durationMin: ''})), onDone?.())},
  );

  const f = useFormState(form, {
    occurredAt: [is.required('Choose when it happened.')],
    durationMin: [is.number({min: 0, max: 24 * 60, integer: true, message: 'Use whole minutes between 0 and 1440, like 15.'})],
  });

  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="grid gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={kind === 'CALL' ? 'Call date' : 'Activity date'} htmlFor="log-at" error={f.error('occurredAt')}>
          <Input id="log-at" type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({...form, occurredAt: e.target.value})} onBlur={f.blur('occurredAt')} />
        </Field>
        {kind !== 'POSTAL' && (
          <Field label="Direction" htmlFor="log-dir">
            <NativeSelect id="log-dir" value={form.direction} onChange={(e) => setForm({...form, direction: e.target.value})}>
              <option value="OUTBOUND">Outbound</option>
              <option value="INBOUND">Inbound</option>
            </NativeSelect>
          </Field>
        )}
        {kind === 'CALL' && (
          <>
            <Field label="Call outcome" htmlFor="log-outcome">
              <NativeSelect id="log-outcome" value={form.outcome} onChange={(e) => setForm({...form, outcome: e.target.value})}>
                <option value="">Select outcome</option>
                {CALL_OUTCOMES.map((o) => <option key={o}>{o}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Duration (min)" htmlFor="log-dur" error={f.error('durationMin')}>
              <Input id="log-dur" type="number" inputMode="numeric" value={form.durationMin} onChange={(e) => setForm({...form, durationMin: e.target.value})} onBlur={f.blur('durationMin')} />
            </Field>
          </>
        )}
      </div>
      <Textarea aria-label="Description" rows={4} value={form.body} onChange={(e) => setForm({...form, body: e.target.value})} placeholder={`Describe the ${meta.label.toLowerCase()}… what was said, what's next?`} />
      <Associations links={links} value={assoc} onChange={setAssoc} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FollowUp value={followUp} onChange={setFollowUp} />
        <Button type="submit" size="sm" pending={save.isPending} pendingLabel="Saving…">
          <meta.icon /> {meta.log}
        </Button>
      </div>
    </form>
  );
}

const DURATIONS = [15, 30, 45, 60, 90, 120];
export type MeetingType = 'VIDEO' | 'PHONE' | 'IN_PERSON' | 'OTHER';

export const MEETING_TYPES: Record<MeetingType, {label: string; icon: typeof Phone; field: string; placeholder: string; input: 'url' | 'tel' | 'text'}> = {
  VIDEO: {label: 'Video call', icon: Video, field: 'Meeting link', placeholder: 'https://meet.google.com/abc-defg-hij', input: 'url'},
  PHONE: {label: 'Phone call', icon: Phone, field: 'Phone number', placeholder: '+1 555 0100', input: 'tel'},
  IN_PERSON: {label: 'In person', icon: MapPin, field: 'Address', placeholder: 'Street, city', input: 'text'},
  OTHER: {label: 'Other', icon: CalendarClock, field: 'Details', placeholder: 'Where or how you will meet', input: 'text'},
};

const VIDEO_PROVIDERS = [
  {name: 'Google Meet', url: 'https://meet.google.com/new'},
  {name: 'Zoom', url: 'https://zoom.us/start/videomeeting'},
  {name: 'Microsoft Teams', url: 'https://teams.microsoft.com/l/meeting/new'},
];

function roundedNextHour() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

/** Schedule a meeting ahead (optionally emailing an invite) or log one that already happened. */
export function MeetingForm({links, onDone, initialMode = 'schedule'}: {links: RecordLinks; onDone?: () => void; initialMode?: 'schedule' | 'log'}) {
  const accounts = useEmailAccounts();
  const cal = useCalendarState();
  const calendar = (cal.data?.connections.find((c) => c.isDefault) ?? cal.data?.connections[0])?.provider ?? null;
  const [mode, setMode] = useState<'schedule' | 'log'>(initialMode);
  const [form, setForm] = useState({
    title: '',
    start: roundedNextHour(),
    durationMin: 30,
    locationType: 'VIDEO' as MeetingType,
    location: '',
    body: '',
    outcome: '',
    invite: true,
    inviteMessage: '',
  });
  const [people, setPeople] = useState<ContactLite[]>(links.attendees ?? []);
  const [assoc, setAssoc] = useState({companyId: links.company?.id ?? null, dealId: links.deal?.id ?? null});
  const canInvite = (accounts.data?.length ?? 0) > 0 && people.some((p) => p.email);

  const save = useApiMutation(
    () =>
      api.post<{invited: number}>('/interactions', {
        kind: 'MEETING',
        title: form.title,
        body: form.body || null,
        occurredAt: new Date(form.start).toISOString(),
        durationMin: form.durationMin,
        locationType: form.locationType,
        location: form.location || null,
        outcome: mode === 'log' ? form.outcome || 'Completed' : 'Scheduled',
        attendeeIds: people.map((p) => p.id),
        contactId: links.contact?.id ?? null,
        companyId: assoc.companyId,
        dealId: assoc.dealId,
        invite: mode === 'schedule' && form.invite && canInvite ? {message: form.inviteMessage || undefined} : undefined,
      }),
    {
      invalidate: recordKeys,
      success: (r) => (mode === 'log' ? 'Meeting logged' : r.invited ? `Meeting scheduled · invite emailed to ${r.invited}` : 'Meeting scheduled'),
      onSuccess: () => onDone?.(),
    },
  );

  const f = useFormState(form, {
    title: [is.required('Give the meeting a title.'), is.maxLength(5000)],
    start: [is.required('Choose when the meeting starts.')],
  });

  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="grid gap-3">
      <div className="inline-flex w-fit rounded-lg bg-slate-100 p-0.5">
        {(['schedule', 'log'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn('cursor-pointer rounded-md px-3 py-1 text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30', mode === m ? 'bg-card text-slate-900 shadow-soft' : 'text-slate-500')}>
            {m === 'schedule' ? 'Schedule a meeting' : 'Log a past meeting'}
          </button>
        ))}
      </div>
      <Field label="Meeting title" htmlFor="mt-title" error={f.error('title')}>
        <Input id="mt-title" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} onBlur={f.blur('title')} placeholder="e.g. Product demo" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Start" htmlFor="mt-start" error={f.error('start')}>
          <Input id="mt-start" type="datetime-local" value={form.start} onChange={(e) => setForm({...form, start: e.target.value})} onBlur={f.blur('start')} />
        </Field>
        <Field label="Duration" htmlFor="mt-dur">
          <NativeSelect id="mt-dur" value={form.durationMin} onChange={(e) => setForm({...form, durationMin: Number(e.target.value)})}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} hour${d > 60 ? 's' : ''}`}</option>)}
          </NativeSelect>
        </Field>
        {mode === 'log' ? (
          <Field label="Outcome" htmlFor="mt-outcome">
            <NativeSelect id="mt-outcome" value={form.outcome} onChange={(e) => setForm({...form, outcome: e.target.value})}>
              <option value="">Completed</option>
              {MEETING_OUTCOMES.filter((o) => o !== 'Scheduled' && o !== 'Completed').map((o) => <option key={o}>{o}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label>Meeting type</Label>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Meeting type">
          {(Object.keys(MEETING_TYPES) as MeetingType[]).map((t) => {
            const m = MEETING_TYPES[t];
            const on = form.locationType === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() =>
                  setForm({
                    ...form,
                    locationType: t,
                    // Pre-fill what we know: the contact's phone, the company's address.
                    location: t === 'PHONE' ? links.phone ?? '' : t === 'IN_PERSON' ? links.address ?? '' : '',
                  })
                }
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-all [&_svg]:size-3.5',
                  on ? 'border-primary bg-accent text-primary ring-2 ring-primary/15' : 'border-border text-slate-600 hover:border-slate-300',
                )}
              >
                <m.icon /> {m.label}
              </button>
            );
          })}
        </div>
        <Field error={f.error('location')}>
        <div className="relative">
          {(() => {
            const Icon = MEETING_TYPES[form.locationType].icon;
            return <Icon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />;
          })()}
          <Input
            aria-label={MEETING_TYPES[form.locationType].field}
            type={MEETING_TYPES[form.locationType].input}
            className="pl-9"
            value={form.location}
            onChange={(e) => setForm({...form, location: e.target.value})}
            placeholder={MEETING_TYPES[form.locationType].placeholder}
          />
        </div>
        </Field>
        {mode === 'schedule' && calendar && (
          <p className="text-xs text-muted-foreground">
            Added to your {calendar === 'google' ? 'Google' : 'Outlook'} calendar with the attendees{form.locationType === 'VIDEO' && !form.location ? `, with a ${calendar === 'google' ? 'Google Meet' : 'Teams'} link` : ''}.
          </p>
        )}
        {form.locationType === 'VIDEO' && !(mode === 'schedule' && calendar) && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Need a link? Create one in
            {VIDEO_PROVIDERS.map((p, i) => (
              <span key={p.name}>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">{p.name}</a>
                {i < VIDEO_PROVIDERS.length - 1 ? ',' : ''}
              </span>
            ))}
            and paste it here.
          </p>
        )}
      </div>
      <Field label="Attendees" htmlFor="mt-people">
        <ContactsPicker id="mt-people" value={people} onChange={setPeople} />
      </Field>
      <Textarea aria-label="Description" rows={3} value={form.body} onChange={(e) => setForm({...form, body: e.target.value})} placeholder={mode === 'log' ? 'What was discussed? Decisions, next steps…' : 'Agenda (shared with attendees if you send an invite)'} />
      <Associations links={links} value={assoc} onChange={setAssoc} />
      {mode === 'schedule' && (
        <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 p-3">
          <div className="flex items-center gap-2">
            <Checkbox id="mt-invite" checked={form.invite && canInvite} disabled={!canInvite} onCheckedChange={(v) => setForm({...form, invite: v === true})} />
            <Label htmlFor="mt-invite" className="font-medium">Email an invitation with calendar links to attendees</Label>
          </div>
          {!canInvite && <p className="pl-6 text-xs text-muted-foreground">{accounts.data?.length ? 'Add an attendee with an email address to send an invite.' : 'Connect an email account in Settings → Email to send invites.'}</p>}
          {form.invite && canInvite && (
            <Textarea aria-label="Invitation message" rows={2} value={form.inviteMessage} onChange={(e) => setForm({...form, inviteMessage: e.target.value})} placeholder="Optional personal note (merge fields like {{contact.first_name}} work here)" />
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" pending={save.isPending} pendingLabel={mode === 'schedule' ? 'Scheduling…' : 'Saving…'}>
          <CalendarClock /> {mode === 'schedule' ? 'Schedule meeting' : 'Log meeting'}
        </Button>
      </div>
    </form>
  );
}
