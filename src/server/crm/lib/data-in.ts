/**
 * The Data in webhook: other tools push data in by POSTing JSON to
 * `/site-api/crm/public/data-in/<action path>/<access token>` with an `X-Signature-Token` header
 * (catalogue: src/crm/lib/data-in.ts; URL shapes: src/crm/lib/data-in-url.ts).
 *
 *   handleDataInUrl() the public endpoint: connection limit → route → access token → the admin it
 *                    acts as still active → rate limit → size → signature token → JSON →
 *                    Idempotency-Key → validation (zod built from the catalogue fields) → the
 *                    action's handler. Every request with a valid access token is logged
 *                    (DataInRequest), refused or not.
 *   HANDLERS         one per catalogue action. They write through the shared
 *                    helpers (record-writes, createNote, logInteraction,
 *                    createTicket, addToList, emit…), acting as the admin who
 *                    turned the webhook on, so the timeline, events, scoring,
 *                    automations, history and audit log stay in step.
 *
 * Errors always answer `{error: {code, message, field?}}` with a stable code.
 */
import {HTTPException} from 'hono/http-exception';
import {z, type ZodType} from 'zod';

import type {ContactList, EntityType, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {
  DATA_IN_ERRORS,
  DATA_IN_MAX_BYTES,
  DEFAULT_DATA_IN_RATE_LIMIT,
  IDEMPOTENCY_HOURS,
  matchDataInAction,
  type DataInAction,
  type DataInActionKey,
  type DataInErrorCode,
  type DataInField,
  type DataInRecord,
} from '@/lib/data-in';
import {ACCESS_TOKEN_PATTERN, DATA_IN_URL_NAME, DATA_IN_URL_TOKEN_PREFIX, SIGNATURE_TOKEN_HEADER, SIGNATURE_TOKEN_PREFIX, type DataInUrlState} from '@/lib/data-in-url';
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
import {httpUrl, userScope} from './http';
import {hit, ipKey} from './rate-limit';
import {createCompanyRecord, createContactRecord, createDealRecord, findCompany, findContact, linkContactCompany, resolveCompany, updateCompanyRecord, updateContactRecord, type DealInput, type Writer} from './record-writes';
import {addToList} from './segments';
import {getSettings} from './settings';
import {createTicket} from './tickets';
import {asUser, withEmail} from './users';
import {strings} from './json-list';

// ─── Settings: rate limit, Data in URL ──────────────────────────────────────

const SETTING_KEY = 'data-in';

/**
 * The Data in URL: an access token in the URL path and a signature token sent as the
 * `X-Signature-Token` header, both needed.
 * Each is kept twice: its SHA-256 (what requests are compared against, in constant time) and
 * encrypted with encryptJson() (only for an admin's "Show tokens"). `createdById` is the admin who
 * turned it on or regenerated it last: requests act as them.
 */
type UrlStored = {id: string; enabled: boolean; accessHash: string; access: string; signatureHash: string; signature: string; createdById: string; rotatedAt: string};
type Stored = {rateLimit?: number; url?: UrlStored};

async function stored(db: Db): Promise<Stored> {
  const row = await db.setting.findUnique({where: {key: SETTING_KEY}});
  return (row?.value ?? {}) as Stored;
}

async function store(db: Db, patch: Partial<Stored>) {
  // Only the keys in use: anything an older version kept in this row is dropped on the next save.
  const {rateLimit, url} = await stored(db);
  const value = {...(rateLimit === undefined ? {} : {rateLimit}), ...(url ? {url} : {}), ...patch};
  await db.setting.upsert({where: {key: SETTING_KEY}, create: {key: SETTING_KEY, value}, update: {value}});
}

export async function dataInSettings(db: Db) {
  const s = await stored(db);
  return {rateLimit: s.rateLimit ?? DEFAULT_DATA_IN_RATE_LIMIT};
}

export const saveRateLimit = (db: Db, rateLimit: number) => store(db, {rateLimit});

const accessHash = (token: string) => sha256Hex(`datain-url:${token}`);
const signatureTokenHash = (token: string) => sha256Hex(`datain-sigtoken:${token}`);

/** Equal-length hex digests compared without an early exit. */
function sameHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const maskToken = (prefix: string, token: string) => `${prefix}${'•'.repeat(12)}${token.slice(-4)}`;

export async function dataInUrlState(db: Db): Promise<DataInUrlState> {
  const u = (await stored(db)).url;
  if (!u) return {enabled: false, ready: false, rotatedAt: null, createdBy: null, accessMasked: null, signatureMasked: null};
  const [tokens, createdBy] = await Promise.all([
    urlTokens(u),
    db.member.findUnique({where: {id: u.createdById}, select: {id: true, name: true, active: true}}),
  ]);
  return {
    enabled: u.enabled,
    ready: !!tokens,
    rotatedAt: u.rotatedAt,
    createdBy,
    accessMasked: tokens ? maskToken(DATA_IN_URL_TOKEN_PREFIX, tokens.access) : null,
    signatureMasked: tokens ? maskToken(SIGNATURE_TOKEN_PREFIX, tokens.signature) : null,
  };
}

async function urlTokens(u: UrlStored): Promise<{access: string; signature: string} | null> {
  const [access, signature] = await Promise.all([decryptJson<string>(u.access).catch(() => null), decryptJson<string>(u.signature).catch(() => null)]);
  return access && signature ? {access, signature} : null;
}

/** Both tokens in full, for an admin's "Show tokens" (the route audits it). */
export async function revealDataInUrl(db: Db): Promise<{access: string; signature: string} | null> {
  const u = (await stored(db)).url;
  return u ? urlTokens(u) : null;
}

/** New tokens (the old URL and header stop working at once), acting as `memberId` from now on. */
export async function regenerateDataInUrl(db: Db, memberId: string, enabled?: boolean) {
  const before = (await stored(db)).url;
  const access = `${DATA_IN_URL_TOKEN_PREFIX}${randomToken(30)}`;
  const signature = `${SIGNATURE_TOKEN_PREFIX}${randomToken(30)}`;
  const url: UrlStored = {
    id: randomToken(9),
    enabled: enabled ?? before?.enabled ?? true,
    accessHash: await accessHash(access),
    access: await encryptJson(access),
    signatureHash: await signatureTokenHash(signature),
    signature: await encryptJson(signature),
    createdById: memberId,
    rotatedAt: new Date().toISOString(),
  };
  await store(db, {url});
  return {access, signature, previous: before ? await urlTokens(before) : null};
}

/** Turns the Data in URL on (making its tokens the first time) or off. On: requests act as `memberId`. */
export async function setDataInUrlEnabled(db: Db, memberId: string, enabled: boolean) {
  const u = (await stored(db)).url;
  if (!u || !(await urlTokens(u))) {
    if (!enabled) return;
    await regenerateDataInUrl(db, memberId, true);
    return;
  }
  await store(db, {url: {...u, enabled, ...(enabled ? {createdById: memberId} : {})}});
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

/** Catalogue fields that hold a link (contacts' and companies' LinkedIn, companies' website). */
const URL_FIELDS = new Set(['website', 'linkedin']);

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
      // Links go through the app's own check: http(s) only (a bare `acme.com` becomes https://acme.com).
      s = URL_FIELDS.has(f.name)
        ? str.transform((v, ctx) => {
            const r = httpUrl.safeParse(v);
            if (r.success) return r.data;
            ctx.addIssue({code: 'custom', message: 'must be a web address starting with http:// or https://'});
            return z.NEVER;
          })
        : str;
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

/** How a request's sender is named in the log, on records' source and in event data. */
type Sender = {id: string; name: string};

type Ctx = {
  db: Db;
  user: User;
  key: Sender;
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

/** Unknown URLs from one address: after this many in 10 minutes, it gets E_RATE_LIMITED without a lookup. */
const BAD_URL_LIMIT = 30;
const BODY_PREVIEW = 4000;

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

/** Who a request acts as, and how it is named in the log, the records' source and idempotency. */
type Caller = {
  key: Sender;
  user: User;
  log: {name: string; prefix: string};
  writer: Pick<Writer, 'by' | 'source' | 'data'> & {meta: Record<string, unknown>};
};

type Run = {
  db: Db;
  input: DataInInput;
  action: DataInAction;
  params: Record<string, string>;
  idemHeader: string | null;
  state: {log: Caller['log'] | null; body: string | null; records: DataInRecord[]; replayed: boolean};
  finish: (status: number, body: unknown, errorCode?: DataInErrorCode, extraHeaders?: Record<string, string>) => Promise<DataInOutput>;
  fail: (code: DataInErrorCode, message: string, field?: string) => Promise<DataInOutput>;
  refuse: (code: DataInErrorCode, message: string) => DataInOutput;
  /** Counts a refusal against the connection (no log row); past the limit, E_RATE_LIMITED. */
  strike: (code: DataInErrorCode, message: string) => Promise<DataInOutput>;
  blockedNow: () => Promise<DataInOutput | null>;
};

/** Logging and refusals. `logPath` never holds a token. */
async function begin(db: Db, input: DataInInput, action: DataInAction, params: Record<string, string>, logPath: string): Promise<Run> {
  const started = Date.now();
  const idemHeader = input.headers.get('idempotency-key')?.trim().slice(0, 200) || null;
  const state: Run['state'] = {log: null, body: null, records: [], replayed: false};

  const finish: Run['finish'] = async (status, body, errorCode, extraHeaders = {}) => {
    const err = (body as {error?: {message?: string}}).error;
    await db.dataInRequest
      .create({
        data: {
          keyName: state.log?.name ?? null,
          keyPrefix: state.log?.prefix ?? null,
          action: action.key,
          method: input.method.toUpperCase(),
          path: logPath.slice(0, 300),
          status,
          errorCode: errorCode ?? null,
          error: err?.message?.slice(0, 500) ?? null,
          durationMs: Date.now() - started,
          idempotencyKey: state.log ? idemHeader : null,
          replayed: state.replayed,
          body: state.body,
          response: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue,
          records: state.records as Prisma.InputJsonValue,
        },
      })
      .catch((e) => console.error('[data-in] log', String((e as Error)?.message ?? e).slice(0, 200)));
    return {status, body, headers: extraHeaders};
  };
  const fail: Run['fail'] = (code, message, field) => finish(DATA_IN_ERRORS[code].status, errorBody(code, message, field), code);

  // Answered without a log row: nobody can be told apart before a valid access token (anyone could fill the log).
  const refuse: Run['refuse'] = (code, message) => ({status: DATA_IN_ERRORS[code].status, body: errorBody(code, message)});
  // Refused before anything is written: a wrong method or an unknown access token counts against
  // the connection (`datain:bad:<ip>`, 30 per 10 minutes) and leaves no log row.
  const badKey = `datain:bad:${await ipKey(input.ip)}`;
  const blocked = () => refuse('E_RATE_LIMITED', 'Too many requests with unknown Data in URLs from this address. Try again later.');
  const strike: Run['strike'] = async (code, message) => ((await hit(db, badKey, BAD_URL_LIMIT, 600)) ? refuse(code, message) : blocked());
  // Over the limit: not even a token lookup until the window has passed.
  const blockedNow = async () => ((await db.rateHit.count({where: {key: badKey, at: {gte: new Date(Date.now() - 600_000)}}})) >= BAD_URL_LIMIT ? blocked() : null);
  return {db, input, action, params, idemHeader, state, finish, fail, refuse, strike, blockedNow};
}

/** The caller's rate limit, then the body's size; the raw body, or the answer that refused it. */
async function limitAndRead(run: Run, rateKey: string, per: string, rateLimit: number): Promise<Uint8Array | DataInOutput> {
  if (!(await hit(run.db, rateKey, Math.max(1, rateLimit), 60))) return run.fail('E_RATE_LIMITED', `Too many requests: ${per} may send ${rateLimit} per minute. Slow down and retry.`);
  const tooLarge = `The body is larger than ${DATA_IN_MAX_BYTES / 1024} KB.`;
  if (Number(run.input.headers.get('content-length') ?? 0) > DATA_IN_MAX_BYTES) return run.fail('E_PAYLOAD_TOO_LARGE', tooLarge);
  const raw = new Uint8Array(await run.input.body());
  if (raw.byteLength > DATA_IN_MAX_BYTES) return run.fail('E_PAYLOAD_TOO_LARGE', tooLarge);
  run.state.body = bodyPreview(raw);
  return raw;
}

/** JSON → Idempotency-Key → validation → the action's handler. */
async function runAction(run: Run, caller: Caller, raw: Uint8Array, opts: {idemScope: string; jsonHint?: string; prepare?: (body: Record<string, unknown>) => Record<string, unknown>}): Promise<DataInOutput> {
  const {db, action, idemHeader, state, fail, finish} = run;
  // ─── JSON ───
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw) || 'null');
  } catch {
    return fail('E_INVALID_JSON', `The body is not valid JSON.${opts.jsonHint ?? ''}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('E_INVALID_JSON', `The body must be a JSON object.${opts.jsonHint ?? ''}`);
  state.body = bodyPreview(raw, parsed);

  // ─── Idempotency ───
  let reservation: string | null = null;
  if (idemHeader) {
    await db.dataInIdempotency.deleteMany({where: {scope: opts.idemScope, key: idemHeader, createdAt: {lt: new Date(Date.now() - IDEMPOTENCY_HOURS * 3_600_000)}}});
    try {
      reservation = (await db.dataInIdempotency.create({data: {scope: opts.idemScope, key: idemHeader, action: action.key}})).id;
    } catch (e) {
      if ((e as {code?: string}).code !== 'P2002') throw e;
      const prior = await db.dataInIdempotency.findUnique({where: {scope_key: {scope: opts.idemScope, key: idemHeader}}});
      if (prior && prior.action !== action.key) return fail('E_INVALID_FIELD', `Idempotency-Key: this key was already used for ${prior.action}. Use a new key per request.`, 'Idempotency-Key');
      if (!prior || prior.status === null) return fail('E_IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still running. Retry in a moment.');
      state.replayed = true;
      return finish(prior.status, prior.response, undefined, {'Idempotent-Replayed': 'true'});
    }
  }

  // ─── Validate and run ───
  const {user} = caller;
  const writer: Writer = {...caller.writer, actor: {id: user.id, name: user.name, email: user.email}};
  const ctx: Ctx = {db, user, key: caller.key, origin: run.input.origin, params: run.params, writer, scope: await userScope(db, user), records: state.records};
  try {
    const input = parsed as Record<string, unknown>;
    const body = validateBody(action, opts.prepare ? opts.prepare(input) : input);
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

const OWNER_INACTIVE = 'can no longer make changes';

// ─── The Data in URL ────────────────────────────────────────────────────────

/**
 * Values as automation tools send them: an unmapped field arrives as "" (left out here, so it never
 * clears a value; null still does), numbers and true/false as text, lists as "a, b", and an object
 * as JSON text. Anything else is left as sent, for validateBody() to accept or refuse by name.
 */
function lenient(action: DataInAction, body: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map(action.fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.trim() === '') continue;
    const f = fields.get(k);
    if (f && typeof v === 'string') {
      const t = v.trim();
      if ((f.type === 'number' || f.type === 'integer') && /^-?\d+(\.\d+)?$/.test(t)) {
        out[k] = Number(t);
        continue;
      }
      if (f.type === 'boolean' && /^(true|false|yes|no|1|0)$/i.test(t)) {
        out[k] = /^(true|yes|1)$/i.test(t);
        continue;
      }
      if (f.type === 'string[]' || f.type === 'email[]') {
        out[k] = t.split(',').map((x) => x.trim()).filter(Boolean);
        continue;
      }
      if (f.type === 'object' && t.startsWith('{')) {
        try {
          const o: unknown = JSON.parse(t);
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            out[k] = o;
            continue;
          }
        } catch {
          // not JSON: refused by validation, naming the field
        }
      }
    }
    out[k] = v;
  }
  return out;
}

const URL_GONE = 'This Data in URL is not active: it was regenerated or turned off. Copy the current URL from Settings → Webhooks → Incoming.';

/**
 * `POST /site-api/crm/public/data-in/<action path>/<access token>` with `X-Signature-Token`:
 * connection limit → route → access token (unknown, regenerated or turned off: 404, counted
 * against the connection) → the admin it acts as still active → rate limit → size → signature
 * token (401) → JSON → Idempotency-Key → validation → handler. Neither token is ever logged.
 */
export async function handleDataInUrl(db: Db, input: DataInInput): Promise<DataInOutput> {
  const path = input.path.replace(/\/+$/, '');
  const cut = path.lastIndexOf('/');
  const token = cut >= 0 ? path.slice(cut + 1) : '';
  const actionPath = cut > 0 ? path.slice(0, cut) : '/';
  const match = matchDataInAction(input.method, actionPath);
  if (!match) return {status: 404, body: errorBody('E_NOT_FOUND', `No action at ${input.method} ${actionPath}/{access_token}. The actions and their URLs are listed in Settings → Webhooks → Incoming.`)};
  const run = await begin(db, input, match.action, match.params, `${actionPath}/{access_token}`);
  const {action, fail, strike} = run;
  const blocked = await run.blockedNow();
  if (blocked) return blocked;
  if (match.wrongMethod) return strike('E_NOT_FOUND', `This URL only accepts ${action.method} requests.`);

  // ─── Access token (in the URL) ───
  if (!ACCESS_TOKEN_PATTERN.test(token)) return strike('E_NOT_FOUND', URL_GONE);
  const settings = await stored(db);
  const url = settings.url;
  if (!url || !url.enabled || !sameHex(await accessHash(token), url.accessHash)) return strike('E_NOT_FOUND', URL_GONE);
  run.state.log = {name: DATA_IN_URL_NAME, prefix: token.slice(0, DATA_IN_URL_TOKEN_PREFIX.length + 4)};
  const member = await db.member.findUnique({where: {id: url.createdById}, include: withEmail});
  const user = member ? asUser(member) : null;
  if (!user || !user.active || user.role === 'VIEWER') {
    return fail('E_KEY_OWNER_INACTIVE', `The admin who turned on this Data in URL was deactivated or ${OWNER_INACTIVE}. Ask an admin to regenerate the URL.`);
  }

  // ─── Rate limit, size ───
  const raw = await limitAndRead(run, `datain:url:${url.id}`, 'the Data in URL', settings.rateLimit ?? DEFAULT_DATA_IN_RATE_LIMIT);
  if (!(raw instanceof Uint8Array)) return raw;

  // ─── Signature token (a header) ───
  const sent = input.headers.get(SIGNATURE_TOKEN_HEADER)?.trim();
  if (!sent) return fail('E_UNAUTHORIZED', `${SIGNATURE_TOKEN_HEADER}: add this header with the signature token from Settings → Webhooks → Incoming.`, SIGNATURE_TOKEN_HEADER);
  if (sent.length > 200 || !sameHex(await signatureTokenHash(sent), url.signatureHash)) {
    return fail('E_UNAUTHORIZED', `${SIGNATURE_TOKEN_HEADER}: the signature token does not match. Copy it again from Settings → Webhooks → Incoming (it changes when the URL is regenerated).`, SIGNATURE_TOKEN_HEADER);
  }

  const name = DATA_IN_URL_NAME;
  const caller: Caller = {
    key: {id: `url:${url.id}`, name},
    user,
    log: run.state.log,
    writer: {
      by: name,
      source: {kind: 'api', name},
      data: {dataInUrl: url.id},
      meta: {source: {kind: 'api', name}, dataInUrl: {id: url.id}, action: action.key},
    },
  };
  return runAction(run, caller, raw, {
    idemScope: `url:${url.id}`,
    jsonHint: ' Send the body as JSON: set your automation tool\'s payload or body type to JSON.',
    prepare: (body) => lenient(action, body),
  });
}
