import * as workers from 'cloudflare:workers';

import {isSensitive, KEY_PATTERN, PREFIX_PATTERN} from './cache-guard';
import {config} from './config';

/**
 * The Site Cache: a small key/value cache for THIS site, kept by the platform near the Site
 * Database (docs/agent/cache.md). Server code only (Hono routes, `src/server/`). Use it for reads many
 * requests share that rarely change, and that are THE SAME FOR EVERY VISITOR who reads that key: settings,
 * opening hours, menus, categories, page text, product cards, totals. A read here isn't billed; a query is.
 *
 *   const settings = await cache.getOrSet('store:settings', 7 * DAY, () => db.storeSettings.findUnique(…));
 *   … everywhere they're saved, after the save:  await cache.del('store:settings');
 *
 * - Deployed: one HTTPS call to `https://site-cache.internal` (~15 ms; the platform adds this
 *   site's identity, so no other site can read it). Preview and local: an in-memory stand-in
 *   with the same size limit and secret guard, empty after a restart, never the live data.
 * - It NEVER breaks a page: an outage, a slow answer (400 ms), a full cache, a bad key, or a
 *   value it can't store (BigInt, a cycle, a secret) is a MISS, and `getOrSet` simply runs
 *   `load()`. After 3 failures in a row the cache is skipped for 30 s.
 * - Values are JSON: dates come back as ISO strings; BigInt values are not cached.
 * - Keys: ids and slugs only (letters, digits, `: _ - . /`, up to 200 characters), never an
 *   email, a token or text a visitor typed. Group them by prefix (`product:12`) for `delPrefix`.
 * - Limits per site (the platform's): 500 calls and 20 saves a second, a value up to 256 KB,
 *   10,000 keys, 50 MB. A full cache drops the entries closest to expiring to make room.
 * - TTL is REQUIRED (seconds, 60 to 604,800 = 1 minute to 7 days): choose it from the data
 *   (docs/agent/cache.md "How long to keep it"). Clear the key when its data changes.
 * - Never cache: sessions, tokens, roles or permissions, a cart, the prices a quote or an order
 *   charges, payment data, or anything that depends on who is asking under a shared key. Per-user
 *   data only under `userKey(viewer.id, …)`. The owner and the platform's staff can open values.
 */

const ENDPOINT = 'https://site-cache.internal/v1/op';
const TIMEOUT_MS = 400;
const MIN_TTL = 60;
/** 7 days. */
const MAX_TTL = 604_800;
const MAX_VALUE_BYTES = 256 * 1024;
/** A cold key another request is filling: check again this often, then load. */
const FILLING_WAIT_MS = 100;
/**
 * The most a `getOrSet` ever spends on the cache before it loads from the database, whatever the
 * cache does (slow, failing, a filler that never comes back). Owner, 2026-11-01: never pile up.
 */
const READ_BUDGET_MS = 1_000;
/** After this many failures in a row, skip the cache for BREAKER_MS (a hung cache costs nothing). */
const BREAKER_FAILURES = 3;
const BREAKER_MS = 30_000;
const DEL_PREFIX_BUDGET_MS = 2_000;

type Reply = {
  hit?: boolean;
  value?: string;
  stale?: boolean;
  refresh?: boolean;
  fill?: boolean;
  lease?: number;
  filling?: boolean;
  ok?: boolean;
  deleted?: number;
  more?: boolean;
};

let forcedMode: 'remote' | 'memory' | null = null;

/** TESTS ONLY: choose the transport (null restores the default). */
export function setCacheModeForTests(mode: 'remote' | 'memory' | null): void {
  forcedMode = mode;
  local.clear();
  localChars = 0;
  failures = 0;
  skipUntil = 0;
}

const remote = () => (forcedMode ?? (config.production ? 'remote' : 'memory')) === 'remote';

/* ---------------------- the Preview's in-memory stand-in --------------------- */

const LOCAL_MAX_ENTRIES = 500;
/** Characters held in all (UTF-16: ~16 MB): the Preview shares the sandbox with the dev server. */
const LOCAL_MAX_CHARS = 8 * 1024 * 1024;
const local = new Map<string, {value: string; expiresAt: number}>();
let localChars = 0;
const encoder = new TextEncoder();

