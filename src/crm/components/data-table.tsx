import {ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X} from 'lucide-react';
import type {ReactNode} from 'react';

import {cn} from '@/lib/utils';

import {Button} from './ui/button';
import {Checkbox, Input} from './ui/form';
import {Skeleton} from './ui/misc';

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
};

const hide = {sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell'};

export function DataTable<T extends {id: string}>({
  rows,
  columns,
  loading,
  sort,
  dir,
  onSort,
  selected,
  onSelect,
  onRowClick,
  empty,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  loading?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
}) {
  const allSelected = !!rows?.length && rows.every((r) => selected?.has(r.id));
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            {onSelect && (
              <th className="w-10 py-3 pl-4">
                <Checkbox aria-label="Select all" checked={allSelected} onCheckedChange={(v) => onSelect(v ? new Set(rows?.map((r) => r.id)) : new Set())} />
              </th>
            )}
            {columns.map((col) => (
              <th key={col.key} className={cn('px-4 py-3 text-xs font-bold tracking-wide whitespace-nowrap text-slate-500 uppercase', col.hideBelow && hide[col.hideBelow], col.className)}>
                {col.sortable && onSort ? (
                  <button className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-slate-900" onClick={() => onSort(col.key)}>
                    {col.header}
                    {sort === col.key && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({length: 6}).map((_, i) => (
              <tr key={i} className="border-b border-slate-50">
                <td colSpan={columns.length + 1} className="px-4 py-3"><Skeleton className="h-6" /></td>
              </tr>
            ))}
          {!loading &&
            rows?.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row)}
                className={cn('border-b border-slate-50 transition-colors last:border-0', onRowClick && 'cursor-pointer hover:bg-accent/40', selected?.has(row.id) && 'bg-accent/50')}
              >
                {onSelect && (
                  <td className="w-10 py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label="Select row"
                      checked={selected?.has(row.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected);
                        v ? next.add(row.id) : next.delete(row.id);
                        onSelect(next);
                      }}
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-4 py-3 text-slate-700', col.hideBelow && hide[col.hideBelow], col.className)}>{col.cell(row)}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && rows?.length === 0 && empty}
    </div>
  );
}

export function Pagination({page, pageSize, total, onPage}: {page: number; pageSize: number; total: number; onPage: (p: number) => void}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="px-4 py-3 text-xs text-muted-foreground">{total} record{total === 1 ? '' : 's'}</p>;
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </p>
      <div className="flex gap-1">
        <Button variant="secondary" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <Button variant="secondary" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
      </div>
    </div>
  );
}

/** Search box for list pages. `size="sm"` is the compact one used in a `FilterBar`. */
export function SearchInput({value, onChange, placeholder, size = 'default', className}: {value: string; onChange: (v: string) => void; placeholder: string; size?: 'default' | 'sm'; className?: string}) {
  const sm = size === 'sm';
  return (
    <div className={cn('relative w-full', sm ? 'sm:w-64' : 'sm:w-72', className)}>
      <Search className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-slate-400', sm ? 'left-2.5 size-3.5' : 'left-3 size-4')} />
      <Input
        size={sm ? 'sm' : 'default'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(sm ? 'pr-7 pl-8' : 'h-9 pl-9')}
        aria-label={placeholder}
      />
      {value && (
        <button type="button" className={cn('absolute top-1/2 -translate-y-1/2 cursor-pointer rounded text-slate-400 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none', sm ? 'right-1.5 p-0.5' : 'right-2 p-1')} onClick={() => onChange('')} aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Floating bar shown while rows are selected. */
export function BulkBar({count, onClear, children}: {count: number; onClear: () => void; children: ReactNode}) {
  if (!count) return null;
  return (
    <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="flex items-center gap-2 rounded-2xl bg-sidebar px-3 py-2 text-white ring-1 ring-white/10 shadow-lift animate-in slide-in-from-bottom-4 fade-in-0">
        <span className="px-2 text-sm font-semibold">{count} selected</span>
        {children}
        <button className="cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" onClick={onClear} aria-label="Clear selection"><X className="size-4" /></button>
      </div>
    </div>
  );
}
