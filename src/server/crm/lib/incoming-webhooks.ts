/**
 * Incoming webhooks: other tools POST to /site-api/crm/public/hooks/:token and the
 * data becomes CRM records (Settings → Webhooks → Incoming).
 *
 *   receiveIncoming()  the public endpoint: token, size, rate limit, optional
 *                      shared-secret header / HMAC signature, "listen" capture,
 *                      idempotency key; stores the request and answers 200 at once.
 *   processIncoming()  the `incoming_webhook.process` job: maps the payload with
 *                      the import field catalogue and parsers, writes through the
 *                      normal helpers (timeline, events, duplicates, scoring, lists,
 *                      createTicket…) and emits `webhook.received`.
 *
 * Retries are safe: ids the action created are kept in `result.steps` as soon
 * as they exist, so a second run finds them instead of creating them again;
 * contact / company upserts simply find the record and change nothing.
 */
import type {ZodType} from 'zod';

import {Prisma, type Company, type Contact, type IncomingWebhook, type IncomingWebhookRequest} from '../../../generated/prisma/client';
import {emailOf, parseCell} from '@/lib/import-export';
import {
  INCOMING_SECRET_NAME,
  cellOf,
  getPath,
  inConfig,
  inTargets,
  IN_ACTIONS,
  MAX_BODY_BYTES,
  type InAction,
  type InConfig,
  type InDefs,
  type InEntity,
  type InResult,
  type InTarget,
} from '@/lib/incoming-webhooks';
import {config as site} from '../../../platform/config';
import {fromB64, sha256Hex} from '../kit/crypto';
import type {Db} from '../kit/db';
import {mergeFields} from '../email/render';
import {companyBody, normalizeDomain} from '../routes/companies';
import {contactBody, contactName} from '../routes/contacts';
import {dealBody, defaultPipeline} from '../routes/deals';
import {logActivity} from './activity';
import {audit} from './audit';
import {cleanCustom} from './custom-fields';
import {associateByDomain, nameFromDomain} from './domains';
import {checkDuplicates} from './duplicates';
import {emit} from './events';
import {enqueue, kickJobs} from './jobs';
import {hit, ipKey} from './rate-limit';
import {
  contactIdByPhone,
  createCompanyRecord,
  createContactRecord,
  createDealRecord,
  findCompany,
  findContact,
  linkContactCompany,
  resolveCompany,
  updateCompanyRecord,
  updateContactRecord,
  type DealInput,
  type Writer,
} from './record-writes';
import {addToList} from './segments';
import {getSettings} from './settings';
import {createTicket} from './tickets';

// ─── Receiving ──────────────────────────────────────────────────────────────

export const tokenHash = (token: string) => sha256Hex(`inhook:${token}`);

/** Unknown tokens from one address: after this many in 10 minutes, every request from it gets 429 without a lookup. */
const BAD_TOKEN_LIMIT = 30;

const SECRET_HEADER = /auth|secret|token|signature|key|cookie|password|session/i;
/** The sender's address: never stored (the site's rule: no raw IPs). */
const ADDRESS_HEADER = /^(cf-connecting-ip(v6)?|cf-pseudo-ipv4|x-forwarded-for|x-real-ip|true-client-ip|x-client-ip|x-cluster-client-ip|forwarded)$/i;

/** Header values that look secret (and the verification header) never reach the log; address headers are left out. */
export function redactHeaders(headers: Headers, extra?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = extra?.toLowerCase();
  headers.forEach((value, name) => {
    if (Object.keys(out).length >= 40 || ADDRESS_HEADER.test(name)) return;
    out[name] = name === skip || SECRET_HEADER.test(name) ? '[redacted]' : value.slice(0, 300);
  });
  return out;
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** `customer[email]=a&items[0][name]=b&tag=x&tag=y` → {customer: {email}, items: [{name}], tag: [x, y]}. */
export function formToObject(params: URLSearchParams): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const push = key.endsWith('[]');
    const parts = key.match(/[^[\]]+/g) ?? [];
    if (!parts.length || parts.some((p) => UNSAFE.has(p))) continue;
    let cur = root as Record<string, unknown>;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      if (last) {
        const prev = cur[p];
        if (push) cur[p] = Array.isArray(prev) ? [...prev, value] : [value];
        else if (prev !== undefined && (typeof prev !== 'object' || Array.isArray(prev))) cur[p] = Array.isArray(prev) ? [...prev, value] : [prev, value];
        else cur[p] = value;
        return;
      }
      const index = /^\d{1,3}$/.test(parts[i + 1]!);
      if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = index ? [] : {};
      cur = cur[p] as Record<string, unknown>;
    });
  }
  return root;
}

export class PayloadError extends Error {}

