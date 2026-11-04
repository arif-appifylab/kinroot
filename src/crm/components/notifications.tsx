import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';
import {AlarmClock, AtSign, Bell, BellOff, CalendarClock, CheckCheck, ClipboardList, Clock, Download, Flame, Handshake, LifeBuoy, Mail, MailWarning, MessageCircle, MessageSquare, Trophy, Upload, UserPlus, Workflow, XCircle} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {badgesQuery, keys, useApiMutation} from '@/lib/queries';
import type {AppNotification} from '@/lib/types';
import {cn} from '@/lib/utils';

import {LoadError} from './data-table';
import {Button} from './ui/button';
import {confirm} from './ui/confirm';
import {Popover, PopoverContent, PopoverTrigger} from './ui/menu';
import {Avatar, EmptyState} from './ui/misc';

const ICONS: Record<string, {icon: typeof Bell; cls: string}> = {
  mention: {icon: AtSign, cls: 'bg-violet-50 text-violet-600'},
  assigned: {icon: UserPlus, cls: 'bg-blue-50 text-blue-600'},
  reminder: {icon: Clock, cls: 'bg-amber-50 text-amber-600'},
  comment: {icon: MessageSquare, cls: 'bg-teal-50 text-teal-600'},
  activity: {icon: Bell, cls: 'bg-slate-100 text-slate-600'},
  stage_changed: {icon: Handshake, cls: 'bg-blue-50 text-blue-600'},
  deal_won: {icon: Trophy, cls: 'bg-emerald-50 text-emerald-600'},
  deal_lost: {icon: XCircle, cls: 'bg-rose-50 text-rose-600'},
  email_in: {icon: Mail, cls: 'bg-sky-50 text-sky-600'},
  chat: {icon: MessageCircle, cls: 'bg-teal-50 text-teal-600'},
  form: {icon: ClipboardList, cls: 'bg-indigo-50 text-indigo-600'},
  ticket: {icon: LifeBuoy, cls: 'bg-violet-50 text-violet-600'},
  sla: {icon: AlarmClock, cls: 'bg-rose-50 text-rose-600'},
  meeting: {icon: CalendarClock, cls: 'bg-violet-50 text-violet-600'},
  score: {icon: Flame, cls: 'bg-rose-50 text-rose-600'},
  automation: {icon: Workflow, cls: 'bg-indigo-50 text-indigo-600'},
  report: {icon: MailWarning, cls: 'bg-amber-50 text-amber-600'},
  import: {icon: Upload, cls: 'bg-teal-50 text-teal-600'},
  export: {icon: Download, cls: 'bg-amber-50 text-amber-600'},
};

/** Types worth a toast when they arrive (reminders already toast on their own). */
const TOAST_TYPES = new Set(['mention', 'assigned', 'comment', 'email_in', 'chat', 'deal_won', 'form', 'ticket', 'sla', 'meeting', 'score', 'automation', 'report', 'import', 'export']);

