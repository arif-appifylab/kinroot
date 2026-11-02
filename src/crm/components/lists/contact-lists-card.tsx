import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Filter, List, Plus, X} from 'lucide-react';

import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe} from '@/lib/queries';
import type {ContactListMembership, ContactListRow} from '@/lib/types';

import {PropertyCard} from '../properties';
import {Button} from '../ui/button';
import {ListMenu} from './list-picker';

/** Lists a contact is in: static memberships (removable) and segments that match right now. */
export function ContactListsCard({contactId}: {contactId: string}) {
  const {canEdit} = useMe();
  const q = useQuery({queryKey: [...keys.lists, 'contact', contactId], queryFn: () => api.get<{rows: ContactListMembership[]}>(`/lists/for-contact/${contactId}`), select: (d) => d.rows});
  const invalidate = [keys.lists, keys.timeline, ...recordKeys];
  const add = useApiMutation((list: ContactListRow) => api.post(`/lists/${list.id}/members`, {contactIds: [contactId]}), {invalidate, success: 'Added to list'});
  const create = useApiMutation((name: string) => api.post('/lists', {name, kind: 'STATIC', contactIds: [contactId]}), {invalidate, success: 'List created'});
  const remove = useApiMutation((listId: string) => api.post(`/lists/${listId}/members/remove`, {contactIds: [contactId]}), {invalidate});
  const rows = q.data ?? [];

  return (
    <PropertyCard
      title={`Lists · ${rows.length}`}
      action={
        canEdit && (
          <ListMenu
            label="Add to a static list"
            align="end"
            exclude={rows.map((r) => r.id)}
            onPick={(l) => add.mutate(l)}
            onCreate={(name) => name && create.mutate(name)}
            trigger={<Button variant="ghost" size="sm"><Plus /> Add</Button>}
          />
        )
      }
    >
      {q.isLoading && <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>}
      {!q.isLoading && rows.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">Not in any list</p>}
      {rows.map((l) => (
        <div key={l.id} className="group flex items-center gap-2.5 px-3 py-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">{l.kind === 'DYNAMIC' ? <Filter className="size-4" /> : <List className="size-4" />}</span>
          <Link to="/lists/$listId" params={{listId: l.id}} className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-800 hover:text-primary">{l.name}</p>
            <p className="text-xs text-muted-foreground">{l.kind === 'DYNAMIC' ? 'Segment · matches now' : `Added ${ago(l.addedAt)}${l.source && l.source !== 'manual' ? ` · ${l.source}` : ''}`}</p>
          </Link>
          {canEdit && l.kind === 'STATIC' && (
            <button aria-label={`Remove from ${l.name}`} onClick={() => remove.mutate(l.id)} className="cursor-pointer rounded p-1 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100">
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}
    </PropertyCard>
  );
}
