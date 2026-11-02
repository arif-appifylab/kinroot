import {useQuery} from '@tanstack/react-query';
import {Check, ListPlus, Plus, Search} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {api} from '@/lib/api';
import {keys} from '@/lib/queries';
import type {ContactListRow, ListKind} from '@/lib/types';
import {cn} from '@/lib/utils';

import {prompt} from '../ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '../ui/menu';

/** Every list (or only static lists / segments), with live member counts. */
export function useLists(kind?: ListKind) {
  return useQuery({
    queryKey: [...keys.lists, 'all'],
    queryFn: () => api.get<{rows: ContactListRow[]}>('/lists'),
    select: (d) => (kind ? d.rows.filter((l) => l.kind === kind) : d.rows),
    staleTime: 30_000,
  });
}

/** Toggle chips for picking static lists (forms, import). */
export function ListMultiSelect({value, onChange}: {value: string[]; onChange: (ids: string[]) => void}) {
  const lists = useLists('STATIC');
  if (lists.isLoading) return <p className="text-xs text-muted-foreground">Loading lists…</p>;
  if (!lists.data?.length) return <p className="text-xs text-muted-foreground">No static lists yet. Create one on the Lists page.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {lists.data.map((l) => {
        const on = value.includes(l.id);
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onChange(on ? value.filter((id) => id !== l.id) : [...value, l.id])}
            className={cn('inline-flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition-colors', on ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600 hover:border-primary/50')}
          >
            {on && <Check className="size-3" />}
            {l.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Dropdown of static lists with a search box and a "New list" row. Used by the
 * contacts bulk bar and the contact page's Lists card.
 */
export function ListMenu({trigger, label, onPick, onCreate, exclude = [], align = 'center'}: {trigger: ReactNode; label: string; onPick: (list: ContactListRow) => void; onCreate?: (name: string) => void; exclude?: string[]; align?: 'start' | 'center' | 'end'}) {
  const [draft, setDraft] = useState('');
  const lists = useLists('STATIC');
  const q = draft.trim().toLowerCase();
  const shown = (lists.data ?? []).filter((l) => !exclude.includes(l.id) && l.name.toLowerCase().includes(q)).slice(0, 10);
  return (
    <DropdownMenu onOpenChange={(o) => !o && setDraft('')}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <div className="relative p-1">
          <Search className="absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // keep typing inside the menu
              if (e.key === 'Enter' && q && onCreate && !shown.length) onCreate(draft.trim());
            }}
            placeholder="Find a list…"
            className="h-9 w-full rounded-lg border border-input bg-card pr-2.5 pl-8 text-sm outline-none focus:border-primary"
          />
        </div>
        {shown.map((l) => (
          <DropdownMenuItem key={l.id} onSelect={() => onPick(l)}>
            <ListPlus /> <span className="flex-1 truncate">{l.name}</span> <span className="text-xs text-muted-foreground tabular-nums">{l.count}</span>
          </DropdownMenuItem>
        ))}
        {!shown.length && !onCreate && <p className="px-2 py-2 text-xs text-muted-foreground">No static lists{q ? ' match' : ' yet'}.</p>}
        {onCreate && (
          <>
            {shown.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={async () => onCreate(draft.trim() || (await prompt({title: 'Name the new list', label: 'List name', confirmLabel: 'Create list'})) || '')} className="font-semibold text-primary">
              <Plus /> {draft.trim() ? `New list “${draft.trim()}”` : 'New list…'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
