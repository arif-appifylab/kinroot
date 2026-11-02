/**
 * Automations: shapes and catalogues shared by the builder (browser) and the
 * engine (src/server/lib/automations.ts).
 *
 * An automation is about one kind of record (`object`): a trigger starts a
 * run for a record, the run walks `steps` (a tree: `if` steps hold a `then`
 * and an `else` list) and keeps a step-by-step history. Conditions reuse the
 * segment rule shape: contact conditions are real segment rules (evaluated by
 * `segmentWhere`), deal / company / ticket conditions use the same JSON over
 * `RECORD_FIELDS`.
 */
import {EVENT_GROUPS} from '@/lib/events';
import type {SegmentRules} from '@/lib/segments';
import {WEBHOOK_SERVICE_NAMES, webhookTarget} from './webhook-targets';

export type AutoObject = 'contact' | 'company' | 'deal' | 'ticket' | 'none';
export type Target = 'contact' | 'company' | 'deal' | 'ticket';

export const OBJECTS: Record<Exclude<AutoObject, 'none'>, {label: string; plural: string}> = {
  contact: {label: 'Contact', plural: 'contacts'},
  company: {label: 'Company', plural: 'companies'},
  deal: {label: 'Deal', plural: 'deals'},
  ticket: {label: 'Ticket', plural: 'tickets'},
};

/** Records a run of this object can reach: the record itself plus its primary related records. */
export const TARGETS: Record<AutoObject, Target[]> = {
  contact: ['contact', 'company', 'deal'],
  company: ['company', 'deal'],
  deal: ['deal', 'contact', 'company'],
  ticket: ['ticket', 'contact', 'company', 'deal'],
  none: [],
};

/** "This deal", "The deal's contact", … */
export function targetLabel(object: AutoObject, target: Target) {
  if (object === target) return `This ${target}`;
  if (target === 'deal') return `The ${object}'s latest open deal`;
  return `The ${object}'s ${target}`;
}

// ─── Conditions ─────────────────────────────────────────────────────────────

/** One block per record; contact blocks are segment rules, the others use RECORD_FIELDS. */
export type ConditionBlock = {target: Target; rules: SegmentRules};
export type Conditions = {match: 'all' | 'any'; blocks: ConditionBlock[]};

export const emptyConditions = (): Conditions => ({match: 'all', blocks: []});

// ─── Record fields (conditions on deals / companies / tickets, field updates, date triggers) ───

export type RecordFieldKind = 'text' | 'choice' | 'tags' | 'bool' | 'number' | 'date';
export type RecordOptionSource =
  | 'users'
  | 'lifecycle'
  | 'pipelines'
  | 'stages'
  | 'deal_status'
  | 'deal_priorities'
  | 'deal_types'
  | 'ticket_status'
  | 'ticket_priority'
  | 'ticket_source'
  | 'ticket_categories'
  | 'ticket_queues'
  | 'lead_statuses'
  | 'buying_roles'
  | 'sources'
  | 'industries'
  | 'company_types'
  | 'company_sizes'
  | 'custom';

export type RecordField = {
  key: string;
  label: string;
  kind: RecordFieldKind;
  options?: RecordOptionSource;
  /** Can be set by an "Update a field" step. */
  writable?: boolean;
  /** Can't be cleared / is never empty. */
  required?: boolean;
  /** Calendar date without a time (expected close date, custom date fields). */
  dateOnly?: boolean;
  /** Custom field choices. */
  choices?: string[];
};

