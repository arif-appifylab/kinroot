import {useQuery} from '@tanstack/react-query';
import {CalendarClock, Info, Loader2, Mail, MoreHorizontal, Pause, Pencil, Play, Plus, Send, Trash2, X} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {Segmented} from '@/components/email-editor';
import {Badge, type BadgeTone} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {confirm} from '@/components/ui/confirm';
import {Checkbox, Field, Input, NativeSelect, Switch, Textarea} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, Skeleton} from '@/components/ui/misc';
import type * as P from '../../../generated/prisma/client';
import {api} from '@/lib/api';
import {ago, timeZones} from '@/lib/format';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {
  MAX_RECIPIENTS,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_RANGES,
  WEEKDAYS,
  WEEKDAY_ORDER,
  scheduleProblem,
  type ScheduleBody,
  type ScheduleFrequency,
  type ScheduleRange,
  type ScheduleStatus,
} from '@/lib/report-schedules';
import type {Jsonify, UserLite} from '@/lib/types';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';
import {EmailFrame} from '../email-frame';

/** A schedule as the API lists it (src/server/routes/report-schedules.ts). */
export type ScheduleRow = Jsonify<P.ReportSchedule> & {
  name: string;
  kind: 'report' | 'dashboard';
  frequencyLabel: string;
  recipients: number;
  statusLabel: string | null;
  owner: UserLite;
  report: {id: string; name: string} | null;
  dashboard: {id: string; name: string} | null;
};

export type ScheduleTarget = {reportId?: string; dashboardId?: string; name: string};

const scheduleKey = [...keys.reports, 'schedules'] as const;

