import {describe, expect, it} from 'vitest';

import {
  type AttemptKind,
  type AttemptStore,
  attemptLocks,
  RATE_LIMITS,
  takeAttempt,
} from '../src/platform/auth/rate-limit';

/**
 * PIPE-12, exactness. On Postgres an attempt's id is taken at INSERT, but other
 * requests see its row only once it commits. Record-first-then-check alone can
 * therefore let a burst slightly past `free` (two requests each miss the other's
 * uncommitted row). The per-scope advisory lock (`exclusive`) makes it exact.
 */
const now = new Date('2026-10-19T12:00:00Z');

type Row = {id: bigint; kind: AttemptKind; emailHash: string | null; ipHash: string; at: Date; succeeded: boolean};

/**
 * Behaves like Postgres under READ COMMITTED: an insert takes its id at once,
 * but its row becomes visible to others only at its commit. The interleaving is
 * forced, not left to timers: no row commits until `readsBeforeCommit` reads
 * (`recent`) have been served, so without the lock every request of a burst
 * reads its window before any other request's row is visible (the worst case
 * the race allows). `exclusive` plays the advisory lock: one holder per name,
 * and the holder's rows are committed before the lock is let go, whatever the
 * latch says.
 */
function commitLagStore(withLock: boolean, readsBeforeCommit: number) {
  const rows: Row[] = [];
  const uncommitted: Row[] = [];
  let seq = 0n;
  let reads = 0;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const commit = () => rows.push(...uncommitted.splice(0));
  const held = new Map<string, Promise<void>>();
  const locksTaken: string[][] = [];
  const store: AttemptStore = {
    async recent(kind, match, since, limit, beforeId) {
      await tick();
      const seen = rows
        .filter(
          r =>
            r.kind === kind &&
            r.at > since &&
            (beforeId === undefined || r.id < beforeId) &&
            (match.emailHash === undefined || r.emailHash === match.emailHash) &&
            (match.ipHash === undefined || r.ipHash === match.ipHash)
        )
        .slice(0, limit)
        .map(r => ({at: r.at, succeeded: r.succeeded}));
      if (++reads >= readsBeforeCommit) commit(); // the latch opens: rows commit from here on
      return seen;
    },
    async record(kind, row) {
      const id = ++seq;
      uncommitted.push({id, kind, ...row, at: now});
      if (reads >= readsBeforeCommit) commit();
      await tick();
      return id;
    },
    async settle(id, succeeded) {
      for (const r of [...rows, ...uncommitted]) if (r.id === id) r.succeeded = succeeded;
    },
    async discard(id) {
      for (const list of [rows, uncommitted]) {
        const at = list.findIndex(r => r.id === id);
        if (at >= 0) list.splice(at, 1);
      }
    },
  };
  if (withLock) {
    store.exclusive = async (locks, work) => {
      locksTaken.push(locks);
      const releases: (() => void)[] = [];
      for (const lock of [...locks].sort()) {
        while (held.has(lock)) await held.get(lock);
        held.set(
          lock,
          new Promise<void>(resolve =>
            releases.push(() => {
              held.delete(lock);
              resolve();
            })
          )
        );
      }
      try {
        const out = await work(store);
        commit(); // COMMIT
        return out;
      } finally {
        for (const release of releases) release();
      }
    };
  }
  return {store, rows, uncommitted, locksTaken};
}

describe('takeAttempt under commit lag (PIPE-12: exact with the per-scope lock)', () => {
  const ip = 'd'.repeat(64);
  const keys = {emailHash: null, ipHash: ip};
  const free = RATE_LIMITS.register.ip!.free;
  const size = 20; // `register` counts by IP only: one read per attempt
  const burst = (store: AttemptStore) =>
    Promise.all(Array.from({length: size}, () => takeAttempt(store, 'register', keys, now)));

  it('without the lock a burst can get more than `free` through (ids are taken before rows commit)', async () => {
    const {store} = commitLagStore(false, size);
    const through = (await burst(store)).filter(r => r.wait === 0).length;
    expect(through).toBe(size);
    expect(through).toBeGreaterThan(free);
  });

  it('with the lock exactly `free` get through, and refused attempts leave no row', async () => {
    const {store, rows, uncommitted} = commitLagStore(true, size);
    const through = (await burst(store)).filter(r => r.wait === 0).length;
    expect(through).toBe(free);
    expect(uncommitted).toHaveLength(0);
    expect(rows).toHaveLength(free);
  });

  it('locks the IP key, and the email key when the kind counts by email, in sorted order', async () => {
    expect(attemptLocks('register', keys)).toEqual([`attempt:register:ip:${ip}`]);
    const email = 'e'.repeat(64);
    const withEmail = attemptLocks('login', {emailHash: email, ipHash: ip});
    expect(withEmail).toEqual([`attempt:login:email:${email}`, `attempt:login:ip:${ip}`]);
    const {store, locksTaken} = commitLagStore(true, 1);
    await takeAttempt(store, 'login', {emailHash: email, ipHash: ip}, now);
    expect(locksTaken).toEqual([withEmail]);
  });
});