export const RECORD_FIELDS: Record<Target, RecordField[]> = {
  contact: [
    {key: 'firstName', label: 'First name', kind: 'text', writable: true, required: true},
    {key: 'lastName', label: 'Last name', kind: 'text', writable: true},
    {key: 'email', label: 'Email', kind: 'text'},
    {key: 'phone', label: 'Phone', kind: 'text', writable: true},
    {key: 'title', label: 'Job title', kind: 'text', writable: true},
    {key: 'lifecycleStage', label: 'Lifecycle stage', kind: 'choice', options: 'lifecycle', writable: true, required: true},
    {key: 'leadStatus', label: 'Lead status', kind: 'text', options: 'lead_statuses', writable: true},
    {key: 'buyingRole', label: 'Buying role', kind: 'text', options: 'buying_roles', writable: true},
    {key: 'ownerId', label: 'Owner', kind: 'choice', options: 'users', writable: true},
    {key: 'source', label: 'Source', kind: 'text', options: 'sources', writable: true},
    {key: 'city', label: 'City', kind: 'text', writable: true},
    {key: 'country', label: 'Country', kind: 'text', writable: true},
    {key: 'emailOptOut', label: 'Opted out of email', kind: 'bool', writable: true},
    {key: 'tags', label: 'Tags', kind: 'tags'},
    {key: 'score', label: 'Lead score', kind: 'number', required: true},
    {key: 'createdAt', label: 'Created', kind: 'date', required: true},
    {key: 'lastActivityAt', label: 'Last activity', kind: 'date'},
  ],
  company: [
    {key: 'name', label: 'Name', kind: 'text', writable: true, required: true},
    {key: 'domain', label: 'Domain', kind: 'text'},
    {key: 'industry', label: 'Industry', kind: 'text', options: 'industries', writable: true},
    {key: 'type', label: 'Type', kind: 'text', options: 'company_types', writable: true},
    {key: 'size', label: 'Size', kind: 'text', options: 'company_sizes', writable: true},
    {key: 'employees', label: 'Employees', kind: 'number', writable: true},
    {key: 'annualRevenue', label: 'Annual revenue', kind: 'number', writable: true},
    {key: 'phone', label: 'Phone', kind: 'text', writable: true},
    {key: 'website', label: 'Website', kind: 'text', writable: true},
    {key: 'city', label: 'City', kind: 'text', writable: true},
    {key: 'country', label: 'Country', kind: 'text', writable: true},
    {key: 'ownerId', label: 'Owner', kind: 'choice', options: 'users', writable: true},
    {key: 'tags', label: 'Tags', kind: 'tags'},
    {key: 'createdAt', label: 'Created', kind: 'date', required: true},
    {key: 'lastActivityAt', label: 'Last activity', kind: 'date'},
  ],
  deal: [
    {key: 'title', label: 'Title', kind: 'text', writable: true, required: true},
    {key: 'value', label: 'Value', kind: 'number', writable: true, required: true},
    {key: 'status', label: 'Status', kind: 'choice', options: 'deal_status', required: true},
    {key: 'pipelineId', label: 'Pipeline', kind: 'choice', options: 'pipelines', required: true},
    {key: 'stageId', label: 'Stage', kind: 'choice', options: 'stages', writable: true, required: true},
    {key: 'ownerId', label: 'Owner', kind: 'choice', options: 'users', writable: true},
    {key: 'priority', label: 'Priority', kind: 'text', options: 'deal_priorities', writable: true},
    {key: 'type', label: 'Type', kind: 'text', options: 'deal_types', writable: true},
    {key: 'tags', label: 'Tags', kind: 'tags'},
    {key: 'expectedCloseDate', label: 'Expected close date', kind: 'date', writable: true, dateOnly: true},
    {key: 'createdAt', label: 'Created', kind: 'date', required: true},
    {key: 'stageEnteredAt', label: 'Entered current stage', kind: 'date', required: true},
    {key: 'closedAt', label: 'Closed', kind: 'date'},
    {key: 'lastActivityAt', label: 'Last activity', kind: 'date', required: true},
  ],
  ticket: [
    {key: 'subject', label: 'Subject', kind: 'text', required: true},
    {key: 'status', label: 'Status', kind: 'choice', options: 'ticket_status', writable: true, required: true},
    {key: 'priority', label: 'Priority', kind: 'choice', options: 'ticket_priority', writable: true, required: true},
    {key: 'category', label: 'Category', kind: 'text', options: 'ticket_categories', writable: true},
    {key: 'queue', label: 'Queue', kind: 'text', options: 'ticket_queues', writable: true},
    {key: 'source', label: 'Source', kind: 'choice', options: 'ticket_source', required: true},
    {key: 'assigneeId', label: 'Assignee', kind: 'choice', options: 'users', writable: true},
    {key: 'tags', label: 'Tags', kind: 'tags'},
    {key: 'createdAt', label: 'Created', kind: 'date', required: true},
    {key: 'lastMessageAt', label: 'Last message', kind: 'date', required: true},
    {key: 'firstResponseDueAt', label: 'First response due', kind: 'date'},
    {key: 'resolutionDueAt', label: 'Resolution due', kind: 'date'},
    {key: 'resolvedAt', label: 'Resolved', kind: 'date'},
  ],
};

type CustomDef = {key: string; label: string; type: string; options: string[]};

/** Custom fields of contacts / companies / deals as `custom.<key>` record fields (all writable). */
export function customRecordFields(defs: CustomDef[]): RecordField[] {
  const kind: Record<string, RecordFieldKind> = {TEXT: 'text', URL: 'text', NUMBER: 'number', CURRENCY: 'number', DATE: 'date', SELECT: 'choice', MULTISELECT: 'tags', CHECKBOX: 'bool'};
  return defs.map((d) => ({
    key: `custom.${d.key}`,
    label: d.label,
    kind: kind[d.type] ?? 'text',
    writable: true,
    dateOnly: d.type === 'DATE' || undefined,
    options: d.options.length ? 'custom' : undefined,
    choices: d.options,
  }));
}

export const ENTITY_OF: Record<Exclude<Target, 'ticket'>, 'CONTACT' | 'COMPANY' | 'DEAL'> = {contact: 'CONTACT', company: 'COMPANY', deal: 'DEAL'};

// ─── Triggers ───────────────────────────────────────────────────────────────

export type EventFilterKey = 'field' | 'form' | 'list' | 'pipeline' | 'stage' | 'fromStage' | 'ticketStatus' | 'direction' | 'band' | 'bandDirection' | 'link' | 'kind' | 'webhook' | 'dataInEvent';

export type EventFilter = {
  field?: string; // *.updated: this field changed
  formId?: string;
  listId?: string;
  pipelineId?: string;
  stageId?: string; // deal.stage_changed: moved to
  fromStageId?: string;
  status?: string; // ticket.status_changed: moved to
  direction?: 'INBOUND' | 'OUTBOUND'; // ticket.replied: customer or team
  band?: string; // contact.score_changed: new band key
  bandDirection?: 'up' | 'down';
  linkId?: string; // meeting.*: booking link
  kind?: string; // interaction.logged: CALL / MEETING / …
  webhookId?: string; // webhook.received: which incoming webhook
  dataInEvent?: string; // data_in.received: the event name sent to POST /events
};

