/**
 * Incoming webhooks, shared by Settings → Webhooks → Incoming (browser) and
 * the server (src/server/lib/incoming-webhooks.ts): the actions, the config
 * shape, the field catalogue (the import targets from import-export.ts, plus
 * a few ticket fields), reading dot paths out of a payload, and the
 * auto-suggested mapping for a captured sample.
 *
 * A mapping row reads `path` from the payload (`data.customer.email`,
 * `items[0].name`) and writes it to `target`, which is `<entity>.<import
 * target key>` (`contact.email`, `deal.value`, `contact.custom.plan`). Values
 * are read with the same parsers as CSV imports (`parseCell()`).
 */
import type * as P from '../../generated/prisma/client';
import {importTargets, normHeader, type ImportTarget} from '@/lib/import-export';
import {TICKET_PRIORITIES, type TicketPriority} from '@/lib/tickets';

export type InAction = 'contact' | 'company' | 'deal' | 'ticket' | 'automations';
export type InEntity = 'contact' | 'company' | 'deal' | 'ticket';

export const IN_ACTIONS: Record<InAction, {label: string; short: string; hint: string; entities: InEntity[]}> = {
  contact: {label: 'Create or update a contact', short: 'Contact', hint: 'Matched by email, then phone.', entities: ['contact']},
  company: {label: 'Create or update a company', short: 'Company', hint: 'Matched by domain, then name.', entities: ['company']},
  deal: {label: 'Create a deal', short: 'Deal', hint: 'Linked to the contact with that email; the contact is created when new.', entities: ['contact', 'deal']},
  ticket: {label: 'Create a ticket', short: 'Ticket', hint: "From the customer's email; the contact is created when new.", entities: ['contact', 'ticket']},
  automations: {label: 'Only start automations', short: 'Automations only', hint: 'Writes no record. Automations that start on "Incoming webhook received" run with the data.', entities: ['contact']},
};

export const IN_ACTION_KEYS = Object.keys(IN_ACTIONS) as InAction[];

export const ENTITY_LABEL: Record<InEntity, string> = {contact: 'Contact', company: 'Company', deal: 'Deal', ticket: 'Ticket'};

/** upsert: create or update · create: only new records · update: only existing ones (for deals / tickets: the contact). */
export type InMode = 'upsert' | 'create' | 'update';
export const IN_MODES: Record<InMode, string> = {upsert: 'Create and update', create: 'Only create new', update: 'Only update existing'};

export type InOwner = {mode: 'none' | 'user' | 'round_robin'; userId?: string | null; userIds?: string[]; next?: number};
export type InMappingRow = {path: string; target: string};
export type InFixedRow = {target: string; value: string};

export type InConfig = {
  mapping: InMappingRow[];
  /** Constant values, applied after the mapping (they win). */
  fixed: InFixedRow[];
  /** Added to the record the action writes (contact, company, deal or ticket). */
  tags: string[];
  /** Static list the contact joins (contact, deal and ticket actions). */
  listId: string | null;
  /** Owner of new records (deals: the deal; tickets: the assignee). */
  owner: InOwner;
  mode: InMode;
  /** Blank values never clear what a record already has. */
  skipBlanks: boolean;
  deal: {pipelineId: string | null; stageId: string | null; title: string};
  ticket: {subject: string; priority: TicketPriority; category: string | null};
  /** Dot path of a unique id in the payload (e.g. `id`): repeats with the same value are ignored. */
  idempotencyPath: string;
  /** Requests per minute this URL accepts. */
  rateLimit: number;
};

export const RATE_LIMIT_DEFAULT = 120;
export const MAX_BODY_BYTES = 256 * 1024;
export const LISTEN_MINUTES = 10;
export const REQUEST_KEEP_DAYS = 30;

