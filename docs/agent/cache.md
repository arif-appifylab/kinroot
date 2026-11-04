---
title: Site Cache: what to cache, how, and how to keep it from showing old data
read-when: before writing a read that runs on many requests (settings, hours, menus, categories, products, page text, totals), a slow page, or any change that saves data a cached read shows
---
The platform keeps a small key/value cache for this site. Server code only (Hono routes,
`src/server/`); the browser never calls it. **Use it for reads many requests share. Every database query is
billed, and a read from the cache isn't.** So it saves the owner money and keeps pages quick on a slow Worker
instance. A cache also brings a risk: old data on a page. Aim for both, in balance: cache the reads that repeat, and
make sure a change always shows.

## What each read costs
| Measured from a Worker in Frankfurt | Normal | On a slow Worker instance (~1 in 15) | Billed by the database? |
| --- | --- | --- | --- |
| a Site Cache read | ~15 ms | ~18 ms | no |
| a plain indexed query, socket already open | ~3 ms | ~170 ms | yes, one operation |
| the first query of a request (opens the socket) | ~20 ms | ~1,000 ms | yes, one operation |

- Prisma Postgres bills per operation: one ORM call or `$queryRaw` is one, however many joins it has, and a row or a report costs the same.
  So one query with a join is cheaper as well as faster than three queries.
- A hit isn't always faster than an open socket, and that's fine. It's a query not billed. It's clearly faster
  when the query is expensive, or when a route runs no query at all on a hit.

## Should this be cached? Work it out for THIS data
There's no list that decides for you: the same "product" can be safe on a public page and a bug at checkout. **First fix the query:** an
index, an explicit `select`, one join, `Promise.all`. A cache hides a slow or looping query until the first miss, and doesn't fix it.
Then read the code and answer these for the read in front of you:

1. **Who reads it, and how often?** Find the routes and pages that call it. On every public page, or once a day in a report? A rare read saves nothing.
2. **Is the answer the same for everyone who reads that key?** Follow `load()` and everything it calls: the viewer, roles, language, currency,
   a cookie, drafts. Anything that changes the answer goes in the key, or it isn't cacheable. When in doubt, it isn't shared.
3. **What changes it?** Search the whole codebase for writes to these tables, including routes, portal screens, background jobs, webhooks, imports
   and installed apps. Include rows it's built from: a list changes when one product in it does, and when one is deleted.
4. **Does it change by itself, with nothing writing?** "Open now", a sale that ends at midnight, "2 hours ago". A clear can't catch these.
5. **What happens if it's old?** Walk it through for this data: a wrong menu for a minute is harmless. A wrong price at checkout, access after
   being removed, or a deleted thing still showing is not.
6. **Who reads it right after changing it?** The person who just saved expects to see it. Those screens read the database.

**Cache it when** it's read often, the answer is shared or keyed, you found every write and can clear in each, and old is harmless for its TTL.
Also when it's expensive to build, or comes from another service. **Don't when** any answer is "I don't know": read more code, or leave it
uncached. An uncached read costs a tiny amount. A cache bug costs the owner's trust.

Keep it simple. One key per thing a page shows, not one per query. A handful of well-chosen keys on the busiest routes saves most of the
queries, so don't wrap every read.

**Say what you decided.** For each key you add, end your answer with one line: `key — TTL — why it's worth caching — every place that clears it`.
If you left a busy read uncached, say why in a few words.

## How caches go wrong
Check your key against each of these. Most cache bugs are one of them:
| The bug | What the visitor sees | How to avoid it |
| --- | --- | --- |
| A write path forgot the clear (a job, webhook, import, app or second screen) | The old value until the TTL | Search for every write to the tables behind it, and clear in each |
| Related data: the product changed, but a list holding it is cached | The right product page, the wrong price in the category list | Clear lists too: a prefix (`delPrefix('category:')`), or keep list TTLs short |
| Deleted or unpublished, still in a cached list | A dead link, or something that should be gone | Clear on delete and unpublish as well as on save |
| Cleared inside a transaction, or before the save | Old value put back by the next read, or data that rolled back | Clear after the save has succeeded, outside the transaction |
| The answer depends on the visitor but the key doesn't | One person's data, language or prices shown to another | Follow `load()`. Key it with `userKey(…)` or the language, or don't cache |
| Filtered by permission, then shared | A list leaking what only staff should see | Never share a list that a role or permission filtered |
| Drafts and published together | Unpublished content on the public site | Cache only the public shape, filtered to published |
| Cached the clock | "Open now" wrong for hours; a sale that won't end | Cache the raw hours or dates, and work out "now" on every request |
| Money or stock used for a decision | The wrong amount charged; oversold stock | Show cached prices on pages. The route that charges or reserves reads the database |
| Access decided from a cached value | Still allowed in after being removed | Roles, sessions and plans always come from the database |
| Edit screen reads the cache | "I saved it and nothing changed" | Portal and admin screens read the database |
| Key from what a visitor types | Thousands of useless keys, and a full cache | Only ids and slugs. Never search terms or free filters |
| A failed or empty answer stored | A broken or empty page for the whole TTL | Throw on failure instead of returning a fallback. `getOrSet` already skips `null`, but an empty list is stored, so give empty lists a short TTL |
| Dates and BigInt | A crash or `Invalid Date` only on a hit, so tests pass | Values are JSON. Convert dates when you read them, and test a hit as well as a miss |