/** What each event can start a run on, and the filters it offers. Events not listed can't trigger automations. */
export const EVENT_TRIGGERS: Record<string, {objects: AutoObject[]; filters?: EventFilterKey[]}> = {
  'contact.created': {objects: ['contact']},
  'contact.updated': {objects: ['contact'], filters: ['field']},
  'contact.deleted': {objects: ['contact']},
  'contact.merged': {objects: ['contact']},
  'contact.restored': {objects: ['contact']},
  'contact.score_changed': {objects: ['contact'], filters: ['band', 'bandDirection']},
  'company.created': {objects: ['company']},
  'company.updated': {objects: ['company'], filters: ['field']},
  'company.deleted': {objects: ['company']},
  'company.merged': {objects: ['company']},
  'company.restored': {objects: ['company']},
  'deal.created': {objects: ['deal'], filters: ['pipeline']},
  'deal.updated': {objects: ['deal'], filters: ['field', 'pipeline']},
  'deal.stage_changed': {objects: ['deal'], filters: ['pipeline', 'stage', 'fromStage']},
  'deal.won': {objects: ['deal'], filters: ['pipeline']},
  'deal.lost': {objects: ['deal'], filters: ['pipeline']},
  'deal.deleted': {objects: ['deal']},
  'deal.restored': {objects: ['deal']},
  'form.submitted': {objects: ['contact', 'deal'], filters: ['form']},
  'list.member_added': {objects: ['contact'], filters: ['list']},
  'list.member_removed': {objects: ['contact'], filters: ['list']},
  'broadcast.sent': {objects: ['none'], filters: ['list']},
  'report.sent': {objects: ['none']},
  'ticket.created': {objects: ['ticket']},
  'ticket.status_changed': {objects: ['ticket'], filters: ['ticketStatus']},
  'ticket.replied': {objects: ['ticket'], filters: ['direction']},
  'ticket.assigned': {objects: ['ticket']},
  'ticket.sla_breached': {objects: ['ticket']},
  'ticket.deleted': {objects: ['ticket']},
  'ticket.restored': {objects: ['ticket']},
  'conversation.created': {objects: ['contact', 'deal']},
  'conversation.assigned': {objects: ['contact', 'deal']},
  'conversation.closed': {objects: ['contact', 'deal']},
  'conversation.reopened': {objects: ['contact', 'deal']},
  'chat.started': {objects: ['contact', 'deal']},
  'meeting.booked': {objects: ['contact', 'deal'], filters: ['link']},
  'meeting.rescheduled': {objects: ['contact', 'deal'], filters: ['link']},
  'meeting.canceled': {objects: ['contact', 'deal'], filters: ['link']},
  'task.created': {objects: ['contact', 'deal', 'company']},
  'task.completed': {objects: ['contact', 'deal', 'company']},
  'note.created': {objects: ['contact', 'deal', 'company']},
  'interaction.logged': {objects: ['contact', 'deal', 'company'], filters: ['kind']},
  'email.sent': {objects: ['contact', 'deal']},
  'email.received': {objects: ['contact', 'deal']},
  'email.opened': {objects: ['contact', 'deal']},
  'email.clicked': {objects: ['contact', 'deal']},
  'file.uploaded': {objects: ['contact', 'deal', 'company']},
  'webhook.received': {objects: ['none', 'contact', 'company', 'deal', 'ticket'], filters: ['webhook']},
  'data_in.received': {objects: ['none', 'contact', 'deal'], filters: ['dataInEvent']},
};

/** Event groups for the trigger picker (only events that can trigger automations). */
export const TRIGGER_EVENT_GROUPS = EVENT_GROUPS.map((g) => ({label: g.label, events: g.events.filter((e) => e.type in EVENT_TRIGGERS)})).filter((g) => g.events.length);

const ALL_EVENTS = (EVENT_GROUPS as readonly {events: readonly {type: string; label: string}[]}[]).flatMap((g) => g.events);
export const eventLabel = (type: string) => ALL_EVENTS.find((e) => e.type === type)?.label ?? type;

export type InactivityRule = 'no_activity' | 'ticket_waiting' | 'task_overdue' | 'in_list';

export const INACTIVITY_RULES: Record<InactivityRule, {label: string; objects: AutoObject[]}> = {
  no_activity: {label: 'No activity for', objects: ['contact', 'company', 'deal']},
  ticket_waiting: {label: 'Ticket waiting on us for', objects: ['ticket']},
  task_overdue: {label: 'A linked task is overdue by', objects: ['contact', 'company', 'deal']},
  in_list: {label: 'In a static list for', objects: ['contact']},
};

export type TimeUnit = 'minutes' | 'hours' | 'days' | 'weeks';
export const UNIT_MS: Record<TimeUnit, number> = {minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000};

export type Trigger =
  | {kind: 'event'; event: string; filter?: EventFilter; conditions?: Conditions}
  | {
      kind: 'date';
      /** `record`: a date field of the record; `booking`: the start of the contact's booked meetings. */
      source?: 'record' | 'booking';
      field: string;
      amount: number;
      unit: TimeUnit;
      direction: 'before' | 'after';
      /** HH:MM; with a day offset the run starts at this time of day. */
      time?: string | null;
      /** Whose time zone `time` is in: the automation's or the record owner's (their scheduling profile). */
      zone?: 'automation' | 'owner';
      conditions?: Conditions;
    }
  | {kind: 'inactivity'; rule: InactivityRule; amount: number; unit: 'hours' | 'days'; listId?: string; conditions?: Conditions}
  | {kind: 'manual'; conditions?: Conditions};

export type TriggerKind = Trigger['kind'];

/** Date fields a date trigger can use, per object (custom date fields are added by the UI / server). */
export const DATE_FIELDS = (object: AutoObject) => (object === 'none' ? [] : RECORD_FIELDS[object].filter((f) => f.kind === 'date'));

// ─── Steps ──────────────────────────────────────────────────────────────────

export type StepType =
  | 'if'
  | 'update_field'
  | 'assign_owner'
  | 'create_task'
  | 'create_deal'
  | 'create_ticket'
  | 'add_tag'
  | 'remove_tag'
  | 'add_to_list'
  | 'remove_from_list'
  | 'send_email'
  | 'notify'
  | 'webhook'
  | 'wait'
  | 'stop';

/** Who a created task / deal / ticket is for, or who is notified. */
export type AssigneeMode = 'owner' | 'user' | 'assignee' | 'creator' | 'none';

/** One step. Fields are optional so the builder can edit them in place; `automationProblems()` says what's missing. */
export type Step = {
  id: string;
  type: StepType;
  // if
  conditions?: Conditions;
  then?: Step[];
  else?: Step[];
  // update_field / add_tag / remove_tag / assign_owner
  target?: Target;
  field?: string;
  /** update_field: the new value (text values may use merge fields). */
  value?: string | number | boolean | string[] | null;
  /** update_field on a date: set / clear / N days from now. */
  mode?: 'set' | 'clear' | 'relative';
  days?: number;
  tag?: string;
  // assign_owner
  assignMode?: 'user' | 'round_robin';
  userIds?: string[];
  onlyIfEmpty?: boolean;
  // create_* / notify
  assignee?: AssigneeMode;
  userId?: string | null;
  title?: string;
  description?: string;
  dueDays?: number;
  time?: string | null;
  taskType?: string;
  priority?: string;
  pipelineId?: string;
  stageId?: string;
  subject?: string;
  category?: string;
  queue?: string;
  // lists
  listId?: string;
  // send_email
  html?: string;
  layout?: 'branded' | 'plain';
  from?: 'owner' | 'shared';
  accountId?: string;
  templateId?: string;
  // notify
  body?: string;
  email?: boolean;
  // webhook
  url?: string;
  // wait
  waitMode?: 'duration' | 'until_date' | 'until_weekday';
  amount?: number;
  unit?: TimeUnit;
  weekdays?: number[];
};