/** JSON, form-urlencoded, multipart (fields only) or text, plus query parameters at the top level (the body wins). */
export async function parsePayload(contentType: string | null, raw: Uint8Array<ArrayBuffer>, query: URLSearchParams): Promise<unknown> {
  const ct = (contentType ?? '').toLowerCase();
  const text = new TextDecoder().decode(raw);
  const q = formToObject(query);
  let body: unknown;
  if (!text.trim()) body = undefined;
  else if (ct.includes('application/x-www-form-urlencoded')) body = formToObject(new URLSearchParams(text));
  else if (ct.includes('multipart/form-data')) {
    const form = await new Response(raw, {headers: {'content-type': contentType!}}).formData().catch(() => null);
    if (!form) throw new PayloadError('The multipart body could not be read');
    const params = new URLSearchParams();
    form.forEach((v, k) => typeof v === 'string' && params.append(k, v));
    body = formToObject(params);
  } else if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new PayloadError('The body is not valid JSON');
    }
  } else body = {text: text.slice(0, 20_000)};
  if (body === undefined) return q;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return {...q, ...(body as Record<string, unknown>)};
  return body;
}

const enc = new TextEncoder();

/** Constant-time equality of two strings (both hashed first, so lengths don't leak either). */
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const ua = new Uint8Array(x);
  const ub = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ua.length; i++) d |= ua[i]! ^ ub[i]!;
  return d === 0;
}

