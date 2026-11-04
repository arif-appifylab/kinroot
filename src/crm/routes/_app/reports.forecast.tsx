import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {CalendarClock, Download, TrendingUp} from 'lucide-react';
import {useState} from 'react';

import {ORDINAL, ReportChart} from '@/components/charts';
import {viewerTz} from '@/components/reports/report-view';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {Avatar, EmptyState, PageHeader, Skeleton} from '@/components/ui/misc';
import {LoadError} from '@/components/data-table';
import {api, qs} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {money, shortDate} from '@/lib/format';
import {keys, useApiMutation, useMe, usePipelines, useSettings, useTeam} from '@/lib/queries';
import {FORECAST_CATEGORIES, type ForecastCategory, type ReportResult} from '@/lib/reports';
import type {ForecastData, ForecastDeal} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/reports/forecast')({
  head: () => ({meta: [{title: pageTitle('Forecast')}]}),
  component: ForecastPage,
});

// Ordered categories take the one-hue ordinal ramp, lightest = least certain.
const CATS: ForecastCategory[] = ['CLOSED_WON', 'COMMIT', 'BEST_CASE', 'PIPELINE'];
const COLORS: Record<ForecastCategory, string> = {PIPELINE: ORDINAL[0]!, BEST_CASE: ORDINAL[1]!, COMMIT: ORDINAL[2]!, CLOSED_WON: ORDINAL[3]!};

