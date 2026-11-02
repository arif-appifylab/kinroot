import {useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';

import {api} from '@/lib/api';
import {customRecordFields, ENTITY_OF, RECORD_FIELDS, type AutoObject, type RecordField, type RecordOptionSource, type RunStatus, type Step, type Target, type TestMode, type Trigger} from '@/lib/automations';
import {BUYING_ROLES, COMPANY_SIZES, LEAD_STATUSES, LIFECYCLE} from '@/lib/format';
import {keys, useFields, usePipelines, useSettings, useTeam} from '@/lib/queries';
import type {SegmentField} from '@/lib/segments';
import {SOURCE_LABELS, TICKET_PRIORITIES, TICKET_STATUSES} from '@/lib/tickets';

import {useLists} from '../lists/list-picker';
import {useTicketSettings} from '../tickets/ticket-badges';

export type Automation = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  object: AutoObject;
  triggerKind: Trigger['kind'];
  triggerEvent: string | null;
  trigger: Trigger;
  steps: Step[];
  reenroll: 'always' | 'never' | 'after';
  reenrollDays: number | null;
  activeFrom: string | null;
  activeUntil: string | null;
  timezone: string;
  hasSecret: boolean;
  failureStreak: number;
  lastRunAt: string | null;
  enabledAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRow = Automation & {stepCount: number; stats: {runs7d: number; failed7d: number; waiting: number}};
export type Problem = {stepId: string | null; message: string};

export type RunRow = {
  id: string;
  automationId: string;
  object: AutoObject;
  recordId: string | null;
  recordLabel: string | null;
  status: RunStatus;
  source: string;
  eventType: string | null;
  depth: number;
  error: string | null;
  waitUntil: string | null;
  startedAt: string;
  finishedAt: string | null;
  context: Record<string, unknown>;
  /** Test runs from the editor (null = a real run). */
  test: TestMode | null;
  cursor?: string | null;
  _count?: {steps: number};
  automation?: {id: string; name: string};
};

export type RunStepRow = {id: string; stepId: string; type: Step['type']; status: 'running' | 'done' | 'skipped' | 'failed'; attempts: number; input: Record<string, unknown>; output: {summary?: string; branch?: 'then' | 'else'} & Record<string, unknown>; error: string | null; startedAt: string; finishedAt: string | null};
export type RunDetail = RunRow & {steps: RunStepRow[]; automation: {id: string; name: string; steps: Step[]; object: AutoObject; trigger: Trigger}};

export const automationKey = (id: string) => [...keys.automations, id] as const;

export function useAutomations() {
  return useQuery({queryKey: keys.automations, queryFn: () => api.get<{rows: AutomationRow[]}>('/automations'), select: (d) => d.rows});
}

export function useAutomation(id: string) {
  return useQuery({queryKey: automationKey(id), queryFn: () => api.get<{automation: Automation; problems: Problem[]}>(`/automations/${id}`)});
}

type Option = {value: string; label: string};

/** Choices for a record field's option source (users, stages, ticket statuses…). */
export function useRecordOptions() {
  const team = useTeam();
  const pipelines = usePipelines();
  const settings = useSettings();
  const tickets = useTicketSettings();
  const s = settings.data?.settings;
  const t = tickets.data?.settings;
  return (source: RecordOptionSource | undefined, choices?: string[]): Option[] => {
    const plain = (xs: string[] | undefined) => (xs ?? []).map((x) => ({value: x, label: x}));
    switch (source) {
      case 'users':
        return (team.data ?? []).filter((u) => u.active).map((u) => ({value: u.id, label: u.name}));
      case 'lifecycle':
        return Object.entries(LIFECYCLE).map(([value, l]) => ({value, label: l.label}));
      case 'pipelines':
        return (pipelines.data ?? []).map((p) => ({value: p.id, label: p.name}));
      case 'stages':
        return (pipelines.data ?? []).flatMap((p) => p.stages.map((st) => ({value: st.id, label: (pipelines.data?.length ?? 0) > 1 ? `${p.name} · ${st.name}` : st.name})));
      case 'deal_status':
        return [{value: 'OPEN', label: 'Open'}, {value: 'WON', label: 'Won'}, {value: 'LOST', label: 'Lost'}];
      case 'deal_priorities':
        return plain(['Low', 'Medium', 'High']);
      case 'deal_types':
        return plain(['New business', 'Existing business', 'Renewal', 'Upsell']);
      case 'ticket_status':
        return TICKET_STATUSES.map((x) => ({value: x.value, label: x.label}));
      case 'ticket_priority':
        return TICKET_PRIORITIES.map((x) => ({value: x.value, label: x.label}));
      case 'ticket_source':
        return Object.entries(SOURCE_LABELS).map(([value, label]) => ({value, label}));
      case 'ticket_categories':
        return plain(t?.categories);
      case 'ticket_queues':
        return plain(t?.queues);
      case 'lead_statuses':
        return plain(LEAD_STATUSES);
      case 'buying_roles':
        return plain(BUYING_ROLES);
      case 'sources':
        return plain(s?.sources);
      case 'industries':
        return plain(s?.industries);
      case 'company_types':
        return plain(s?.companyTypes);
      case 'company_sizes':
        return plain(COMPANY_SIZES);
      case 'custom':
        return plain(choices);
      default:
        return [];
    }
  };
}

/** A record type's fields, custom fields included. */
export function useRecordFields(target: Target): RecordField[] {
  const custom = useFields(target === 'ticket' ? 'CONTACT' : ENTITY_OF[target]);
  return useMemo(() => [...RECORD_FIELDS[target], ...(target === 'ticket' ? [] : customRecordFields(custom.data ?? []))], [target, custom.data]);
}

const GROUP: Record<Target, SegmentField['group']> = {contact: 'Contact', company: 'Company', deal: 'Deals', ticket: 'Ticket'};

/** Record fields in the segment builder's shape, choices resolved to labels. */
export function useConditionFields(target: Target): SegmentField[] {
  const fields = useRecordFields(target);
  const options = useRecordOptions();
  return fields.map((f) => {
    const pairs = f.options ? options(f.options, f.choices) : undefined;
    return {key: f.key, label: f.label, group: GROUP[target], kind: f.kind, required: f.required, pairs: pairs?.length ? pairs : f.kind === 'choice' ? [] : undefined};
  });
}

/** Label lookups for summaries: field labels, list names, user names. */
export function useNames() {
  const lists = useLists();
  const team = useTeam();
  const contact = useRecordFields('contact');
  const company = useRecordFields('company');
  const deal = useRecordFields('deal');
  const byTarget: Record<Target, RecordField[]> = {contact, company, deal, ticket: RECORD_FIELDS.ticket};
  return {
    field: (target: Target, key: string) => byTarget[target].find((f) => f.key === key)?.label ?? key,
    list: (id: string) => lists.data?.find((l) => l.id === id)?.name ?? 'a deleted list',
    user: (id: string) => team.data?.find((u) => u.id === id)?.name ?? 'someone',
  };
}
