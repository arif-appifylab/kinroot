/**
 * Email a list: the "Send email" dialog (template or blank, rich editor,
 * branded preview, account, audience, now or later) and the broadcast history
 * (per list, and the overview at /lists/broadcasts). Sending itself runs as
 * background jobs on the server (src/server/lib/broadcasts.ts).
 */
import {useQuery} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {AlertTriangle, CalendarClock, CheckCircle2, Clock, Eye, ListChecks, Loader2, Mail, Send, XCircle} from 'lucide-react';
import {useEffect, useState} from 'react';

import {EmailPreview, RichEditor, Segmented} from '@/components/email-editor';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {EmptyState, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import {dateTime} from '@/lib/format';
import {keys, useApiMutation, useEmailAccounts, useMe, useTemplates} from '@/lib/queries';
import type {UserLite} from '@/lib/types';

export type BroadcastStatus = 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELED';
export type BroadcastStats = {sent: number; failed: number; skipped: number; pending: number; canceled: number; opened: number; clicked: number; unsubscribed: number};
export type BroadcastRow = {
  id: string;
  listId: string | null;
  listName: string;
  subject: string;
  preheader: string | null;
  status: BroadcastStatus;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  canceledAt: string | null;
  waitingUntil: string | null;
  total: number;
  excluded: {noEmail?: number; optedOut?: number; duplicates?: number};
  error: string | null;
  createdAt: string;
  createdById: string | null;
  createdBy: UserLite | null;
  account: {id: string; fromEmail: string; fromName: string; dailyLimit: number} | null;
  stats: BroadcastStats;
};
type Audience = {contacts: number; noEmail: number; optedOut: number; duplicates: number; recipients: number; max: number; account: {dailyLimit: number; sentToday: number} | null};

const broadcastKey = (listId?: string) => [...keys.lists, 'broadcasts', listId ?? 'all'];
const busy = (s: BroadcastStatus) => s === 'SCHEDULED' || s === 'SENDING';

export function useBroadcasts(listId?: string) {
  return useQuery({
    queryKey: broadcastKey(listId),
    queryFn: () => api.get<{rows: BroadcastRow[]}>('/broadcasts', {listId}),
    select: (d) => d.rows,
    // Sending happens in the background: refresh while anything is on its way.
    refetchInterval: (q) => (q.state.data?.rows.some((b) => busy(b.status)) ? 5000 : false),
  });
}

const STATUS: Record<BroadcastStatus, {label: string; tone: 'blue' | 'violet' | 'green' | 'neutral'; icon: typeof Clock}> = {
  SCHEDULED: {label: 'Scheduled', tone: 'blue', icon: CalendarClock},
  SENDING: {label: 'Sending', tone: 'violet', icon: Loader2},
  SENT: {label: 'Sent', tone: 'green', icon: CheckCircle2},
  CANCELED: {label: 'Canceled', tone: 'neutral', icon: XCircle},
};

/** Scheduled for now or earlier: "Send now", or a schedule that is due, waiting for the job runner. */
const starting = (b: Pick<BroadcastRow, 'status' | 'scheduledAt'>) => b.status === 'SCHEDULED' && new Date(b.scheduledAt).getTime() <= Date.now();

export function BroadcastStatusBadge({b}: {b: Pick<BroadcastRow, 'status' | 'waitingUntil' | 'scheduledAt'>}) {
  if (starting(b)) {
    return (
      <Badge tone="violet">
        <Loader2 className="animate-spin" /> Starting
      </Badge>
    );
  }
  const s = STATUS[b.status];
  const Icon = s.icon;
  return (
    <Badge tone={b.status === 'SENDING' && b.waitingUntil ? 'amber' : s.tone}>
      <Icon className={b.status === 'SENDING' && !b.waitingUntil ? 'animate-spin' : undefined} /> {b.status === 'SENDING' && b.waitingUntil ? 'Paused' : s.label}
    </Badge>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

/** "now" in the browser's zone as a datetime-local value, rounded up to the next quarter hour. */
function soonLocal() {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Lists | Broadcasts switch under the Lists page header. */
export function ListsNav({current}: {current: 'lists' | 'broadcasts'}) {
  const navigate = useNavigate();
  return (
    <Tabs value={current} onValueChange={(v) => navigate(v === 'lists' ? {to: '/lists', search: {}} : {to: '/lists/broadcasts'})} className="mb-4">
      <TabsList>
        <TabsTrigger value="lists"><ListChecks /> Lists</TabsTrigger>
        <TabsTrigger value="broadcasts"><Mail /> Broadcasts</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

// ─── Send email to a list ───────────────────────────────────────────────────

export function BroadcastDialog({list, onClose}: {list: {id: string; name: string}; onClose: () => void}) {
  const accounts = useEmailAccounts();
  const templates = useTemplates();
  const {me} = useMe();
  const [accountId, setAccountId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState('');
  // The editor keeps its own state; a new key loads a template into it.
  const [editorKey, setEditorKey] = useState(0);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(soonLocal);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!accountId && accounts.data?.length) setAccountId((accounts.data.find((a) => a.isDefault && a.userId === me.id) ?? accounts.data.find((a) => a.isDefault) ?? accounts.data[0])!.id);
  }, [accounts.data, accountId, me.id]);

  const audience = useQuery({
    queryKey: [...broadcastKey(list.id), 'audience', accountId],
    queryFn: () => api.get<Audience>('/broadcasts/audience', {listId: list.id, accountId: accountId || undefined}),
  });
  const account = accounts.data?.find((a) => a.id === accountId);

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    setPreheader(t.preheader ?? '');
    setHtml(t.html || textToEditorHtml(t.body));
    setEditorKey((k) => k + 1);
  };

  const send = useApiMutation(
    () =>
      api.post<{broadcast: BroadcastRow}>('/broadcasts', {
        listId: list.id,
        accountId,
        subject,
        html,
        preheader: preheader || null,
        templateId: templateId || null,
        scheduledAt: when === 'later' ? new Date(at).toISOString() : null,
      }),
    {
      invalidate: [[...keys.lists, 'broadcasts']],
      success: (r) => (when === 'later' ? `Scheduled for ${dateTime(r.broadcast.scheduledAt)}` : 'Sending started'),
      onSuccess: onClose,
    },
  );

  const a = audience.data;
  const empty = isEmptyHtml(html);
  const left = a?.account ? Math.max(0, a.account.dailyLimit - a.account.sentToday) : null;
  const days = a?.account && a.recipients > (left ?? 0) ? 1 + Math.ceil((a.recipients - (left ?? 0)) / a.account.dailyLimit) : 1;
  const canSend = !!accountId && !!subject.trim() && !empty && !!a?.recipients && (when === 'now' || !!at);
  const noAccounts = accounts.isSuccess && !accounts.data.length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Email “{list.name}”</DialogTitle>
          <DialogDescription>One email to everyone in this list, sent in the branded layout with an unsubscribe link. Each email shows on the contact’s timeline.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {noAccounts ? (
            <EmptyState
              icon={<Mail />}
              title="Connect an email account first"
              description="Broadcasts go out through one of your email accounts or a shared team account."
              action={<Button asChild><Link to="/settings/email">Connect email</Link></Button>}
            />
          ) : (
            <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="grid min-w-0 content-start gap-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Start from" htmlFor="bc-template">
                    <NativeSelect id="bc-template" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                      <option value="">Blank email</option>
                      {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </NativeSelect>
                  </Field>
                  <Field label="Send from" htmlFor="bc-account">
                    <NativeSelect id="bc-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                      {accounts.data?.map((x) => <option key={x.id} value={x.id}>{x.fromEmail} · {x.userId ? 'yours' : 'shared'}</option>)}
                    </NativeSelect>
                  </Field>
                </div>
                <Field label="Subject" htmlFor="bc-subject">
                  <Input id="bc-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. What’s new this month, {{contact.first_name|there}}" maxLength={500} />
                </Field>
                <Field label="Preview text" htmlFor="bc-preheader" hint="Shown next to the subject in most inboxes.">
                  <Input id="bc-preheader" value={preheader} onChange={(e) => setPreheader(e.target.value)} maxLength={300} />
                </Field>
                <RichEditor key={editorKey} value={html} onChange={setHtml} placeholder="Write your email… merge fields like the first name are filled in per contact" />
              </div>

              <div className="grid content-start gap-3">
                <Card className="p-4">
                  <h3 className="text-sm font-bold text-slate-900">Recipients</h3>
                  {audience.isLoading || !a ? (
                    <Skeleton className="mt-3 h-20" />
                  ) : (
                    <>
                      <p className="mt-1 text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">{a.recipients.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">of {a.contacts.toLocaleString()} contacts in the list{a.contacts !== a.recipients ? ', after leaving out:' : ''}</p>
                      {a.contacts !== a.recipients && (
                        <dl className="mt-2 grid gap-1 text-sm">
                          {[
                            ['Opted out of email', a.optedOut],
                            ['No email address', a.noEmail],
                            ['Duplicate addresses', a.duplicates],
                          ].map(([label, n]) => (
                            <div key={label as string} className="flex justify-between gap-2">
                              <dt className="text-slate-600">{label}</dt>
                              <dd className="font-semibold text-slate-800 tabular-nums">{(n as number).toLocaleString()}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {a.recipients > a.max && <p className="mt-2 text-xs font-semibold text-destructive">More than {a.max.toLocaleString()} recipients: split the list first.</p>}
                      {a.account && (
                        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-muted-foreground">
                          {account?.fromEmail} sends up to {a.account.dailyLimit.toLocaleString()} emails a day ({left?.toLocaleString()} left today).
                          {days > 1 && <span className="mt-1 flex items-start gap-1.5 font-medium text-amber-700"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Sending continues automatically over about {days} days.</span>}
                        </p>
                      )}
                    </>
                  )}
                </Card>

                <Card className="grid gap-3 p-4">
                  <h3 className="text-sm font-bold text-slate-900">When</h3>
                  <Segmented label="When to send" value={when} onChange={setWhen} options={[{value: 'now', label: 'Send now', icon: <Send />}, {value: 'later', label: 'Schedule', icon: <Clock />}]} />
                  {when === 'later' && <Input aria-label="Send at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />}
                </Card>
              </div>
            </div>
          )}
        </DialogBody>
        {!noAccounts && (
          <DialogFooter>
            <Button variant="ghost" className="@sm:mr-auto" onClick={() => setPreviewing(true)} disabled={empty}><Eye /> Preview</Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => send.mutate(undefined)} disabled={!canSend || send.isPending}>
              {send.isPending ? <Loader2 className="animate-spin" /> : when === 'later' ? <CalendarClock /> : <Send />}
              {when === 'later' ? 'Schedule' : `Send to ${a?.recipients.toLocaleString() ?? '…'}`}
            </Button>
          </DialogFooter>
        )}
        {previewing && (
          <Dialog open onOpenChange={(o) => !o && setPreviewing(false)}>
            <DialogContent size="lg">
              <DialogHeader><DialogTitle>Preview</DialogTitle></DialogHeader>
              <DialogBody>
                <EmailPreview html={html} subject={subject} preheader={preheader || null} layout="branded" signatureHtml={account?.signatureHtml || (account?.signature ? textToEditorHtml(account.signature) : null)} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

/** Broadcasts of one list, or of every list (overview). */
export function BroadcastHistory({listId, title = 'Emails to this list'}: {listId?: string; title?: string}) {
  const rows = useBroadcasts(listId);
  const [open, setOpen] = useState<string | null>(null);
  if (listId && !rows.isLoading && !rows.data?.length) return null;

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
      </div>
      {rows.isLoading && <Skeleton className="m-4 h-16" />}
      {!rows.isLoading && !rows.data?.length && (
        <EmptyState icon={<Mail />} title="No broadcasts yet" description="Open a list or segment and choose “Send email” to email everyone in it at once." />
      )}
      {!!rows.data?.length && (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-bold tracking-wide text-slate-500 uppercase">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Sent</th>
                <th className="px-4 py-3 text-right">Failed</th>
                <th className="px-4 py-3 text-right">Opened</th>
                <th className="px-4 py-3 text-right">Clicked</th>
                <th className="px-4 py-3 text-right">Unsubscribed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.data.map((b) => (
                <tr key={b.id} className="cursor-pointer hover:bg-slate-50/70" onClick={() => setOpen(b.id)}>
                  <td className="max-w-0 px-4 py-3">
                    <p className="truncate font-semibold text-slate-900">{b.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {!listId && <>{b.listName} · </>}
                      {starting(b) ? 'starting now' : b.status === 'SCHEDULED' ? `for ${dateTime(b.scheduledAt)}` : dateTime(b.finishedAt ?? b.startedAt ?? b.scheduledAt)}
                      {b.createdBy && <> · {b.createdBy.name}</>}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <BroadcastStatusBadge b={b} />
                    {b.status === 'SENDING' && <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{b.stats.sent + b.stats.failed + b.stats.skipped} of {b.total}</p>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{b.stats.sent.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.stats.failed ? b.stats.failed.toLocaleString() : <span className="text-slate-400">0</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.stats.opened.toLocaleString()} <span className="text-xs text-muted-foreground">{pct(b.stats.opened, b.stats.sent)}</span></td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.stats.clicked.toLocaleString()} <span className="text-xs text-muted-foreground">{pct(b.stats.clicked, b.stats.sent)}</span></td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.stats.unsubscribed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <BroadcastDetail id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

type Problem = {id: string; email: string; contactId: string | null; status: 'FAILED' | 'SKIPPED'; error: string | null};

function BroadcastDetail({id, onClose}: {id: string; onClose: () => void}) {
  const {me, isAdmin, canEdit} = useMe();
  const q = useQuery({
    queryKey: [...keys.lists, 'broadcasts', 'detail', id],
    queryFn: () => api.get<{broadcast: BroadcastRow; problems: Problem[]}>(`/broadcasts/${id}`),
    refetchInterval: (s) => (s.state.data && busy(s.state.data.broadcast.status) ? 5000 : false),
  });
  const cancel = useApiMutation(() => api.post(`/broadcasts/${id}/cancel`, {}), {invalidate: [[...keys.lists, 'broadcasts']], success: 'Broadcast canceled'});
  const b = q.data?.broadcast;
  const s = b?.stats;
  const mayCancel = !!b && canEdit && busy(b.status) && (b.createdById === me.id || isAdmin);
  const excluded = b ? (b.excluded.optedOut ?? 0) + (b.excluded.noEmail ?? 0) + (b.excluded.duplicates ?? 0) : 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="pr-4">{b?.subject ?? 'Broadcast'}</DialogTitle>
          {b && (
            <DialogDescription>
              To {b.listId ? <Link to="/lists/$listId" params={{listId: b.listId}} search={{}} className="font-semibold text-primary hover:underline">{b.listName}</Link> : b.listName}
              {b.account && <> from {b.account.fromEmail}</>}
              {b.createdBy && <> · by {b.createdBy.name}</>}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          {!b || !s ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <BroadcastStatusBadge b={b} />
                {b.status === 'SCHEDULED' && <span>{starting(b) ? 'Starting: the first emails go out within a minute' : `Sends ${dateTime(b.scheduledAt)}`}</span>}
                {b.status === 'SENDING' && <span className="tabular-nums">{s.sent + s.failed + s.skipped} of {b.total} done</span>}
                {b.status === 'SENT' && <span>Finished {dateTime(b.finishedAt)}</span>}
                {b.status === 'CANCELED' && <span>Canceled {dateTime(b.canceledAt)}</span>}
              </div>
              {b.waitingUntil && b.status === 'SENDING' && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <Clock className="mt-0.5 size-4 shrink-0" />
                  {b.error ?? `Daily sending limit of ${b.account?.dailyLimit ?? ''} reached.`} Continues {dateTime(b.waitingUntil)}.
                </p>
              )}
              {b.error && !(b.waitingUntil && b.status === 'SENDING') && <p className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {b.error}</p>}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Sent', s.sent, b.total ? `of ${b.total}` : ''],
                  ['Opened', s.opened, pct(s.opened, s.sent)],
                  ['Clicked', s.clicked, pct(s.clicked, s.sent)],
                  ['Unsubscribed', s.unsubscribed, pct(s.unsubscribed, s.sent)],
                ].map(([label, n, sub]) => (
                  <div key={label as string} className="rounded-xl border border-slate-100 p-3">
                    <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 text-xl font-extrabold tracking-tight text-slate-900 tabular-nums">{(n as number).toLocaleString()}</dd>
                    <dd className="text-xs text-muted-foreground tabular-nums">{sub}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                {s.failed > 0 && <>{s.failed} failed · </>}
                {s.skipped > 0 && <>{s.skipped} skipped (unsubscribed before sending) · </>}
                {s.canceled > 0 && <>{s.canceled} not sent (canceled) · </>}
                {b.startedAt ? `${excluded} left out when sending started (opted out, no address or duplicate)` : 'Recipients are counted again when sending starts.'}
              </p>
              {q.data!.problems.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-bold text-slate-900">Not delivered</h3>
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100 text-sm">
                    {q.data!.problems.map((p) => (
                      <li key={p.id} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                        {p.contactId ? <Link to="/contacts/$contactId" params={{contactId: p.contactId}} className="font-semibold text-slate-800 hover:text-primary">{p.email}</Link> : <span className="font-semibold text-slate-800">{p.email}</span>}
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.error}</span>
                        <Badge tone={p.status === 'FAILED' ? 'rose' : 'neutral'}>{p.status === 'FAILED' ? 'Failed' : 'Skipped'}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </DialogBody>
        {mayCancel && (
          <DialogFooter>
            <Button variant="destructive" onClick={async () => (await confirm({title: 'Cancel this broadcast?', description: 'Emails already sent stay sent; the rest are not sent.', confirmLabel: 'Cancel broadcast', cancelLabel: 'Keep sending', destructive: true})) && cancel.mutate(undefined)} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2 className="animate-spin" /> : <XCircle />} Cancel broadcast
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