function decodeSignature(value: string, encoding: 'hex' | 'base64'): Uint8Array<ArrayBuffer> | null {
  const v = value.trim().replace(/^sha256=/i, '');
  if (encoding === 'hex') {
    if (!/^[0-9a-f]{64}$/i.test(v)) return null;
    return new Uint8Array(v.match(/../g)!.map((h) => parseInt(h, 16)));
  }
  try {
    const bytes = fromB64(v.replace(/-/g, '+').replace(/_/g, '/'));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Null when the request passes the webhook's verification, else why not (shown to the sender and in the log). */
export async function verifyRequest(hook: Pick<IncomingWebhook, 'verify' | 'verifyHeader' | 'verifyEncoding' | 'secretName'>, headers: Headers, raw: Uint8Array<ArrayBuffer>): Promise<string | null> {
  // Every request proves the sender (the site's rule for webhooks into the site): no check set up, nothing accepted.
  if (hook.verify !== 'header' && hook.verify !== 'hmac') return 'This webhook has no sender check yet. Set one up in Settings → Webhooks → Incoming.';
  const name = hook.verifyHeader?.trim();
  if (!name || !hook.secretName || !INCOMING_SECRET_NAME.test(hook.secretName)) return 'Verification is not set up for this webhook';
  const secret = site.ownerSecret(hook.secretName);
  if (!secret) return `The site secret ${hook.secretName} is not added yet`;
  const value = headers.get(name);
  if (!value) return `Missing the ${name} header`;
  if (hook.verify === 'header') return (await safeEqual(value.trim(), secret)) ? null : `The ${name} header does not match the secret`;
  const sig = decodeSignature(value, hook.verifyEncoding === 'base64' ? 'base64' : 'hex');
  if (!sig) return `The ${name} header is not a ${hook.verifyEncoding === 'base64' ? 'base64' : 'hex'} HMAC-SHA256 signature`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  // crypto.subtle.verify compares in constant time.
  return (await crypto.subtle.verify('HMAC', key, sig, raw)) ? null : 'The signature does not match the body';
}

export type Received = {status: 200 | 400 | 401 | 403 | 404 | 405 | 413 | 429; body: Record<string, unknown>};

type ReceiveInput = {token: string; headers: Headers; body: () => Promise<ArrayBuffer>; query: URLSearchParams; ip: string | null};

const errorBody = (error: string) => ({ok: false, error});

/** The public endpoint. Answers fast: the work happens in the `incoming_webhook.process` job. */
export async function receiveIncoming(db: Db, input: ReceiveInput): Promise<Received> {
  const badKey = `inhook:bad:${await ipKey(input.ip)}`;
  if ((await db.rateHit.count({where: {key: badKey, at: {gte: new Date(Date.now() - 600_000)}}})) >= BAD_TOKEN_LIMIT) {
    return {status: 429, body: errorBody('Too many requests to unknown webhook URLs. Try again later.')};
  }
  const hook = input.token.length >= 20 && input.token.length <= 100 ? await db.incomingWebhook.findUnique({where: {tokenHash: await tokenHash(input.token)}}) : null;
  if (!hook) {
    await db.rateHit.create({data: {key: badKey}});
    return {status: 404, body: errorBody('Unknown webhook URL. Check the address, or copy it again from Settings → Webhooks → Incoming.')};
  }
  const config = inConfig(hook.config);
  const contentType = input.headers.get('content-type');
  const log = (status: string, error: string | null, extra: Partial<Prisma.IncomingWebhookRequestUncheckedCreateInput> = {}) =>
    db.incomingWebhookRequest.create({data: {webhookId: hook.id, status, error, contentType: contentType?.slice(0, 200), headers: redactHeaders(input.headers, hook.verifyHeader), ...extra}});
  const reject = async (status: Received['status'], error: string, size = 0) => {
    await log('rejected', error, {size});
    await db.incomingWebhook.update({where: {id: hook.id}, data: {lastRequestAt: new Date(), lastStatus: 'rejected'}});
    return {status, body: errorBody(error)};
  };

  // Rate limit before reading the body (not logged: a flood must not fill the log).
  if (!(await hit(db, `inhook:${hook.id}`, Math.max(1, config.rateLimit), 60))) {
    return {status: 429, body: errorBody(`Too many requests: this URL takes ${config.rateLimit} per minute. Slow down and retry.`)};
  }

  const declared = Number(input.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return reject(413, `The body is larger than ${MAX_BODY_BYTES / 1024} KB`, declared);
  const raw = new Uint8Array(await input.body());
  if (raw.byteLength > MAX_BODY_BYTES) return reject(413, `The body is larger than ${MAX_BODY_BYTES / 1024} KB`, raw.byteLength);

  const denied = await verifyRequest(hook, input.headers, raw);
  if (denied) return reject(401, denied, raw.byteLength);

  const listening = !!hook.listenUntil && hook.listenUntil > new Date();
  if (!hook.active && !listening) return reject(403, 'This webhook is turned off. Turn it on in Settings → Webhooks → Incoming.', raw.byteLength);

  let payload: unknown;
  try {
    payload = await parsePayload(contentType, raw, input.query);
  } catch (e) {
    if (e instanceof PayloadError) return reject(400, e.message, raw.byteLength);
    throw e;
  }
  const json = JSON.parse(JSON.stringify(payload ?? {})) as Prisma.InputJsonValue;
  const headers = redactHeaders(input.headers, hook.verifyHeader);

  // "Listen for a test request": stored as the sample, nothing is written.
  if (listening) {
    const sample = {payload: json, contentType, headers, at: new Date().toISOString()};
    const {count} = await db.incomingWebhook.updateMany({where: {id: hook.id, listenUntil: {gt: new Date()}}, data: {listenUntil: null, sample: sample as Prisma.InputJsonValue, sampleAt: new Date(), lastRequestAt: new Date(), lastStatus: 'captured'}});
    if (count) {
      const row = await log('captured', null, {size: raw.byteLength, payload: json});
      return {status: 200, body: {ok: true, id: row.id, captured: true}};
    }
    if (!hook.active) return reject(403, 'This webhook is turned off. Turn it on in Settings → Webhooks → Incoming.', raw.byteLength);
  }

  const fromPath = config.idempotencyPath ? cellOf(getPath(payload, config.idempotencyPath)) : undefined;
  const key = (fromPath || input.headers.get('idempotency-key') || input.headers.get('x-idempotency-key') || '').trim().slice(0, 200) || null;
  let row: IncomingWebhookRequest;
  try {
    row = await db.incomingWebhookRequest.create({data: {webhookId: hook.id, status: 'accepted', idempotencyKey: key, contentType: contentType?.slice(0, 200), size: raw.byteLength, payload: json, headers}});
  } catch (e) {
    if ((e as {code?: string}).code !== 'P2002' || !key) throw e;
    const first = await db.incomingWebhookRequest.findUnique({where: {webhookId_idempotencyKey: {webhookId: hook.id, idempotencyKey: key}}, select: {id: true}});
    const dupe = await log('duplicate', null, {size: raw.byteLength, payload: json, result: {outcome: 'none', duplicateOf: first?.id ?? null, reason: `Same ${config.idempotencyPath || 'Idempotency-Key'} as an earlier request (${key})`}});
    await db.incomingWebhook.update({where: {id: hook.id}, data: {lastRequestAt: new Date(), lastStatus: 'duplicate'}});
    return {status: 200, body: {ok: true, id: first?.id ?? dupe.id, duplicate: true}};
  }
  await db.incomingWebhook.update({where: {id: hook.id}, data: {lastRequestAt: new Date(), lastStatus: 'accepted'}});
  await enqueue(db, 'incoming_webhook.process', {requestId: row.id});
  kickJobs();
  return {status: 200, body: {ok: true, id: row.id}};
}

// ─── Processing ─────────────────────────────────────────────────────────────

/** A problem a retry can't fix (nothing to identify the contact…): the request fails at once. */
class InboundError extends Error {
  permanent = true;
}

type Ctx = {
  db: Db;
  hook: IncomingWebhook;
  request: IncomingWebhookRequest;
  config: InConfig;
  payload: unknown;
  targets: Map<string, InTarget>;
  result: InResult;
  warnings: string[];
  source: {kind: 'webhook'; name: string};
  /** How records are written (src/server/lib/record-writes.ts): "… by incoming webhook <name>". */
  writer: Writer;
  ownerPicked?: string | null;
};

type Values = {
  fields: Record<string, unknown>;
  custom: Record<string, unknown>;
  tags: string[];
  owner?: string;
  company?: {name?: string; domain?: string};
  note?: string;
  pipeline?: string;
  stage?: string;
};

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const lower = (s: string) => s.trim().toLowerCase();

/** Saves `result` (with its steps) so a retry sees what already happened. */
async function save(ctx: Ctx) {
  await ctx.db.incomingWebhookRequest.update({where: {id: ctx.request.id}, data: {result: ctx.result as Prisma.InputJsonValue}});
}

/** Runs `create` once per request: a retry gets the id the first run stored. */
async function once(ctx: Ctx, key: string, create: () => Promise<string>): Promise<{id: string; fresh: boolean}> {
  const done = ctx.result.steps?.[key];
  if (done) return {id: done, fresh: false};
  const id = await create();
  ctx.result.steps = {...ctx.result.steps, [key]: id};
  await save(ctx);
  return {id, fresh: true};
}

/** Reads the mapped (then fixed) values for one entity, parsed like import cells. */
async function readValues(ctx: Ctx, entity: InEntity): Promise<Values> {
  const v: Values = {fields: {}, custom: {}, tags: []};
  const users = (await ctx.db.member.findMany({where: {active: true}, select: {id: true, name: true, user: {select: {email: true}}}})).map((u) => ({id: u.id, name: u.name, email: u.user?.email ?? ''}));
  const apply = (target: InTarget, cell: string) => {
    let value: unknown;
    if (!cell) {
      if (target.clearable && !ctx.config.skipBlanks) value = null;
      else return;
    } else {
      const r = parseCell(target, cell, {dateOrder: 'mdy', valueMap: {}});
      ctx.warnings.push(...(r.warnings ?? []));
      // New select options are only added by an admin; webhooks keep to the existing ones.
      if (r.newOptions?.length) return;
      value = r.value;
    }
    if (value === undefined) return;
    const f = target.field;
    if (f.startsWith('custom.')) v.custom[f.slice(7)] = value;
    else if (f === 'tags') v.tags = [...new Set([...v.tags, ...(value as string[]).map((t) => t.toLowerCase().slice(0, 40))])];
    else if (f === 'owner') {
      if (value === null) return;
      const s = lower(String(value));
      const u = users.find((x) => lower(x.email) === s || lower(x.name) === s);
      if (u) v.owner = u.id;
      else ctx.warnings.push(`No team member "${value}"; owner left as configured`);
    } else if (f === 'company') v.company = {...v.company, name: value === null ? undefined : String(value).slice(0, 200)};
    else if (f === 'companyDomain') v.company = {...v.company, domain: normalizeDomain(value === null ? null : String(value)) || undefined};
    else if (f === 'note') v.note = value === null ? undefined : String(value).slice(0, 20_000);
    else if (f === 'pipeline') v.pipeline = value === null ? undefined : String(value);
    else if (f === 'stage') v.stage = value === null ? undefined : String(value);
    else v.fields[f] = value;
  };
  for (const row of ctx.config.mapping) {
    const t = ctx.targets.get(row.target);
    if (!t || t.entity !== entity || !row.path.trim()) continue;
    const cell = cellOf(getPath(ctx.payload, row.path));
    if (cell !== undefined) apply(t, cell.slice(0, 20_000));
  }
  for (const row of ctx.config.fixed) {
    const t = ctx.targets.get(row.target);
    if (t && t.entity === entity) apply(t, row.value.trim());
  }
  if (v.company && !v.company.name && !v.company.domain) delete v.company;
  if (entity === 'contact') {
    // "Lee, Ann" or "Ann Lee"
    const full = typeof v.fields.fullName === 'string' ? v.fields.fullName.trim() : '';
    delete v.fields.fullName;
    if (full && v.fields.firstName === undefined) {
      const [a, b] = full.includes(',') ? full.split(',', 2).map((s) => s.trim()).reverse() : [full.split(/\s+/)[0], full.split(/\s+/).slice(1).join(' ')];
      v.fields.firstName = a || undefined;
      if (v.fields.lastName === undefined && b) v.fields.lastName = b;
    }
    if (typeof v.fields.email === 'string') v.fields.email = emailOf(v.fields.email) || null;
  }
  if (entity === 'company') {
    if (typeof v.fields.domain === 'string') v.fields.domain = normalizeDomain(v.fields.domain);
    else if (v.fields.domain === undefined && typeof v.fields.website === 'string') v.fields.domain = normalizeDomain(v.fields.website);
  }
  if (entity === 'deal' && typeof v.fields.currency === 'string') {
    const sym: Record<string, string> = {$: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '৳': 'BDT'};
    const cur = sym[v.fields.currency.trim()] ?? v.fields.currency.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(cur)) v.fields.currency = cur;
    else {
      ctx.warnings.push(`"${v.fields.currency}" is not a 3-letter currency code; left out`);
      delete v.fields.currency;
    }
  }
  return v;
}

/** zod-checks a body; fields that fail are dropped with a warning instead of failing the whole request. */
function checked(ctx: Ctx, schema: ZodType, input: Record<string, unknown>, required: string[] = []): Record<string, unknown> | null {
  let body = {...input};
  for (let i = 0; i < 3; i++) {
    const r = schema.safeParse(body);
    if (r.success) return r.data as Record<string, unknown>;
    const bad = new Set(r.error.issues.map((x) => String(x.path[0] ?? '')));
    if ([...bad].some((f) => required.includes(f) || !f)) {
      ctx.warnings.push(...r.error.issues.map((x) => `${String(x.path[0] ?? 'value')}: ${x.message}`));
      return null;
    }
    for (const f of bad) {
      ctx.warnings.push(`${f}: ${r.error.issues.find((x) => String(x.path[0]) === f)?.message ?? 'invalid'}; left out`);
      delete body[f];
    }
    body = {...body};
  }
  return null;
}

/** Owner for new records: fixed person or the next one in the rotation (advanced once per request). */
async function pickOwner(ctx: Ctx): Promise<string | null> {
  if (ctx.ownerPicked !== undefined) return ctx.ownerPicked;
  const owner = ctx.config.owner;
  let id: string | null = null;
  if (owner.mode === 'user' && owner.userId) id = (await ctx.db.member.findFirst({where: {id: owner.userId, active: true}, select: {id: true}}))?.id ?? null;
  if (owner.mode === 'round_robin' && owner.userIds?.length) {
    const fromStep = ctx.result.steps?.owner;
    const active = await ctx.db.member.findMany({where: {id: {in: owner.userIds}, active: true}, select: {id: true}, orderBy: {createdAt: 'asc'}});
    if (fromStep && active.some((u) => u.id === fromStep)) id = fromStep;
    else if (active.length) {
      const fresh = inConfig((await ctx.db.incomingWebhook.findUnique({where: {id: ctx.hook.id}, select: {config: true}}))?.config);
      const next = fresh.owner.next ?? 0;
      id = active[next % active.length]!.id;
      await ctx.db.incomingWebhook.update({where: {id: ctx.hook.id}, data: {config: {...fresh, owner: {...fresh.owner, next: next + 1}} as Prisma.InputJsonValue}});
      ctx.result.steps = {...ctx.result.steps, owner: id};
      await save(ctx);
    }
  }
  ctx.ownerPicked = id;
  return id;
}

async function addNote(ctx: Ctx, note: string | undefined, link: {contactId?: string; companyId?: string; dealId?: string}) {
  if (!note) return;
  await once(ctx, `note:${Object.values(link)[0]}`, async () => {
    const row = await ctx.db.note.create({data: {body: note, ...link}});
    await logActivity(ctx.db, {type: 'note', title: 'Note added', refId: row.id, ...link, data: {body: note.slice(0, 2000), source: ctx.source}, text: note.slice(0, 5000)});
    await emit(ctx.db, 'note.created', {recordId: row.id, data: row});
    return row.id;
  });
}

type ContactOutcome = {contact: Contact; outcome: 'created' | 'updated' | 'unchanged' | 'skipped'};

/** Contact upsert: match by email, then phone. `tags` from the config only go on the contact for the contact action. */
async function upsertContact(ctx: Ctx, opts: {mainRecord: boolean}): Promise<ContactOutcome | null> {
  const db = ctx.db;
  const v = await readValues(ctx, 'contact');
  const tags = [...new Set([...v.tags, ...(opts.mainRecord ? ctx.config.tags : [])])];
  const email = typeof v.fields.email === 'string' && v.fields.email ? v.fields.email : null;
  const phone = typeof v.fields.phone === 'string' && v.fields.phone ? v.fields.phone : null;
  const stepId = ctx.result.steps?.contact;
  let existing: Contact | null = stepId ? await db.contact.findUnique({where: {id: stepId}}) : null;
  // By email, then by phone (unless that would hand this email to someone with another address).
  existing ??= await findContact(db, {email, phone});
  // Created by an earlier attempt of this request: just carry on with it.
  if (existing && stepId === existing.id) return {contact: existing, outcome: 'created'};

  if (existing) {
    if (ctx.config.mode === 'create') return {contact: existing, outcome: 'skipped'};
    const before = existing;
    const parsed = checked(ctx, contactBody.partial(), defined(v.fields)) ?? {};
    const {custom: _c, companyId: _x, ...data} = parsed;
    const merged = [...new Set([...before.tags, ...tags])];
    if (merged.length > before.tags.length) data.tags = merged.slice(0, 50);
    if (v.owner && v.owner !== before.ownerId) data.ownerId = v.owner;
    else if (!before.ownerId && ctx.config.owner.mode !== 'none') data.ownerId = await pickOwner(ctx);
    let custom: Record<string, unknown> | undefined;
    if (Object.keys(v.custom).length) custom = await cleanCustom(db, 'CONTACT', v.custom, before.custom).catch((e) => (ctx.warnings.push(`Custom fields left out: ${(e as Error).message}`), undefined));
    const {contact, changes} = await updateContactRecord(db, ctx.writer, before, data, custom);
    if (v.company) {
      const company = await resolveCompany(db, ctx.writer, v.company, contact.ownerId);
      if (company) await linkContactCompany(db, contact.id, company.id);
    }
    await addNote(ctx, v.note, {contactId: contact.id});
    return {contact, outcome: changes.length ? 'updated' : 'unchanged'};
  }

  if (ctx.config.mode === 'update') return null;
  const firstName = (v.fields.firstName as string | undefined) || (email ? email.split('@')[0] : undefined) || (phone ? phone : undefined);
  if (!firstName) throw new InboundError('Nothing identifies the contact: map an email, a phone or a name');
  const ownerId = v.owner ?? (await pickOwner(ctx));
  const parsed = checked(ctx, contactBody, defined({...v.fields, firstName, tags: tags.slice(0, 50), ownerId}), ['firstName']);
  if (!parsed) throw new InboundError(`The contact could not be saved: ${ctx.warnings.at(-1) ?? 'invalid data'}`);
  const {custom: _c, companyId: _x, ...data} = parsed;
  const custom = Object.keys(v.custom).length ? await cleanCustom(db, 'CONTACT', v.custom).catch((e) => (ctx.warnings.push(`Custom fields left out: ${(e as Error).message}`), undefined)) : undefined;
  const source = (data.source as string | null | undefined) || `Webhook: ${ctx.hook.name}`;
  const {id} = await once(ctx, 'contact', async () => (await createContactRecord(db, ctx.writer, {...(data as Prisma.ContactUncheckedCreateInput), firstName: String(data.firstName), source}, custom)).id);
  let contact = (await db.contact.findUnique({where: {id}}))!;
  const company = v.company ? await resolveCompany(db, ctx.writer, v.company, contact.ownerId) : null;
  if (company) await linkContactCompany(db, contact.id, company.id);
  else await associateByDomain(db, contact.id);
  await checkDuplicates(db, 'contact', contact.id);
  await addNote(ctx, v.note, {contactId: contact.id});
  contact = (await db.contact.findUnique({where: {id}}))!;
  return {contact, outcome: 'created'};
}

async function upsertCompany(ctx: Ctx): Promise<{company: Company; outcome: 'created' | 'updated' | 'unchanged' | 'skipped'} | null> {
  const db = ctx.db;
  const v = await readValues(ctx, 'company');
  const tags = [...new Set([...v.tags, ...ctx.config.tags])];
  const domain = typeof v.fields.domain === 'string' && v.fields.domain ? v.fields.domain : null;
  const name = typeof v.fields.name === 'string' && v.fields.name ? v.fields.name : null;
  const stepId = ctx.result.steps?.company;
  let existing: Company | null = stepId ? await db.company.findUnique({where: {id: stepId}}) : null;
  existing ??= await findCompany(db, {domain, name});
  if (existing && stepId === existing.id) return {company: existing, outcome: 'created'};

  if (existing) {
    if (ctx.config.mode === 'create') return {company: existing, outcome: 'skipped'};
    const before = existing;
    const parsed = checked(ctx, companyBody.partial(), defined(v.fields)) ?? {};
    const {custom: _c, ...data} = parsed;
    const merged = [...new Set([...before.tags, ...tags])];
    if (merged.length > before.tags.length) data.tags = merged.slice(0, 50);
    if (v.owner && v.owner !== before.ownerId) data.ownerId = v.owner;
    else if (!before.ownerId && ctx.config.owner.mode !== 'none') data.ownerId = await pickOwner(ctx);
    let custom: Record<string, unknown> | undefined;
    if (Object.keys(v.custom).length) custom = await cleanCustom(db, 'COMPANY', v.custom, before.custom).catch((e) => (ctx.warnings.push(`Custom fields left out: ${(e as Error).message}`), undefined));
    const {company, changes} = await updateCompanyRecord(db, ctx.writer, before, data, custom);
    await addNote(ctx, v.note, {companyId: company.id});
    return {company, outcome: changes.length ? 'updated' : 'unchanged'};
  }

  if (ctx.config.mode === 'update') return null;
  const finalName = name || (domain ? nameFromDomain(domain) : null);
  if (!finalName) throw new InboundError('Nothing identifies the company: map a name or a domain');
  const ownerId = v.owner ?? (await pickOwner(ctx));
  const parsed = checked(ctx, companyBody, defined({...v.fields, name: finalName, tags: tags.slice(0, 50), ownerId}), ['name']);
  if (!parsed) throw new InboundError(`The company could not be saved: ${ctx.warnings.at(-1) ?? 'invalid data'}`);
  const {custom: _c, ...data} = parsed;
  const custom = Object.keys(v.custom).length ? await cleanCustom(db, 'COMPANY', v.custom).catch((e) => (ctx.warnings.push(`Custom fields left out: ${(e as Error).message}`), undefined)) : undefined;
  const {id} = await once(ctx, 'company', async () => (await createCompanyRecord(db, ctx.writer, {...(data as Prisma.CompanyUncheckedCreateInput), name: String(data.name)}, custom)).id);
  const company = (await db.company.findUnique({where: {id}}))!;
  await addNote(ctx, v.note, {companyId: company.id});
  return {company, outcome: 'created'};
}

const mergeCtx = (contact: Contact | null, company: {name: string} | null, hook: IncomingWebhook) => ({contact, company, deal: null, me: {name: hook.name, email: ''}});

async function createDeal(ctx: Ctx, contact: Contact) {
  const db = ctx.db;
  const v = await readValues(ctx, 'deal');
  const tags = [...new Set([...v.tags, ...ctx.config.tags])].slice(0, 50);
  const pipelines = await db.pipeline.findMany({include: {stages: {orderBy: {position: 'asc'}}}, orderBy: [{isDefault: 'desc'}, {position: 'asc'}]});
  const named = v.pipeline ? pipelines.find((p) => lower(p.name) === lower(v.pipeline!)) : undefined;
  if (v.pipeline && !named) ctx.warnings.push(`No pipeline "${v.pipeline}"; the configured one is used`);
  const pipeline = named ?? (await defaultPipeline(db, ctx.config.deal.pipelineId ?? undefined).catch(() => null)) ?? (await defaultPipeline(db).catch(() => null));
  if (!pipeline) throw new InboundError('Create a pipeline with at least one stage first');
  const namedStage = v.stage ? pipeline.stages.find((s) => lower(s.name) === lower(v.stage!)) : undefined;
  if (v.stage && !namedStage) ctx.warnings.push(`No stage "${v.stage}" in ${pipeline.name}; the configured one is used`);
  const stage = namedStage ?? pipeline.stages.find((s) => s.id === ctx.config.deal.stageId) ?? pipeline.stages[0]!;

  const primary = await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, include: {company: {select: {id: true, name: true}}}});
  const company = v.company ? await resolveCompany(db, ctx.writer, v.company, contact.ownerId) : (primary?.company ?? null);
  const title = (typeof v.fields.title === 'string' && v.fields.title) || mergeFields(ctx.config.deal.title || `${ctx.hook.name}: {{contact.full_name}}`, mergeCtx(contact, company, ctx.hook)).trim() || ctx.hook.name;
  const ownerId = v.owner ?? (ctx.config.owner.mode !== 'none' ? await pickOwner(ctx) : null) ?? contact.ownerId;
  const {status, lostReason, closedAt, ...rest} = v.fields as Record<string, unknown> & {status?: string; lostReason?: string | null; closedAt?: string};
  const parsed = checked(ctx, dealBody, defined({...rest, title: title.slice(0, 200), tags, ownerId}), ['title']);
  if (!parsed) throw new InboundError(`The deal could not be saved: ${ctx.warnings.at(-1) ?? 'invalid data'}`);
  const {custom: _c, contactIds: _ci, companyIds: _co, companyId: _x, pipelineId: _p, stageId: _s, ...data} = parsed;
  const custom = Object.keys(v.custom).length ? await cleanCustom(db, 'DEAL', v.custom).catch((e) => (ctx.warnings.push(`Custom fields left out: ${(e as Error).message}`), undefined)) : undefined;
  const settings = await getSettings(db);
  const {id} = await once(ctx, 'deal', async () => {
    const deal = await createDealRecord(db, ctx.writer, {
      data: {...(data as DealInput['data']), title: String(data.title), currency: (data.currency as string | undefined) ?? settings.currency},
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: status === 'WON' || status === 'LOST' ? status : 'OPEN',
      lostReason: lostReason ?? null,
      closedAt: closedAt ? new Date(closedAt) : null,
      contactId: contact.id,
      companyId: company?.id ?? null,
      custom,
    });
    return deal.id;
  });
  const deal = (await db.deal.findUnique({where: {id}}))!;
  await addNote(ctx, v.note, {dealId: deal.id});
  return deal;
}

