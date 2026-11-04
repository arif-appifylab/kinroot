import {ArchiveRestore, CheckCircle2, Inbox, Mail, MailOpen, RotateCcw, Search, ShieldAlert, ShieldCheck, SlidersHorizontal, Trash2, UserCheck, X} from 'lucide-react';
import {useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {CHANNEL_FILTERS, INBOX_SORTS, type ChannelFilter, type InboxSort, type InboxView} from '@/lib/inbox';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import type {ConversationRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {BulkBar, LoadError} from '../data-table';
import {FilterBar} from '../filter-bar';
import {useBinToast} from '../recycle-bin-toast';
import {Button} from '../ui/button';
import {confirm} from '../ui/confirm';
import {Checkbox, Input, NativeSelect} from '../ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tooltip} from '../ui/menu';
import {Avatar, EmptyState, Skeleton} from '../ui/misc';
import {ChannelIcon, senderLabel} from './parts';

export type ListFilters = {q: string; channel: '' | ChannelFilter; assignee: string; status: '' | 'OPEN' | 'CLOSED'; sort: InboxSort; unread: boolean};

const ghost = 'text-white hover:bg-white/10 hover:text-white';

export function ConversationList({
  view,
  rows,
  total,
  loading,
  error,
  onRetry,
  selectedId,
  filters,
  onFilters,
  onOpen,
}: {
  view: InboxView;
  rows: ConversationRow[] | undefined;
  total: number;
  loading: boolean;
  /** The list failed to load: an error state with Retry. */
  error?: unknown;
  onRetry?: () => void;
  selectedId: string | undefined;
  filters: ListFilters;
  onFilters: (f: Partial<ListFilters>) => void;
  onOpen: (id: string) => void;
}) {
  const {me, isAdmin, canEdit} = useMe();
  const team = useTeam();
  const binToast = useBinToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  useEffect(() => setPicked(new Set()), [view]);
  const ids = [...picked].filter((id) => rows?.some((r) => r.id === id));
  const bulk = useApiMutation(
    (body: {action: string; assigneeId?: string | null}) => api.post<{done: number; errors: string[]; binIds?: string[]}>('/inbox/conversations/actions', {ids, ...body}),
    {
      invalidate: [keys.inbox, keys.recycleBin],
      success: (r) => `${r.done} conversation${r.done === 1 ? '' : 's'} updated${r.errors.length ? ` · ${r.errors.length} skipped` : ''}`,
      onSuccess: () => setPicked(new Set()),
    },
  );
  const all = !!rows?.length && rows.every((r) => picked.has(r.id));
  const toggle = (id: string, on: boolean) => setPicked((p) => {
    const next = new Set(p);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const filtered = !!filters.channel || !!filters.assignee || !!filters.status || filters.unread;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid gap-2 border-b border-slate-100 p-3">
        <div className="flex items-center gap-2">
          {canEdit && <Checkbox aria-label="Select all" checked={all} onCheckedChange={(v) => setPicked(v === true ? new Set(rows?.map((r) => r.id)) : new Set())} />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
            <Input size="sm" value={filters.q} onChange={(e) => onFilters({q: e.target.value})} placeholder="Search conversations…" aria-label="Search conversations" className="pr-7 pl-8" />
            {filters.q && (
              <button type="button" className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none" onClick={() => onFilters({q: ''})} aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Tooltip content="Filters and sorting">
            <Button variant={filtered || showFilters ? 'soft' : 'ghost'} size="icon-sm" aria-label="Filters and sorting" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}><SlidersHorizontal /></Button>
          </Tooltip>
        </div>
        {showFilters && (
          <FilterBar active={filtered} onClear={() => onFilters({channel: '', assignee: '', status: '', unread: false})}>
            <NativeSelect size="sm" aria-label="Channel" value={filters.channel} onChange={(e) => onFilters({channel: e.target.value as ListFilters['channel']})}>
              <option value="">Every channel</option>
              {(Object.keys(CHANNEL_FILTERS) as ChannelFilter[]).map((ch) => <option key={ch} value={ch}>{CHANNEL_FILTERS[ch]}</option>)}
            </NativeSelect>
            <NativeSelect size="sm" aria-label="Assignee" value={filters.assignee} onChange={(e) => onFilters({assignee: e.target.value})}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="none">Unassigned</option>
              {team.data?.filter((u) => u.active && u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </NativeSelect>
            <NativeSelect size="sm" aria-label="Status" value={filters.status} onChange={(e) => onFilters({status: e.target.value as ListFilters['status']})}>
              <option value="">Any status</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
            </NativeSelect>
            <NativeSelect size="sm" aria-label="Sort" value={filters.sort} onChange={(e) => onFilters({sort: e.target.value as InboxSort})}>
              {(Object.keys(INBOX_SORTS) as InboxSort[]).map((s) => <option key={s} value={s}>{INBOX_SORTS[s]}</option>)}
            </NativeSelect>
            <label className="flex h-8 items-center gap-2 text-xs font-medium text-slate-600">
              <Checkbox checked={filters.unread} onCheckedChange={(v) => onFilters({unread: v === true})} /> Unread only
            </label>
          </FilterBar>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" role="list" aria-label="Conversations">
        {loading && <div className="space-y-2 p-3">{Array.from({length: 6}).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
        {!loading && !!error && !rows && <LoadError error={error} onRetry={onRetry} />}
        {!loading && rows?.length === 0 && (
          <EmptyState icon={<Inbox />} title={filters.q ? 'Nothing matches' : 'All clear'} description={filters.q ? 'Try other words or another view.' : 'New conversations from your mailboxes, forms and website chat show up here.'} />
        )}
        {rows?.map((r) => {
          const unread = r.unread;
          return (
            <div
              key={r.id}
              role="listitem"
              className={cn('group flex items-start gap-2.5 border-b border-slate-50 px-3 py-3 transition-colors hover:bg-slate-50', selectedId === r.id && 'bg-accent/70 hover:bg-accent/70')}
            >
              {canEdit && <Checkbox className="mt-1" aria-label={`Select ${r.subject}`} checked={picked.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />}
              <button type="button" onClick={() => onOpen(r.id)} className="min-w-0 flex-1 cursor-pointer text-left" aria-current={selectedId === r.id ? 'true' : undefined}>
                <div className="flex items-center gap-1.5">
                  {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <p className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-bold text-slate-900' : 'font-semibold text-slate-700')}>{senderLabel(r)}</p>
                  {r.online && <span className="size-2 shrink-0 rounded-full bg-green-500 ring-2 ring-green-100" aria-label="Visitor is on the site now" title="On the site now" />}
                  <ChannelIcon channel={r.channel} personal={r.personal} />
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(r.lastMessageAt)}</span>
                </div>
                <p className={cn('mt-0.5 truncate text-sm', unread ? 'font-semibold text-slate-900' : 'text-slate-800')}>{r.subject}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.last?.direction === 'OUTBOUND' ? 'You: ' : ''}{r.last?.text}</p>
                  {r.status === 'CLOSED' && view !== 'closed' && <CheckCircle2 className="size-3.5 shrink-0 text-green-600" aria-label="Closed" />}
                  {r.assignee ? (
                    <Tooltip content={`Assigned to ${r.assignee.name}`}><span><Avatar name={r.assignee.name} color={r.assignee.color} src={r.assignee.avatarUrl} size="xs" className="ring-0" /></span></Tooltip>
                  ) : (
                    <span className="size-5 shrink-0 rounded-full border border-dashed border-slate-300" aria-label="Unassigned" />
                  )}
                </div>
              </button>
            </div>
          );
        })}
        {!!rows?.length && total > rows.length && <p className="p-3 text-center text-xs text-muted-foreground">Showing {rows.length} of {total}: narrow it down with search or filters.</p>}
      </div>

      <BulkBar count={ids.length} onClear={() => setPicked(new Set())}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={ghost} disabled={bulk.isPending}><UserCheck /> Assign</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            {team.data?.filter((u) => u.active).map((u) => <DropdownMenuItem key={u.id} onSelect={() => bulk.mutate({action: 'assign', assigneeId: u.id})}>{u.name}</DropdownMenuItem>)}
            <DropdownMenuItem onSelect={() => bulk.mutate({action: 'assign', assigneeId: null})}>Unassigned</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {view === 'trash' ? (
          <>
            <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'restore'} pendingLabel="Restoring…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'restore'})}><ArchiveRestore /> Restore</Button>
            <Button
              size="sm"
              variant="ghost"
              className={ghost}
              pending={bulk.isPending && bulk.variables?.action === 'delete'}
              pendingLabel="Deleting…"
              disabled={bulk.isPending}
              onClick={async () => {
                if (!(await confirm({title: `Delete ${ids.length} conversation${ids.length === 1 ? '' : 's'} forever?`, description: isAdmin ? 'They leave the inbox for good. Admins can still restore them from Settings → Recycle bin for 30 days.' : 'Only conversations from your own mailbox can be deleted; team ones need an admin.', confirmLabel: 'Delete forever', destructive: true}))) return;
                const r = await bulk.mutateAsync({action: 'delete'});
                if (r.binIds?.length === 1) binToast('Conversation', r.binIds[0], {reopen: false});
              }}
            >
              <Trash2 /> Delete forever
            </Button>
          </>
        ) : (
          <>
            {view === 'closed' ? (
              <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'reopen'} pendingLabel="Reopening…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'reopen'})}><RotateCcw /> Reopen</Button>
            ) : (
              <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'close'} pendingLabel="Closing…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'close'})}><CheckCircle2 /> Close</Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={ghost} disabled={bulk.isPending}><MailOpen /> Mark</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem onSelect={() => bulk.mutate({action: 'read'})}><MailOpen /> As read</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => bulk.mutate({action: 'unread'})}><Mail /> As unread</DropdownMenuItem>
                {view === 'closed' ? null : <DropdownMenuItem onSelect={() => bulk.mutate({action: 'reopen'})}><RotateCcw /> Reopened</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            {view === 'spam' ? (
              <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'not_spam'} pendingLabel="Saving…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'not_spam'})}><ShieldCheck /> Not spam</Button>
            ) : (
              <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'spam'} pendingLabel="Saving…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'spam'})}><ShieldAlert /> Spam</Button>
            )}
            <Button size="sm" variant="ghost" className={ghost} pending={bulk.isPending && bulk.variables?.action === 'trash'} pendingLabel="Moving…" disabled={bulk.isPending} onClick={() => bulk.mutate({action: 'trash'})}><Trash2 /> Trash</Button>
          </>
        )}
      </BulkBar>
    </div>
  );
}
