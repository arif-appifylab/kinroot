import {keepPreviousData, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Building2, CopyCheck, GitMerge, RefreshCw, RotateCcw, User, X} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {LoadError, Pagination} from '@/components/data-table';
import {useDuplicateCounts} from '@/components/duplicates';
import {FilterBar} from '@/components/filter-bar';
import {MergePairDialog} from '@/components/record-merge';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Switch} from '@/components/ui/form';
import {EmptyState, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, fullName} from '@/lib/format';
import {confidence, DUPLICATE_REASONS} from '@/lib/hygiene';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {DuplicateCompany, DuplicateContact, DuplicatePairRow} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/duplicates')({
  validateSearch: z.object({entity: z.enum(['contact', 'company']).optional(), status: z.enum(['open', 'dismissed']).optional(), low: z.boolean().optional()}),
  head: () => ({meta: [{title: pageTitle('Duplicates')}]}),
  component: Duplicates,
});

type Entity = 'contact' | 'company';
type Paged = {rows: DuplicatePairRow[]; total: number; page: number; pageSize: number};

const tone = (score: number): 'blue' | 'amber' | 'neutral' => (score >= 85 ? 'blue' : score >= 60 ? 'amber' : 'neutral');

/** Fields that explain the match get a soft highlight. */
const HIGHLIGHT: Record<string, string[]> = {
  email: ['email'],
  phone: ['phone'],
  name_company: ['name', 'company'],
  name_domain: ['name', 'email'],
  similar_name: ['name'],
  name: ['name'],
  domain: ['domain'],
  company_name: ['name'],
  similar_company_name: ['name'],
};

function Line({value, hit, muted}: {value: string | null | undefined; hit?: boolean; muted?: boolean}) {
  if (!value) return null;
  return <p className={cn('truncate', muted ? 'text-xs text-muted-foreground' : 'text-sm text-slate-700', hit && 'w-fit max-w-full rounded bg-amber-50 px-1 -mx-1 font-semibold text-amber-800')}>{value}</p>;
}

function ContactCard({r, hits}: {r: DuplicateContact; hits: Set<string>}) {
  const company = r.companies[0]?.company.name;
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-card p-3.5">
      <div className="flex items-center gap-2">
        <User className="size-4 shrink-0 text-slate-400" />
        <Link to="/contacts/$contactId" params={{contactId: r.id}} className={cn('truncate font-bold text-slate-900 hover:text-primary', hits.has('name') && 'rounded bg-amber-50 px-1 text-amber-800')}>{fullName(r)}</Link>
      </div>
      <div className="mt-1.5 grid gap-0.5 pl-6">
        <Line value={r.title} muted />
        <Line value={r.email} hit={hits.has('email')} />
        <Line value={r.phone} hit={hits.has('phone')} />
        <Line value={company} hit={hits.has('company')} />
        <p className="mt-1 text-xs text-muted-foreground">
          Created {ago(r.createdAt)}{r.owner ? ` · ${r.owner.name}` : ''} · {r._count.deals} deal{r._count.deals === 1 ? '' : 's'} · {r._count.notes} note{r._count.notes === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}

function CompanyCard({r, hits}: {r: DuplicateCompany; hits: Set<string>}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-card p-3.5">
      <div className="flex items-center gap-2">
        <Building2 className="size-4 shrink-0 text-slate-400" />
        <Link to="/companies/$companyId" params={{companyId: r.id}} className={cn('truncate font-bold text-slate-900 hover:text-primary', hits.has('name') && 'rounded bg-amber-50 px-1 text-amber-800')}>{r.name}</Link>
      </div>
      <div className="mt-1.5 grid gap-0.5 pl-6">
        <Line value={r.domain ?? r.website} hit={hits.has('domain')} />
        <Line value={r.phone} />
        <Line value={[r.city, r.country].filter(Boolean).join(', ')} muted />
        <p className="mt-1 text-xs text-muted-foreground">
          Created {ago(r.createdAt)}{r.owner ? ` · ${r.owner.name}` : ''} · {r._count.contacts} contact{r._count.contacts === 1 ? '' : 's'} · {r._count.deals} deal{r._count.deals === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}

function PairCard({pair, entity, onMerge}: {pair: DuplicatePairRow; entity: Entity; onMerge: () => void}) {
  const {canEdit} = useMe();
  const dismiss = useApiMutation(() => api.post(`/duplicates/${pair.id}/dismiss`), {invalidate: [keys.duplicates], success: 'Marked as not a duplicate'});
  const reopen = useApiMutation(() => api.post(`/duplicates/${pair.id}/reopen`), {invalidate: [keys.duplicates], success: 'Back in the queue'});
  const hits = new Set(pair.reasons.flatMap((r) => HIGHLIGHT[r] ?? []));
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3.5 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Badge tone={tone(pair.score)}>{confidence(pair.score)} confidence · {pair.score}%</Badge>
        {pair.reasons.map((r) => <Badge key={r} tone="outline">{DUPLICATE_REASONS[r] ?? r}</Badge>)}
        {pair.status === 'dismissed' && pair.dismissedAt && <span className="text-xs text-muted-foreground">Marked not a duplicate {ago(pair.dismissedAt)}</span>}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {entity === 'contact' ? (
          <>
            <ContactCard r={pair.a as DuplicateContact} hits={hits} />
            <ContactCard r={pair.b as DuplicateContact} hits={hits} />
          </>
        ) : (
          <>
            <CompanyCard r={pair.a as DuplicateCompany} hits={hits} />
            <CompanyCard r={pair.b as DuplicateCompany} hits={hits} />
          </>
        )}
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {pair.status === 'open' ? (
            <>
              <Button variant="secondary" size="sm" pending={dismiss.isPending} pendingLabel="Dismissing…" onClick={() => dismiss.mutate(undefined)}><X /> Not a duplicate</Button>
              <Button size="sm" disabled={dismiss.isPending} onClick={onMerge}><GitMerge /> Review &amp; merge</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" pending={reopen.isPending} pendingLabel="Reopening…" onClick={() => reopen.mutate(undefined)}><RotateCcw /> Reopen</Button>
          )}
        </div>
      )}
    </div>
  );
}