export const STEP_TYPES: Record<StepType, {label: string; description: string; group: 'Records' | 'Create' | 'Communicate' | 'Flow'}> = {
  update_field: {label: 'Update a field', description: 'Set a property, lifecycle stage, lead status, ticket status…', group: 'Records'},
  assign_owner: {label: 'Assign owner', description: 'A fixed person or round robin', group: 'Records'},
  add_tag: {label: 'Add a tag', description: 'Tag the record', group: 'Records'},
  remove_tag: {label: 'Remove a tag', description: 'Untag the record', group: 'Records'},
  add_to_list: {label: 'Add to a list', description: 'Static list membership', group: 'Records'},
  remove_from_list: {label: 'Remove from a list', description: 'Static list membership', group: 'Records'},
  create_task: {label: 'Create a task', description: 'For the owner or someone else', group: 'Create'},
  create_deal: {label: 'Create a deal', description: 'In a pipeline and stage', group: 'Create'},
  create_ticket: {label: 'Create a ticket', description: 'Support ticket for the contact', group: 'Create'},
  send_email: {label: 'Send an email', description: 'One templated email to the contact', group: 'Communicate'},
  notify: {label: 'Notify someone', description: 'In-app, optionally by email', group: 'Communicate'},
  webhook: {label: 'Send a webhook', description: 'Signed POST to a URL', group: 'Communicate'},
  if: {label: 'If / else', description: 'Branch on conditions', group: 'Flow'},
  wait: {label: 'Wait', description: 'A duration, a date or a weekday', group: 'Flow'},
  stop: {label: 'Stop', description: 'End the run here', group: 'Flow'},
};

export const STEP_GROUPS = ['Records', 'Create', 'Communicate', 'Flow'] as const;

/** Steps that change something outside the automation (dry runs describe them instead). */
export const SIDE_EFFECT_STEPS = new Set<StepType>(['update_field', 'assign_owner', 'create_task', 'create_deal', 'create_ticket', 'add_tag', 'remove_tag', 'add_to_list', 'remove_from_list', 'send_email', 'notify', 'webhook']);

