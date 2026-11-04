/**
 * Data in API: other platforms push data in through
 * `POST /site-api/crm/public/data-in/v1/<action>` (catalogue: src/lib/data-in.ts).
 *
 *   handleDataIn()   the public endpoint: route → API key (Bearer) → key owner
 *                    still active → rate limit → size → X-Signature (HMAC-SHA256
 *                    of "<t>.<raw body>", 5-minute window, each signature once)
 *                    → JSON → Idempotency-Key → validation (zod built from the
 *                    catalogue fields) → the action's handler. Every request
 *                    with a known route is logged (DataInRequest), refused or not.
 *   HANDLERS         one per catalogue action. They write through the shared
 *                    helpers (record-writes, createNote, logInteraction,
 *                    createTicket, addToList, emit…), acting as the user who
 *                    created the key, so the timeline, events, scoring,
 *                    automations, history and audit log stay in step.
 *
 * Errors always answer `{error: {code, message, field?}}` with a stable code.
 */
import {HTTPException} from 'hono/http-exception';
import {z, type ZodType} from 'zod';

import type {ApiKey, ContactList, EntityType, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {
  API_KEY_PREFIX,
  DATA_IN_ERRORS,
  DATA_IN_MAX_BYTES,
  DEFAULT_DATA_IN_RATE_LIMIT,
  IDEMPOTENCY_HOURS,
  matchDataInAction,
  SIGNATURE_TOLERANCE_SEC,
  SIGNING_SECRET_PREFIX,
  type DataInAction,
  type DataInActionKey,
  type DataInErrorCode,
  type DataInField,
  type DataInRecord,
} from '@/lib/data-in';
import {decryptJson, encryptJson, randomToken, sha256Hex} from '../kit/crypto';
import {CRM_APP} from '../kit/config';
import type {Db} from '../kit/db';
import {normalizeDomain} from '../routes/companies';
import {contactName} from '../routes/contacts';
import {logInteraction} from '../routes/interactions';
import {createNote} from '../routes/notes';
import {logActivity} from './activity';
import {audit, redact} from './audit';
import {cleanCustom} from './custom-fields';
import {associateByDomain, nameFromDomain} from './domains';
import {contactsByEmail} from './contact-email';
import {checkDuplicates} from './duplicates';
import {emit} from './events';
import {userScope} from './http';
import {hit, ipKey} from './rate-limit';
import {createCompanyRecord, createContactRecord, createDealRecord, findCompany, findContact, linkContactCompany, resolveCompany, updateCompanyRecord, updateContactRecord, type DealInput, type Writer} from './record-writes';
import {addToList} from './segments';
import {getSettings} from './settings';
import {createTicket} from './tickets';
import {asUser, withEmail} from './users';
import {strings} from './json-list';

// ─── Settings: signing secret, rate limit ───────────────────────────────────

const SETTING_KEY = 'data-in';
type Stored = {secret?: string; rotatedAt?: string; rateLimit?: number};

async function stored(db: Db): Promise<Stored> {
  const row = await db.setting.findUnique({where: {key: SETTING_KEY}});
  return (row?.value ?? {}) as Stored;
}

async function store(db: Db, patch: Partial<Stored>) {
  const value = {...(await stored(db)), ...patch};
  await db.setting.upsert({where: {key: SETTING_KEY}, create: {key: SETTING_KEY, value}, update: {value}});
}

const newSecret = () => `${SIGNING_SECRET_PREFIX}${randomToken(32)}`;

/** The signing secret (made on first use; stored encrypted with encryptJson()). */
export async function signingSecret(db: Db): Promise<string> {
  const s = await stored(db);
  const current = s.secret ? await decryptJson<string>(s.secret).catch(() => null) : null;
  if (current) return current;
  const secret = newSecret();
  await store(db, {secret: await encryptJson(secret), rotatedAt: new Date().toISOString()});
  return secret;
}

/** A new signing secret; the old one stops working at once. */
export async function rotateSigningSecret(db: Db): Promise<string> {
  const secret = newSecret();
  await store(db, {secret: await encryptJson(secret), rotatedAt: new Date().toISOString()});
  return secret;
}

export async function dataInSettings(db: Db) {
  const s = await stored(db);
  return {rateLimit: s.rateLimit ?? DEFAULT_DATA_IN_RATE_LIMIT, rotatedAt: s.rotatedAt ?? null};
}

export const saveRateLimit = (db: Db, rateLimit: number) => store(db, {rateLimit});

export const maskSecret = (secret: string) => `${secret.slice(0, SIGNING_SECRET_PREFIX.length + 2)}${'•'.repeat(16)}${secret.slice(-4)}`;

// ─── API keys ───────────────────────────────────────────────────────────────

const apiKeyHash = (key: string) => sha256Hex(`apikey:${key}`);

/** A new key: shown once in full; only its hash and a short prefix are stored. */
export async function newApiKey() {
  const key = `${API_KEY_PREFIX}${randomToken(24)}`;
  return {key, hash: await apiKeyHash(key), prefix: key.slice(0, API_KEY_PREFIX.length + 6)};
}

// ─── Validation from the catalogue ──────────────────────────────────────────

class DataInError extends Error {
  constructor(
    public code: DataInErrorCode,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

const fieldError = (field: string, message: string) => new DataInError('E_INVALID_FIELD', `${field}: ${message}`, field);
const notFoundError = (field: string, message: string) => new DataInError('E_NOT_FOUND', message, field);

function fieldSchema(f: DataInField): ZodType {
  const max = f.max;
  let s: ZodType;
  switch (f.type) {
    case 'string':
    case 'text':
    case 'id': {
      let str = z.string({error: 'must be a string'});
      if (f.type !== 'text') str = str.trim();
      if (f.min) str = str.min(f.min, `must be at least ${f.min} characters`);
      str = str.max(max ?? (f.type === 'id' ? 60 : f.type === 'text' ? 20_000 : 200), `must be at most ${max ?? (f.type === 'id' ? 60 : f.type === 'text' ? 20_000 : 200)} characters`);
      s = str;
      break;
    }
    case 'email':
      s = z.email({error: 'must be an email address'}).max(254, 'is too long').transform((v) => v.toLowerCase());
      break;
    case 'email[]':
      s = z
        .array(z.email({error: 'must be an email address'}).max(254).transform((v) => v.toLowerCase()), {error: 'must be an array of email addresses'})
        .min(f.min ?? 0, `needs at least ${f.min ?? 0} address`)
        .max(max ?? 500, `can hold at most ${max ?? 500} addresses`);
      break;
    case 'number':
    case 'integer': {
      let n = z.number({error: `must be ${f.type === 'integer' ? 'an integer' : 'a number'}`});
      if (f.type === 'integer') n = n.int('must be an integer');
      if (f.min !== undefined) n = n.min(f.min, `must be at least ${f.min}`);
      n = n.max(f.max ?? 1e13, `must be at most ${f.max ?? 1e13}`);
      s = n;
      break;
    }
    case 'boolean':
      s = z.boolean({error: 'must be true or false'});
      break;
    case 'datetime':
      s = z
        .string({error: 'must be an ISO 8601 date'})
        .refine((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 date, e.g. 2026-12-31 or 2026-12-31T14:00:00Z')
        .transform((v) => new Date(v));
      break;
    case 'enum': {
      const values = (f.values ?? []) as [string, ...string[]];
      s = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(values, {error: `must be one of: ${values.join(', ')}`}));
      break;
    }
    case 'string[]':
      s = z.array(z.string({error: 'must be a string'}).trim().min(1, 'must not be empty').max(100, 'must be at most 100 characters'), {error: 'must be an array of strings'}).max(max ?? 50, `can hold at most ${max ?? 50} items`);
      break;
    case 'object':
      s = z.record(z.string(), z.unknown(), {error: 'must be an object'});
      break;
  }
  if (f.nullable) s = s.nullable();
  return f.required ? s : s.optional();
}

const schemas = new Map<string, ZodType>();
function schemaFor(action: DataInAction) {
  let s = schemas.get(action.key);
  if (!s) {
    s = z.strictObject(Object.fromEntries(action.fields.map((f) => [f.name, fieldSchema(f)])));
    schemas.set(action.key, s);
  }
  return s;
}

const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Validates a body against the action's catalogue fields; throws E_INVALID_FIELD naming the field. */
function validateBody(action: DataInAction, body: Record<string, unknown>): Record<string, unknown> {
  for (const f of action.fields) if (f.required && blank(body[f.name])) throw fieldError(f.name, 'is required');
  const r = schemaFor(action).safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    if (issue.code === 'unrecognized_keys') {
      const key = (issue as {keys: string[]}).keys[0] ?? '';
      throw fieldError(key, `is not a field of ${action.method} ${action.path}`);
    }
    throw fieldError(issue.path.map(String).join('.') || 'body', issue.message);
  }
  const data = r.data as Record<string, unknown>;
  if (action.oneOf && action.oneOf.every((k) => blank(data[k]))) throw fieldError(action.oneOf[0]!, `send at least one of: ${action.oneOf.join(', ')}`);
  return data;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

type Ctx = {
  db: Db;
  user: User;
  key: ApiKey;
  origin: string;
  params: Record<string, string>;
  writer: Writer;
  scope: {ownerId?: string};
  records: DataInRecord[];
};

// Validated by validateBody() from the catalogue, so handlers read fields by name.
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handled = {status: 200 | 201; result: Record<string, unknown>};

const touch = (ctx: Ctx, entity: DataInRecord['entity'], id: string, label: string) => {
  if (ctx.records.length < 25 && !ctx.records.some((r) => r.entity === entity && r.id === id)) ctx.records.push({entity, id, label: label.slice(0, 120)});
};
/** The record's screen in the CRM (under /crm). */
const recordUrl = (ctx: Ctx, path: string) => `${ctx.origin}${CRM_APP}${path}`;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const lower = (s: string) => s.trim().toLowerCase();
const apiSource = (ctx: Ctx) => `API: ${ctx.key.name}`.slice(0, 100);

async function ownerFromEmail(ctx: Ctx, email: string | undefined, field: string) {
  if (!email) return undefined;
  const address = email.trim().toLowerCase();
  // A teammate who joined (their account's address) or one invited who has not joined yet.
  const u = await ctx.db.member.findFirst({where: {OR: [{user: {email: address}}, {inviteEmail: address}], active: true}, select: {id: true}});
  if (!u) throw notFoundError(field, `${field}: no active team member has the email ${email}`);
  return u.id;
}

/** Refuses unknown custom field keys and bad values before anything is written. */
async function checkCustom(ctx: Ctx, entity: EntityType, input: Record<string, unknown> | undefined) {
  if (!input) return;
  const defs = await ctx.db.customFieldDef.findMany({where: {entity}, select: {key: true}});
  const known = new Set(defs.map((d) => d.key));
  const unknown = Object.keys(input).find((k) => !known.has(k));
  if (unknown) throw fieldError(`custom.${unknown}`, 'is not a custom field (Settings → Fields shows the keys)');
  await mergeCustom(ctx, entity, input, {});
}

async function mergeCustom(ctx: Ctx, entity: EntityType, input: Record<string, unknown> | undefined, existing: unknown) {
  if (!input) return undefined;
  try {
    return await cleanCustom(ctx.db, entity, input, existing);
  } catch (e) {
    if (e instanceof HTTPException) throw fieldError('custom', e.message);
    throw e;
  }
}

async function staticList(ctx: Ctx, ref: string, field: string): Promise<Pick<ContactList, 'id' | 'name' | 'kind'>> {
  const select = {id: true, name: true, kind: true} as const;
  const list = (await ctx.db.contactList.findUnique({where: {id: ref}, select})) ?? (await ctx.db.contactList.findFirst({where: {name: {equals: ref.trim(), mode: 'insensitive'}}, select, orderBy: {createdAt: 'asc'}}));
  if (!list) throw notFoundError(field, `${field}: no list has the id or name "${ref}"`);
  if (list.kind !== 'STATIC') throw fieldError(field, `"${list.name}" is a dynamic list; its members follow its rules`);
  return list;
}

/** A new contact for an email nobody has (deals, tickets, list members). */
async function createContactFor(ctx: Ctx, email: string, names: {firstName?: string; lastName?: string} = {}) {
  const contact = await createContactRecord(ctx.db, ctx.writer, {
    firstName: (names.firstName || email.split('@')[0] || email).slice(0, 100),
    lastName: names.lastName || null,
    email,
    ownerId: ctx.user.id,
    source: apiSource(ctx),
  });
  await associateByDomain(ctx.db, contact.id, ctx.user.id);
  await checkDuplicates(ctx.db, 'contact', contact.id);
  touch(ctx, 'contact', contact.id, contactName(contact));
  return contact;
}

/** contactId / contactEmail → the contact; with `create`, an unknown email becomes a new contact. */
async function contactFromRef(ctx: Ctx, b: Body, create: boolean): Promise<{id: string; name: string; outcome: 'found' | 'created'} | null> {
  if (b.contactId) {
    const c = await ctx.db.contact.findFirst({where: {id: b.contactId, ...ctx.scope}, select: {id: true, firstName: true, lastName: true}});
    if (!c) throw notFoundError('contactId', `contactId: no contact has the id ${b.contactId}`);
    return {id: c.id, name: contactName(c), outcome: 'found'};
  }
  if (!b.contactEmail) return null;
  const found = await findContact(ctx.db, {email: b.contactEmail}, ctx.scope);
  if (found) return {id: found.id, name: contactName(found), outcome: 'found'};
  if (!create) throw notFoundError('contactEmail', `contactEmail: no contact has the email ${b.contactEmail}`);
  const c = await createContactFor(ctx, b.contactEmail, {firstName: b.contactFirstName, lastName: b.contactLastName});
  return {id: c.id, name: contactName(c), outcome: 'created'};
}

async function addNoteTo(ctx: Ctx, body: string | undefined, link: {contactId?: string; companyId?: string; dealId?: string}) {
  if (!body?.trim()) return;
  const note = await createNote(ctx.db, {body: body.trim(), ...link}, ctx.user, {source: ctx.writer.source});
  touch(ctx, 'note', note.id, note.body.slice(0, 60));
}

const CONTACT_FIELDS: [api: string, column: string][] = [
  ['firstName', 'firstName'],
  ['lastName', 'lastName'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['jobTitle', 'title'],
  ['lifecycleStage', 'lifecycleStage'],
  ['leadStatus', 'leadStatus'],
  ['buyingRole', 'buyingRole'],
  ['source', 'source'],
  ['city', 'city'],
  ['country', 'country'],
  ['linkedin', 'linkedin'],
  ['emailOptOut', 'emailOptOut'],
];

const COMPANY_FIELDS = ['name', 'domain', 'website', 'industry', 'type', 'size', 'employees', 'annualRevenue', 'phone', 'address', 'city', 'state', 'postalCode', 'country', 'timezone', 'linkedin', 'description'];

const tagsOf = (input: unknown) => (Array.isArray(input) ? [...new Set(input.map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))] : []);

const HANDLERS: Record<DataInActionKey, (ctx: Ctx, b: Body) => Promise<Handled>> = {
  async 'contacts.upsert'(ctx, b) {
    const db = ctx.db;
    // Everything that can be refused is checked before anything is written.
    const ownerId = await ownerFromEmail(ctx, b.owner, 'owner');
    const lists: Pick<ContactList, 'id' | 'name' | 'kind'>[] = [];
    for (const [i, ref] of ((b.lists as string[] | undefined) ?? []).entries()) lists.push(await staticList(ctx, ref, `lists.${i}`));
    await checkCustom(ctx, 'CONTACT', b.custom);
    if (b.firstName === '') throw fieldError('firstName', 'must not be empty');

    const fields = defined(Object.fromEntries(CONTACT_FIELDS.map(([api, column]) => [column, b[api] === '' ? null : b[api]])));
    const tags = tagsOf(b.tags);
    const existing = await findContact(db, {email: b.email, phone: b.phone}, ctx.scope);
    let contact;
    let outcome: 'created' | 'updated' | 'unchanged';
    if (existing) {
      const data: Record<string, unknown> = {...fields};
      const merged = [...new Set([...strings(existing.tags), ...tags])];
      if (merged.length > strings(existing.tags).length) data.tags = merged.slice(0, 50);
      if (ownerId && ownerId !== existing.ownerId) data.ownerId = ownerId;
      const custom = await mergeCustom(ctx, 'CONTACT', b.custom, existing.custom);
      const r = await updateContactRecord(db, ctx.writer, existing, data, custom);
      contact = r.contact;
      outcome = r.changes.length ? 'updated' : 'unchanged';
    } else {
      const custom = await mergeCustom(ctx, 'CONTACT', b.custom, {});
      const firstName: string = b.firstName || (b.email ? String(b.email).split('@')[0] : '') || String(b.phone);
      contact = await createContactRecord(
        db,
        ctx.writer,
        {...(fields as Prisma.ContactUncheckedCreateInput), firstName: firstName.slice(0, 100), tags: tags.slice(0, 50), ownerId: ownerId ?? ctx.user.id, source: (fields.source as string | undefined) || apiSource(ctx)},
        custom,
      );
      outcome = 'created';
    }
    touch(ctx, 'contact', contact.id, contactName(contact));

    let companyId: string | null = null;
    const domain = normalizeDomain(b.companyDomain) || undefined;
    if (b.company || domain) {
      const company = await resolveCompany(db, ctx.writer, {name: b.company || undefined, domain}, contact.ownerId, ctx.scope);
      if (company) {
        await linkContactCompany(db, contact.id, company.id);
        companyId = company.id;
        touch(ctx, 'company', company.id, company.name);
      }
    } else if (outcome === 'created') {
      await associateByDomain(db, contact.id, ctx.user.id);
    }
    if (outcome === 'created') await checkDuplicates(db, 'contact', contact.id);
    companyId ??= (await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}))?.companyId ?? null;
    await addNoteTo(ctx, b.note, {contactId: contact.id});
    for (const list of lists) {
      await addToList(db, list.id, [contact.id], {actorId: ctx.user.id, source: 'api'});
      touch(ctx, 'list', list.id, list.name);
    }
    return {
      status: outcome === 'created' ? 201 : 200,
      result: {outcome, id: contact.id, url: recordUrl(ctx, `/contacts/${contact.id}`), companyId, lists: lists.map((l) => l.id)},
    };
  },

  async 'companies.upsert'(ctx, b) {
    const db = ctx.db;
    const ownerId = await ownerFromEmail(ctx, b.owner, 'owner');
    await checkCustom(ctx, 'COMPANY', b.custom);
    if (b.name === '') throw fieldError('name', 'must not be empty');
    const domain = b.domain === undefined ? undefined : normalizeDomain(b.domain) || null;
    const fields = defined(Object.fromEntries(COMPANY_FIELDS.map((k) => [k, k === 'domain' ? domain : b[k] === '' ? null : b[k]])));
    const tags = tagsOf(b.tags);
    const existing = await findCompany(db, {domain, name: b.name}, ctx.scope);
    let company;
    let outcome: 'created' | 'updated' | 'unchanged';
    if (existing) {
      const data: Record<string, unknown> = {...fields};
      if (!b.name) delete data.name;
      const merged = [...new Set([...strings(existing.tags), ...tags])];
      if (merged.length > strings(existing.tags).length) data.tags = merged.slice(0, 50);
      if (ownerId && ownerId !== existing.ownerId) data.ownerId = ownerId;
      const r = await updateCompanyRecord(db, ctx.writer, existing, data, await mergeCustom(ctx, 'COMPANY', b.custom, existing.custom));
      company = r.company;
      outcome = r.changes.length ? 'updated' : 'unchanged';
    } else {
      const name = (b.name as string | undefined) || (domain ? nameFromDomain(domain) : '');
      company = await createCompanyRecord(
        db,
        ctx.writer,
        {...(fields as Prisma.CompanyUncheckedCreateInput), name: name.slice(0, 200), website: (fields.website as string | undefined) ?? (domain ? `https://${domain}` : null), tags: tags.slice(0, 50), ownerId: ownerId ?? ctx.user.id},
        await mergeCustom(ctx, 'COMPANY', b.custom, {}),
      );
      outcome = 'created';
    }
    touch(ctx, 'company', company.id, company.name);
    await addNoteTo(ctx, b.note, {companyId: company.id});
    return {status: outcome === 'created' ? 201 : 200, result: {outcome, id: company.id, url: recordUrl(ctx, `/companies/${company.id}`)}};
  },

  async 'deals.create'(ctx, b) {
    const db = ctx.db;
    const pipelines = await db.pipeline.findMany({include: {stages: {orderBy: {position: 'asc'}}}, orderBy: [{isDefault: 'desc'}, {position: 'asc'}]});
    const pipeline = b.pipeline ? pipelines.find((p) => p.id === b.pipeline || lower(p.name) === lower(b.pipeline)) : pipelines.find((p) => p.stages.length);
    if (!pipeline) throw notFoundError('pipeline', b.pipeline ? `pipeline: no pipeline has the id or name "${b.pipeline}"` : 'pipeline: create a pipeline with at least one stage first');
    const stage = b.stage ? pipeline.stages.find((s) => s.id === b.stage || lower(s.name) === lower(b.stage)) : pipeline.stages[0];
    if (!stage) throw notFoundError('stage', b.stage ? `stage: ${pipeline.name} has no stage with the id or name "${b.stage}"` : `stage: ${pipeline.name} has no stages`);
    if (b.currency && !/^[A-Za-z]{3}$/.test(b.currency)) throw fieldError('currency', 'must be a three-letter code like USD');
    const ownerId = await ownerFromEmail(ctx, b.owner, 'owner');
    await checkCustom(ctx, 'DEAL', b.custom);

    const contact = await contactFromRef(ctx, b, true);
    const domain = normalizeDomain(b.companyDomain) || undefined;
    let company: {id: string; name: string} | null = null;
    if (b.company || domain) company = await resolveCompany(db, ctx.writer, {name: b.company || undefined, domain}, ownerId ?? ctx.user.id, ctx.scope);
    else if (contact) company = (await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, include: {company: {select: {id: true, name: true}}}}))?.company ?? null;
    const settings = await getSettings(db);
    const deal = await createDealRecord(db, ctx.writer, {
      data: defined({title: b.title, value: b.value, currency: b.currency ? String(b.currency).toUpperCase() : settings.currency, ownerId: ownerId ?? ctx.user.id, expectedCloseDate: b.expectedCloseDate, tags: tagsOf(b.tags).slice(0, 50)}) as DealInput['data'],
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: b.status ?? 'OPEN',
      lostReason: b.lostReason ?? null,
      contactId: contact?.id ?? null,
      companyId: company?.id ?? null,
      custom: await mergeCustom(ctx, 'DEAL', b.custom, {}),
    });
    touch(ctx, 'deal', deal.id, deal.title);
    if (contact) touch(ctx, 'contact', contact.id, contact.name);
    if (company) touch(ctx, 'company', company.id, company.name);
    await addNoteTo(ctx, b.note, {dealId: deal.id});
    return {
      status: 201,
      result: {id: deal.id, url: recordUrl(ctx, `/deals/${deal.id}`), pipelineId: pipeline.id, stageId: stage.id, status: deal.status, contactId: contact?.id ?? null, contactOutcome: contact?.outcome ?? null, companyId: company?.id ?? null},
    };
  },

  async 'tickets.create'(ctx, b) {
    const assigneeId = (await ownerFromEmail(ctx, b.assignee, 'assignee')) ?? null;
    const contact = await contactFromRef(ctx, b, true);
    const ticket = await createTicket(ctx.db, {
      subject: b.subject,
      description: b.description || null,
      priority: b.priority,
      category: b.category || null,
      tags: tagsOf(b.tags).slice(0, 50),
      assigneeId,
      contactId: contact?.id ?? null,
      source: 'API',
      actorId: ctx.user.id,
    });
    await audit(ctx.db, null, {action: 'ticket.created', entity: 'ticket', recordId: ticket.id, label: ticket.subject, meta: ctx.writer.meta, actor: ctx.writer.actor});
    touch(ctx, 'ticket', ticket.id, `#${ticket.number} ${ticket.subject}`);
    if (contact) touch(ctx, 'contact', contact.id, contact.name);
    return {status: 201, result: {id: ticket.id, number: ticket.number, url: recordUrl(ctx, `/tickets/${ticket.id}`), status: ticket.status, contactId: contact?.id ?? null}};
  },

  async 'notes.create'(ctx, b) {
    const db = ctx.db;
    const contact = await contactFromRef(ctx, b, false);
    let companyId: string | undefined;
    if (b.companyId) {
      const c = await db.company.findFirst({where: {id: b.companyId, ...ctx.scope}, select: {id: true, name: true}});
      if (!c) throw notFoundError('companyId', `companyId: no company has the id ${b.companyId}`);
      companyId = c.id;
      touch(ctx, 'company', c.id, c.name);
    } else if (b.companyDomain) {
      const c = await findCompany(db, {domain: normalizeDomain(b.companyDomain)}, ctx.scope);
      if (!c) throw notFoundError('companyDomain', `companyDomain: no company has the domain ${b.companyDomain}`);
      companyId = c.id;
      touch(ctx, 'company', c.id, c.name);
    }
    let dealId: string | undefined;
    if (b.dealId) {
      const d = await db.deal.findFirst({where: {id: b.dealId, ...ctx.scope}, select: {id: true, title: true}});
      if (!d) throw notFoundError('dealId', `dealId: no deal has the id ${b.dealId}`);
      dealId = d.id;
      touch(ctx, 'deal', d.id, d.title);
    }
    if (contact) touch(ctx, 'contact', contact.id, contact.name);
    const note = await createNote(db, {body: String(b.body).trim(), pinned: b.pinned, contactId: contact?.id, companyId, dealId}, ctx.user, {source: ctx.writer.source});
    touch(ctx, 'note', note.id, note.body.slice(0, 60));
    return {status: 201, result: {id: note.id, contactId: note.contactId, companyId: note.companyId, dealId: note.dealId}};
  },

  async 'activities.create'(ctx, b) {
    if (b.kind === 'MEETING' && !b.title) throw fieldError('title', 'is required for meetings');
    const contact = await contactFromRef(ctx, b, false);
    let dealId: string | null = null;
    if (b.dealId) {
      const d = await ctx.db.deal.findFirst({where: {id: b.dealId, ...ctx.scope}, select: {id: true, title: true}});
      if (!d) throw notFoundError('dealId', `dealId: no deal has the id ${b.dealId}`);
      dealId = d.id;
      touch(ctx, 'deal', d.id, d.title);
    }
    const interaction = await logInteraction(
      ctx.db,
      {kind: b.kind, title: b.title || null, body: b.body || null, occurredAt: b.occurredAt ?? new Date(), durationMin: b.durationMin ?? null, outcome: b.outcome || null, direction: b.direction ?? null, contactId: contact!.id, dealId, attendeeIds: [contact!.id]},
      ctx.user,
    );
    touch(ctx, 'contact', contact!.id, contact!.name);
    touch(ctx, 'interaction', interaction.id, interaction.title || interaction.kind);
    return {status: 201, result: {id: interaction.id, kind: interaction.kind, contactId: contact!.id, dealId}};
  },

  async 'lists.members'(ctx, b) {
    const db = ctx.db;
    const ref = ctx.params.list?.trim();
    if (!ref) throw fieldError('list', 'is required');
    const list = await staticList(ctx, ref, 'list');
    const emails = [...new Set((b.emails as string[]).map(lower))];
    const found = await contactsByEmail(db, emails, {ownerId: ctx.scope.ownerId, take: 5000});
    const byEmail = new Map<string, string>();
    for (const c of found) if (c.email && !byEmail.has(lower(c.email))) byEmail.set(lower(c.email), c.id);
    const missing = emails.filter((e) => !byEmail.has(e));
    let created = 0;
    if (b.createMissing) {
      for (const email of missing) {
        byEmail.set(email, (await createContactFor(ctx, email)).id);
        created++;
      }
    }
    const ids = [...new Set(byEmail.values())];
    const added = await addToList(db, list.id, ids, {actorId: ctx.user.id, source: 'api'});
    touch(ctx, 'list', list.id, list.name);
    return {status: 200, result: {listId: list.id, list: list.name, added, alreadyMembers: ids.length - added, created, notFound: b.createMissing ? [] : missing}};
  },

  async 'events.create'(ctx, b) {
    const name = String(b.event).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw fieldError('event', 'use letters, digits, ".", "-" and "_" only');
    let contactId: string | null = null;
    if (b.contactId) contactId = (await contactFromRef(ctx, b, false))!.id;
    else if (b.contactEmail) contactId = (await findContact(ctx.db, {email: b.contactEmail}, ctx.scope))?.id ?? null;
    const occurredAt = (b.occurredAt as Date | undefined) ?? new Date();
    const properties = (b.properties as Record<string, unknown> | undefined) ?? {};
    const event = await emit(ctx.db, 'data_in.received', {
      entity: 'data_in',
      actorId: ctx.user.id,
      data: {event: name, contactId, properties, occurredAt: occurredAt.toISOString(), key: {id: ctx.key.id, name: ctx.key.name}},
    });
    if (!event) throw new Error('The event could not be recorded');
    if (contactId) {
      await logActivity(ctx.db, {type: 'data_in_event', title: `Event: ${name}`, actorId: ctx.user.id, contactId, refId: event.id, at: occurredAt, data: {event: name, properties: redact(properties) as Prisma.InputJsonValue, source: ctx.writer.source}, text: name});
      const c = await ctx.db.contact.findUnique({where: {id: contactId}, select: {firstName: true, lastName: true}});
      touch(ctx, 'contact', contactId, c ? contactName(c) : 'contact');
    }
    touch(ctx, 'event', event.id, name);
    return {status: 201, result: {eventId: event.id, event: name, contactId}};
  },
};

