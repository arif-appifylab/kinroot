/**
 * Data in API: the one catalogue of inbound actions other platforms call
 * (`POST /site-api/crm/public/data-in/v1/<path>`), shared by the server (request
 * validation: src/server/lib/data-in.ts builds each zod schema from `fields`)
 * and the UI (Settings → Webhooks → Incoming: field tables, samples, cURL).
 * The docs and the validation come from the same objects, so they can't drift.
 *
 * To add an action: an entry in DATA_IN_ACTIONS, a handler in HANDLERS
 * (src/server/lib/data-in.ts) and checks in scripts/test-data-in.mjs.
 */

export const DATA_IN_PATH = '/site-api/crm/public/data-in/v1';
export const dataInBaseUrl = (origin: string) => `${origin.replace(/\/$/, '')}${DATA_IN_PATH}`;

/** Signatures older or newer than this (seconds) are refused; each one works once within it. */
export const SIGNATURE_TOLERANCE_SEC = 300;
export const IDEMPOTENCY_HOURS = 24;
export const DATA_IN_MAX_BYTES = 256 * 1024;
export const DATA_IN_LOG_DAYS = 30;
export const DEFAULT_DATA_IN_RATE_LIMIT = 120;
/** Visible start of every API key (brand-neutral on purpose); the rest is random. */
export const API_KEY_PREFIX = 'crm_live_';
export const SIGNING_SECRET_PREFIX = 'crm_sig_';

// ─── Errors ─────────────────────────────────────────────────────────────────

export const DATA_IN_ERRORS = {
  E_UNAUTHORIZED: {status: 401, when: 'The Authorization header is missing, or the API key is unknown or revoked.'},
  E_KEY_OWNER_INACTIVE: {status: 403, when: 'The person who created the API key was deactivated or made read-only. Create a new key.'},
  E_SIGNATURE_MISSING: {status: 401, when: 'The X-Signature header is missing.'},
  E_SIGNATURE_INVALID: {status: 401, when: 'X-Signature is not "t=…,v1=…", or v1 is not the HMAC-SHA256 of "<t>.<raw body>" with the signing secret.'},
  E_SIGNATURE_EXPIRED: {status: 401, when: `t is more than ${SIGNATURE_TOLERANCE_SEC / 60} minutes away from the server's clock.`},
  E_SIGNATURE_REUSED: {status: 401, when: 'This exact signature was already used. Sign every request again.'},
  E_INVALID_JSON: {status: 400, when: 'The body is not a JSON object.'},
  E_INVALID_FIELD: {status: 422, when: 'A field is missing, unknown or has the wrong type or value; error.field names it (e.g. "tags.2").'},
  E_NOT_FOUND: {status: 404, when: 'A record the request refers to (by id, email or name) does not exist.'},
  E_IDEMPOTENCY_IN_PROGRESS: {status: 409, when: 'A request with the same Idempotency-Key is still running. Retry in a moment.'},
  E_PAYLOAD_TOO_LARGE: {status: 413, when: `The body is larger than ${DATA_IN_MAX_BYTES / 1024} KB.`},
  E_RATE_LIMITED: {status: 429, when: 'Too many requests with this key in the last minute. Wait and retry.'},
  E_INTERNAL: {status: 500, when: 'Something went wrong on our side. Safe to retry with the same Idempotency-Key.'},
} as const;

export type DataInErrorCode = keyof typeof DATA_IN_ERRORS;
export type DataInErrorBody = {error: {code: DataInErrorCode; message: string; field?: string}};

/** Every action can answer these. */
const COMMON_ERRORS: DataInErrorCode[] = [
  'E_UNAUTHORIZED',
  'E_KEY_OWNER_INACTIVE',
  'E_SIGNATURE_MISSING',
  'E_SIGNATURE_INVALID',
  'E_SIGNATURE_EXPIRED',
  'E_SIGNATURE_REUSED',
  'E_INVALID_JSON',
  'E_INVALID_FIELD',
  'E_IDEMPOTENCY_IN_PROGRESS',
  'E_PAYLOAD_TOO_LARGE',
  'E_RATE_LIMITED',
  'E_INTERNAL',
];

// ─── Actions ────────────────────────────────────────────────────────────────

export type DataInFieldType = 'string' | 'text' | 'email' | 'email[]' | 'number' | 'integer' | 'boolean' | 'datetime' | 'enum' | 'string[]' | 'object' | 'id';

