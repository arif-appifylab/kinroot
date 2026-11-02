import {keepPreviousData, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, ChevronDown, ClipboardList, Copy, Filter, List, Loader2, Mail, Pencil, Plus, RefreshCw, Trash2, UserMinus, Users} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {BulkBar, DataTable, Pagination, SearchInput, type Column} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {ImportExportActions} from '@/components/import-export/actions';
import {BroadcastDialog, BroadcastHistory} from '@/components/lists/broadcasts';
import {ListDialog} from '@/components/lists/list-dialog';
import {RulesSummary, SegmentBuilder, SegmentPreview} from '@/components/lists/segment-builder';
import {ContactsPicker} from '@/components/pickers';
import {Badge} from '@/components/ui/badge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, Skeleton} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, fullName, LIFECYCLE} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe} from '@/lib/queries';
import type {SegmentRules} from '@/lib/segments';
import type {ContactListRow, ContactListUsage, ContactLite, ListMember, Paged} from '@/lib/types';

export const Route = createFileRoute('/_app/lists/$listId')({
  validateSearch: z.object({
    edit: z.boolean().optional(),
    q: z.string().optional(),
    sort: z.string().optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().optional(),
  }),
  head: () => ({meta: [{title: pageTitle('List')}]}),
  component: ListPage,
});

