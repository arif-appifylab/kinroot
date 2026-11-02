import {useInfiniteQuery} from '@tanstack/react-query';
import {format, isToday, isYesterday} from 'date-fns';
import {ArchiveRestore, ArrowRight, FileInput, GitMerge, Globe, History, KeyRound, Loader2, Plus, Settings2, Upload, Webhook, Workflow} from 'lucide-react';
import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';

import {api} from '@/lib/api';
import {ago, dateTime} from '@/lib/format';
import type {HistoryActor, HistoryEntity, HistoryEntry, HistoryPage} from '@/lib/history';
import {keys} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {SearchInput} from './data-table';
import {FilterBar} from './filter-bar';
import {Button} from './ui/button';
import {DropdownMenuItem, Tooltip} from './ui/menu';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from './ui/dialog';
import {NativeSelect} from './ui/form';
import {Avatar, EmptyState} from './ui/misc';

/**
 * Property history drawer (HubSpot style): every change to one record, newest
 * first, from `GET /site-api/crm/history`. Record pages wrap themselves in
 * `<PropertyHistoryProvider entity id name>`; property rows (`field` prop in
 * properties.tsx) and the timeline's "Property history" button open it with
 * `usePropertyHistory()?.open(field?)`.
 */
type Ctx = {open: (field?: string) => void};
const PropertyHistoryContext = createContext<Ctx | null>(null);

export const usePropertyHistory = () => useContext(PropertyHistoryContext);

export function PropertyHistoryProvider({entity, id, name, children}: {entity: HistoryEntity; id: string; name: string; children: ReactNode}) {
  const [state, setState] = useState<{field: string} | null>(null);
  const open = useCallback((field?: string) => setState({field: field ?? ''}), []);
  const value = useMemo(() => ({open}), [open]);
  return (
    <PropertyHistoryContext.Provider value={value}>
      {children}
      {state && <PropertyHistoryDrawer entity={entity} id={id} name={name} initialField={state.field} onClose={() => setState(null)} />}
    </PropertyHistoryContext.Provider>
  );
}

/** "Property history" button for a card header or toolbar; renders nothing outside a provider. */
export function PropertyHistoryButton({className, compact, labelClassName}: {className?: string; compact?: boolean; labelClassName?: string}) {
  const history = usePropertyHistory();
  if (!history) return null;
  return (
    <Button variant="secondary" size="sm" className={cn('shrink-0', className)} onClick={() => history.open()} aria-label="Property history">
      <History /> <span className={cn(compact && 'sr-only', labelClassName)}>Property history</span>
    </Button>
  );
}

/** "View property history" for a record's Actions menu. */
export function PropertyHistoryMenuItem() {
  const history = usePropertyHistory();
  if (!history) return null;
  return <DropdownMenuItem onSelect={() => history.open()}><History /> View property history</DropdownMenuItem>;
}

const ACTOR_ICONS: Partial<Record<HistoryActor['kind'], typeof Workflow>> = {automation: Workflow, import: Upload, form: FileInput, webhook: Webhook, api: KeyRound, merge: GitMerge, customer: Globe, system: Settings2};

function ActorLabel({actor}: {actor: HistoryActor}) {
  const Icon = ACTOR_ICONS[actor.kind];
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      {actor.kind === 'user' ? <Avatar name={actor.name} color={actor.color} src={actor.avatarUrl} size="xs" className="ring-0" /> : Icon && <Icon className="size-3.5 shrink-0 text-indigo-500" />}
      <span className="truncate font-semibold text-slate-700">{actor.name}</span>
      {actor.by && actor.by !== actor.name && <span className="truncate">· by {actor.by}</span>}
    </span>
  );
}

const Empty = () => <span className="text-slate-400 italic">empty</span>;

/** A value that may be long (descriptions, URLs): wraps anywhere, clamps to a few lines, full text on hover. */
function Value({text, className}: {text: string | null; className?: string}) {
  if (text === null) return <Empty />;
  return <span title={text.length > 80 ? text : undefined} className={cn('line-clamp-4 min-w-0 [overflow-wrap:anywhere] whitespace-pre-line', className)}>{text}</span>;
}

/**
 * One change. Stacked in a narrow drawer; from @3xl (wide drawer) a three-column
 * row: property · old → new · who and when. Every column is minmax(0, …), so
 * nothing can push the drawer sideways.
 */
