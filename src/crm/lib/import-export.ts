/**
 * Import & export, shared by the drawers and the server: what a CSV column can
 * map to (with header synonyms for auto-matching), the import options, the
 * export columns, and the value parsers (yes/no, numbers, dates, option
 * values) that both sides apply the same way, so the preview in the drawer
 * and the server's dry run agree. Server: src/server/lib/{imports,exports}.ts.
 */
import type * as P from '../../generated/prisma/client';
import {BUYING_ROLES, COMPANY_SIZES, LEAD_STATUSES, LIFECYCLE} from '@/lib/format';
import type {Jsonify} from '@/lib/types';

export type IoEntity = 'contact' | 'company' | 'deal';

export const IO_ENTITIES: Record<IoEntity, {one: string; many: string; path: '/contacts' | '/companies' | '/deals'; fieldEntity: 'CONTACT' | 'COMPANY' | 'DEAL'}> = {
  contact: {one: 'contact', many: 'contacts', path: '/contacts', fieldEntity: 'CONTACT'},
  company: {one: 'company', many: 'companies', path: '/companies', fieldEntity: 'COMPANY'},
  deal: {one: 'deal', many: 'deals', path: '/deals', fieldEntity: 'DEAL'},
};

/** Up to this many rows download straight away; bigger exports always run as a job and are emailed. */
export const DIRECT_EXPORT_ROWS = 2_000;
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
/** Export and import files are deleted this long after they were made. */
export const IO_FILE_DAYS = 7;

// ─── Import targets ─────────────────────────────────────────────────────────

/**
 * text: kept as written (`suggest` only fixes the casing of known values);
 * enum / multi: one / several of `options` (custom selects may get new options);
 * list: tags, contact emails.
 */
export type TargetKind = 'text' | 'email' | 'number' | 'integer' | 'date' | 'boolean' | 'enum' | 'multi' | 'list';

export type ImportTarget = {
  key: string;
  label: string;
  kind: TargetKind;
  group: 'Fields' | 'Related records' | 'Custom fields';
  synonyms?: string[];
  options?: {value: string; label: string}[];
  /** Custom select fields: unknown values may become new options. */
  allowNew?: boolean;
  /** Known values whose casing is fixed ("decision maker" → "Decision maker"). */
  suggest?: readonly string[];
  /** A blank cell may clear the value on update (when "don't overwrite with blanks" is off). */
  clearable?: boolean;
  hint?: string;
};

const T = (key: string, label: string, kind: TargetKind, synonyms: string[] = [], extra: Partial<ImportTarget> = {}): ImportTarget => ({
  key,
  label,
  kind,
  group: 'Fields',
  synonyms,
  clearable: kind === 'text' || kind === 'number' || kind === 'integer' || kind === 'date' || kind === 'email',
  ...extra,
});
const R = (key: string, label: string, kind: TargetKind, synonyms: string[], extra: Partial<ImportTarget> = {}) => T(key, label, kind, synonyms, {group: 'Related records', clearable: false, ...extra});

const opts = (o: Record<string, {label: string}> | readonly string[]) =>
  Array.isArray(o) ? o.map((v: string) => ({value: v, label: v})) : Object.entries(o as Record<string, {label: string}>).map(([value, v]) => ({value, label: v.label}));

export const DEAL_STATUSES = {OPEN: {label: 'Open'}, WON: {label: 'Won'}, LOST: {label: 'Lost'}};
export const DEAL_PRIORITIES = ['Low', 'Medium', 'High'] as const;
export const DEAL_TYPES = ['New business', 'Existing business'] as const;

const ID = T('id', 'Record ID', 'text', ['record id'], {clearable: false, hint: 'Matches records exported from here'});
const OWNER = R('owner', 'Owner', 'text', ['owner', 'owner email', 'owner name', 'contact owner', 'company owner', 'deal owner', 'record owner', 'assigned to', 'sales rep', 'account manager', 'account owner'], {hint: 'Team member email or name'});
const TAGS = T('tags', 'Tags', 'list', ['tags', 'tag', 'labels', 'label'], {clearable: false, hint: 'Separated by , ; or |'});
const NOTE = R('note', 'Note', 'text', ['notes', 'note', 'comments', 'comment', 'remarks'], {hint: 'Added as a note on the record'});