## Worked examples
- **Opening hours on every page:** cache. Same for everyone, changed only on one settings screen, read constantly. Key `store:hours`, 7 days, cleared by
  that screen. "Open now" is worked out per request from the cached hours, never cached itself.
- **Category list on a shop:** cache the first page, with a short TTL. Clear with `delPrefix('category:')` wherever a product is saved, deleted, or its price or
  stock changes. Deep pages and filters aren't cached.
- **Product price:** cache for showing, never for charging. The quote and checkout routes read the database.
- **"My orders":** only if it's slow or read a lot. Under `userKey(viewer.id, 'orders')`, cleared when they order. The detail of one order reads the database.
- **The owner's product list in the portal:** don't cache. They edit it and expect to see the change, and it's rarely read.
- **A job board's open-jobs count:** cache for 10 minutes, with no clear. Being a few minutes old is harmless.
- **Search results:** don't cache. The keys are what people type, and they rarely repeat.

## Keeping it from showing old data
Rules for every key:
1. **Clear in every place** you found in question 3. If you can't list them all, use a short TTL, up to 5 minutes, and only where that old is fine.
2. **Clear after the save has succeeded, outside the transaction.**
3. **Group related keys** under a prefix, and clear the group when one thing can appear in several.
4. **A change must show, so test it:** read, save, read again, and the second read shows the new value. Add this to the route's integration test.
5. **Never rely on it being there.** The site has to work the same on an empty cache, and a miss runs your query.

A site built before the socket (no `src/platform/db-socket.ts`) pays ~130 ms a query, so the cache
helps it even more: **don't remove a cache there.** Upgrade it (`upgrade.md`) when you can. On any site, a cache that fails
this test can go when you're working in that code: remove its read and its `del` calls together.

## The helper (`src/platform/cache.ts`)
```ts
import {cache, userKey} from '../../platform/cache';

const MINUTE = 60, HOUR = 3600, DAY = 86_400; // TTLs are in seconds

// Read-through: cached value, else load, store for 7 days (cleared on save, below), return.
const settings = await cache.getOrSet('store:settings', 7 * DAY, () =>
  db.storeSettings.findUnique({where: {id: 1}, select: {…}})
);

// After the data changes (in EVERY place that saves it, after the save succeeded):
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
| store / site settings, opening hours | `store:settings`, `store:hours` | 7 days | settings are saved |
| menus, categories, navigation | `menu:list`, `category:<slug>` | 7 days | a menu or category is saved: `delPrefix('category:')` |
| owner-edited page text, FAQs, team | `page:<slug>` | 7 days | the page is saved |
| a product card or detail, as the PUBLIC page shows it | `product:<id>`, `product:slug:<slug>` | 1 day | that product is saved, or its price or stock changes |
| a public list: a category's first page, featured | `category:<slug>:list`, `shop:featured` | 1 hour | any product in it is saved: `delPrefix('category:')`, `del('shop:featured')` |
| counts and totals shown publicly ("120 jobs open") | `stats:jobs-open` | 10 minutes | (time-based: nothing clears it) |
| a report or aggregate that takes several queries or a heavy `$queryRaw` | `report:<name>` | 10–60 minutes | what it counts changes, or time-based |
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
1. **Clear everywhere it's written.** Every place that saves data a cached read shows calls
   `del` / `delPrefix` right after the write succeeds. A missing clear = stale pages until the TTL.
2. **One key per thing, read through `getOrSet`.** Never cache in module memory yourself.
3. **Fix the query first.** A miss still runs it: explicit `select`, an index, one query per nested read, `Promise.all`
   (`performance.md`). When a route reads several keys, read them in `Promise.all` too: one by one they add up.
4. **Prerender first.** A page that is the same for everyone and changes only on Publish is a static
   page (no Worker, no cache needed, nothing billed). The cache is for Site API reads and server-rendered pages.
5. **The site must work the same on an empty cache.** Nothing depends on a value being there.

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
