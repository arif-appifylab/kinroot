import {useQuery} from '@tanstack/react-query';
import {ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Table2} from 'lucide-react';
import {useState} from 'react';

import {formatValue, ReportChart, seriesColor} from '@/components/charts';
import {Button} from '@/components/ui/button';
import {EmptyState, Skeleton} from '@/components/ui/misc';
import {Tooltip} from '@/components/ui/menu';
import {api} from '@/lib/api';
import {shortDate} from '@/lib/format';
import {keys} from '@/lib/queries';
import type {ChartType, ReportConfig, ReportOverrides, ReportResult} from '@/lib/reports';
import {cn} from '@/lib/utils';

export const viewerTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

/** Query params shared by every report run / export. */
export function runParams(overrides?: ReportOverrides) {
  return {
    tz: viewerTz(),
    range: overrides?.range?.preset,
    from: overrides?.range?.preset === 'custom' ? overrides.range.from : undefined,
    to: overrides?.range?.preset === 'custom' ? overrides.range.to : undefined,
    ownerId: overrides?.ownerId,
  };
}

/** Runs an unsaved definition (builder preview). */
export function useReportPreview(config: ReportConfig | null) {
  return useQuery({
    queryKey: [...keys.reports, 'preview', config],
    queryFn: () => api.get<ReportResult>('/reports/run', {config: JSON.stringify(config), ...runParams()}),
    enabled: !!config,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** Big number + change against the previous period of the same length. */
export function KpiTile({result, currency, size = 'lg'}: {result: ReportResult; currency: string; size?: 'sm' | 'lg'}) {
  const {value} = result.total;
  const prev = result.previous;
  const delta = prev ? value - prev.value : null;
  const pct = prev && prev.value ? delta! / Math.abs(prev.value) : null;
  const Icon = delta === null || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="flex h-full flex-col justify-center py-2">
      <p className="text-sm font-medium text-muted-foreground">{result.measureLabel}</p>
      <p className={cn('mt-1 font-extrabold leading-none tracking-tight text-slate-900', size === 'lg' ? 'text-5xl' : 'text-4xl')}>{formatValue(value, result.format, currency, value >= 100_000)}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {result.range.label}
        {result.measureLabel.startsWith('Number of') ? '' : ` · ${result.total.count} ${result.noun[result.total.count === 1 ? 0 : 1]}`}
      </p>
      {prev && (
        <p className="mt-3 inline-flex flex-wrap items-center gap-1.5 text-sm text-slate-700">
          <Icon className="size-4 text-slate-500" aria-hidden />
          <span className="font-semibold">
            {delta! > 0 ? '+' : ''}
            {formatValue(delta!, result.format, currency, true)}
            {pct !== null && ` (${pct > 0 ? '+' : ''}${Math.round(pct * 100)}%)`}
          </span>
          <span className="text-muted-foreground">
            vs {formatValue(prev.value, result.format, currency, true)} ({shortDate(prev.from)} – {shortDate(new Date(new Date(prev.to).getTime() - 1).toISOString())})
          </span>
        </p>
      )}
    </div>
  );
}

/** The table view every chart has (and the report itself when the chart is "table"). */
export function ReportTable({result, currency, maxHeight}: {result: ReportResult; currency: string; maxHeight?: number}) {
  const multi = result.series.length > 1 || result.series[0]?.key !== 'value';
  const {additive} = result;
  const fmt = (v: number) => formatValue(v, result.format, currency);
  return (
    <div className="overflow-auto rounded-lg border border-slate-100 scrollbar-thin" style={maxHeight ? {maxHeight} : undefined}>
      <table className="w-full min-w-[360px] text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <th className="px-3 py-2.5">{result.groupLabel ?? 'Total'}</th>
            {result.series.map((s, i) => (
              <th key={s.key} className="px-3 py-2.5 text-right whitespace-nowrap">
                {multi && <span className="mr-1.5 inline-block size-2 rounded-[2px] align-middle" style={{background: seriesColor(s.key, i)}} />}
                {multi ? s.label : result.measureLabel}
              </th>
            ))}
            {multi && <th className="px-3 py-2.5 text-right">{additive ? 'Total' : 'Overall'}</th>}
            <th className="px-3 py-2.5 text-right whitespace-nowrap capitalize">{result.noun[1]}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50 tabular-nums">
          {result.rows.map((r) => (
            <tr key={r.key} className="hover:bg-slate-50/60">
              <td className="px-3 py-2 font-medium text-slate-800">{r.label}</td>
              {result.series.map((s) => <td key={s.key} className="px-3 py-2 text-right text-slate-700">{fmt(r.values[s.key] ?? 0)}</td>)}
              {multi && <td className="px-3 py-2 text-right font-semibold text-slate-900">{fmt(r.total)}</td>}
              <td className="px-3 py-2 text-right text-slate-500">{r.count}</td>
            </tr>
          ))}
        </tbody>
        {result.groupLabel && (
          <tfoot>
            <tr className="border-t border-slate-200 font-semibold text-slate-900 tabular-nums">
              <td className="px-3 py-2">{additive ? 'Total' : 'Overall'}</td>
              {result.series.map((s) => (
                <td key={s.key} className="px-3 py-2 text-right">
                  {multi && additive ? fmt(result.rows.reduce((a, r) => a + (r.values[s.key] ?? 0), 0)) : multi ? '' : fmt(result.total.value)}
                </td>
              ))}
              {multi && <td className="px-3 py-2 text-right">{fmt(result.total.value)}</td>}
              <td className="px-3 py-2 text-right text-slate-500">{result.total.count}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Chart + table toggle for one report result. */
export function ReportView({result, chart, currency, height = 260, loading, error, compact}: {result?: ReportResult; chart: ChartType; currency: string; height?: number; loading?: boolean; error?: string | null; compact?: boolean}) {
  const [table, setTable] = useState(false);
  if (error) return <EmptyState className="py-10" icon={<BarChart3 />} title="This report can't run" description={error} />;
  if (!result) return <Skeleton className="w-full rounded-lg" style={{height}} />;
  if (chart === 'kpi') return <KpiTile result={result} currency={currency} size={compact ? 'sm' : 'lg'} />;
  const empty = result.total.count === 0;
  const showTable = chart === 'table' || table;
  return (
    // Refetches keep the previous render, dimmed, instead of flashing a skeleton.
    <div className={cn('transition-opacity', loading && 'opacity-60')}>
      {chart !== 'table' && !empty && (
        <div className="-mt-1 mb-2 flex justify-end">
          <Tooltip content={showTable ? 'Show chart' : 'Show table'}>
            <Button variant="ghost" size="icon-sm" onClick={() => setTable(!table)} aria-label={showTable ? 'Show chart' : 'Show table'} aria-pressed={table}>
              {showTable ? <BarChart3 /> : <Table2 />}
            </Button>
          </Tooltip>
        </div>
      )}
      {empty ? (
        <EmptyState className="py-10" icon={<BarChart3 />} title={`No ${result.noun[1]} match`} description="Try a longer date range or fewer filters." />
      ) : showTable ? (
        <ReportTable result={result} currency={currency} maxHeight={compact ? height + 40 : undefined} />
      ) : (
        <ReportChart result={result} chart={chart} currency={currency} height={height} />
      )}
      {result.truncated && <p className="mt-2 text-xs text-muted-foreground">Showing the largest groups only. Add filters to see the rest.</p>}
    </div>
  );
}
