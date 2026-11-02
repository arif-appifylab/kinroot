import {HTTPException} from 'hono/http-exception';

import {sha256Hex} from '../kit/crypto';
import type {Db} from '../kit/db';

/**
 * DB-based rate limiting (no KV / Durable Objects on this stack): one
 * `RateHit` row per counted request, keyed like "chat:start:ip:<hash>".
 * Rows older than a day are pruned by the job runner (`pruneRateHits()`).
 */

/** Counts a hit; false (and nothing stored) when `limit` hits in the last `windowSec` already happened. */
export async function hit(db: Db, key: string, limit: number, windowSec: number) {
  const since = new Date(Date.now() - windowSec * 1000);
  const used = await db.rateHit.count({where: {key, at: {gte: since}}});
  if (used >= limit) return false;
  await db.rateHit.create({data: {key}});
  return true;
}

/** Throws 429 when any of the limits is reached. Checks all before counting, so a refused request costs nothing. */
export async function rateLimit(db: Db, limits: {key: string; limit: number; windowSec: number}[], message = 'Too many requests. Please wait a moment and try again.') {
  for (const l of limits) {
    const used = await db.rateHit.count({where: {key: l.key, at: {gte: new Date(Date.now() - l.windowSec * 1000)}}});
    if (used >= l.limit) throw new HTTPException(429, {message});
  }
  if (limits.length) await db.rateHit.createMany({data: limits.map((l) => ({key: l.key}))});
}

/** Keys never hold a raw IP address. */
export const ipKey = async (ip: string | null) => (ip ? (await sha256Hex(`ip:${ip}`)).slice(0, 20) : 'unknown');

export async function pruneRateHits(db: Db) {
  await db.rateHit.deleteMany({where: {at: {lt: new Date(Date.now() - 86_400_000)}}});
}
