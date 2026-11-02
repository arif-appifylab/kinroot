import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {attemptLocks, takeAttempt} from '../../src/platform/auth/rate-limit';
import {attemptStore} from '../../src/platform/auth/store';
import {createDb} from '../../src/platform/db';
import {configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * PIPE-12 follow-up (second review): a busy rate-limit lock is tried, not waited on with a
 * connection held. While another transaction holds the scope's lock, an attempt gives up after
 * ATTEMPT_LOCK_WAIT_MS and is refused like a rate-limited one; before, it sat on its own database
 * connection until the holder finished, so a burst on one IP parked one connection per waiter.
 */
describe.skipIf(!DATABASE_URL)('rate-limit lock busy (integration, real Postgres)', () => {
  // Another request: its own client (one connection each, like a Worker request).
  const other = createDb(DATABASE_URL || 'postgresql://unused@localhost/unused');
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => Promise.all([db.$disconnect(), other.$disconnect()]));

  it('an attempt on a held scope is refused within the wait, not parked until the holder ends', async () => {
    const keys = {emailHash: null, ipHash: 'b'.repeat(64)};
    const [lock] = attemptLocks('register', keys);
    let taken!: () => void;
    const holding = new Promise<void>(resolve => (taken = resolve));
    const holder = other.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
        taken();
        await new Promise(resolve => setTimeout(resolve, 4_500));
      },
      {timeout: 10_000}
    );
    await holding;
    const started = Date.now();
    const result = await takeAttempt(attemptStore(db), 'register', keys);
    const took = Date.now() - started;
    await holder;
    expect(result).toEqual({wait: 1, id: null});
    expect(took).toBeLessThan(4_000);
    expect(await db.loginAttempt.count()).toBe(0);

    // Free again: the next attempt goes through.
    expect((await takeAttempt(attemptStore(db), 'register', keys)).wait).toBe(0);
  }, 20_000);
});
