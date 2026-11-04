import type {Prisma, PrismaClient} from '../generated/prisma/client';

/**
 * Do something once, however many times it is asked for (docs/agent/orders-and-stock.md).
 *
 *   const {value, replayed} = await idempotent(
 *     c.var.db,
 *     {scope: `booking:${viewer.id}`, key, request: {slotId}},
 *     tx => tx.booking.create({data: {slotId, userId: viewer.id}, select: {id: true}})
 *   );
 *
 * The key is taken and the work is done in ONE transaction, so they commit together:
 * - the same key while the first request runs waits for it, then answers what the first answered;
 * - the first request failing (a thrown error rolls everything back) frees the key, so a retry
 *   runs the work;
 * - a request reported as failed that did save (a lost connection, `P2028`) is answered correctly
 *   by the retry, and is never done twice;
 * - the same key with a different `request` is `IdempotencyConflict`, never someone else's answer.
 *
 * The answer is stored as JSON and given back on a repeat, so keep it small and plain: ids and
 * statuses, no secrets, tokens or email addresses. Dates come back as strings on a repeat, and the
 * first answer goes through the same JSON, so both look alike. Keys are kept for 7 days
 * (`sweep` in src/platform/auth/store.ts).
 *
 * Only database work belongs in `work`. Never call a payment provider or anything slow inside it:
 * the transaction stays open while it runs. Rows the transaction changes stay locked until then.
 */

/** A key from a client: long enough not to be guessed, plain enough to be stored as it is. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

const MAX_RESPONSE = 64 * 1024;
const WORK_TIMEOUT_MS = 15_000;

/** The same key arrived with a different request: a bug in the caller. Answer 409. */
export class IdempotencyConflict extends Error {
  readonly code = 'idempotency_conflict';
  constructor() {
    super('This key was already used for a different request.');
    this.name = 'IdempotencyConflict';
  }
}

/** The request's `Idempotency-Key` header: `null` when it's missing or not a valid key. */
export function idempotencyKeyOf(request: Request): string | null {
  const key = request.headers.get('idempotency-key')?.trim() ?? '';
  return IDEMPOTENCY_KEY.test(key) ? key : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(plain)
        .sort()
        .map(k => [k, canonical(plain[k])])
    );
  }
  return value;
}

async function fingerprintOf(request: unknown): Promise<string> {
  const text = new TextEncoder().encode(JSON.stringify(canonical(request ?? null)));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', text));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function idempotent<T>(
  db: PrismaClient,
  input: {
    /** Who and what it's for (`booking:${userId}`). A key means nothing outside its scope. */
    scope: string;
    /** From the client: one per attempt, the same on every retry of that attempt. */
    key: string;
    /** What was asked for. The same key with a different request is refused. */
    request: unknown;
  },
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<{value: T; replayed: boolean}> {
  const {scope, key} = input;
  if (!IDEMPOTENCY_KEY.test(key)) throw new TypeError('An idempotency key is 16 to 64 letters, digits, - or _.');
  if (!scope || scope.length > 120) throw new TypeError('An idempotency scope is 1 to 120 characters.');
  const fingerprint = await fingerprintOf(input.request);
  return db.$transaction(
    async tx => {
      // Waits here while another request holds this key, until it commits or rolls back.
      const won = await tx.$queryRaw<{id: number}[]>`
        INSERT INTO "idempotency_keys" ("scope", "key", "fingerprint")
        VALUES (${scope}, ${key}, ${fingerprint})
        ON CONFLICT ("scope", "key") DO NOTHING
        RETURNING "id"`;
      if (!won.length) {
        const [row] = await tx.$queryRaw<{fingerprint: string; response: unknown}[]>`
          SELECT "fingerprint", "response" FROM "idempotency_keys"
          WHERE "scope" = ${scope} AND "key" = ${key}`;
        if (!row || row.fingerprint !== fingerprint) throw new IdempotencyConflict();
        return {value: row.response as T, replayed: true};
      }
      const result = await work(tx);
      const text = JSON.stringify(result ?? null);
      if (text.length > MAX_RESPONSE) {
        throw new RangeError('An idempotent answer is at most 64 KB: return ids and statuses.');
      }
      await tx.$executeRaw`
        UPDATE "idempotency_keys" SET "response" = ${text}::jsonb WHERE "id" = ${won[0]!.id}`;
      return {value: JSON.parse(text) as T, replayed: false};
    },
    {timeout: WORK_TIMEOUT_MS}
  );
}
