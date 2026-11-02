/**
 * Dynamic segment rules, shared by the list builder (browser) and the
 * translator in src/server/lib/segments.ts (rules → Prisma `where`).
 *
 * A segment is groups of rules: `match` at the top combines the groups, each
 * group's `match` combines its rules. Incomplete rules (no value yet) are
 * ignored; a segment without one complete rule matches nobody.
 */
import type {CustomField} from '@/lib/types';

export type SegmentMatch = 'all' | 'any';

export type SegmentOp =
  // text
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  // choice (lifecycle, owner, select fields)
  | 'is_any'
  | 'is_none'
  // tags / multi-select
  | 'has_any'
  | 'has_all'
  | 'has_none'
  // yes/no
  | 'is_true'
  | 'is_false'
  // numbers
  | 'eq'
  | 'gt'
  | 'lt'
  // dates (value = YYYY-MM-DD, days = N)
  | 'in_last'
  | 'more_than'
  | 'before'
  | 'after'
  // activity (days = N)
  | 'not_in_last'
  | 'ever'
  | 'never'
  // list membership / deal pipeline
  | 'in'
  | 'not_in'
  | 'has'
  | 'has_not'
  // any nullable property
  | 'empty'
  | 'not_empty';

export type SegmentRule = {
  /** A SEGMENT_FIELDS key, or `custom.<key>` for a contact custom field. */
  field: string;
  op: SegmentOp;
  /** Text, number, date (YYYY-MM-DD), list id, form id or pipeline id. */
  value?: string;
  /** Choice / tag values. */
  values?: string[];
  /** "in the last N days" / "more than N days ago". */
  days?: number;
  /** deal.pipeline: optional stage inside the pipeline. */
  stageId?: string;
};

export type SegmentGroup = {match: SegmentMatch; rules: SegmentRule[]};
export type SegmentRules = {match: SegmentMatch; groups: SegmentGroup[]};

export type FieldKind = 'text' | 'choice' | 'tags' | 'bool' | 'number' | 'date' | 'activity' | 'list' | 'deal_pipeline';

/** Where a field's choices come from (the builder resolves them). */
export type OptionSource = 'lifecycle' | 'users' | 'sources' | 'lead_statuses' | 'buying_roles' | 'industries' | 'company_types' | 'company_sizes' | 'forms' | 'custom';

export type SegmentField = {
  key: string;
  label: string;
  group: 'Contact' | 'Custom fields' | 'Company' | 'Deals' | 'Activity' | 'Lists' | 'Ticket';
  kind: FieldKind;
  /** Suggestions (text) or choices (choice / tags). */
  options?: OptionSource;
  /** Can't be empty (no "is empty" / "is known" ops). */
  required?: boolean;
  /** Custom field options, when options === 'custom'. */
  choices?: string[];
  /** Ready-made choices with labels (ids → names); wins over `options` (automation conditions on deals / tickets). */
  pairs?: {value: string; label: string}[];
};

export const SEGMENT_FIELDS: SegmentField[] = [
  {key: 'firstName', label: 'First name', group: 'Contact', kind: 'text', required: true},
  {key: 'lastName', label: 'Last name', group: 'Contact', kind: 'text'},
  {key: 'email', label: 'Email', group: 'Contact', kind: 'text'},
  {key: 'phone', label: 'Phone', group: 'Contact', kind: 'text'},
  {key: 'title', label: 'Job title', group: 'Contact', kind: 'text'},
  {key: 'lifecycleStage', label: 'Lifecycle stage', group: 'Contact', kind: 'choice', options: 'lifecycle', required: true},
  {key: 'leadStatus', label: 'Lead status', group: 'Contact', kind: 'text', options: 'lead_statuses'},
  {key: 'buyingRole', label: 'Buying role', group: 'Contact', kind: 'text', options: 'buying_roles'},
  {key: 'ownerId', label: 'Owner', group: 'Contact', kind: 'choice', options: 'users'},
  {key: 'tags', label: 'Tags', group: 'Contact', kind: 'tags'},
  {key: 'source', label: 'Source', group: 'Contact', kind: 'text', options: 'sources'},
  {key: 'emailOptOut', label: 'Opted out of email', group: 'Contact', kind: 'bool'},
  {key: 'city', label: 'City', group: 'Contact', kind: 'text'},
  {key: 'country', label: 'Country', group: 'Contact', kind: 'text'},
  {key: 'createdAt', label: 'Created', group: 'Contact', kind: 'date', required: true},
  {key: 'lastActivityAt', label: 'Last activity', group: 'Contact', kind: 'date'},
  {key: 'score', label: 'Lead score', group: 'Contact', kind: 'number', required: true},

  {key: 'company.name', label: 'Company name', group: 'Company', kind: 'text', required: true},
  {key: 'company.industry', label: 'Company industry', group: 'Company', kind: 'text', options: 'industries'},
  {key: 'company.type', label: 'Company type', group: 'Company', kind: 'text', options: 'company_types'},
  {key: 'company.size', label: 'Company size', group: 'Company', kind: 'text', options: 'company_sizes'},
  {key: 'company.employees', label: 'Company employees', group: 'Company', kind: 'number'},
  {key: 'company.country', label: 'Company country', group: 'Company', kind: 'text'},

  {key: 'deal.open', label: 'Has an open deal', group: 'Deals', kind: 'bool'},
  {key: 'deal.won', label: 'Has a won deal', group: 'Deals', kind: 'bool'},
  {key: 'deal.pipeline', label: 'Has a deal in pipeline / stage', group: 'Deals', kind: 'deal_pipeline'},
  {key: 'deal.wonValue', label: 'Total won deal value', group: 'Deals', kind: 'number', required: true},

  {key: 'activity.form', label: 'Submitted a form', group: 'Activity', kind: 'activity', options: 'forms'},
  {key: 'activity.emailOpened', label: 'Opened an email', group: 'Activity', kind: 'activity'},
  {key: 'activity.emailReplied', label: 'Replied to an email', group: 'Activity', kind: 'activity'},
  {key: 'activity.meeting', label: 'Had a logged meeting', group: 'Activity', kind: 'activity'},
  {key: 'activity.call', label: 'Had a logged call', group: 'Activity', kind: 'activity'},

  {key: 'list', label: 'Member of list', group: 'Lists', kind: 'list'},
];

