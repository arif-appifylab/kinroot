import {useQuery} from '@tanstack/react-query';
import {GitMerge} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {api} from '@/lib/api';
import {shortDate} from '@/lib/format';
import {recordKeys, useApiMutation} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Field} from './ui/form';

export type MergeRow = {field: string; label: string; show?: (v: unknown) => string};
type Rec = {id: string; createdAt: string} & Record<string, unknown>;

/**
 * HubSpot-style merge, shared by contacts and companies: pick the duplicate,
 * choose the record to keep, choose per property, preview, then merge.
 */
export function MergeDialog<T extends Rec>({
  noun,
  current,
  rows,
  title,
  subtitle,
  picker,
  load,
  mergeUrl,
  notes,
  onClose,
  onMerged,
  initialOtherId,
}: {
  noun: string;
  current: T;
  rows: MergeRow[];
  title: (r: T) => string;
  subtitle: (r: T) => string;
  picker: (otherId: string | null, set: (id: string | null) => void) => ReactNode;
  load: (id: string) => Promise<T>;
  mergeUrl: string;
  notes: string[];
  onClose: () => void;
  onMerged: (keptId: string) => void;
  /** Preselects the duplicate (the duplicate queue opens the dialog for a known pair). */
  initialOtherId?: string;
}) {
  const [otherId, setOtherId] = useState<string | null>(initialOtherId ?? null);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [choices, setChoices] = useState<Record<string, 'this' | 'other'>>({});
  const other = useQuery({queryKey: ['merge', noun, otherId], queryFn: () => load(otherId!), enabled: !!otherId && otherId !== current.id});
  const merge = useApiMutation(() => api.post<{keptId: string}>(mergeUrl, {otherId, keep, fields: choices}), {
    invalidate: recordKeys,
    success: `${noun[0]!.toUpperCase()}${noun.slice(1)}s merged`,
    onSuccess: (r) => (onClose(), onMerged(r.keptId)),
  });

  const o = other.data;
  const fmt = (row: MergeRow, v: unknown) => (v === null || v === undefined || v === '' ? '—' : row.show ? row.show(v) : String(v));
  const differing = o ? rows.filter((r) => fmt(r, current[r.field]) !== fmt(r, o[r.field])) : [];
  const resolved = (row: MergeRow) => {
    if (!o) return current[row.field];
    const choice = choices[row.field];
    if (choice) return (choice === 'this' ? current : o)[row.field];
    const [first, second] = keep === 'this' ? [current, o] : [o, current];
    return first[row.field] ?? second[row.field];
  };
  const survivor = keep === 'this' || !o ? current : o;

  const RecordCard = ({rec, side}: {rec: T; side: 'this' | 'other'}) => (
    <label className={cn('flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-all', keep === side ? 'border-primary bg-accent/50 ring-2 ring-primary/15' : 'border-border hover:border-slate-300')}>
      <input type="radio" name="keep" className="mt-1 accent-[var(--primary)]" checked={keep === side} onChange={() => setKeep(side)} />
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-slate-900">{title(rec)}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle(rec)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Created {shortDate(rec.createdAt)}</p>
        {keep === side && <Badge tone="blue" className="mt-1.5">Primary: kept</Badge>}
      </div>
    </label>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !merge.isPending && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Merge duplicate {noun}s</DialogTitle>
          <DialogDescription>Choose the duplicate, the record to keep, and which values win.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid content-start gap-4">
              <Field label={`${noun[0]!.toUpperCase()}${noun.slice(1)} to merge in`}>{picker(otherId, (id) => (setOtherId(id === current.id ? null : id), setChoices({})))}</Field>
              {other.isError && <p role="alert" className="text-sm text-destructive">That {noun} could not be loaded. {other.error.message}</p>}
              {o && (
                <>
                  <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
                    <RecordCard rec={current} side="this" />
                    <RecordCard rec={o} side="other" />
                  </div>
                  {differing.length > 0 ? (
                    <div className="overflow-hidden rounded-xl border border-slate-100">
                      <p className="bg-slate-50 px-3 py-2 text-xs font-bold tracking-wide text-slate-500 uppercase">Properties that differ</p>
                      {differing.map((row) => (
                        <div key={row.field} className="grid grid-cols-[110px_1fr_1fr] items-center gap-2 border-t border-slate-100 px-3 py-2 text-sm">
                          <span className="text-xs font-semibold text-muted-foreground">{row.label}</span>
                          {(['this', 'other'] as const).map((side) => {
                            const v = (side === 'this' ? current : o)[row.field];
                            const active = (choices[row.field] ?? (fmt(row, resolved(row)) === fmt(row, v) ? side : null)) === side;
                            return (
                              <label key={side} className={cn('flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1', active && 'bg-accent text-accent-foreground')}>
                                <input type="radio" name={`f-${row.field}`} className="accent-[var(--primary)]" checked={active} onChange={() => setChoices({...choices, [row.field]: side})} />
                                <span className="truncate">{fmt(row, v)}</span>
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No conflicting properties. Everything combines cleanly.</p>
                  )}
                </>
              )}
            </div>
            <div className="grid content-start gap-3">
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4">
                <p className="text-xs font-bold tracking-wide text-slate-500 uppercase">Merged record preview</p>
                <p className="mt-2 text-base font-bold text-slate-900">{title({...survivor, ...Object.fromEntries(rows.map((r) => [r.field, resolved(r)]))} as T)}</p>
                <dl className="mt-2 grid gap-1 text-xs">
                  {rows.map((row) => {
                    const v = resolved(row);
                    return v !== null && v !== undefined && v !== '' ? (
                      <div key={row.field} className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">{row.label}</dt><dd className="truncate text-slate-700">{fmt(row, v)}</dd></div>
                    ) : null;
                  })}
                </dl>
              </div>
              <p className="text-xs font-bold text-slate-700">What happens when I merge?</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {notes.map((n) => <li key={n}>{n}</li>)}
                <li className="font-semibold text-slate-700">The other record is deleted. This can’t be undone.</li>
              </ul>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={merge.isPending}>Cancel</Button>
          <Button variant="destructive" disabled={!o} pending={merge.isPending} pendingLabel="Merging…" onClick={() => merge.mutate(undefined)}><GitMerge /> Merge</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