const CONTACT_TARGETS: ImportTarget[] = [
  ID,
  T('fullName', 'Full name', 'text', ['name', 'full name', 'contact name', 'contact', 'person', 'display name'], {clearable: false, hint: 'Split into first and last name'}),
  T('firstName', 'First name', 'text', ['first name', 'first', 'firstname', 'given name', 'forename'], {clearable: false}),
  T('lastName', 'Last name', 'text', ['last name', 'last', 'lastname', 'surname', 'family name']),
  T('email', 'Email', 'email', ['email', 'e mail', 'email address', 'e mail address', 'mail', 'work email', 'primary email', 'business email']),
  T('phone', 'Phone', 'text', ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'telephone', 'tel', 'work phone', 'direct phone']),
  T('title', 'Job title', 'text', ['job title', 'title', 'position', 'role', 'designation', 'job role']),
  T('linkedin', 'LinkedIn', 'text', ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url']),
  T('lifecycleStage', 'Lifecycle stage', 'enum', ['lifecycle stage', 'lifecycle', 'stage', 'contact stage'], {options: opts(LIFECYCLE), clearable: false}),
  T('leadStatus', 'Lead status', 'text', ['lead status', 'status'], {suggest: LEAD_STATUSES}),
  T('buyingRole', 'Buying role', 'text', ['buying role', 'role in deal', 'persona'], {suggest: BUYING_ROLES}),
  T('source', 'Source', 'text', ['source', 'lead source', 'original source', 'channel']),
  T('city', 'City', 'text', ['city', 'town']),
  T('country', 'Country', 'text', ['country', 'country region', 'nation']),
  T('emailOptOut', 'Email opt-out', 'boolean', ['email opt out', 'opted out', 'unsubscribed', 'do not email', 'opt out'], {clearable: false}),
  TAGS,
  OWNER,
  R('company', 'Company name', 'text', ['company', 'company name', 'organization', 'organisation', 'organization name', 'account', 'account name', 'employer', 'business'], {hint: 'Linked, or created when new'}),
  R('companyDomain', 'Company domain', 'text', ['company domain', 'domain', 'company website', 'website', 'web site', 'url'], {hint: 'Matches the company by domain first'}),
  NOTE,
];

const COMPANY_TARGETS: ImportTarget[] = [
  ID,
  T('name', 'Name', 'text', ['name', 'company', 'company name', 'organization', 'organisation', 'organization name', 'account', 'account name', 'business name'], {clearable: false}),
  T('domain', 'Domain', 'text', ['domain', 'company domain', 'domain name', 'website domain']),
  T('website', 'Website', 'text', ['website', 'web site', 'url', 'website url', 'homepage', 'site', 'web']),
  T('industry', 'Industry', 'text', ['industry', 'sector', 'vertical']),
  T('type', 'Type', 'text', ['type', 'company type', 'account type', 'relationship']),
  T('size', 'Size', 'text', ['size', 'company size', 'size range', 'headcount range'], {suggest: COMPANY_SIZES}),
  T('employees', 'Employees', 'integer', ['employees', 'number of employees', 'employee count', 'no of employees', 'headcount', 'staff']),
  T('annualRevenue', 'Annual revenue', 'number', ['annual revenue', 'revenue', 'yearly revenue', 'turnover']),
  T('phone', 'Phone', 'text', ['phone', 'phone number', 'company phone', 'telephone', 'tel', 'main phone']),
  T('address', 'Street address', 'text', ['address', 'street', 'street address', 'address 1', 'address line 1', 'billing street']),
  T('city', 'City', 'text', ['city', 'town', 'billing city']),
  T('state', 'State / region', 'text', ['state', 'region', 'province', 'state region', 'county', 'billing state']),
  T('postalCode', 'Postal code', 'text', ['postal code', 'zip', 'zip code', 'postcode', 'post code', 'billing zip']),
  T('country', 'Country', 'text', ['country', 'country region', 'billing country']),
  T('timezone', 'Time zone', 'text', ['time zone', 'timezone', 'tz']),
  T('linkedin', 'LinkedIn', 'text', ['linkedin', 'linkedin url', 'linkedin page', 'company linkedin']),
  T('description', 'Description', 'text', ['description', 'about', 'summary', 'overview']),
  TAGS,
  OWNER,
  NOTE,
];