export type DataInField = {
  name: string;
  type: DataInFieldType;
  required?: boolean;
  /** null clears the value on an update. */
  nullable?: boolean;
  description: string;
  /** enum: the possible values (case-insensitive on input). */
  values?: readonly string[];
  /** strings: max length; arrays: max items. */
  max?: number;
  min?: number;
};

export type DataInActionError = {code: DataInErrorCode; when: string};

export type DataInActionKey = 'contacts.upsert' | 'companies.upsert' | 'deals.create' | 'tickets.create' | 'notes.create' | 'activities.create' | 'lists.members' | 'events.create';

export type DataInAction = {
  key: DataInActionKey;
  title: string;
  method: 'POST';
  /** Relative to the base URL; `{name}` is a path parameter. */
  path: string;
  description: string;
  params?: DataInField[];
  fields: DataInField[];
  /** At least one of these must be sent. */
  oneOf?: string[];
  sample: Record<string, unknown>;
  sampleParams?: Record<string, string>;
  success: {status: number; body: Record<string, unknown>; note?: string};
  /** Errors specific to this action (COMMON_ERRORS apply too). */
  errors: DataInActionError[];
};

const LIFECYCLE = ['LEAD', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CHURNED', 'OTHER'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const KINDS = ['CALL', 'MEETING', 'EMAIL', 'SMS', 'LINKEDIN', 'WHATSAPP', 'POSTAL'] as const;

const owner = (what: string): DataInField => ({name: 'owner', type: 'email', description: `Email of the team member who owns the ${what}. New ${what === 'company' ? 'companies' : `${what}s`} default to the person who created the API key.`});
const tags = (what: string): DataInField => ({name: 'tags', type: 'string[]', max: 50, description: `Tags to add to the ${what}; tags it already has stay.`});
const custom = (what: string): DataInField => ({name: 'custom', type: 'object', description: `Custom fields of the ${what} by key (Settings → Fields), e.g. {"plan": "Pro"}. null clears one; unknown keys are refused.`});
const note = (what: string): DataInField => ({name: 'note', type: 'text', max: 20_000, description: `Adds a note to the ${what}.`});
const contactRef = (create: boolean): DataInField[] => [
  {name: 'contactId', type: 'id', description: 'Id of an existing contact.'},
  {name: 'contactEmail', type: 'email', description: create ? 'Email of the contact; a new contact is created when nobody has it.' : 'Email of an existing contact.'},
  ...(create
    ? ([
        {name: 'contactFirstName', type: 'string', max: 100, description: 'First name, used when the contact is created.'},
        {name: 'contactLastName', type: 'string', max: 100, description: 'Last name, used when the contact is created.'},
      ] as DataInField[])
    : []),
];

const ID = {contact: 'cmcontact0mayapatel0001', company: 'cmcompany0northwind0001', deal: 'cmdeal0northwindrenew01', ticket: 'cmticket0billing0000001', list: 'cmlist0newsletter000001', note: 'cmnote0renewalcall00001', interaction: 'cminteraction0call00001', event: 'cmevent0trialstarted001'};
const url = (path: string) => `https://crm.yourcompany.example${path}`;

export const DATA_IN_ACTIONS: DataInAction[] = [
  {
    key: 'contacts.upsert',
    title: 'Create or update a contact',
    method: 'POST',
    path: '/contacts',
    description:
      'Finds the contact by email (then by phone, when no email is sent or the contact found has none) and updates it, or creates it. Fields you leave out are kept; null clears a field. A company sent by name or domain is found or created and linked.',
    fields: [
      {name: 'email', type: 'email', description: 'Matched first (case-insensitive).'},
      {name: 'phone', type: 'string', max: 50, nullable: true, description: 'Matched when no email is sent, or the contact found by it has no email.'},
      {name: 'firstName', type: 'string', max: 100, description: 'New contacts without one get the part of the email before the @.'},
      {name: 'lastName', type: 'string', max: 100, nullable: true, description: 'Last name.'},
      {name: 'jobTitle', type: 'string', max: 200, nullable: true, description: 'Job title.'},
      {name: 'company', type: 'string', max: 200, description: 'Company name: found (by companyDomain first, then name) or created, and linked to the contact.'},
      {name: 'companyDomain', type: 'string', max: 200, description: 'Company website domain, e.g. northwind.example.'},
      owner('contact'),
      {name: 'lifecycleStage', type: 'enum', values: LIFECYCLE, description: 'Lifecycle stage.'},
      {name: 'leadStatus', type: 'string', max: 100, nullable: true, description: 'Lead status, e.g. "New".'},
      {name: 'buyingRole', type: 'string', max: 100, nullable: true, description: 'Buying role, e.g. "Decision maker".'},
      {name: 'source', type: 'string', max: 100, nullable: true, description: 'Where the contact came from. New contacts default to "API: <key name>".'},
      {name: 'city', type: 'string', max: 100, nullable: true, description: 'City.'},
      {name: 'country', type: 'string', max: 100, nullable: true, description: 'Country.'},
      {name: 'linkedin', type: 'string', max: 300, nullable: true, description: 'LinkedIn profile URL.'},
      {name: 'emailOptOut', type: 'boolean', description: 'true when the contact must not get marketing email.'},
      tags('contact'),
      {name: 'lists', type: 'string[]', max: 20, description: 'Static lists (ids or names) to add the contact to.'},
      custom('contact'),
      note('contact'),
    ],
    oneOf: ['email', 'phone'],
    sample: {
      email: 'maya.patel@northwind.example',
      firstName: 'Maya',
      lastName: 'Patel',
      jobTitle: 'Head of Operations',
      company: 'Northwind Traders',
      companyDomain: 'northwind.example',
      lifecycleStage: 'LEAD',
      source: 'Website',
      tags: ['trial'],
      custom: {plan: 'Pro'},
    },
    success: {
      status: 201,
      note: '201 when created; 200 when an existing contact was updated (outcome "updated") or already matched (outcome "unchanged").',
      body: {ok: true, action: 'contacts.upsert', result: {outcome: 'created', id: ID.contact, url: url(`/contacts/${ID.contact}`), companyId: ID.company, lists: []}},
    },
    errors: [
      {code: 'E_INVALID_FIELD', when: 'Neither email nor phone is sent, a custom field key is unknown, or a select value is not one of its options.'},
      {code: 'E_NOT_FOUND', when: 'owner is not an active team member, or a list in lists does not exist (or is dynamic).'},
    ],
  },
  {
    key: 'companies.upsert',
    title: 'Create or update a company',
    method: 'POST',
    path: '/companies',
    description: 'Finds the company by domain (then by name) and updates it, or creates it. Fields you leave out are kept; null clears a field. Contacts whose work email matches the domain are linked.',
    fields: [
      {name: 'name', type: 'string', max: 200, description: 'Company name. New companies without one are named after the domain.'},
      {name: 'domain', type: 'string', max: 200, description: 'Website domain, matched first (https:// and www. are removed).'},
      {name: 'website', type: 'string', max: 300, nullable: true, description: 'Website URL.'},
      {name: 'industry', type: 'string', max: 100, nullable: true, description: 'Industry.'},
      {name: 'type', type: 'string', max: 100, nullable: true, description: 'Company type, e.g. "Prospect".'},
      {name: 'size', type: 'string', max: 50, nullable: true, description: 'Size band, e.g. "51-200".'},
      {name: 'employees', type: 'integer', min: 0, nullable: true, description: 'Number of employees.'},
      {name: 'annualRevenue', type: 'number', min: 0, nullable: true, description: 'Annual revenue.'},
      {name: 'phone', type: 'string', max: 50, nullable: true, description: 'Main phone number.'},
      {name: 'address', type: 'string', max: 300, nullable: true, description: 'Street address.'},
      {name: 'city', type: 'string', max: 100, nullable: true, description: 'City.'},
      {name: 'state', type: 'string', max: 100, nullable: true, description: 'State or region.'},
      {name: 'postalCode', type: 'string', max: 30, nullable: true, description: 'Postal code.'},
      {name: 'country', type: 'string', max: 100, nullable: true, description: 'Country.'},
      {name: 'timezone', type: 'string', max: 100, nullable: true, description: 'IANA time zone, e.g. "Europe/Berlin".'},
      {name: 'linkedin', type: 'string', max: 300, nullable: true, description: 'LinkedIn page URL.'},
      {name: 'description', type: 'text', max: 5000, nullable: true, description: 'Description.'},
      owner('company'),
      tags('company'),
      custom('company'),
      note('company'),
    ],
    oneOf: ['domain', 'name'],
    sample: {name: 'Northwind Traders', domain: 'northwind.example', industry: 'Logistics', employees: 120, city: 'San Francisco', country: 'United States'},
    success: {
      status: 201,
      note: '201 when created; 200 when an existing company was updated or already matched.',
      body: {ok: true, action: 'companies.upsert', result: {outcome: 'created', id: ID.company, url: url(`/companies/${ID.company}`)}},
    },
    errors: [
      {code: 'E_INVALID_FIELD', when: 'Neither domain nor name is sent, or a custom field is unknown or invalid.'},
      {code: 'E_NOT_FOUND', when: 'owner is not an active team member.'},
    ],
  },
  {
    key: 'deals.create',
    title: 'Create a deal',
    method: 'POST',
    path: '/deals',
    description: 'Creates a deal in a pipeline and stage (by id or name; the default pipeline and its first stage when left out), linked to a contact (found or created by email) and a company (found or created by name or domain).',
    fields: [
      {name: 'title', type: 'string', required: true, max: 200, description: 'Deal name.'},
      {name: 'value', type: 'number', min: 0, description: 'Deal amount.'},
      {name: 'currency', type: 'string', min: 3, max: 3, description: 'Three-letter currency code, e.g. "EUR". Defaults to the CRM currency.'},
      {name: 'pipeline', type: 'string', max: 200, description: 'Pipeline id or name.'},
      {name: 'stage', type: 'string', max: 200, description: 'Stage id or name within the pipeline.'},
      {name: 'status', type: 'enum', values: ['OPEN', 'WON', 'LOST'], description: 'Defaults to OPEN. WON and LOST close the deal now.'},
      {name: 'lostReason', type: 'string', max: 200, description: 'Why the deal was lost (status LOST).'},
      {name: 'expectedCloseDate', type: 'datetime', description: 'Expected close date (ISO 8601, e.g. "2026-12-31").'},
      owner('deal'),
      ...contactRef(true),
      {name: 'company', type: 'string', max: 200, description: 'Company name: found or created. Defaults to the contact\'s primary company.'},
      {name: 'companyDomain', type: 'string', max: 200, description: 'Company website domain, matched before the name.'},
      tags('deal'),
      custom('deal'),
      note('deal'),
    ],
    sample: {title: 'Northwind renewal', value: 18000, currency: 'USD', pipeline: 'Sales', stage: 'Qualified', contactEmail: 'maya.patel@northwind.example', company: 'Northwind Traders'},
    success: {
      status: 201,
      body: {ok: true, action: 'deals.create', result: {id: ID.deal, url: url(`/deals/${ID.deal}`), pipelineId: 'cmpipeline0sales0000001', stageId: 'cmstage0qualified000001', status: 'OPEN', contactId: ID.contact, contactOutcome: 'found', companyId: ID.company}},
    },
    errors: [
      {code: 'E_NOT_FOUND', when: 'pipeline, stage, contactId or owner does not exist.'},
      {code: 'E_INVALID_FIELD', when: 'title is missing, currency is not three letters, or a custom field is unknown or invalid.'},
    ],
  },
  {
    key: 'tickets.create',
    title: 'Create a ticket',
    method: 'POST',
    path: '/tickets',
    description: 'Opens a support ticket with its SLA deadlines, timeline entry and notifications, for a contact found or created by email.',
    fields: [
      {name: 'subject', type: 'string', required: true, max: 300, description: 'Ticket subject.'},
      {name: 'description', type: 'text', max: 50_000, description: 'What the customer needs (plain text).'},
      {name: 'priority', type: 'enum', values: PRIORITIES, description: 'Defaults to NORMAL.'},
      {name: 'category', type: 'string', max: 100, description: 'Category, e.g. "Billing".'},
      {name: 'assignee', type: 'email', description: 'Email of the team member to assign it to; unassigned when left out.'},
      ...contactRef(true),
      tags('ticket'),
    ],
    sample: {subject: 'Cannot download my invoice', description: 'The download button on the billing page shows an error.', priority: 'HIGH', category: 'Billing', contactEmail: 'maya.patel@northwind.example'},
    success: {status: 201, body: {ok: true, action: 'tickets.create', result: {id: ID.ticket, number: 1042, url: url(`/tickets/${ID.ticket}`), status: 'NEW', contactId: ID.contact}}},
    errors: [
      {code: 'E_NOT_FOUND', when: 'contactId or assignee does not exist.'},
      {code: 'E_INVALID_FIELD', when: 'subject is missing or priority is not one of the values.'},
    ],
  },
  {
    key: 'notes.create',
    title: 'Add a note',
    method: 'POST',
    path: '/notes',
    description: 'Adds a note to a contact, company or deal (several links are allowed). It shows on their timelines, written by the person who created the API key.',
    fields: [
      {name: 'body', type: 'text', required: true, max: 20_000, description: 'The note (plain text). "@Full Name" mentions notify that teammate.'},
      ...contactRef(false),
      {name: 'companyId', type: 'id', description: 'Id of a company.'},
      {name: 'companyDomain', type: 'string', max: 200, description: 'Domain of an existing company.'},
      {name: 'dealId', type: 'id', description: 'Id of a deal.'},
      {name: 'pinned', type: 'boolean', description: 'Pin the note to the top of the notes list.'},
    ],
    oneOf: ['contactId', 'contactEmail', 'companyId', 'companyDomain', 'dealId'],
    sample: {contactEmail: 'maya.patel@northwind.example', body: 'Asked for a quote for 20 more seats.'},
    success: {status: 201, body: {ok: true, action: 'notes.create', result: {id: ID.note, contactId: ID.contact, companyId: null, dealId: null}}},
    errors: [
      {code: 'E_NOT_FOUND', when: 'The contact, company or deal does not exist.'},
      {code: 'E_INVALID_FIELD', when: 'body is missing, or no record is named.'},
    ],
  },
  {
    key: 'activities.create',
    title: 'Log a call, meeting or message',
    method: 'POST',
    path: '/activities',
    description: 'Logs an interaction (call, meeting, email, SMS, LinkedIn, WhatsApp or postal mail) on a contact\'s timeline, optionally on a deal too. Counts for lead scoring and can start automations.',
    fields: [
      {name: 'kind', type: 'enum', required: true, values: KINDS, description: 'What happened.'},
      {name: 'title', type: 'string', max: 200, description: 'Short summary. Required for meetings.'},
      {name: 'body', type: 'text', max: 20_000, description: 'Notes (plain text).'},
      {name: 'occurredAt', type: 'datetime', description: 'When it happened (ISO 8601). Defaults to now; a future meeting shows as scheduled.'},
      {name: 'durationMin', type: 'integer', min: 0, max: 1440, description: 'Duration in minutes.'},
      {name: 'outcome', type: 'string', max: 200, description: 'Outcome, e.g. "Connected" or "Left voicemail".'},
      {name: 'direction', type: 'enum', values: ['INBOUND', 'OUTBOUND'], description: 'Who reached out.'},
      ...contactRef(false),
      {name: 'dealId', type: 'id', description: 'Id of a deal to log it on as well.'},
    ],
    oneOf: ['contactId', 'contactEmail'],
    sample: {kind: 'CALL', title: 'Renewal check-in', body: 'Discussed seat count for next year.', durationMin: 20, outcome: 'Connected', direction: 'OUTBOUND', contactEmail: 'maya.patel@northwind.example'},
    success: {status: 201, body: {ok: true, action: 'activities.create', result: {id: ID.interaction, kind: 'CALL', contactId: ID.contact, dealId: null}}},
    errors: [
      {code: 'E_NOT_FOUND', when: 'The contact or deal does not exist.'},
      {code: 'E_INVALID_FIELD', when: 'kind is missing or unknown, no contact is named, or a meeting has no title.'},
    ],
  },
  {
    key: 'lists.members',
    title: 'Add contacts to a list',
    method: 'POST',
    path: '/lists/{list}/members',
    description: 'Adds contacts, by email, to a static list. Contacts already in the list are skipped. With createMissing, emails nobody has become new contacts first.',
    params: [{name: 'list', type: 'string', required: true, description: 'Id or name of a static list (URL-encoded).'}],
    fields: [
      {name: 'emails', type: 'email[]', required: true, min: 1, max: 500, description: 'Email addresses of the contacts to add.'},
      {name: 'createMissing', type: 'boolean', description: 'Create a contact for every email nobody has (default false: they are reported in notFound).'},
    ],
    sample: {emails: ['maya.patel@northwind.example', 'li.wei@contoso.example'], createMissing: false},
    sampleParams: {list: ID.list},
    success: {status: 200, body: {ok: true, action: 'lists.members', result: {listId: ID.list, list: 'Newsletter', added: 1, alreadyMembers: 1, created: 0, notFound: []}}},
    errors: [
      {code: 'E_NOT_FOUND', when: 'No list has this id or name.'},
      {code: 'E_INVALID_FIELD', when: 'The list is dynamic (its members follow its rules), or emails is empty or holds an invalid address.'},
    ],
  },
  {
    key: 'events.create',
    title: 'Record a custom event',
    method: 'POST',
    path: '/events',
    description: 'Records something that happened in your platform (a trial started, an order shipped) without changing any record. Automations can start on "Data in event received" (filtered by event name) and lead scoring can give points for it.',
    fields: [
      {name: 'event', type: 'string', required: true, max: 100, description: 'Event name, e.g. "trial.started" (letters, digits, dots, dashes and underscores).'},
      ...contactRef(false),
      {name: 'properties', type: 'object', description: 'Anything else about the event; automations can read it.'},
      {name: 'occurredAt', type: 'datetime', description: 'When it happened (ISO 8601). Defaults to now.'},
    ],
    sample: {event: 'trial.started', contactEmail: 'maya.patel@northwind.example', properties: {plan: 'Pro', seats: 12}},
    success: {status: 201, note: 'contactId is null when no contact matches; the event is recorded anyway.', body: {ok: true, action: 'events.create', result: {eventId: ID.event, event: 'trial.started', contactId: ID.contact}}},
    errors: [
      {code: 'E_NOT_FOUND', when: 'contactId does not exist.'},
      {code: 'E_INVALID_FIELD', when: 'event is missing or has characters other than letters, digits, ".", "-" and "_".'},
    ],
  },
];

export const dataInAction = (key: string) => DATA_IN_ACTIONS.find((a) => a.key === key);

/** Finds the action for a method + path (relative to the base URL) and its path parameters. */
export function matchDataInAction(method: string, path: string): {action: DataInAction; params: Record<string, string>; wrongMethod: boolean} | null {
  const clean = path.replace(/\/+$/, '') || '/';
  for (const action of DATA_IN_ACTIONS) {
    const names: string[] = [];
    const pattern = action.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), '([^/]+)'));
    const m = new RegExp(`^${pattern}$`).exec(clean);
    if (!m) continue;
    if (action.method !== method.toUpperCase()) return {action, params: {}, wrongMethod: true};
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]!);
      } catch {
        params[n] = m[i + 1]!;
      }
    });
    return {action, params, wrongMethod: false};
  }
  return null;
}

