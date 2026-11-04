import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {
  AlarmClock,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  Eye,
  Inbox,
  Lock,
  Mail,
  MailWarning,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  StickyNote,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';

import {api, ApiError} from '@/lib/api';
import {ago, dateTime, toLocalInput} from '@/lib/format';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import type {ConversationComment, ConversationDetail, EmailMessage} from '@/lib/types';
import {cn} from '@/lib/utils';

import {MentionText} from '../mentions';
import {useBinToast} from '../recycle-bin-toast';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {confirm} from '../ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input} from '../ui/form';
import {is, useFormState} from '../ui/form-state';
import {LoadError} from '../data-table';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip} from '../ui/menu';
import {Avatar, EmptyState, Skeleton} from '../ui/misc';
import {useChimeOn} from './chat-sound';
import {ChatComposer, ChatTimeline} from './chat-thread';
import {ConversationSidebar} from './conversation-sidebar';
import {ChannelIcon, MessageFrame} from './parts';
import {ReplyComposer, type ComposerMode} from './reply-composer';

const invalidate = [keys.inbox, keys.timeline, keys.email];

/** The detail as the server sends it: plus its own time (the first `after`) and whether older emails exist. */
type Detail = ConversationDetail & {now?: string; olderMessages?: boolean};
type ChatMessage = NonNullable<ConversationDetail['chat']>['messages'][number];
type Updates = {
  now: string;
  state: Record<(typeof STATE_FIELDS)[number], string | null> & {lastEmailId: string | null};
  chat: {messages: ChatMessage[]; typing: boolean; visitor: {lastSeenAt: string; online: boolean; away: boolean} | null} | null;
  comments: ConversationComment[];
};
/** The thread's state: when one of these moved, the whole detail is loaded again. */
const STATE_FIELDS = ['status', 'assigneeId', 'snoozedUntil', 'spamAt', 'trashedAt', 'contactId', 'dealId', 'companyId'] as const;
const NO_MESSAGES: EmailMessage[] = [];

function mergeById<T extends {id: string}>(old: T[], fresh: T[], at: (x: T) => string) {
  if (!fresh.length) return old;
  const byId = new Map(old.map((x) => [x.id, x]));
  for (const x of fresh) byId.set(x.id, x);
  return [...byId.values()].sort((a, b) => at(a).localeCompare(at(b)));
}

/**
 * Keeps an open conversation live without downloading it again and again (AUDIT P2-20): polls
 * `/updates` since the last answer (every 3 s for a chat, 20 s for email, only while the tab is
 * visible) and merges new chat messages, delivery / read changes, comments, typing and presence into
 * the cached detail. When the state moved (assigned, closed, linked…) or a new email arrived, the
 * full detail is loaded again; it also loads on open, on focus and after a write.
 */
function useConversationUpdates(id: string, detail: Detail | undefined) {
  const qc = useQueryClient();
  const cursor = useRef<string | null>(null);
  useEffect(() => {
    cursor.current = detail?.now ?? null;
  }, [detail?.now]);
  useQuery({
    queryKey: [...keys.inbox, 'conversation', id, 'updates'],
    enabled: !!detail?.now,
    refetchInterval: detail?.chat ? 3000 : 20_000,
    queryFn: async () => {
      const key = [...keys.inbox, 'conversation', id];
      const after = cursor.current;
      if (!after) return null;
      const u = await api.get<Updates>(`/inbox/conversations/${id}/updates`, {after});
      cursor.current = u.now;
      const cur = qc.getQueryData<Detail>(key);
      if (!cur) return u;
      const moved = STATE_FIELDS.some((f) => (cur.conversation[f] ?? null) !== (u.state[f] ?? null)) || (cur.messages.at(-1)?.id ?? null) !== u.state.lastEmailId;
      if (moved) {
        void qc.invalidateQueries({queryKey: key, exact: true});
        return u;
      }
      qc.setQueryData<Detail>(key, (old) => {
        if (!old) return old;
        const chat = old.chat && u.chat
          ? {...old.chat, typing: u.chat.typing, messages: mergeById(old.chat.messages, u.chat.messages, (m) => m.createdAt), visitor: old.chat.visitor && u.chat.visitor ? {...old.chat.visitor, ...u.chat.visitor} : old.chat.visitor}
          : old.chat;
        return {...old, chat, comments: mergeById(old.comments, u.comments, (c) => c.createdAt)};
      });
      return u;
    },
  });
}