export const defaultInConfig = (): InConfig => ({
  mapping: [],
  fixed: [],
  tags: [],
  listId: null,
  owner: {mode: 'none'},
  mode: 'upsert',
  skipBlanks: true,
  deal: {pipelineId: null, stageId: null, title: ''},
  ticket: {subject: '', priority: 'NORMAL', category: null},
  idempotencyPath: '',
  rateLimit: RATE_LIMIT_DEFAULT,
});

export const inConfig = (raw: unknown): InConfig => {
  const d = defaultInConfig();
  const c = (raw ?? {}) as Partial<InConfig>;
  return {...d, ...c, deal: {...d.deal, ...c.deal}, ticket: {...d.ticket, ...c.ticket}, owner: {...d.owner, ...c.owner}};
};

export type InVerify = 'none' | 'header' | 'hmac';
export const IN_VERIFY: Record<InVerify, {label: string; hint: string}> = {
  none: {label: 'URL only', hint: 'The secret URL is the only key. Fine for most tools.'},
  header: {label: 'Shared secret header', hint: 'The sender also puts a secret in a header you name.'},
  hmac: {label: 'HMAC-SHA256 signature', hint: 'The sender signs the raw body with a shared key (Stripe-style tools, your own app).'},
};

// ─── Field catalogue ────────────────────────────────────────────────────────

export type InTarget = ImportTarget & {entity: InEntity; field: string; groupLabel: string};
type FieldDef = Pick<P.CustomFieldDef, 'key' | 'label' | 'type' | 'options'>;
export type InDefs = {CONTACT: FieldDef[]; COMPANY: FieldDef[]; DEAL: FieldDef[]};

const TICKET_TARGETS: ImportTarget[] = [
  {key: 'subject', label: 'Subject', kind: 'text', group: 'Fields', synonyms: ['subject', 'title', 'summary', 'topic', 'issue'], clearable: false},
  {key: 'description', label: 'Description', kind: 'text', group: 'Fields', synonyms: ['description', 'message', 'body', 'details', 'comment', 'comments', 'content', 'text', 'question'], clearable: false},
  {key: 'priority', label: 'Priority', kind: 'enum', group: 'Fields', synonyms: ['priority', 'urgency', 'severity'], options: TICKET_PRIORITIES.map((p) => ({value: p.value, label: p.label})), clearable: false},
  {key: 'category', label: 'Category', kind: 'text', group: 'Fields', synonyms: ['category', 'type', 'kind'], clearable: false},
  {key: 'tags', label: 'Tags', kind: 'list', group: 'Fields', synonyms: ['tags', 'tag', 'labels', 'label'], clearable: false},
];

/** Targets that would only confuse a webhook mapping (Record ID; deal contact emails come from the contact). */
const SKIP = new Set(['id', 'deal.contacts']);

function entityTargets(entity: InEntity, defs: InDefs): InTarget[] {
  const base = entity === 'ticket' ? TICKET_TARGETS : importTargets(entity, entity === 'contact' ? defs.CONTACT : entity === 'company' ? defs.COMPANY : defs.DEAL);
  return base
    .filter((t) => !SKIP.has(t.key) && !SKIP.has(`${entity}.${t.key}`))
    .map((t) => ({...t, key: `${entity}.${t.key}`, field: t.key, entity, groupLabel: t.group === 'Custom fields' ? `${ENTITY_LABEL[entity]} · custom fields` : ENTITY_LABEL[entity]}));
}

/** What an action's mapping can write to. "Only start automations" only reads email / phone to find the contact. */
export function inTargets(action: InAction, defs: InDefs): InTarget[] {
  if (action === 'automations') return entityTargets('contact', defs).filter((t) => t.field === 'email' || t.field === 'phone').map((t) => ({...t, hint: 'Used to find the contact; nothing is written'}));
  return IN_ACTIONS[action].entities.flatMap((e) => entityTargets(e, defs));
}

