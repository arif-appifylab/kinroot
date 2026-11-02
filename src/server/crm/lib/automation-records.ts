/**
 * What an automation run sees: the record it is about plus its primary
 * related records (`loadRecords`), conditions over them (`evaluateConditions`)
 * and merge fields for step text (`fill`).
 */
import type {Company, Contact, Deal, Stage, Ticket} from '../../../generated/prisma/client';
import {RECORD_FIELDS, customRecordFields, ENTITY_OF, type AutoObject, type ConditionBlock, type Conditions, type RecordField, type Target} from '@/lib/automations';
import {ruleComplete, type SegmentRule} from '@/lib/segments';
import {PRIORITY, STATUS} from '@/lib/tickets';
import type {Db} from '../kit/db';
import {mergeFields, type MergeContext} from '../email/render';
import {segmentWhere} from './segments';

export type DealWithStage = Deal & {stage: Stage};

export type Records = {
  contact: Contact | null;
  company: Company | null;
  deal: DealWithStage | null;
  ticket: Ticket | null;
  /** The run's own record is gone (a *.deleted trigger): `snapshot` holds the event's copy. */
  missing: boolean;
  snapshot?: Record<string, unknown> | null;
};

const contactName = (c: {firstName: string; lastName: string | null} | null | undefined) => (c ? [c.firstName, c.lastName].filter(Boolean).join(' ') : '');

async function latestOpenDeal(db: Db, where: {contactId?: string; companyId?: string}) {
  return db.deal.findFirst({
    where: {status: 'OPEN', ...(where.contactId ? {contacts: {some: {contactId: where.contactId}}} : {companies: {some: {companyId: where.companyId}}})},
    orderBy: {lastActivityAt: 'desc'},
    include: {stage: true},
  });
}

/** The record plus its primary company, latest open deal, first contact… depending on the object. */
export async function loadRecords(db: Db, object: AutoObject, recordId: string | null, snapshot?: Record<string, unknown> | null): Promise<Records> {
  const empty: Records = {contact: null, company: null, deal: null, ticket: null, missing: false, snapshot};
  if (object === 'none' || !recordId) return empty;
  const records = await loadExisting(db, object, recordId, empty);
  // Gone (a *.deleted trigger): the event's copy stands in, read-only, for conditions and merge fields.
  return records.missing && snapshot ? {...records, [object]: snapshot} : records;
}

async function loadExisting(db: Db, object: Exclude<AutoObject, 'none'>, recordId: string, empty: Records): Promise<Records> {
  if (object === 'contact') {
    const contact = await db.contact.findUnique({where: {id: recordId}});
    if (!contact) return {...empty, missing: true};
    const link = await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, include: {company: true}});
    return {...empty, contact, company: link?.company ?? null, deal: await latestOpenDeal(db, {contactId: contact.id})};
  }
  if (object === 'company') {
    const company = await db.company.findUnique({where: {id: recordId}});
    if (!company) return {...empty, missing: true};
    return {...empty, company, deal: await latestOpenDeal(db, {companyId: company.id})};
  }
  if (object === 'deal') {
    const deal = await db.deal.findUnique({where: {id: recordId}, include: {stage: true}});
    if (!deal) return {...empty, missing: true};
    const link = await db.dealContact.findFirst({where: {dealId: deal.id}, include: {contact: true}});
    const company = deal.companyId ? await db.company.findUnique({where: {id: deal.companyId}}) : null;
    return {...empty, deal, contact: link?.contact ?? null, company};
  }
  const ticket = await db.ticket.findUnique({where: {id: recordId}});
  if (!ticket) return {...empty, missing: true};
  const [contact, company, deal] = await Promise.all([
    ticket.contactId ? db.contact.findUnique({where: {id: ticket.contactId}}) : null,
    ticket.companyId ? db.company.findUnique({where: {id: ticket.companyId}}) : null,
    ticket.dealId ? db.deal.findUnique({where: {id: ticket.dealId}, include: {stage: true}}) : null,
  ]);
  return {...empty, ticket, contact, company, deal};
}

export const recordOf = (r: Records, target: Target) => r[target] as (Contact | Company | DealWithStage | Ticket | null);

export function labelOf(target: Target | AutoObject, rec: unknown): string {
  const r = (rec ?? {}) as Record<string, unknown>;
  if (target === 'contact') return contactName(r as {firstName: string; lastName: string | null}) || String(r.email ?? 'Contact');
  if (target === 'company') return String(r.name ?? 'Company');
  if (target === 'deal') return String(r.title ?? 'Deal');
  if (target === 'ticket') return r.number ? `#${r.number} ${r.subject ?? ''}`.trim() : 'Ticket';
  return '';
}

