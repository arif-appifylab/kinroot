import {HTTPException} from 'hono/http-exception';

import type {Prisma} from '../../../generated/prisma/client';
import {IdempotencyConflict, idempotencyKeyOf, idempotent} from '../../../platform/idempotency';
import type {Db} from '../kit/db';

/**
 * Public writes a visitor's browser may send twice (a retry after a lost connection, a reload):
 * the first one creates the thing, a repeat answers what the first answered and does nothing else
 * (docs/agent/orders-and-stock.md). The browser sends an `idempotency-key` per attempt
 * (src/lib/idempotency.ts); the template's `idempotent()` keeps the key and the first write in ONE
 * transaction.
 *
 *   const once = onceOf(c.req.raw, `form:${form.id}`, {answers});
 *   try {
 *     const {value, replayed} = await runOnce(db, once, (tx) => tx.thing.create({…, select: {id: true}}));
 *     if (!replayed) { …emails, events, notifications… }
 *   } catch (error) {
 *     const first = await orEarlier<{id: string}>(db, once, error);   // the first attempt's answer, or the refusal
 *   }
 */

export type Once = {scope: string; key: string; request: unknown};

/** The request's key with its scope and what was asked for; null without a (valid) key. */
export function onceOf(request: Request, scope: string, asked: unknown): Once | null {
  const key = idempotencyKeyOf(request);
  return key ? {scope, key, request: asked} : null;
}

const CONFLICT = 'This request was already sent with different details. Please reload the page and try again.';

/**
 * `work` in one transaction, once per key: a repeat (at the same moment or later) gets the first
 * answer with `replayed: true` and runs nothing. Without a key, `work` simply runs in a transaction.
 * Keep the answer to ids (it is stored); keep `work` to database statements.
 */
export async function runOnce<T>(db: Db, once: Once | null, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<{value: T; replayed: boolean}> {
  if (!once) return {value: await db.$transaction(work), replayed: false};
  try {
    return await idempotent(db, once, work);
  } catch (error) {
    if (error instanceof IdempotencyConflict) throw new HTTPException(409, {message: CONFLICT});
    throw error;
  }
}

class NotYet extends Error {}

/**
 * What an earlier request with this key answered, null when none finished. One still running is
 * waited for. Nothing is written: a key not taken yet is left free.
 */
export async function earlier<T>(db: Db, once: Once): Promise<T | null> {
  try {
    const {value} = await idempotent<T>(db, once, async () => {
      throw new NotYet();
    });
    return value;
  } catch (error) {
    if (error instanceof NotYet || error instanceof IdempotencyConflict) return null;
    throw error;
  }
}

/**
 * A refusal (4xx) may be the visitor's own first attempt showing: the slot it took, the form it
 * answered, the files it claimed. With a key whose first attempt went through, that attempt's
 * answer; otherwise the refusal, unchanged. "Too many requests" (429) is answered as it is, so a
 * burst stays cheap: the browser keeps its key and the retry gets the first answer.
 */
export async function orEarlier<T>(db: Db, once: Once | null, error: unknown): Promise<T> {
  if (once && error instanceof HTTPException && error.status >= 400 && error.status < 500 && error.status !== 429) {
    const value = await earlier<T>(db, once);
    if (value !== null) return value;
  }
  throw error;
}

/** One host's (or form's, or person's) writes, one at a time until the transaction ends. */
export async function lockFor(tx: Prisma.TransactionClient, name: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}
