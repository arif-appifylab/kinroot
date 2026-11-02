---
title: Site Cache: what to cache, how, and when to clear it
read-when: before writing a Site API read that runs on many requests (settings, hours, menus, categories, products, page text), a page or list that is slow, or any change that saves data a cached read shows
---
The platform keeps a small key/value cache for this site, next to the Site Database: a read takes a
few ms, a Prisma query ~100–150 ms (each one is an HTTPS round trip). Use it to answer the SAME
data many visitors ask for without going to the database every time. Server code only (Hono
routes, `src/server/`); the browser never calls it.

## The helper (`src/platform/cache.ts`)
```ts
import {cache, userKey} from '../../platform/cache';

const MINUTE = 60, HOUR = 3600, DAY = 86_400; // TTLs are in seconds

// Read-through: cached value, else load, store for 7 days (cleared on save, below), return.
const settings = await cache.getOrSet('store:settings', 7 * DAY, () =>
  db.storeSettings.findUnique({where: {id: 1}, select: {…}})
);

// After the data changes (in the SAME route that saved it):
await cache.del('store:settings');
await cache.delPrefix('category:');   // a group of keys
```
`get(key)` → value or `null`, `set(key, value, ttl)` → `true` when stored, `del(key)` and
`delPrefix(prefix)` → `true` when done, `getOrSet(key, ttl, load)`, `userKey(viewer.id, key)`.
- Deployed: the platform's cache. Preview and local: an in-memory stand-in with the same limits
  and refusals (empty after a restart, never the live data). Test with the Preview as usual.
- It never breaks a page: unreachable, slow (> 400 ms), rate-limited, full, a bad key or a value it
  can't store (BigInt, a cycle, a secret) = a MISS, and `getOrSet` simply runs `load()`. After 3
  failures in a row the cache is skipped for 30 s. The cache part of one `getOrSet` never takes
  more than 1 s in all; then it loads from the database. Don't add your own timeouts or retries.
- **The TTL is required** on `getOrSet` and `set`: whole seconds from 60 (1 minute) to 604,800
  (7 days). Missing or out of range = the cache is skipped (a warning in the log): choose it by
  "How long to keep it" below, every time.
- **Values are JSON: a `Date` comes back as an ISO string, a BigInt is not cached.** Convert in
  the route (`new Date(row.createdAt)`), or cache `id.toString()`.
- No stampede, through `getOrSet` only: a busy key just past its TTL is served for a short grace
  (at most 1 minute) while ONE request reloads it; a missing key another request is loading is
  waited for (up to ~1 s) instead of loaded again; the save runs after the answer. A plain `get` never
  sees an expired value. If `load()` finds nothing (`null`) or the value can't be stored, the next request
  loads instead of waiting.