function ForecastPage() {
  const {me, canEdit} = useMe();
  const team = useTeam();
  const pipelines = usePipelines();
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  const [filters, setFilters] = useState({pipelineId: '', ownerId: '', months: '3'});
  const params = {...filters, tz: viewerTz()};
  const query = useQuery({queryKey: [...keys.forecast, params], queryFn: () => api.get<ForecastData>('/reports/forecast', params), placeholderData: (p) => p});
  const f = query.data;
  const m = (v: number) => money(v, currency, true);

  // Same shape as a report result, so the stacked bar chart and its tooltip are shared.
  const chart: ReportResult | null = f
    ? {
        measureLabel: 'Deal value',
        format: 'currency',
        additive: true,
        bucket: 'month',
        series: CATS.map((k) => ({key: k, label: FORECAST_CATEGORIES[k]})),
        rows: f.rows.map((r) => ({key: r.key, label: r.label, values: Object.fromEntries(CATS.map((k) => [k, r[k]])), total: CATS.reduce((a, k) => a + r[k], 0), count: r.count})),
        total: {value: CATS.reduce((a, k) => a + f.totals[k], 0), count: f.totals.count},
        range: {from: f.range.from, to: f.range.to, label: ''},
        truncated: false,
        noun: ['deal', 'deals'],
      }
    : null;

  return (
    <div>
      <PageHeader
        title="Forecast"
        description="Open deals by expected close month and forecast category, plus what's already won. Weighted uses each stage's probability."
        actions={
          <>
            {(pipelines.data?.length ?? 0) > 1 && (
              <NativeSelect size="sm" aria-label="Pipeline" value={filters.pipelineId} onChange={(e) => setFilters({...filters, pipelineId: e.target.value})}>
                <option value="">All pipelines</option>
                {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            )}
            <NativeSelect size="sm" aria-label="Owner" value={filters.ownerId} onChange={(e) => setFilters({...filters, ownerId: e.target.value})}>
              <option value="">Everyone</option>
              {team.data?.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Just me' : u.name}</option>)}
            </NativeSelect>
            <NativeSelect size="sm" aria-label="Months" value={filters.months} onChange={(e) => setFilters({...filters, months: e.target.value})}>
              <option value="1">This month</option>
              <option value="3">Next 3 months</option>
              <option value="6">Next 6 months</option>
              <option value="12">Next 12 months</option>
            </NativeSelect>
            <Button variant="secondary" size="sm" asChild>
              <a href={`/site-api/crm/reports/forecast.csv${qs(params)}`} download><Download /> CSV</a>
            </Button>
          </>
        }
      />

      {query.isError && !f ? (
        <Card>
          <LoadError error={query.error} onRetry={() => query.refetch()} />
        </Card>
      ) : !f || !chart ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <div className={cn('grid grid-cols-1 gap-6 transition-opacity', query.isFetching && 'opacity-60')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Closed won" value={m(f.totals.CLOSED_WON)} sub="Won in the period so far" />
            <Tile label="Commit forecast" value={m(f.totals.CLOSED_WON + f.totals.COMMIT)} sub="Closed won + commit" />
            <Tile label="Best case" value={m(f.totals.CLOSED_WON + f.totals.COMMIT + f.totals.BEST_CASE)} sub="Commit forecast + best case" />
            <Tile label="Weighted forecast" value={m(f.totals.weighted)} sub="Closed won + open value × stage probability" />
          </div>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>By close month</CardTitle>
                <CardDescription>Stacked by forecast category, most certain at the bottom</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {chart.total.count ? <ReportChart result={chart} chart="stacked" currency={currency} colors={COLORS} height={280} /> : <EmptyState className="py-10" icon={<TrendingUp />} title="Nothing in this window" description="Add expected close dates to open deals to forecast them." />}
              <div className="mt-5 overflow-x-auto rounded-lg border border-slate-100">
                <table className="w-full min-w-[640px] text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      <th className="px-3 py-2.5">Month</th>
                      {CATS.map((k) => (
                        <th key={k} className="px-3 py-2.5 text-right whitespace-nowrap">
                          <span className="mr-1.5 inline-block size-2 rounded-[2px] align-middle" style={{background: COLORS[k]}} />
                          {FORECAST_CATEGORIES[k]}
                        </th>
                      ))}
                      <th className="px-3 py-2.5 text-right">Weighted</th>
                      <th className="px-3 py-2.5 text-right">Deals</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {[...f.rows, f.totals].map((r) => (
                      <tr key={r.key} className={cn(r.key === 'total' && 'border-t border-slate-200 font-semibold text-slate-900')}>
                        <td className="px-3 py-2 font-medium text-slate-800">{r.label}</td>
                        {CATS.map((k) => <td key={k} className="px-3 py-2 text-right text-slate-700">{money(r[k], currency)}</td>)}
                        <td className="px-3 py-2 text-right font-semibold text-slate-900">{money(r.weighted, currency)}</td>
                        <td className="px-3 py-2 text-right text-slate-500">{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {f.noCloseDate.count > 0 && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock className="size-3.5" /> {f.noCloseDate.count} open deal{f.noCloseDate.count === 1 ? '' : 's'} ({money(f.noCloseDate.value, currency, true)}) have no expected close date and are left out.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Open deals in the forecast</CardTitle>
                <CardDescription>The category follows the stage probability (80%+ commit, 50%+ best case) unless someone sets it on the deal.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {f.deals.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-y border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                        <th className="px-5 py-2.5">Deal</th>
                        <th className="px-3 py-2.5">Close date</th>
                        <th className="px-3 py-2.5">Stage</th>
                        <th className="px-3 py-2.5">Owner</th>
                        <th className="px-3 py-2.5 text-right">Value</th>
                        <th className="px-3 py-2.5 text-right">Weighted</th>
                        <th className="px-5 py-2.5">Category</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {f.deals.map((d) => <DealRow key={d.id} deal={d} canEdit={canEdit} />)}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState className="py-10" icon={<TrendingUp />} title="No open deals closing in this window" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Tile({label, value, sub}: {label: string; value: string; sub: string}) {
  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </Card>
  );
}

function DealRow({deal, canEdit}: {deal: ForecastDeal; canEdit: boolean}) {
  const set = useApiMutation((category: string | null) => api.post(`/reports/forecast/deals/${deal.id}`, {category}), {invalidate: [keys.forecast, keys.timeline], success: 'Forecast category updated'});
  const overdue = new Date(deal.expectedCloseDate).getTime() < Date.now();
  return (
    <tr className="hover:bg-slate-50/60">
      <td className="px-5 py-2.5">
        <Link to="/deals/$dealId" params={{dealId: deal.id}} className="font-semibold text-slate-900 hover:text-primary">{deal.title}</Link>
        {deal.company && <p className="text-xs text-muted-foreground">{deal.company.name}</p>}
      </td>
      <td className={cn('px-3 py-2.5 whitespace-nowrap', overdue ? 'font-semibold text-rose-700' : 'text-slate-600')}>{shortDate(deal.expectedCloseDate)}</td>
      <td className="px-3 py-2.5 text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{background: deal.stage.color}} /> {deal.stage.name} <span className="text-slate-400">{deal.stage.probability}%</span>
        </span>
      </td>
      <td className="px-3 py-2.5">{deal.owner && <span className="inline-flex items-center gap-2 text-slate-600"><Avatar name={deal.owner.name} color={deal.owner.color} src={deal.owner.avatarUrl} size="xs" /> {deal.owner.name}</span>}</td>
      <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums">{money(deal.value, deal.currency)}</td>
      <td className="px-3 py-2.5 text-right text-slate-600 tabular-nums">{money(deal.weighted, deal.currency)}</td>
      <td className="px-5 py-2.5">
        <NativeSelect aria-label={`Forecast category for ${deal.title}`} className="h-8 w-44 text-[13px]" disabled={!canEdit || set.isPending} value={deal.override ?? ''} onChange={(e) => set.mutate(e.target.value || null)}>
          <option value="">Auto: {FORECAST_CATEGORIES[deal.auto]}</option>
          <option value="PIPELINE">Pipeline</option>
          <option value="BEST_CASE">Best case</option>
          <option value="COMMIT">Commit</option>
          <option value="OMIT">Omit from forecast</option>
        </NativeSelect>
      </td>
    </tr>
  );
}