// ─── The endpoint ───────────────────────────────────────────────────────────

/** Unknown keys from one address: after this many in 10 minutes, it gets E_RATE_LIMITED without a lookup. */
const BAD_KEY_LIMIT = 30;
const BODY_PREVIEW = 4000;
const enc = new TextEncoder();

export type DataInInput = {method: string; path: string; headers: Headers; body: () => Promise<ArrayBuffer>; ip: string | null; origin: string};
export type DataInOutput = {status: number; body: unknown; headers?: Record<string, string>};

const errorBody = (code: DataInErrorCode, message: string, field?: string) => ({error: {code, message, ...(field ? {field} : {})}});

const SECRET_KEY = /pass(word)?|secret|token|credential|api_?key|authorization|cookie|private/i;

/** A copy with the values of secret-looking keys replaced (nothing else is cut). */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(v, depth + 1)]));
}

/** The body as it goes into the log: secret-looking values redacted, cut to 4 KB. */
function bodyPreview(raw: Uint8Array, parsed?: unknown) {
  const text = parsed === undefined ? new TextDecoder().decode(raw) : JSON.stringify(redactSecrets(parsed), null, 2);
  return text.length > BODY_PREVIEW ? `${text.slice(0, BODY_PREVIEW)}…` : text;
}

function parseSignature(header: string) {
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k!.trim(), v!.trim()]),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return null;
  return {t: Number(t), v1: v1.toLowerCase()};
}

