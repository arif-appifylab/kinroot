import {useQuery} from '@tanstack/react-query';
import {Bookmark, BookmarkPlus, Trash2} from 'lucide-react';

import {api} from '@/lib/api';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {EntityType, SavedView} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Button} from './ui/button';
import {confirm, prompt} from './ui/confirm';

/** Built-in "smart views" plus the team's saved filters, as one row of chips. */
export function SavedViews({entity, presets, current, onApply}: {entity: EntityType; presets: {name: string; filters: Record<string, string>}[]; current: Record<string, string>; onApply: (f: Record<string, string>) => void}) {
  const {me, isAdmin} = useMe();
  const views = useQuery({queryKey: keys.views(entity), queryFn: () => api.get<{rows: SavedView[]}>('/views', {entity}), select: (d) => d.rows});
  const save = useApiMutation((v: {name: string; shared: boolean}) => api.post('/views', {entity, filters: current, ...v}), {invalidate: [keys.views(entity)], success: 'View saved'});
  const remove = useApiMutation((id: string) => api.del(`/views/${id}`), {invalidate: [keys.views(entity)]});

  const clean = (f: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(f).filter(([, v]) => v).sort()));
  const active = clean(current);
  const hasFilters = active !== '{}';
  const all = [...presets.map((p) => ({...p, id: `preset-${p.name}`, ownerId: null as string | null})), ...(views.data ?? [])];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {all.map((v) => {
        const on = clean(v.filters) === active;
        return (
          <span key={v.id} className="group relative inline-flex">
            <button
              onClick={() => onApply(v.filters)}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all',
                on ? 'border-transparent bg-brand text-white shadow-btn' : 'border-border bg-card text-slate-600 hover:border-slate-300 hover:text-slate-900',
              )}
            >
              {!v.id.startsWith('preset-') && <Bookmark className="size-3" />}
              {v.name}
            </button>
            {!v.id.startsWith('preset-') && (v.ownerId === me.id || isAdmin) && (
              <button aria-label={`Delete view ${v.name}`} onClick={() => remove.mutate(v.id)} className="absolute -top-1.5 -right-1.5 hidden size-5 cursor-pointer items-center justify-center rounded-full bg-card text-slate-400 shadow-soft group-hover:flex hover:text-destructive">
                <Trash2 className="size-3" />
              </button>
            )}
          </span>
        );
      })}
      {hasFilters && !all.some((v) => clean(v.filters) === active) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full text-xs"
          onClick={async () => {
            const name = await prompt({title: 'Name this view', label: 'View name', placeholder: 'e.g. My hot leads', confirmLabel: 'Continue'});
            if (name) save.mutate({name, shared: isAdmin && (await confirm({title: 'Share this view with the whole team?', confirmLabel: 'Share', cancelLabel: 'Just me'}))});
          }}
        >
          <BookmarkPlus /> Save view
        </Button>
      )}
    </div>
  );
}
