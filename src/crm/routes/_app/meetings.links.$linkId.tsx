import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {ArrowLeft, Copy, ExternalLink, Save} from 'lucide-react';
import {useEffect, useState} from 'react';

import {MEETING_TYPES, type MeetingType} from '@/components/activity-log';
import {Overrides, WeeklyHours} from '@/components/booking/availability-editor';
import {TimeZoneSelect} from '@/components/booking/slot-picker';
import {copyText, useCalendarState} from '@/components/booking/hooks';
import {LoadError} from '@/components/data-table';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Checkbox, Field, Input, Label, NativeSelect, Switch, Textarea} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {Avatar, PageHeader, Skeleton} from '@/components/ui/misc';
import {ApiError, api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys, useApiMutation, useTeam} from '@/lib/queries';
import {availabilityError, durationLabel, type QuestionMode} from '@/lib/scheduling';
import type {BookingLinkRow} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/meetings/links/$linkId')({
  head: () => ({meta: [{title: pageTitle('Booking link')}]}),
  component: LinkEditor,
});

type Draft = Pick<
  BookingLinkRow,
  | 'name'
  | 'slug'
  | 'description'
  | 'durations'
  | 'timezone'
  | 'availability'
  | 'bufferBefore'
  | 'bufferAfter'
  | 'minNoticeMin'
  | 'maxDaysAhead'
  | 'dailyLimit'
  | 'slotStepMin'
  | 'locationType'
  | 'location'
  | 'questions'
  | 'hostIds'
  | 'active'
>;

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const BUFFERS = [0, 5, 10, 15, 30, 45, 60];
const NOTICE = [
  [0, 'No minimum'],
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
  [720, '12 hours'],
  [1440, '1 day'],
  [2880, '2 days'],
  [10080, '1 week'],
] as const;
const STEPS = [null, 10, 15, 20, 30, 60] as const;
// Monday first, as most people read a work week.

function toDraft(l: BookingLinkRow): Draft {
  const {name, slug, description, durations, timezone, availability, bufferBefore, bufferAfter, minNoticeMin, maxDaysAhead, dailyLimit, slotStepMin, locationType, location, questions, hostIds, active} = l;
  return {name, slug, description, durations, timezone, availability, bufferBefore, bufferAfter, minNoticeMin, maxDaysAhead, dailyLimit, slotStepMin, locationType, location, questions, hostIds, active};
}