const DEAL_TARGETS: ImportTarget[] = [
  ID,
  T('title', 'Deal name', 'text', ['deal name', 'deal', 'deal title', 'title', 'name', 'opportunity', 'opportunity name'], {clearable: false}),
  T('value', 'Amount', 'number', ['amount', 'value', 'deal value', 'deal amount', 'price', 'deal size', 'total'], {clearable: false}),
  T('currency', 'Currency', 'text', ['currency', 'currency code'], {clearable: false}),
  R('pipeline', 'Pipeline', 'text', ['pipeline', 'deal pipeline', 'sales pipeline'], {hint: 'By name; blank = the default pipeline'}),
  R('stage', 'Stage', 'text', ['stage', 'deal stage', 'pipeline stage', 'sales stage'], {hint: 'By name, in the deal’s pipeline'}),
  T('status', 'Status', 'enum', ['status', 'deal status', 'won lost', 'outcome', 'result'], {options: opts(DEAL_STATUSES), clearable: false}),
  T('lostReason', 'Lost reason', 'text', ['lost reason', 'closed lost reason', 'reason lost', 'loss reason']),
  T('expectedCloseDate', 'Expected close date', 'date', ['expected close date', 'close date', 'closing date', 'expected close', 'target close date']),
  T('closedAt', 'Closed on', 'date', ['closed on', 'closed date', 'date closed', 'won date', 'lost date', 'actual close date'], {clearable: false, hint: 'For won / lost deals'}),
  T('type', 'Deal type', 'text', ['deal type', 'type', 'business type'], {suggest: DEAL_TYPES}),
  T('priority', 'Priority', 'enum', ['priority', 'deal priority'], {options: opts(DEAL_PRIORITIES)}),
  TAGS,
  OWNER,
  R('company', 'Company name', 'text', ['company', 'company name', 'organization', 'organisation', 'account', 'account name', 'customer'], {hint: 'Linked, or created when new'}),
  R('companyDomain', 'Company domain', 'text', ['company domain', 'domain', 'company website', 'website']),
  R('contacts', 'Contact emails', 'list', ['contacts', 'contact emails', 'contact email', 'email', 'emails', 'associated contacts', 'contact'], {hint: 'Existing contacts, by email'}),
  NOTE,
];

const BASE_TARGETS: Record<IoEntity, ImportTarget[]> = {contact: CONTACT_TARGETS, company: COMPANY_TARGETS, deal: DEAL_TARGETS};

type FieldDef = Pick<P.CustomFieldDef, 'key' | 'label' | 'type' | 'options'>;

export function customTarget(def: FieldDef): ImportTarget {
  const kind: TargetKind =
    def.type === 'NUMBER' || def.type === 'CURRENCY' ? 'number' : def.type === 'DATE' ? 'date' : def.type === 'CHECKBOX' ? 'boolean' : def.type === 'SELECT' ? 'enum' : def.type === 'MULTISELECT' ? 'multi' : 'text';
  return {
    key: `custom.${def.key}`,
    label: def.label,
    kind,
    group: 'Custom fields',
    synonyms: [def.label, def.key],
    options: kind === 'enum' || kind === 'multi' ? def.options.map((o) => ({value: o, label: o})) : undefined,
    allowNew: kind === 'enum' || kind === 'multi',
    clearable: kind !== 'boolean' && kind !== 'multi',
  };
}

export function importTargets(entity: IoEntity, defs: FieldDef[]): ImportTarget[] {
  return [...BASE_TARGETS[entity], ...defs.map(customTarget)];
}

/** "E-mail Address" → "e mail address"; accents and punctuation folded away. */
export const normHeader = (h: string) =>
  h
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const squash = (s: string) => normHeader(s).replace(/ /g, '');