async function createTicketFor(ctx: Ctx, contact: Contact) {
  const v = await readValues(ctx, 'ticket');
  const tags = [...new Set([...v.tags, ...ctx.config.tags])].slice(0, 50);
  const f = v.fields as {subject?: string | null; description?: string | null; priority?: string; category?: string | null};
  const subject = f.subject || mergeFields(ctx.config.ticket.subject || `${ctx.hook.name}: {{contact.full_name}}`, mergeCtx(contact, null, ctx.hook)).trim() || ctx.hook.name;
  const assigneeId = ctx.config.owner.mode !== 'none' ? await pickOwner(ctx) : null;
  const {id} = await once(ctx, 'ticket', async () => {
    const ticket = await createTicket(ctx.db, {
      subject,
      description: f.description || null,
      source: 'WEBHOOK',
      priority: (f.priority as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined) ?? ctx.config.ticket.priority,
      category: f.category || ctx.config.ticket.category,
      tags,
      assigneeId,
      contactId: contact.id,
    });
    await audit(ctx.db, null, {action: 'ticket.created', entity: 'ticket', recordId: ticket.id, label: ticket.subject, meta: {source: 'incoming webhook', webhook: ctx.hook.name, webhookId: ctx.hook.id}});
    return ticket.id;
  });
  return (await ctx.db.ticket.findUnique({where: {id}}))!;
}

