import {keepPreviousData, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Bell, BellOff, Inbox, Keyboard, PenSquare, RefreshCw, Settings} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {EmailComposer} from '@/components/email-composer';
import {useChatSoundPref, useChimeOn} from '@/components/inbox/chat-sound';
import {ConversationList, type ListFilters} from '@/components/inbox/conversation-list';
import {ConversationView} from '@/components/inbox/conversation-view';
import {InboxNav, InboxNavSelect, type NavValue} from '@/components/inbox/inbox-nav';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Popover, PopoverContent, PopoverTrigger, Tooltip} from '@/components/ui/menu';
import {EmptyState, PageHeader} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {CHANNEL_FILTERS, INBOX_SHORTCUTS, INBOX_SORTS, VIEW_KEYS, type ChannelFilter, type InboxSort, type InboxView} from '@/lib/inbox';
import {keys, useEmailAccounts, useMe} from '@/lib/queries';
import type {ConversationRow, InboxCounts} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/inbox')({
  validateSearch: z.object({
    thread: z.string().optional(),
    view: z.enum(VIEW_KEYS as [InboxView, ...InboxView[]]).optional(),
    channel: z.enum(Object.keys(CHANNEL_FILTERS) as [ChannelFilter, ...ChannelFilter[]]).optional(),
    assignee: z.string().optional(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    sort: z.enum(Object.keys(INBOX_SORTS) as [InboxSort, ...InboxSort[]]).optional(),
    unread: z.string().optional(),
  }),
  head: () => ({meta: [{title: pageTitle('Inbox')}]}),
  component: InboxPage,
});

const POLL_MS = 20_000; // no websockets on this stack: lists, counts and the open conversation poll

