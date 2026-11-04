import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {AlarmClock, Columns3, Inbox, LifeBuoy, List, Plus, Smile, UserCheck, UserX} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {z} from 'zod';

import {DataTable, LoadError, Pagination, SearchInput, type Column} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {NewTicketDialog} from '@/components/tickets/new-ticket-dialog';
import {TicketBoard} from '@/components/tickets/ticket-board';
import {PriorityLabel, SlaBadge, StatusBadge, useTicketSettings} from '@/components/tickets/ticket-badges';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {Avatar, EmptyState, IconBadge, PageHeader} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, fullName} from '@/lib/format';
import {keys, useMe} from '@/lib/queries';
import {TICKET_PRIORITIES, TICKET_STATUSES} from '@/lib/tickets';
import type {Paged, TicketCounts, TicketRow} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/tickets/')({
  validateSearch: z.object({
    view: z.enum(['board', 'list']).optional(),
    filter: z.enum(['all', 'mine', 'unassigned', 'breached']).optional(),
    status: z.string().optional(), // list view: "open" (default) | "all" | a status
    priority: z.string().optional(),
    category: z.string().optional(),
    queue: z.string().optional(),
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    contactId: z.string().optional(),
    companyId: z.string().optional(),
    dealId: z.string().optional(),
    new: z.coerce.string().optional(),
  }),
  head: () => ({meta: [{title: pageTitle('Tickets')}]}),
  component: TicketsPage,
});

const FILTERS = [
  {id: 'all', label: 'All tickets'},
  {id: 'mine', label: 'Assigned to me'},
  {id: 'unassigned', label: 'Unassigned'},
  {id: 'breached', label: 'SLA breached'},
] as const;

function Stat({icon, tone, label, value, onClick, active}: {icon: ReactNode; tone: 'blue' | 'teal' | 'amber' | 'rose' | 'green'; label: string; value: ReactNode; onClick?: () => void; active?: boolean}) {
  const body = (
    <>
      <IconBadge tone={tone}>{icon}</IconBadge>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted-foreground">{label}</p>
        <p className="text-xl font-extrabold tracking-tight text-slate-900">{value}</p>
      </div>
    </>
  );
  // A filter card is a real button (keyboard, screen readers); the same look as the Card.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={!!active}
        className={cn(
          'flex w-full cursor-pointer items-center gap-3 rounded-xl border border-slate-100 bg-card p-4 text-left text-card-foreground shadow-soft outline-none transition-all duration-200 ease-out hover:-translate-y-1 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30',
          active && 'ring-2 ring-primary/30',
        )}
      >
        {body}
      </button>
    );
  }
  return <Card className="flex items-center gap-3 p-4">{body}</Card>;
}

function TicketsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, page: undefined, ...patch}), replace: true});
  const {canEdit} = useMe();
  const settings = useTicketSettings();
  const [qDraft, setQDraft] = useState(s.q ?? '');
  const view = s.view ?? 'board';
  const filter = s.filter ?? 'all';

  const base = {
    view: filter === 'mine' || filter === 'unassigned' ? filter : 'all',
    breached: filter === 'breached' ? '1' : undefined,
    priority: s.priority,
    category: s.category,
    queue: s.queue,
    q: s.q,
    contactId: s.contactId,
    companyId: s.companyId,
    dealId: s.dealId,
  };
  const counts = useQuery({queryKey: [...keys.tickets, 'counts'], queryFn: () => api.get<TicketCounts>('/tickets/counts'), refetchInterval: 60_000});
  const listParams = {...base, status: s.status ?? 'open', sort: 'updated', page: s.page ?? 1, pageSize: 50};
  const list = useQuery({
    queryKey: [...keys.tickets, 'list', listParams],
    queryFn: () => api.get<Paged<TicketRow>>('/tickets', listParams),
    enabled: view === 'list',
    placeholderData: keepPreviousData,
  });
  const board = useQuery({
    queryKey: [...keys.tickets, 'board', base],
    queryFn: async () => {
      // Open tickets in full; resolved and closed ones only recent.
      const [open, done] = await Promise.all([
        api.get<Paged<TicketRow>>('/tickets', {...base, status: 'open', sort: 'priority', pageSize: 300}),
        filter === 'breached' ? Promise.resolve({rows: [] as TicketRow[]}) : api.get<Paged<TicketRow>>('/tickets', {...base, status: 'RESOLVED,CLOSED', sort: 'updated', pageSize: 60}),
      ]);
      return [...open.rows, ...done.rows];
    },
    enabled: view === 'board',
    placeholderData: keepPreviousData,
  });

  const columns: Column<TicketRow>[] = [
    {key: 'number', header: '#', className: 'w-16', cell: (t) => <span className="font-semibold text-muted-foreground">#{t.number}</span>},
    {
      key: 'subject',
      header: 'Subject',
      cell: (t) => (
        <div className="min-w-0">
          <Link to="/tickets/$ticketId" params={{ticketId: String(t.number)}} onClick={(e) => e.stopPropagation()} className="block truncate rounded-sm font-semibold text-slate-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/30">
            {t.subject}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{[t.contact && fullName(t.contact), t.company?.name].filter(Boolean).join(' · ') || 'No contact'}</p>
        </div>
      ),
    },
    {key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} />},
    {key: 'priority', header: 'Priority', hideBelow: 'md', cell: (t) => <PriorityLabel priority={t.priority} />},
    {key: 'sla', header: 'SLA', hideBelow: 'md', cell: (t) => <SlaBadge ticket={t} compact />},
    {key: 'category', header: 'Category', hideBelow: 'xl', cell: (t) => t.category ?? <span className="text-muted-foreground">—</span>},
    {
      key: 'assignee',
      header: 'Assignee',
      hideBelow: 'lg',
      cell: (t) => (t.assignee ? <span className="inline-flex items-center gap-2"><Avatar name={t.assignee.name} color={t.assignee.color} src={t.assignee.avatarUrl} size="xs" />{t.assignee.name.split(' ')[0]}</span> : <span className="text-muted-foreground">Unassigned</span>),
    },
    {key: 'updated', header: 'Updated', hideBelow: 'sm', cell: (t) => <span className="whitespace-nowrap text-slate-500">{ago(t.lastMessageAt)}</span>},
  ];

  const csat = counts.data?.csat;
  const filtered = !!(s.q || s.priority || s.category || s.queue || (view === 'list' && s.status));

  return (
    <div>
      <PageHeader
        title="Tickets"
        description="Support requests from email, the portal, forms and your team."
        actions={
          <>
            <div className="inline-flex rounded-lg border border-slate-200 bg-card p-0.5">
              {([['board', Columns3, 'Board'], ['list', List, 'List']] as const).map(([v, Icon, label]) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => set({view: v === 'board' ? undefined : v})} className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-semibold transition-colors', view === v ? 'bg-accent text-primary' : 'text-slate-500 hover:text-slate-800')}>
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
            {canEdit && <Button size="sm" className="h-9" onClick={() => set({new: '1'})}><Plus /> New ticket</Button>}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat icon={<Inbox />} tone="blue" label="Open" value={counts.data?.open ?? '—'} onClick={() => set({filter: undefined})} active={filter === 'all'} />
        <Stat icon={<UserCheck />} tone="teal" label="Assigned to me" value={counts.data?.mine ?? '—'} onClick={() => set({filter: 'mine'})} active={filter === 'mine'} />
        <Stat icon={<UserX />} tone="amber" label="Unassigned" value={counts.data?.unassigned ?? '—'} onClick={() => set({filter: 'unassigned'})} active={filter === 'unassigned'} />
        <Stat icon={<AlarmClock />} tone="rose" label="SLA breached" value={counts.data?.breached ?? '—'} onClick={() => set({filter: 'breached'})} active={filter === 'breached'} />
        <Stat icon={<Smile />} tone="green" label={`CSAT${csat?.count ? ` · ${csat.count} rating${csat.count === 1 ? '' : 's'}` : ''}`} value={csat?.average ? `${csat.average.toFixed(1)} / 5` : '—'} />
      </div>

      <Card className="mb-4 overflow-hidden">
        <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 scrollbar-thin">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => set({filter: f.id === 'all' ? undefined : f.id})}
              className={cn('-mb-px cursor-pointer border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors', filter === f.id ? 'border-primary text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <FilterBar className="p-3" active={filtered} onClear={() => (setQDraft(''), set({q: undefined, priority: undefined, category: undefined, queue: undefined, status: undefined}))}>
          <form noValidate onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
            <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search #number, subject, contact…" />
          </form>
          {view === 'list' && (
            <NativeSelect size="sm" aria-label="Status" value={s.status ?? 'open'} onChange={(e) => set({status: e.target.value === 'open' ? undefined : e.target.value})}>
              <option value="open">Open statuses</option>
              <option value="all">Any status</option>
              {TICKET_STATUSES.map((st) => <option key={st.value} value={st.value}>{st.label}</option>)}
            </NativeSelect>
          )}
          <NativeSelect size="sm" aria-label="Priority" value={s.priority ?? ''} onChange={(e) => set({priority: e.target.value || undefined})}>
            <option value="">Any priority</option>
            {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Category" value={s.category ?? ''} onChange={(e) => set({category: e.target.value || undefined})}>
            <option value="">Any category</option>
            {settings.data?.settings.categories.map((c) => <option key={c}>{c}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Queue" value={s.queue ?? ''} onChange={(e) => set({queue: e.target.value || undefined})}>
            <option value="">Any queue</option>
            {settings.data?.settings.queues.map((q) => <option key={q}>{q}</option>)}
          </NativeSelect>
          {(s.contactId || s.companyId || s.dealId) && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-slate-500" onClick={() => set({contactId: undefined, companyId: undefined, dealId: undefined})}>Clear record filter</Button>
          )}
        </FilterBar>
      </Card>

      {view === 'board' ? (
        board.isError && !board.data ? <Card><LoadError error={board.error} onRetry={() => board.refetch()} /></Card> : board.data ? <TicketBoard tickets={board.data} /> : <div className="h-64 animate-pulse rounded-2xl bg-slate-100/70" />
      ) : (
        <Card className="overflow-hidden">
          <DataTable
            rows={list.data?.rows}
            columns={columns}
            loading={list.isLoading}
            error={list.isError && !list.data ? list.error : undefined}
            onRetry={() => list.refetch()}
            onRowClick={(t) => navigate({to: '/tickets/$ticketId', params: {ticketId: String(t.number)}})}
            empty={
              <EmptyState
                icon={<LifeBuoy />}
                title="No tickets here"
                description="Mail to your support address, portal requests and form responses show up here."
                action={canEdit ? <Button size="sm" onClick={() => set({new: '1'})}><Plus /> New ticket</Button> : <Link to="/settings/tickets" className="text-sm font-semibold text-primary hover:underline">Ticket settings</Link>}
              />
            }
          />
          {list.data && list.data.total > list.data.pageSize && (
            <div className="border-t border-slate-100 p-3"><Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(page) => navigate({search: (prev) => ({...prev, page}), replace: true})} /></div>
          )}
        </Card>
      )}

      {s.new && <NewTicketDialog onClose={() => set({new: undefined})} />}
    </div>
  );
}
