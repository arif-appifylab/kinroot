import {BarChart3, ChartArea, ChartColumnStacked, ChartLine, CircleDot, Hash, Plus, Table2, X} from 'lucide-react';
import type {ReactNode} from 'react';

import {FilterDateRange} from '@/components/filter-bar';
import {Button} from '@/components/ui/button';
import {Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {useMe, useTeam} from '@/lib/queries';
import {
  BUCKETS,
  CHARTS,
  MEASURE_OPS,
  RANGE_PRESETS,
  chartsFor,
  type Bucket,
  type CatalogueField,
  type CatalogueObject,
  type ChartType,
  type CondOp,
  type DateRange,
  type GroupBy,
  type MeasureOp,
  type ReportCondition,
  type ReportConfig,
} from '@/lib/reports';
import {cn} from '@/lib/utils';

import {OptionPicker, useFieldOptions} from './option-picker';

export const CHART_ICONS: Record<ChartType, typeof BarChart3> = {bar: BarChart3, stacked: ChartColumnStacked, line: ChartLine, area: ChartArea, donut: CircleDot, table: Table2, kpi: Hash};

/** A sensible first report for an object. */
export function defaultConfig(o: CatalogueObject): ReportConfig {
  const group = o.fields.find((f) => f.key === 'stage') ?? o.fields.find((f) => f.kind === 'enum') ?? o.fields.find((f) => f.groupable && f.kind !== 'date');
  return {object: o.key, measure: {op: 'count'}, groupBy: group ? {field: group.key} : null, breakdown: null, filters: {dateField: o.defaultDate, range: {preset: 'all'}, conditions: []}, chart: 'bar'};
}

/** Keeps the chart valid for the current shape (e.g. no donut with a breakdown). */
export function normalize(c: ReportConfig): ReportConfig {
  const allowed = chartsFor(c);
  return allowed.includes(c.chart) ? c : {...c, chart: allowed[0]!};
}

const OPS: Record<CatalogueField['kind'], {op: CondOp; label: string}[]> = {
  string: [
    {op: 'is', label: 'is any of'},
    {op: 'is_not', label: 'is none of'},
    {op: 'contains', label: 'contains'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  enum: [
    {op: 'is', label: 'is any of'},
    {op: 'is_not', label: 'is none of'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  ref: [
    {op: 'is', label: 'is any of'},
    {op: 'is_not', label: 'is none of'},
    {op: 'not_empty', label: 'is set'},
    {op: 'empty', label: 'is not set'},
  ],
  tags: [
    {op: 'is', label: 'has any of'},
    {op: 'is_not', label: 'has none of'},
    {op: 'not_empty', label: 'has any value'},
    {op: 'empty', label: 'is empty'},
  ],
  number: [
    {op: 'gt', label: 'is greater than'},
    {op: 'gte', label: 'is at least'},
    {op: 'lt', label: 'is less than'},
    {op: 'lte', label: 'is at most'},
    {op: 'is', label: 'equals'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  currency: [],
  date: [
    {op: 'after', label: 'is after'},
    {op: 'before', label: 'is before'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  boolean: [
    {op: 'is_true', label: 'is yes'},
    {op: 'is_false', label: 'is no'},
  ],
};
OPS.currency = OPS.number;

const noValue: CondOp[] = ['empty', 'not_empty', 'is_true', 'is_false'];

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="grid gap-3 border-b border-slate-100 px-5 py-4 last:border-0">
      <h2 className="text-xs font-bold tracking-wider text-slate-400 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function GroupPicker({object, value, onChange, label, exclude, allowNone = true}: {object: CatalogueObject; value: GroupBy | null | undefined; onChange: (g: GroupBy | null) => void; label: string; exclude?: string; allowNone?: boolean}) {
  const fields = object.fields.filter((f) => f.groupable && f.key !== exclude);
  const current = fields.find((f) => f.key === value?.field);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <Field label={label}>
        <NativeSelect value={value?.field ?? ''} onChange={(e) => onChange(e.target.value ? {field: e.target.value, bucket: fields.find((f) => f.key === e.target.value)?.kind === 'date' ? 'month' : undefined} : null)}>
          {allowNone && <option value="">None</option>}
          {fieldOptions(fields)}
        </NativeSelect>
      </Field>
      {current?.kind === 'date' && (
        <Field label="By">
          <NativeSelect className="w-auto" value={value?.bucket ?? 'month'} onChange={(e) => onChange({field: current.key, bucket: e.target.value as Bucket})}>
            {Object.entries(BUCKETS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </NativeSelect>
        </Field>
      )}
    </div>
  );
}

/** Built-in fields first, custom fields in their own group. */
/** The options of a field picker, as elements: NativeSelect reads its `<option>` children, not a component's output. */
function fieldOptions(fields: CatalogueField[]) {
  const own = fields.filter((f) => !f.custom);
  const custom = fields.filter((f) => f.custom);
  return (
    <>
      {own.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      {custom.length > 0 && (
        <optgroup label="Custom fields">
          {custom.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </optgroup>
      )}
    </>
  );
}

function ConditionRow({object, cond, onChange, onRemove}: {object: CatalogueObject; cond: ReportCondition; onChange: (c: ReportCondition) => void; onRemove: () => void}) {
  const field = object.fields.find((f) => f.key === cond.field);
  const {options} = useFieldOptions(field);
  const ops = field ? OPS[field.kind] : [];
  const list = Array.isArray(cond.value) ? cond.value : cond.value === undefined || cond.value === '' ? [] : [String(cond.value)];
  const picker = field && (field.kind === 'enum' || field.kind === 'ref' || field.kind === 'tags' || (field.kind === 'string' && options.length > 0)) && (cond.op === 'is' || cond.op === 'is_not');
  return (
    <div className="grid gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Field"
          className="h-9 flex-1"
          value={cond.field}
          onChange={(e) => {
            const f = object.fields.find((x) => x.key === e.target.value);
            onChange({field: e.target.value, op: f ? OPS[f.kind][0]!.op : 'is', value: undefined});
          }}
        >
          {fieldOptions(object.fields)}
        </NativeSelect>
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove filter"><X /></Button>
      </div>
      <NativeSelect aria-label="Condition" className="h-9" value={cond.op} onChange={(e) => onChange({...cond, op: e.target.value as CondOp, value: noValue.includes(e.target.value as CondOp) ? undefined : cond.value})}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </NativeSelect>
      {!noValue.includes(cond.op) &&
        (picker ? (
          <OptionPicker options={options} value={list} onChange={(v) => onChange({...cond, value: v})} placeholder="Pick values" />
        ) : field?.kind === 'date' ? (
          <Input type="date" aria-label="Date" className="h-9" value={typeof cond.value === 'string' ? cond.value : ''} onChange={(e) => onChange({...cond, value: e.target.value})} />
        ) : field && (field.kind === 'number' || field.kind === 'currency') ? (
          <Input type="number" aria-label="Number" className="h-9" value={cond.value === undefined ? '' : String(cond.value)} onChange={(e) => onChange({...cond, value: e.target.value === '' ? undefined : Number(e.target.value)})} />
        ) : (
          <Input
            className="h-9"
            aria-label={cond.op === 'contains' ? 'Text' : 'Values, comma separated'}
            placeholder={cond.op === 'contains' ? 'Text' : 'Values, comma separated'}
            value={Array.isArray(cond.value) ? cond.value.join(', ') : String(cond.value ?? '')}
            onChange={(e) => onChange({...cond, value: e.target.value})}
          />
        ))}
    </div>
  );
}

export function RangeFields({range, onChange, compact}: {range: DateRange | undefined; onChange: (r: DateRange) => void; compact?: boolean}) {
  const preset = range?.preset ?? 'all';
  return (
    <>
      <NativeSelect size={compact ? 'sm' : 'default'} aria-label="Date range" value={preset} onChange={(e) => onChange({preset: e.target.value as DateRange['preset'], from: range?.from, to: range?.to})}>
        {Object.entries(RANGE_PRESETS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </NativeSelect>
      {preset === 'custom' &&
        (compact ? (
          <FilterDateRange from={range?.from} to={range?.to} onChange={(r) => onChange({preset, from: r.from, to: r.to})} />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" aria-label="From" value={range?.from ?? ''} onChange={(e) => onChange({preset, from: e.target.value, to: range?.to})} />
            <Input type="date" aria-label="To" value={range?.to ?? ''} onChange={(e) => onChange({preset, from: range?.from, to: e.target.value})} />
          </div>
        ))}
    </>
  );
}

/** The left-hand panel of the report builder: object → measure → group by → filters → chart. */
export function BuilderPanel({objects, config, onChange}: {objects: CatalogueObject[]; config: ReportConfig; onChange: (c: ReportConfig) => void}) {
  const {me} = useMe();
  const team = useTeam();
  const object = objects.find((o) => o.key === config.object) ?? objects[0]!;
  const set = (patch: Partial<ReportConfig>) => onChange(normalize({...config, ...patch}));
  const filters = config.filters;
  const setFilters = (patch: Partial<ReportConfig['filters']>) => set({filters: {...filters, ...patch}});
  const numeric = object.fields.filter((f) => f.numeric);
  const dates = object.fields.filter((f) => f.kind === 'date');
  const charts = chartsFor(config);

  return (
    <div>
      <Section title="Data">
        <Field label="Report on">
          <NativeSelect
            value={object.key}
            onChange={(e) => {
              const next = objects.find((o) => o.key === e.target.value);
              if (next) onChange(defaultConfig(next));
            }}
          >
            {objects.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </NativeSelect>
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <Field label="Measure">
            <NativeSelect
              className="w-auto"
              value={config.measure.op}
              onChange={(e) => {
                const op = e.target.value as MeasureOp;
                set({measure: op === 'count' ? {op} : {op, field: config.measure.field ?? numeric[0]?.key}});
              }}
            >
              {Object.entries(MEASURE_OPS).map(([k, l]) => (
                <option key={k} value={k} disabled={k !== 'count' && !numeric.length}>{l}</option>
              ))}
            </NativeSelect>
          </Field>
          {config.measure.op === 'count' ? (
            <Field label="Of">
              <Input disabled value={object.label} />
            </Field>
          ) : (
            <Field label="Of">
              <NativeSelect value={config.measure.field ?? ''} onChange={(e) => set({measure: {...config.measure, field: e.target.value}})}>
                {fieldOptions(numeric)}
              </NativeSelect>
            </Field>
          )}
        </div>
      </Section>

      <Section title="Group">
        <GroupPicker object={object} label="Group by" value={config.groupBy} onChange={(g) => set({groupBy: g, breakdown: g ? config.breakdown : null})} />
        {config.groupBy && <GroupPicker object={object} label="Break down by" exclude={config.groupBy.field} value={config.breakdown} onChange={(g) => set({breakdown: g})} />}
        {config.groupBy && !object.fields.find((f) => f.key === config.groupBy?.field && f.kind === 'date') && (
          <Field label="Sort groups">
            <NativeSelect value={config.sort ?? 'value'} onChange={(e) => set({sort: e.target.value as 'value' | 'label'})}>
              <option value="value">Natural order, then largest first</option>
              <option value="label">A → Z</option>
            </NativeSelect>
          </Field>
        )}
      </Section>

      <Section title="Filters">
        <Field label="Date range on">
          <NativeSelect value={filters.dateField ?? object.defaultDate} onChange={(e) => setFilters({dateField: e.target.value})}>
            {fieldOptions(dates)}
          </NativeSelect>
        </Field>
        <RangeFields range={filters.range} onChange={(range) => setFilters({range})} />
        {object.hasOwner && (
          <Field label={object.ownerLabel}>
            <NativeSelect value={filters.ownerId ?? ''} onChange={(e) => setFilters({ownerId: e.target.value || undefined})}>
              <option value="">Anyone</option>
              {team.data?.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? `${u.name} (me)` : u.name}</option>)}
              <option value="none">Nobody</option>
            </NativeSelect>
          </Field>
        )}
        {object.hasPipeline && <PipelineFilter value={filters.pipelineId} onChange={(pipelineId) => setFilters({pipelineId})} />}
        {filters.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            object={object}
            cond={c}
            onChange={(next) => setFilters({conditions: filters.conditions.map((x, j) => (j === i ? next : x))})}
            onRemove={() => setFilters({conditions: filters.conditions.filter((_, j) => j !== i)})}
          />
        ))}
        {filters.conditions.length < 20 && (
          <Button
            variant="secondary"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              const f = object.fields.find((x) => x.kind === 'enum') ?? object.fields[0]!;
              setFilters({conditions: [...filters.conditions, {field: f.key, op: OPS[f.kind][0]!.op}]});
            }}
          >
            <Plus /> Add filter
          </Button>
        )}
      </Section>

      <Section title="Visualization">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Chart type">
          {charts.map((c) => {
            const Icon = CHART_ICONS[c];
            const on = config.chart === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({chart: c})}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-semibold transition-colors',
                  on ? 'border-primary bg-accent text-primary' : 'border-border bg-card text-slate-600 hover:border-slate-300',
                )}
              >
                <Icon className="size-3.5" /> {CHARTS[c]}
              </button>
            );
          })}
        </div>
        {config.chart === 'kpi' && (
          <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
            Compare with the previous period
            <Switch checked={!!config.compare} onCheckedChange={(v) => set({compare: v})} disabled={(filters.range?.preset ?? 'all') === 'all'} />
          </label>
        )}
      </Section>
    </div>
  );
}

const PIPELINE_FIELD: CatalogueField = {key: 'pipeline', label: 'Pipeline', kind: 'ref', ref: 'pipeline', groupable: true, numeric: false};

function PipelineFilter({value, onChange}: {value?: string; onChange: (v: string | undefined) => void}) {
  const {options} = useFieldOptions(PIPELINE_FIELD);
  if (options.length < 2 && !value) return null;
  return (
    <Field label="Pipeline">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">All pipelines</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </NativeSelect>
    </Field>
  );
}