function localDelete(key: string): void {
  const entry = local.get(key);
  if (!entry) return;
  localChars -= entry.value.length;
  local.delete(key);
}

/** The same answers production gives, including what it refuses. */
function localOp(body: Record<string, unknown>): Reply {
  const now = Date.now();
  const key = body.key as string;
  switch (body.op) {
    case 'get': {
      const entry = local.get(key);
      if (!entry || entry.expiresAt <= now) {
        localDelete(key);
        return body.stale === true ? {hit: false, fill: true} : {hit: false};
      }
      return {hit: true, value: entry.value};
    }
    case 'set': {
      const value = body.value as string;
      if (encoder.encode(key + value).length > MAX_VALUE_BYTES || isSensitive(key, value)) return {ok: false};
      localDelete(key);
      while (local.size >= LOCAL_MAX_ENTRIES || localChars + value.length > LOCAL_MAX_CHARS) {
        const oldest = local.keys().next().value;
        if (oldest === undefined) break;
        localDelete(oldest);
      }
      local.set(key, {value, expiresAt: now + (body.ttl as number) * 1000});
      localChars += value.length;
      return {ok: true};
    }
    case 'del':
      localDelete(key);
      return {ok: true};
    case 'release':
      return {ok: true};
    default: {
      let deleted = 0;
      for (const name of [...local.keys()]) {
        if (name.startsWith(body.prefix as string)) {
          localDelete(name);
          deleted++;
        }
      }
      return {deleted, more: false};
    }
  }
}

/* --------------------------------- transport -------------------------------- */

let failures = 0;
let skipUntil = 0;

async function send(body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<Reply | null> {
  if (!remote()) return localOp(body);
  if (Date.now() < skipUntil || timeoutMs < 20) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeoutMs, TIMEOUT_MS)),
    });
    // 4xx is an answer (a refusal, a rate limit), not an outage.
    if (res.status >= 500) throw new Error(`cache ${res.status}`);
    failures = 0;
    return res.ok ? ((await res.json()) as Reply) : null;
  } catch {
    if (++failures >= BREAKER_FAILURES) {
      failures = 0;
      skipUntil = Date.now() + BREAKER_MS;
    }
    return null;
  }
}

/** Runs after the answer when the runtime allows it, so a save never delays the page. */
function later(promise: Promise<unknown>): void {
  const settled = promise.catch(() => undefined);
  const waitUntil = (workers as {waitUntil?: (p: Promise<unknown>) => void}).waitUntil;
  if (typeof waitUntil === 'function') waitUntil(settled);
}

let warnedKey = false;
/** A key built from data that isn't a valid key: bypass the cache (warn once), never break the page. */
function keyOk(key: string): boolean {
  if (typeof key === 'string' && KEY_PATTERN.test(key)) return true;
  if (!warnedKey) {
    warnedKey = true;
    console.warn(`cache: skipped a key that isn't ids and slugs only ("${String(key).slice(0, 40)}")`);
  }
  return false;
}

let warnedTtl = false;
/** The TTL, or null (warned once) when it is missing or not whole seconds from 60 to 604,800: the cache is skipped. */
function ttlOf(ttl: number): number | null {
  if (Number.isInteger(ttl) && ttl >= MIN_TTL && ttl <= MAX_TTL) return ttl;
  if (!warnedTtl) {
    warnedTtl = true;
    console.warn(`cache: skipped a ttl of ${String(ttl)} (required: whole seconds from ${MIN_TTL} to ${MAX_TTL})`);
  }
  return null;
}

/** JSON text for a value, or null when it can't be cached (undefined, BigInt, a cycle, too big). */
function encode(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    return text !== undefined && text.length <= MAX_VALUE_BYTES ? text : null;
  } catch {
    return null;
  }
}

type Read<T> = {value: T | null; refresh: boolean; fill: boolean; lease: number | undefined; filling: boolean};

