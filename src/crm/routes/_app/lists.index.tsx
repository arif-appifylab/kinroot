import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Filter, List, ListChecks, MoreHorizontal, Pencil, Plus, Trash2} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {SearchInput} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {ListsNav} from '@/components/lists/broadcasts';
import {useLists} from '@/components/lists/list-picker';
import {ListDialog} from '@/components/lists/list-dialog';
import {Badge} from '@/components/ui/badge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, PageHeader, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {ContactListRow} from '@/lib/types';

export const Route = createFileRoute('/_app/lists/')({
  validateSearch: z.object({kind: z.enum(['STATIC', 'DYNAMIC']).optional(), q: z.string().optional()}),
  head: () => ({meta: [{title: pageTitle('Lists')}]}),
  component: ListsPage,
});

function ListsPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const {canEdit} = useMe();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContactListRow | null>(null);
  const lists = useLists();
  const q = (s.q ?? '').toLowerCase();
  const rows = (lists.data ?? []).filter((l) => (!s.kind || l.kind === s.kind) && (!q || l.name.toLowerCase().includes(q)));

  return (
    <div>
      <PageHeader
        title="Lists"
        description="Static lists you curate and segments that keep themselves up to date."
        actions={canEdit && <Button onClick={() => setCreating(true)}><Plus /> New list</Button>}
      />
      <ListsNav current="lists" />

      <Card className="overflow-hidden">
        <FilterBar className="border-b border-slate-100 p-3">
          <SearchInput size="sm" value={s.q ?? ''} onChange={(v) => navigate({search: (p) => ({...p, q: v || undefined}), replace: true})} placeholder="Search lists…" />
          <Tabs value={s.kind ?? 'all'} onValueChange={(v) => navigate({search: (p) => ({...p, kind: v === 'all' ? undefined : (v as 'STATIC' | 'DYNAMIC')}), replace: true})}>
            <TabsList size="sm" aria-label="List type">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="STATIC"><List /> Static</TabsTrigger>
              <TabsTrigger value="DYNAMIC"><Filter /> Segments</TabsTrigger>
            </TabsList>
          </Tabs>
        </FilterBar>
        {lists.isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
        {!lists.isLoading && rows.length === 0 && (
          <EmptyState
            icon={<ListChecks />}
            title={lists.data?.length ? 'No lists match' : 'No lists yet'}
            description="Make a static list for a campaign or event, or a segment like “Customers in Germany with an open deal”."
            action={canEdit && <Button onClick={() => setCreating(true)}><Plus /> New list</Button>}
          />
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-bold tracking-wide text-slate-500 uppercase">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Contacts</th>
                  <th className="hidden px-4 py-3 md:table-cell">Owner</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((l) => <ListRowItem key={l.id} list={l} onEdit={() => setEditing(l)} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <ListDialog onClose={() => setCreating(false)} />}
      {editing && <ListDialog list={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ListRowItem({list: l, onEdit}: {list: ContactListRow; onEdit: () => void}) {
  const {me, isAdmin, canEdit} = useMe();
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/lists/${l.id}`), {invalidate: [keys.lists, keys.recycleBin], onSuccess: (r) => binToast('List', r.binId, {reopen: false})});
  const mayEdit = canEdit && (!l.ownerId || l.ownerId === me.id || isAdmin);
  return (
    <tr className="group hover:bg-slate-50/70">
      <td className="max-w-0 px-4 py-3">
        <Link to="/lists/$listId" params={{listId: l.id}} className="font-semibold text-slate-900 hover:text-primary">{l.name}</Link>
        {l.description && <p className="truncate text-xs text-muted-foreground">{l.description}</p>}
      </td>
      <td className="px-4 py-3">{l.kind === 'DYNAMIC' ? <Badge tone="violet"><Filter /> Segment</Badge> : <Badge tone="blue"><List /> Static</Badge>}</td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">{l.count.toLocaleString()}</td>
      <td className="hidden px-4 py-3 md:table-cell">
        {l.owner ? <span className="inline-flex items-center gap-2"><Avatar name={l.owner.name} color={l.owner.color} src={l.owner.avatarUrl} size="xs" />{l.owner.name.split(' ')[0]}</span> : <span className="text-slate-400">—</span>}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{ago(l.updatedAt)}</td>
      <td className="px-2 py-3">
        {mayEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Options for ${l.name}`}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onEdit}><Pencil /> Rename</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${l.name}"?`, description: `Contacts stay; the list can be restored from the recycle bin for 30 days.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}
