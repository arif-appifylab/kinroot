import {DATA_IN_LOG_DAYS, IDEMPOTENCY_HOURS} from '@/lib/data-in';
import type {Db} from '../kit/db';
import {deleteInChunks} from './chunked-delete';

/**
 * From pruneJobs(): Data in requests (the log) go after 30 days and stored
 * Idempotency-Key responses after 24 hours.
 */
export async function pruneDataIn(db: Db, until = Date.now() + 10_000) {
  const log = new Date(Date.now() - DATA_IN_LOG_DAYS * 86_400_000);
  const keys = new Date(Date.now() - IDEMPOTENCY_HOURS * 3_600_000);
  await deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "DataInRequest" WHERE id IN (SELECT id FROM "DataInRequest" WHERE "createdAt" < ${log} LIMIT ${n})`);
  await deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "DataInIdempotency" WHERE id IN (SELECT id FROM "DataInIdempotency" WHERE "createdAt" < ${keys} LIMIT ${n})`);
}