/** The action's path with its parameters filled in (samples, docs). */
export const actionPath = (action: DataInAction, params: Record<string, string> = action.sampleParams ?? {}) =>
  action.path.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(params[n] ?? `{${n}}`));

export const errorsFor = (action: DataInAction) => [
  ...action.errors.map((e) => ({...e, status: DATA_IN_ERRORS[e.code].status as number, common: false})),
  ...COMMON_ERRORS.filter((code) => !action.errors.some((e) => e.code === code)).map((code) => ({code, when: DATA_IN_ERRORS[code].when as string, status: DATA_IN_ERRORS[code].status as number, common: true})),
];

export const FIELD_TYPE_LABEL: Record<DataInFieldType, string> = {
  string: 'string',
  text: 'string',
  email: 'string (email)',
  'email[]': 'array of emails',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  datetime: 'string (ISO 8601)',
  enum: 'string (enum)',
  'string[]': 'array of strings',
  object: 'object',
  id: 'string (id)',
};

// ─── Code samples ───────────────────────────────────────────────────────────

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A complete cURL command that signs the body with openssl and sends it. */
export function curlFor(action: DataInAction, baseUrl: string) {
  const body = JSON.stringify(action.sample);
  return [
    '# Set API_KEY and SIGNING_SECRET first (Settings → Webhooks → Incoming).',
    `BODY=${shellQuote(body)}`,
    'T=$(date +%s)',
    'SIG=$(printf \'%s\' "$T.$BODY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | sed \'s/^.* //\')',
    `curl -X ${action.method} ${shellQuote(baseUrl + actionPath(action))} \\`,
    '  -H "Authorization: Bearer $API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-Signature: t=$T,v1=$SIG" \\',
    '  -H "Idempotency-Key: $(uuidgen)" \\',
    '  -d "$BODY"',
  ].join('\n');
}

