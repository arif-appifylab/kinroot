import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Building2, Plus, Trash2, UserCheck} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {useCreate} from '@/components/create-dialogs';
import {BulkBar, DataTable, Pagination, SearchInput, type Column} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {DuplicatesButton} from '@/components/duplicates';
import {ImportExportActions} from '@/components/import-export/actions';
import {SavedViews} from '@/components/saved-views';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import type {Company, Paged} from '@/lib/types';

export const Route = createFileRoute('/_app/companies/')({
  validateSearch: z.object({
    q: z.string().optional(),
    ownerId: z.string().optional(),
    tag: z.string().optional(),
    sort: z.string().optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().optional(),
    importId: z.string().optional(), // opens the import drawer (notification links)
  }),
  head: () => ({meta: [{title: pageTitle('Companies')}]}),
  component: CompaniesPage,
});

function CompaniesPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const create = useCreate();
  const {me, canEdit} = useMe();
  const team = useTeam();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qDraft, setQDraft] = useState(s.q ?? '');
  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, page: undefined, ...patch}), replace: true});

  const list = useQuery({queryKey: [...keys.companies, 'list', s], queryFn: () => api.get<Paged<Company>>('/companies', {...s, pageSize: 50}), placeholderData: keepPreviousData});
  const bulk = useApiMutation((body: {action: string; value?: string}) => api.post('/companies/bulk', {ids: [...selected], ...body}), {invalidate: recordKeys, success: 'Updated', onSuccess: () => setSelected(new Set())});

  const columns: Column<Company>[] = [
    {
      key: 'name',
      header: 'Company',
      sortable: true,
      cell: (c) => (
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-50 to-teal-50 text-sm font-extrabold text-primary">{c.name[0]}</span>
          <div className="min-w-0">
            <Link to="/companies/$companyId" params={{companyId: c.id}} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-slate-900 hover:text-primary">{c.name}</Link>
            <p className="truncate text-xs text-muted-foreground">{c.domain ?? '—'}</p>
          </div>
        </div>
      ),
    },
    {key: 'industry', header: 'Industry', sortable: true, hideBelow: 'md', cell: (c) => c.industry ?? <span className="text-slate-400">—</span>},
    {key: 'people', header: 'People', cell: (c) => c._count?.contacts ?? 0},
    {key: 'deals', header: 'Open deals', cell: (c) => (c._count?.deals ? <Badge tone="blue">{c._count.deals}</Badge> : <span className="text-slate-400">0</span>)},
    {key: 'tags', header: 'Tags', hideBelow: 'xl', cell: (c) => <span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="teal">{t}</Badge>)}</span>},
    {key: 'owner', header: 'Owner', hideBelow: 'lg', cell: (c) => c.owner ? <span className="inline-flex items-center gap-2"><Avatar name={c.owner.name} color={c.owner.color} src={c.owner.avatarUrl} size="xs" />{c.owner.name.split(' ')[0]}</span> : <span className="text-slate-400">—</span>},
    {key: 'lastActivityAt', header: 'Last activity', sortable: true, hideBelow: 'sm', cell: (c) => <span className="text-muted-foreground">{ago(c.lastActivityAt)}</span>},
  ];

  return (
    <div>
      <PageHeader
        title="Companies"
        description="The accounts behind your contacts and deals."
        actions={
          <>
            <ImportExportActions
              entity="company"
              filters={{q: s.q, ownerId: s.ownerId, tag: s.tag}}
              scopeLabel={s.q || s.ownerId || s.tag ? 'matching the current filters' : 'every company you can see'}
              importId={s.importId}
              onImportClosed={() => set({importId: undefined})}
            />
            <DuplicatesButton entity="company" />
            {canEdit && <Button size="sm" className="h-9" onClick={() => create.open({kind: 'company'})}><Plus /> New company</Button>}
          </>
        }
      />
      <div className="mb-4">
        <SavedViews
          entity="COMPANY"
          current={{ownerId: s.ownerId ?? '', tag: s.tag ?? ''}}
          onApply={(f) => set({ownerId: f.ownerId || undefined, tag: f.tag || undefined})}
          presets={[{name: 'All companies', filters: {}}, {name: 'My companies', filters: {ownerId: me.id}}]}
        />
      </div>
      <Card className="overflow-hidden">
        <FilterBar className="border-b border-slate-100 p-3" active={!!(s.q || s.ownerId || s.tag)} onClear={() => (setQDraft(''), set({q: undefined, ownerId: undefined, tag: undefined}))}>
          <form noValidate onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
            <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search name, domain, industry…" />
          </form>
          <NativeSelect size="sm" aria-label="Owner" value={s.ownerId ?? ''} onChange={(e) => set({ownerId: e.target.value || undefined})}>
            <option value="">Any owner</option>
            <option value="none">Unassigned</option>
            {team.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </NativeSelect>
          {s.tag && (
            <button type="button" aria-label={`Remove the tag filter ${s.tag}`} onClick={() => set({tag: undefined})} className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
              <Badge tone="teal" className="h-7">tag: {s.tag} ✕</Badge>
            </button>
          )}
        </FilterBar>
        <DataTable
          rows={list.data?.rows}
          columns={columns}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          sort={s.sort ?? 'createdAt'}
          dir={s.dir ?? 'desc'}
          onSort={(key) => set({sort: key, dir: s.sort === key && s.dir === 'asc' ? 'desc' : 'asc'})}
          selected={canEdit ? selected : undefined}
          onSelect={canEdit ? setSelected : undefined}
          onRowClick={(c) => navigate({to: '/companies/$companyId', params: {companyId: c.id}})}
          empty={<EmptyState icon={<Building2 />} title="No companies yet" action={canEdit && <Button onClick={() => create.open({kind: 'company'})}><Plus /> New company</Button>} />}
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(page) => navigate({search: (p) => ({...p, page})})} />}
      </Card>
      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={bulk.isPending} aria-busy={(bulk.isPending && bulk.variables?.action === 'assign') || undefined}><UserCheck /> Assign</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {team.data?.map((u) => <DropdownMenuItem key={u.id} onSelect={() => bulk.mutate({action: 'assign', value: u.id})}>{u.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-rose-300 hover:bg-white/10 hover:text-rose-200" disabled={bulk.isPending} aria-busy={(bulk.isPending && bulk.variables?.action === 'delete') || undefined}><Trash2 /> Delete</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuLabel>Delete {selected.size} companies?</DropdownMenuLabel>
            <DropdownMenuItem destructive onSelect={() => bulk.mutate({action: 'delete'})}>Yes, move to the recycle bin</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </BulkBar>
    </div>
  );
}
