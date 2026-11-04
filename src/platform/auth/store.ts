import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {tableMissing} from '../background';
import {ATTEMPT_LOCK_TRIES, AttemptBusyError, type AttemptKind, type AttemptStore, type ScopeTally} from './rate-limit';
import type {NewRefreshRow, RefreshRow, RefreshStore, RevokeReason} from './refresh';

/**
 * The auth rules' stores on the Site Database (Prisma). Every query selects
 * explicit columns, is bounded, and hits an index from `prisma/schema.prisma`.
 */

/** A hosted database can take a few seconds to start a transaction, past Prisma's 2-second default. */
export const AUTH_TX = {maxWait: 4_000, timeout: 8_000} as const;

export function refreshStore(db: PrismaClient): RefreshStore {
  return {
    async findByHash(tokenHash): Promise<RefreshRow | null> {
      return db.refreshToken.findUnique({
        where: {tokenHash},
        select: {
          id: true,
          familyId: true,
          userId: true,
          usedAt: true,
          revokedAt: true,
          expiresAt: true,
          absoluteExpiresAt: true,
        },
      });
    },
    async markUsed(id, at) {
      const {count} = await db.refreshToken.updateMany({
        where: {id, usedAt: null, revokedAt: null},
        data: {usedAt: at},
      });
      return count === 1;
    },
    async insert(row: NewRefreshRow) {
      await db.refreshToken.create({data: row, select: {id: true}});
    },
    async familyRevoked(familyId) {
      return (await db.refreshToken.count({where: {familyId, revokedAt: {not: null}}})) > 0;
    },
    async revokeFamily(familyId, at, reason: RevokeReason) {
      await db.refreshToken.updateMany({
        where: {familyId, revokedAt: null},
        data: {revokedAt: at, revokedReason: reason},
      });
    },
    async revokeAllForUser(userId, at, reason: RevokeReason) {
      await db.refreshToken.updateMany({
        where: {userId, revokedAt: null},
        data: {revokedAt: at, revokedReason: reason},
      });
    },
  };
}

export function attemptStore(db: PrismaClient | Prisma.TransactionClient): AttemptStore {
  return {
    async tally(kind: AttemptKind, scopes): Promise<ScopeTally[]> {
      // One statement for every scope, filtered to what each one counts.
      const parts = scopes.map((scope, i) => {
        const where = [
          Prisma.sql`"kind" = ${kind}`,
          ...(scope.match.emailHash ? [Prisma.sql`"email_hash" = ${scope.match.emailHash}`] : []),
          ...(scope.match.ipHash ? [Prisma.sql`"ip_hash" = ${scope.match.ipHash}`] : []),
          Prisma.sql`"created_at" > ${scope.since}::timestamp`,
        ];
        const inScope = Prisma.join(where, ' AND ');
        const counted = [
          inScope,
          ...(scope.failuresOnly ? [Prisma.sql`NOT "succeeded"`] : []),
          ...(scope.resetOnSuccess
            ? [Prisma.sql`"id" > COALESCE((SELECT MAX("id") FROM "login_attempts" WHERE ${inScope} AND "succeeded"), 0)`]
            : []),
        ];
        return Prisma.sql`SELECT ${i}::int AS "scope", COUNT(*)::int AS "count", MAX("created_at") AS "latest" FROM "login_attempts" WHERE ${Prisma.join(counted, ' AND ')}`;
      });
      const rows = await db.$queryRaw<{scope: number; count: number; latest: Date | null}[]>`${Prisma.join(parts, ' UNION ALL ')}`;
      return scopes.map((_, i) => {
        const row = rows.find(one => Number(one.scope) === i);
        return {count: Number(row?.count ?? 0), latest: row?.latest ? new Date(row.latest) : null};
      });
    },
    async record(kind, row) {
      return (await db.loginAttempt.create({data: {kind, ...row}, select: {id: true}})).id;
    },
    async settle(id, succeeded) {
      await db.loginAttempt.updateMany({where: {id}, data: {succeeded}});
    },
    async exclusive<T>(locks: string[], work: (store: AttemptStore) => Promise<T>) {
      // Already inside a transaction (no `$transaction` on it): run as is.
      if (!('$transaction' in db)) return work(attemptStore(db));
      // Transaction-scoped advisory locks: released at COMMIT or ROLLBACK, never
      // left behind by a request that dies. Sorted, so callers never deadlock.
      // TRIED, not waited on: a busy lock ends this transaction (its connection goes
      // back to the pool) and is tried again after a short pause, a few times at most,
      // because each try is a billed transaction (see rate-limit.ts).
      const sorted = [...locks].sort();
      for (let tries = 0; tries < ATTEMPT_LOCK_TRIES; tries++) {
        if (tries) await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
        let out: {value: T} | null;
        try {
          out = await db.$transaction(async tx => {
            for (const lock of sorted) {
              const [row] = await tx.$queryRaw<{locked: boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS "locked"`;
              if (!row?.locked) return null;
            }
            return {value: await work(attemptStore(tx))};
          }, AUTH_TX);
        } catch (error) {
          // The database didn't start or finish it in time: nothing was recorded, so it's the same as
          // busy. No more tries: the limit on how long a request waits matters more.
          if ((error as {code?: string}).code !== 'P2028') throw error;
          throw new AttemptBusyError();
        }
        if (out) return out.value;
      }
      throw new AttemptBusyError();
    },
  };
}

/**
 * Deletes a BOUNDED batch of dead rows (old attempts, long-expired tokens and
 * links). Run now and then, in the background, from the auth routes: a Site
 * has no cron. Each statement deletes at most 500 rows through its index.
 */
export async function sweep(db: PrismaClient, now: Date = new Date()): Promise<void> {
  const day = new Date(now.getTime() - 24 * 3600 * 1000);
  const week = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  await db.$executeRaw`DELETE FROM "login_attempts" WHERE "id" IN (SELECT "id" FROM "login_attempts" WHERE "created_at" < ${day} LIMIT 500)`;
  await db.$executeRaw`DELETE FROM "refresh_tokens" WHERE "id" IN (SELECT "id" FROM "refresh_tokens" WHERE "expires_at" < ${week} LIMIT 500)`;
  await db.$executeRaw`DELETE FROM "password_resets" WHERE "id" IN (SELECT "id" FROM "password_resets" WHERE "expires_at" < ${day} LIMIT 500)`;
  await db.$executeRaw`DELETE FROM "email_verifications" WHERE "id" IN (SELECT "id" FROM "email_verifications" WHERE "expires_at" < ${week} LIMIT 500)`;
  await db.$executeRaw`DELETE FROM "pending_sign_ups" WHERE "id" IN (SELECT "id" FROM "pending_sign_ups" WHERE "expires_at" < ${day} LIMIT 500)`.catch((error: unknown) => {
    // A site between the upgrade and its migration has no such table yet.
    if (!tableMissing(error)) throw error;
  });
  await db.$executeRaw`DELETE FROM "sign_in_codes" WHERE "id" IN (SELECT "id" FROM "sign_in_codes" WHERE "expires_at" < ${day} LIMIT 500)`;
  await db.$executeRaw`DELETE FROM "idempotency_keys" WHERE "id" IN (SELECT "id" FROM "idempotency_keys" WHERE "created_at" < ${week} LIMIT 500)`.catch((error: unknown) => {
    // A site between the upgrade and its migration has no such table yet.
    if (!tableMissing(error)) throw error;
  });
}
