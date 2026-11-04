import {describe, expect, it} from 'vitest';

import {
  type AttemptKind,
  type AttemptStore,
  attemptLocks,
  checkRateLimit,
  RATE_LIMITS,
  retryAfterSeconds,
  type ScopeQuery,
  type ScopeTally,
  takeAttempt,
} from '../src/platform/auth/rate-limit';

const now = new Date('2026-10-19T12:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const login = RATE_LIMITS.login;

type Row = {id: bigint; kind: AttemptKind; emailHash: string | null; ipHash: string; at: Date; succeeded: boolean};

/** The same counting rules as the SQL in `store.ts`, on an array. */
function memoryStore(rows: Row[] = []): AttemptStore & {rows: Row[]} {
  let seq = BigInt(rows.length);
  return {
    rows,
    async tally(kind, scopes: ScopeQuery[]): Promise<ScopeTally[]> {
      return scopes.map(scope => {
        const inScope = rows.filter(
          r =>
            r.kind === kind &&
            r.at > scope.since &&
            (scope.match.emailHash === undefined || r.emailHash === scope.match.emailHash) &&
            (scope.match.ipHash === undefined || r.ipHash === scope.match.ipHash)
        );
        const lastWin = scope.resetOnSuccess ? inScope.filter(r => r.succeeded).reduce((max, r) => (r.id > max ? r.id : max), 0n) : 0n;
        const counted = inScope.filter(r => r.id > lastWin && (!scope.failuresOnly || !r.succeeded));
        const latest = counted.reduce<Date | null>((max, r) => (!max || r.at > max ? r.at : max), null);
        return {count: counted.length, latest};
      });
    },
    async record(kind, row) {
      const id = ++seq;
      rows.push({id, kind, ...row, at: now});
      return id;
    },
    async settle(id, succeeded) {
      for (const row of rows) if (row.id === id) row.succeeded = succeeded;
    },
  };
}

const seed = (store: {rows: Row[]}, n: number, row: Partial<Row>) => {
  for (let i = 0; i < n; i++) {
    store.rows.push({id: BigInt(store.rows.length + 1), kind: 'login', emailHash: 'e', ipHash: 'i', at: ago(60), succeeded: false, ...row});
  }
};

describe('retryAfterSeconds', () => {
  const pair = login.pair!;
  it('allows the free attempts', () => {
    expect(retryAfterSeconds({count: 4, latest: ago(1)}, pair, now)).toBe(0);
  });
  it('backs off exponentially after that: 1, 2, 4, 8 minutes, capped at 15', () => {
    for (const [count, minutes] of [[5, 1], [6, 2], [7, 4], [8, 8], [9, 15], [20, 15]] as const) {
      expect(retryAfterSeconds({count, latest: now}, pair, now)).toBe(minutes * 60);
    }
  });
  it('counts the wait from the latest attempt', () => {
    expect(retryAfterSeconds({count: 5, latest: ago(45)}, pair, now)).toBe(15);
    expect(retryAfterSeconds({count: 5, latest: ago(61)}, pair, now)).toBe(0);
  });
});

describe('checkRateLimit (all scopes, strictest wins)', () => {
  it('locks the email+IP pair after 5 failures, but not the same email from elsewhere', async () => {
    const store = memoryStore();
    seed(store, 5, {at: ago(5)});
    expect((await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'i'}, {now})).wait).toBeGreaterThan(0);
    expect((await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'other'}, {now})).wait).toBe(0);
  });
  it('a success ends the pair streak, so someone who gets it right starts clean', async () => {
    const store = memoryStore();
    seed(store, 5, {at: ago(5)});
    seed(store, 1, {at: ago(4), succeeded: true});
    expect((await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'i'}, {now})).wait).toBe(0);
  });
  it('slows down a distributed attack on one account', async () => {
    const store = memoryStore();
    for (let i = 0; i < 20; i++) seed(store, 1, {ipHash: `ip${i}`, at: ago(5)});
    const out = await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'fresh'}, {now});
    expect(out.scope).toBe('subject');
    expect(out.wait).toBeGreaterThan(0);
  });
  it('a browser that has signed in to the address is not stopped by a limit on the address alone', async () => {
    const store = memoryStore();
    for (let i = 0; i < 20; i++) seed(store, 1, {ipHash: `ip${i}`, at: ago(5)});
    expect((await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'fresh'}, {now, trusted: true})).wait).toBe(0);
    // Its own guesses from one place still count.
    seed(store, 5, {ipHash: 'guesser', at: ago(5)});
    expect((await checkRateLimit(store, 'login', {emailHash: 'e', ipHash: 'guesser'}, {now, trusted: true})).scope).toBe('pair');
  });
  it('locks one IP that sprays many emails (credential stuffing)', async () => {
    const store = memoryStore();
    for (let i = 0; i < 50; i++) seed(store, 1, {emailHash: `e${i}`, at: ago(5)});
    const out = await checkRateLimit(store, 'login', {emailHash: 'new', ipHash: 'i'}, {now});
    expect(out.scope).toBe('ip');
  });
  it('successes can\'t hide failures: any number of own-account logins leaves the IP\'s count as it was', async () => {
    const store = memoryStore();
    for (let i = 0; i < 50; i++) seed(store, 1, {emailHash: `e${i}`, at: ago(30)});
    for (let i = 0; i < 500; i++) seed(store, 1, {emailHash: 'mine', succeeded: true, at: ago(5)});
    expect((await checkRateLimit(store, 'login', {emailHash: 'new', ipHash: 'i'}, {now})).scope).toBe('ip');
  });
  it('keeps kinds apart', async () => {
    const store = memoryStore();
    seed(store, 5, {at: ago(5)});
    expect((await checkRateLimit(store, 'mfa', {emailHash: 'e', ipHash: 'i'}, {now})).wait).toBe(0);
  });
  it('a daily budget stops slow guessing at a sign-in code', async () => {
    const store = memoryStore();
    for (let i = 0; i < 52; i++) seed(store, 1, {kind: 'codecheck', ipHash: `ip${i}`, at: ago(1000)});
    const out = await checkRateLimit(store, 'codecheck', {emailHash: 'e', ipHash: 'fresh'}, {now});
    expect(out.scope).toBe('subject');
    expect(out.wait).toBeGreaterThan(0);
  });
});