/**
 * Best guess per column: exact synonym / label (spacing and punctuation
 * ignored), custom fields first when their label matches exactly, then the
 * same with a leading "contact" / "company" / "deal" / "primary" dropped.
 * Each target is used once (the first matching column wins).
 */
export function guessMapping(entity: IoEntity, headers: string[], defs: FieldDef[]): (string | null)[] {
  const targets = importTargets(entity, defs);
  const custom = targets.filter((t) => t.group === 'Custom fields');
  const ordered = [...custom, ...targets.filter((t) => t.group !== 'Custom fields')];
  const used = new Set<string>();
  const find = (h: string) =>
    ordered.find((t) => !used.has(t.key) && [t.label, ...(t.synonyms ?? [])].some((s) => squash(s) === h));
  return headers.map((header) => {
    const h = squash(header);
    if (!h) return null;
    const stripped = normHeader(header).replace(/^(contact|company|deal|primary|main|the)\s+/, '').replace(/ /g, '');
    const hit = find(h) ?? (stripped !== h ? find(stripped) : undefined);
    if (!hit) return null;
    used.add(hit.key);
    return hit.key;
  });
}

// ─── Import options ─────────────────────────────────────────────────────────

export type ImportMode = 'create' | 'update' | 'upsert';
export type DateOrder = 'mdy' | 'dmy';
/** Per target, per value (`valueKey(raw)`): an option value, `NEW_OPTION + label` (add it as an option) or SKIP_VALUE. */
export type ValueMap = Record<string, Record<string, string>>;
export const NEW_OPTION = '__new__:';
export const SKIP_VALUE = '__skip__';

export type ImportOptions = {
  mode: ImportMode;
  /** Don't overwrite existing values with blank cells. */
  skipBlanks: boolean;
  dateOrder: DateOrder;
  /** Contacts: add every imported (and matched) contact to this static list. */
  listId: string | null;
  /** Tag every imported row. */
  tag: string | null;
  /** Owner for rows without one: 'me', a user id, or null (no owner). */
  defaultOwner: string | null;
  /** Contacts / deals: create companies that don't exist yet. */
  createCompanies: boolean;
  /** Deals without a pipeline column (or a blank cell). Null = the default pipeline. */
  pipelineId: string | null;
  emailMe: boolean;
  valueMap: ValueMap;
};

export const defaultImportOptions = (): ImportOptions => ({
  mode: 'upsert',
  skipBlanks: true,
  dateOrder: 'mdy',
  listId: null,
  tag: null,
  defaultOwner: 'me',
  createCompanies: true,
  pipelineId: null,
  emailMe: false,
  valueMap: {},
});

/** The match rule an import uses, in words. */
export const MATCH_RULES: Record<IoEntity, string> = {
  contact: 'Record ID, then email',
  company: 'Record ID, then domain, then name',
  deal: 'Record ID, then deal name + company',
};

// ─── Value parsing (browser preview and server agree) ───────────────────────

/** Trims, and undoes the apostrophe our exports put in front of =, +, - and @ (formula safety). */
export const cleanCell = (v: string | undefined | null) => {
  const s = (v ?? '').trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
};

