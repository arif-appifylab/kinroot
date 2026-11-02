/**
 * Rate limits, kept in the Site Database (`login_attempts`): a Site has no
 * KV or Redis. Every attempt is one row keyed by a KIND and keyed hashes of
 * the email and the client IP (`keys.ts`, never the raw values).
 *
 * Each kind checks up to three SCOPES at once and the strictest wins:
 *   pair     the same email from the same IP     (a person mistyping)
 *   subject  the same email from any IP          (one account under attack)
 *   ip       any email from the same IP          (credential stuffing)
 *
 * Backoff is exponential: once a scope has `free` counted attempts in its
 * window, the next one waits `base × 2^(n − free)` seconds after the latest
 * (capped at `max`). In the `pair` scope of a `failures` kind a SUCCESS ends
 * the streak, so a person who finally gets it right starts clean; the wider
 * scopes never reset on a success (an attacker could otherwise interleave
 * logins to an account they own to wipe their IP's record).
 *
 * ONE AT A TIME PER SCOPE, RECORD FIRST, THEN CHECK (`takeAttempt`): the
 * attempt takes a lock per key its scopes count by (`exclusive`: a Postgres
 * transaction-scoped advisory lock on the kind + IP hash, and on the kind +
 * email hash), inserts its row, reads the limit counting only the rows
 * inserted before it (`id < own id`), and commits. The next request of the
 * same scope waits for that commit, so it sees the row: a burst of 20 at once
 * gets exactly `free` through. Without the lock the order alone is close but
 * not exact (an id is taken before its row commits, so two requests can each
 * miss the other's uncommitted row), and a check-then-record order lets every
 * request of a burst read the same empty window. A refused
 * attempt's row is removed again, so hammering a locked scope does not keep
 * extending its own lock; a `failures` kind's row starts as a failure and is
 * settled to a success when the attempt succeeds.
 *
 * A busy lock is TRIED, never waited on with a connection held: a burst on one
 * IP would otherwise park one database connection per waiter on the lock (and
 * drain the Site Database's connections, unauthenticated). A waiter lets its
 * connection go, retries after a short pause, and after `ATTEMPT_LOCK_WAIT_MS`
 * is refused like any rate-limited attempt (429, `Retry-After: 1`).
 *
 * The decision is a pure function (`retryAfterSeconds`), unit-tested in
 * `tests/rate-limit.test.ts`; `store.ts` reads and writes the rows.
 */
export type AttemptKind =
  | 'login'
  | 'register'
  | 'reset'
  | 'verify'
  | 'password'
  | 'owner'
  | 'mfa'
  | 'email'
  | 'delete'
  | 'code'
  | 'codecheck';

export interface ScopePolicy {
  windowSeconds: number;
  /** Attempts allowed before backoff starts. */
  free: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** `failures`: only failed attempts count. `all`: every attempt counts. */
  counts: 'failures' | 'all';
  /** A success ends the streak (pair scope only). */
  resetOnSuccess?: boolean;
}

export interface KindPolicy {
  pair?: ScopePolicy;
  subject?: ScopePolicy;
  ip?: ScopePolicy;
}

const MIN = 60;