function ShortcutsHelp({open, onOpenChange}: {open: boolean; onOpenChange: (o: boolean) => void}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="h-9 w-9" aria-label="Keyboard shortcuts (?)"><Keyboard /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <p className="mb-2 text-sm font-bold text-slate-900">Keyboard shortcuts</p>
        <ul className="grid gap-1.5">
          {INBOX_SHORTCUTS.map(([key, label]) => (
            <li key={key} className="flex items-center justify-between text-sm text-slate-600">
              {label}
              <kbd className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">{key}</kbd>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function InboxPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const qc = useQueryClient();
  const {canEdit} = useMe();
  const accounts = useEmailAccounts();
  const [composing, setComposing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const view: InboxView = s.view ?? 'open';
  const nav: NavValue = {view, channel: s.channel};
  const filters: ListFilters = {q, channel: s.channel ?? '', assignee: s.assignee ?? '', status: s.status ?? '', sort: s.sort ?? 'newest', unread: s.unread === '1'};

  const counts = useQuery({queryKey: [...keys.inbox, 'counts'], queryFn: () => api.get<InboxCounts>('/inbox/counts'), refetchInterval: POLL_MS});
  const list = useQuery({
    queryKey: [...keys.inbox, 'list', view, s.channel, s.assignee, s.status, s.sort, s.unread, query],
    queryFn: () => api.get<{rows: ConversationRow[]; total: number}>('/inbox/conversations', {view, channel: s.channel, assigneeId: s.assignee, status: s.status, sort: s.sort, unread: s.unread, q: query, pageSize: 100}),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
  });
  const rows = list.data?.rows;

  // New chat messages: a chime (opt-in, per browser) and the unread count in the tab title.
  const [sound, setSound] = useChatSoundPref();
  useChimeOn(counts.data?.chat.latest, true);
  const chatUnread = counts.data?.chat.unread ?? 0;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\) /, '');
    document.title = sound && chatUnread ? `(${chatUnread > 99 ? '99+' : chatUnread}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\+?\) /, '');
    };
  }, [sound, chatUnread]);

  const open = (thread: string | undefined) => navigate({search: (p) => ({...p, thread})});
  const setNav = (v: NavValue) => navigate({search: (p) => ({...p, view: v.view === 'open' && !v.channel ? undefined : v.view, channel: v.channel, thread: undefined})});
  const setFilters = (f: Partial<ListFilters>) => {
    if (f.q !== undefined) setQ(f.q);
    navigate({
      search: (p) => ({
        ...p,
        ...(f.channel !== undefined ? {channel: f.channel || undefined} : {}),
        ...(f.assignee !== undefined ? {assignee: f.assignee || undefined} : {}),
        ...(f.status !== undefined ? {status: f.status || undefined} : {}),
        ...(f.sort !== undefined ? {sort: f.sort === 'newest' ? undefined : f.sort} : {}),
        ...(f.unread !== undefined ? {unread: f.unread ? '1' : undefined} : {}),
      }),
    });
  };

  // j / k move through the list, ? shows the shortcuts (the open conversation handles e, a, r, c).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest('[role="dialog"],[role="menu"]'))) return;
      if (e.key === '?') return void (e.preventDefault(), setHelp((h) => !h));
      if (e.key !== 'j' && e.key !== 'k') return;
      if (!rows?.length) return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.id === s.thread);
      const next = e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      open(rows[next]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function syncNow() {
    setSyncing(true);
    let stored = 0;
    let queued = false;
    for (const a of accounts.data?.filter((x) => x.info.kind === 'oauth') ?? []) {
      const r = await api.post<{stored: number; queued?: boolean; error?: string}>(`/email/accounts/${a.id}/sync`).catch((e: Error) => ({stored: 0, queued: false, error: e.message}));
      stored += r.stored;
      queued ||= !!r.queued;
      if (r.error) toast.error(`${a.fromEmail}: ${r.error}`);
    }
    setSyncing(false);
    // Syncs run as background jobs: new emails show up shortly (the inbox polls).
    toast.success(queued ? 'Syncing in the background. New emails appear in a minute.' : stored ? `${stored} new email${stored > 1 ? 's' : ''} logged` : 'Up to date');
    qc.invalidateQueries({queryKey: keys.inbox});
  }

  const hasOAuth = accounts.data?.some((a) => a.info.kind === 'oauth');

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Team and personal conversations from your mailboxes, forms and website chat."
        actions={
          <>
            <Tooltip content={sound ? 'New chat messages: sound and tab badge on' : 'Play a sound and show a tab badge for new chat messages'}>
              <Button variant="ghost" size="icon-sm" className="h-9 w-9" aria-pressed={sound} aria-label="Sound for new chat messages" onClick={() => setSound(!sound)}>{sound ? <Bell /> : <BellOff />}</Button>
            </Tooltip>
            <ShortcutsHelp open={help} onOpenChange={setHelp} />
            {hasOAuth && <Button variant="secondary" size="sm" className="h-9" onClick={syncNow} pending={syncing} pendingLabel="Syncing…"><RefreshCw /> Sync now</Button>}
            <Button variant="secondary" size="sm" className="h-9" asChild><Link to="/settings/email"><Settings /> Email settings</Link></Button>
            {canEdit && <Button size="sm" className="h-9" onClick={() => setComposing(true)}><PenSquare /> Compose</Button>}
          </>
        }
      />
      <Card className="grid h-[calc(100dvh-13rem)] min-h-[560px] grid-cols-1 overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[200px_320px_minmax(0,1fr)]">
        <div className="hidden min-h-0 border-r border-slate-100 xl:block">
          <InboxNav value={nav} counts={counts.data} onChange={setNav} />
        </div>
        <div className={cn('flex min-h-0 flex-col border-r border-slate-100', s.thread && 'hidden lg:flex')}>
          <div className="border-b border-slate-100 p-3 xl:hidden"><InboxNavSelect value={nav} counts={counts.data} onChange={setNav} /></div>
          <div className="min-h-0 flex-1">
            <ConversationList view={view} rows={rows} total={list.data?.total ?? 0} loading={list.isLoading} error={list.isError ? list.error : undefined} onRetry={() => list.refetch()} selectedId={s.thread} filters={filters} onFilters={setFilters} onOpen={open} />
          </div>
        </div>
        <div className={cn('min-h-0 min-w-0', !s.thread && 'hidden lg:block')}>
          {s.thread ? (
            <ConversationView key={s.thread} id={s.thread} onBack={() => open(undefined)} onGone={() => open(undefined)} />
          ) : (
            <EmptyState className="h-full" icon={<Inbox />} title="Select a conversation" description="Pick one on the left, or press j to open the first. Press ? for shortcuts." />
          )}
        </div>
      </Card>

      <Dialog open={composing} onOpenChange={setComposing}>
        <DialogContent size="lg">
          <DialogHeader><DialogTitle>New email</DialogTitle></DialogHeader>
          <DialogBody><EmailComposer context={{}} onSent={() => setComposing(false)} /></DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
