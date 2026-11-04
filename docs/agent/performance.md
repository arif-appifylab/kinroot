---
title: Performance: fast pages, cheap queries, Workers limits
read-when: before writing a query, a list, a page, adding a dependency, an image, a font, a cache, or anything that loops
---
The site runs on ONE Cloudflare Worker: 128 MB per isolate, a short CPU budget per request
(one password hash alone is ~160 ms), no KV/Redis of your own, no cron. The Site Database is Prisma
Postgres over one WebSocket per request: a query is ~3 ms, ~20 ms to open the socket once
(`database.md` › Connections; a site without `src/platform/db-socket.ts` still pays ~130 ms a query:
upgrade it). Design for few, small, indexed queries, reads together in `Promise.all`. Every query is
also billed, one operation each whatever its joins, so one join beats three queries, and reads many requests share go in the
Site Cache, by `cache.md` › "Should this be cached?".

## Worker budgets (design to these)
| Budget | Target | Why |
| --- | --- | --- |
| CPU per request | < 10 ms for a read, < 50 ms for a write (password hashing aside) | CPU is the Worker's hard limit; waiting on the database is not CPU |
| Database round trips per request | ≤ 5, independent ones in parallel | about 1 Worker instance in 15 pays ~170 ms for each one, so five is already ~1 s there |
| Response size | ≤ 100 rows, ≤ ~200 KB JSON | serializing is CPU; the portal renders it all |
| Module memory | small public maps with a size cap (`PUBLIC_CACHE`: 200 entries) | an isolate serves many visitors and lives on |
| Request body | 64 KB (`bodyLimit` in `src/server/app.ts`) | files go straight to storage (`files.md`) |
| Work after the answer | `c.executionCtx.waitUntil()`, bounded; anything longer is a job | `background-jobs.md` |
- CPU-heavy work (big CSV, image processing, report totals over many rows) never runs in a
  request: a background job in bounded batches, results stored in a table.
- No top-level work in a module beyond constants: parsing a big JSON file or building a table at
  import runs on every cold start.

## Queries (non-negotiable)
- **Round-trip budget: at most ~5 sequential database round trips per request**, ideally 1–3.
  Count them for every route you write (`review.md` step 5): ~3 ms each normally, ~170 ms on a
  slow Worker instance (~130 ms each on a site not yet upgraded). `Promise.all` of plain reads
  counts as ONE: they share the trip.
- **One query per read**: related rows in the SAME query (nested `select`, one SQL join with
  `relationJoins`), aggregates and multi-table reads as ONE tagged `$queryRaw` (`database.md` ›
  One query per read). Never "load the list, then load each item's details".
- **No `await` inside a loop** (`for`, `.forEach`, `.map(async …)`) that reaches the database, the
  platform or another service. Collect the ids, ONE `findMany({where: {id: {in: ids}}})` (bounded),
  join in a `Map`; or ONE `createMany` / `updateMany` / tagged `$executeRaw` for writes.
- **Explicit `select`** on every query: only the columns the answer needs. Never return a whole row.
- **Bounded**: every `findMany` has `take` (≤ 100). No unbounded `findMany`, no `deleteMany`
  without a narrow `where`, no loading a table to filter in JS.
- **Keyset paging**, never offset (`skip` reads and throws away every earlier row):
  `where: {id: {lt: before}}`, `orderBy: {id: 'desc'}`, `take: PAGE + 1`, answer `nextBefore`
  (`jobs.ts`). Ordered by something else (time, a score), the cursor is that value PLUS `id`,
  and the index ends the same way (`@@index([teamId, createdAt(sort: Desc), id(sort: Desc)])`):
  ```ts
  // cursor "2026-10-29T08:00:00.000Z_123" from the previous page's last row
  const [at, id] = [new Date(cursorAt), cursorId];
  const rows = await db.event.findMany({
    where: {teamId, ...(cursorAt ? {OR: [{createdAt: {lt: at}}, {createdAt: at, id: {lt: id}}]} : {})},
    orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: PAGE + 1, select,
  });
  ```
  Validate both parts of the cursor (a real date, a safe integer). No "page 7 of 40": next/more.