/** Contact custom fields as segment fields (`custom.<key>`). */
export function customSegmentFields(defs: Pick<CustomField, 'key' | 'label' | 'type' | 'options'>[]): SegmentField[] {
  const kind: Record<CustomField['type'], FieldKind> = {TEXT: 'text', URL: 'text', NUMBER: 'number', CURRENCY: 'number', DATE: 'date', SELECT: 'choice', MULTISELECT: 'tags', CHECKBOX: 'bool'};
  return defs.map((d) => ({key: `custom.${d.key}`, label: d.label, group: 'Custom fields', kind: kind[d.type], options: d.options.length ? 'custom' : undefined, choices: d.options}));
}

export const OPS: Record<FieldKind, {op: SegmentOp; label: string}[]> = {
  text: [
    {op: 'is', label: 'is'},
    {op: 'is_not', label: 'is not'},
    {op: 'contains', label: 'contains'},
    {op: 'not_contains', label: "doesn't contain"},
    {op: 'starts_with', label: 'starts with'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  choice: [
    {op: 'is_any', label: 'is any of'},
    {op: 'is_none', label: 'is none of'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  tags: [
    {op: 'has_any', label: 'has any of'},
    {op: 'has_all', label: 'has all of'},
    {op: 'has_none', label: 'has none of'},
    {op: 'not_empty', label: 'has any value'},
    {op: 'empty', label: 'is empty'},
  ],
  bool: [
    {op: 'is_true', label: 'is yes'},
    {op: 'is_false', label: 'is no'},
  ],
  number: [
    {op: 'eq', label: 'equals'},
    {op: 'gt', label: 'is greater than'},
    {op: 'lt', label: 'is less than'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  date: [
    {op: 'in_last', label: 'in the last'},
    {op: 'more_than', label: 'more than'},
    {op: 'before', label: 'is before'},
    {op: 'after', label: 'is after'},
    {op: 'not_empty', label: 'is known'},
    {op: 'empty', label: 'is unknown'},
  ],
  activity: [
    {op: 'in_last', label: 'in the last'},
    {op: 'not_in_last', label: 'not in the last'},
    {op: 'ever', label: 'ever'},
    {op: 'never', label: 'never'},
  ],
  list: [
    {op: 'in', label: 'is a member of'},
    {op: 'not_in', label: 'is not a member of'},
  ],
  deal_pipeline: [
    {op: 'has', label: 'has a deal in'},
    {op: 'has_not', label: 'has no deal in'},
  ],
};

/** Ops for a field, without "is empty" style ops on required properties. */
export function opsFor(field: SegmentField | undefined) {
  if (!field) return [];
  return OPS[field.kind].filter((o) => !(field.required && (o.op === 'empty' || o.op === 'not_empty')));
}

export type ValueShape = 'none' | 'text' | 'values' | 'number' | 'days' | 'date' | 'ref';

/** What a rule needs besides its op. */
export function valueShape(kind: FieldKind, op: SegmentOp): ValueShape {
  if (op === 'empty' || op === 'not_empty' || op === 'is_true' || op === 'is_false' || op === 'ever' || op === 'never') return 'none';
  if (kind === 'list' || kind === 'deal_pipeline') return 'ref';
  if (kind === 'choice' || kind === 'tags') return 'values';
  if (kind === 'number') return 'number';
  if (kind === 'date') return op === 'before' || op === 'after' ? 'date' : 'days';
  if (kind === 'activity') return 'days';
  return 'text';
}

/** True when the rule has everything it needs to be evaluated. */
export function ruleComplete(rule: SegmentRule, field: SegmentField | undefined): boolean {
  if (!field || !OPS[field.kind].some((o) => o.op === rule.op)) return false;
  switch (valueShape(field.kind, rule.op)) {
    case 'none':
      return true;
    case 'values':
      return !!rule.values?.length;
    case 'days':
      return typeof rule.days === 'number' && rule.days > 0;
    case 'number':
      return rule.value !== undefined && rule.value !== '' && !Number.isNaN(Number(rule.value));
    case 'date':
      return !!rule.value && /^\d{4}-\d{2}-\d{2}$/.test(rule.value);
    default:
      return !!rule.value?.trim();
  }
}

export const emptyRules = (): SegmentRules => ({match: 'all', groups: [{match: 'all', rules: [{field: 'lifecycleStage', op: 'is_any', values: []}]}]});

/** Normalises whatever is stored in ContactList.rules. */
export function asRules(raw: unknown): SegmentRules {
  const r = raw as Partial<SegmentRules> | null;
  if (!r || !Array.isArray(r.groups)) return {match: 'all', groups: []};
  return {match: r.match === 'any' ? 'any' : 'all', groups: r.groups.map((g) => ({match: g?.match === 'any' ? 'any' : 'all', rules: Array.isArray(g?.rules) ? g.rules : []}))};
}

/** Every list id a segment refers to (for cycle checks and "used by"). */
export const referencedLists = (rules: SegmentRules) => rules.groups.flatMap((g) => g.rules.filter((r) => r.field === 'list' && r.value).map((r) => r.value!));
