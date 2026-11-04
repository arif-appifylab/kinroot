import {Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps} from 'recharts';

import {compactNumber, money} from '@/lib/format';
import type {ChartType, ReportResult} from '@/lib/reports';

// Chart marks follow the dataviz spec: single hue per chart, ≤24px bars with a
// 4px rounded data-end, hairline solid grid, text in ink tokens, hover tooltip.
const INK_MUTED = '#64748b';
const GRID = '#eef2f7';
// Slot 1 of the validated categorical palette (tokens in styles.css; dark mode has its own steps).
export const SERIES = 'var(--chart-1)';

function ChartTooltip({active, payload, label, currency}: TooltipProps<number, string> & {currency: string; payload?: {value: number; payload: Record<string, unknown>}[]; label?: string}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!;
  const count = p.payload.count as number | undefined;
  return (
    <div className="rounded-lg border border-slate-100 bg-card px-3 py-2 text-xs shadow-lift">
      <p className="font-semibold text-slate-900">{label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-slate-600">
        <span className="size-2 rounded-sm" style={{background: SERIES}} />
        {money(p.value, currency)}
        {count !== undefined && <span className="text-muted-foreground">· {count} deal{count === 1 ? '' : 's'}</span>}
      </p>
    </div>
  );
}

export function ValueBarChart({data, xKey, currency, height = 240}: {data: Record<string, unknown>[]; xKey: string; currency: string; height?: number}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{top: 8, right: 4, bottom: 0, left: 0}} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{fill: INK_MUTED, fontSize: 12, fontWeight: 500}} interval={0} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={52} tick={{fill: INK_MUTED, fontSize: 11}} tickFormatter={(v: number) => money(v, currency, true)} />
        <Tooltip cursor={{fill: 'rgb(37 99 235 / 0.06)', radius: 6}} content={<ChartTooltip currency={currency} />} />
        <Bar dataKey="value" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function CountTooltip({active, payload, label, noun}: TooltipProps<number, string> & {noun: string; payload?: {value: number}[]; label?: string}) {
  if (!active || !payload?.length) return null;
  const n = payload[0]!.value;
  return (
    <div className="rounded-lg border border-slate-100 bg-card px-3 py-2 text-xs shadow-lift">
      <p className="font-semibold text-slate-900">{label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-slate-600">
        <span className="size-2 rounded-sm" style={{background: SERIES}} />
        {n} {noun}
        {n === 1 ? '' : 's'}
      </p>
    </div>
  );
}

/** Counts over time (e.g. form responses per day). */
export function CountBarChart({data, xKey, yKey, noun, height = 200}: {data: Record<string, unknown>[]; xKey: string; yKey: string; noun: string; height?: number}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{top: 8, right: 4, bottom: 0, left: 0}} barCategoryGap="25%">
        <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{fill: INK_MUTED, fontSize: 11}} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{fill: INK_MUTED, fontSize: 11}} />
        <Tooltip cursor={{fill: 'rgb(37 99 235 / 0.06)', radius: 6}} content={<CountTooltip noun={noun} />} />
        <Bar dataKey={yKey} fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Report charts ───
// Categorical slots in fixed order (never cycled); "Other" is the de-emphasis gray.
export const PALETTE = Array.from({length: 8}, (_, i) => `var(--chart-${i + 1})`);
export const OTHER_COLOR = 'var(--chart-other)';
/** Ordinal ramp, light → dark (forecast categories and other ordered classes). */
export const ORDINAL = Array.from({length: 4}, (_, i) => `var(--chart-ord-${i + 1})`);

export const seriesColor = (key: string, index: number) => (key === '__other__' ? OTHER_COLOR : PALETTE[index % PALETTE.length]!);

export type ValueFormat = 'number' | 'currency';
export function formatValue(v: number, format: ValueFormat, currency: string, compact = false) {
  if (format === 'currency') return money(v, currency, compact);
  if (compact) return compactNumber(v);
  return new Intl.NumberFormat('en-US', {maximumFractionDigits: Math.abs(v) < 10 && v % 1 ? 2 : 1}).format(v);
}

export type SeriesKey = {key: string; label: string; color: string};
type TipProps = {active?: boolean; label?: unknown; payload?: readonly {dataKey?: unknown; value?: unknown}[]};

