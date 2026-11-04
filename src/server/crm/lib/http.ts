import {zValidator} from '@hono/zod-validator';
import {HTTPException} from 'hono/http-exception';
import type {ZodType} from 'zod';
import {z} from 'zod';

import type {User} from '../kit/guards';
import type {Db} from '../kit/db';
import {isAdmin, type AppContext} from '../kit/guards';
import {getSettings} from './settings';

/**
 * zValidator that answers `422 {error, fields}`: `error` is the first problem in words (for a
 * status line or toast), `fields` maps each wrong field's path (`email`, `tags.2`) to its message,
 * so a form can show every error under its field (AGENTS.md › Fields).
 */
export const valid = <T extends ZodType, K extends 'json' | 'query' | 'param'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || target;
        fields[path] ??= issue.message;
      }
      const first = result.error.issues[0];
      const where = first?.path.join('.') || target;
      return c.json({error: `${where}: ${first?.message ?? 'invalid'}`, fields}, 422);
    }
  });

export const notFound = (what = 'Record') => new HTTPException(404, {message: `${what} not found`});

/**
 * A hand-written check about ONE input (`throw fieldError('slug', 'Another form already uses that
 * link', 409)`): answers `{error, fields: {[field]: message}}` in `valid()`'s shape, so the form shows
 * the words under that field (`f.fail`). Keeps its status (400 by default, 409 for "already taken").
 * `summary` is the top-level `error` when it should say more than the field's words (which field).
 * Checks that are not about one input (permissions, a record's state) stay plain HTTPExceptions.
 */
export const fieldError = (field: string, message: string, status: 400 | 409 | 422 = 400, summary = message) =>
  new HTTPException(status, {message: summary, res: Response.json({error: summary, fields: {[field]: message}}, {status})});

// Shared zod pieces
export const optStr = z.string().trim().max(5000).nullish().transform((v) => (v === '' ? null : v));
/** optStr with the field's own limit (src/crm/lib/record-limits.ts: the column's VARCHAR(n)). */
export const optText = (max: number) =>
  z.string().trim().max(max, `must be at most ${max} characters`).nullish().transform((v) => (v === '' ? null : v));
export const tags = z.array(z.string().trim().min(1).max(40)).max(50);
export const custom = z.record(z.string(), z.unknown());
export const isoDate = z
  .string()
  .nullish()
  .transform((v) => (v ? new Date(v) : v === null || v === '' ? null : undefined));

/**
 * A whole number from a query string: digits only (`1.5`, `1e3`, `0x10`, ` 7` are refused, never
 * a 500 further down), within [min, max].
 */
export const intParam = (min: number, max: number) =>
  z.string().regex(/^-?\d{1,9}$/, 'must be a whole number').transform(Number).pipe(z.number().int().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

/**
 * A whole number in a JSON body: a number, or digits in a string (forms send either); `1.5`,
 * `"1e3"`, `"0x10"` are refused. Within [min, max].
 */
export const intValue = (min: number, max: number) =>
  z
    .union([z.number(), z.string().trim().regex(/^-?\d{1,9}$/, 'must be a whole number').transform(Number)], {error: 'must be a whole number'})
    .pipe(z.number().int('must be a whole number').min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

/** Deepest page a list may ask for (offset paging; past this, narrow the filters). */
export const MAX_PAGE = 1000;

/**
 * An http(s) link (website, LinkedIn…). A bare `acme.com` is saved as `https://acme.com`;
 * any other scheme (`javascript:`, `data:`…) is refused. Empty → null, absent → unchanged.
 */
export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    const link = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
    try {
      const url = new URL(link);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')) return link;
    } catch {
      // not a URL: refused below
    }
    ctx.addIssue({code: 'custom', message: 'must be a web address starting with http:// or https://'});
    return z.NEVER;
  });

/**
 * Free text that may also be a link (a meeting's location: "Room 4", a phone number, a video
 * link). Anything written as a link must be an http(s) one.
 */
