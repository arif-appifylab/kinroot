import {describe, expect, it} from 'vitest';

import {
  type Attempt,
  type AttemptKind,
  type AttemptStore,
  checkRateLimit,
  RATE_LIMITS,
  retryAfterSeconds,
  takeAttempt,
} from '../src/platform/auth/rate-limit';

const now = new Date('2026-10-19T12:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const fail = (seconds: number): Attempt => ({at: ago(seconds), succeeded: false});
const ok = (seconds: number): Attempt => ({at: ago(seconds), succeeded: true});

const pair = RATE_LIMITS.login.pair!;
const ip = RATE_LIMITS.login.ip!;

describe('retryAfterSeconds', () => {
  it('allows the first 5 failures per email+IP in 15 minutes', () => {
    expect(retryAfterSeconds([], pair, now)).toBe(0);
    expect(retryAfterSeconds([fail(1), fail(2), fail(3), fail(4)], pair, now)).toBe(0);
  });

  it('backs off exponentially after that: 1, 2, 4, 8 minutes, capped at 15', () => {
    const failures = (n: number) => Array.from({length: n}, () => fail(0));
    expect(retryAfterSeconds(failures(5), pair, now)).toBe(60);
    expect(retryAfterSeconds(failures(6), pair, now)).toBe(120);
    expect(retryAfterSeconds(failures(7), pair, now)).toBe(240);
    expect(retryAfterSeconds(failures(8), pair, now)).toBe(480);
    expect(retryAfterSeconds(failures(9), pair, now)).toBe(900);
    expect(retryAfterSeconds(failures(30), pair, now)).toBe(900);
  });

  it('counts the wait from the LATEST failure', () => {
    const rows = [fail(45), fail(100), fail(110), fail(120), fail(130)];
    expect(retryAfterSeconds(rows, pair, now)).toBe(15); // 60 s after the one 45 s ago
    expect(retryAfterSeconds([fail(61), fail(100), fail(110), fail(120), fail(130)], pair, now)).toBe(0);
  });

  it('forgets failures older than the window', () => {
    const rows = [fail(10), fail(20), fail(30), fail(40), fail(16 * 60)];
    expect(retryAfterSeconds(rows, pair, now)).toBe(0);
  });

  it('a success ends the streak for the same email+IP', () => {
    const rows = [fail(1), ok(2), fail(3), fail(4), fail(5), fail(6), fail(7)];
    expect(retryAfterSeconds(rows, pair, now)).toBe(0);
  });

  it('a success does NOT reset the per-IP scope (no wiping your record with your own account)', () => {
    const rows: Attempt[] = [];
    for (let i = 0; i < 60; i++) rows.push(i % 10 === 0 ? ok(i) : fail(i));
    expect(retryAfterSeconds(rows, ip, now)).toBeGreaterThan(0);
  });

  it('"all" scopes count every attempt (register, reset)', () => {
    const reg = RATE_LIMITS.register.ip!;
    const rows = Array.from({length: reg.free}, (_, i) => ok(i * 10));
    expect(retryAfterSeconds(rows, reg, now)).toBeGreaterThan(0);
  });
});

type Row = {id?: bigint; kind: AttemptKind; emailHash: string | null; ipHash: string; at: Date; succeeded: boolean};

/**
 * In-memory store: rows newest first per query, like the Prisma one. Every
 * call yields to the event loop first, like a database round trip, so
 * parallel callers interleave.
 */
function memoryStore(rows: Row[]) {
  let seq = 0n;
  for (const row of rows) row.id ??= ++seq;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const store: AttemptStore = {
    async recent(kind, match, since, limit, beforeId) {
      await tick();
      return rows
        .filter(
          r =>
            r.kind === kind &&
            r.at > since &&
            (beforeId === undefined || r.id! < beforeId) &&
            (match.emailHash === undefined || r.emailHash === match.emailHash) &&
            (match.ipHash === undefined || r.ipHash === match.ipHash)
        )
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, limit)
        .map(r => ({at: r.at, succeeded: r.succeeded}));
    },
    async record(kind, row) {
      await tick();
      const id = ++seq;
      rows.push({id, kind, ...row, at: now});
      return id;
    },
    async settle(id, succeeded) {
      await tick();
      for (const r of rows) if (r.id === id) r.succeeded = succeeded;
    },
    async discard(id) {
      await tick();
      const at = rows.findIndex(r => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
  };
  return store;
}

describe('takeAttempt (record first, then check: PIPE-12)', () => {
  const ip = 'b'.repeat(64);

  it('a parallel burst gets exactly the free attempts through, not all of them', async () => {
    const rows: Row[] = [];
    const store = memoryStore(rows);
    const free = RATE_LIMITS.register.ip!.free;
    const results = await Promise.all(
      Array.from({length: 20}, () => takeAttempt(store, 'register', {emailHash: null, ipHash: ip}, now))
    );
    expect(results.filter(r => r.wait === 0)).toHaveLength(free);
    // Refused attempts leave no row behind (they do not extend their own lock).
    expect(rows).toHaveLength(free);
  });

  it('the old check-then-record order let the whole burst through (the bug)', async () => {
    const rows: Row[] = [];
    const store = memoryStore(rows);
    const keys = {emailHash: null, ipHash: ip};
    const results = await Promise.all(
      Array.from({length: 20}, async () => {
        const wait = await checkRateLimit(store, 'register', keys, now);
        if (!wait) await store.record('register', {...keys, succeeded: true});
        return wait;
      })
    );
    expect(results.filter(w => w === 0).length).toBeGreaterThan(RATE_LIMITS.register.ip!.free);
  });

  it('a failures kind counts a pending attempt as a failure until it is settled', async () => {
    const rows: Row[] = [];
    const store = memoryStore(rows);
    const keys = {emailHash: 'c'.repeat(64), ipHash: ip};
    const burst = await Promise.all(Array.from({length: 12}, () => takeAttempt(store, 'login', keys, now)));
    expect(burst.filter(r => r.wait === 0)).toHaveLength(RATE_LIMITS.login.pair!.free);
    expect(rows.every(r => !r.succeeded)).toBe(true);

    // A success ends the pair streak: the next try is free again.
    const fresh = memoryStore([]);
    const first = await takeAttempt(fresh, 'login', keys, now);
    await fresh.settle(first.id!, true);
    for (let i = 0; i < RATE_LIMITS.login.pair!.free; i++) expect((await takeAttempt(fresh, 'login', keys, now)).wait).toBe(0);
  });
});

describe('checkRateLimit (all scopes, strictest wins)', () => {
  const victim = 'e'.repeat(64);
  const attacker = 'i'.repeat(64);

  it('locks the email+IP pair after 5 failures, but not the same email from another IP', async () => {
    const rows = Array.from({length: 5}, (_, i) => ({
      kind: 'login' as const,
      emailHash: victim,
      ipHash: attacker,
      at: ago(i),
      succeeded: false,
    }));
    const store = memoryStore(rows);
    expect(await checkRateLimit(store, 'login', {emailHash: victim, ipHash: attacker}, now)).toBeGreaterThan(0);
    expect(await checkRateLimit(store, 'login', {emailHash: victim, ipHash: 'o'.repeat(64)}, now)).toBe(0);
  });

  it('locks one IP that sprays many emails (credential stuffing)', async () => {
    const rows = Array.from({length: 50}, (_, i) => ({
      kind: 'login' as const,
      emailHash: i.toString(16).padStart(64, '0'),
      ipHash: attacker,
      at: ago(i),
      succeeded: false,
    }));
    const store = memoryStore(rows);
    expect(await checkRateLimit(store, 'login', {emailHash: victim, ipHash: attacker}, now)).toBeGreaterThan(0);
  });

  it('slows down a distributed attack on one account', async () => {
    const rows = Array.from({length: 20}, (_, i) => ({
      kind: 'login' as const,
      emailHash: victim,
      ipHash: i.toString(16).padStart(64, '0'),
      at: ago(i),
      succeeded: false,
    }));
    const store = memoryStore(rows);
    expect(await checkRateLimit(store, 'login', {emailHash: victim, ipHash: 'n'.repeat(64)}, now)).toBeGreaterThan(0);
  });

  it('keeps kinds apart', async () => {
    const rows = Array.from({length: 10}, (_, i) => ({
      kind: 'reset' as const,
      emailHash: victim,
      ipHash: attacker,
      at: ago(i),
      succeeded: true,
    }));
    expect(await checkRateLimit(memoryStore(rows), 'login', {emailHash: victim, ipHash: attacker}, now)).toBe(0);
  });
});