export const valueKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const TRUE = new Set(['true', 'yes', 'y', '1', 'x', 'on', 'checked', '✓', '✔', 'ja', 'si', 'oui']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', 'unchecked', 'nein', 'non', '-']);

/** Yes/no cells: true/yes/y/1/x/on/checked vs false/no/n/0/off. Anything else is undefined (a warning). */
export function parseBool(s: string): boolean | undefined {
  const k = valueKey(s);
  if (TRUE.has(k)) return true;
  if (FALSE.has(k)) return false;
  return undefined;
}

/**
 * Numbers with currency signs, spaces and thousands separators: "$12,500.50",
 * "12.500,50 €", "1 200", "(300)" → -300. With both separators the last one is
 * the decimal mark; a lone comma is decimal unless exactly three digits follow
 * ("1,250" = 1250, "12,5" = 12.5).
 */
export function parseNumber(s: string): number | undefined {
  let t = s.trim();
  if (!t) return undefined;
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/^[^\d-]+/, ''));
  t = t.replace(/[()\s\u00a0'’]/g, '');
  // Only a currency sign / code or % may surround the number ("$1,200", "12 EUR", "15%"); "2.5m" is not a number.
  const m = /^([$€£¥₹৳]|[A-Za-z]{3})?-?([\d.,]+)([$€£¥₹৳%]|[A-Za-z]{3})?$/.exec(t);
  if (!m) return undefined;
  t = m[2]!;
  if (!/\d/.test(t)) return undefined;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = t.split(',');
    t = parts.length === 2 && parts[1]!.length !== 3 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else if ((t.match(/\./g) ?? []).length > 1) {
    t = t.replace(/\./g, ''); // 1.250.000
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y: number, m: number, d: number) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return undefined; // 31 April
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Dates as YYYY-MM-DD: ISO (2026-03-31, with or without a time), 2026/03/31,
 * day-first or month-first numbers (31/03/2026, 03-31-26) as `order` says,
 * month names (31 Mar 2026, March 31, 2026) and Excel serial numbers (46112).
 */
export function parseDate(s: string, order: DateOrder): string | undefined {
  const t = s.trim();
  if (!t) return undefined;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(t);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(t);
  if (m) return order === 'dmy' ? ymd(+m[3]!, +m[2]!, +m[1]!) : ymd(+m[3]!, +m[1]!, +m[2]!);
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const serial = Math.floor(Number(t));
    if (serial < 20_000 || serial > 80_000) return undefined; // 1954 … 2119
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // "31 Mar 2026", "March 31, 2026", "Mar 31 2026"
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?[\s-]+(\d{2,4})$/i.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return month >= 0 ? ymd(+m[3]!, month + 1, +m[1]!) : undefined;
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/i.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    return month >= 0 ? ymd(+m[3]!, month + 1, +m[2]!) : undefined;
  }
  return undefined;
}

/** Day-first or month-first, from values like 31/03/2026 (only one reading is valid); null when every value fits both. */
export function detectDateOrder(values: string[]): DateOrder | null {
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(v.trim());
    if (!m) continue;
    if (+m[1]! > 12 && +m[2]! <= 12) return 'dmy';
    if (+m[2]! > 12 && +m[1]! <= 12) return 'mdy';
  }
  return null;
}