- **No `count()` / aggregates on growing tables per request.** Show "25+" from the first page
  (`pageCount` in `src/portal/shared.tsx`), or keep a counter column updated in the same write.
- **An index for every query shape**: the `where` columns first (equality, then range), then the
  `orderBy` column. Add it in `schema.prisma` (`@@index([ownerId, id])`) in the same migration as
  the query. Check with `EXPLAIN` in Prisma Studio/psql on the Preview Database when in doubt.
- **No N+1**: fetch related rows with one `include/select` or one `where: {id: {in: ids}}`
  (bounded), never a query inside a loop.
- **Parallel when independent, always**: `Promise.all([a, b, c])` for reads that don't need each
  other's result (the page's data + the visitor, a list + its total-ish count, two lists). Sequential
  only when one needs the other, or inside a transaction. Bound it: `Promise.all` over a list of
  ids is a loop of queries in disguise (use one `in` query).
  In a page, a read that does not depend on the visitor runs BESIDE `pageContext()`, never after
  it (`src/pages/jobs/index.astro`):
  ```ts
  const [{site, viewer}, page] = await Promise.all([
    pageContext(Astro.request, Astro.response),
    read<JobsPage>(backend(Astro.request).jobs.$get({query: {…}})),
  ]);
  ```
- **Search**: `contains` (ILIKE) scans; fine for hundreds of rows. Before thousands, add a
  `pg_trgm` GIN index or full-text (`tsvector`) column in a migration, or search exact values only.
- Writes that must be atomic: one conditional `updateMany` (`where: {id, status: 'open'}`, check
  `count`) or `$transaction([...])`. No read-modify-write races, no `SELECT … FOR UPDATE` loops.
- Long text/JSON columns: cap sizes in the validator and the column (`@db.VarChar(n)`).

## Per request
- The visitor, their access and the DB client are memoized per request (`request-scope.ts`):
  call `getViewer`/`getAccess` freely; never cache them yourself.
- Pages call the Site API IN-PROCESS (`backend()`), never `fetch()` their own host.
- Every platform call has a timeout and a fallback (`src/platform/api.ts`); a slow section
  disappears, the page still renders.
- Background work after the answer: `c.executionCtx.waitUntil(promise)` (bounded, guarded).

## Caching
| Response | Cache | How |
| --- | --- | --- |
| prerendered pages, `public/` files | edge, revalidated | served before the Worker runs; nothing to add |
| hashed `/_astro/*` files | a year, `immutable` | added by the build; never reference them by a fixed name |
| the same for everyone, reads no visitor (no cookies, no `pageContext`, no `withViewer`) | `Cache-Control: public, max-age=…` | `/sitemap.xml` (1 h), `GET /site-api/jobs/sitemap` (1 h) |
| anything that read the visitor, or depends on their roles | `private, no-store` | set by `withViewer`, `pageContext`, `/me`; an SSR page calling `pageContext` is private, always |
| sign-in, tokens, account answers | `no-store` | `withAuthCore` and the managed auth routes set it |
| public platform data (brand) | per-isolate memo | `publicGet(..., {ttlSeconds})` (60 s); public data only |
| Site API reads many requests share (settings, hours, menus, categories, products, page text, totals, an outside API) | the Site Cache: fewer billed queries | `cache.getOrSet(key, ttl, load)` + `cache.del` everywhere it's saved (`cache.md`) |
| portal reads | TanStack Query in the browser | `staleTime: 30_000` in `PortalApp.tsx` |
- Never `public` on: a response that varies by cookie, a list filtered by permissions, anything
  with an email, a draft, a signed file link, an error, or a 404 that may soon exist. A wrong
  `public` header serves one visitor's page to the next.