function ListPage() {
  const {listId} = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const qc = useQueryClient();
  const {me, isAdmin, canEdit} = useMe();
  const [qDraft, setQDraft] = useState(s.q ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [draft, setDraft] = useState<SegmentRules | null>(null);

  const detail = useQuery({queryKey: [...keys.lists, listId], queryFn: () => api.get<{list: ContactListRow; usedBy: ContactListUsage}>(`/lists/${listId}`)});
  const members = useQuery({
    queryKey: [...keys.lists, listId, 'members', s.q, s.sort, s.dir, s.page],
    queryFn: () => api.get<Paged<ListMember>>(`/lists/${listId}/members`, {q: s.q, sort: s.sort, dir: s.dir, page: s.page, pageSize: 50}),
    placeholderData: keepPreviousData,
  });
  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, page: undefined, ...patch}), replace: true});
  const invalidate = [keys.lists, keys.timeline, ...recordKeys];

  const saveRules = useApiMutation((rules: SegmentRules) => api.patch(`/lists/${listId}`, {rules}), {invalidate: [keys.lists], success: 'Segment saved', onSuccess: () => (setDraft(null), set({edit: undefined}))});
  const remove = useApiMutation((ids: string[]) => api.post<{removed: number}>(`/lists/${listId}/members/remove`, {contactIds: ids}), {invalidate, success: (r) => `Removed ${r.removed} from the list`, onSuccess: () => setSelected(new Set())});
  const snapshot = useApiMutation(() => api.post<{list: {id: string}; added: number}>(`/lists/${listId}/snapshot`, {}), {
    invalidate: [keys.lists],
    success: (r) => `Static copy created with ${r.added} contacts`,
    onSuccess: (r) => navigate({to: '/lists/$listId', params: {listId: r.list.id}, search: {}}),
  });
  const binToast = useBinToast();
  const del = useApiMutation(() => api.del<{binId: string | null}>(`/lists/${listId}`), {invalidate: [keys.lists, keys.recycleBin], onSuccess: (r) => (binToast('List', r.binId), navigate({to: '/lists', search: {}}))});

  const list = detail.data?.list;
  if (detail.isLoading || !list) {
    return detail.error ? <p className="text-sm text-destructive">{(detail.error as Error).message}</p> : <Skeleton className="h-64 rounded-2xl" />;
  }
  const usedBy = detail.data!.usedBy;
  const isSegment = list.kind === 'DYNAMIC';
  const mayEdit = canEdit && (!list.ownerId || list.ownerId === me.id || isAdmin);
  const editing = isSegment && mayEdit && (s.edit || draft !== null);
  const rules = draft ?? list.rules;

  const columns: Column<ListMember>[] = [
    {
      key: 'firstName',
      header: 'Name',
      sortable: true,
      cell: (c) => (
        <div className="flex items-center gap-3">
          <Avatar name={fullName(c)} size="sm" />
          <div className="min-w-0">
            <Link to="/contacts/$contactId" params={{contactId: c.id}} className="block truncate font-semibold text-slate-900 hover:text-primary" onClick={(e) => e.stopPropagation()}>{fullName(c)}</Link>
            <p className="truncate text-xs text-muted-foreground">{c.email ?? c.phone ?? '—'}</p>
          </div>
        </div>
      ),
    },
    {key: 'company', header: 'Company', hideBelow: 'md', cell: (c) => c.companies[0]?.company.name ?? <span className="text-slate-400">—</span>},
    {key: 'lifecycleStage', header: 'Stage', sortable: true, cell: (c) => <Badge tone={LIFECYCLE[c.lifecycleStage].tone}>{LIFECYCLE[c.lifecycleStage].label}</Badge>},
    {key: 'owner', header: 'Owner', hideBelow: 'lg', cell: (c) => c.owner ? <span className="inline-flex items-center gap-2"><Avatar name={c.owner.name} color={c.owner.color} src={c.owner.avatarUrl} size="xs" />{c.owner.name.split(' ')[0]}</span> : <span className="text-slate-400">—</span>},
    isSegment
      ? {key: 'lastActivityAt', header: 'Last activity', sortable: true, hideBelow: 'sm', cell: (c) => <span className="text-muted-foreground">{ago(c.lastActivityAt)}</span>}
      : {key: 'added', header: 'Added', hideBelow: 'sm', cell: (c) => <span className="text-muted-foreground">{ago(c.listMemberships?.[0]?.createdAt)}{c.listMemberships?.[0]?.source && c.listMemberships[0].source !== 'manual' ? ` · ${c.listMemberships[0].source}` : ''}</span>},
  ];

  return (
    <div>
      <Link to="/lists" search={{}} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Lists
      </Link>

      <Card className="relative mb-6 overflow-hidden p-5 sm:p-6">
        <div className="blob -top-24 -right-16 size-64 bg-blue-200/40" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900">{list.name}</h1>
              {isSegment ? <Badge tone="violet"><Filter /> Segment</Badge> : <Badge tone="blue"><List /> Static list</Badge>}
            </div>
            {list.description && <p className="mt-1 text-sm text-slate-600">{list.description}</p>}
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold text-slate-800 tabular-nums">{list.count.toLocaleString()}</span> contacts · {list.owner ? `owned by ${list.owner.name}` : 'no owner'} · updated {ago(list.updatedAt)}
            </p>
            {(usedBy.forms.length > 0 || usedBy.segments.length > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Used by
                {usedBy.forms.map((f) => <Link key={f.id} to="/forms/$formId" params={{formId: f.id}}><Badge tone="outline"><ClipboardList /> {f.name}</Badge></Link>)}
                {usedBy.segments.map((l) => <Link key={l.id} to="/lists/$listId" params={{listId: l.id}} search={{}}><Badge tone="outline"><Filter /> {l.name}</Badge></Link>)}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && <Button size="sm" variant={isSegment ? 'default' : 'secondary'} onClick={() => setEmailing(true)} disabled={!list.count}><Mail /> Send email</Button>}
            {!isSegment && canEdit && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add contacts</Button>}

            {isSegment && (
              <Button variant="secondary" size="sm" onClick={() => qc.invalidateQueries({queryKey: [...keys.lists, listId]})} disabled={detail.isFetching || members.isFetching}>
                <RefreshCw className={detail.isFetching || members.isFetching ? 'animate-spin' : undefined} /> Refresh
              </Button>
            )}
            <ImportExportActions entity="contact" filters={{}} listId={listId} canImport={!isSegment} scopeLabel={`members of ${list.name}`} />
            {mayEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="secondary" size="sm">Actions <ChevronDown /></Button></DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  <DropdownMenuItem onSelect={() => setRenaming(true)}><Pencil /> Rename</DropdownMenuItem>
                  {isSegment && <DropdownMenuItem onSelect={() => set({edit: true})}><Filter /> Edit rules</DropdownMenuItem>}
                  {isSegment && <DropdownMenuItem onSelect={() => snapshot.mutate(undefined)}><Copy /> Save as static list</DropdownMenuItem>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${list.name}"?`, description: `Contacts stay; the list can be restored from the recycle bin for 30 days.${usedBy.forms.length ? ' Forms using it stop adding to it.' : ''}`, confirmLabel: 'Delete', destructive: true})) && del.mutate(undefined)}><Trash2 /> Delete list</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </Card>

      {isSegment && (
        <Card className="mb-6 p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Rules</h2>
              <p className="text-xs text-muted-foreground">Evaluated every time the segment is opened, exported or used.</p>
            </div>
            {!editing && mayEdit && <Button variant="secondary" size="sm" onClick={() => set({edit: true})}><Pencil /> Edit rules</Button>}
          </div>
          {editing ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <SegmentBuilder rules={rules} onChange={setDraft} listId={listId} />
              <div className="grid content-start gap-3 lg:sticky lg:top-20">
                <SegmentPreview rules={rules} listId={listId} />
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => (setDraft(null), set({edit: undefined}))}>Cancel</Button>
                  <Button className="flex-1" onClick={() => saveRules.mutate(rules)} disabled={saveRules.isPending}>{saveRules.isPending && <Loader2 className="animate-spin" />} Save</Button>
                </div>
              </div>
            </div>
          ) : (
            <RulesSummary rules={list.rules} />
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <FilterBar className="border-b border-slate-100 p-3">
          <form onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
            <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search members…" />
          </form>
        </FilterBar>
        <DataTable
          rows={members.data?.rows}
          columns={columns}
          loading={members.isLoading}
          sort={s.sort ?? 'createdAt'}
          dir={s.dir ?? 'desc'}
          onSort={(key) => set({sort: key, dir: s.sort === key && s.dir === 'asc' ? 'desc' : 'asc'})}
          selected={!isSegment && canEdit ? selected : undefined}
          onSelect={!isSegment && canEdit ? setSelected : undefined}
          onRowClick={(c) => navigate({to: '/contacts/$contactId', params: {contactId: c.id}})}
          empty={
            <EmptyState
              icon={<Users />}
              title={s.q ? 'No members match' : isSegment ? 'Nobody matches these rules yet' : 'This list is empty'}
              description={isSegment ? 'Adjust the rules, or check back as contacts change.' : 'Add contacts by hand, from the contacts table, by CSV import or from a form.'}
              action={!isSegment && canEdit && !s.q && <Button onClick={() => setAdding(true)}><Plus /> Add contacts</Button>}
            />
          }
        />
        {members.data && <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPage={(page) => navigate({search: (p) => ({...p, page})})} />}
      </Card>

      <div className="mt-6"><BroadcastHistory listId={listId} /></div>

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" className="text-rose-300 hover:bg-white/10 hover:text-rose-200" onClick={() => remove.mutate([...selected])}><UserMinus /> Remove from list</Button>
      </BulkBar>

      {renaming && <ListDialog list={list} onClose={() => setRenaming(false)} />}
      {emailing && <BroadcastDialog list={list} onClose={() => setEmailing(false)} />}
      {adding && <AddMembersDialog listId={listId} name={list.name} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddMembersDialog({listId, name, onClose}: {listId: string; name: string; onClose: () => void}) {
  const [picked, setPicked] = useState<ContactLite[]>([]);
  const add = useApiMutation(() => api.post<{added: number}>(`/lists/${listId}/members`, {contactIds: picked.map((c) => c.id)}), {
    invalidate: [keys.lists, keys.timeline, ...recordKeys],
    success: (r) => `Added ${r.added} to ${name}`,
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add contacts</DialogTitle>
          <DialogDescription>Search by name or email. To add many at once, select them in the contacts table and use “Lists”.</DialogDescription>
        </DialogHeader>
        <DialogBody><ContactsPicker value={picked} onChange={setPicked} /></DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => add.mutate(undefined)} disabled={!picked.length || add.isPending}>{add.isPending && <Loader2 className="animate-spin" />} Add {picked.length || ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
