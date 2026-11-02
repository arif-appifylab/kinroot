import type {PrismaClient} from '../../../generated/prisma/client';
import {getDb} from '../../../platform/db';

export type Db = PrismaClient;

/**
 * The Site Database client of the current request (or job run): the template's ONE client per
 * request (src/platform/db.ts), shared with the auth core. Kinroot code keeps calling
 * `createDb()` as it did; the template opens and closes the connection, so nothing here
 * disconnects (`isSharedDb` is always true).
 */
export async function createDb(): Promise<Db> {
  const db = getDb();
  if (!db) throw new Error('This site has no Site Database yet.');
  return db;
}

export const isSharedDb = (_db: Db) => true;