export const newStepId = () => `s${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/** A fresh step of a type with sensible defaults for this object. */
export function blankStep(type: StepType, object: AutoObject): Step {
  const target = (TARGETS[object][0] ?? 'contact') as Target;
  const id = newStepId();
  switch (type) {
    case 'if':
      return {id, type, conditions: {match: 'all', blocks: []}, then: [], else: []};
    case 'update_field':
      return {id, type, target, field: '', value: ''};
    case 'assign_owner':
      return {id, type, target, assignMode: 'round_robin', userIds: [], onlyIfEmpty: false};
    case 'create_task':
      return {id, type, title: '', dueDays: 1, time: null, taskType: 'TODO', priority: 'NONE', assignee: object === 'ticket' ? 'assignee' : 'owner'};
    case 'create_deal':
      return {id, type, title: '{{contact.full_name}}', pipelineId: '', stageId: '', value: 0, assignee: 'owner'};
    case 'create_ticket':
      return {id, type, subject: '', description: '', priority: 'NORMAL', assignee: 'none'};
    case 'add_tag':
    case 'remove_tag':
      return {id, type, target, tag: ''};
    case 'add_to_list':
    case 'remove_from_list':
      return {id, type, listId: ''};
    case 'send_email':
      return {id, type, subject: '', html: '', layout: 'branded', from: 'owner'};
    case 'notify':
      return {id, type, assignee: object === 'ticket' ? 'assignee' : 'owner', title: '', body: '', email: false};
    case 'webhook':
      return {id, type, url: ''};
    case 'wait':
      return {id, type, waitMode: 'duration', amount: 1, unit: 'days', time: '09:00', weekdays: [1]};
    case 'stop':
      return {id, type};
  }
}

// ─── Step tree helpers ──────────────────────────────────────────────────────

/** Every step, depth first, with its parent `if` (null at the top level). */
export function flattenSteps(steps: Step[], parent: Step | null = null): {step: Step; parent: Step | null; branch: 'then' | 'else' | null}[] {
  return steps.flatMap((step) => [
    {step, parent, branch: parent ? (parent.then?.includes(step) ? 'then' : 'else') : null} as const,
    ...(step.type === 'if' ? [...flattenSteps(step.then ?? [], step), ...flattenSteps(step.else ?? [], step)] : []),
  ]);
}

function locate(list: Step[], id: string, parent: Step | null = null): {list: Step[]; index: number; parent: Step | null} | null {
  for (let i = 0; i < list.length; i++) {
    const step = list[i]!;
    if (step.id === id) return {list, index: i, parent};
    if (step.type === 'if') {
      const inner = locate(step.then ?? [], id, step) ?? locate(step.else ?? [], id, step);
      if (inner) return inner;
    }
  }
  return null;
}

export const findStep = (steps: Step[], id: string) => {
  const at = locate(steps, id);
  return at ? at.list[at.index]! : null;
};

/** The step that runs after `id` finishes (not entering its branches); null = end of the run. */
export function nextAfter(steps: Step[], id: string): string | null {
  const at = locate(steps, id);
  if (!at) return null;
  if (at.index + 1 < at.list.length) return at.list[at.index + 1]!.id;
  return at.parent ? nextAfter(steps, at.parent.id) : null;
}

/** First step of an `if` branch, or what follows the `if` when the branch is empty. */
export function branchStart(steps: Step[], ifStep: Step, branch: 'then' | 'else') {
  const list = (branch === 'then' ? ifStep.then : ifStep.else) ?? [];
  return list[0]?.id ?? nextAfter(steps, ifStep.id);
}

/** Copies a step tree with fresh ids (duplicating an automation keeps ids; copying a step doesn't). */
export function cloneSteps(steps: Step[]): Step[] {
  return steps.map((s) => ({...s, id: newStepId(), ...(s.type === 'if' ? {then: cloneSteps(s.then ?? []), else: cloneSteps(s.else ?? [])} : {})}));
}

/** Immutable edits used by the builder. */
export function mapSteps(steps: Step[], fn: (s: Step) => Step | null): Step[] {
  return steps.flatMap((s) => {
    const next = fn(s);
    if (!next) return [];
    return [next.type === 'if' ? {...next, then: mapSteps(next.then ?? [], fn), else: mapSteps(next.else ?? [], fn)} : next];
  });
}

/** Inserts `step` into the list identified by (parentId, branch) at `index`. parentId null = top level. */
export function insertStep(steps: Step[], parentId: string | null, branch: 'then' | 'else', index: number, step: Step): Step[] {
  if (!parentId) return [...steps.slice(0, index), step, ...steps.slice(index)];
  return mapSteps(steps, (s) => {
    if (s.id !== parentId) return s;
    const list = (branch === 'then' ? s.then : s.else) ?? [];
    return {...s, [branch]: [...list.slice(0, index), step, ...list.slice(index)]};
  });
}

export const removeStep = (steps: Step[], id: string) => mapSteps(steps, (s) => (s.id === id ? null : s));
export const replaceStep = (steps: Step[], next: Step) => mapSteps(steps, (s) => (s.id === next.id ? {...next, ...(next.type === 'if' ? {then: s.then, else: s.else} : {})} : s));

/** Moves a step up or down inside its own list. */
export function moveStep(steps: Step[], id: string, delta: -1 | 1): Step[] {
  const swap = (list: Step[]): Step[] => {
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return list.map((s) => (s.type === 'if' ? {...s, then: swap(s.then ?? []), else: swap(s.else ?? [])} : s));
    const j = i + delta;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  return swap(steps);
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Runs started by events that an automation caused: A → B → A … stops at this depth. */
export const MAX_CHAIN_DEPTH = 5;
/** Per automation and record: at most this many runs in an hour (manual runs excepted). */
export const RUNS_PER_RECORD_PER_HOUR = 10;
/** Steps one run may execute (guards against runaway runs). */
export const MAX_STEPS_PER_RUN = 100;
export const MAX_STEPS = 60;

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'canceled';
export const RUN_STATUS: Record<RunStatus, {label: string; tone: 'blue' | 'violet' | 'green' | 'rose' | 'neutral' | 'amber'}> = {
  running: {label: 'Running', tone: 'blue'},
  waiting: {label: 'Waiting', tone: 'violet'},
  done: {label: 'Completed', tone: 'green'},
  failed: {label: 'Failed', tone: 'rose'},
  skipped: {label: 'Skipped', tone: 'amber'},
  canceled: {label: 'Canceled', tone: 'neutral'},
};

export const RUN_SOURCES: Record<string, string> = {event: 'Event', date: 'Date', inactivity: 'Inactivity', manual: 'Manual', list: 'List run', test: 'Test'};

// ─── Test runs ──────────────────────────────────────────────────────────────

/**
 * Test runs from the editor (`AutomationRun.test`). They run the editor's draft
 * (saved or not), are flagged, and never count in stats, failure streaks,
 * re-enrollment or rate limits.
 *   quick   simulation (dry run): every wait lasts QUICK_TEST_WAIT_MS
 *   timed   simulation with real wait times, carried on by the job runner
 *   record  for real on a picked record: every step really happens
 */
export type TestMode = 'quick' | 'timed' | 'record';
export const TEST_MODES: Record<TestMode, {label: string; description: string; dry: boolean}> = {
  quick: {label: 'Quick test', description: 'Every wait takes 5 seconds, so you can watch it all now.', dry: true},
  timed: {label: 'Test with real wait times', description: 'Waits last as long as they would for a record.', dry: true},
  record: {label: 'Test on a record…', description: 'Pick who it runs on. Every step really happens to them.', dry: false},
};
export const QUICK_TEST_WAIT_MS = 5_000;

// ─── Merge fields ───────────────────────────────────────────────────────────

/** Tokens usable in step text (task titles, notifications, emails, field values). */
export const AUTOMATION_MERGE_FIELDS: {key: string; label: string; objects?: AutoObject[]}[] = [
  {key: 'contact.first_name', label: 'Contact first name'},
  {key: 'contact.last_name', label: 'Contact last name'},
  {key: 'contact.full_name', label: 'Contact full name'},
  {key: 'contact.email', label: 'Contact email'},
  {key: 'contact.phone', label: 'Contact phone'},
  {key: 'contact.title', label: 'Contact job title'},
  {key: 'company.name', label: 'Company name'},
  {key: 'deal.title', label: 'Deal title'},
  {key: 'deal.value', label: 'Deal value'},
  {key: 'deal.stage', label: 'Deal stage'},
  {key: 'ticket.number', label: 'Ticket number'},
  {key: 'ticket.subject', label: 'Ticket subject'},
  {key: 'ticket.status', label: 'Ticket status'},
  {key: 'ticket.priority', label: 'Ticket priority'},
  {key: 'owner.name', label: 'Record owner name'},
  {key: 'owner.first_name', label: 'Record owner first name'},
  {key: 'owner.email', label: 'Record owner email'},
  {key: 'record.name', label: 'Record name'},
  {key: 'record.url', label: 'Link to the record'},
  {key: 'automation.name', label: 'Automation name'},
];

// ─── Validation ─────────────────────────────────────────────────────────────

export type Problem = {stepId: string | null; message: string};

const hasRules = (c: Conditions | undefined) => !!c?.blocks.some((b) => b.rules.groups.some((g) => g.rules.length));
const isTime = (t: string | null | undefined) => !t || /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

export type AutomationDraft = {name: string; object: AutoObject; trigger: Trigger; steps: Step[]};

/**
 * What stops an automation from being switched on. Checks shapes only; the
 * server also checks that referenced lists, users, pipelines and fields exist.
 */
export function automationProblems(a: AutomationDraft): Problem[] {
  const out: Problem[] = [];
  const add = (stepId: string | null, message: string) => out.push({stepId, message});
  if (!a.name.trim()) add(null, 'Give the automation a name');
  const t = a.trigger;
  if (t.kind === 'event') {
    const def = EVENT_TRIGGERS[t.event];
    if (!def) add(null, 'Pick the event that starts the automation');
    else if (!def.objects.includes(a.object)) add(null, `"${eventLabel(t.event)}" can't run on ${a.object === 'none' ? 'no record' : OBJECTS[a.object].plural}`);
  } else if (t.kind === 'date') {
    if (a.object === 'none') add(null, 'Date triggers need a record type');
    if (!t.field) add(null, 'Pick the date the automation waits for');
    if (!(t.amount >= 0)) add(null, 'The offset must be zero or more');
    if (!isTime(t.time)) add(null, 'Use a time of day like 09:00');
  } else if (t.kind === 'inactivity') {
    const rule = INACTIVITY_RULES[t.rule];
    if (!rule) add(null, 'Pick an inactivity rule');
    else if (!rule.objects.includes(a.object)) add(null, `"${rule.label}" doesn't apply to ${a.object === 'none' ? 'no record' : OBJECTS[a.object].plural}`);
    if (!(t.amount > 0)) add(null, 'The inactivity period must be more than zero');
    if (t.rule === 'in_list' && !t.listId) add(null, 'Pick the static list');
  } else if (t.kind === 'manual') {
    if (a.object === 'none') add(null, 'Manual automations run on a record type');
  }
  const all = flattenSteps(a.steps);
  if (!all.length) add(null, 'Add at least one step');
  if (all.length > MAX_STEPS) add(null, `An automation can have up to ${MAX_STEPS} steps`);
  const targets = TARGETS[a.object];
  for (const {step: s} of all) {
    const need = (cond: unknown, message: string) => {
      if (!cond) add(s.id, message);
    };
    if (s.target && !targets.includes(s.target)) add(s.id, 'This record type has no such related record');
    switch (s.type) {
      case 'if':
        need(hasRules(s.conditions), 'Add at least one condition');
        break;
      case 'update_field':
        need(s.target, 'Pick which record to update');
        need(s.field, 'Pick the field to update');
        if (s.field && s.mode !== 'clear' && s.mode !== 'relative') need(s.value !== undefined && s.value !== null && s.value !== '' && !(Array.isArray(s.value) && !s.value.length), 'Fill in the new value');
        if (s.mode === 'relative') need(typeof s.days === 'number', 'Fill in the number of days');
        break;
      case 'assign_owner':
        need(s.target, 'Pick which record to assign');
        need(s.assignMode === 'user' ? s.userId : s.userIds?.length, s.assignMode === 'user' ? 'Pick the new owner' : 'Pick the people in the rotation');
        break;
      case 'create_task':
        need(s.title?.trim(), 'Give the task a title');
        need(s.assignee !== 'user' || s.userId, 'Pick who the task is for');
        need(isTime(s.time), 'Use a time of day like 09:00');
        break;
      case 'create_deal':
        need(s.title?.trim(), 'Give the deal a title');
        need(s.pipelineId && s.stageId, 'Pick the pipeline and stage');
        need(s.assignee !== 'user' || s.userId, 'Pick the deal owner');
        break;
      case 'create_ticket':
        need(s.subject?.trim(), 'Give the ticket a subject');
        need(s.assignee !== 'user' || s.userId, 'Pick the assignee');
        break;
      case 'add_tag':
      case 'remove_tag':
        need(s.target, 'Pick which record to tag');
        need(s.tag?.trim(), 'Fill in the tag');
        break;
      case 'add_to_list':
      case 'remove_from_list':
        need(targets.includes('contact'), 'Lists hold contacts: this record type has no contact');
        need(s.listId, 'Pick the static list');
        break;
      case 'send_email':
        need(targets.includes('contact'), 'Emails go to a contact: this record type has no contact');
        need(s.subject?.trim(), 'Fill in the subject');
        need(s.html?.replace(/<[^>]+>/g, '').trim() || /<img\b/i.test(s.html ?? ''), 'Write the email');
        need(s.from !== 'shared' || s.accountId, 'Pick the shared mailbox');
        break;
      case 'notify':
        need(s.title?.trim(), 'Fill in the notification text');
        need(s.assignee !== 'user' || s.userIds?.length, 'Pick who to notify');
        break;
      case 'webhook':
        need(webhookTarget(s.url), `Use a webhook URL from ${WEBHOOK_SERVICE_NAMES}`);
        break;
      case 'wait':
        if (s.waitMode === 'until_date') {
          need(s.target && s.field, 'Pick the date to wait for');
        } else if (s.waitMode === 'until_weekday') {
          need(s.weekdays?.length, 'Pick at least one weekday');
          need(s.time && isTime(s.time), 'Use a time of day like 09:00');
        } else need((s.amount ?? 0) > 0 && s.unit, 'Fill in how long to wait');
        break;
    }
  }
  return out;
}

