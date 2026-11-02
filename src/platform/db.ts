import {PrismaPg} from '@prisma/adapter-pg';
import {PrismaPostgresAdapter} from '@prisma/adapter-ppg';

import {PrismaClient} from '../generated/prisma/client';
import {config} from './config';
import {scopedValue} from './request-scope';

/**
 * The Site Database client, or `null` when this site has no Site Database yet
 * (`DATABASE_URL` is empty until the owner enables it).
 *
 * ONE client per request, shared by the page, the auth lookup and every
 * in-process Site API call of that request (`request-scope.ts`), and never
 * across requests: a Worker must not share I/O objects between requests.
 *
 * Which driver is decided by the connection string's HOST:
 *   - Prisma Postgres (`*.prisma.io`, live and Preview): `@prisma/adapter-ppg`,
 *     over HTTPS. Deployed sites only ever get this; raw TCP is blocked there.
 *   - any other host (a local Postgres, tests):
 *     `@prisma/adapter-pg` over TCP, one short-lived connection per request.
 */
export function isPrismaPostgres(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'prisma.io' || host.endsWith('.prisma.io');
  } catch {
    return false;
  }
}

export function createDb(url: string): PrismaClient {
  const adapter = isPrismaPostgres(url)
    ? new PrismaPostgresAdapter({connectionString: url})
    : new PrismaPg({connectionString: url, max: 1, idleTimeoutMillis: 1000});
  return new PrismaClient({adapter});
}

export function getDb(): PrismaClient | null {
  const url = config.databaseUrl;
  if (!url) return null;
  return scopedValue('db', () => createDb(url));
}

export type {PrismaClient};