/** One tooltip, every series at that X: values lead, series names follow, keyed by a short line. */
export function SeriesTooltip({active, payload, label, keys, format, currency, total}: TipProps & {keys: SeriesKey[]; format: ValueFormat; currency: string; total?: boolean}) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((p) => [String(p.dataKey), Number(p.value ?? 0)]));
  const rows = keys.filter((k) => byKey.has(k.key));
  const sum = rows.reduce((a, k) => a + (byKey.get(k.key) ?? 0), 0);
  return (
    <div className="min-w-36 rounded-lg border border-slate-100 bg-card px-3 py-2 text-xs shadow-lift">
      <p className="mb-1 font-semibold text-slate-500">{String(label ?? '')}</p>
      <ul className="grid gap-1">
        {rows.map((k) => (
          <li key={k.key} className="flex items-center gap-2">
            <span className="h-0.5 w-3 shrink-0 rounded-full" style={{background: k.color}} />
            <span className="font-bold text-slate-900 tabular-nums">{formatValue(byKey.get(k.key) ?? 0, format, currency)}</span>
            {k.label && <span className="truncate text-slate-500">{k.label}</span>}
          </li>
        ))}
      </ul>
      {total && rows.length > 1 && <p className="mt-1.5 border-t border-slate-100 pt-1.5 font-semibold text-slate-700 tabular-nums">Total {formatValue(sum, format, currency)}</p>}
    </div>
  );
}

/** Legend for two or more series; mirrors the mark (rect for bars / areas, line for lines). */
export function ChartLegend({keys, mark = 'rect'}: {keys: SeriesKey[]; mark?: 'rect' | 'line'}) {
  if (keys.length < 2) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600" aria-label="Legend">
      {keys.map((k) => (
        <li key={k.key} className="inline-flex items-center gap-1.5">
          <span className={mark === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-[3px]'} style={{background: k.color}} />
          {k.label}
        </li>
      ))}
    </ul>
  );
}

const axisTick = {fill: INK_MUTED, fontSize: 11};

/**
 * A report result as bar / stacked bar / line / area / donut. Tables and KPI
 * tiles live in components/reports/report-view.tsx.
 */