- `max-age` short (minutes to an hour) on SSR data; the owner expects edits to show soon. Prefer
  prerendering anything that is the same for everyone.
- No whole-table or per-visitor cache in module memory, no hand-made cache of `getViewer` /
  `getAccess` (memoized per request already: `request-scope.ts`). A shared cache is the Site Cache
  (`cache.md`), never a module-level `Map`.

## Pages
- Pick the page kind first (AGENTS.md): static (prerendered) for marketing, SSR for crawlable
  data, the portal SPA for signed-in screens. Static is the fastest: no Worker work at all.
- JavaScript: Astro ships none by default; keep it that way on public pages. A `<script>` is a
  small module; React islands only where there is real interactivity (`client:visible` over
  `client:load`). Never ship the portal's bundle to public pages. Budget: < 50 KB JS gzipped on a
  public page, < 250 KB for the portal's FIRST load (screens load lazily on top: each one small,
  < 50 KB gzipped).
- Portal bundle: every screen lazy (`lazyRouteComponent`, below); a heavy library used by one
  screen or one action (a chart, a rich-text editor, a CSV parser) is imported INSIDE that
  screen, or with `await import('…')` in the handler that needs it, never in the kit (`src/portal/ui/`),
  `shared.tsx` or `PortalApp.tsx`. Import named functions, not whole libraries. Prefer the
  platform: `Intl.DateTimeFormat` / `Intl.NumberFormat` over date and number libraries, `<dialog>`
  and CSS over UI kits, `fetch` through `api` over HTTP clients.
- Lists in the portal render one page (≤ 100 rows) and load more on demand
  (`useInfiniteQuery`); never render thousands of rows.
- Images: in PRERENDERED pages, the file in `src/assets/` through `astro:assets` (`Cover`,
  `<Picture formats={['avif', 'webp']} widths sizes>`): resized and converted at BUILD
  (`imageService: 'compile'`). `sizes` says how wide the slot is, so phones get the small file.
  In SSR pages and the portal images are passed through (no on-demand transforms): commit them
  resized, or use the CDN URL's own sizing. Always `width` and `height` (no layout shift),
  lazy below the fold (`Cover` default, `loading="lazy"` + `decoding="async"`), the ONE hero /
  LCP image eager with `fetchpriority="high"`.
- Fonts: system stack by default. A web font: self-host `woff2` in `public/fonts`, at most 2
  weights, `font-display: swap`, `<link rel="preload">` the one used above the fold.
- CSS: one stylesheet (`src/styles/global.css`); no CSS framework added on top unless the owner asks.

## Navigation: instant everywhere, SEO kept
- **Public pages stay a multi-page site**: each is real HTML at its own URL (prerendered or
  SSR), reached by a plain `<a href>`, and navigated client-side by Astro's `<ClientRouter />`
  (`Base.astro`): the next page is swapped in without a reload, focus moves and the new title is
  announced, history and scroll work. Never move a public or SEO page into the portal; `/dashboard`
  has no router, so a link to it is a normal page load (as it must be).