// ─── Summaries ──────────────────────────────────────────────────────────────

const unitLabel = (n: number, unit: string) => `${n} ${n === 1 ? unit.replace(/s$/, '') : unit}`;

/** "When a deal is won", "3 days before Expected close date at 09:00", … (names of fields resolved by `fieldLabel`). */
export function triggerSummary(object: AutoObject, t: Trigger, fieldLabel: (key: string) => string = (k) => k) {
  switch (t.kind) {
    case 'event':
      return t.event ? `When: ${eventLabel(t.event)}` : 'Pick a trigger';
    case 'date': {
      const what = t.source === 'booking' ? 'a booked meeting' : fieldLabel(t.field) || 'a date';
      const offset = t.amount ? `${unitLabel(t.amount, t.unit)} ${t.direction}` : 'On';
      return `${offset} ${what}${t.time && t.unit === 'days' ? ` at ${t.time}` : ''}`;
    }
    case 'inactivity':
      return `${INACTIVITY_RULES[t.rule]?.label ?? 'Inactive for'} ${unitLabel(t.amount, t.unit)}`;
    case 'manual':
      return `Started by hand on ${object === 'none' ? 'a record' : OBJECTS[object].plural}`;
  }
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One line per step for the builder cards and the run history. */
export function stepSummary(s: Step, names: {field?: (target: Target, key: string) => string; list?: (id: string) => string; user?: (id: string) => string} = {}) {
  const field = (t: Target | undefined, k: string | undefined) => (t && k ? names.field?.(t, k) ?? k : 'a field');
  const who = (mode: AssigneeMode | undefined) => (mode === 'owner' ? 'the owner' : mode === 'assignee' ? 'the ticket assignee' : mode === 'creator' ? 'the automation creator' : mode === 'user' ? 'a chosen person' : 'nobody');
  switch (s.type) {
    case 'if':
      return `${s.conditions?.blocks.reduce((n, b) => n + b.rules.groups.reduce((m, g) => m + g.rules.length, 0), 0) ?? 0} condition(s)`;
    case 'update_field':
      return s.mode === 'clear' ? `Clear ${field(s.target, s.field)}` : s.mode === 'relative' ? `Set ${field(s.target, s.field)} to ${s.days ?? '?'} days from now` : `Set ${field(s.target, s.field)}`;
    case 'assign_owner':
      return s.assignMode === 'round_robin' ? `Round robin among ${s.userIds?.length ?? 0} people` : `Assign to ${s.userId ? names.user?.(s.userId) ?? 'a person' : '…'}`;
    case 'create_task':
      return `${s.title || 'Untitled task'} · due in ${unitLabel(s.dueDays ?? 0, 'days')} · for ${who(s.assignee)}`;
    case 'create_deal':
      return s.title || 'New deal';
    case 'create_ticket':
      return s.subject || 'New ticket';
    case 'add_tag':
      return `Add "${s.tag || '…'}"`;
    case 'remove_tag':
      return `Remove "${s.tag || '…'}"`;
    case 'add_to_list':
      return `Add to ${s.listId ? names.list?.(s.listId) ?? 'a list' : '…'}`;
    case 'remove_from_list':
      return `Remove from ${s.listId ? names.list?.(s.listId) ?? 'a list' : '…'}`;
    case 'send_email':
      return s.subject || 'No subject yet';
    case 'notify':
      return `${s.title || '…'} → ${who(s.assignee)}${s.email ? ' (+ email)' : ''}`;
    case 'webhook':
      return s.url || 'No URL yet';
    case 'wait':
      if (s.waitMode === 'until_date') return `Until ${field(s.target, s.field)}`;
      if (s.waitMode === 'until_weekday') return `Until next ${(s.weekdays ?? []).map((d) => WEEKDAY_SHORT[d]).join(' / ') || '…'} at ${s.time ?? '09:00'}`;
      return `For ${unitLabel(s.amount ?? 0, s.unit ?? 'days')}`;
    case 'stop':
      return 'End the run';
  }
}

// ─── Recipes ────────────────────────────────────────────────────────────────

export type Recipe = {
  key: string;
  name: string;
  description: string;
  object: AutoObject;
  trigger: Trigger;
  steps: Step[];
  /** Names the builder resolves to ids when the recipe is used (lists, stages). */
  hints?: {listName?: string; stageName?: string};
};

const block = (target: Target, rules: SegmentRules['groups'][number]['rules']): ConditionBlock => ({target, rules: {match: 'all', groups: [{match: 'all', rules}]}});

/** Starting points in "New automation". Ids are fixed strings; the builder gives the copy fresh ones. */
export const RECIPES: Recipe[] = [
  {
    key: 'form-task',
    name: 'Form submitted → follow-up task for the owner',
    description: 'Every form response gets a task for the contact owner, due tomorrow.',
    object: 'contact',
    trigger: {kind: 'event', event: 'form.submitted', filter: {}},
    steps: [{id: 'r1', type: 'create_task', title: 'Follow up with {{contact.full_name}}', description: 'They just submitted a form.', dueDays: 1, time: '09:00', taskType: 'CALL', priority: 'NORMAL', assignee: 'owner'}],
  },
  {
    key: 'deal-won-onboarding',
    name: 'Deal won → onboarding ticket, Customers list, lifecycle Customer',
    description: 'Opens an onboarding ticket, adds the contact to your "Customers" list and makes them a customer.',
    object: 'deal',
    trigger: {kind: 'event', event: 'deal.won', filter: {}},
    hints: {listName: 'Customers'},
    steps: [
      {id: 'r1', type: 'create_ticket', subject: 'Onboarding: {{deal.title}}', description: 'Kick off onboarding for {{company.name}}.', priority: 'NORMAL', assignee: 'owner'},
      {id: 'r2', type: 'add_to_list', listId: ''},
      {id: 'r3', type: 'update_field', target: 'contact', field: 'lifecycleStage', value: 'CUSTOMER'},
    ],
  },
  {
    key: 'hot-lead',
    name: 'Lead score turns Hot → Qualified + tell the owner',
    description: 'When a contact moves up into the Hot band, set lifecycle to Qualified and notify the owner.',
    object: 'contact',
    trigger: {kind: 'event', event: 'contact.score_changed', filter: {band: 'hot', bandDirection: 'up'}},
    steps: [
      {id: 'r1', type: 'update_field', target: 'contact', field: 'lifecycleStage', value: 'QUALIFIED'},
      {id: 'r2', type: 'notify', assignee: 'owner', title: '🔥 {{contact.full_name}} is now a hot lead', body: 'Lead score crossed into Hot.', email: false},
    ],
  },
  {
    key: 'ticket-waiting',
    name: 'Ticket waiting on us for 24 h → notify assignee + raise priority',
    description: 'Nudges the assignee and bumps the priority to High when a customer has waited a day.',
    object: 'ticket',
    trigger: {kind: 'inactivity', rule: 'ticket_waiting', amount: 24, unit: 'hours'},
    steps: [
      {id: 'r1', type: 'notify', assignee: 'assignee', title: 'Ticket #{{ticket.number}} has waited 24 h: {{ticket.subject}}', email: false},
      {id: 'r2', type: 'update_field', target: 'ticket', field: 'priority', value: 'HIGH'},
    ],
  },
  {
    key: 'close-date-task',
    name: '3 days before expected close → task for the owner',
    description: 'A reminder task at 09:00, three days before an open deal is due to close.',
    object: 'deal',
    trigger: {kind: 'date', source: 'record', field: 'expectedCloseDate', amount: 3, unit: 'days', direction: 'before', time: '09:00', zone: 'automation', conditions: {match: 'all', blocks: [block('deal', [{field: 'status', op: 'is_any', values: ['OPEN']}])]}},
    steps: [{id: 'r1', type: 'create_task', title: 'Close plan for {{deal.title}}', dueDays: 0, time: '12:00', taskType: 'TODO', priority: 'HIGH', assignee: 'owner'}],
  },
  {
    key: 'meeting-stage',
    name: 'Meeting booked → move the deal to "Meeting"',
    description: 'When a contact books a meeting, move their open deal to your "Meeting" stage.',
    object: 'deal',
    trigger: {kind: 'event', event: 'meeting.booked', filter: {}},
    hints: {stageName: 'Meeting'},
    steps: [{id: 'r1', type: 'update_field', target: 'deal', field: 'stageId', value: ''}],
  },
  {
    key: 'reply-task',
    name: 'Email replied → follow-up task',
    description: 'A contact replied: give the owner a task to answer today.',
    object: 'contact',
    trigger: {kind: 'event', event: 'email.received', filter: {}},
    steps: [{id: 'r1', type: 'create_task', title: 'Answer {{contact.full_name}}', dueDays: 0, time: null, taskType: 'EMAIL', priority: 'NORMAL', assignee: 'owner'}],
  },
  {
    key: 'form-round-robin',
    name: 'New contact from a form without owner → round robin',
    description: 'Shares form leads evenly among the people you pick.',
    object: 'contact',
    trigger: {kind: 'event', event: 'form.submitted', filter: {}, conditions: {match: 'all', blocks: [block('contact', [{field: 'ownerId', op: 'empty'}])]}},
    steps: [{id: 'r1', type: 'assign_owner', target: 'contact', assignMode: 'round_robin', userIds: [], onlyIfEmpty: true}],
  },
  {
    key: 'deal-stale',
    name: 'Deal with no activity for 14 days → notify the owner',
    description: 'Flags open deals that went quiet.',
    object: 'deal',
    trigger: {kind: 'inactivity', rule: 'no_activity', amount: 14, unit: 'days', conditions: {match: 'all', blocks: [block('deal', [{field: 'status', op: 'is_any', values: ['OPEN']}])]}},
    steps: [{id: 'r1', type: 'notify', assignee: 'owner', title: '{{deal.title}} has had no activity for 14 days', email: false}],
  },
  {
    key: 'contact-restored',
    name: 'Contact restored → notify the owner',
    description: 'Someone brought a contact back from the recycle bin.',
    object: 'contact',
    trigger: {kind: 'event', event: 'contact.restored', filter: {}},
    steps: [{id: 'r1', type: 'notify', assignee: 'owner', title: '{{contact.full_name}} was restored from the recycle bin', email: false}],
  },
  {
    key: 'contact-merged',
    name: 'Contacts merged → notify the owner',
    description: 'Lets the owner know two of their contacts became one.',
    object: 'contact',
    trigger: {kind: 'event', event: 'contact.merged', filter: {}},
    steps: [{id: 'r1', type: 'notify', assignee: 'owner', title: 'A duplicate was merged into {{contact.full_name}}', email: false}],
  },
  {
    key: 'sla-breach',
    name: 'SLA breached → urgent + notify the assignee',
    description: 'Raises the priority to Urgent and pings the assignee by email too.',
    object: 'ticket',
    trigger: {kind: 'event', event: 'ticket.sla_breached', filter: {}},
    steps: [
      {id: 'r1', type: 'update_field', target: 'ticket', field: 'priority', value: 'URGENT'},
      {id: 'r2', type: 'notify', assignee: 'assignee', title: 'SLA breached on #{{ticket.number}}: {{ticket.subject}}', email: true},
    ],
  },
  {
    key: 'welcome-email',
    name: 'New contact → welcome email the next day',
    description: 'Waits a day, then sends one branded welcome email (opted-out contacts are skipped).',
    object: 'contact',
    trigger: {kind: 'event', event: 'contact.created', filter: {}, conditions: {match: 'all', blocks: [block('contact', [{field: 'email', op: 'not_empty'}])]}},
    steps: [
      {id: 'r1', type: 'wait', waitMode: 'duration', amount: 1, unit: 'days'},
      {id: 'r2', type: 'send_email', subject: 'Welcome, {{contact.first_name|there}}', html: '<p>Hi {{contact.first_name|there}},</p><p>Thanks for getting in touch. Reply to this email any time if you have questions.</p><p>{{me.name}}</p>', layout: 'branded', from: 'owner'},
    ],
  },
  {
    key: 'renewal-task',
    name: '30 days before a renewal date → renewal task',
    description: 'Pick your custom renewal date field; the owner gets a task a month ahead.',
    object: 'company',
    trigger: {kind: 'date', source: 'record', field: '', amount: 30, unit: 'days', direction: 'before', time: '09:00', zone: 'owner'},
    steps: [{id: 'r1', type: 'create_task', title: 'Renewal coming up: {{company.name}}', dueDays: 7, time: null, taskType: 'TODO', priority: 'NORMAL', assignee: 'owner'}],
  },
];
