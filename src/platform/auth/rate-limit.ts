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
 * (capped at `max`). In a scope with `resetOnSuccess` a SUCCESS ends the
 * streak, so a person who finally gets it right starts clean; the wider scopes
 * never reset on a success (an attacker could otherwise interleave logins to
 * an account they own to wipe their IP's record). The database does the count,
 * filtered to what the scope counts: successes can't push failures out of view.
 *
 * ONE AT A TIME PER SCOPE (`takeAttempt`): the attempt takes a lock per key its
 * scopes count by (`exclusive`: a Postgres transaction-scoped advisory lock on
 * the kind + IP hash, and on the kind + email hash), reads the counts, inserts
 * its row if allowed, and commits. The next request of the same scope then sees
 * that row, so a burst of 20 at once gets exactly `free` through. A refused
 * attempt writes nothing, so hammering a locked scope does not extend its own
 * lock. A `failures` kind's row starts as a failure and is settled to a success
 * when the attempt succeeds.
 *
 * A busy lock is TRIED, never waited on with a connection held, and only
 * `ATTEMPT_LOCK_TRIES` times: each try is a billed transaction, and a burst on
 * one IP must not park connections or run up the bill, unauthenticated. After
 * the last try it is refused like any rate-limited attempt (429, `Retry-After: 1`).
 *
 * `trusted` (a browser that has signed in to this address, `kit.ts`) skips the
 * limits on the address alone, so a stranger can't lock the real person out of it. The pair and ip
 * scopes still apply.
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
  | 'codecheck'
  | 'mail'
  | 'notice';

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
  /** A second limit on the same address over a longer window: a total budget. */
  subjectDaily?: ScopePolicy;
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
  // Who may ask for a mail from one IP. How often an address gets one is `mail`, whoever asks.
  reset: {
    ip: {windowSeconds: 60 * MIN, free: 10, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  verify: {
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
  // One email with a way in, per address, per 15 minutes, whoever asks: a code or link stays good for
  // longer than that, so anyone asking finds a working one in the inbox. A stranger asking uses up
  // nothing the real person needs, and the inbox can't be flooded.
  mail: {
    subject: {windowSeconds: 15 * MIN, free: 1, baseDelaySeconds: 15 * MIN, maxDelaySeconds: 15 * MIN, counts: 'all'},
  },
  // A notice with no way in ("you already have an account"), so it never takes the place of one that has.
  notice: {
    subject: {windowSeconds: 60 * MIN, free: 1, baseDelaySeconds: 60 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  // Asking for a sign-in code, per IP.
  code: {
    ip: {windowSeconds: 60 * MIN, free: 30, baseDelaySeconds: 5 * MIN, maxDelaySeconds: 60 * MIN, counts: 'all'},
  },
  // Entering a 6-digit code, per address and per IP. These totals are what stop guessing. A person they
  // block still has a link, which can't be guessed: the sign-up email's, or a password reset's.
  codecheck: {
    subject: {
      windowSeconds: 15 * MIN,
      free: 10,
      baseDelaySeconds: MIN,
      maxDelaySeconds: 15 * MIN,
      counts: 'failures',
      resetOnSuccess: true,
    },
    // A total budget, so guessing can't go on at the short window's pace all day, every day.
    subjectDaily: {windowSeconds: 24 * 60 * MIN, free: 50, baseDelaySeconds: 15 * MIN, maxDelaySeconds: 6 * 60 * MIN, counts: 'failures'},
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

/** What a scope's window holds, as counted by the database. */
export interface ScopeTally {
  count: number;
  latest: Date | null;
}

/** Seconds until the next attempt is allowed in ONE scope (0 = go ahead). */
export function retryAfterSeconds(tally: ScopeTally, policy: ScopePolicy, now: Date): number {
  if (tally.count < policy.free || !tally.latest) return 0;
  const delay = Math.min(policy.baseDelaySeconds * 2 ** (tally.count - policy.free), policy.maxDelaySeconds);
  const wait = Math.ceil((tally.latest.getTime() + delay * 1000 - now.getTime()) / 1000);
  return Math.max(0, wait);
}

/** One scope to count: its rows, how far back, and which of them count. */
export interface ScopeQuery {
  match: {emailHash?: string; ipHash?: string};
  since: Date;
  failuresOnly: boolean;
  resetOnSuccess: boolean;
}

/** Where the rows come from; implemented on Prisma in `store.ts`. */
export interface AttemptStore {
  /** Counts each scope, in the order given. One statement, whatever the number of scopes. */
  tally(kind: AttemptKind, scopes: ScopeQuery[]): Promise<ScopeTally[]>;
  /** Inserts one attempt; answers its id. */
  record(kind: AttemptKind, row: {emailHash: string | null; ipHash: string; succeeded: boolean}): Promise<bigint>;
  /** Marks a recorded attempt as succeeded or failed. */
  settle(id: bigint, succeeded: boolean): Promise<void>;
  /**
   * Runs `work` holding every lock in `locks` (tried together, so two callers never
   * deadlock), on a store whose writes are committed before the locks are let go.
   * Optional: without it `takeAttempt` runs unlocked.
   */
  exclusive?<T>(locks: string[], work: (store: AttemptStore) => Promise<T>): Promise<T>;
}

/** How many times `exclusive` tries a busy lock before the attempt is refused. Each try is a transaction. */
export const ATTEMPT_LOCK_TRIES = 4;

/** Thrown by `exclusive` when a lock stayed busy for every try. */
export class AttemptBusyError extends Error {
  constructor() {
    super('rate-limit lock busy');
    this.name = 'AttemptBusyError';
  }
}

type Keys = {emailHash: string | null; ipHash: string};

export interface AttemptOptions {
  now?: Date;
  /** This browser has signed in to this address: skip the scopes counting the address alone. */
  trusted?: boolean;
}

/** Which scopes apply, by name. An address alone counts only when it isn't `trusted`. */
function activeScopes(kind: AttemptKind, keys: Keys, trusted: boolean) {
  const policy = RATE_LIMITS[kind];
  const scopes: {name: 'pair' | 'subject' | 'ip'; policy: ScopePolicy; match: ScopeQuery['match']}[] = [];
  if (keys.emailHash) {
    if (policy.pair) scopes.push({name: 'pair', policy: policy.pair, match: {emailHash: keys.emailHash, ipHash: keys.ipHash}});
    if (!trusted) {
      if (policy.subject) scopes.push({name: 'subject', policy: policy.subject, match: {emailHash: keys.emailHash}});
      if (policy.subjectDaily) scopes.push({name: 'subject', policy: policy.subjectDaily, match: {emailHash: keys.emailHash}});
    }
  }
  if (policy.ip) scopes.push({name: 'ip', policy: policy.ip, match: {ipHash: keys.ipHash}});
  return scopes;
}

/** The locks `takeAttempt` holds: one per key its scopes count by, sorted. None when no scope applies. */
export function attemptLocks(kind: AttemptKind, keys: Keys, trusted = false): string[] {
  const scopes = activeScopes(kind, keys, trusted);
  const locks = new Set<string>();
  for (const scope of scopes) {
    // A pair is covered by the IP's lock when there is one.
    if (scope.name === 'ip' || (scope.name === 'pair' && RATE_LIMITS[kind].ip)) locks.add(`attempt:${kind}:ip:${keys.ipHash}`);
    else locks.add(`attempt:${kind}:email:${keys.emailHash}`);
  }
  return [...locks].sort();
}

/** The strictest wait across the kind's scopes, and which scope set it. */
export async function checkRateLimit(
  store: AttemptStore,
  kind: AttemptKind,
  keys: Keys,
  {now = new Date(), trusted = false}: AttemptOptions = {}
): Promise<{wait: number; scope: 'pair' | 'subject' | 'ip' | null}> {
  const scopes = activeScopes(kind, keys, trusted);
  if (!scopes.length) return {wait: 0, scope: null};
  const tallies = await store.tally(
    kind,
    scopes.map(({policy, match}) => ({
      match,
      since: new Date(now.getTime() - policy.windowSeconds * 1000),
      failuresOnly: policy.counts === 'failures',
      resetOnSuccess: policy.resetOnSuccess === true,
    }))
  );
  let wait = 0;
  let scope: 'pair' | 'subject' | 'ip' | null = null;
  scopes.forEach((one, i) => {
    const seconds = retryAfterSeconds(tallies[i]!, one.policy, now);
    if (seconds > wait) {
      wait = seconds;
      scope = one.name;
    }
  });
  return {wait, scope};
}

export interface TakenAttempt {
  wait: number;
  id: bigint | null;
  /** The scope that refused it (`subject`: a limit on the address alone). */
  scope: 'pair' | 'subject' | 'ip' | null;
}

/**
 * Checks the limit, then records this attempt, holding the scopes' locks (see
 * the top of this file). `wait > 0`: refused and nothing written, answer 429.
 * `wait = 0`: go ahead; for a `failures` kind the row counts as a failure until
 * `settle(id, true)`.
 */
export async function takeAttempt(store: AttemptStore, kind: AttemptKind, keys: Keys, options: AttemptOptions = {}): Promise<TakenAttempt> {
  const countsFailures = Object.values(RATE_LIMITS[kind]).some(scope => scope?.counts === 'failures');
  const take = async (inner: AttemptStore): Promise<TakenAttempt> => {
    const {wait, scope} = await checkRateLimit(inner, kind, keys, options);
    if (wait > 0) return {wait, id: null, scope};
    return {wait: 0, id: await inner.record(kind, {...keys, succeeded: !countsFailures}), scope: null};
  };
  const locks = attemptLocks(kind, keys, options.trusted);
  if (!store.exclusive || !locks.length) return take(store);
  try {
    return await store.exclusive(locks, take);
  } catch (err) {
    // The scope is that busy: refused like any other attempt over the limit.
    if (err instanceof AttemptBusyError) return {wait: 1, id: null, scope: 'ip'};
    throw err;
  }
}