export function ReportChart({result, chart, currency, height = 260, colors}: {result: ReportResult; chart: Exclude<ChartType, 'table' | 'kpi'>; currency: string; height?: number; colors?: Record<string, string>}) {
  const multi = result.series.length > 1 || result.series[0]?.key !== 'value';
  const keys: SeriesKey[] = result.series.map((s, i) => ({key: s.key, label: multi ? s.label : '', color: colors?.[s.key] ?? (multi ? seriesColor(s.key, i) : SERIES)}));
  const time = !!result.bucket;
  // Undated records stay in the table; a time axis has no place for them.
  const rows = time ? result.rows.filter((r) => r.key !== '__none__') : result.rows;
  const data = rows.map((r) => ({label: r.label, ...r.values}));
  const fmt = (v: number) => formatValue(v, result.format, currency, true);
  const line = chart === 'line' || chart === 'area';
  const tooltip = (
    <Tooltip
      cursor={line ? {stroke: 'var(--muted-foreground)', strokeWidth: 1} : {fill: 'rgb(100 116 139 / 0.08)', radius: 6}}
      content={(p) => <SeriesTooltip {...(p as TipProps)} keys={keys} format={result.format} currency={currency} total={chart === 'stacked' || chart === 'area'} />}
    />
  );

  if (chart === 'donut') return <DonutChart result={result} currency={currency} height={height} />;

  if (line) {
    const Chart = chart === 'line' ? LineChart : AreaChart;
    const dots = data.length <= 24;
    const active = (color: string) => ({r: 5, fill: color, stroke: 'var(--card)', strokeWidth: 2});
    return (
      <div>
        <ChartLegend keys={keys} mark={chart === 'line' ? 'line' : 'rect'} />
        <ResponsiveContainer width="100%" height={height}>
          <Chart data={data} margin={{top: 8, right: 12, bottom: 0, left: 0}}>
            <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} tickMargin={8} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={axisTick} tickFormatter={fmt} />
            {tooltip}
            {keys.map((k) =>
              chart === 'line' ? (
                <Line key={k.key} type="monotone" dataKey={k.key} name={k.label} stroke={k.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={dots ? {r: 4, fill: k.color, stroke: 'var(--card)', strokeWidth: 2} : false} activeDot={active(k.color)} isAnimationActive={false} />
              ) : (
                <Area key={k.key} type="monotone" dataKey={k.key} name={k.label} stackId="a" stroke={k.color} strokeWidth={2} fill={k.color} fillOpacity={0.1} activeDot={active(k.color)} isAnimationActive={false} />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Bars go horizontal when there are many categories or long names.
  const horizontal = !time && (data.length > 8 || rows.some((r) => r.label.length > 14));
  const stacked = chart === 'stacked';
  const perRow = stacked || keys.length === 1 ? 30 : 16 * keys.length + 14;
  const chartHeight = horizontal ? Math.max(height, data.length * perRow + 32) : height;
  const last = keys.length - 1;
  return (
    <div>
      <ChartLegend keys={keys} />
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{top: 8, right: 12, bottom: 0, left: 0}} barCategoryGap="28%" barGap={2}>
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke={GRID} strokeWidth={1} />
          {horizontal ? (
            <>
              <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick} tickFormatter={fmt} />
              <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={132} tick={{...axisTick, fontSize: 12}} interval={0} tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)} />
            </>
          ) : (
            <>
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{...axisTick, fontSize: 12}} tickMargin={8} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} width={56} tick={axisTick} tickFormatter={fmt} />
            </>
          )}
          {tooltip}
          {keys.map((k, i) => (
            <Bar
              key={k.key}
              dataKey={k.key}
              name={k.label}
              fill={k.color}
              stackId={stacked ? 'a' : undefined}
              maxBarSize={24}
              // 4px rounded data-end, square at the baseline; inside a stack only the outer segment is rounded.
              radius={stacked && i !== last ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              // 2px surface gap between touching segments.
              stroke={stacked ? 'var(--card)' : undefined}
              strokeWidth={stacked ? 2 : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Part-to-whole at a glance: at most 6 segments (the tail folds into "Other"), labelled with values and shares. */
function DonutChart({result, currency, height}: {result: ReportResult; currency: string; height: number}) {
  const positive = result.rows.filter((r) => r.total > 0);
  const top = positive.length > 6 ? [...positive].sort((a, b) => b.total - a.total).slice(0, 5) : positive;
  const rest = positive.filter((r) => !top.includes(r));
  const parts = [
    ...top.map((r, i) => ({key: r.key, label: r.label, value: r.total, color: seriesColor(r.key, i)})),
    ...(rest.length ? [{key: '__other__', label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.total, 0), color: OTHER_COLOR}] : []),
  ];
  const sum = parts.reduce((a, p) => a + p.value, 0);
  const size = Math.min(height, 220);
  return (
    <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="relative mx-auto" style={{width: size, height: size}}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={parts} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>
              {parts.map((p) => <Cell key={p.key} fill={p.color} />)}
            </Pie>
            <Tooltip
              content={(p) => {
                const item = (p as TipProps).payload?.[0] as {value?: number; payload?: {label: string; color: string}} | undefined;
                if (!(p as TipProps).active || !item?.payload) return null;
                return (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-card px-3 py-2 text-xs shadow-lift">
                    <span className="h-0.5 w-3 rounded-full" style={{background: item.payload.color}} />
                    <span className="font-bold text-slate-900 tabular-nums">{formatValue(Number(item.value ?? 0), result.format, currency)}</span>
                    <span className="text-slate-500">{item.payload.label}</span>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-lg font-extrabold tracking-tight text-slate-900">{formatValue(sum, result.format, currency, true)}</span>
          <span className="text-[11px] text-muted-foreground">Total</span>
        </div>
      </div>
      <ul className="grid gap-2 text-sm">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2.5">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{background: p.color}} />
            <span className="min-w-0 flex-1 truncate text-slate-700">{p.label}</span>
            <span className="font-semibold text-slate-900 tabular-nums">{formatValue(p.value, result.format, currency, true)}</span>
            <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{sum ? Math.round((p.value / sum) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
