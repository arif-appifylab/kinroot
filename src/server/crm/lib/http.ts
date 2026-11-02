import {zValidator} from '@hono/zod-validator';
import {HTTPException} from 'hono/http-exception';
import type {ZodType} from 'zod';
import {z} from 'zod';

import type {User} from '../kit/guards';
import type {Db} from '../kit/db';
import {isAdmin, type AppContext} from '../kit/guards';
import {getSettings} from './settings';

/** zValidator that answers 400 with the first readable issue. */
export const valid = <T extends ZodType, K extends 'json' | 'query' | 'param'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.join('.') || target;
      return c.json({error: `${where}: ${issue?.message ?? 'invalid'}`}, 400);
    }
  });

export const notFound = (what = 'Record') => new HTTPException(404, {message: `${what} not found`});

// Shared zod pieces
export const optStr = z.string().trim().max(5000).nullish().transform((v) => (v === '' ? null : v));
export const tags = z.array(z.string().trim().min(1).max(40)).max(50);
export const custom = z.record(z.string(), z.unknown());
export const isoDate = z
  .string()
  .nullish()
  .transform((v) => (v ? new Date(v) : v === null || v === '' ? null : undefined));

export const listQuery = z.object({
  q: z.string().optional(),
  ownerId: z.string().optional(),
  tag: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
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

export function sortBy(sort: string | undefined, dir: 'asc' | 'desc' | undefined, allowed: string[], fallback: string) {
  const field = sort && allowed.includes(sort) ? sort : fallback;
  return {[field]: dir ?? (field === fallback ? 'desc' : 'asc')};
}