/** "Only start automations": the contact with that email / phone, if there is one (nothing is written). */
async function findContactOnly(ctx: Ctx) {
  const v = await readValues(ctx, 'contact');
  const email = typeof v.fields.email === 'string' && v.fields.email ? v.fields.email : null;
  if (email) {
    const c = await ctx.db.contact.findFirst({where: {email: {equals: email, mode: 'insensitive'}}, orderBy: {createdAt: 'asc'}, select: {id: true}});
    if (c) return c.id;
  }
  return contactIdByPhone(ctx.db, typeof v.fields.phone === 'string' ? v.fields.phone : null);
}

async function runAction(ctx: Ctx) {
  const action = ctx.hook.action as InAction;
  const r = ctx.result;
  if (action === 'contact' || action === 'deal' || action === 'ticket') {
    const c = await upsertContact(ctx, {mainRecord: action === 'contact'});
    if (!c) {
      Object.assign(r, {outcome: 'skipped', reason: 'No matching contact to update (the webhook only updates existing contacts)'});
      return;
    }
    r.contactId = c.contact.id;
    if (action === 'contact') Object.assign(r, {outcome: c.outcome, entity: 'contact', recordId: c.contact.id, label: contactName(c.contact)});
    if (c.outcome === 'skipped' && action === 'contact') r.reason = 'A contact with this email or phone exists (the webhook only creates new contacts)';
    if (ctx.config.listId && (action !== 'contact' || c.outcome !== 'skipped')) await addToList(ctx.db, ctx.config.listId, [c.contact.id], {source: 'webhook'});
    if (action === 'deal') {
      const deal = await createDeal(ctx, c.contact);
      Object.assign(r, {outcome: 'created', entity: 'deal', recordId: deal.id, label: deal.title, dealId: deal.id, companyId: deal.companyId});
    }
    if (action === 'ticket') {
      const ticket = await createTicketFor(ctx, c.contact);
      Object.assign(r, {outcome: 'created', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`, ticketId: ticket.id, companyId: ticket.companyId});
    }
    return;
  }
  if (action === 'company') {
    const c = await upsertCompany(ctx);
    if (!c) Object.assign(r, {outcome: 'skipped', reason: 'No matching company to update (the webhook only updates existing companies)'});
    else {
      Object.assign(r, {outcome: c.outcome, entity: 'company', recordId: c.company.id, label: c.company.name, companyId: c.company.id});
      if (c.outcome === 'skipped') r.reason = 'A company with this domain or name exists (the webhook only creates new companies)';
    }
    return;
  }
  r.outcome = 'none';
  r.contactId = await findContactOnly(ctx);
}

/** `incoming_webhook.process` job. Safe to run twice; `final` is the last attempt. */
export async function processIncoming(db: Db, requestId: string, final: boolean) {
  const request = await db.incomingWebhookRequest.findUnique({where: {id: requestId}, include: {webhook: true}});
  if (!request || request.status !== 'accepted') return;
  const {webhook: hook, ...req} = request;
  await db.incomingWebhookRequest.update({where: {id: req.id}, data: {attempts: {increment: 1}}});
  const defs = await db.customFieldDef.findMany({where: {entity: {in: ['CONTACT', 'COMPANY', 'DEAL']}}, orderBy: {position: 'asc'}});
  const byEntity: InDefs = {CONTACT: defs.filter((d) => d.entity === 'CONTACT'), COMPANY: defs.filter((d) => d.entity === 'COMPANY'), DEAL: defs.filter((d) => d.entity === 'DEAL')};
  const action = (hook.action in IN_ACTIONS ? hook.action : 'automations') as InAction;
  const previous = (req.result ?? {}) as InResult;
  const ctx: Ctx = {
    db,
    hook,
    request: req,
    config: inConfig(hook.config),
    payload: req.payload,
    targets: new Map(inTargets(action, byEntity).map((t) => [t.key, t])),
    result: {outcome: 'none', steps: previous.steps},
    warnings: [],
    source: {kind: 'webhook', name: hook.name},
    writer: {by: `incoming webhook ${hook.name}`, source: {kind: 'webhook', name: hook.name}, data: {webhookId: hook.id}, meta: {source: 'incoming webhook', webhook: hook.name, webhookId: hook.id}},
  };
  ctx.writer.once = async (key, create) => (await once(ctx, key, create)).id;
  try {
    await runAction(ctx);
    const r = ctx.result;
    if (ctx.warnings.length) r.warnings = [...new Set(ctx.warnings)].slice(0, 20);
    // Every processed request (skipped ones too) can start automations.
    await once(ctx, 'event', async () => {
      const event = await emit(db, 'webhook.received', {
        entity: 'incoming_webhook',
        recordId: hook.id,
        data: {webhookId: hook.id, webhook: {id: hook.id, name: hook.name}, requestId: req.id, action, outcome: r.outcome, recordId: r.recordId ?? null, contactId: r.contactId ?? null, companyId: r.companyId ?? null, dealId: r.dealId ?? null, ticketId: r.ticketId ?? null, data: req.payload},
      });
      return event?.id ?? 'none';
    });
    await db.incomingWebhookRequest.update({where: {id: req.id}, data: {status: 'processed', result: r as Prisma.InputJsonValue, error: null, processedAt: new Date()}});
    await db.incomingWebhook.update({where: {id: hook.id}, data: {lastStatus: 'processed'}});
  } catch (e) {
    const message = (e as Error).message.split('\n').pop()?.slice(0, 500) || 'Processing failed';
    const permanent = e instanceof InboundError;
    if (permanent || final) {
      await db.incomingWebhookRequest.update({where: {id: req.id}, data: {status: 'failed', error: message, processedAt: new Date(), result: {...ctx.result, warnings: ctx.warnings.slice(0, 20)} as Prisma.InputJsonValue}});
      await db.incomingWebhook.update({where: {id: hook.id}, data: {lastStatus: 'failed'}});
      if (permanent) return;
    } else {
      await db.incomingWebhookRequest.update({where: {id: req.id}, data: {error: `${message} (retrying)`}});
    }
    throw e;
  }
}

/** Requests are kept 30 days. */
export async function pruneIncomingRequests(db: Db, days: number) {
  await db.incomingWebhookRequest.deleteMany({where: {createdAt: {lt: new Date(Date.now() - days * 86_400_000)}}});
}