function EntryRow({entry, field}: {entry: HistoryEntry; field: string}) {
  const event = entry.kind !== 'change';
  const EventIcon = entry.kind === 'created' ? Plus : entry.kind === 'merged' ? GitMerge : ArchiveRestore;
  // In a one-property view the creation row carries the value the property started with.
  const initial = entry.kind === 'created' && !!field;
  const label = initial ? 'Set when created' : entry.label;
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-slate-100 bg-card px-3.5 py-3 shadow-soft">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', event ? 'bg-teal-50 text-teal-600' : 'bg-blue-50 text-blue-600')}>
        {event ? <EventIcon className="size-3.5" /> : <ArrowRight className="size-3.5" />}
      </span>
      <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-1 @3xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,15rem)] @3xl:items-start">
        <p className="truncate pt-0.5 text-sm font-semibold text-slate-900" title={label}>{label}</p>
        <div className="grid min-w-0 gap-0.5 text-sm">
          {entry.kind === 'change' && (
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-slate-600">
              <Value text={entry.from} className="text-slate-500 line-through decoration-slate-300" />
              <span aria-label="changed to" className="text-slate-400">→</span>
              <Value text={entry.to} className="font-medium text-slate-900" />
            </p>
          )}
          {initial && <p className="min-w-0 font-medium text-slate-900"><Value text={entry.to} /></p>}
          {entry.note && <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{entry.note}</p>}
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-0.5 text-xs text-muted-foreground @3xl:justify-end">
          <ActorLabel actor={entry.actor} /> ·
          <Tooltip content={dateTime(entry.at)}>
            <time dateTime={entry.at} tabIndex={0} className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{ago(entry.at)}</time>
          </Tooltip>
        </p>
      </div>
    </li>
  );
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  return isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEEE, MMM d, yyyy');
};

export function PropertyHistoryDrawer({entity, id, name, initialField = '', onClose}: {entity: HistoryEntity; id: string; name: string; initialField?: string; onClose: () => void}) {
  const [field, setField] = useState(initialField);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const feed = useInfiniteQuery({
    queryKey: [...keys.timeline, 'history', entity, id, field, search],
    queryFn: ({pageParam}) => api.get<HistoryPage>('/history', {entity, id, field: field || undefined, q: search || undefined, cursor: pageParam}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = feed.data?.pages.flatMap((p) => p.rows) ?? [];
  const first = feed.data?.pages[0];
  // The filter keeps the chosen property even when it has no changes yet (opened from its row).
  const options = first?.fields ?? [];
  const chosenLabel = field ? (first?.fieldLabel ?? options.find((f) => f.field === field)?.label) : undefined;

  const days: {label: string; rows: HistoryEntry[]}[] = [];
  for (const r of rows) {
    const label = dayLabel(r.at);
    if (days.at(-1)?.label === label) days.at(-1)!.rows.push(r);
    else days.push({label, rows: [r]});
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Property history</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{field && chosenLabel ? `${chosenLabel} of ${name}` : `Every change to ${name}`}, newest first.</DialogDescription>
        </DialogHeader>
        <FilterBar className="shrink-0 border-b border-slate-100 px-6 py-3">
          <SearchInput size="sm" value={q} onChange={setQ} placeholder="Search values or people" />
          <NativeSelect size="sm" aria-label="Property" value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">All properties</option>
            {field && !options.some((f) => f.field === field) && <option value={field}>{chosenLabel ?? field} (0)</option>}
            {options.map((f) => <option key={f.field} value={f.field}>{f.label} ({f.count})</option>)}
          </NativeSelect>
        </FilterBar>
        <DialogBody className="grid-cols-1 overflow-x-hidden">
          {feed.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-primary" /></div>
          ) : feed.error ? (
            <p className="text-sm text-destructive">{(feed.error as Error).message}</p>
          ) : rows.length === 0 ? (
            <EmptyState icon={<History />} title={search ? 'No matching changes' : 'No changes yet'} description={search ? 'Try a different search.' : 'Edits to this property will show up here.'} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground" aria-live="polite">{first?.total ?? rows.length} {(first?.total ?? rows.length) === 1 ? 'entry' : 'entries'}</p>
              {days.map((d) => (
                <section key={d.label} aria-label={d.label} className="min-w-0">
                  <h3 className="mb-2 text-xs font-bold tracking-wider text-slate-400 uppercase">{d.label}</h3>
                  <ol className="grid min-w-0 grid-cols-1 gap-2">
                    {d.rows.map((r) => <EntryRow key={r.id} entry={r} field={field} />)}
                  </ol>
                </section>
              ))}
              {feed.hasNextPage && (
                <div className="flex justify-center">
                  <Button variant="secondary" size="sm" onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
                    {feed.isFetchingNextPage && <Loader2 className="animate-spin" />} Load older changes
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