export function useSchedules(target?: Pick<ScheduleTarget, 'reportId' | 'dashboardId'>) {
  return useQuery({
    queryKey: [...scheduleKey, target?.reportId ?? target?.dashboardId ?? 'all'],
    queryFn: () => api.get<{rows: ScheduleRow[]}>('/report-schedules', {reportId: target?.reportId, dashboardId: target?.dashboardId}),
    select: (d) => d.rows,
  });
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** "Mon, Oct 26, 9:00 AM" in the viewer's own zone. */
export const whenLocal = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '—';

const STATUS_TONE: Record<ScheduleStatus, BadgeTone> = {sent: 'green', partial: 'amber', failed: 'rose', no_mailbox: 'amber'};

export function ScheduleStatusBadge({row}: {row: Pick<ScheduleRow, 'lastStatus' | 'statusLabel' | 'lastError' | 'active' | 'failures'>}) {
  if (!row.lastStatus) return <span className="text-xs text-muted-foreground">Not sent yet</span>;
  return (
    <Badge tone={STATUS_TONE[row.lastStatus as ScheduleStatus] ?? 'neutral'} title={row.lastError ?? undefined}>
      {row.statusLabel}
    </Badge>
  );
}

/** Pause / resume, send now, delete: shared by the drawer list and the "Scheduled emails" tab. */
export function useScheduleActions(row: ScheduleRow) {
  const invalidate = [scheduleKey, keys.audit];
  const toggle = useApiMutation(() => api.patch(`/report-schedules/${row.id}`, {active: !row.active}), {invalidate, success: row.active ? 'Paused' : 'Resumed'});
  const sendNow = useApiMutation(() => api.post<{recipients: number}>(`/report-schedules/${row.id}/send`), {
    invalidate,
    success: (r) => `Sent to ${r.recipients} ${r.recipients === 1 ? 'recipient' : 'recipients'}`,
  });
  const remove = useApiMutation(() => api.del(`/report-schedules/${row.id}`), {invalidate, success: 'Scheduled email deleted'});
  return {toggle, sendNow, remove};
}

export function ScheduleMenu({row, onEdit}: {row: ScheduleRow; onEdit: () => void}) {
  const {toggle, sendNow, remove} = useScheduleActions(row);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`} disabled={sendNow.isPending}>
          {sendNow.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => sendNow.mutate(undefined)}><Send /> Send now</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggle.mutate(undefined)}>{row.active ? <><Pause /> Pause</> : <><Play /> Resume</>}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={async () => (await confirm({title: 'Delete this scheduled email?', description: `${row.name} · ${row.frequencyLabel}. Nobody gets it anymore.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Button + drawer on the report and dashboard pages ───

export function ScheduleEmailButton({target}: {target: ScheduleTarget}) {
  const [open, setOpen] = useState(false);
  const list = useSchedules(target);
  const count = list.data?.length ?? 0;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <CalendarClock /> Schedule email
        {count > 0 && <Badge tone="blue" className="ml-0.5">{count}</Badge>}
      </Button>
      <ScheduleDrawer open={open} onOpenChange={setOpen} target={target} />
    </>
  );
}

/**
 * Right-side drawer: the target's schedules, and the form to create or edit
 * one with a live preview of the email. Opening with `editing` goes straight
 * to that schedule's form.
 */
export function ScheduleDrawer({open, onOpenChange, target, editing}: {open: boolean; onOpenChange: (o: boolean) => void; target: ScheduleTarget; editing?: ScheduleRow | null}) {
  const list = useSchedules(target);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [current, setCurrent] = useState<ScheduleRow | null>(null);

  // Each opening starts fresh: the form when there is nothing to list (or a schedule to edit).
  useEffect(() => {
    if (!open) return;
    setCurrent(editing ?? null);
    setView(editing ? 'form' : 'list');
  }, [open, editing]);
  const showForm = view === 'form' || (!editing && list.isSuccess && !list.data.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={showForm ? 'xl' : 'md'}>
        <DialogHeader>
          <DialogTitle>{showForm ? (current ? 'Edit scheduled email' : 'Schedule email') : 'Scheduled emails'}</DialogTitle>
          <DialogDescription>{target.name}</DialogDescription>
        </DialogHeader>
        {showForm ? (
          <ScheduleForm
            key={current?.id ?? 'new'}
            target={target}
            row={current}
            onDone={() => (editing ? onOpenChange(false) : (setView('list'), setCurrent(null)))}
            onCancel={() => (editing || !list.data?.length ? onOpenChange(false) : (setView('list'), setCurrent(null)))}
          />
        ) : (
          <>
            <DialogBody className="content-start">
              {list.isLoading && <Skeleton className="h-24" />}
              {list.data?.map((row) => (
                <div key={row.id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-card p-4 shadow-soft">
                  <span className={cn('mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', row.active ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400')}><Mail /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">{row.frequencyLabel}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.recipients} {row.recipients === 1 ? 'recipient' : 'recipients'} · {row.active ? `next ${whenLocal(row.nextRunAt)}` : 'Paused'}
                      {row.lastSentAt && ` · last sent ${ago(row.lastSentAt)}`}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <ScheduleStatusBadge row={row} />
                      {!row.active && <Badge>Paused</Badge>}
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Avatar name={row.owner.name} color={row.owner.color} src={row.owner.avatarUrl} size="xs" /> {row.owner.name}</span>
                    </div>
                    {row.lastError && row.lastStatus !== 'sent' && <p className="mt-2 text-xs text-destructive">{row.lastError}</p>}
                  </div>
                  <ScheduleMenu row={row} onEdit={() => (setCurrent(row), setView('form'))} />
                </div>
              ))}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
              <Button onClick={() => (setCurrent(null), setView('form'))}><Plus /> New schedule</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Draft = Omit<ScheduleBody, 'weekday' | 'monthDay' | 'subject' | 'note'> & {weekday: number; monthDay: number; subject: string; note: string};

const draftOf = (target: ScheduleTarget, row: ScheduleRow | null, meId: string): Draft => ({
  reportId: target.reportId ?? null,
  dashboardId: target.dashboardId ?? null,
  frequency: (row?.frequency as ScheduleFrequency) ?? 'weekly',
  weekday: row?.weekday ?? 1,
  monthDay: row?.monthDay ?? 1,
  time: row?.time ?? '09:00',
  timezone: row?.timezone ?? browserZone(),
  userIds: row ? row.userIds : [meId],
  emails: row?.emails ?? [],
  subject: row?.subject ?? '',
  note: row?.note ?? '',
  range: (row?.range as ScheduleRange) ?? 'report',
  active: row?.active ?? true,
});

/** What the API takes: unused timing fields cleared. */
const bodyOf = (d: Draft): ScheduleBody => ({
  ...d,
  weekday: d.frequency === 'weekly' ? d.weekday : null,
  monthDay: d.frequency === 'monthly' ? d.monthDay : null,
  subject: d.subject.trim() || null,
  note: d.note.trim() || null,
});

function useDebounced<T>(value: T, ms = 500) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ScheduleForm({target, row, onDone, onCancel}: {target: ScheduleTarget; row: ScheduleRow | null; onDone: () => void; onCancel: () => void}) {
  const {me} = useMe();
  const brand = useBrand();
  const team = useTeam();
  const zones = useMemo(timeZones, []);
  const [draft, setDraft] = useState<Draft>(() => draftOf(target, row, me.id));
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({...d, ...patch}));
  const body = bodyOf(draft);
  const problem = scheduleProblem(body);
  const count = new Set([...draft.userIds, ...draft.emails]).size;
  const zoneOptions = zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones];
  const activeTeam = (team.data ?? []).filter((u) => u.active && !u.invited);

  const timing = useDebounced({frequency: body.frequency, weekday: body.weekday, monthDay: body.monthDay, time: body.time, timezone: body.timezone}, 300);
  const next = useQuery({
    queryKey: [...scheduleKey, 'next', timing],
    queryFn: () => api.post<{slots: string[]}>('/report-schedules/next', timing),
    retry: false,
  });
  const previewBody = useDebounced(body, 600);
  const preview = useQuery({
    queryKey: [...scheduleKey, 'preview', row?.id ?? 'new', previewBody],
    queryFn: () => api.post<{subject: string; html: string; rangeLabel: string; attachments: {filename: string; size: number}[]; skipped: string[]}>('/report-schedules/preview', {...previewBody, id: row?.id}),
    retry: false,
    placeholderData: (prev) => prev,
  });

  const save = useApiMutation(() => (row ? api.patch(`/report-schedules/${row.id}`, body) : api.post('/report-schedules', body)), {
    invalidate: [scheduleKey, keys.audit],
    success: row ? 'Scheduled email saved' : 'Scheduled email created',
    onSuccess: onDone,
  });

  function addEmails(raw: string) {
    const parts = raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((e) => !EMAIL_RE.test(e));
    const good = parts.filter((e) => EMAIL_RE.test(e) && !draft.emails.includes(e));
    if (count + good.length > MAX_RECIPIENTS) {
      setEmailError(`Up to ${MAX_RECIPIENTS} recipients`);
      return;
    }
    if (good.length) set({emails: [...draft.emails, ...good]});
    setEmailError(bad.length ? `Not an email address: ${bad.join(', ')}` : null);
    setEmailInput(bad.join(' '));
  }

  const toggleUser = (id: string, on: boolean) => set({userIds: on ? [...draft.userIds, id] : draft.userIds.filter((x) => x !== id)});

  return (
    <>
      <DialogBody className="grid-cols-1 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @4xl:items-start @4xl:gap-6">
        <div className="grid min-w-0 content-start gap-4">
          <Field label="Frequency">
            <Segmented
              label="Frequency"
              value={draft.frequency}
              onChange={(frequency) => set({frequency})}
              options={(Object.keys(SCHEDULE_FREQUENCIES) as ScheduleFrequency[]).map((f) => ({value: f, label: SCHEDULE_FREQUENCIES[f]}))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            {draft.frequency === 'weekly' && (
              <Field label="On">
                <NativeSelect value={draft.weekday} onChange={(e) => set({weekday: Number(e.target.value)})}>
                  {WEEKDAY_ORDER.map((d) => <option key={d} value={d}>{WEEKDAYS[d]}</option>)}
                </NativeSelect>
              </Field>
            )}
            {draft.frequency === 'monthly' && (
              <Field label="On day" hint={draft.monthDay > 28 ? 'Shorter months send on their last day.' : undefined}>
                <NativeSelect value={draft.monthDay} onChange={(e) => set({monthDay: Number(e.target.value)})}>
                  {Array.from({length: 31}, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                  <option value={-1}>Last day of the month</option>
                </NativeSelect>
              </Field>
            )}
            <Field label="At" htmlFor="schedule-time">
              <Input id="schedule-time" type="time" value={draft.time} onChange={(e) => e.target.value && set({time: e.target.value.slice(0, 5)})} />
            </Field>
            <Field label="Time zone" className={draft.frequency === 'daily' ? undefined : 'col-span-2'}>
              <NativeSelect value={draft.timezone} onChange={(e) => set({timezone: e.target.value})}>
                {zoneOptions.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </NativeSelect>
            </Field>
          </div>
          <p className="-mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <CalendarClock className="size-3.5" />
            {next.data ? <>Next: {next.data.slots.map(whenLocal).join(' · ')} <span>(your time)</span></> : next.error ? next.error.message : 'Working out the next sends…'}
          </p>

          <Field label={`Recipients (${count} of ${MAX_RECIPIENTS})`}>
            <div className="max-h-44 overflow-y-auto rounded-lg border border-input p-1 scrollbar-thin">
              {activeTeam.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                  <Checkbox checked={draft.userIds.includes(u.id)} onCheckedChange={(v) => toggleUser(u.id, v === true)} />
                  <Avatar name={u.name} color={u.color} src={u.avatarUrl} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-slate-800">{u.name}{u.id === me.id && ' (you)'}</span>
                  <span className="hidden truncate text-xs text-muted-foreground @md:inline">{u.email}</span>
                </label>
              ))}
              {!activeTeam.length && <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading the team…</p>}
            </div>
          </Field>
          <Field label="People outside the team" error={emailError} hint="Press Enter or comma to add. They get the same email, unsubscribe link included.">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
              {draft.emails.map((e) => (
                <span key={e} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pr-1 pl-2 text-xs font-medium text-slate-700">
                  {e}
                  <button type="button" aria-label={`Remove ${e}`} className="cursor-pointer rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700" onClick={() => set({emails: draft.emails.filter((x) => x !== e)})}><X className="size-3" /></button>
                </span>
              ))}
              <input
                aria-label="Add an email address"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',') && emailInput.trim()) {
                    e.preventDefault();
                    addEmails(emailInput);
                  } else if (e.key === 'Backspace' && !emailInput && draft.emails.length) set({emails: draft.emails.slice(0, -1)});
                }}
                onBlur={() => emailInput.trim() && addEmails(emailInput)}
                placeholder={draft.emails.length ? '' : 'name@client.com'}
                className="h-7 min-w-40 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
            </div>
          </Field>
          <div className="flex gap-2.5 rounded-lg bg-blue-50/70 px-3 py-2.5 text-xs leading-relaxed text-slate-700">
            <Info className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
            <span>
              Everyone gets the numbers {row && row.owner.id !== me.id ? `${row.owner.name} (who set this up)` : 'you'} can see in {brand.name}: reports run with the creator's visibility, so people outside the team never see more than that.
            </span>
          </div>

          <Field label="Date range">
            <div className="grid gap-2">
              {(Object.keys(SCHEDULE_RANGES) as ScheduleRange[]).map((r) => (
                <label key={r} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors', draft.range === r ? 'border-primary/40 bg-blue-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                  <input type="radio" name="schedule-range" className="mt-1 accent-[var(--primary)]" checked={draft.range === r} onChange={() => set({range: r})} />
                  <span>
                    <span className="font-semibold text-slate-800">{SCHEDULE_RANGES[r]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r === 'report'
                        ? target.dashboardId
                          ? "The dashboard's saved date range, as of the send."
                          : "As saved on the report (e.g. last 30 days), as of the send."
                        : draft.frequency === 'daily'
                          ? 'Yesterday.'
                          : draft.frequency === 'weekly'
                            ? 'The 7 days before the send (Monday sends get last Monday–Sunday).'
                            : 'The days since last month’s send (the 1st gets the whole of last month).'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <Field label="Subject" hint="Leave empty for the report name and date range.">
            <Input value={draft.subject} maxLength={200} placeholder={preview.data?.subject ?? target.name} onChange={(e) => set({subject: e.target.value})} />
          </Field>
          <Field label="Note" hint="Shown above the numbers.">
            <Textarea value={draft.note} maxLength={2000} rows={2} className="min-h-16" placeholder="Here are this week's numbers." onChange={(e) => set({note: e.target.value})} />
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
            <span className="font-semibold">Active</span>
            <Switch checked={draft.active} onCheckedChange={(active) => set({active})} />
          </label>
        </div>
        <div className="min-w-0 @4xl:sticky @4xl:top-0">
          <EmailFramePreview loading={preview.isFetching} error={preview.error?.message} data={preview.data} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => save.mutate(undefined)} disabled={!!problem || save.isPending} title={problem ?? undefined}>
          {save.isPending && <Loader2 className="animate-spin" />} {row ? 'Save' : 'Create schedule'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The rendered email (server-built, real numbers) in a sandboxed frame. */
function EmailFramePreview({data, loading, error}: {data?: {subject: string; html: string; attachments: {filename: string; size: number}[]; skipped: string[]}; loading: boolean; error?: string}) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  // Links in the preview must not navigate the frame.
  const doc = data?.html.replace('<head>', '<head><style>a{pointer-events:none}</style>') ?? '';
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700">Preview {loading && <Loader2 className="ml-1 inline size-3.5 animate-spin text-slate-400" />}</p>
        <Segmented label="Preview size" value={device} onChange={setDevice} options={[{value: 'desktop', label: 'Desktop'}, {value: 'mobile', label: 'Mobile'}]} />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
        <div className="border-b border-slate-200 bg-card px-4 py-2.5">
          <p className="truncate text-sm font-bold text-slate-900">{data?.subject ?? '…'}</p>
          {!!data?.attachments.length && <p className="truncate text-xs text-muted-foreground">Attached: {data.attachments.map((a) => a.filename).join(', ')}</p>}
        </div>
        {error ? (
          <p className="p-6 text-sm text-destructive">{error}</p>
        ) : doc ? (
          <div className="flex justify-center p-3">
            <div className={cn('max-h-[560px] overflow-auto rounded-lg transition-[width] duration-300', device === 'mobile' ? 'w-[375px] max-w-full' : 'w-full')}>
              <EmailFrame html={doc} interactive={false} />
            </div>
          </div>
        ) : (
          <Skeleton className="m-3 h-[560px]" />
        )}
      </div>
    </div>
  );
}
