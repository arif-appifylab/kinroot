import {useQuery} from '@tanstack/react-query';
import {Check, ChevronDown} from 'lucide-react';
import {useMemo, useState} from 'react';

import {Input} from '@/components/ui/form';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/menu';
import {api} from '@/lib/api';
import {keys} from '@/lib/queries';
import type {CatalogueField, CatalogueObject} from '@/lib/reports';
import {cn} from '@/lib/utils';

export function useCatalogue() {
  return useQuery({
    queryKey: [...keys.reports, 'catalogue'],
    queryFn: () => api.get<{objects: CatalogueObject[]}>('/reports/catalogue'),
    select: (d) => d.objects,
    staleTime: 5 * 60_000,
  });
}

type Option = {value: string; label: string};

/** Choices for a field's filter: its own options, a ref lookup (users, stages, companies…) or tags in use. */
export function useFieldOptions(field: CatalogueField | undefined): {options: Option[]; loading: boolean} {
  const ref = field?.kind === 'ref' ? field.ref : undefined;
  const refs = useQuery({
    queryKey: [...keys.reports, 'refs', ref],
    queryFn: () => api.get<{rows: {id: string; label: string}[]}>(`/reports/refs/${ref}`),
    enabled: !!ref,
    staleTime: 60_000,
  });
  const needTags = field?.kind === 'tags' && !field.options;
  const tags = useQuery({queryKey: [...keys.tags, 'all'], queryFn: () => api.get<{rows: {tag: string}[]}>('/tags'), enabled: needTags, staleTime: 60_000});
  return useMemo(() => {
    if (!field) return {options: [], loading: false};
    if (field.options) return {options: field.options, loading: false};
    if (ref) return {options: refs.data?.rows.map((r) => ({value: r.id, label: r.label})) ?? [], loading: refs.isLoading};
    if (needTags) return {options: tags.data?.rows.map((r) => ({value: r.tag, label: r.tag})) ?? [], loading: tags.isLoading};
    return {options: [], loading: false};
  }, [field, ref, refs.data, refs.isLoading, needTags, tags.data, tags.isLoading]);
}

/** Multi-select over a list of options, searchable once it gets long. */
export function OptionPicker({options, value, onChange, placeholder = 'Any value', disabled}: {options: Option[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean}) {
  const [q, setQ] = useState('');
  const labels = new Map(options.map((o) => [o.value, o.label]));
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs transition-colors outline-none hover:border-slate-300 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn('min-w-0 flex-1 truncate', !value.length && 'text-slate-400')}>{value.length ? value.map((v) => labels.get(v) ?? v).join(', ') : placeholder}</span>
          <ChevronDown className="size-4 shrink-0 text-slate-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        {options.length > 8 && (
          <div className="border-b border-slate-100 p-2">
            <Input autoFocus className="h-8" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
        <ul className="max-h-64 overflow-y-auto p-1 scrollbar-thin" role="listbox" aria-multiselectable>
          {shown.map((o) => {
            const on = value.includes(o.value);
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-accent"
                >
                  <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-[5px] border', on ? 'border-primary bg-brand text-white' : 'border-slate-300')}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                  <span className="truncate">{o.label}</span>
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="px-2.5 py-3 text-center text-xs text-muted-foreground">Nothing to pick</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
