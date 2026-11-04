import {createFileRoute, Link} from '@tanstack/react-router';
import {AlertTriangle, CalendarDays, Copy, MoreHorizontal, RefreshCw, Trash2} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {copyText, useCalendarState, useSchedulingProfile} from '@/components/booking/hooks';
import {TimeZoneSelect} from '@/components/booking/slot-picker';
import {LoadError} from '@/components/data-table';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Checkbox, Field, Input, Label, NativeSelect, Switch} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {CalendarConnectionView} from '@/lib/types';
import {useBrand} from '@/lib/use-brand';

export const Route = createFileRoute('/_app/settings/calendar')({
  validateSearch: z.object({connected: z.string().optional(), error: z.string().optional()}),
  head: () => ({meta: [{title: pageTitle('Calendar')}]}),
  component: CalendarSettings,
});

const PROVIDER = {
  google: {name: 'Google Calendar', cls: 'bg-rose-50 text-rose-600'},
  microsoft: {name: 'Outlook / Microsoft 365', cls: 'bg-sky-50 text-sky-600'},
} as const;

function CalendarSettings() {
  const s = Route.useSearch();
  const brand = useBrand();
  const {isAdmin} = useMe();
  const cal = useCalendarState();
  useEffect(() => {
    if (s.connected) toast.success(s.connected);
    if (s.error) toast.error(s.error);
  }, [s.connected, s.error]);
  const conns = cal.data?.connections ?? [];
  const providers = cal.data?.providers;

  return (
    <div>
      <BookingProfile />
      <SettingsSection
        title="Connected calendars"
        description={`${brand.name} hides busy times from booking pages, adds meetings you schedule here (with a Meet or Teams link for video calls) and logs calendar meetings with your contacts.`}
      >
        <div className="grid gap-4">
          {cal.isError && !cal.data && <LoadError error={cal.error} onRetry={() => cal.refetch()} />}
          {conns.map((c) => <ConnectionCard key={c.id} conn={c} multiple={conns.length > 1} />)}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['google', 'microsoft'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={!providers?.[kind]}
                onClick={() => (window.location.href = `/site-api/crm/calendar/oauth/${kind}/start`)}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-4 text-left transition-all outline-none hover:border-primary/50 hover:shadow-soft focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-200 disabled:hover:shadow-none"
              >
                <IconBadge className={PROVIDER[kind].cls}><CalendarDays /></IconBadge>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-slate-900">Connect {PROVIDER[kind].name}</span>
                  <span className="block text-xs text-muted-foreground">{providers?.[kind] ? 'Sign in and allow calendar access' : 'The OAuth app is not set up yet'}</span>
                </span>
              </button>
            ))}
          </div>
          {providers && (!providers.google || !providers.microsoft) && (
            <p className="text-xs text-muted-foreground">
              Calendars use the same Google / Microsoft apps as mailboxes.{' '}
              {isAdmin ? <>Add them in <Link to="/settings/email" className="font-semibold text-primary hover:underline">Settings → Email</Link>, with the calendar redirect URIs below.</> : 'Ask an admin to set them up.'}
            </p>
          )}
          {isAdmin && cal.data && (
            <details className="rounded-xl border border-dashed border-slate-200 p-4 text-sm">
              <summary className="cursor-pointer font-semibold text-slate-700">OAuth app setup for calendars</summary>
              <div className="mt-3 grid gap-3 text-muted-foreground">
                <p>Add these redirect URIs to the same apps used for email, and allow the calendar permissions:</p>
                <CopyRow label="Google redirect URI" value={cal.data.redirectUris.google} />
                <p className="text-xs">Google Cloud: enable the Google Calendar API; scopes <code>calendar.readonly</code> and <code>calendar.events</code>.</p>
                <CopyRow label="Microsoft redirect URI" value={cal.data.redirectUris.microsoft} />
                <p className="text-xs">Azure: delegated Microsoft Graph permission <code>Calendars.ReadWrite</code> (plus <code>offline_access</code>, <code>User.Read</code>).</p>
              </div>
            </details>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

function CopyRow({label, value}: {label: string; value: string}) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="secondary" size="icon" onClick={() => copyText(value)} aria-label={`Copy ${label}`}><Copy /></Button>
      </div>
    </Field>
  );
}

