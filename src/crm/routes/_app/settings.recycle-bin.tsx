import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ArchiveRestore, Building2, ClipboardList, Handshake, Inbox, LifeBuoy, ListChecks, MoreHorizontal, Trash2, User} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {BulkBar, DataTable, Pagination, SearchInput, type Column} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, IconBadge, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime} from '@/lib/format';
import {BIN_COUNT_LABELS, BIN_DAYS, BIN_ENTITIES, type BinEntity} from '@/lib/hygiene';
import {keys, recordKeys, useApiMutation, useMe} from '@/lib/queries';
import type {BinEntry, BinResponse, RestoreResult} from '@/lib/types';

export const Route = createFileRoute('/_app/settings/recycle-bin')({
  head: () => ({meta: [{title: pageTitle('Recycle bin')}]}),
  component: RecycleBin,
});

const ICONS: Record<BinEntity, typeof User> = {contact: User, company: Building2, deal: Handshake, ticket: LifeBuoy, form: ClipboardList, list: ListChecks, conversation: Inbox};

const daysLeft = (expiresAt: string) => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));

/** "3 notes, 12 timeline entries" from the bin entry's counts. */
function contents(counts: Record<string, number>) {
  const parts = Object.entries(BIN_COUNT_LABELS)
    .filter(([k]) => counts[k])
    .map(([k, [one, many]]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
  return parts.length ? parts.slice(0, 3).join(', ') + (parts.length > 3 ? '…' : '') : 'Nothing else';
}

/** Keys to refresh after restoring: the record lists and everything hanging off them. */
const restoredKeys = [...recordKeys, keys.lists, keys.forms, keys.tickets];

function RecycleBin() {
  const {isAdmin, canEdit} = useMe();
  const navigate = useNavigate();
  const [entity, setEntity] = useState<BinEntity | 'all'>('all');
  const [q, setQ] = useState('');
  const [qDraft, setQDraft] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const params = {entity: entity === 'all' ? undefined : entity, q: q || undefined, page};
  const list = useQuery({queryKey: [...keys.recycleBin, params], queryFn: () => api.get<BinResponse>('/recycle-bin', params), placeholderData: keepPreviousData});

  const afterRestore = (rows: RestoreResult[]) => {
    for (const r of rows.filter((x) => x.warning)) toast.warning(r.label, {description: r.warning!});
    setSelected(new Set());
  };
  const restore = useApiMutation((id: string) => api.post<{restored: RestoreResult}>(`/recycle-bin/${id}/restore`), {
    invalidate: restoredKeys,
    onSuccess: ({restored}) => {
      afterRestore([restored]);
      toast.success(`${restored.label} restored`, {action: {label: 'Open', onClick: () => navigate({href: restored.path})}});
    },
  });
  const restoreMany = useApiMutation((ids: string[]) => api.post<{restored: RestoreResult[]; failed: {id: string; error: string}[]}>('/recycle-bin/restore', {ids}), {
    invalidate: restoredKeys,
    onSuccess: (r) => {
      afterRestore(r.restored);
      if (r.restored.length) toast.success(`${r.restored.length} restored`);
      for (const f of r.failed) toast.error(f.error);
    },
  });
  const purge = useApiMutation((ids: string[]) => api.post<{purged: number}>('/recycle-bin/purge', {ids}), {
    invalidate: [keys.recycleBin],
    success: (r) => `${r.purged} deleted forever`,
    onSuccess: () => setSelected(new Set()),
  });

  const data = list.data;
  const total = Object.values(data?.counts ?? {}).reduce((a, b) => a + b, 0);
  const columns: Column<BinEntry>[] = [
    {
      key: 'label',
      header: 'Record',
      cell: (r) => {
        const Icon = ICONS[r.entity as BinEntity] ?? Trash2;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <IconBadge tone="slate" className="size-8 rounded-lg [&_svg]:size-4"><Icon /></IconBadge>
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-900">{r.label}</p>
              <p className="truncate text-xs text-muted-foreground">{BIN_ENTITIES[r.entity as BinEntity]?.label ?? r.entity}{r.detail ? ` · ${r.detail}` : ''}</p>
            </div>
          </div>
        );
      },
    },
    {key: 'contents', header: 'Comes back with', hideBelow: 'lg', cell: (r) => <span className="text-xs text-muted-foreground">{contents(r.counts)}</span>},
    {key: 'deleted', header: 'Deleted', cell: (r) => <span className="text-muted-foreground" title={dateTime(r.deletedAt)}>{ago(r.deletedAt)}{r.deletedByName ? ` by ${r.deletedByName}` : ''}</span>},
    {
      key: 'left',
      header: 'Days left',
      hideBelow: 'sm',
      cell: (r) => {
        const left = daysLeft(r.expiresAt);
        return <Badge tone={left <= 3 ? 'rose' : left <= 7 ? 'amber' : 'neutral'}>{left === 0 ? 'Today' : `${left} day${left === 1 ? '' : 's'}`}</Badge>;
      },
    },
    {
      key: 'actions',
      header: '',
      className: 'w-0 text-right',
      cell: (r) =>
        canEdit && (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button variant="secondary" size="sm" disabled={restore.isPending || purge.isPending} pending={restore.isPending && restore.variables === r.id} pendingLabel="Restoring…" onClick={() => restore.mutate(r.id)}><ArchiveRestore /> Restore</Button>
            {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={restore.isPending || purge.isPending}><Button variant="ghost" size="icon-sm" pending={purge.isPending && purge.variables?.length === 1 && purge.variables[0] === r.id} aria-label={`More actions for ${r.label}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${r.label}" forever?`, description: `This can't be undone.`, confirmLabel: 'Delete forever', destructive: true})) && purge.mutate([r.id])}><Trash2 /> Delete forever</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ),
    },
  ];

  return (
    <SettingsSection
      title="Recycle bin"
      description={`Deleted records stay here for ${BIN_DAYS} days. Restoring brings a record back with its notes, tasks, timeline, files and links.${isAdmin ? '' : ' You see the records you deleted.'}`}
    >
      <FilterBar className="mb-4 [&>*]:max-w-full">
        <form role="search" noValidate onSubmit={(e) => (e.preventDefault(), setQ(qDraft), setPage(1))} className="contents">
          <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && (setQ(''), setPage(1)))} placeholder="Search deleted records…" />
        </form>
        <Tabs value={entity} onValueChange={(v) => (setEntity(v as BinEntity | 'all'), setPage(1), setSelected(new Set()))}>
          <TabsList size="sm" aria-label="Record type" className="max-w-full overflow-x-auto scrollbar-thin">
            <TabsTrigger value="all">All {total ? <span className="text-slate-400">{total}</span> : null}</TabsTrigger>
            {(Object.keys(BIN_ENTITIES) as BinEntity[]).map((k) => (
              <TabsTrigger key={k} value={k}>{BIN_ENTITIES[k].plural}{data?.counts[k] ? <span className="text-slate-400">{data.counts[k]}</span> : null}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </FilterBar>
      <div className="-mx-5 border-t border-slate-100">
        <DataTable
          rows={data?.rows}
          columns={columns}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          selected={canEdit ? selected : undefined}
          onSelect={canEdit ? setSelected : undefined}
          empty={<EmptyState icon={<Trash2 />} title={q ? 'Nothing matches' : 'The recycle bin is empty'} description={`Deleted contacts, companies, deals, tickets, forms and lists wait here for ${BIN_DAYS} days.`} />}
        />
        {data && data.total > 0 && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={purge.isPending} pending={restoreMany.isPending} pendingLabel="Restoring…" onClick={() => restoreMany.mutate([...selected])}>
          <ArchiveRestore /> Restore
        </Button>
        {isAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={restoreMany.isPending || purge.isPending}><Button size="sm" variant="ghost" className="text-rose-300 hover:bg-white/10 hover:text-rose-200" pending={purge.isPending && (purge.variables?.length ?? 0) > 1} pendingLabel="Deleting…"><Trash2 /> Delete forever</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuLabel>Delete {selected.size} forever? This can't be undone.</DropdownMenuLabel>
              <DropdownMenuItem destructive onSelect={() => purge.mutate([...selected])}>Yes, delete forever</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </BulkBar>
    </SettingsSection>
  );
}
