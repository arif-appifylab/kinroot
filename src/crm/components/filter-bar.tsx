import {X} from 'lucide-react';
import type {ReactNode} from 'react';

import {cn} from '@/lib/utils';

import {Button} from './ui/button';
import {Input} from './ui/form';

/**
 * One compact row of list filters: the search first (`<SearchInput size="sm">`), then compact
 * controls (`<NativeSelect size="sm">`, `<FilterDateRange>`), wrapping on narrow screens.
 * "Clear filters" shows only while `active`.
 */
export function FilterBar({children, active, onClear, className, label = 'Filters'}: {children: ReactNode; active?: boolean; onClear?: () => void; className?: string; label?: string}) {
  return (
    <div role="group" aria-label={label} className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}>
      {children}
      {active && onClear && (
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs text-slate-500 [&_svg]:size-3.5" onClick={onClear}>
          <X /> Clear filters
        </Button>
      )}
    </div>
  );
}

/** "From … To …" as two compact date inputs, for a `FilterBar`. Empty means open-ended. */
export function FilterDateRange({from, to, onChange}: {from?: string; to?: string; onChange: (range: {from?: string; to?: string}) => void}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
      <label className="flex items-center gap-1.5">
        From
        <Input size="sm" type="date" className="w-auto" value={from ?? ''} max={to} onChange={(e) => onChange({from: e.target.value || undefined, to})} />
      </label>
      <label className="flex items-center gap-1.5">
        To
        <Input size="sm" type="date" className="w-auto" value={to ?? ''} min={from} onChange={(e) => onChange({from, to: e.target.value || undefined})} />
      </label>
    </div>
  );
}
