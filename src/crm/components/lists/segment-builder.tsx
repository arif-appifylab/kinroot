import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Loader2, Plus, Trash2, Users, X} from 'lucide-react';
import {createContext, useContext, useEffect, useMemo, useState} from 'react';

import {api} from '@/lib/api';
import {BUYING_ROLES, COMPANY_SIZES, fullName, LEAD_STATUSES, LIFECYCLE} from '@/lib/format';
import {keys, useFields, usePipelines, useSettings, useTeam} from '@/lib/queries';
import {customSegmentFields, opsFor, ruleComplete, SEGMENT_FIELDS, valueShape, type SegmentField, type SegmentGroup, type SegmentRule, type SegmentRules} from '@/lib/segments';
import type {ContactLite, EntityType, FormRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {TagInput} from '../pickers';

import {Button} from '../ui/button';
import {Input, NativeSelect} from '../ui/form';
import {useLists} from './list-picker';

type Option = {value: string; label: string};

/** Resolves a field's option source to concrete choices. */
function useOptionSources() {
  const team = useTeam();
  const settings = useSettings();
  const forms = useQuery({queryKey: keys.forms, queryFn: () => api.get<{rows: FormRow[]}>('/forms'), select: (d) => d.rows, staleTime: 60_000});
  const s = settings.data?.settings;
  return (field: SegmentField): Option[] => {
    if (field.pairs) return field.pairs;
    const plain = (xs: string[] | undefined) => (xs ?? []).map((x) => ({value: x, label: x}));
    switch (field.options) {
      case 'lifecycle':
        return Object.entries(LIFECYCLE).map(([value, l]) => ({value, label: l.label}));
      case 'users':
        return (team.data ?? []).map((u) => ({value: u.id, label: u.name}));
      case 'sources':
        return plain(s?.sources);
      case 'lead_statuses':
        return plain(LEAD_STATUSES);
      case 'buying_roles':
        return plain(BUYING_ROLES);
      case 'industries':
        return plain(s?.industries);
      case 'company_types':
        return plain(s?.companyTypes);
      case 'company_sizes':
        return plain(COMPANY_SIZES);
      case 'forms':
        return (forms.data ?? []).map((f) => ({value: f.id, label: f.name}));
      case 'custom':
        return plain(field.choices);
      default:
        return [];
    }
  };
}

const GROUP_ORDER: SegmentField['group'][] = ['Contact', 'Custom fields', 'Company', 'Deals', 'Activity', 'Lists', 'Ticket'];

/** Whose tags the tag picker suggests (contacts, unless the builder edits another record type). */
const TagEntity = createContext<EntityType | undefined>('CONTACT');

/** Fresh rule for a field: its first op, sensible defaults. */
function ruleFor(field: SegmentField): SegmentRule {
  const op = opsFor(field)[0]!.op;
  const shape = valueShape(field.kind, op);
  return {field: field.key, op, ...(shape === 'days' ? {days: 30} : {}), ...(shape === 'values' ? {values: []} : {})};
}

/**
 * Editor for dynamic segment rules: groups of rules, "all / any" at both
 * levels, with a live count of matching contacts. Looks like the forms
 * logic editor.
 */
export function SegmentBuilder({rules, onChange, listId, exclude, fields: only, entity}: {
  rules: SegmentRules;
  onChange: (r: SegmentRules) => void;
  listId?: string;
  /** field keys to leave out, e.g. the lead score in scoring rules */
  exclude?: string[];
  /** Another record type's fields instead of the contact fields (automation conditions on deals, companies, tickets). */
  fields?: SegmentField[];
  entity?: EntityType;
}) {
  const customDefs = useFields('CONTACT');
  const excluded = exclude?.join(',') ?? '';
  const contactFields = useMemo(() => [...SEGMENT_FIELDS, ...customSegmentFields(customDefs.data ?? [])].filter((f) => !excluded.split(',').includes(f.key)), [customDefs.data, excluded]);
  const fields = only ?? contactFields;
  const setGroup = (i: number, g: SegmentGroup) => onChange({...rules, groups: rules.groups.map((x, j) => (j === i ? g : x))});
  const addGroup = () => onChange({...rules, groups: [...rules.groups, {match: 'all', rules: [ruleFor(fields[0]!)]}]});

  return (
    <TagEntity.Provider value={only ? entity : 'CONTACT'}>
    <div className="grid gap-3">
      {rules.groups.length > 1 && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          {only ? 'Matching' : 'Contacts matching'}
          <NativeSelect className="h-8 w-auto py-0 text-xs" value={rules.match} onChange={(e) => onChange({...rules, match: e.target.value as SegmentRules['match']})} aria-label="Match groups">
            <option value="all">all groups</option>
            <option value="any">any group</option>
          </NativeSelect>
        </div>
      )}
      {rules.groups.map((g, i) => (
        <div key={i} className="grid gap-3">
          {i > 0 && (
            <div className="flex items-center gap-3 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
              <span className="h-px flex-1 bg-slate-200" />
              {rules.match === 'any' ? 'or' : 'and'}
              <span className="h-px flex-1 bg-slate-200" />
            </div>
          )}
          <GroupEditor
            group={g}
            index={i}
            fields={fields}
            listId={listId}
            onChange={(next) => setGroup(i, next)}
            onRemove={rules.groups.length > 1 ? () => onChange({...rules, groups: rules.groups.filter((_, j) => j !== i)}) : undefined}
          />
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={addGroup}><Plus /> Add rule group</Button>
    </div>
    </TagEntity.Provider>
  );
}

function GroupEditor({group, index, fields, listId, onChange, onRemove}: {group: SegmentGroup; index: number; fields: SegmentField[]; listId?: string; onChange: (g: SegmentGroup) => void; onRemove?: () => void}) {
  const setRule = (i: number, r: SegmentRule) => onChange({...group, rules: group.rules.map((x, j) => (j === i ? r : x))});
  const last = fields.find((f) => f.key === group.rules.at(-1)?.field) ?? fields[0]!;
  return (
    <div className="grid gap-2 rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <span className="font-bold text-slate-800">Group {index + 1}</span>
        {group.rules.length > 1 && (
          <>
            · match
            <NativeSelect className="h-7 w-auto py-0 text-xs" value={group.match} onChange={(e) => onChange({...group, match: e.target.value as SegmentGroup['match']})} aria-label="Match rules">
              <option value="all">all rules</option>
              <option value="any">any rule</option>
            </NativeSelect>
          </>
        )}
        {onRemove && <Button type="button" variant="ghost" size="icon-sm" className="ml-auto text-slate-400 hover:text-destructive" onClick={onRemove} aria-label="Remove group"><Trash2 /></Button>}
      </div>
      {group.rules.map((r, i) => (
        <RuleEditor key={i} rule={r} fields={fields} listId={listId} onChange={(next) => setRule(i, next)} onRemove={() => onChange({...group, rules: group.rules.filter((_, j) => j !== i)})} />
      ))}
      {group.rules.length === 0 && <p className="text-xs text-muted-foreground">No rules in this group yet.</p>}
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => onChange({...group, rules: [...group.rules, ruleFor(last)]})}><Plus /> Add rule</Button>
    </div>
  );
}

function RuleEditor({rule, fields, listId, onChange, onRemove}: {rule: SegmentRule; fields: SegmentField[]; listId?: string; onChange: (r: SegmentRule) => void; onRemove: () => void}) {
  const field = fields.find((f) => f.key === rule.field);
  const ops = opsFor(field);
  const shape = field ? valueShape(field.kind, rule.op) : 'none';
  const incomplete = !ruleComplete(rule, field);
  const setOp = (op: SegmentRule['op']) => {
    const next = field ? valueShape(field.kind, op) : 'none';
    onChange({field: rule.field, op, value: rule.value, values: rule.values, days: next === 'days' ? rule.days ?? 30 : undefined, stageId: rule.stageId});
  };

  return (
    <div className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
      <div className="flex gap-1.5">
        <NativeSelect
          className="h-8 min-w-0 flex-1 py-0 text-xs"
          value={rule.field}
          onChange={(e) => {
            const f = fields.find((x) => x.key === e.target.value);
            if (f) onChange(ruleFor(f));
          }}
          aria-label="Property"
        >
          {!field && <option value={rule.field}>Deleted field</option>}
          {GROUP_ORDER.map((g) => {
            const inGroup = fields.filter((f) => f.group === g);
            return inGroup.length ? (
              <optgroup key={g} label={g}>
                {inGroup.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </optgroup>
            ) : null;
          })}
        </NativeSelect>
        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onClick={onRemove} aria-label="Remove rule"><X /></Button>
      </div>
      {field && (
        <div className="flex flex-wrap gap-1.5">
          <NativeSelect className="h-8 w-auto py-0 text-xs" value={rule.op} onChange={(e) => setOp(e.target.value as SegmentRule['op'])} aria-label="Condition">
            {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </NativeSelect>
          <ValueEditor rule={rule} field={field} shape={shape} listId={listId} onChange={onChange} />
        </div>
      )}
      {incomplete && field && <p className="text-[11px] text-amber-700">Fill in a value to use this rule.</p>}
    </div>
  );
}

function ValueEditor({rule, field, shape, listId, onChange}: {rule: SegmentRule; field: SegmentField; shape: ReturnType<typeof valueShape>; listId?: string; onChange: (r: SegmentRule) => void}) {
  const options = useOptionSources()(field);
  const lists = useLists(undefined, {counts: false});
  const pipelines = usePipelines();
  const tagEntity = useContext(TagEntity);
  const cls = 'h-8 min-w-0 flex-1 py-0 text-xs';
  const set = (patch: Partial<SegmentRule>) => onChange({...rule, ...patch});

  // "Submitted a form": which form, plus the time window.
  const formPicker = field.key === 'activity.form' && (
    <NativeSelect className={cls} value={rule.value ?? ''} onChange={(e) => set({value: e.target.value || undefined})} aria-label="Form">
      <option value="">any form</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </NativeSelect>
  );

  switch (shape) {
    case 'none':
      return formPicker || null;
    case 'text': {
      const id = `opts-${field.key}`;
      return (
        <>
          <Input className={cls} value={rule.value ?? ''} onChange={(e) => set({value: e.target.value})} placeholder="Value" aria-label="Value" list={options.length ? id : undefined} />
          {options.length > 0 && <datalist id={id}>{options.map((o) => <option key={o.value} value={o.value} />)}</datalist>}
        </>
      );
    }
    case 'number':
      return <Input className={cls} type="number" value={rule.value ?? ''} onChange={(e) => set({value: e.target.value})} placeholder="Number" aria-label="Value" />;
    case 'date':
      return <Input className={cls} type="date" value={rule.value ?? ''} onChange={(e) => set({value: e.target.value})} aria-label="Date" />;
    case 'days':
      return (
        <>
          {formPicker}
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            <Input className="h-8 w-20 text-xs" type="number" inputMode="numeric" value={rule.days ?? ''} onChange={(e) => set({days: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined})} aria-label="Days" />
            {rule.op === 'more_than' ? 'days ago' : 'days'}
          </span>
        </>
      );
    case 'values':
      if (field.kind === 'tags' && !options.length) return <div className="min-w-0 flex-1"><TagInput entity={tagEntity} value={rule.values ?? []} onChange={(values) => set({values})} /></div>;
      return <ChoiceChips options={options} value={rule.values ?? []} onChange={(values) => set({values})} />;
    case 'ref':
      if (field.kind === 'list') {
        const others = (lists.data ?? []).filter((l) => l.id !== listId);
        return (
          <NativeSelect className={cls} value={rule.value ?? ''} onChange={(e) => set({value: e.target.value || undefined})} aria-label="List">
            <option value="">Pick a list…</option>
            {others.map((l) => <option key={l.id} value={l.id}>{l.name}{l.kind === 'DYNAMIC' ? ' (segment)' : ''}</option>)}
          </NativeSelect>
        );
      }
      return (
        <>
          <NativeSelect className={cls} value={rule.value ?? ''} onChange={(e) => set({value: e.target.value || undefined, stageId: undefined})} aria-label="Pipeline">
            <option value="">Pick a pipeline…</option>
            {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          {rule.value && (
            <NativeSelect className={cls} value={rule.stageId ?? ''} onChange={(e) => set({stageId: e.target.value || undefined})} aria-label="Stage">
              <option value="">any stage</option>
              {pipelines.data?.find((p) => p.id === rule.value)?.stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </NativeSelect>
          )}
        </>
      );
  }
}

function ChoiceChips({options, value, onChange}: {options: Option[]; value: string[]; onChange: (v: string[]) => void}) {
  if (!options.length) return <span className="self-center text-xs text-muted-foreground">No options to pick from</span>;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cn('outline-none focus-visible:ring-2 focus-visible:ring-primary/30', on ? 'cursor-pointer rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary' : 'cursor-pointer rounded-full border border-slate-200 bg-card px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-primary/50')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only sentence per rule, e.g. "Lifecycle stage is any of Lead, Customer". */
export function RulesSummary({rules}: {rules: SegmentRules}) {
  const customDefs = useFields('CONTACT');
  const fields = [...SEGMENT_FIELDS, ...customSegmentFields(customDefs.data ?? [])];
  const resolve = useOptionSources();
  const lists = useLists(undefined, {counts: false});
  const pipelines = usePipelines();
  const groups = rules.groups.filter((g) => g.rules.length);
  if (!groups.length) return <p className="text-sm text-muted-foreground">No rules yet, so nobody is in this segment.</p>;

  const describe = (r: SegmentRule) => {
    const field = fields.find((f) => f.key === r.field);
    if (!field) return {label: 'Deleted field', text: 'matches nobody'};
    const op = opsFor(field).find((o) => o.op === r.op)?.label ?? r.op;
    const opts = resolve(field);
    const name = (v: string) => opts.find((o) => o.value === v)?.label ?? v;
    let value = '';
    switch (valueShape(field.kind, r.op)) {
      case 'values':
        value = (r.values ?? []).map(name).join(', ');
        break;
      case 'days':
        value = `${r.days ?? '?'} ${r.op === 'more_than' ? 'days ago' : 'days'}`;
        break;
      case 'ref':
        if (field.kind === 'list') value = lists.data?.find((l) => l.id === r.value)?.name ?? 'a deleted list';
        else {
          const p = pipelines.data?.find((x) => x.id === r.value);
          value = [p?.name ?? 'a deleted pipeline', r.stageId && p?.stages.find((st) => st.id === r.stageId)?.name].filter(Boolean).join(' → ');
        }
        break;
      case 'none':
        break;
      default:
        value = r.value ?? '';
    }
    if (field.key === 'activity.form') value = [r.value ? name(r.value) : 'any form', value].filter(Boolean).join(', ');
    return {label: field.label, text: [op, value].filter(Boolean).join(' '), incomplete: !ruleComplete(r, field)};
  };

  return (
    <div className="grid gap-2">
      {groups.map((g, i) => (
        <div key={i} className="grid gap-2">
          {i > 0 && <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">{rules.match === 'any' ? 'or' : 'and'}</p>}
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5">
            {g.rules.map((r, j) => {
              const d = describe(r);
              return (
                <span key={j} className="contents">
                  {j > 0 && <span className="text-[11px] font-bold text-slate-400 uppercase">{g.match === 'any' ? 'or' : 'and'}</span>}
                  <span className={d.incomplete ? 'rounded-lg border border-dashed border-amber-300 px-2 py-1 text-xs text-amber-700' : 'rounded-lg bg-card px-2 py-1 text-xs text-slate-700 shadow-xs'}>
                    <span className="font-semibold text-slate-900">{d.label}</span> {d.text}
                    {d.incomplete && ' (incomplete, ignored)'}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Debounced live count (and a few names) for rules being edited. */
export function SegmentPreview({rules, listId}: {rules: SegmentRules; listId?: string}) {
  const json = JSON.stringify(rules);
  const [debounced, setDebounced] = useState(json);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(json), 400);
    return () => clearTimeout(t);
  }, [json]);
  const preview = useQuery({
    queryKey: [...keys.lists, 'preview', listId ?? '', debounced],
    queryFn: () => api.post<{count: number; sample: ContactLite[]}>('/lists/preview', {rules: JSON.parse(debounced), listId}),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const busy = preview.isFetching || json !== debounced;
  return (
    <div className="rounded-xl bg-accent/50 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        {busy ? <Loader2 className="size-4 animate-spin text-primary" /> : <Users className="size-4 text-primary" />}
        {preview.error ? <span className="text-destructive">{(preview.error as Error).message}</span> : <span><span className="text-lg font-extrabold tabular-nums">{preview.data?.count.toLocaleString() ?? '…'}</span> contacts match</span>}
      </p>
      {!!preview.data?.sample.length && (
        <p className="mt-1 text-xs text-muted-foreground">
          {preview.data.sample.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <Link to="/contacts/$contactId" params={{contactId: c.id}} className="hover:text-primary hover:underline">{fullName(c)}</Link>
            </span>
          ))}
          {preview.data.count > preview.data.sample.length && ' …'}
        </p>
      )}
      {preview.data?.count === 0 && !busy && <p className="mt-1 text-xs text-muted-foreground">Complete at least one rule, or loosen the rules.</p>}
    </div>
  );
}