async function signatureMatches(secret: string, t: number, v1: string, raw: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const prefix = enc.encode(`${t}.`);
  const data = new Uint8Array(prefix.length + raw.length);
  data.set(prefix);
  data.set(raw, prefix.length);
  const sig = new Uint8Array(v1.match(/../g)!.map((h) => parseInt(h, 16)));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, sig, data);
}

export async function handleDataIn(db: Db, input: DataInInput): Promise<DataInOutput> {
  const started = Date.now();
  const match = matchDataInAction(input.method, input.path);
  // Not a route of this API: answered, never logged.
  if (!match) return {status: 404, body: errorBody('E_NOT_FOUND', `No action at ${input.method} ${input.path || '/'}. The actions are listed in Settings → Webhooks → Incoming.`)};
  const {action, params} = match;
  const idemHeader = input.headers.get('idempotency-key')?.trim().slice(0, 200) || null;
  const state: {key: ApiKey | null; body: string | null; records: DataInRecord[]; replayed: boolean} = {key: null, body: null, records: [], replayed: false};

  const finish = async (status: number, body: unknown, errorCode?: DataInErrorCode, extraHeaders: Record<string, string> = {}): Promise<DataInOutput> => {
    const err = (body as {error?: {message?: string}}).error;
    await db.dataInRequest
      .create({
        data: {
          apiKeyId: state.key?.id ?? null,
          keyName: state.key?.name ?? null,
          keyPrefix: state.key?.prefix ?? null,
          action: action.key,
          method: input.method.toUpperCase(),
          path: input.path.slice(0, 300),
          status,
          errorCode: errorCode ?? null,
          error: err?.message?.slice(0, 500) ?? null,
          durationMs: Date.now() - started,
          idempotencyKey: state.key ? idemHeader : null,
          replayed: state.replayed,
          body: state.body,
          response: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue,
          records: state.records as Prisma.InputJsonValue,
        },
      })
      .catch((e) => console.error('[data-in] log', String((e as Error)?.message ?? e).slice(0, 200)));
    return {status, body, headers: extraHeaders};
  };
  const fail = (code: DataInErrorCode, message: string, field?: string) => finish(DATA_IN_ERRORS[code].status, errorBody(code, message, field), code);

  // Answered without a log row: nobody can be told apart before a valid key (anyone could fill the log).
  const refuse = (code: DataInErrorCode, message: string): DataInOutput => ({status: DATA_IN_ERRORS[code].status, body: errorBody(code, message)});
  // Refused before anything is written: a wrong method, no key or an unknown key counts against the
  // connection (`datain:bad:<ip>`, 30 per 10 minutes) and leaves no request log row.
  const badKey = `datain:bad:${await ipKey(input.ip)}`;
  const blocked = () => refuse('E_RATE_LIMITED', 'Too many requests with unknown API keys from this address. Try again later.');
  const strike = async (code: DataInErrorCode, message: string) => ((await hit(db, badKey, BAD_KEY_LIMIT, 600)) ? refuse(code, message) : blocked());
  // Over the limit: not even a key lookup until the window has passed.
  if ((await db.rateHit.count({where: {key: badKey, at: {gte: new Date(Date.now() - 600_000)}}})) >= BAD_KEY_LIMIT) return blocked();
  if (match.wrongMethod) return strike('E_NOT_FOUND', `${action.path} only accepts ${action.method} requests`);

  // ─── API key ───
  const bearer = /^Bearer\s+(\S{10,200})$/i.exec((input.headers.get('authorization') ?? '').trim())?.[1];
  if (!bearer) return strike('E_UNAUTHORIZED', 'Send your API key as "Authorization: Bearer <key>".');
  const key = await db.apiKey.findUnique({where: {keyHash: await apiKeyHash(bearer)}, include: {createdBy: {include: withEmail}}});
  if (!key) return strike('E_UNAUTHORIZED', 'Unknown API key. Copy it again, or create a new one in Settings → Webhooks → Incoming.');
  const {createdBy, ...keyRow} = key;
  const user = createdBy ? asUser(createdBy) : null;
  state.key = keyRow;
  if (key.revokedAt) return fail('E_UNAUTHORIZED', 'This API key was revoked. Create a new one in Settings → Webhooks → Incoming.');
  if (!user || !user.active || user.role === 'VIEWER') {
    return fail('E_KEY_OWNER_INACTIVE', 'The person who created this API key was deactivated or can no longer make changes. Ask an admin to create a new key.');
  }

  // ─── Rate limit, size ───
  const {rateLimit} = await dataInSettings(db);
  if (!(await hit(db, `datain:${key.id}`, Math.max(1, rateLimit), 60))) return fail('E_RATE_LIMITED', `Too many requests: this key may send ${rateLimit} per minute. Slow down and retry.`);
  const tooLarge = `The body is larger than ${DATA_IN_MAX_BYTES / 1024} KB.`;
  if (Number(input.headers.get('content-length') ?? 0) > DATA_IN_MAX_BYTES) return fail('E_PAYLOAD_TOO_LARGE', tooLarge);
  const raw = new Uint8Array(await input.body());
  if (raw.byteLength > DATA_IN_MAX_BYTES) return fail('E_PAYLOAD_TOO_LARGE', tooLarge);
  state.body = bodyPreview(raw);

  // ─── Signature ───
  const header = input.headers.get('x-signature');
  if (!header) return fail('E_SIGNATURE_MISSING', 'Sign the request: X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">.');
  const sig = parseSignature(header);
  if (!sig) return fail('E_SIGNATURE_INVALID', 'X-Signature must look like t=<unix seconds>,v1=<64 hex characters>.');
  if (!(await signatureMatches(await signingSecret(db), sig.t, sig.v1, raw))) {
    return fail('E_SIGNATURE_INVALID', 'The signature does not match. Sign "<t>.<raw body>" byte for byte with the current signing secret.');
  }
  if (Math.abs(Date.now() / 1000 - sig.t) > SIGNATURE_TOLERANCE_SEC) return fail('E_SIGNATURE_EXPIRED', `The signature's time is more than ${SIGNATURE_TOLERANCE_SEC / 60} minutes away from now. Sign every request just before sending it.`);
  try {
    await db.dataInSignature.create({data: {signature: await sha256Hex(sig.v1)}});
  } catch (e) {
    if ((e as {code?: string}).code === 'P2002') return fail('E_SIGNATURE_REUSED', 'This signature was already used. Sign every request again, even a retry.');
    throw e;
  }
  await db.apiKey.update({where: {id: key.id}, data: {lastUsedAt: new Date()}});

  // ─── JSON ───
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw) || 'null');
  } catch {
    return fail('E_INVALID_JSON', 'The body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('E_INVALID_JSON', 'The body must be a JSON object.');
  state.body = bodyPreview(raw, parsed);

  // ─── Idempotency ───
  let reservation: string | null = null;
  if (idemHeader) {
    await db.dataInIdempotency.deleteMany({where: {apiKeyId: key.id, key: idemHeader, createdAt: {lt: new Date(Date.now() - IDEMPOTENCY_HOURS * 3_600_000)}}});
    try {
      reservation = (await db.dataInIdempotency.create({data: {apiKeyId: key.id, key: idemHeader, action: action.key}})).id;
    } catch (e) {
      if ((e as {code?: string}).code !== 'P2002') throw e;
      const prior = await db.dataInIdempotency.findUnique({where: {apiKeyId_key: {apiKeyId: key.id, key: idemHeader}}});
      if (prior && prior.action !== action.key) return fail('E_INVALID_FIELD', `Idempotency-Key: this key was already used for ${prior.action}. Use a new key per request.`, 'Idempotency-Key');
      if (!prior || prior.status === null) return fail('E_IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still running. Retry in a moment.');
      state.replayed = true;
      return finish(prior.status, prior.response, undefined, {'Idempotent-Replayed': 'true'});
    }
  }

  // ─── Validate and run ───
  const writer: Writer = {
    by: `API key ${key.name}`,
    source: {kind: 'api', name: key.name},
    data: {apiKeyId: key.id},
    meta: {source: {kind: 'api', name: key.name}, dataInKey: {id: key.id, name: key.name, prefix: key.prefix}, action: action.key},
    actor: {id: user.id, name: user.name, email: user.email},
  };
  const ctx: Ctx = {db, user, key: keyRow, origin: input.origin, params, writer, scope: await userScope(db, user), records: state.records};
  try {
    const body = validateBody(action, parsed as Record<string, unknown>);
    const out = await HANDLERS[action.key](ctx, body as Body);
    const response = {ok: true, action: action.key, result: out.result};
    if (reservation) await db.dataInIdempotency.update({where: {id: reservation}, data: {status: out.status, response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue}});
    return finish(out.status, response);
  } catch (e) {
    // A refused or failed request can be fixed and sent again with the same key.
    if (reservation) await db.dataInIdempotency.deleteMany({where: {id: reservation}});
    if (e instanceof DataInError) return fail(e.code, e.message, e.field);
    console.error('[data-in]', action.key, String((e as Error)?.message ?? e).slice(0, 200));
    return fail('E_INTERNAL', 'Something went wrong on our side. Retry with the same Idempotency-Key.');
  }
}
