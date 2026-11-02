import {useQuery} from '@tanstack/react-query';
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
import {useEffect, useMemo, useState} from 'react';

import {api} from '@/lib/api';
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
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip} from '../ui/menu';
import {Avatar, EmptyState, Skeleton} from '../ui/misc';
import {useChimeOn} from './chat-sound';
import {ChatComposer, ChatTimeline} from './chat-thread';
import {ConversationSidebar} from './conversation-sidebar';
import {ChannelIcon, MessageFrame} from './parts';
import {ReplyComposer, type ComposerMode} from './reply-composer';

const invalidate = [keys.inbox, keys.timeline, keys.email];

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
              onClick={async () => (await confirm({title: 'Delete this comment?', confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}
              className="cursor-pointer rounded p-0.5 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
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

function SnoozeDrawer({onPick, onClose}: {onPick: (iso: string) => void; onClose: () => void}) {
  const [value, setValue] = useState(toLocalInput(new Date(Date.now() + 24 * 3600_000).toISOString()));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={(e) => (e.preventDefault(), value && (onPick(new Date(value).toISOString()), onClose()))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>It leaves the open views and comes back, unread, at this time.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Date and time" htmlFor="snooze-at"><Input id="snooze-at" type="datetime-local" required min={toLocalInput(new Date().toISOString())} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit">Snooze</Button>
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
  // An open chat polls quickly (only while the tab is visible); email keeps the inbox rhythm.
  const q = useQuery({
    queryKey: [...keys.inbox, 'conversation', id],
    queryFn: () => api.get<ConversationDetail>(`/inbox/conversations/${id}`),
    refetchInterval: (query) => (query.state.data?.chat ? 3000 : 20_000),
  });
  const act = useApiMutation((body: {action: string; assigneeId?: string | null; until?: string; block?: 'address' | 'domain' | 'visitor' | null}) => api.post<{binIds?: string[]}>('/inbox/conversations/actions', {ids: [id], ...body}), {invalidate});
  const detail = q.data;
  const t = detail?.conversation;
  const chat = detail?.chat ?? null;
  const transcript = useApiMutation(() => api.post<{to: string}>(`/inbox/conversations/${id}/transcript`), {invalidate, success: (r) => `Transcript emailed to ${r.to}`});
  useChimeOn([...(chat?.messages ?? [])].reverse().find((m) => m.direction === 'INBOUND')?.createdAt, !!chat);

  const items = useMemo(() => {
    if (!detail) return [];
    return [
      ...(detail.chat ? [] : detail.messages.map((m) => ({at: m.sentAt, key: `m${m.id}`, node: <MessageCard key={`m${m.id}`} m={m} />}))),
      ...detail.comments.map((c) => ({at: c.createdAt, key: `c${c.id}`, node: c.kind === 'event' ? <EventLine key={`c${c.id}`} c={c} /> : <CommentCard key={`c${c.id}`} c={c} threadId={detail.conversation.id} />})),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [detail]);

  const ask = (m: ComposerMode) => (setMode(m), setFocusKey((k) => k + 1));
  const toggleStatus = () => t && canEdit && act.mutate({action: t.status === 'OPEN' ? 'close' : 'reopen'});
  useConversationKeys(t && canEdit && t.channel !== 'ticket' ? {e: toggleStatus, a: () => setAssignOpen(true), r: () => ask('reply'), c: () => ask('comment')} : {});

  if (q.isLoading) return <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
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
              <Button variant="success" size="sm" onClick={toggleStatus} disabled={act.isPending} aria-label="Close (e)"><CheckCircle2 /> Close</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={toggleStatus} disabled={act.isPending} aria-label="Reopen (e)"><RotateCcw /> Reopen</Button>
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

      {snoozing && <SnoozeDrawer onClose={() => setSnoozing(false)} onPick={(until) => act.mutate({action: 'snooze', until})} />}
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
