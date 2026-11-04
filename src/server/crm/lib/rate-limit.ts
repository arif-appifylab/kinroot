import {HTTPException} from 'hono/http-exception';

import {sign} from '../kit/crypto';
import type {Db} from '../kit/db';
import {deleteInChunks} from './chunked-delete';

/**
 * DB-based rate limiting (no KV / Durable Objects on this stack): one
 * `RateHit` row per counted request, keyed like "chat:start:ip:<hash>".
 * Rows older than a day are pruned by the job runner (`pruneRateHits()`).
 *
 * Insert first, then count: two requests at the same moment both see each other's row, so a burst
 * can never slip past the limit (count-then-insert let every request of a burst through). A refused
 * request takes its row back out, so it costs nothing against the next window.
 */

const since = (windowSec: number) => new Date(Date.now() - windowSec * 1000);

/** Counts a hit; false (and nothing kept) when `limit` hits in the last `windowSec` already happened. */
export async function hit(db: Db, key: string, limit: number, windowSec: number) {
  const row = await db.rateHit.create({data: {key}, select: {id: true}});
  const used = await db.rateHit.count({where: {key, at: {gte: since(windowSec)}}});
  if (used <= limit) return true;
  await db.rateHit.deleteMany({where: {id: row.id}});
  return false;
}

/** Throws 429 when any of the limits is reached; a refused request leaves no rows behind. */
export async function rateLimit(db: Db, limits: {key: string; limit: number; windowSec: number}[], message = 'Too many requests. Please wait a moment and try again.') {
  if (!limits.length) return;
  const rows = await db.rateHit.createManyAndReturn({data: limits.map((l) => ({key: l.key})), select: {id: true}});
  const used = await Promise.all(limits.map((l) => db.rateHit.count({where: {key: l.key, at: {gte: since(l.windowSec)}}})));
  if (limits.every((l, i) => used[i]! <= l.limit)) return;
  await db.rateHit.deleteMany({where: {id: {in: rows.map((r) => r.id)}}});
  throw new HTTPException(429, {message});
}

/**
 * Keys never hold a raw IP address, nor an unkeyed hash of one (an IPv4 hash is reversed by trying
 * all 4 billion): a keyed HMAC, as the audit log does (lib/audit.ts).
 */
export const ipKey = async (ip: string | null) => (ip ? await sign(`ip:${ip}`) : 'unknown');

/** The visitor's connection (Cloudflare's header). */
export const clientIp = (h: (n: string) => string | undefined) => h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

/** A public action's limits per connection: `perMinute` and `perHour` under `scope`. */
export async function connectionLimits(h: (n: string) => string | undefined, scope: string, perMinute: number, perHour: number) {
  const who = await ipKey(clientIp(h));
  return [
    {key: `${scope}:min:${who}`, limit: perMinute, windowSec: 60},
    {key: `${scope}:hour:${who}`, limit: perHour, windowSec: 3600},
  ];
}

export async function pruneRateHits(db: Db, until = Date.now() + 10_000) {
  const cut = new Date(Date.now() - 86_400_000);
  return deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "RateHit" WHERE id IN (SELECT id FROM "RateHit" WHERE "at" < ${cut} LIMIT ${n})`);
}