/** Splits the quoted history off a plain-text reply ("On … wrote:", "> …"). */
function splitQuoted(text: string): [string, string] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l, i) => /^On .{4,300}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || (/^>/.test(l.trim()) && lines.slice(i).every((x) => !x.trim() || /^>/.test(x.trim()))));
  if (at <= 0) return [text.trim(), ''];
  return [lines.slice(0, at).join('\n').trim(), lines.slice(at).join('\n').trim()];
}

function MessageBody({m}: {m: EmailMessage}) {
  const [quoted, setQuoted] = useState(false);
  if (m.html) return <MessageFrame html={m.html} />;
  const [main, rest] = splitQuoted(m.text ?? '');
  return (
    <div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-800">{main || <span className="text-slate-400">(empty message)</span>}</p>
      {rest && (
        <>
          <button type="button" onClick={() => setQuoted((v) => !v)} className="mt-2 cursor-pointer rounded bg-slate-100 px-2 text-xs font-bold text-slate-500 hover:bg-slate-200" aria-label={quoted ? 'Hide quoted text' : 'Show quoted text'}>···</button>
          {quoted && <p className="mt-2 border-l-2 border-slate-200 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-500">{rest}</p>}
        </>
      )}
    </div>
  );
}

function MessageCard({m}: {m: EmailMessage}) {
  const inbound = m.direction === 'INBOUND';
  const name = inbound ? m.fromName || m.fromEmail : (m.sender?.name ?? m.fromName ?? m.fromEmail);
  return (
    <li className={cn('min-w-0 rounded-xl border p-4 shadow-soft', inbound ? 'border-slate-100 bg-card' : 'border-blue-100 bg-blue-50/40')}>
      <header className="mb-3 flex items-start gap-3">
        <Avatar name={name} color={inbound ? '#0d9488' : m.sender?.color} src={inbound ? null : m.sender?.avatarUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{name} {inbound && m.fromName && <span className="font-normal text-muted-foreground">{m.fromEmail}</span>}</p>
          <p className="truncate text-xs text-muted-foreground">to {m.to.join(', ')}{m.cc.length ? `, cc ${m.cc.join(', ')}` : ''}</p>
        </div>
        <div className="shrink-0 text-right">
          <Tooltip content={dateTime(m.sentAt)}><p className="text-xs text-muted-foreground">{ago(m.sentAt)}</p></Tooltip>
          {!inbound && m.status === 'SENT' && m.openCount > 0 && <Badge tone="green" className="mt-1"><Eye /> Opened</Badge>}
          {m.status === 'FAILED' && <Badge tone="rose" className="mt-1"><MailWarning /> Not sent</Badge>}
        </div>
      </header>
      <MessageBody m={m} />
      {m.error && <p className="mt-2 text-xs font-medium text-destructive">{m.error}</p>}
    </li>
  );
}

function CommentCard({c, threadId}: {c: ConversationComment; threadId: string}) {
  const {me, isAdmin} = useMe();
  const remove = useApiMutation(() => api.del(`/inbox/conversations/${threadId}/comments/${c.id}`), {invalidate, success: 'Comment deleted'});
  return (
    <li className="group rounded-xl border border-amber-100 bg-amber-50/60 p-4">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {c.author && <Avatar name={c.author.name} color={c.author.color} src={c.author.avatarUrl} size="xs" className="ring-0" />}
        <span className="font-semibold text-slate-700">{c.author?.name ?? 'Someone'}</span> · comment · <Tooltip content={dateTime(c.createdAt)}><span>{ago(c.createdAt)}</span></Tooltip>
        <span className="ml-auto flex items-center gap-1">
          {(c.authorId === me.id || isAdmin) && (
            <button
              type="button"
              aria-label="Delete comment"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={async () => (await confirm({title: 'Delete this comment?', confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}
              className="cursor-pointer rounded p-0.5 text-slate-300 opacity-0 outline-none group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed"
            >
              <X className="size-3.5" />
            </button>
          )}
          <Lock className="size-3.5 text-amber-500" aria-label="Only your team sees this" />
        </span>
      </p>
      <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-800"><MentionText text={c.body} /></p>
    </li>
  );
}

function EventLine({c}: {c: ConversationComment}) {
  const d = c.data as {type?: string; name?: string | null; to?: string | null; via?: string | null; until?: string; reason?: string; blocked?: string | null; number?: number; count?: number};
  const who = c.author?.name ?? 'System';
  const text = (() => {
    switch (d.type) {
      case 'assigned':
        return d.to ? `${d.via === 'round_robin' ? 'Round robin' : d.via === 'owner' ? 'Mailbox owner' : who}: assigned to ${d.name ?? 'someone'}` : `${who} removed the assignee`;
      case 'closed':
        return d.reason === 'auto' ? 'Closed automatically (no reply)' : `${who} closed this`;
      case 'reopened':
        return d.reason === 'reply' ? 'Reopened by a new reply' : `${who} reopened this`;
      case 'snoozed':
        return `${who} snoozed this until ${dateTime(d.until)}`;
      case 'unsnoozed':
        return `${who} unsnoozed this`;
      case 'woke':
        return 'Back from snooze';
      case 'spam':
        return `${who} marked this as spam${d.blocked ? ` and blocked ${d.blocked}` : ''}`;
      case 'not_spam':
        return `${who} moved this out of spam`;
      case 'trashed':
        return `${who} moved this to trash`;
      case 'restored':
        return `${who} restored this`;
      case 'deal':
        return d.to ? `${who} associated a deal` : `${who} removed the deal`;
      case 'ticket':
        return `${who} created ticket #${d.number}`;
      case 'transcript':
        return `${who} emailed the transcript to ${d.to}`;
      case 'chat_emailed':
        return `The visitor had left: ${d.count === 1 ? 'the reply was' : `${d.count} replies were`} emailed to ${d.to}`;
      case 'chat_email_failed':
        return `Couldn't email the reply to the visitor: ${d.reason}`;
      default:
        return null;
    }
  })();
  if (!text) return null;
  return (
    <li className="flex items-center gap-2 px-1 text-xs text-slate-500">
      <span className="h-px flex-1 bg-slate-200" aria-hidden />
      <span className="max-w-[80%] text-center">{text} · {ago(c.createdAt)}</span>
      <span className="h-px flex-1 bg-slate-200" aria-hidden />
    </li>
  );
}

/** Stays open until the snooze is saved; the server's words about the time (`fields.until`) land on the field. */
function SnoozeDrawer({onPick, onClose, pending}: {onPick: (iso: string, onError: (e: unknown) => void) => void; onClose: () => void; pending: boolean}) {
  const [until, setUntil] = useState(toLocalInput(new Date(Date.now() + 24 * 3600_000).toISOString()));
  const f = useFormState({until}, {until: [is.required('Choose when it comes back.'), (v) => (v && new Date(v).getTime() <= Date.now() ? 'Choose a time in the future.' : null)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent size="sm">
        <form {...f.form(() => onPick(new Date(until).toISOString(), f.fail))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>It leaves the open views and comes back, unread, at this time.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Date and time" htmlFor="snooze-at" error={f.error('until')}><Input id="snooze-at" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} onBlur={f.blur('until')} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" pending={pending} pendingLabel="Snoozing…">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const at = (days: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};
function snoozePresets() {
  const now = new Date();
  const monday = (8 - now.getDay()) % 7 || 7;
  return [
    ['In 3 hours', new Date(now.getTime() + 3 * 3600_000)],
    ['Tomorrow, 9 am', at(1, 9)],
    ['Next week, Monday 9 am', at(monday, 9)],
  ] as const;
}

/** Keyboard shortcuts on the open conversation: e close / reopen, a assign, r reply, c comment. */
function useConversationKeys(handlers: Record<string, () => void>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest('[role="dialog"],[role="menu"]'))) return;
      const fn = handlers[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

export function ConversationView({id, onBack, onGone}: {id: string; onBack: () => void; onGone: () => void}) {
  const {me, isAdmin, canEdit} = useMe();
  const team = useTeam();
  const binToast = useBinToast();
  const [mode, setMode] = useState<ComposerMode>('reply');
  const [focusKey, setFocusKey] = useState(0);
  const [assignOpen, setAssignOpen] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [details, setDetails] = useState(false);
  // The full detail loads on open, on focus and after a write; what changes meanwhile comes from
  // the light `/updates` poll (useConversationUpdates), quick for a chat, at the inbox rhythm for email.
  const q = useQuery({
    queryKey: [...keys.inbox, 'conversation', id],
    queryFn: () => api.get<Detail>(`/inbox/conversations/${id}`),
  });
  useConversationUpdates(id, q.data);
  // "Load older": email messages before the newest 200 the detail brings, kept for this conversation.
  const [older, setOlder] = useState<{id: string; rows: EmailMessage[]; more: boolean; error: string | null} | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRows = older?.id === id ? older.rows : NO_MESSAGES;
  const hasOlder = older?.id === id ? older.more : !!q.data?.olderMessages;
  async function loadOlder() {
    const first = olderRows[0] ?? q.data?.messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const r = await api.get<{messages: EmailMessage[]; more: boolean}>(`/inbox/conversations/${id}/messages`, {before: first.sentAt, beforeId: first.id});
      setOlder({id, rows: [...r.messages, ...olderRows], more: r.more, error: null});
    } catch (e) {
      setOlder({id, rows: olderRows, more: true, error: (e as Error).message || 'Could not load older messages. Try again.'});
    } finally {
      setLoadingOlder(false);
    }
  }
  const act = useApiMutation((body: {action: string; assigneeId?: string | null; until?: string; block?: 'address' | 'domain' | 'visitor' | null}) => api.post<{binIds?: string[]}>('/inbox/conversations/actions', {ids: [id], ...body}), {invalidate});
  const detail = q.data;
  const t = detail?.conversation;
  const chat = detail?.chat ?? null;
  const transcript = useApiMutation(() => api.post<{to: string}>(`/inbox/conversations/${id}/transcript`), {invalidate, success: (r) => `Transcript emailed to ${r.to}`});
  useChimeOn([...(chat?.messages ?? [])].reverse().find((m) => m.direction === 'INBOUND')?.createdAt, !!chat);

  const items = useMemo(() => {
    if (!detail) return [];
    return [
      ...(detail.chat ? [] : [...olderRows, ...detail.messages].map((m) => ({at: m.sentAt, key: `m${m.id}`, node: <MessageCard key={`m${m.id}`} m={m} />}))),
      ...detail.comments.map((c) => ({at: c.createdAt, key: `c${c.id}`, node: c.kind === 'event' ? <EventLine key={`c${c.id}`} c={c} /> : <CommentCard key={`c${c.id}`} c={c} threadId={detail.conversation.id} />})),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [detail, olderRows]);

  const ask = (m: ComposerMode) => (setMode(m), setFocusKey((k) => k + 1));
  const toggleStatus = () => t && canEdit && act.mutate({action: t.status === 'OPEN' ? 'close' : 'reopen'});
  useConversationKeys(t && canEdit && t.channel !== 'ticket' ? {e: toggleStatus, a: () => setAssignOpen(true), r: () => ask('reply'), c: () => ask('comment')} : {});

  if (q.isLoading) return <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
  if (!detail && q.isError && !(q.error instanceof ApiError && q.error.status === 404)) return <LoadError className="h-full" error={q.error} onRetry={() => q.refetch()} />;
  if (!detail || !t) return <EmptyState className="h-full" icon={<Inbox />} title="Conversation not found" description={(q.error as Error | null)?.message ?? 'It may have been deleted, or you no longer have access.'} />;

  const users = (team.data ?? []).filter((u) => u.active && (!t.personal || u.id === t.account?.userId));
  const spam = !!t.spamAt;
  const trashed = !!t.trashedAt;
  const block = async (kind: 'address' | 'domain' | 'visitor') => {
    const from = detail.sidebar.sender?.email ?? '';
    if (kind === 'visitor') {
      if (await confirm({title: 'Block this visitor?', description: 'This chat is marked as spam, and their next messages go straight to Spam. "Not spam" unblocks them.', confirmLabel: 'Mark spam & block', destructive: true})) act.mutate({action: 'spam', block: 'visitor'});
      return;
    }
    const target = kind === 'address' ? from : from.split('@')[1];
    if (await confirm({title: `Block ${target}?`, description: 'This is marked as spam, and future mail from it goes straight to Spam. Admins can unblock it in Settings → Inbox.', confirmLabel: 'Mark spam & block', destructive: true})) {
      act.mutate({action: 'spam', block: kind});
    }
  };
  const remove = async () => {
    if (!(await confirm({title: 'Delete this conversation forever?', description: 'It leaves the inbox for good, with its messages and comments. Admins can still restore it from Settings → Recycle bin for 30 days.', confirmLabel: 'Delete forever', destructive: true}))) return;
    const r = await act.mutateAsync({action: 'delete'});
    binToast('Conversation', r.binIds?.[0]);
    onGone();
  };

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <button type="button" onClick={onBack} className="-ml-1 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-slate-100 lg:hidden" aria-label="Back to the list"><ArrowLeft className="size-4" /></button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-slate-900">{t.subject}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <ChannelIcon channel={t.channel} personal={t.personal} />
            <span className="truncate">{t.channel === 'form' ? 'Form response' : chat ? `Website chat${chat.visitor ? ` · ${chat.visitor.online ? 'on the site now' : `last seen ${ago(chat.visitor.lastSeenAt)}`}` : ''}` : t.personal ? 'Your mailbox · private' : (t.account?.fromEmail ?? 'Team inbox')}</span>
            {t.status === 'CLOSED' && <Badge tone="neutral">Closed</Badge>}
            {t.snoozedUntil && <Badge tone="violet"><AlarmClock /> Until {dateTime(t.snoozedUntil)}</Badge>}
            {spam && <Badge tone="rose">Spam</Badge>}
            {trashed && <Badge tone="amber">In trash</Badge>}
            {t.ticket && <Link to="/tickets/$ticketId" params={{ticketId: String(t.ticket.number)}}><Badge tone="violet" className="cursor-pointer">Ticket #{t.ticket.number}</Badge></Link>}
          </div>
        </div>
        {canEdit && t.channel !== 'ticket' && (
          <div className="flex flex-wrap items-center gap-1.5">
            <DropdownMenu open={assignOpen} onOpenChange={setAssignOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" aria-label="Assign (a)">
                  {t.assignee ? <Avatar name={t.assignee.name} color={t.assignee.color} src={t.assignee.avatarUrl} size="xs" className="ring-0" /> : <UserPlus />}
                  <span className="max-w-28 truncate">{t.assignee ? (t.assignee.id === me.id ? 'Me' : t.assignee.name) : 'Assign'}</span>
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 w-56 overflow-y-auto">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {users.map((u) => (
                  <DropdownMenuItem key={u.id} onSelect={() => act.mutate({action: 'assign', assigneeId: u.id})}>
                    <Avatar name={u.name} color={u.color} src={u.avatarUrl} size="xs" className="ring-0" /> <span className="truncate">{u.id === me.id ? `${u.name} (me)` : u.name}</span>
                  </DropdownMenuItem>
                ))}
                {t.assigneeId && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => act.mutate({action: 'assign', assigneeId: null})}><X /> Unassign</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {t.status === 'OPEN' ? (
              <Button variant="success" size="sm" onClick={toggleStatus} disabled={act.isPending} pending={act.isPending && act.variables?.action === 'close'} pendingLabel="Closing…" aria-label="Close (e)"><CheckCircle2 /> Close</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={toggleStatus} disabled={act.isPending} pending={act.isPending && act.variables?.action === 'reopen'} pendingLabel="Reopening…" aria-label="Reopen (e)"><RotateCcw /> Reopen</Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon-sm" aria-label="Snooze"><AlarmClock /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                {snoozePresets().map(([label, when]) => (
                  <DropdownMenuItem key={label} onSelect={() => act.mutate({action: 'snooze', until: when.toISOString()})}>
                    <span className="flex-1">{label}</span>
                    <span className="text-xs text-muted-foreground">{when.toLocaleDateString(undefined, {weekday: 'short'})}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => setSnoozing(true)}>Pick a date & time…</DropdownMenuItem>
                {t.snoozedUntil && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => act.mutate({action: 'unsnooze'})}><X /> Unsnooze</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* The sidebar only fits inline on wide panes; below that it opens as a drawer. */}
            <Tooltip content="Contact & details">
              <Button variant="secondary" size="icon-sm" className="@3xl:hidden" onClick={() => setDetails(true)} aria-label="Contact & details"><PanelRight /></Button>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon-sm" aria-label="More actions"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <DropdownMenuItem onSelect={() => setDetails(true)}><PanelRight /> Contact & details</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => act.mutate({action: 'unread'}, {onSuccess: onBack})}><StickyNote /> Mark as unread</DropdownMenuItem>
                {t.channel === 'chat' && (
                  <DropdownMenuItem disabled={!detail.replyTo || transcript.isPending} onSelect={() => transcript.mutate(undefined)}>
                    <Mail /> {detail.replyTo ? 'Email transcript' : 'Email transcript (no email given)'}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {spam ? (
                  <DropdownMenuItem onSelect={() => act.mutate({action: 'not_spam'})}><ShieldCheck /> Not spam</DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => act.mutate({action: 'spam'})}><ShieldAlert /> Mark as spam</DropdownMenuItem>
                    {chat?.visitor && <DropdownMenuItem onSelect={() => block('visitor')}><Ban /> Spam & block visitor</DropdownMenuItem>}
                    {detail.sidebar.sender?.email.includes('@') && (
                      <>
                        <DropdownMenuItem onSelect={() => block('address')}><Ban /> Spam & block sender</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => block('domain')}><Ban /> Spam & block domain</DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                {trashed ? (
                  <>
                    <DropdownMenuItem onSelect={() => act.mutate({action: 'restore'})}><ArchiveRestore /> Restore</DropdownMenuItem>
                    {(isAdmin || t.personal) && <DropdownMenuItem destructive onSelect={remove}><Trash2 /> Delete forever</DropdownMenuItem>}
                  </>
                ) : (
                  <DropdownMenuItem destructive onSelect={() => act.mutate({action: 'trash'})}><Trash2 /> Move to trash</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 @3xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-h-0 min-w-0 flex-col">
          {chat ? (
            <ChatTimeline detail={detail} extra={items} />
          ) : (
            <ol className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto bg-slate-50/50 p-4 scrollbar-thin">
              {hasOlder && (
                <li className="flex flex-wrap items-center justify-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={loadOlder} pending={loadingOlder} pendingLabel="Loading…">Load older messages</Button>
                  {older?.id === id && older.error && <span role="alert" className="text-xs text-destructive">{older.error}</span>}
                </li>
              )}
              {items.map((i) => i.node)}
            </ol>
          )}
          {canEdit && (
            <div className="border-t border-slate-100 p-3">
              {chat ? <ChatComposer detail={detail} mode={mode} onMode={setMode} focusKey={focusKey} /> : <ReplyComposer detail={detail} mode={mode} onMode={setMode} focusKey={focusKey} />}
            </div>
          )}
        </div>
        <aside className="hidden min-h-0 overflow-y-auto border-l border-slate-100 scrollbar-thin @3xl:block" aria-label="Contact and details">
          <ConversationSidebar detail={detail} />
        </aside>
      </div>

      {snoozing && <SnoozeDrawer onClose={() => setSnoozing(false)} pending={act.isPending} onPick={(until, onError) => act.mutate({action: 'snooze', until}, {onSuccess: () => setSnoozing(false), onError})} />}
      {details && (
        <Dialog open onOpenChange={(o) => !o && setDetails(false)}>
          <DialogContent size="sm">
            <DialogHeader><DialogTitle>Contact & details</DialogTitle></DialogHeader>
            <DialogBody className="p-0"><ConversationSidebar detail={detail} /></DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
