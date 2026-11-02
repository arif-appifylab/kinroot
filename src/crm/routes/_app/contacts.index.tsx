import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ListMinus, ListPlus, Plus, Tag, Trash2, UserCheck, Users} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {useCreate} from '@/components/create-dialogs';
import {BulkBar, DataTable, Pagination, SearchInput, type Column} from '@/components/data-table';
import {DuplicatesButton} from '@/components/duplicates';
import {FilterBar} from '@/components/filter-bar';
import {ImportExportActions} from '@/components/import-export/actions';
import {ListMenu, useLists} from '@/components/lists/list-picker';
import {ScoreBadge, useBands} from '@/components/scoring/score';
import {SavedViews} from '@/components/saved-views';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {ago, fullName, LIFECYCLE} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe, useSettings, useTeam} from '@/lib/queries';
import type {Contact, LifecycleStage, Paged} from '@/lib/types';

const search = z.object({
  q: z.string().optional(),
  ownerId: z.string().optional(),
  lifecycleStage: z.string().optional(),
  source: z.string().optional(),
  tag: z.string().optional(),
  noActivityDays: z.string().optional(),
  listId: z.string().optional(),
  scoreBand: z.string().optional(),
  importId: z.string().optional(), // opens the import drawer (notification links)
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().optional(),
});

export const Route = createFileRoute('/_app/contacts/')({
  validateSearch: search,
  head: () => ({meta: [{title: pageTitle('Contacts')}]}),
  component: ContactsPage,
});

function ContactsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const create = useCreate();
  const {me, canEdit} = useMe();
  const team = useTeam();
  const settings = useSettings();
  const lists = useLists();
  const bands = useBands();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qDraft, setQDraft] = useState(s.q ?? '');

  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, page: undefined, ...patch}), replace: true});
  const filters = {ownerId: s.ownerId ?? '', lifecycleStage: s.lifecycleStage ?? '', source: s.source ?? '', tag: s.tag ?? '', noActivityDays: s.noActivityDays ?? '', listId: s.listId ?? '', scoreBand: s.scoreBand ?? ''};

  const list = useQuery({
    queryKey: [...keys.contacts, 'list', s],
    queryFn: () => api.get<Paged<Contact>>('/contacts', {...s, pageSize: 50}),
    placeholderData: keepPreviousData,
  });
  const bulk = useApiMutation((body: {action: string; value?: string}) => api.post('/contacts/bulk', {ids: [...selected], ...body}), {invalidate: recordKeys, success: 'Updated', onSuccess: () => setSelected(new Set())});
  const listInvalidate = [keys.lists, ...recordKeys];
  const addToList = useApiMutation((listId: string) => api.post<{added: number}>(`/lists/${listId}/members`, {contactIds: [...selected]}), {invalidate: listInvalidate, success: (r) => `Added ${r.added} to the list`, onSuccess: () => setSelected(new Set())});
  const newList = useApiMutation((name: string) => api.post('/lists', {name, kind: 'STATIC', contactIds: [...selected]}), {invalidate: listInvalidate, success: 'List created', onSuccess: () => setSelected(new Set())});
  const removeFromList = useApiMutation((listId: string) => api.post<{removed: number}>(`/lists/${listId}/members/remove`, {contactIds: [...selected]}), {invalidate: listInvalidate, success: (r) => `Removed ${r.removed} from the list`, onSuccess: () => setSelected(new Set())});

  const columns: Column<Contact>[] = [
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
    {key: 'company', header: 'Company', hideBelow: 'md', cell: (c) => c.companies[0] ? <span className="font-medium">{c.companies[0].company.name}</span> : <span className="text-slate-400">—</span>},
    {key: 'title', header: 'Title', hideBelow: 'xl', cell: (c) => c.title ?? <span className="text-slate-400">—</span>},
    {key: 'lifecycleStage', header: 'Stage', sortable: true, cell: (c) => <Badge tone={LIFECYCLE[c.lifecycleStage].tone}>{LIFECYCLE[c.lifecycleStage].label}</Badge>},
    {key: 'score', header: 'Score', sortable: true, hideBelow: 'sm', cell: (c) => <ScoreBadge score={c.score} compact />},
    {key: 'owner', header: 'Owner', hideBelow: 'lg', cell: (c) => c.owner ? <span className="inline-flex items-center gap-2"><Avatar name={c.owner.name} color={c.owner.color} src={c.owner.avatarUrl} size="xs" />{c.owner.name.split(' ')[0]}</span> : <span className="text-slate-400">—</span>},
    {key: 'lastActivityAt', header: 'Last activity', sortable: true, hideBelow: 'sm', cell: (c) => <span className="text-muted-foreground">{ago(c.lastActivityAt)}</span>},
  ];

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="Everyone you sell to, with their full history."
        actions={
          <>
            <ImportExportActions
              entity="contact"
              filters={{...filters, q: s.q}}
              scopeLabel={s.q || Object.values(filters).some(Boolean) ? 'matching the current filters' : 'everyone you can see'}
              importId={s.importId}
              onImportClosed={() => set({importId: undefined})}
            />
            <DuplicatesButton entity="contact" />
            {canEdit && <Button size="sm" className="h-9" onClick={() => create.open({kind: 'contact'})}><Plus /> New contact</Button>}
          </>
        }
      />

      <div className="mb-4">
        <SavedViews
          entity="CONTACT"
          current={filters}
          onApply={(f) => set({ownerId: f.ownerId || undefined, lifecycleStage: f.lifecycleStage || undefined, source: f.source || undefined, tag: f.tag || undefined, noActivityDays: f.noActivityDays || undefined, listId: f.listId || undefined, scoreBand: f.scoreBand || undefined})}
          presets={[
            {name: 'All contacts', filters: {}},
            {name: 'My contacts', filters: {ownerId: me.id}},
            {name: 'Leads', filters: {lifecycleStage: 'LEAD'}},
            {name: 'Customers', filters: {lifecycleStage: 'CUSTOMER'}},
            {name: 'Gone quiet (30d)', filters: {noActivityDays: '30'}},
            ...(bands.length > 1 ? [{name: `${bands.at(-1)!.name} leads`, filters: {scoreBand: bands.at(-1)!.key}}] : []),
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        <FilterBar
          className="border-b border-slate-100 p-3"
          active={!!s.q || Object.values(filters).some(Boolean)}
          onClear={() => (setQDraft(''), set({q: undefined, ownerId: undefined, lifecycleStage: undefined, source: undefined, tag: undefined, noActivityDays: undefined, listId: undefined, scoreBand: undefined}))}
        >
          <form onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
            <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search name, email, company…" />
          </form>
          <NativeSelect size="sm" aria-label="Owner" value={filters.ownerId} onChange={(e) => set({ownerId: e.target.value || undefined})}>
            <option value="">Any owner</option>
            <option value="none">Unassigned</option>
            {team.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Lifecycle stage" value={filters.lifecycleStage} onChange={(e) => set({lifecycleStage: e.target.value || undefined})}>
            <option value="">Any stage</option>
            {Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Source" value={filters.source} onChange={(e) => set({source: e.target.value || undefined})}>
            <option value="">Any source</option>
            {settings.data?.settings.sources.map((src) => <option key={src}>{src}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="List" value={filters.listId} onChange={(e) => set({listId: e.target.value || undefined})}>
            <option value="">Any list</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}{l.kind === 'DYNAMIC' ? ' (segment)' : ''}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Lead score band" value={filters.scoreBand} onChange={(e) => set({scoreBand: e.target.value || undefined})}>
            <option value="">Any score</option>
            {bands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
          </NativeSelect>
          {s.tag && <Badge tone="teal" className="h-7 cursor-pointer" onClick={() => set({tag: undefined})}>tag: {s.tag} ✕</Badge>}
        </FilterBar>
        <DataTable
          rows={list.data?.rows}
          columns={columns}
          loading={list.isLoading}
          sort={s.sort ?? 'createdAt'}
          dir={s.dir ?? 'desc'}
          onSort={(key) => set({sort: key, dir: s.sort === key && s.dir === 'asc' ? 'desc' : 'asc'})}
          selected={canEdit ? selected : undefined}
          onSelect={canEdit ? setSelected : undefined}
          onRowClick={(c) => navigate({to: '/contacts/$contactId', params: {contactId: c.id}})}
          empty={<EmptyState icon={<Users />} title="No contacts match" description="Try a different filter, or add your first contact." action={canEdit && <Button onClick={() => create.open({kind: 'contact'})}><Plus /> New contact</Button>} />}
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(page) => navigate({search: (p) => ({...p, page})})} />}
      </Card>

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white"><UserCheck /> Assign</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {team.data?.map((u) => <DropdownMenuItem key={u.id} onSelect={() => bulk.mutate({action: 'assign', value: u.id})}>{u.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white">Stage</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {(Object.keys(LIFECYCLE) as LifecycleStage[]).map((k) => <DropdownMenuItem key={k} onSelect={() => bulk.mutate({action: 'stage', value: k})}>{LIFECYCLE[k].label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <BulkTagMenu onTag={(value) => bulk.mutate({action: 'tag', value})} />
        <ListMenu
          label={`Add ${selected.size} to a list`}
          onPick={(l) => addToList.mutate(l.id)}
          onCreate={(name) => name && newList.mutate(name)}
          trigger={<Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Add to list"><ListPlus /> <span className="hidden sm:inline">Add to list</span></Button>}
        />
        <ListMenu
          label={`Remove ${selected.size} from a list`}
          onPick={(l) => removeFromList.mutate(l.id)}
          trigger={<Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Remove from list"><ListMinus /> <span className="hidden sm:inline">Remove from list</span></Button>}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-rose-300 hover:bg-white/10 hover:text-rose-200"><Trash2 /> Delete</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuLabel>Delete {selected.size} contacts?</DropdownMenuLabel>
            <DropdownMenuItem destructive onSelect={() => bulk.mutate({action: 'delete'})}>Yes, move to the recycle bin</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </BulkBar>
    </div>
  );
}

/** Tag the selection with an existing tag, or type a new one right in the menu. */
function BulkTagMenu({onTag}: {onTag: (tag: string) => void}) {
  const [draft, setDraft] = useState('');
  const tags = useQuery({queryKey: [...keys.tags, 'CONTACT'], queryFn: () => api.get<{rows: {tag: string}[]}>('/tags', {entity: 'CONTACT'}), select: (d) => d.rows.map((r) => r.tag)});
  const q = draft.trim().toLowerCase();
  const shown = (tags.data ?? []).filter((t) => t.includes(q)).slice(0, 8);
  return (
    <DropdownMenu onOpenChange={(o) => !o && setDraft('')}>
      <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white"><Tag /> Tag</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-60">
        <div className="p-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // keep typing inside the menu
              if (e.key === 'Enter' && q) onTag(q);
            }}
            placeholder="Find or create a tag…"
            className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm outline-none focus:border-primary"
          />
        </div>
        {shown.map((t) => <DropdownMenuItem key={t} onSelect={() => onTag(t)}><Tag /> {t}</DropdownMenuItem>)}
        {q && !(tags.data ?? []).includes(q) && (
          <DropdownMenuItem onSelect={() => onTag(q)} className="font-semibold text-primary"><Plus /> Create tag “{q}”</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
