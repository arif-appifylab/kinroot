import {useQuery} from '@tanstack/react-query';

import {
  DATE_FIELDS,
  EVENT_TRIGGERS,
  eventLabel,
  INACTIVITY_RULES,
  OBJECTS,
  TRIGGER_EVENT_GROUPS,
  type AutoObject,
  type EventFilter,
  type InactivityRule,
  type Trigger,
  type TriggerKind,
} from '@/lib/automations';
import {api} from '@/lib/api';
import type {IncomingWebhookRow} from '@/lib/incoming-webhooks';
import {keys, usePipelines} from '@/lib/queries';
import {TICKET_STATUSES} from '@/lib/tickets';
import type {FormRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {useBookingLinks} from '../booking/hooks';
import {useLists} from '../lists/list-picker';
import {useScoringSettings} from '../scoring/score';
import {Field, Input, NativeSelect} from '../ui/form';
import {ConditionsEditor} from './conditions-editor';
import {useRecordFields} from './hooks';
import {TRIGGER_ICONS} from './meta';

const KINDS: {kind: TriggerKind; label: string; hint: string}[] = [
  {kind: 'event', label: 'Event', hint: 'Something happens'},
  {kind: 'date', label: 'Date', hint: 'A date arrives'},
  {kind: 'inactivity', label: 'Inactivity', hint: 'Nothing happens for a while'},
  {kind: 'manual', label: 'Manual', hint: 'Started by hand'},
];

const INTERACTION_KINDS = ['CALL', 'MEETING', 'EMAIL', 'SMS', 'LINKEDIN', 'WHATSAPP', 'POSTAL'];

/** Sensible trigger when switching kind or record type. */
export function defaultTrigger(kind: TriggerKind, object: AutoObject): Trigger {
  if (kind === 'date') return {kind, source: 'record', field: object === 'deal' ? 'expectedCloseDate' : '', amount: 1, unit: 'days', direction: 'before', time: '09:00', zone: 'automation'};
  if (kind === 'inactivity') return {kind, rule: object === 'ticket' ? 'ticket_waiting' : 'no_activity', amount: object === 'ticket' ? 24 : 14, unit: object === 'ticket' ? 'hours' : 'days'};
  if (kind === 'manual') return {kind};
  const first = Object.entries(EVENT_TRIGGERS).find(([, d]) => d.objects.includes(object))?.[0] ?? '';
  return {kind: 'event', event: first, filter: {}};
}

/** Side panel for the trigger card: kind, record type, event / date / inactivity settings and trigger conditions. */
export function TriggerPanel({object, trigger, onChange, readOnly}: {object: AutoObject; trigger: Trigger; onChange: (object: AutoObject, trigger: Trigger) => void; readOnly?: boolean}) {
  const objects = (Object.keys(OBJECTS) as AutoObject[]).concat(trigger.kind === 'event' ? ['none'] : []);
  const set = (t: Trigger) => onChange(object, t);
  return (
    <div className={cn('grid gap-5', readOnly && 'pointer-events-none opacity-80')}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {KINDS.map((k) => {
          const Icon = TRIGGER_ICONS[k.kind];
          const on = trigger.kind === k.kind;
          return (
            <button
              key={k.kind}
              type="button"
              onClick={() => !on && onChange(object === 'none' && k.kind !== 'event' ? 'contact' : object, defaultTrigger(k.kind, object === 'none' && k.kind !== 'event' ? 'contact' : object))}
              className={cn('flex cursor-pointer flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-all', on ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-slate-200 hover:border-primary/40')}
            >
              <Icon className={cn('size-4', on ? 'text-primary' : 'text-slate-400')} />
              <span className="text-xs font-bold text-slate-800">{k.label}</span>
              <span className="text-[11px] leading-tight text-muted-foreground">{k.hint}</span>
            </button>
          );
        })}
      </div>

      <Field label="Runs on" hint="The record each run is about. Steps can also reach its related records.">
        <NativeSelect
          value={object}
          onChange={(e) => {
            const next = e.target.value as AutoObject;
            const keep = trigger.kind === 'event' && EVENT_TRIGGERS[trigger.event]?.objects.includes(next);
            onChange(next, keep ? trigger : defaultTrigger(trigger.kind, next));
          }}
        >
          {objects.map((o) => <option key={o} value={o}>{o === 'none' ? 'No record (team-wide events)' : OBJECTS[o as Exclude<AutoObject, 'none'>].plural.replace(/^./, (x) => x.toUpperCase())}</option>)}
        </NativeSelect>
      </Field>

      {trigger.kind === 'event' && <EventFields object={object} trigger={trigger} onChange={set} />}
      {trigger.kind === 'date' && <DateFields object={object} trigger={trigger} onChange={set} />}
      {trigger.kind === 'inactivity' && <InactivityFields object={object} trigger={trigger} onChange={set} />}
      {trigger.kind === 'manual' && (
        <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          Team members start this automation from a record's <b>Automations</b> card, or for every contact in a list from this page. Switch it on to make it available.
        </p>
      )}

      {object !== 'none' && (
        <Field label="Only for records that match" hint="Leave empty to run for every record.">
          <ConditionsEditor object={object} value={trigger.conditions} onChange={(conditions) => set({...trigger, conditions})} />
        </Field>
      )}
    </div>
  );
}

function EventFields({object, trigger, onChange}: {object: AutoObject; trigger: Extract<Trigger, {kind: 'event'}>; onChange: (t: Trigger) => void}) {
  const def = EVENT_TRIGGERS[trigger.event];
  const filters = def?.filters ?? [];
  const f = trigger.filter ?? {};
  const setF = (patch: Partial<EventFilter>) => onChange({...trigger, filter: Object.fromEntries(Object.entries({...f, ...patch}).filter(([, v]) => v !== '' && v !== undefined)) as EventFilter});
  const groups = TRIGGER_EVENT_GROUPS.map((g) => ({...g, events: g.events.filter((e) => EVENT_TRIGGERS[e.type]?.objects.includes(object))})).filter((g) => g.events.length);
  return (
    <div className="grid gap-4">
      <Field label="When">
        <NativeSelect value={trigger.event} onChange={(e) => onChange({...trigger, event: e.target.value, filter: {}})}>
          {!groups.some((g) => g.events.some((e) => e.type === trigger.event)) && <option value="">Pick an event…</option>}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.events.map((e) => <option key={e.type} value={e.type}>{e.label}</option>)}
            </optgroup>
          ))}
        </NativeSelect>
      </Field>
      {filters.includes('field') && object !== 'none' && object !== 'ticket' && <ChangedField object={object} value={f.field} onChange={(field) => setF({field})} />}
      {filters.includes('form') && <FormFilter value={f.formId} onChange={(formId) => setF({formId})} />}
      {filters.includes('list') && <ListFilter value={f.listId} onChange={(listId) => setF({listId})} />}
      {(filters.includes('pipeline') || filters.includes('stage')) && <PipelineFilter filter={f} stages={filters.includes('stage')} onChange={setF} />}
      {filters.includes('ticketStatus') && (
        <Field label="Moved to">
          <NativeSelect value={f.status ?? ''} onChange={(e) => setF({status: e.target.value})}>
            <option value="">Any status</option>
            {TICKET_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </NativeSelect>
        </Field>
      )}
      {filters.includes('direction') && (
        <Field label="Who replied">
          <NativeSelect value={f.direction ?? ''} onChange={(e) => setF({direction: (e.target.value || undefined) as EventFilter['direction']})}>
            <option value="">The team or the customer</option>
            <option value="INBOUND">The customer</option>
            <option value="OUTBOUND">The team</option>
          </NativeSelect>
        </Field>
      )}
      {filters.includes('band') && <BandFilter filter={f} onChange={setF} />}
      {filters.includes('link') && <LinkFilter value={f.linkId} onChange={(linkId) => setF({linkId})} />}
      {filters.includes('webhook') && <IncomingWebhookFilter value={f.webhookId} onChange={(webhookId) => setF({webhookId})} />}
      {filters.includes('dataInEvent') && (
        <Field label="Event name" hint="The event sent to POST /events, e.g. trial.started. Empty: any event.">
          <Input value={f.dataInEvent ?? ''} maxLength={100} placeholder="trial.started" onChange={(e) => setF({dataInEvent: e.target.value.trim()})} />
        </Field>
      )}
      {filters.includes('kind') && (
        <Field label="Kind">
          <NativeSelect value={f.kind ?? ''} onChange={(e) => setF({kind: e.target.value})}>
            <option value="">Any call, meeting or message</option>
            {INTERACTION_KINDS.map((k) => <option key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</option>)}
          </NativeSelect>
        </Field>
      )}
      {trigger.event.endsWith('.deleted') && <p className="text-xs text-muted-foreground">The record is in the recycle bin when this runs: notify and webhook steps work, steps that change it are skipped.</p>}
      {def && <p className="text-xs text-muted-foreground">{eventLabel(trigger.event)}: one run per event.</p>}
    </div>
  );
}

