import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Handshake, Hourglass, KanbanSquare, List, Plus} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {useCreate} from '@/components/create-dialogs';
import {DataTable, LoadError, Pagination, SearchInput, type Column} from '@/components/data-table';
import {DealBoard} from '@/components/deal-board';
import {FilterBar} from '@/components/filter-bar';
import {ImportExportActions} from '@/components/import-export/actions';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {Avatar, EmptyState, PageHeader, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {ago, dueLabel, money} from '@/lib/format';
import {keys, useMe, usePipelines, useTeam} from '@/lib/queries';
import type {Deal} from '@/lib/types';
import {cn} from '@/lib/utils';

type DealPage = {rows: Deal[]; total: number; page: number; pageSize: number; summary: {count: number; value: number; weighted: number}};

export const Route = createFileRoute('/_app/deals/')({
  validateSearch: z.object({
    view: z.enum(['board', 'list']).optional(),
    pipelineId: z.string().optional(),
    status: z.enum(['OPEN', 'WON', 'LOST', 'ALL']).optional(),
    ownerId: z.string().optional(),
    q: z.string().optional(),
    rotting: z.string().optional(),
    closeDate: z.enum(['overdue', 'this_month', 'next_month', 'this_quarter', 'none']).optional(),
    createdDays: z.string().optional(),
    closedDays: z.string().optional(), // board: how far back the won/lost columns reach; "0" hides them
    page: z.coerce.number().optional(),
    sort: z.string().optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    importId: z.string().optional(), // opens the import drawer (notification links)
  }),
  head: () => ({meta: [{title: pageTitle('Deals')}]}),
  component: DealsPage,
});

function DealsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const create = useCreate();
  const {me, canEdit, isAdmin} = useMe();
  const team = useTeam();
  const pipelines = usePipelines();
  const [qDraft, setQDraft] = useState(s.q ?? '');
  // A new filter starts again on page 1.
  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, page: undefined, ...patch}), replace: true});

  const view = s.view ?? 'board';
  const pipeline = pipelines.data?.find((p) => p.id === s.pipelineId) ?? pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0];
  const status = view === 'board' ? 'OPEN' : (s.status ?? 'OPEN');

  // 100 deals a page (the server's maximum), with page numbers like the other lists.
  const dealPages = useQuery({
    queryKey: [...keys.deals, 'list', pipeline?.id, status, s.ownerId, s.q, s.rotting, s.sort, s.dir, s.closeDate, s.createdDays, s.page],
    queryFn: () =>
      api.get<DealPage>('/deals', {
        pipelineId: pipeline!.id,
        status,
        ownerId: s.ownerId,
        q: s.q,
        rotting: s.rotting,
        closeDate: s.closeDate,
        createdDays: s.createdDays,
        sort: view === 'list' ? s.sort : undefined,
        dir: s.dir,
        page: s.page,
      }),
    enabled: !!pipeline,
    placeholderData: keepPreviousData,
  });
  const deals = {data: dealPages.data?.rows, isLoading: dealPages.isLoading};
  const summary = dealPages.data?.summary;
  const closedDays = s.closedDays ?? '30';
  const closed = useQuery({
    queryKey: [...keys.deals, 'closed', pipeline?.id, s.ownerId, s.q, closedDays],
    queryFn: () => api.get<{rows: Deal[]}>('/deals', {pipelineId: pipeline!.id, status: 'CLOSED', ownerId: s.ownerId, q: s.q, closedDays}),
    select: (d) => d.rows,
    enabled: !!pipeline && view === 'board' && closedDays !== '0',
    placeholderData: keepPreviousData,
  });

  // Totals for the whole filter come from the server (the loaded pages may be only the first 100).
  const total = summary?.value ?? 0;
  const weighted = summary?.weighted ?? 0;

  const columns: Column<Deal>[] = [
    {key: 'title', header: 'Deal', sortable: true, cell: (d) => (
      <div className="min-w-0">
        <Link to="/deals/$dealId" params={{dealId: d.id}} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-slate-900 hover:text-primary">{d.title}</Link>
        <p className="truncate text-xs text-muted-foreground">{d.company?.name ?? '—'}</p>
      </div>
    )},
    {key: 'value', header: 'Value', sortable: true, cell: (d) => <span className="font-bold text-slate-900">{money(d.value, d.currency)}</span>},
    {key: 'stage', header: 'Stage', cell: (d) =>
      d.status === 'OPEN' ? (
        <span className="inline-flex items-center gap-1.5 font-medium"><span className="size-2 rounded-full" style={{background: d.stage.color}} />{d.stage.name}</span>
      ) : (
        <Badge tone={d.status === 'WON' ? 'green' : 'rose'}>{d.status === 'WON' ? 'Won' : 'Lost'}</Badge>
      )},
    {key: 'expectedCloseDate', header: 'Close date', sortable: true, hideBelow: 'md', cell: (d) => d.expectedCloseDate ? dueLabel(d.expectedCloseDate) : <span className="text-slate-400">—</span>},
    {key: 'next', header: 'Next step', hideBelow: 'lg', cell: (d) => d.nextTask ? <span className="truncate text-xs">{dueLabel(d.nextTask.dueAt)} · {d.nextTask.title}</span> : d.status === 'OPEN' ? <span className="text-xs font-semibold text-amber-600">None</span> : '—'},
    {key: 'owner', header: 'Owner', hideBelow: 'xl', cell: (d) => d.owner ? <span className="inline-flex items-center gap-2"><Avatar name={d.owner.name} color={d.owner.color} src={d.owner.avatarUrl} size="xs" />{d.owner.name.split(' ')[0]}</span> : '—'},
    {key: 'lastActivityAt', header: 'Activity', sortable: true, hideBelow: 'sm', cell: (d) => <span className="text-muted-foreground">{ago(d.lastActivityAt)}</span>},
  ];

  return (
    <div>
      <PageHeader
        title="Deals"
        description={deals.data ? <>{summary?.count ?? deals.data.length} {status === 'OPEN' ? 'open' : status.toLowerCase()} deals · <span className="font-semibold text-slate-700">{money(total, deals.data[0]?.currency ?? 'USD')}</span>{status === 'OPEN' && <> · weighted {money(weighted, deals.data[0]?.currency ?? 'USD')}</>}</> : 'Your pipeline at a glance.'}
        actions={
          <>
            <Tabs value={view} onValueChange={(v) => set({view: v as 'board' | 'list'})}>
              <TabsList>
                <TabsTrigger value="board"><KanbanSquare /> Board</TabsTrigger>
                <TabsTrigger value="list"><List /> List</TabsTrigger>
              </TabsList>
            </Tabs>
            <ImportExportActions
              entity="deal"
              filters={{pipelineId: pipeline?.id, status, ownerId: s.ownerId, q: s.q, rotting: s.rotting, closeDate: s.closeDate, createdDays: s.createdDays}}
              scopeLabel={`${status === 'ALL' ? 'all' : status.toLowerCase()} deals in ${pipeline?.name ?? 'the pipeline'}${s.ownerId || s.q || s.rotting || s.closeDate || s.createdDays ? ', current filters' : ''}`}
              importId={s.importId}
              onImportClosed={() => set({importId: undefined})}
            />
            {canEdit && <Button size="sm" className="h-9" onClick={() => create.open({kind: 'deal', defaults: {pipelineId: pipeline?.id}})}><Plus /> New deal</Button>}
          </>
        }
      />

      <div className="mb-4 flex gap-1 border-b border-slate-100">
        {[
          {label: 'All deals', ownerId: undefined},
          {label: 'My deals', ownerId: me.id},
        ].map((t) => (
          <button
            key={t.label}
            type="button"
            aria-pressed={s.ownerId === t.ownerId}
            onClick={() => set({ownerId: t.ownerId})}
            className={cn('-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/30', s.ownerId === t.ownerId ? 'border-primary text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <FilterBar
        className="mb-5"
        active={!!(s.q || s.ownerId || s.rotting || s.closeDate || s.createdDays || (view === 'list' && status !== 'OPEN'))}
        onClear={() => (setQDraft(''), set({q: undefined, ownerId: undefined, rotting: undefined, closeDate: undefined, createdDays: undefined, status: undefined}))}
      >
        <form noValidate onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
          <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search deals or companies…" />
        </form>
        <NativeSelect
          size="sm"
          aria-label="Pipeline"
          className="font-semibold"
          value={pipeline?.id ?? ''}
          onChange={(e) => (e.target.value === '__manage' ? navigate({to: '/settings/pipelines'}) : set({pipelineId: e.target.value}))}
        >
          {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {isAdmin && <option value="__manage">Manage pipelines…</option>}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Owner" value={s.ownerId ?? ''} onChange={(e) => set({ownerId: e.target.value || undefined})}>
          <option value="">Everyone</option>
          <option value={me.id}>My deals</option>
          {team.data?.filter((u) => u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </NativeSelect>
        {view === 'list' && (
          <NativeSelect size="sm" aria-label="Status" value={status} onChange={(e) => set({status: e.target.value as typeof s.status})}>
            <option value="OPEN">Open</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
            <option value="ALL">All</option>
          </NativeSelect>
        )}
        <NativeSelect size="sm" aria-label="Close date" value={s.closeDate ?? ''} onChange={(e) => set({closeDate: (e.target.value || undefined) as typeof s.closeDate})}>
          <option value="">Any close date</option>
          <option value="overdue">Past close date</option>
          <option value="this_month">Closing this month</option>
          <option value="next_month">Closing next month</option>
          <option value="this_quarter">Closing this quarter</option>
          <option value="none">No close date</option>
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Create date" value={s.createdDays ?? ''} onChange={(e) => set({createdDays: e.target.value || undefined})}>
          <option value="">Any create date</option>
          <option value="7">Created last 7 days</option>
          <option value="30">Created last 30 days</option>
          <option value="90">Created last 90 days</option>
        </NativeSelect>
        {view === 'board' && (
          <NativeSelect size="sm" aria-label="Closed deals" value={closedDays} onChange={(e) => set({closedDays: e.target.value})}>
            <option value="0">Hide won / lost</option>
            <option value="30">Won / lost: 30 days</option>
            <option value="90">Won / lost: 90 days</option>
            <option value="365">Won / lost: 12 months</option>
          </NativeSelect>
        )}
        <button
          type="button"
          aria-pressed={!!s.rotting}
          onClick={() => set({rotting: s.rotting ? undefined : '1'})}
          className={cn(
            'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
            s.rotting ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-border bg-card text-slate-600 hover:border-slate-300',
          )}
        >
          <Hourglass className="size-3.5" /> Going stale
        </button>
      </FilterBar>

      {pipelines.isError || (dealPages.isError && !deals.data) ? (
        <Card className="overflow-hidden">
          <LoadError error={pipelines.error ?? dealPages.error} onRetry={() => (pipelines.isError ? pipelines.refetch() : dealPages.refetch())} title="Deals could not be loaded" />
        </Card>
      ) : !pipeline || deals.isLoading ? (
        <div className="flex gap-4">{Array.from({length: 4}).map((_, i) => <Skeleton key={i} className="h-96 w-[280px] shrink-0 rounded-2xl" />)}</div>
      ) : view === 'board' ? (
        <DealBoard pipeline={pipeline} deals={deals.data ?? []} closed={closedDays === '0' ? undefined : closed.data ?? []} currency={deals.data?.[0]?.currency ?? 'USD'} />
      ) : (
        <Card className="overflow-hidden">
          <DataTable
            rows={deals.data}
            columns={columns}
            sort={s.sort}
            dir={s.dir}
            onSort={(key) => set({sort: key, dir: s.sort === key && s.dir === 'asc' ? 'desc' : 'asc'})}
            onRowClick={(d) => navigate({to: '/deals/$dealId', params: {dealId: d.id}})}
            empty={<EmptyState icon={<Handshake />} title="No deals here" description="Change the filters or create a new deal." />}
          />
        </Card>
      )}
      {dealPages.data && dealPages.data.total > dealPages.data.pageSize && (
        <Pagination page={dealPages.data.page} pageSize={dealPages.data.pageSize} total={dealPages.data.total} onPage={(page) => navigate({search: (p) => ({...p, page})})} />
      )}

    </div>
  );
}