- **Scripts with the ClientRouter**: a bundled `<script>` runs ONCE per visit, so page code runs
  in `document.addEventListener('astro:page-load', () => { … })` and returns early when the page's
  own element is missing (the event fires on every page: first load, each navigation, back and
  forward). Listeners on `document`/`window` are added once, outside it. `history.replaceState`
  keeps `history.state` (the router's). After a sign-in or sign-out, a full load
  (`location.assign`): the header must be rendered again for the new session.
- **List pages (static shell + JSON).** A long list is a prerendered page: title, text and filters in the HTML,
  skeleton rows, and `bindListPage` (`src/lib/list-page.ts`) fills in rows from the JSON route. Filters, search and
  "load more" fetch only the data, and filters stay in the URL. Copy `src/pages/jobs/index.astro`:
  - `preloadData="<the route>"` on `<Base>` starts the data with the page, not after it. On a link with filters
    in it, that first fetch is unused: one extra query, which is why it's only for the plain list.
  - The rows are `<template>` + `textContent`, no React: public pages stay light.
  - Loading, empty, no match and error all come from the helper, with the error's Try again button.
  - The route answers fast and small: `select` only what a row shows, keyset paging, bounded (`database.md`).
  - Search engines read the shell: the title, description and intro text go in it, never in the JSON. Every detail page goes
    in `/sitemap.xml`. See `seo.md`.
  - An older list page rendered on the server keeps working. Move it when a task changes it, not for its own sake.
- **Prefetch is opt-in** (`prefetch: {prefetchAll: false, defaultStrategy: 'hover'}`): a link
  to a PRERENDERED page carries `data-astro-prefetch` (fetched on hover or focus); the header
  nav uses `data-astro-prefetch="viewport"` (`Base.astro`, phones have no hover). Never on a
  link to an SSR page (`/jobs/<slug>/`) or `/dashboard`: they answer `no-store`, so the prefetch is a
  wasted Worker request. A new SSR page in `NAV` gets `prefetch: false` (`src/content/site.ts`).
- **View transitions**: the ClientRouter animates page to page; the header holds still
  (`view-transition-name: site-header`, unique per page). The cross-document `@view-transition`
  in `global.css` covers full loads (`/dashboard`), inside `prefers-reduced-motion: no-preference`.
- **The portal** (`src/portal/`): one SPA, never a page load between screens. `PortalApp.tsx`
  sets `defaultPreload: 'intent'` (a hovered `<Link>` loads the screen's code and data),
  `defaultPreloadStaleTime: 0` (Query owns caching), `scrollRestoration`, the pending and error
  screens, and Query's `staleTime: 30_000` (going back to a screen is instant). Every screen,
  every time: its reads as `queryOptions` in `src/portal/queries.ts` (used by the screen AND
  its route's `loader` through `queryClient.ensureQueryData` / `ensureInfiniteQueryData`), a
  LAZY component (`lazyRouteComponent(() => import('./screens/x'), 'X')`) and a
  `staticData.title`. Never import a screen statically in `routes.tsx` (it lands in the first
  bundle), never `fetch` in a `useEffect`, never `staleTime: 0` by default.
## Core Web Vitals and measuring
- Targets, mobile, at the 75th percentile: LCP < 2.5 s, INP < 200 ms, CLS < 0.1; server time
  (TTFB) < 200 ms for prerendered pages, < 600 ms for SSR pages and Site API reads.
- Lighthouse on a public page (mobile): Performance ≥ 95, Accessibility ≥ 95, Best Practices
  ≥ 95, SEO ≥ 95 (a `noindex` page scores low on SEO by design). A console error (often a CSP
  block) costs Best Practices.
- Measure on the LIVE site (the Preview runs a dev server: slower, unbundled, not representative):
  Chrome DevTools Lighthouse and Performance panels, the Network panel for request count and size.
- Bundle sizes: after `npm run build`, the gzipped size of each built script:
  `find dist -path '*/_astro/*.js' -exec sh -c 'echo "$(gzip -c "$1" | wc -c) $1"' _ {} \; | sort -n | tail`.
  A screen chunk that jumped means a heavy import: find and lazy-load it.
- Queries: `EXPLAIN` the query shape on the Preview Database (Prisma Studio / psql): a `Seq Scan`
  on a growing table means a missing index (`database.md`).
- CPU: a Worker's clock only moves on I/O, so `Date.now()` around pure CPU work reads 0 when
  deployed; time CPU-heavy code locally (`performance.now()` in a test), keep it out of requests.

## Never
A loop over all rows, a query per row, `count()` per request, an un-indexed `where`, offset
paging, a whole-table cache in memory, a big npm package for a small helper, blocking scripts in
`<head>`, images without dimensions, or work after the response without `waitUntil`.