export const RATE_LIMITS: Record<AttemptKind, KindPolicy> = {
  // 5 tries per email+IP per 15 minutes, then 1, 2, 4, 8, 15 minutes.
  login: {
    pair: {
      windowSeconds: 15 * MIN,
      free: 5,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
    subject: {windowSeconds: 15 * MIN, free: 20, baseDelaySeconds: MIN, maxDelaySeconds: 15 * MIN, counts: 'failures'},
    ip: {windowSeconds: 15 * MIN, free: 50, baseDelaySeconds: MIN, maxDelaySeconds: 30 * MIN, counts: 'failures'},
  },
  register: {
    ip: {windowSeconds: 60 * MIN, free: 5, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  reset: {
    subject: {windowSeconds: 60 * MIN, free: 3, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
    ip: {windowSeconds: 60 * MIN, free: 10, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  verify: {
    subject: {windowSeconds: 60 * MIN, free: 3, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
    ip: {windowSeconds: 60 * MIN, free: 20, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  // A one-click owner sign-in from the dashboard, per IP: a bad ticket counts (each one costs a platform call).
  owner: {
    ip: {windowSeconds: 15 * MIN, free: 10, baseDelaySeconds: MIN, maxDelaySeconds: 15 * MIN, counts: 'failures'},
  },
  // The second sign-in step (an authenticator code or a recovery code), per account and per IP.
  mfa: {
    subject: {
      windowSeconds: 15 * MIN,
      free: 5,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
    ip: {windowSeconds: 15 * MIN, free: 30, baseDelaySeconds: MIN, maxDelaySeconds: 30 * MIN, counts: 'failures'},
  },
  // Asking for a sign-in code (each one sends an email), per address and per IP. Every ask counts.
  code: {
    subject: {windowSeconds: 15 * MIN, free: 3, baseDelaySeconds: 2 * MIN, maxDelaySeconds: 30 * MIN, counts: 'all'},
    ip: {windowSeconds: 60 * MIN, free: 30, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  // Entering a sign-in code, per address and per IP (a code also dies after 5 wrong tries).
  codecheck: {
    subject: {
      windowSeconds: 15 * MIN,
      free: 10,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
    ip: {windowSeconds: 15 * MIN, free: 50, baseDelaySeconds: MIN, maxDelaySeconds: 30 * MIN, counts: 'failures'},
  },
  // Asking to move the account to a new address (each one sends an email), per account.
  email: {
    subject: {windowSeconds: 60 * MIN, free: 3, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  // Deleting the account: re-entering the password, per account.
  delete: {
    subject: {
      windowSeconds: 15 * MIN,
      free: 5,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
  },
  // Re-entering the current password while signed in (change password).
  password: {
    subject: {
      windowSeconds: 15 * MIN,
      free: 5,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
  },
};

export interface Attempt {
  at: Date;
  succeeded: boolean;
}

/** Most rows a check ever reads per scope: enough to reach the max delay. */
export const MAX_ROWS_PER_CHECK = 64;

/**
 * Seconds until the next attempt is allowed in ONE scope (0 = go ahead).
 * `attempts` are that scope's rows inside its window, NEWEST FIRST.
 */
export function retryAfterSeconds(attempts: readonly Attempt[], policy: ScopePolicy, now: Date): number {
  const since = now.getTime() - policy.windowSeconds * 1000;
  let counted = 0;
  let latest: Date | null = null;
  for (const attempt of attempts) {
    if (attempt.at.getTime() <= since) break;
    if (attempt.succeeded && policy.counts === 'failures') {
      if (policy.resetOnSuccess) break;
      continue;
    }
    counted++;
    latest ??= attempt.at;
  }
  if (counted < policy.free || !latest) return 0;
  const delay = Math.min(policy.baseDelaySeconds * 2 ** (counted - policy.free), policy.maxDelaySeconds);
  const wait = Math.ceil((latest.getTime() + delay * 1000 - now.getTime()) / 1000);
  return Math.max(0, wait);
}

/** Where the rows come from; implemented on Prisma in `store.ts`. */
export interface AttemptStore {
  /**
   * Rows of `kind` newer than `since`, newest first, at most `limit`, matching
   * the given hashes; with `beforeId`, only rows inserted before that one.
   */
  recent(
    kind: AttemptKind,
    match: {emailHash?: string; ipHash?: string},
    since: Date,
    limit: number,
    beforeId?: bigint
  ): Promise<Attempt[]>;
  /** Inserts one attempt; answers its id. */
  record(kind: AttemptKind, row: {emailHash: string | null; ipHash: string; succeeded: boolean}): Promise<bigint>;
  /** Marks a recorded attempt as succeeded or failed. */
  settle(id: bigint, succeeded: boolean): Promise<void>;
  /** Removes a recorded attempt (it was refused, so it never happened). */
  discard(id: bigint): Promise<void>;
  /**
   * Runs `work` holding every lock in `locks` (taken in sorted order, so two
   * callers never deadlock), on a store whose writes are committed before the
   * locks are let go. Optional: without it `takeAttempt` runs unlocked.
   */
  exclusive?<T>(locks: string[], work: (store: AttemptStore) => Promise<T>): Promise<T>;
}

/** How long `exclusive` keeps retrying a busy lock before the attempt is refused. */
export const ATTEMPT_LOCK_WAIT_MS = 2_000;

/** Thrown by `exclusive` when a lock stayed busy for `ATTEMPT_LOCK_WAIT_MS`. */
export class AttemptBusyError extends Error {
  constructor() {
    super('rate-limit lock busy');
    this.name = 'AttemptBusyError';
  }
}

/** The locks `takeAttempt` holds: one per key the kind's scopes count by, sorted. */
export function attemptLocks(kind: AttemptKind, keys: Keys): string[] {
  const policy = RATE_LIMITS[kind];
  const locks = [`attempt:${kind}:ip:${keys.ipHash}`];
  if (keys.emailHash && (policy.pair || policy.subject)) locks.push(`attempt:${kind}:email:${keys.emailHash}`);
  return locks.sort();
}

type Keys = {emailHash: string | null; ipHash: string};

/** The strictest wait across the kind's scopes. Scopes are read in parallel. */
export async function checkRateLimit(
  store: AttemptStore,
  kind: AttemptKind,
  keys: Keys,
  now: Date = new Date(),
  beforeId?: bigint
): Promise<number> {
  const policy = RATE_LIMITS[kind];
  const checks: Promise<number>[] = [];
  const check = (scope: ScopePolicy | undefined, match: {emailHash?: string; ipHash?: string}) => {
    if (!scope) return;
    const since = new Date(now.getTime() - scope.windowSeconds * 1000);
    checks.push(
      store.recent(kind, match, since, MAX_ROWS_PER_CHECK, beforeId).then(rows => retryAfterSeconds(rows, scope, now))
    );
  };
  if (keys.emailHash) {
    check(policy.pair, {emailHash: keys.emailHash, ipHash: keys.ipHash});
    check(policy.subject, {emailHash: keys.emailHash});
  }
  check(policy.ip, {ipHash: keys.ipHash});
  const waits = await Promise.all(checks);
  return waits.length ? Math.max(...waits) : 0;
}

/**
 * Records this attempt, THEN checks the limit against the attempts recorded
 * before it (see the top of this file). `wait > 0`: refused (its row is gone
 * again), answer 429. `wait = 0`: go ahead; for a `failures` kind the row
 * counts as a failure until `settle(id, true)`.
 */
export async function takeAttempt(
  store: AttemptStore,
  kind: AttemptKind,
  keys: Keys,
  now: Date = new Date()
): Promise<{wait: number; id: bigint | null}> {
  const countsFailures = Object.values(RATE_LIMITS[kind]).some(scope => scope?.counts === 'failures');
  const take = async (inner: AttemptStore): Promise<{wait: number; id: bigint | null}> => {
    const id = await inner.record(kind, {...keys, succeeded: !countsFailures});
    const wait = await checkRateLimit(inner, kind, keys, now, id);
    if (wait > 0) {
      await inner.discard(id);
      return {wait, id: null};
    }
    return {wait: 0, id};
  };
  if (!store.exclusive) return take(store);
  try {
    return await store.exclusive(attemptLocks(kind, keys), take);
  } catch (err) {
    // The scope is that busy: refused like any other attempt over the limit.
    if (err instanceof AttemptBusyError) return {wait: 1, id: null};
    throw err;
  }
}
