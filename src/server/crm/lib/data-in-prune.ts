import {DATA_IN_LOG_DAYS, IDEMPOTENCY_HOURS, SIGNATURE_TOLERANCE_SEC} from '@/lib/data-in';
import type {Db} from '../kit/db';

/**
 * From pruneJobs(): Data in requests (the log) go after 30 days, stored
 * Idempotency-Key responses after 24 hours and used signatures once their
 * 5-minute window (doubled for clock skew) has passed.
 */
export async function pruneDataIn(db: Db) {
  await db.dataInRequest.deleteMany({where: {createdAt: {lt: new Date(Date.now() - DATA_IN_LOG_DAYS * 86_400_000)}}});
  await db.dataInIdempotency.deleteMany({where: {createdAt: {lt: new Date(Date.now() - IDEMPOTENCY_HOURS * 3_600_000)}}});
  await db.dataInSignature.deleteMany({where: {createdAt: {lt: new Date(Date.now() - 2 * SIGNATURE_TOLERANCE_SEC * 1000)}}});
}