export type SigningSample = {key: 'node' | 'php' | 'postman'; label: string; code: string};

export function signingSamples(baseUrl: string): SigningSample[] {
  return [
    {
      key: 'node',
      label: 'Node.js',
      code: `// Node 18+. Signs and sends one request to the Data in API.
import {createHmac, randomUUID} from 'node:crypto';

const BASE_URL = '${baseUrl}';
const API_KEY = process.env.CRM_API_KEY;
const SIGNING_SECRET = process.env.CRM_SIGNING_SECRET;

async function send(path, data) {
  const body = JSON.stringify(data); // sign exactly the bytes you send
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SIGNING_SECRET).update(\`\${t}.\${body}\`).digest('hex');
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: \`Bearer \${API_KEY}\`,
      'X-Signature': \`t=\${t},v1=\${v1}\`,
      'Idempotency-Key': randomUUID(), // optional: a retry with the same key is not applied twice
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(\`\${json.error.code}: \${json.error.message}\`);
  return json.result;
}

console.log(await send('/contacts', {email: 'maya.patel@northwind.example', firstName: 'Maya'}));
`,
    },
    {
      key: 'php',
      label: 'PHP',
      code: `<?php
// Signs and sends one request to the Data in API (PHP 7.4+ with curl).
const BASE_URL = '${baseUrl}';

function send(string $path, array $data): array
{
    $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); // sign exactly what you send
    $t = time();
    $v1 = hash_hmac('sha256', $t . '.' . $body, getenv('CRM_SIGNING_SECRET'));
    $ch = curl_init(BASE_URL . $path);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . getenv('CRM_API_KEY'),
            'X-Signature: t=' . $t . ',v1=' . $v1,
            'Idempotency-Key: ' . bin2hex(random_bytes(16)),
        ],
    ]);
    $json = json_decode(curl_exec($ch), true);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status >= 400) {
        throw new RuntimeException($json['error']['code'] . ': ' . $json['error']['message']);
    }
    return $json['result'];
}

print_r(send('/contacts', ['email' => 'maya.patel@northwind.example', 'firstName' => 'Maya']));
`,
    },
    {
      key: 'postman',
      label: 'Postman',
      code: `// Postman: paste into the collection's Scripts → Pre-request tab.
// Variables: apiKey, signingSecret, baseUrl (= ${baseUrl}), in an environment
// that is selected (top right) or in the collection's Variables tab.
// Requests: POST {{baseUrl}}/contacts with Body → raw → JSON.
const apiKey = (pm.variables.get('apiKey') || '').trim();
const secret = (pm.variables.get('signingSecret') || '').trim();
if (!apiKey || !secret) throw new Error('Set apiKey and signingSecret, and select their environment');
const t = Math.floor(Date.now() / 1000).toString();
const body = pm.request.body && pm.request.body.raw ? pm.variables.replaceIn(pm.request.body.raw) : '';
const v1 = CryptoJS.HmacSHA256(t + '.' + body, secret).toString(CryptoJS.enc.Hex);
pm.request.headers.upsert({key: 'Authorization', value: 'Bearer ' + apiKey});
pm.request.headers.upsert({key: 'Content-Type', value: 'application/json'});
pm.request.headers.upsert({key: 'X-Signature', value: 't=' + t + ',v1=' + v1});
`,
    },
  ];
}

// ─── Admin API shapes (Settings → Webhooks → Incoming) ──────────────────────

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  createdBy: {id: string; name: string; active: boolean} | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type DataInOverview = {
  baseUrl: string;
  secret: {masked: string; rotatedAt: string | null};
  rateLimit: number;
  keys: ApiKeyRow[];
  stats: {day: number; failed: number};
};

export type DataInRecord = {entity: 'contact' | 'company' | 'deal' | 'ticket' | 'list' | 'note' | 'interaction' | 'event'; id: string; label: string};

export type DataInLogRow = {
  id: string;
  action: string;
  method: string;
  path: string;
  status: number;
  errorCode: string | null;
  error: string | null;
  durationMs: number;
  key: {id: string | null; name: string | null; prefix: string | null};
  idempotencyKey: string | null;
  replayed: boolean;
  records: DataInRecord[];
  body: string | null;
  response: unknown;
  createdAt: string;
};