async function read<T>(key: string, stale: boolean, timeoutMs = TIMEOUT_MS): Promise<Read<T>> {
  const miss = {value: null, refresh: false, fill: false, lease: undefined, filling: false};
  const reply = await send(stale ? {op: 'get', key, stale: true} : {op: 'get', key}, timeoutMs);
  if (!reply) return miss;
  if (!reply.hit || typeof reply.value !== 'string') {
    return {...miss, fill: reply.fill === true, lease: reply.lease, filling: reply.filling === true};
  }
  try {
    return {...miss, value: JSON.parse(reply.value) as T, refresh: reply.stale === true && reply.refresh === true};
  } catch {
    return miss;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------ API ----------------------------------- */

export const cache = {
  /** The cached value, or null on a miss (also when the cache is unreachable or the key is bad). */
  async get<T>(key: string): Promise<T | null> {
    if (!keyOk(key)) return null;
    return (await read<T>(key, false)).value;
  },

  /** Stores `value` (JSON) for `ttl` seconds (required, 60–604,800). False when not stored (any reason). */
  async set(key: string, value: unknown, ttl: number): Promise<boolean> {
    const seconds = ttlOf(ttl);
    if (seconds === null || !keyOk(key)) return false;
    const text = encode(value);
    if (text === null) return false;
    const reply = await send({op: 'set', key, value: text, ttl: seconds});
    return reply?.ok === true;
  },

  /** Removes one key; true when the cache confirmed it. Call it right after the data behind it changes. */
  async del(key: string): Promise<boolean> {
    if (!keyOk(key)) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await send({op: 'del', key}))?.ok === true) return true;
    }
    return false;
  },

  /** Removes every key starting with `prefix` (`'product:'`); `''` clears this site's whole cache. */
  async delPrefix(prefix: string): Promise<boolean> {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) return false;
    const until = Date.now() + DEL_PREFIX_BUDGET_MS;
    while (Date.now() < until) {
      const reply = await send({op: 'delPrefix', prefix});
      if (!reply) return false;
      if (!reply.more) return true;
    }
    return false;
  },

  /**
   * The cached value, or `load()`'s result stored for `ttl` seconds and returned. Only for data
   * that is the same for every visitor reading this key. Built to keep the database calm:
   * - a value just past its TTL is served while ONE request reloads it;
   * - a missing key another request is loading right now is waited for, and the whole cache
 *   part of a `getOrSet` never takes more than 1 s (a slow or failing cache can't pile requests up);
   * - the save runs after the answer; `null` / `undefined` results are not stored (and the
   *   requests waiting on this one are told at once, so they load instead of waiting);
   * - if `load()` fails while a stale value exists, the stale value is served.
   */
  async getOrSet<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const seconds = ttlOf(ttl);
    if (seconds === null || !keyOk(key)) return load();
    const deadline = Date.now() + READ_BUDGET_MS;
    const left = () => deadline - Date.now();
    let cached = await read<T>(key, true, left());
    // Another request is loading it: check again until the budget runs out, then load ourselves.
    while (cached.filling && left() > FILLING_WAIT_MS) {
      await sleep(FILLING_WAIT_MS);
      cached = await read<T>(key, true, left());
    }
    if (cached.value !== null && !cached.refresh) return cached.value;
    // This request was told to fill the key: if it won't store a value, let the waiters go.
    const release = () => {
      if (cached.fill) later(send({op: 'release', key}));
    };
    let fresh: T;
    try {
      fresh = await load();
    } catch (error) {
      release();
      if (cached.value !== null) return cached.value;
      throw error;
    }
    const text = fresh === null ? null : encode(fresh);
    // The lease makes the cache refuse this save if the key was deleted while we were loading.
    if (text !== null) later(send({op: 'set', key, value: text, ttl: seconds, ...(cached.lease !== undefined ? {lease: cached.lease} : {})}));
    else release();
    return fresh;
  },
};

/** A key that belongs to one signed-in user (`user:<id>:<key>`). Build it from `c.var.viewer.id`, never input. */
export function userKey(userId: number | string, key: string): string {
  const id = String(userId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TypeError('userKey: a user id');
  return `user:${id}:${key}`;
}