function ChangedField({object, value, onChange}: {object: Exclude<AutoObject, 'none' | 'ticket'>; value?: string; onChange: (v: string) => void}) {
  const fields = useRecordFields(object);
  return (
    <Field label="Only when this field changed">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any change</option>
        {fields.filter((f) => f.writable || f.key === 'tags').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </NativeSelect>
    </Field>
  );
}

function FormFilter({value, onChange}: {value?: string; onChange: (v: string) => void}) {
  const forms = useQuery({queryKey: keys.forms, queryFn: () => api.get<{rows: FormRow[]}>('/forms'), select: (d) => d.rows, staleTime: 60_000});
  return (
    <Field label="Form">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any form</option>
        {forms.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </NativeSelect>
    </Field>
  );
}

function IncomingWebhookFilter({value, onChange}: {value?: string; onChange: (v: string) => void}) {
  const hooks = useQuery({queryKey: keys.incomingWebhooks, queryFn: () => api.get<{rows: IncomingWebhookRow[]}>('/incoming-webhooks'), select: (d) => d.rows, staleTime: 60_000});
  return (
    <Field label="Incoming webhook" hint="Set one up in Settings → Webhooks → Incoming.">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any incoming webhook</option>
        {hooks.data?.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
      </NativeSelect>
    </Field>
  );
}

function ListFilter({value, onChange}: {value?: string; onChange: (v: string) => void}) {
  const lists = useLists('STATIC');
  return (
    <Field label="List">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any list</option>
        {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </NativeSelect>
    </Field>
  );
}

function PipelineFilter({filter, stages, onChange}: {filter: EventFilter; stages: boolean; onChange: (p: Partial<EventFilter>) => void}) {
  const pipelines = usePipelines();
  const pipeline = pipelines.data?.find((p) => p.id === filter.pipelineId);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Pipeline">
        <NativeSelect value={filter.pipelineId ?? ''} onChange={(e) => onChange({pipelineId: e.target.value, stageId: undefined, fromStageId: undefined})}>
          <option value="">Any pipeline</option>
          {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </Field>
      {stages && pipeline && (
        <>
          <Field label="Moved to">
            <NativeSelect value={filter.stageId ?? ''} onChange={(e) => onChange({stageId: e.target.value})}>
              <option value="">Any stage</option>
              {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Moved from">
            <NativeSelect value={filter.fromStageId ?? ''} onChange={(e) => onChange({fromStageId: e.target.value})}>
              <option value="">Any stage</option>
              {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </NativeSelect>
          </Field>
        </>
      )}
    </div>
  );
}

function BandFilter({filter, onChange}: {filter: EventFilter; onChange: (p: Partial<EventFilter>) => void}) {
  const scoring = useScoringSettings();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="New band">
        <NativeSelect value={filter.band ?? ''} onChange={(e) => onChange({band: e.target.value})}>
          <option value="">Any band</option>
          {scoring.data?.bands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Direction">
        <NativeSelect value={filter.bandDirection ?? ''} onChange={(e) => onChange({bandDirection: (e.target.value || undefined) as EventFilter['bandDirection']})}>
          <option value="">Up or down</option>
          <option value="up">Moving up</option>
          <option value="down">Moving down</option>
        </NativeSelect>
      </Field>
    </div>
  );
}

function LinkFilter({value, onChange}: {value?: string; onChange: (v: string) => void}) {
  const links = useBookingLinks();
  return (
    <Field label="Booking link">
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any booking link</option>
        {links.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </NativeSelect>
    </Field>
  );
}

export function useDateFields(object: AutoObject) {
  const custom = useRecordFields(object === 'none' ? 'contact' : object);
  if (object === 'none') return [];
  return [...DATE_FIELDS(object), ...custom.filter((f) => f.key.startsWith('custom.') && f.kind === 'date')];
}

function DateFields({object, trigger, onChange}: {object: AutoObject; trigger: Extract<Trigger, {kind: 'date'}>; onChange: (t: Trigger) => void}) {
  const fields = useDateFields(object);
  const dayUnit = trigger.unit === 'days' || trigger.unit === 'weeks';
  return (
    <div className="grid gap-4">
      {object === 'contact' && (
        <Field label="Date source">
          <NativeSelect value={trigger.source ?? 'record'} onChange={(e) => onChange({...trigger, source: e.target.value as 'record' | 'booking', field: e.target.value === 'booking' ? 'startAt' : ''})}>
            <option value="record">A date field of the contact</option>
            <option value="booking">The start of a meeting they booked</option>
          </NativeSelect>
        </Field>
      )}
      {trigger.source !== 'booking' && (
        <Field label="Date field" hint="Custom date fields are listed too.">
          <NativeSelect value={trigger.field} onChange={(e) => onChange({...trigger, field: e.target.value})}>
            <option value="">Pick a date…</option>
            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </NativeSelect>
        </Field>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label="Offset">
          <Input type="number" min={0} value={trigger.amount} onChange={(e) => onChange({...trigger, amount: Math.max(0, Math.round(Number(e.target.value) || 0))})} />
        </Field>
        <Field label="Unit">
          <NativeSelect value={trigger.unit} onChange={(e) => onChange({...trigger, unit: e.target.value as typeof trigger.unit})}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </NativeSelect>
        </Field>
        <Field label="When">
          <NativeSelect value={trigger.direction} onChange={(e) => onChange({...trigger, direction: e.target.value as 'before' | 'after'})}>
            <option value="before">before</option>
            <option value="after">after</option>
          </NativeSelect>
        </Field>
      </div>
      {dayUnit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="At time of day">
            <Input type="time" value={trigger.time ?? ''} onChange={(e) => onChange({...trigger, time: e.target.value || null})} />
          </Field>
          <Field label="Time zone">
            <NativeSelect value={trigger.zone ?? 'automation'} onChange={(e) => onChange({...trigger, zone: e.target.value as 'automation' | 'owner'})}>
              <option value="automation">The automation's (Settings tab)</option>
              <option value="owner">The record owner's</option>
            </NativeSelect>
          </Field>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Each record runs once per date value. When the date changes, the automation is armed again for the new date. Checked on every background run (every few minutes); missed checks are caught up.</p>
    </div>
  );
}

function InactivityFields({object, trigger, onChange}: {object: AutoObject; trigger: Extract<Trigger, {kind: 'inactivity'}>; onChange: (t: Trigger) => void}) {
  const lists = useLists('STATIC');
  const rules = (Object.entries(INACTIVITY_RULES) as [InactivityRule, (typeof INACTIVITY_RULES)[InactivityRule]][]).filter(([, r]) => r.objects.includes(object));
  return (
    <div className="grid gap-4">
      <Field label="Rule">
        <NativeSelect value={trigger.rule} onChange={(e) => onChange({...trigger, rule: e.target.value as InactivityRule})}>
          {!rules.some(([k]) => k === trigger.rule) && <option value="">Pick a rule…</option>}
          {rules.map(([k, r]) => <option key={k} value={k}>{r.label}…</option>)}
        </NativeSelect>
      </Field>
      {trigger.rule === 'in_list' && (
        <Field label="Static list">
          <NativeSelect value={trigger.listId ?? ''} onChange={(e) => onChange({...trigger, listId: e.target.value || undefined})}>
            <option value="">Pick a list…</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </NativeSelect>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="For">
          <Input type="number" min={1} value={trigger.amount} onChange={(e) => onChange({...trigger, amount: Math.max(1, Math.round(Number(e.target.value) || 1))})} />
        </Field>
        <Field label="Unit">
          <NativeSelect value={trigger.unit} onChange={(e) => onChange({...trigger, unit: e.target.value as 'hours' | 'days'})}>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </NativeSelect>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {trigger.rule === 'ticket_waiting' && 'Counts from when the ticket was opened or last moved to “Waiting on us”. '}
        {trigger.rule === 'no_activity' && 'Counts from the last activity on the record (emails, calls, notes, changes…). '}
        {trigger.rule === 'task_overdue' && 'Counts from the due date of an open task linked to the record. '}
        Fires once per quiet spell; new activity arms it again. Counting starts when the automation is switched on.
      </p>
    </div>
  );
}