// ─── Payload paths ──────────────────────────────────────────────────────────

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** `data.customer.email`, `items[0].name`, `items.0.name`, `$.a.b` → the value, or undefined when it isn't there. */
export function getPath(data: unknown, path: string): unknown {
  const parts = path.trim().replace(/^\$\.?/, '').match(/[^.[\]]+/g);
  if (!parts) return undefined;
  let cur: unknown = data;
  for (const raw of parts) {
    const part = raw.replace(/^["']|["']$/g, '');
    if (cur === null || typeof cur !== 'object' || UNSAFE.has(part)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

/**
 * A payload value as the text a parser reads: undefined when the path is
 * missing, '' for null / empty, lists of plain values joined with ", ".
 */
export function cellOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return v.filter((x) => x !== null && x !== '').join(', ');
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

export type SamplePath = {path: string; value: string; type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'};

/** Every leaf of a sample as a pickable path (arrays: the first 3 items), at most `max`. */
export function samplePaths(data: unknown, max = 300): SamplePath[] {
  const out: SamplePath[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      const plain = v.every((x) => x === null || typeof x !== 'object');
      if (plain || depth > 6) {
        if (path) out.push({path, value: cellOf(v) ?? '', type: 'array'});
        return;
      }
      v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    if (v !== null && typeof v === 'object') {
      if (depth > 6) {
        if (path) out.push({path, value: JSON.stringify(v).slice(0, 200), type: 'object'});
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, path ? (/^[\w-]+$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`) : k, depth + 1);
      return;
    }
    if (path) out.push({path, value: v === null ? '' : String(v).slice(0, 200), type: v === null ? 'null' : (typeof v as 'string' | 'number' | 'boolean')});
  };
  walk(data, '', 0);
  return out;
}

// ─── Suggested mapping ──────────────────────────────────────────────────────

const squash = (s: string) => normHeader(s).replace(/ /g, '');
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');

const HINTS: [RegExp, InEntity][] = [
  [/deal|order|opportunit|purchase|checkout|invoice|subscription/i, 'deal'],
  [/ticket|issue|case|support|request/i, 'ticket'],
  [/company|organi[sz]ation|account|business|employer/i, 'company'],
];

/**
 * Best CRM field per sample path: the last two segments ("customer email",
 * "company name"), then the last one ("first_name" / "firstName" → First
 * name), matched against labels and import synonyms. Paths under a "deal" /
 * "order" / "ticket" / "company" key prefer that entity. Each field once.
 */
export function suggestMapping(paths: string[], targets: InTarget[]): InMappingRow[] {
  const used = new Set<string>();
  const out: InMappingRow[] = [];
  const entities = [...new Set(targets.map((t) => t.entity))];
  for (const path of paths) {
    const segs = path.replace(/\[\d+\]/g, '').split(/[.[\]"]+/).filter(Boolean);
    if (!segs.length) continue;
    const last = words(segs.at(-1)!);
    const lastTwo = segs.length > 1 ? `${words(segs.at(-2)!)} ${last}` : null;
    const hinted = HINTS.find(([re]) => segs.slice(0, -1).some((s) => re.test(s)))?.[1];
    const order = hinted && entities.includes(hinted) ? [hinted, ...entities.filter((e) => e !== hinted)] : entities;
    const pick = (label: string) => {
      const key = squash(label);
      for (const e of order) {
        const pool = targets.filter((t) => t.entity === e && !used.has(t.key));
        // Custom fields first when their label matches exactly, like the import.
        const hit = [...pool.filter((t) => t.group === 'Custom fields'), ...pool.filter((t) => t.group !== 'Custom fields')].find((t) =>
          [t.label, ...(t.synonyms ?? [])].some((s) => squash(s) === key),
        );
        if (hit) return hit;
      }
      return undefined;
    };
    const stripped = lastTwo?.replace(/^(contact|customer|person|user|lead|client|billing|primary|the|data|payload|object)\s+/i, '');
    const hit = (lastTwo && pick(lastTwo)) || (stripped && stripped !== lastTwo && pick(stripped)) || pick(last);
    if (!hit) continue;
    used.add(hit.key);
    out.push({path, target: hit.key});
  }
  return out;
}

/** A unique id in the sample that looks like an event / object id, for the idempotency path. */
export function suggestIdempotencyPath(paths: SamplePath[]) {
  const names = ['id', 'event_id', 'eventId', 'idempotency_key', 'request_id', 'requestId', 'uuid', 'data.id', 'data.object.id'];
  return names.find((n) => paths.some((p) => p.path === n && p.value)) ?? '';
}

// ─── Example body (for the curl helper) ─────────────────────────────────────

export function exampleBody(action: InAction): Record<string, unknown> {
  const person = {email: 'maya.patel@northwind.example', first_name: 'Maya', last_name: 'Patel', phone: '+1 415 555 0142', company: 'Northwind Traders'};
  if (action === 'company') return {id: 'evt_1001', company: {name: 'Northwind Traders', domain: 'northwind.example', industry: 'Logistics', employees: 120}};
  if (action === 'deal') return {id: 'evt_1001', customer: person, order: {title: 'Annual plan', amount: 1800, currency: 'USD'}};
  if (action === 'ticket') return {id: 'evt_1001', customer: person, subject: 'Invoice shows the wrong address', message: 'Our March invoice still has our old address.'};
  if (action === 'automations') return {id: 'evt_1001', event: 'trial.started', customer: {email: person.email}};
  return {id: 'evt_1001', customer: person, plan: 'Pro'};
}

// ─── Request log ────────────────────────────────────────────────────────────

export type InRequestStatus = 'accepted' | 'processed' | 'failed' | 'duplicate' | 'rejected' | 'captured';

export const IN_STATUSES: Record<InRequestStatus, {label: string; tone: 'green' | 'amber' | 'rose' | 'neutral' | 'violet' | 'blue'}> = {
  accepted: {label: 'Accepted', tone: 'blue'},
  processed: {label: 'Processed', tone: 'green'},
  failed: {label: 'Failed', tone: 'rose'},
  duplicate: {label: 'Duplicate', tone: 'neutral'},
  rejected: {label: 'Rejected', tone: 'amber'},
  captured: {label: 'Test capture', tone: 'violet'},
};

export type InResult = {
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'none';
  entity?: InEntity;
  recordId?: string | null;
  label?: string | null;
  reason?: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  ticketId?: string | null;
  warnings?: string[];
  duplicateOf?: string;
  /** Ids already created by an earlier attempt (retries never create them twice). */
  steps?: Record<string, string>;
};

export type InSample = {payload: unknown; contentType: string | null; headers: Record<string, string>; at: string};

export type IncomingWebhookRow = {
  id: string;
  name: string;
  active: boolean;
  action: InAction;
  config: InConfig;
  verify: InVerify;
  verifyHeader: string | null;
  verifyEncoding: 'hex' | 'base64' | null;
  hasSecret: boolean;
  url: string;
  listening: boolean;
  listenUntil: string | null;
  sample: InSample | null;
  sampleAt: string | null;
  lastRequestAt: string | null;
  lastStatus: InRequestStatus | null;
  createdAt: string;
  stats: {day: number; failed: number};
};

export type IncomingRequestRow = {
  id: string;
  status: InRequestStatus;
  createdAt: string;
  processedAt: string | null;
  contentType: string | null;
  size: number;
  error: string | null;
  attempts: number;
  result: InResult | null;
  headers: Record<string, string>;
  /** The received body as pretty JSON, cut to a few KB. */
  body: string | null;
  truncated: boolean;
};

/** Where a written record opens in the app. */
export const recordPath = (entity: InEntity, id: string) => (entity === 'contact' ? `/contacts/${id}` : entity === 'company' ? `/companies/${id}` : entity === 'deal' ? `/deals/${id}` : `/tickets/${id}`);