describe('takeAttempt', () => {
  it('a refused attempt writes nothing, so hammering doesn\'t extend its own wait', async () => {
    const store = memoryStore();
    seed(store, 5, {at: ago(5)});
    const before = store.rows.length;
    const out = await takeAttempt(store, 'login', {emailHash: 'e', ipHash: 'i'}, {now});
    expect(out.id).toBeNull();
    expect(out.wait).toBeGreaterThan(0);
    expect(store.rows.length).toBe(before);
  });
  it('a failures kind counts as a failure until settled', async () => {
    const store = memoryStore();
    const {id} = await takeAttempt(store, 'login', {emailHash: 'e', ipHash: 'i'}, {now});
    expect(store.rows[0]!.succeeded).toBe(false);
    await store.settle(id!, true);
    expect(store.rows[0]!.succeeded).toBe(true);
  });
  it('an all-kinds attempt counts at once', async () => {
    const store = memoryStore();
    await takeAttempt(store, 'register', {emailHash: null, ipHash: 'i'}, {now});
    expect(store.rows[0]!.succeeded).toBe(true);
  });
});

describe('attemptLocks', () => {
  it('holds a lock per key its scopes count by, sorted', () => {
    expect(attemptLocks('login', {emailHash: 'e', ipHash: 'i'})).toEqual(['attempt:login:email:e', 'attempt:login:ip:i']);
  });
  it('a trusted browser doesn\'t queue on the address', () => {
    expect(attemptLocks('login', {emailHash: 'e', ipHash: 'i'}, true)).toEqual(['attempt:login:ip:i']);
  });
  it('takes no IP lock when the kind doesn\'t count by IP', () => {
    expect(attemptLocks('password', {emailHash: 'e', ipHash: 'i'})).toEqual(['attempt:password:email:e']);
  });
  it('takes no lock at all when no scope applies', () => {
    expect(attemptLocks('password', {emailHash: 'e', ipHash: 'i'}, true)).toEqual([]);
  });
});