function BookingProfile() {
  const profile = useSchedulingProfile();
  const [form, setForm] = useState<{handle: string; timezone: string} | null>(null);
  useEffect(() => {
    if (profile.data && !form) setForm({handle: profile.data.profile.handle, timezone: profile.data.profile.timezone});
  }, [profile.data, form]);
  const save = useApiMutation(() => api.patch('/scheduling/profile', form), {invalidate: [keys.scheduling], success: 'Saved'});
  const f = useFormState(form ?? {handle: '', timezone: ''}, {
    handle: [
      is.required('Choose a handle, like your first name.'),
      (v) => v.trim().length < 2 && 'Use at least 2 characters.',
      is.maxLength(40),
      is.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes (no dash at the start or end).'),
    ],
  });
  if (profile.isError && !profile.data) {
    return (
      <SettingsSection title="Your booking page">
        <LoadError error={profile.error} onRetry={() => profile.refetch()} />
      </SettingsSection>
    );
  }
  if (!form || !profile.data) return null;
  const base = profile.data.baseUrl.slice(0, profile.data.baseUrl.length - profile.data.profile.handle.length);
  const dirty = form.handle !== profile.data.profile.handle || form.timezone !== profile.data.profile.timezone;
  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))}>
    <SettingsSection
      title="Your booking page"
      description={<>Your booking links live under this address. Manage them in <Link to="/meetings" search={{tab: 'links'}} className="font-semibold text-primary hover:underline">Meetings</Link>.</>}
      actions={<Button type="submit" size="sm" disabled={!dirty} pending={save.isPending} pendingLabel="Saving…">Save</Button>}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Field label="Handle" htmlFor="sp-handle" error={f.error('handle')} hint={<span className="break-all">{base}<b>{form.handle}</b>/…</span>}>
          <Input id="sp-handle" value={form.handle} onChange={(e) => setForm({...form, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-')})} onBlur={f.blur('handle')} maxLength={40} />
        </Field>
        <Field label="Default timezone" hint="New booking links start in this timezone." error={f.error('timezone')}>
          <TimeZoneSelect value={form.timezone} onChange={(timezone) => setForm({...form, timezone})} />
        </Field>
      </div>
    </SettingsSection>
    </form>
  );
}

function ConnectionCard({conn, multiple}: {conn: CalendarConnectionView; multiple: boolean}) {
  const invalidate = [keys.calendar];
  const update = useApiMutation((patch: Partial<Pick<CalendarConnectionView, 'busyCalendarIds' | 'targetCalendarId' | 'syncMeetings'>> & {isDefault?: true}) => api.patch(`/calendar/connections/${conn.id}`, patch), {invalidate});
  const refresh = useApiMutation(() => api.post(`/calendar/connections/${conn.id}/refresh`), {invalidate, success: 'Calendar list updated'});
  // The sync runs as a background job: say so instead of counting meetings here.
  const sync = useApiMutation(() => api.post<{queued?: boolean; logged?: number; updated?: number; error?: string}>(`/calendar/connections/${conn.id}/sync`), {
    invalidate,
    onSuccess: (r) => (r.error ? toast.error(r.error) : toast.success(r.queued ? 'Syncing in the background. New events appear in a minute.' : `${r.logged ?? 0} meeting${r.logged === 1 ? '' : 's'} logged`)),
  });
  const remove = useApiMutation(() => api.del(`/calendar/connections/${conn.id}`), {invalidate, success: 'Calendar disconnected'});
  const meta = PROVIDER[conn.provider as keyof typeof PROVIDER] ?? PROVIDER.google;
  const writable = conn.calendars.filter((c) => c.writable);

  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-start gap-3 p-4">
        <IconBadge className={meta.cls}><CalendarDays /></IconBadge>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-bold text-slate-900">{conn.email}</p>
            {conn.status === 'ERROR' ? <Badge tone="rose"><AlertTriangle /> Needs attention</Badge> : <Badge tone="green">Connected</Badge>}
            {multiple && conn.isDefault && <Badge tone="blue">New meetings go here</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{meta.name} · {conn.lastSyncedAt ? `synced ${ago(conn.lastSyncedAt)}` : 'not synced yet'}</p>
          {conn.lastError && <p className="mt-1 text-xs font-medium text-rose-600">{conn.lastError}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Options for ${conn.email}`} pending={sync.isPending || refresh.isPending || remove.isPending}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => sync.mutate(undefined)}><RefreshCw /> Sync meetings now</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => refresh.mutate(undefined)}><CalendarDays /> Refresh calendar list</DropdownMenuItem>
            {conn.status === 'ERROR' && <DropdownMenuItem onSelect={() => (window.location.href = `/site-api/crm/calendar/oauth/${conn.provider}/start`)}><RefreshCw /> Reconnect</DropdownMenuItem>}
            {multiple && !conn.isDefault && <DropdownMenuItem onSelect={() => update.mutate({isDefault: true})}><CalendarDays /> Add new meetings here</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Disconnect ${conn.email}?`, description: `Meetings already in the CRM stay.`, confirmLabel: 'Disconnect', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Disconnect</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="grid grid-cols-1 gap-5 border-t border-slate-100 p-4 lg:grid-cols-2">
        <div role="group" aria-labelledby={`conflicts-${conn.id}`} className="grid content-start gap-2">
          <Label id={`conflicts-${conn.id}`}>Check for conflicts</Label>
          {conn.calendars.length ? (
            conn.calendars.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <Checkbox
                  disabled={update.isPending}
                  checked={conn.busyCalendarIds.includes(c.id)}
                  onCheckedChange={(v) => update.mutate({busyCalendarIds: v === true ? [...conn.busyCalendarIds, c.id] : conn.busyCalendarIds.filter((id) => id !== c.id)})}
                />
                <span className="truncate">{c.name}</span>
                {c.primary && <Badge tone="neutral">Primary</Badge>}
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No calendars listed yet. Use “Refresh calendar list”.</p>
          )}
        </div>
        <div className="grid content-start gap-4">
          <Field label="Add new meetings to" htmlFor={`target-${conn.id}`}>
            <NativeSelect id={`target-${conn.id}`} disabled={update.isPending} value={conn.targetCalendarId ?? ''} onChange={(e) => update.mutate({targetCalendarId: e.target.value || null})}>
              <option value="">Primary calendar</option>
              {writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </NativeSelect>
          </Field>
          <label className="flex cursor-pointer items-start justify-between gap-3 text-sm text-slate-700">
            <span>
              <span className="block font-medium">Log meetings with contacts</span>
              <span className="block text-xs text-muted-foreground">Events that have a known contact as attendee are added to their timeline.</span>
            </span>
            <Switch checked={conn.syncMeetings} disabled={update.isPending} onCheckedChange={(v) => update.mutate({syncMeetings: v})} />
          </label>
        </div>
      </div>
    </div>
  );
}