function LinkEditor() {
  const {linkId} = Route.useParams();
  const q = useQuery({queryKey: [...keys.scheduling, 'links', linkId], queryFn: () => api.get<{link: BookingLinkRow}>(`/scheduling/links/${linkId}`), select: (d) => d.link});
  const [draft, setDraft] = useState<Draft | null>(null);
  const link = q.data;
  useEffect(() => {
    if (link && !draft) setDraft(toDraft(link));
  }, [link, draft]);
  const save = useApiMutation(() => api.patch<{link: BookingLinkRow}>(`/scheduling/links/${linkId}`, draft), {
    invalidate: [keys.scheduling],
    success: 'Booking link saved',
    onSuccess: (r) => setDraft(toDraft(r.link)),
  });
  const f = useFormState(draft ?? ({} as Draft), {
    name: [is.required('Give the meeting a name, like Intro call.'), is.maxLength(120)],
    slug: [is.required('Choose an address, like intro-call.'), is.maxLength(60), is.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes, like intro-call (no dash at the start or end).')],
    availability: [(v) => !!v && availabilityError(v)],
  });

  if (q.isError && !link) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="sr-only">{missing ? 'Booking link not found' : 'Booking link'}</h1>
        <LoadError title={missing ? 'Booking link not found' : undefined} error={q.error} onRetry={missing ? undefined : () => q.refetch()} />
      </div>
    );
  }
  if (q.isLoading || !draft || !link) return <div className="grid gap-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>;
  const set = (patch: Partial<Draft>) => setDraft({...draft, ...patch});
  const dirty = JSON.stringify(toDraft(link)) !== JSON.stringify(draft);
  const problem = availabilityError(draft.availability);
  const prefix = link.url.slice(0, link.url.length - link.slug.length);
  const readOnly = !link.canEdit;

  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="mx-auto max-w-4xl">
      <Link to="/meetings" search={{tab: 'links'}} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> Booking links
      </Link>
      <PageHeader
        title={draft.name || 'Booking link'}
        description={link.kind === 'team' ? 'Team round robin: each booking goes to whoever is free and was booked least recently.' : 'People pick a time that is free on your calendar.'}
        actions={
          <>
            <Button variant="secondary" asChild><a href={link.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open page</a></Button>
            {!readOnly && (
              <Button type="submit" disabled={!dirty} pending={save.isPending} pendingLabel="Saving…">
                <Save /> Save
              </Button>
            )}
          </>
        }
      >
        {link.kind === 'team' && <Badge tone="teal" className="mt-2">Team link</Badge>}
      </PageHeader>
      {readOnly && <p className="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Only admins can change team links. You are in the rotation.</p>}

      <fieldset disabled={readOnly} className="min-w-0">
        <SettingsSection title="Basics">
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Meeting name" htmlFor="ln-name" error={f.error('name')}><Input id="ln-name" value={draft.name} onChange={(e) => set({name: e.target.value})} onBlur={f.blur('name')} maxLength={120} /></Field>
              <Field label="Address" htmlFor="ln-slug" error={f.error('slug')} hint={<span className="break-all">{prefix}<b>{draft.slug}</b></span>}>
                <div className="flex gap-2">
                  <Input id="ln-slug" value={draft.slug} onChange={(e) => set({slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-')})} onBlur={f.blur('slug')} maxLength={60} />
                  <Button type="button" variant="secondary" size="icon" onClick={() => copyText(link.url, 'Link copied')} aria-label="Copy link"><Copy /></Button>
                </div>
              </Field>
            </div>
            <Field label="Description" htmlFor="ln-desc" hint="Shown on the booking page.">
              <Textarea id="ln-desc" rows={3} value={draft.description ?? ''} onChange={(e) => set({description: e.target.value || null})} placeholder="What the call is about, what to prepare…" />
            </Field>
            <div className="grid gap-2">
              <Label>Durations</Label>
              <div className="flex flex-wrap gap-1.5">
                {DURATIONS.map((d) => {
                  const on = draft.durations.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? draft.durations.filter((x) => x !== d) : [...draft.durations, d].sort((a, b) => a - b);
                        if (next.length) set({durations: next});
                      }}
                      className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30', on ? 'border-primary bg-accent text-primary' : 'border-border text-slate-600 hover:border-slate-300')}
                    >
                      {durationLabel(d)}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Pick one or several; invitees choose when there are several.</p>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
              Accepting bookings
              <Switch checked={draft.active} onCheckedChange={(active) => set({active})} />
            </label>
          </div>
        </SettingsSection>

        <SettingsSection title="Availability" description="Weekly hours in the timezone below. Busy times on connected calendars are hidden automatically.">
          <div className="grid gap-5">
            <Field label="Timezone" className="max-w-sm"><TimeZoneSelect value={draft.timezone} onChange={(timezone) => set({timezone})} /></Field>
            <WeeklyHours value={draft.availability} onChange={(availability) => set({availability})} />
            <Overrides value={draft.availability} onChange={(availability) => set({availability})} />
            {problem && <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>}
          </div>
        </SettingsSection>

        <SettingsSection title="Limits">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Buffer before" htmlFor="ln-bb">
              <NativeSelect id="ln-bb" value={draft.bufferBefore} onChange={(e) => set({bufferBefore: Number(e.target.value)})}>
                {BUFFERS.map((b) => <option key={b} value={b}>{b ? `${b} min` : 'None'}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Buffer after" htmlFor="ln-ba">
              <NativeSelect id="ln-ba" value={draft.bufferAfter} onChange={(e) => set({bufferAfter: Number(e.target.value)})}>
                {BUFFERS.map((b) => <option key={b} value={b}>{b ? `${b} min` : 'None'}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Minimum notice" htmlFor="ln-notice">
              <NativeSelect id="ln-notice" value={draft.minNoticeMin} onChange={(e) => set({minNoticeMin: Number(e.target.value)})}>
                {NOTICE.some(([v]) => v === draft.minNoticeMin) ? null : <option value={draft.minNoticeMin}>{draft.minNoticeMin} min</option>}
                {NOTICE.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Book up to (days ahead)" htmlFor="ln-ahead">
              <Input id="ln-ahead" type="number" inputMode="numeric" min={1} max={365} value={draft.maxDaysAhead} onChange={(e) => set({maxDaysAhead: Math.max(1, Math.min(365, Number(e.target.value) || 1))})} />
            </Field>
            <Field label="Max bookings per day" htmlFor="ln-daily" hint="Per host. Empty = no limit.">
              <Input id="ln-daily" type="number" min={1} max={50} value={draft.dailyLimit ?? ''} onChange={(e) => set({dailyLimit: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : null})} />
            </Field>
            <Field label="Start times every" htmlFor="ln-step">
              <NativeSelect id="ln-step" value={draft.slotStepMin ?? ''} onChange={(e) => set({slotStepMin: e.target.value ? Number(e.target.value) : null})}>
                {STEPS.map((s) => <option key={s ?? 'auto'} value={s ?? ''}>{s ? `${s} min` : 'Length of the meeting'}</option>)}
              </NativeSelect>
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Location">
          <LocationEditor draft={draft} set={set} />
        </SettingsSection>

        <SettingsSection title="Questions" description="Name and email are always asked. A booking creates or updates the contact by email.">
          <div className="grid gap-3">
            {(['phone', 'company', 'notes'] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-700">{k === 'phone' ? 'Phone number' : k === 'company' ? 'Company' : 'Notes ("Anything we should know?")'}</span>
                <NativeSelect aria-label={k === 'phone' ? 'Ask for a phone number' : k === 'company' ? 'Ask for the company' : 'Ask for notes'} className="h-9 w-36" value={draft.questions[k]} onChange={(e) => set({questions: {...draft.questions, [k]: e.target.value as QuestionMode}})}>
                  <option value="off">Don't ask</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </NativeSelect>
              </div>
            ))}
          </div>
        </SettingsSection>

        {link.kind === 'team' && (
          <SettingsSection title="Rotation" description="Who can be booked. Each time goes to whoever is free, least recently booked first.">
            <HostPicker value={draft.hostIds} onChange={(hostIds) => set({hostIds})} />
          </SettingsSection>
        )}
      </fieldset>
    </form>
  );
}

function LocationEditor({draft, set}: {draft: Draft; set: (p: Partial<Draft>) => void}) {
  const cal = useCalendarState();
  const conns = cal.data?.connections ?? [];
  const provider = conns.find((c) => c.isDefault)?.provider ?? conns[0]?.provider;
  const type = draft.locationType as MeetingType;
  const meta = MEETING_TYPES[type];
  const hint =
    type === 'VIDEO'
      ? provider
        ? `Leave empty to create a ${provider === 'google' ? 'Google Meet' : 'Microsoft Teams'} link for every booking.`
        : 'Paste a fixed link, or connect your calendar in Settings → Calendar to create a Meet / Teams link per booking.'
      : type === 'PHONE'
        ? 'Your number for them to call, or leave empty to call them (their phone number is then asked).'
        : type === 'IN_PERSON'
          ? 'The address, shown on the booking page.'
          : 'Where or how you will meet.';
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Meeting type">
        {(Object.keys(MEETING_TYPES) as MeetingType[]).map((t) => {
          const m = MEETING_TYPES[t];
          const on = type === t;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => set({locationType: t, location: null, ...(t === 'PHONE' ? {questions: {...draft.questions, phone: 'required'}} : {})})}
              className={cn(
                'flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&_svg]:size-3.5',
                on ? 'border-primary bg-accent text-primary ring-2 ring-primary/15' : 'border-border text-slate-600 hover:border-slate-300',
              )}
            >
              <m.icon /> {m.label}
            </button>
          );
        })}
      </div>
      <Field label={meta.field} hint={hint}>
        <Input type={meta.input} value={draft.location ?? ''} onChange={(e) => set({location: e.target.value || null})} placeholder={meta.placeholder} />
      </Field>
    </div>
  );
}

function HostPicker({value, onChange}: {value: string[]; onChange: (ids: string[]) => void}) {
  const team = useTeam();
  const people = (team.data ?? []).filter((u) => u.active && u.role !== 'VIEWER' && !u.invited);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {people.map((u) => {
        const on = value.includes(u.id);
        return (
          <label key={u.id} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all', on ? 'border-primary bg-primary/[0.04]' : 'border-slate-200 hover:border-slate-300')}>
            <Checkbox checked={on} onCheckedChange={(v) => onChange(v === true ? [...value, u.id] : value.filter((id) => id !== u.id))} />
            <Avatar name={u.name} color={u.color} src={u.avatarUrl} size="sm" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-900">{u.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