/** "a; b, c | d" → ["a", "b", "c", "d"] */
export const splitList = (s: string) =>
  s
    .split(/[;,|\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

const LIFECYCLE_SYNONYMS: Record<string, string> = {
  subscriber: 'LEAD',
  lead: 'LEAD',
  new: 'LEAD',
  prospect: 'LEAD',
  mql: 'QUALIFIED',
  'marketing qualified lead': 'QUALIFIED',
  sql: 'QUALIFIED',
  'sales qualified lead': 'QUALIFIED',
  qualified: 'QUALIFIED',
  opportunity: 'OPPORTUNITY',
  customer: 'CUSTOMER',
  client: 'CUSTOMER',
  churned: 'CHURNED',
  'former customer': 'CHURNED',
  evangelist: 'OTHER',
  other: 'OTHER',
};

const STATUS_SYNONYMS: Record<string, string> = {
  open: 'OPEN',
  active: 'OPEN',
  'in progress': 'OPEN',
  won: 'WON',
  'closed won': 'WON',
  win: 'WON',
  lost: 'LOST',
  'closed lost': 'LOST',
  loss: 'LOST',
};

/**
 * One option value for a cell: the user's choice in the value map first, then
 * an option whose value or label matches (any case), then known synonyms.
 * `new` means "add as a new option"; `unknown` is a warning on the row.
 */
export function resolveOption(target: ImportTarget, raw: string, valueMap: ValueMap): {value: string} | {skip: true} | {new: string} | {unknown: true} {
  const k = valueKey(raw);
  const chosen = valueMap[target.key]?.[k];
  if (chosen === SKIP_VALUE) return {skip: true};
  if (chosen?.startsWith(NEW_OPTION)) return target.allowNew ? {new: chosen.slice(NEW_OPTION.length).trim() || raw.trim()} : {unknown: true};
  if (chosen && target.options?.some((o) => o.value === chosen)) return {value: chosen};
  const hit = target.options?.find((o) => valueKey(o.value) === k || valueKey(o.label) === k);
  if (hit) return {value: hit.value};
  const synonym = target.key === 'lifecycleStage' ? LIFECYCLE_SYNONYMS[k] : target.key === 'status' ? STATUS_SYNONYMS[k] : undefined;
  if (synonym) return {value: synonym};
  return {unknown: true};
}

/** Known values keep their usual casing ("decision maker" → "Decision maker"). */
export const suggestCase = (target: ImportTarget, raw: string) => target.suggest?.find((s) => valueKey(s) === valueKey(raw)) ?? raw;

/** "Ann Lee <ann@x.com>" / "mailto:ann@x.com" → "ann@x.com" */
export const emailOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v.replace(/^mailto:/i, '')).trim().toLowerCase();

export type ParsedCell = {value?: unknown; warnings?: string[]; newOptions?: string[]};

/**
 * One non-blank value as its target stores it: numbers, dates, yes / no,
 * options (with the value map and synonyms), lists. A value that can't be
 * read comes back without `value` and with a warning. Shared by CSV imports
 * and incoming webhooks, so both read values the same way.
 */
export function parseCell(t: ImportTarget, raw: string, opts: {dateOrder: DateOrder; valueMap: ValueMap}): ParsedCell {
  switch (t.kind) {
    case 'text':
      return {value: suggestCase(t, raw)};
    case 'email':
      return {value: emailOf(raw)};
    case 'number':
    case 'integer': {
      const n = parseNumber(raw);
      if (n === undefined) return {warnings: [`"${raw}" is not a number; ${t.label} left out`]};
      return {value: t.kind === 'integer' ? Math.round(n) : n};
    }
    case 'date': {
      const d = parseDate(raw, opts.dateOrder);
      return d ? {value: d} : {warnings: [`"${raw}" is not a date we can read; ${t.label} left out`]};
    }
    case 'boolean': {
      const b = parseBool(raw);
      return b === undefined ? {warnings: [`"${raw}" is not yes / no; ${t.label} left out`]} : {value: b};
    }
    case 'enum': {
      const r = resolveOption(t, raw, opts.valueMap);
      if ('value' in r) return {value: r.value};
      if ('new' in r) return {value: r.new, newOptions: [r.new]};
      if ('unknown' in r) return {warnings: [`"${raw}" is not an option of ${t.label}; left out`]};
      return {};
    }
    case 'multi': {
      const out: string[] = [];
      const fresh: string[] = [];
      const warnings: string[] = [];
      for (const part of splitList(raw)) {
        const r = resolveOption(t, part, opts.valueMap);
        if ('value' in r) out.push(r.value);
        else if ('new' in r) {
          out.push(r.new);
          fresh.push(r.new);
        } else if ('unknown' in r) warnings.push(`"${part}" is not an option of ${t.label}; left out`);
      }
      return {value: [...new Set(out)], newOptions: fresh.length ? fresh : undefined, warnings};
    }
    case 'list':
      return {value: splitList(raw)};
  }
}

// ─── Export columns ─────────────────────────────────────────────────────────

export type ExportColumn = {key: string; label: string; group: 'Fields' | 'Related records' | 'Custom fields' | 'System'};

const C = (key: string, label: string, group: ExportColumn['group'] = 'Fields'): ExportColumn => ({key, label, group});

/** Labels match the import synonyms, so an export imports back cleanly (Record ID matches the rows). */
export const EXPORT_COLUMNS: Record<IoEntity, ExportColumn[]> = {
  contact: [
    C('id', 'Record ID', 'System'),
    C('firstName', 'First name'),
    C('lastName', 'Last name'),
    C('email', 'Email'),
    C('phone', 'Phone'),
    C('title', 'Job title'),
    C('linkedin', 'LinkedIn'),
    C('lifecycleStage', 'Lifecycle stage'),
    C('leadStatus', 'Lead status'),
    C('buyingRole', 'Buying role'),
    C('source', 'Source'),
    C('city', 'City'),
    C('country', 'Country'),
    C('emailOptOut', 'Email opt-out'),
    C('tags', 'Tags'),
    C('score', 'Lead score'),
    C('company', 'Company name', 'Related records'),
    C('companyDomain', 'Company domain', 'Related records'),
    C('owner', 'Owner', 'Related records'),
    C('ownerEmail', 'Owner email', 'Related records'),
    C('createdAt', 'Created', 'System'),
    C('updatedAt', 'Updated', 'System'),
    C('lastActivityAt', 'Last activity', 'System'),
  ],
  company: [
    C('id', 'Record ID', 'System'),
    C('name', 'Name'),
    C('domain', 'Domain'),
    C('website', 'Website'),
    C('industry', 'Industry'),
    C('type', 'Type'),
    C('size', 'Size'),
    C('employees', 'Employees'),
    C('annualRevenue', 'Annual revenue'),
    C('phone', 'Phone'),
    C('address', 'Street address'),
    C('city', 'City'),
    C('state', 'State / region'),
    C('postalCode', 'Postal code'),
    C('country', 'Country'),
    C('timezone', 'Time zone'),
    C('linkedin', 'LinkedIn'),
    C('description', 'Description'),
    C('tags', 'Tags'),
    C('contactCount', 'Contacts', 'Related records'),
    C('openDeals', 'Open deals', 'Related records'),
    C('owner', 'Owner', 'Related records'),
    C('ownerEmail', 'Owner email', 'Related records'),
    C('createdAt', 'Created', 'System'),
    C('lastActivityAt', 'Last activity', 'System'),
  ],
  deal: [
    C('id', 'Record ID', 'System'),
    C('title', 'Deal name'),
    C('value', 'Amount'),
    C('currency', 'Currency'),
    C('pipeline', 'Pipeline'),
    C('stage', 'Stage'),
    C('status', 'Status'),
    C('lostReason', 'Lost reason'),
    C('expectedCloseDate', 'Expected close date'),
    C('closedAt', 'Closed on'),
    C('type', 'Deal type'),
    C('priority', 'Priority'),
    C('tags', 'Tags'),
    C('company', 'Company name', 'Related records'),
    C('companyDomain', 'Company domain', 'Related records'),
    C('contacts', 'Contact emails', 'Related records'),
    C('owner', 'Owner', 'Related records'),
    C('ownerEmail', 'Owner email', 'Related records'),
    C('createdAt', 'Created', 'System'),
    C('lastActivityAt', 'Last activity', 'System'),
  ],
};

export const exportColumns = (entity: IoEntity, defs: Pick<P.CustomFieldDef, 'key' | 'label'>[]): ExportColumn[] => [
  ...EXPORT_COLUMNS[entity],
  ...defs.map((d) => C(`custom.${d.key}`, d.label, 'Custom fields')),
];

// ─── API shapes ─────────────────────────────────────────────────────────────

export type ImportCounts = {create: number; update: number; skip: number; errors: number; warnings: number; newCompanies?: number};
export type ImportStats = {companiesCreated?: number; listAdded?: number; notes?: number};
export type ImportIssueRow = Jsonify<P.ImportIssue>;
export type ImportRun = Omit<Jsonify<P.Import>, 'mapping' | 'options' | 'preview' | 'stats'> & {
  mapping: (string | null)[];
  options: ImportOptions;
  preview: ImportCounts | null;
  stats: ImportStats;
  hasFile: boolean;
  hasErrorFile: boolean;
};
export type ImportDetail = {import: ImportRun; issues: ImportIssueRow[]; issueCount: number};
export type ExportRun = Omit<Jsonify<P.Export>, 'filters'> & {filters: Record<string, string>; downloadUrl: string | null};

export const ACTIVE_IMPORT = new Set(['validating', 'queued', 'running']);
export const isActive = (status: string) => ACTIVE_IMPORT.has(status);
export const ACTIVE_EXPORT = new Set(['queued', 'running']);
