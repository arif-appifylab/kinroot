import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {type Attempt, ATTEMPT_LOCK_WAIT_MS, AttemptBusyError, type AttemptKind, type AttemptStore} from './rate-limit';
import type {NewRefreshRow, RefreshRow, RefreshStore, RevokeReason} from './refresh';

/**
 * The auth rules' stores on the Site Database (Prisma). Every query selects
 * explicit columns, is bounded, and hits an index from `prisma/schema.prisma`.
 */

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
    async recent(kind: AttemptKind, match, since, limit, beforeId): Promise<Attempt[]> {
      const rows = await db.loginAttempt.findMany({
        where: {kind, ...match, createdAt: {gt: since}, ...(beforeId === undefined ? {} : {id: {lt: beforeId}})},
        select: {createdAt: true, succeeded: true},
        orderBy: {createdAt: 'desc'},
        take: limit,
      });
      return rows.map(row => ({at: row.createdAt, succeeded: row.succeeded}));
    },
    async record(kind, row) {
      return (await db.loginAttempt.create({data: {kind, ...row}, select: {id: true}})).id;
    },
    async settle(id, succeeded) {
      await db.loginAttempt.updateMany({where: {id}, data: {succeeded}});
    },
    async discard(id) {
      await db.loginAttempt.deleteMany({where: {id}});
    },
    async exclusive(locks, work) {
      // Already inside a transaction (no `$transaction` on it): run as is.
      if (!('$transaction' in db)) return work(attemptStore(db));
      // Transaction-scoped advisory locks: released at COMMIT or ROLLBACK, never
      // left behind by a request that dies. Sorted, so callers never deadlock.
      // TRIED, not waited on: a busy lock ends this transaction (its connection goes
      // back to the pool) and is tried again after a short pause (see rate-limit.ts).
      const sorted = [...locks].sort();
      const deadline = Date.now() + ATTEMPT_LOCK_WAIT_MS;
      for (;;) {
        const out = await db.$transaction(async tx => {
          for (const lock of sorted) {
            const [row] = await tx.$queryRaw<{locked: boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS "locked"`;
            if (!row?.locked) return null;
          }
          return {value: await work(attemptStore(tx))};
        });
        if (out) return out.value;
        if (Date.now() >= deadline) throw new AttemptBusyError();
        await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
      }
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
  await db.$executeRaw`DELETE FROM "sign_in_codes" WHERE "id" IN (SELECT "id" FROM "sign_in_codes" WHERE "expires_at" < ${day} LIMIT 500)`;
}