export const textOrHttpUrl = optStr.refine(
  (v) => {
    if (!v) return true;
    const s = v.replace(/[\u0000- ]/g, '');
    if (/^(javascript|data|vbscript|file|blob):/i.test(s)) return false;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
    return !scheme || /^https?$/i.test(scheme[1]!);
  },
  'links must start with http:// or https://',
);

export const listQuery = z.object({
  q: z.string().max(200).optional(),
  ownerId: z.string().max(40).optional(),
  tag: z.string().max(40).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: intParam(1, MAX_PAGE).default(1),
  pageSize: intParam(1, 200).default(50),
});

/** Members only see their own records when record visibility is set to "owner". */
export async function ownerScope(c: AppContext): Promise<{ownerId?: string}> {
  return userScope(c.var.db, c.var.user!);
}

/** ownerScope() for a given user outside a request (background jobs acting for someone). */
export async function userScope(db: Db, user: Pick<User, 'id' | 'role'>): Promise<{ownerId?: string}> {
  if (isAdmin(user)) return {};
  const settings = await getSettings(db);
  return settings.recordVisibility === 'owner' ? {ownerId: user.id} : {};
}

/** The records a note, task, interaction, file or timeline entry may be attached to. */
export type RecordRef = {contactId?: string | null; companyId?: string | null; dealId?: string | null};

/**
 * 404 unless every record named in `ref` exists and the signed-in user may see it (owner-only
 * visibility, as the record pages). Every route that takes a record id from the client calls it
 * before reading or writing what is attached to that record.
 */
export async function assertVisible(c: AppContext, ref: RecordRef & {contactIds?: string[]; companyIds?: string[]}, scope?: {ownerId?: string}) {
  const s = scope ?? (await ownerScope(c));
  const db = c.var.db;
  const contactIds = [...new Set([...(ref.contactId ? [ref.contactId] : []), ...(ref.contactIds ?? [])])];
  const companyIds = [...new Set([...(ref.companyId ? [ref.companyId] : []), ...(ref.companyIds ?? [])])];
  const [contacts, companies, deal] = await Promise.all([
    contactIds.length ? db.contact.count({where: {id: {in: contactIds}, ...s}}) : 0,
    companyIds.length ? db.company.count({where: {id: {in: companyIds}, ...s}}) : 0,
    ref.dealId ? db.deal.count({where: {id: ref.dealId, ...s}}) : 0,
  ]);
  if (contacts !== contactIds.length) throw notFound('Contact');
  if (companies !== companyIds.length) throw notFound('Company');
  if (ref.dealId && !deal) throw notFound('Deal');
}

/**
 * Where for rows attached to records (notes, tasks, interactions, files, timeline entries): with
 * owner-only visibility, a row shows when one of its records is the user's, or it has none.
 * That is what the record pages show (a deal's notes include those also linked to a contact).
 * Use inside `AND: [...]`, never spread next to another `OR`.
 */
export function attachedWhere(scope: {ownerId?: string}) {
  if (!scope.ownerId) return {};
  const ownerId = scope.ownerId;
  return {OR: [{contact: {ownerId}}, {company: {ownerId}}, {deal: {ownerId}}, {contactId: null, companyId: null, dealId: null}]};
}

export function sortBy(sort: string | undefined, dir: 'asc' | 'desc' | undefined, allowed: string[], fallback: string) {
  const field = sort && allowed.includes(sort) ? sort : fallback;
  return {[field]: dir ?? (field === fallback ? 'desc' : 'asc')};
}

/**
 * A linked contact / company / deal as this person may see it (read with its `ownerId`): null when
 * owner-only visibility hides it, and the owner id is never sent. The `shownTask` / `scopedDeal` rule
 * for any list that shows a linked record's name (AUDIT-2 L-2).
 */
export function shownLink<T extends {ownerId: string | null}>(link: T | null | undefined, scope: {ownerId?: string}): Omit<T, 'ownerId'> | null {
  if (!link || (scope.ownerId && link.ownerId !== scope.ownerId)) return null;
  const {ownerId: _o, ...rest} = link;
  return rest;
}