/** The run's own record (or the deleted record's snapshot). */
export const primaryOf = (object: AutoObject, r: Records) => (object === 'none' ? null : recordOf(r, object));

/** Owner of a record: contacts / companies / deals have an owner, tickets an assignee. */
export function ownerIdOf(target: Target | AutoObject, rec: unknown): string | null {
  const r = (rec ?? {}) as Record<string, unknown>;
  return ((target === 'ticket' ? r.assigneeId : r.ownerId) as string | null | undefined) ?? null;
}

export function recordPath(target: Target | AutoObject, rec: unknown) {
  const r = (rec ?? {}) as Record<string, unknown>;
  if (!r.id) return null;
  if (target === 'contact') return `/contacts/${r.id}`;
  if (target === 'company') return `/companies/${r.id}`;
  if (target === 'deal') return `/deals/${r.id}`;
  if (target === 'ticket') return `/tickets/${r.number ?? r.id}`;
  return null;
}

// ─── Merge fields ───────────────────────────────────────────────────────────

export type MergeInput = {
  object: AutoObject;
  records: Records;
  automation: {name: string; origin: string};
  owner: {name: string; email: string} | null;
};

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TOKEN = /\{\{\s*([a-z_.]+)\s*(?:\|([^}]*))?\}\}/gi;

/** Values only automations know (the standard ones come from mergeFields()). */
function extraValues(m: MergeInput): Record<string, string | null | undefined> {
  const {contact, deal, ticket} = m.records;
  const primary = primaryOf(m.object, m.records);
  const path = m.object === 'none' ? null : recordPath(m.object, primary);
  return {
    'contact.phone': contact?.phone,
    'deal.stage': deal?.stage?.name,
    'ticket.number': ticket ? String(ticket.number) : null,
    'ticket.subject': ticket?.subject,
    'ticket.status': ticket ? STATUS[ticket.status]?.label : null,
    'ticket.priority': ticket ? PRIORITY[ticket.priority]?.label : null,
    'owner.name': m.owner?.name,
    'owner.first_name': m.owner?.name.split(' ')[0],
    'owner.email': m.owner?.email,
    'record.name': m.object === 'none' ? null : labelOf(m.object, primary),
    'record.url': path && m.automation.origin ? `${m.automation.origin}${path}` : path,
    'automation.name': m.automation.name,
  };
}

export const mergeContext = (m: MergeInput): MergeContext => ({
  contact: m.records.contact,
  company: m.records.company,
  deal: m.records.deal,
  me: m.owner ?? {name: m.automation.name, email: ''},
});

/**
 * Fills merge fields in step text. With `keepStandard`, only the
 * automation-only tokens are replaced and the standard ones are left for
 * sendEmail() / composeEmail() (which fill them with the email's own context).
 */
export function fill(text: string | null | undefined, m: MergeInput, opts: {html?: boolean; keepStandard?: boolean} = {}) {
  if (!text) return '';
  const extra = extraValues(m);
  const pre = text.replace(TOKEN, (all, key: string, fallback?: string) => {
    const k = key.toLowerCase();
    if (!(k in extra)) return all;
    const v = extra[k];
    return v ? (opts.html ? escapeHtml(v) : v) : (fallback?.trim() ?? '');
  });
  return opts.keepStandard ? pre : mergeFields(pre, mergeContext(m), {html: opts.html});
}

// ─── Conditions ─────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** Record fields (with custom fields) per target, loaded once per run. */
export async function fieldsFor(db: Db, target: Target): Promise<RecordField[]> {
  if (target === 'ticket') return RECORD_FIELDS.ticket;
  const defs = await db.customFieldDef.findMany({where: {entity: ENTITY_OF[target]}, select: {key: true, label: true, type: true, options: true}});
  return [...RECORD_FIELDS[target], ...customRecordFields(defs)];
}