function Duplicates() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const {canEdit, isAdmin} = useMe();
  const entity: Entity = s.entity ?? 'contact';
  const status = s.status ?? 'open';
  const [page, setPage] = useState(1);
  const [merging, setMerging] = useState<DuplicatePairRow | null>(null);
  const counts = useDuplicateCounts();
  const params = {entity, status, page, low: s.low ? '1' : undefined};
  const list = useQuery({queryKey: [...keys.duplicates, 'list', params], queryFn: () => api.get<Paged>('/duplicates', params), placeholderData: keepPreviousData});
  // The scan runs as a background job: say so; the counts poll while it runs and the queue refreshes when it ends.
  const scan = useApiMutation(() => api.post<{queued: boolean; running?: boolean; message?: string}>('/duplicates/scan', {}), {
    invalidate: [keys.duplicates],
    onSuccess: (r) => (r.queued ? toast.success('Scanning in the background. New matches appear here in a minute.') : toast.info(r.message ?? 'A duplicate scan is already running.')),
  });
  const scanning = !!counts.data?.scanning;
  const queryClient = useQueryClient();
  const wasScanning = useRef(scanning);
  useEffect(() => {
    if (wasScanning.current && !scanning) void queryClient.invalidateQueries({queryKey: [...keys.duplicates, 'list']});
    wasScanning.current = scanning;
  }, [scanning, queryClient]);
  const set = (next: {entity?: Entity; status?: 'open' | 'dismissed'; low?: boolean}) => (setPage(1), navigate({search: (p) => ({...p, ...next})}));
  const last = counts.data?.lastScan[entity];
  const data = list.data;

  return (
    <SettingsSection
      title="Duplicates"
      description="Likely duplicate contacts and companies, matched on email (ignoring case, +tags and Gmail dots), phone, name with company or email domain, similar names and website domain. Merge them, or mark them as not duplicates so they are never suggested again."
      actions={
        // A full scan is an admin action (the server refuses others).
        isAdmin && (
          <Button variant="secondary" size="sm" pending={scan.isPending || scanning} pendingLabel={scanning ? 'Scan running…' : 'Starting…'} onClick={() => scan.mutate(undefined)}>
            <RefreshCw /> Scan now
          </Button>
        )
      }
    >
      <FilterBar className="mb-4">
        <Tabs value={entity} onValueChange={(v) => set({entity: v as Entity})}>
          <TabsList size="sm" aria-label="Record type">
            <TabsTrigger value="contact"><User /> Contacts {counts.data?.contact ? <span className="text-slate-400">{counts.data.contact}</span> : null}</TabsTrigger>
            <TabsTrigger value="company"><Building2 /> Companies {counts.data?.company ? <span className="text-slate-400">{counts.data.company}</span> : null}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={status} onValueChange={(v) => set({status: v as 'open' | 'dismissed'})}>
          <TabsList size="sm" aria-label="Status">
            <TabsTrigger value="open">To review</TabsTrigger>
            <TabsTrigger value="dismissed">Not duplicates</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground sm:ml-auto">{last ? `Scanned ${ago(last)}` : 'Not scanned yet'} · rescans every 6 hours</span>
      </FilterBar>

      {list.isError && !data && <LoadError error={list.error} onRetry={() => list.refetch()} />}
      {list.isLoading && <div className="grid gap-3">{Array.from({length: 3}, (_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>}
      {data && data.rows.length === 0 && (
        <EmptyState
          icon={<CopyCheck />}
          title={status === 'open' ? `No duplicate ${entity === 'contact' ? 'contacts' : 'companies'} to review` : 'Nothing dismissed yet'}
          description={status === 'open' ? 'New records are checked as they are created; a full scan runs every few hours.' : 'Pairs you mark as not duplicates show up here and can be reopened.'}
        />
      )}
      {status === 'open' && (s.low || !!counts.data?.lowConfidence[entity]) && (
        <label className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
          <Switch checked={!!s.low} onCheckedChange={(v) => set({low: v || undefined})} />
          Show low-confidence matches{counts.data?.lowConfidence[entity] ? ` (${counts.data.lowConfidence[entity]})` : ''}, like a shared phone number or the same name at another company
        </label>
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="grid gap-3">{data.rows.map((p) => <PairCard key={p.id} pair={p} entity={entity} onMerge={() => setMerging(p)} />)}</div>
          <div className="-mx-5 -mb-5 mt-4"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
        </>
      )}

      {merging && <MergePairDialog entity={entity} aId={merging.a.id} bId={merging.b.id} onClose={() => setMerging(null)} onMerged={() => setMerging(null)} />}
    </SettingsSection>
  );
}