type Count = {unread: number; latestId: string | null};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  // The unread number and the newest id come with the app's badges (one request for the whole shell).
  const count = useQuery({...badgesQuery, select: (b): Count => ({unread: b.notifications, latestId: b.latestNotificationId})});
  const list = useQuery({
    queryKey: [...keys.notifications, 'list', unreadOnly],
    queryFn: () => api.get<{rows: AppNotification[]; unread: number}>('/notifications', {unread: unreadOnly ? '1' : undefined}),
    enabled: open,
  });

  const markRead = useApiMutation((ids?: string[]) => api.post('/notifications/read', {ids}), {invalidate: [keys.notifications]});
  const clearRead = useApiMutation(() => api.del('/notifications'), {invalidate: [keys.notifications]});

  function openItem(n: AppNotification) {
    if (!n.readAt) markRead.mutate([n.id]);
    setOpen(false);
    // Export files are downloads from the API, not pages.
    if (n.link?.startsWith('/site-api/')) window.location.assign(n.link);
    else if (n.link) navigate({href: n.link});
  }

  // New arrivals since the last poll show as a toast.
  const lastSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const latest = count.data?.latestId;
    if (latest === undefined) return;
    const previous = lastSeen.current;
    lastSeen.current = latest;
    if (previous === undefined || !latest || latest === previous) return;
    api.get<{rows: AppNotification[]}>('/notifications', {unread: '1'}).then(({rows}) => {
      const fresh = rows.slice(0, rows.findIndex((r) => r.id === previous) === -1 ? 3 : rows.findIndex((r) => r.id === previous));
      for (const n of fresh.filter((r) => TOAST_TYPES.has(r.type)).slice(0, 3)) {
        toast(n.title, {description: n.body?.slice(0, 120), action: n.link ? {label: 'Open', onClick: () => openItem(n)} : undefined});
      }
      qc.invalidateQueries({queryKey: [...keys.notifications, 'list']});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count.data?.latestId]);

  const unread = count.data?.unread ?? 0;
  const rows = list.data?.rows ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}>
          <Bell />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] leading-none font-bold text-white ring-2 ring-card">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-bold text-slate-900">Notifications</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly((v) => !v)}
              className={cn('cursor-pointer rounded-md px-2 py-1 text-xs font-semibold transition-colors', unreadOnly ? 'bg-primary/10 text-primary' : 'text-slate-500 hover:bg-slate-100')}
            >
              Unread
            </button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={!unread} pending={markRead.isPending} pendingLabel="Marking…" onClick={() => markRead.mutate(undefined)}>
              <CheckCheck /> Mark all read
            </Button>
          </div>
        </div>
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto scrollbar-thin">
          {list.isLoading && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>}
          {list.isError && !list.data && <LoadError error={list.error} onRetry={() => list.refetch()} className="py-2" />}
          {!list.isLoading && !list.isError && rows.length === 0 && (
            <EmptyState icon={<BellOff />} title={unreadOnly ? 'All caught up' : 'No notifications yet'} description="Mentions, assignments and updates on records you own or follow land here." className="py-10" />
          )}
          {rows.map((n) => {
            const {icon: Icon, cls} = ICONS[n.type] ?? ICONS.activity!;
            return (
              <button
                key={n.id}
                onClick={() => openItem(n)}
                className={cn('flex w-full cursor-pointer gap-3 border-b border-slate-50 px-4 py-3 text-left transition-colors hover:bg-slate-50', !n.readAt && 'bg-primary/[0.04]')}
              >
                <div className="relative shrink-0">
                  {n.actor ? <Avatar name={n.actor.name} color={n.actor.color} src={n.actor.avatarUrl} size="sm" /> : <span className={cn('flex size-8 items-center justify-center rounded-full', cls)}><Icon className="size-4" /></span>}
                  {n.actor && <span className={cn('absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full ring-2 ring-card', cls)}><Icon className="size-2.5" /></span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm leading-snug', n.readAt ? 'text-slate-600' : 'font-semibold text-slate-900')}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground">{ago(n.createdAt)}</p>
                </div>
                {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            );
          })}
        </div>
        {rows.some((r) => r.readAt) && !unreadOnly && (
          <div className="border-t border-slate-100 px-4 py-2 text-right">
            <button
              type="button"
              disabled={clearRead.isPending}
              aria-busy={clearRead.isPending || undefined}
              onClick={async () => (await confirm({title: 'Clear read notifications?', description: 'Notifications you have read are removed for good. Unread ones stay.', confirmLabel: 'Clear read', destructive: true})) && clearRead.mutate(undefined)}
              className="cursor-pointer rounded text-xs font-semibold text-slate-500 outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {clearRead.isPending ? 'Clearing…' : 'Clear read'}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Follow / unfollow a record to hear about its notes, emails, stage moves and more. */
export function FollowButton({entity, id, size = 'sm'}: {entity: 'contact' | 'company' | 'deal'; id: string; size?: 'sm' | 'default'}) {
  const q = useQuery({
    queryKey: [...keys.follows, entity, id],
    queryFn: () => api.get<{following: boolean; followers: {id: string; name: string}[]}>(`/notifications/follow/${entity}/${id}`),
  });
  const toggle = useApiMutation(
    (follow: boolean) => (follow ? api.post(`/notifications/follow/${entity}/${id}`) : api.del(`/notifications/follow/${entity}/${id}`)),
    {invalidate: [[...keys.follows, entity, id]], success: (r) => ((r as {following: boolean}).following ? "Following: you'll be notified about updates" : 'Unfollowed')},
  );
  const following = q.data?.following ?? false;
  const others = (q.data?.followers ?? []).length - (following ? 1 : 0);
  return (
    <Button variant="secondary" size={size} disabled={q.isLoading} pending={toggle.isPending} pendingLabel={following ? 'Unfollowing…' : 'Following…'} onClick={() => toggle.mutate(!following)} title={others > 0 ? `${others} other follower${others === 1 ? '' : 's'}` : undefined}>
      {following ? <BellOff /> : <Bell />} {following ? 'Unfollow' : 'Follow'}
    </Button>
  );
}