## What to cache
| Data | Key | TTL | Clear when |
| --- | --- | --- | --- |
| store / site settings, opening hours | `store:settings`, `store:hours` | 7 days | the settings route saves |
| menus, categories, navigation | `menu:list`, `category:<slug>` | 7 days | a menu or category is saved: `delPrefix('category:')` |
| owner-edited page text, FAQs, team | `page:<slug>` | 7 days | the page is saved |
| a product card / detail (what the PAGE shows) | `product:<id>`, `product:slug:<slug>` | 1 day | that product is saved, or its price / stock changes |
| a public list (a category's first page, featured) | `category:<slug>:list`, `shop:featured` | 1 hour | any product in it is saved: `delPrefix('category:')`, `del('shop:featured')` |
| counts and totals shown publicly ("120 jobs open") | `stats:jobs-open` | 10 minutes | (time-based: nothing clears it) |
| data from another service (rates, availability, reviews feed) | `ext:<service>:<thing>` | as stale as the owner accepts: 5–60 minutes | (time-based) |
| one signed-in user's own read-heavy data (their order history list) | `userKey(viewer.id, 'orders')` | 15 minutes | they place or change an order |
Cache the SHAPE the route returns (the `select`ed fields), not whole rows.

## How long to keep it (the TTL: required, 1 minute to 7 days)
Decide from the data, every time; never copy a number without thinking:
1. **Does a route you control clear it when it changes?** (settings, menus, pages, products the
   owner edits, all clearing with `del` / `delPrefix` in the route that saves.) Then keep it LONG:
   **1 to 7 days.** Freshness comes from the clear, not the TTL; a long TTL just means fewer
   database reads. Use 7 days for things that change rarely, 1 day for things edited often.
2. **Does it change by itself, with nothing to clear it?** (counts, "open now", stock that changes
   with orders, anything computed from many rows, data from another service.) Then the TTL IS how
   old a visitor may see it: **1 to 60 minutes.** Ask: "if this is N minutes old, is that wrong
   for the owner or a visitor?" Pick the largest N that's still fine.
3. **Is it about one signed-in user?** Short: **5 to 30 minutes**, and clear it when they change it.
4. **Money and access never come from the cache** (see "Never cache"): there is no TTL short enough.
When in doubt between two values, choose the shorter one and clear on change.

## Shared keys hold only what EVERY visitor sees (the leak rule)
A key without `userKey(…)` is shared by every visitor. Cache under it ONLY a result that is
identical for every visitor who could read it. If `load()` reads the visitor (`c.var.viewer`,
`getAccess`, a membership, a cookie, the language, a price list per customer group), put that in
the key (`category:beef:list:lang:es`, `userKey(viewer.id, …)`) or don't cache it. Never cache
rendered HTML or a whole response. When unsure: don't cache it.

## Never cache
The site owner and the platform's staff can open any cached value (to check and clear it), so a
cached value is never private. The platform REFUSES (`set` → false) a key or a JSON field named
like a sign-in secret (`password`, `passwordHash`, `tokenHash`, `codeHash`, `*Sealed`, `accessToken`,
`refreshToken`, `jwt`, `sessionToken`, `clientSecret`, `apiKey`, `recoveryCodes`…), a session id,
salt or hash that looks like one, a JWT, an API key (`sk_live_…`, `sk-…`, `AKIA…`), a bearer token,
a URL with a password, or a private key. Leave those fields out (an explicit `select` does it).
- Sessions, tokens, who the visitor is, roles or permissions (`getViewer`/`getAccess` are already
  per request), a cart, checkout or payment data.
- **The prices or stock a quote, an order or a payment uses.** Show cached prices on pages, but
  the route that charges reads the database (a cached price can be minutes old).
- Another user's data, an email address, anything signed (file links), errors, a 404 or a `null`
  (`getOrSet` already skips `null`: a missing row may exist a moment later).
- Per-user data under a key that does not come from `userKey(c.var.viewer.id, …)`.
- Values over ~256 KB (not stored): cache the first page of a list, not the whole table.

## Keys and limits
- **Ids and slugs only**: letters, digits and `: _ - . /`, up to 200 characters; never an email, a
  token, a code or text a visitor typed (key names are listed to the owner and staff). A prefix per
  kind (`product:`, `category:`, `page:`, `user:<id>:`) so `delPrefix` clears a group.
- Per site: a value up to 256 KB, 10,000 keys, 50 MB, 500 calls and 20 saves a second (deletes are
  never held back), TTL 1 minute to 7 days (required). A full cache drops the entries closest to
  expiring to make room; a value too large or a save over the limit is simply not stored.
  Expired keys go away by themselves. When a site user deletes their account, their `user:<id>:`
  keys are cleared; resetting or restoring the Site Database clears the whole cache.
- The cache is the site's alone: no other site can read it. The owner (their dashboard) and the
  platform's staff can list keys, open values and clear a key, a prefix or everything, any time:
  the site must work the same with an empty cache.

## Rules
1. **Clear in the same route that writes.** Every route that saves data a cached read shows calls
   `del` / `delPrefix` right after the write succeeds. A missing clear = stale pages until the TTL.
2. **One key per thing, read through `getOrSet`.** Never cache in module memory yourself.
3. **Still fix the query.** A miss runs the query: it must stay fast (explicit `select`, one query
   per nested read, `Promise.all` for independent reads, `performance.md`).
4. **Prerender first.** A page that is the same for everyone and changes only on Publish is a static
   page (no Worker, no cache needed). The cache is for Site API reads and server-rendered pages.

## A site without `src/platform/cache.ts` (built before the cache)
Run `npm run platform -- upgrade` when you can. If that is not possible in this task, do NOT add
the file to `src/platform/`: put this in `src/server/site-cache.ts` and import it from there.
```ts
import * as workers from 'cloudflare:workers';
import {config} from '../platform/config';

const ENDPOINT = 'https://site-cache.internal/v1/op';

async function send(body: Record<string, unknown>): Promise<any> {
  if (!config.production) return null; // Preview / local: always a miss
  try {
    const res = await fetch(ENDPOINT, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(400)});
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// The save runs after the answer. Without waitUntil the Worker cancels it when the page returns.
function later(promise: Promise<unknown>) {
  const waitUntil = (workers as {waitUntil?: (p: Promise<unknown>) => void}).waitUntil;
  if (typeof waitUntil === 'function') waitUntil(promise.catch(() => undefined));
}

export async function getOrSet<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await send({op: 'get', key});
  if (hit?.hit) {
    try { return JSON.parse(hit.value) as T; } catch { /* a miss */ }
  }
  const fresh = await load();
  let text: string | undefined;
  try { text = JSON.stringify(fresh); } catch { /* BigInt or a cycle: not cached */ }
  if (fresh != null && text) later(send({op: 'set', key, value: text, ttl}));
  return fresh;
}
export const del = async (key: string) => (await send({op: 'del', key}))?.ok === true;
export async function delPrefix(prefix: string): Promise<boolean> {
  const until = Date.now() + 2000; // 1,000 keys per call
  while (Date.now() < until) {
    const reply = await send({op: 'delPrefix', prefix});
    if (!reply) return false;
    if (!reply.more) return true;
  }
  return false;
}
```
Same keys, TTLs and rules as above; a site's own copy must not add anything else (no other host, no
headers, no secrets).