export function fieldValue(rec: unknown, key: string): unknown {
  const r = (rec ?? {}) as Record<string, unknown>;
  if (key.startsWith('custom.')) return ((r.custom ?? {}) as Record<string, unknown>)[key.slice(7)];
  return r[key];
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' && v ? new Date(v.length === 10 ? `${v}T00:00:00Z` : v).getTime() : NaN);

/** One rule against a loaded record; null when the rule is incomplete (ignored, like in segments). */
export function ruleMatches(rec: unknown, rule: SegmentRule, field: RecordField | undefined, now = Date.now()): boolean | null {
  if (!field) return false; // deleted custom field: matches nothing, never widens
  // RecordField kinds are a subset of segment field kinds, so ruleComplete applies as is.
  if (!ruleComplete(rule, {key: field.key, label: field.label, group: 'Contact', kind: field.kind, required: field.required})) return null;
  const v = fieldValue(rec, rule.field);
  if (rule.op === 'empty') return isEmpty(v);
  if (rule.op === 'not_empty') return !isEmpty(v);
  switch (field.kind) {
    case 'text': {
      const a = String(v ?? '').toLowerCase();
      const b = (rule.value ?? '').trim().toLowerCase();
      if (rule.op === 'is') return a === b;
      if (rule.op === 'is_not') return a !== b;
      if (rule.op === 'contains') return a.includes(b);
      if (rule.op === 'not_contains') return !a.includes(b);
      if (rule.op === 'starts_with') return a.startsWith(b);
      return false;
    }
    case 'choice': {
      const values = rule.values ?? [];
      const has = !isEmpty(v) && values.includes(String(v));
      return rule.op === 'is_any' ? has : rule.op === 'is_none' ? !has : false;
    }
    case 'tags': {
      const arr = (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase());
      const values = (rule.values ?? []).map((x) => x.toLowerCase());
      if (rule.op === 'has_any') return values.some((x) => arr.includes(x));
      if (rule.op === 'has_all') return values.every((x) => arr.includes(x));
      if (rule.op === 'has_none') return !values.some((x) => arr.includes(x));
      return false;
    }
    case 'bool':
      return rule.op === 'is_true' ? v === true : rule.op === 'is_false' ? v !== true : false;
    case 'number': {
      if (isEmpty(v)) return false;
      const a = Number(v);
      const b = Number(rule.value);
      return rule.op === 'eq' ? a === b : rule.op === 'gt' ? a > b : rule.op === 'lt' ? a < b : false;
    }
    case 'date': {
      const ms = toMs(v);
      if (Number.isNaN(ms)) return false;
      if (rule.op === 'in_last') return ms >= now - (rule.days ?? 0) * DAY && ms <= now;
      if (rule.op === 'more_than') return ms < now - (rule.days ?? 0) * DAY;
      const day = toMs(rule.value);
      if (rule.op === 'before') return ms < day;
      if (rule.op === 'after') return ms >= day + DAY;
      return false;
    }
  }
}

/** Groups / rules combined like segments: all / any at both levels; no complete rule = no match. */
function rulesMatch(rec: unknown, block: ConditionBlock, fields: RecordField[], now: number) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const groups = block.rules.groups
    .map((g) => {
      const results = g.rules.map((r) => ruleMatches(rec, r, byKey.get(r.field), now)).filter((x): x is boolean => x !== null);
      return results.length ? (g.match === 'any' ? results.some(Boolean) : results.every(Boolean)) : null;
    })
    .filter((x): x is boolean => x !== null);
  if (!groups.length) return false;
  return block.rules.match === 'any' ? groups.some(Boolean) : groups.every(Boolean);
}

export type ConditionResult = {ok: boolean; blocks: {target: Target; ok: boolean; reason?: string}[]};

/**
 * True when no condition is set. Contact blocks run as segment rules against
 * this one contact; a deleted record (its event snapshot) is checked on its
 * last known properties instead.
 */
export async function evaluateConditions(db: Db, conditions: Conditions | undefined, records: Records): Promise<ConditionResult> {
  const blocks = (conditions?.blocks ?? []).filter((b) => b.rules.groups.some((g) => g.rules.length));
  if (!blocks.length) return {ok: true, blocks: []};
  const now = Date.now();
  const results: ConditionResult['blocks'] = [];
  for (const block of blocks) {
    const rec = recordOf(records, block.target);
    if (!rec) {
      results.push({target: block.target, ok: false, reason: `no ${block.target}`});
      continue;
    }
    if (block.target === 'contact' && !(records.missing && rec === records.snapshot)) {
      const where = await segmentWhere(db, block.rules);
      const n = await db.contact.count({where: {AND: [{id: (rec as Contact).id}, where]}});
      results.push({target: 'contact', ok: n > 0});
    } else {
      results.push({target: block.target, ok: rulesMatch(rec, block, await fieldsFor(db, block.target), now)});
    }
  }
  const ok = conditions?.match === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
  return {ok, blocks: results};
}
