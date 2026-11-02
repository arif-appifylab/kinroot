# Rules for AI agents working in this app

The single source of rules for EVERY coding agent (Claude Code, Codex, Gemini, Cursor…).
`CLAUDE.md` and `GEMINI.md` only import this file: edit here, never there.

This repo is ONE site: a website AND its own app, in one Astro project on ONE
Cloudflare Worker (`output: 'server'`, `@astrojs/cloudflare`). It stands alone: it owns its
users, sign-in, roles and data in its own Site Database. It already works end to end:
prerendered marketing pages, a blog, a job board, sign-up/sign-in/password reset, two-step
sign-in, change email, signed-in devices, delete account, one-click owner sign-in from the dashboard
("Open admin"), a dashboard with user and role admin, a backend and a database. Extend it; don't
rebuild what is here.

Placeholders written as double braces around an UPPER_CASE name are filled in by the platform.
The filled-in copy, which wins over this file when they differ, is what the editor
gives you (`/etc/claude-code/CLAUDE.md`, `{{DOCS_DIR}}/`); outside the editor,
`npm run platform -- docs` saves it to `.platform/docs/` (start with `core.md`).

## Every task: the current rules first, then the owner's words
These rules are kept up to date by the platform and can be newer than this site's code, which stays
as it was built. The owner is not an engineer: they say WHAT they want; HOW is yours, by these rules.
1. Before each task, re-read the current rules (`/etc/claude-code/CLAUDE.md` in the editor, for every
   agent; else `{{DOCS_URL}}` on this site's address) and the topic doc for that work (below), even
   mid-session: they may have changed since you last read them. Never work from memory of them.
2. Then do what the owner asked, the way these rules say.
3. Code the task touches or depends on that breaks a current rule: bring it up to the rule in the same
   task when it matters (security, lost or wrong data, a broken page, a slow query or page,
   accessibility). Something minor: leave it and say so in one short line. Never rewrite parts of the site the task does not need.
4. A doc names something this site does not have yet (a helper in `src/platform/`, a script command):
   its platform code is older than the doc. Never add it inside `src/platform/` (managed); do the
   task in your own code (`src/server/`, `src/pages/`…) following the doc's pattern.
5. Before saying it's done, check it works: `npm run build`, `npm test`, and the page in the Preview.
6. **Then review it, every task that touched a route, a query, a page that reads data, a permission,
   a form, a payment, a job or an outside call: run `review.md` (security with AUTHORIZATION first,
   then performance), fix what it finds, and end your answer with its short report.** No exceptions
   for "small" changes: most leaks are one missing `where`.

## Topic docs: read the one that fits BEFORE that work
Read the current copy: `{{DOCS_DIR}}/<topic>.md` in the editor, else `{{DOCS_URL}}/<topic>.md` on this
site's address. `docs/agent/<topic>.md` in this repo is the copy from when the site was built or last
upgraded and can be older; when they differ, the current copy wins:

| Doc | Read it before |
| --- | --- |
| `ui.md` | ANY dashboard screen, form, table, dialog, button, style or UI dependency (the UI kit) |
| `auth.md` | anything about who the visitor is, sign-in, sessions, passwords, account emails |
| `roles-and-permissions.md` | gating a feature, an admin screen, a new permission or role |
| `security.md` | any route, form, query, HTML, outbound call, secret, log line; before "done" |
| `review.md` | the END of every task that touched server code or data (the security + performance review, with its report) |
| `performance.md` | any query, list, page, dependency, image, font, cache or loop |
| `cache.md` | a Site API read that runs on many requests (settings, hours, menus, categories, products, page text), a slow page, or saving data a cached read shows |
| `database.md` | the schema, a migration, seed data, an index, a new model |
| `seo.md` | a new public page, titles and descriptions, URLs, social cards, sitemap, robots.txt, RSS |
| `site-api.md` | any server route or backend code |
| `background-jobs.md` | anything that happens later, on a schedule, with retries: reminders, follow-ups, summaries, cleanups |
| `files.md` | anything that stores a file a person picks (photos, documents, attachments, avatars, audio, video) or shows one back |
| `publishing.md` | git, scripts, dependencies, config, the Preview, going live |
| `payments.md` | anything sold: a Buy or Subscribe button, a price, checkout, a membership or paid page, orders, refunds |
| `plans-catalogue.md` | the platform's plans an owner resells (sign-up links to their studio), not the site's own products; their real plans: `npm run platform -- plans --write` |

**Selling anything → `payments.md`**: built in (Buy / Subscribe buttons, checkout, memberships,
orders in the Site Database), always sandbox while you build; use it by default, never a
third-party checkout script or a hard-coded amount.

## Architecture: one Worker, Hono is the backend
```
browser ──► Astro page (the view) ──in-process──► Hono /site-api ──► Site Database / platform API
browser ──► /dashboard (React SPA) ──── fetch ─────► Hono /site-api
```
- **Hono (`src/server/app.ts`, `src/server/routes/*`) is the ONLY backend.** Validation,
  guards, database and platform calls live in Site API routes. Pages only render.
- **Pages call it in-process** with `backend(Astro.request)` / `pageContext()` (`src/server/`).
- **`src/platform/` is the MANAGED core** (config, platform client, guards, the whole auth
  system in `src/platform/auth/`, browser helpers, sanitizer). Never edit it:
  `npm run platform -- upgrade` replaces it (that is how security fixes reach this site).
  `docs/agent/` is managed the same way. Your code: `src/server/`, `src/pages/`, `src/portal/`,
  `src/content/`, `src/lib/`, `src/styles/`, `prisma/`.
- **One Worker, one build, one deploy.** No second Worker, no KV/R2/D1/queues/Durable Objects.
  Later and scheduled work is the platform's background jobs (`background-jobs.md`): handlers in
  `src/server/background.ts`, schedules in `background.json`, `sendJob()` to send. A cache is the
  platform's Site Cache (`cache.md`, `cache.getOrSet` from `src/platform/cache.ts`), never your own.

| Path | What | Code |
| --- | --- | --- |
| `/`, `/about/` | marketing (STATIC) | `src/pages/index.astro`, `about.astro` |
| `/blog/`, `/blog/<slug>/` | the blog: Markdown files, prerendered | `src/content/blog/*.md`, `src/pages/blog/`, `src/content.config.ts` |
| `/jobs/`, `/jobs/<slug>/` | job board (SSR, Site Database) | `src/pages/jobs/` |
| `/account/*` | login, register, forgot, reset, verify (STATIC + script) | `src/pages/account/` |
| `/dashboard/*` | signed-in dashboard: account, users, roles, activity, jobs (SPA) | `src/portal/` |
| `/portal/*` | the dashboard's old address: redirects to `/dashboard/*` with its query (the platform's one-click sign-in opens it); keep it | `src/pages/portal/[...path].astro` |
| `/site-api/*` | the backend | `src/server/`, `src/platform/auth/` |
| `/sitemap.xml` | public pages, posts, open jobs (SSR, cached 1 h) | `src/pages/sitemap.xml.ts` |
| `/robots.txt`, `/rss.xml` | crawler rules, the blog feed (STATIC) | `src/pages/robots.txt.ts`, `rss.xml.ts` |
| — | error pages: any miss (404), a page that failed on the server (500) | `src/pages/404.astro`, `500.astro` |
| — | `<head>` SEO (title, description, canonical, Open Graph, Twitter), header, footer | `src/layouts/Base.astro`, `src/lib/seo.ts` |

Public page URLs END WITH `/` (`/about/`, `/blog/<slug>/`, `/jobs/`): prerendered pages are
served there (`/about` costs a redirect), and the canonical URLs and sitemap use that form.
Link with the slash.

Never create pages under `{{API_PREFIX}}` (the platform's) and never add `/login`, `/register`, `/forgot`,
`/reset`, `/verify-email` at the root: sign-in pages live under `/account/`.

## Environment
Read ONLY through `config` (`src/platform/config.ts`), server code only. Names are the platform's
contract: you cannot rename or add them, and you cannot add secrets (never ask for one).

| `config.` | Platform name | What |
| --- | --- | --- |
| `siteUrl` | `{{SITE_URL_ENV}}` | the site's own address, where the platform answers `{{API_PREFIX}}/*` (`{{SITE_ORIGIN_PATTERN}}` or its custom domain; plain var) |
| `preview` | `SITE_PREVIEW` | `1` only in the editor Preview |
| `databaseUrl` | `DATABASE_URL` | the Site Database (Preview Database in the editor) — secret |
| `jwtSecret` | `JWT_SECRET` | signs access tokens, keys rate-limit hashes — secret |
| `ownerSecret('NAME')` | an owner-added secret | another service's API key the owner added (a payment provider, mail, SMS, AI…: `security.md` › Calling other services); `null` when not added |
| `siteKey` | `{{SITE_KEY_ENV}}` | the Site Key (`{{SITE_KEY_PREFIX}}…`) for `{{SITE_API_PREFIX}}/*` (relayed emails) — secret |

- No `DATABASE_URL` → routes answer 503 `site_database_disabled`; no `JWT_SECRET` → auth answers
  503 `auth_not_configured`. Tell the owner; don't work around it.
- Deployed server code may call public APIs (webhooks out, mail, SMS, a payment provider, AI…)
  with `fetch`, keys only from `config.ownerSecret` (`security.md` › Calling other services).
  The platform's internal network is never reachable (IP addresses, private names:
  `403 Egress blocked`). No raw TCP, no outgoing WebSockets, no native modules. Account emails,
  files, jobs and payments are built in (`site-api.md`, `payments.md`): prefer them.
- Never send a secret to the browser, log it, write it to a file (`.env`, `.dev.vars`) or commit it.

## Auth in one paragraph (details: `auth.md`)
Site-owned: `users` + PBKDF2-SHA256 (600k) passwords, a 10-minute HS256 access JWT and a rotating
opaque refresh token in `__Host-` HttpOnly Secure SameSite=Lax cookies, CSRF double-submit,
rate limits in `login_attempts`, account emails relayed by the platform. In a route:
`validator → withViewer → requireAuth → requirePermission('site:x:y') → withDb`; the user is
`c.var.viewer.id`. In a page: `pageContext()` → `viewer.state === 'user'` (gated:
`pagePermission()`). In the browser: `siteFetch()` or the portal's `api`, never a plain
`fetch` (in the editor Preview the session travels only through them: `publishing.md`). Never
write login, token, cookie, password or two-step code yourself. The admin ALREADY EXISTS: the
platform makes the owner addresses' accounts (`SITE_OWNER_EMAILS`, live and Preview) with the
`owner` role and no password; never create, seed or change it. The admin signs in at `/dashboard`
with a 6-digit code emailed to them, or in one click from the dashboard ("Open live portal" on the
app's page, the shield in the Preview's bar); a password and two-step sign-in are optional, set
in the portal, and other admins are made in its Users screen. Say exactly that when they ask how
to reach the admin, and put the app's admin screens inside `/dashboard`.

## Which kind of page (decide FIRST, every time)
| The page is… | Build it as |
| --- | --- |
| Signed-in and interactive: dashboard, CRM, admin, settings, any form-driven screen | **SPA**: a screen in `/dashboard` (`src/portal/screens/`) |
| Public content indexed or shared per URL: a list, search results, a detail page | **SSR**: `src/pages/<name>/*.astro` |
| Public content that rarely changes: home, about, pricing; forms that only post to the API | **Static**: `export const prerender = true` |
- NEVER build a signed-in app as one `.astro` page per screen (full reloads, flashes, repeated
  session lookups). An app is ONE catch-all page hosting React; screens are client routes.
- NEVER move a public or SEO page into the portal. Public pages stay real pages with plain
  `<a href>`, navigated CLIENT-SIDE by `<ClientRouter />` (in `Base.astro`, keep it) and made
  instant by prefetch (`data-astro-prefetch` on links to PRERENDERED pages only). A `<script>`
  on a public page runs ONCE per visit: put its work in `document.addEventListener(
  'astro:page-load', () => { … })`, return early when the page's own element is missing, and
  keep `history.state` when you `replaceState` (`performance.md`).
- Inside the portal: TanStack Router `<Link>` (never a plain `<a href>` to a portal path: it
  reloads the app), `navigate()` after a save, invalidate the query.
- Never put visitor data in a static page's HTML: it is one file served to everyone. Fill it in
  the browser (`data-user-only`, `data-guest-only`, `data-live` sections built with `textContent`).

## A dashboard looks like a dashboard (`ui.md`)
The dashboard ships finished: shell, overview, users, roles, activity, jobs and account, all
built from ONE UI kit in `src/portal/ui/` (`import {Button, Card, DataTable} from '../ui'`).
Build every screen from the kit; see it live at `/dashboard/components` in the Preview.
- The shell (`src/portal/routes.tsx`): `App.astro` layout (full height, no site header/footer,
  `noindex`); a sidebar with the site's logo, grouped nav with icons, admin items hidden by
  `abilities`, "Back to the website"; a top bar with the screen title (the only `<h1>`), the
  theme menu and the user menu; a drawer with a scrim on small screens. After each navigation
  the shell sets the tab title from the route's `staticData.title` and moves focus to that
  `<h1>`; keep both. Toasts (`useToast`) and confirmations (`useConfirm`) are mounted there.
- Overview first: `Stat` tiles (cheap numbers only: `pageCount` "25+", never `count()`), then
  what needs doing and recent activity with "View all".
- Every screen: `PageHeader` (h2, description, ONE primary action), `Card`s, `DataTable`s, and
  all three states: loading, empty (`EmptyState` with its action), error.
- Create / edit in a `Drawer`, destructive actions in a row `Menu` + `useConfirm`, results as a
  toast. Never `window.confirm` / `alert`.
- Look: tokens in `src/styles/global.css` (rebrand with `--accent`, light + dark), classes in
  `src/styles/app.css`. No hex in screens, no `style={}` (CSP), no second UI kit, no coloured
  stripe on one side of anything.
- Never in an app: hero sections, marketing copy, the website nav/footer, a centered narrow column.

## Buttons and forms (NON-NEGOTIABLE, every page, every time)
Reference: `src/portal/ui/` (`Button`, `Field`, `useForm`, `useConfirm`; `ui.md`), `src/lib/rules.ts` (shared rules),
`src/lib/form.ts` (`bindForm` for `.astro` pages, used by `/account/*`).

**Buttons**
- Pending while its action runs: spinner + present-tense label ("Saving…"), `aria-busy="true"`,
  `disabled` (a second click never sends twice). React: `<Button pending pendingLabel="Saving…">`.
- Disabled when it cannot act, visibly (`cursor: not-allowed`). Never a button that does nothing.
- Per row: only the acted-on row shows pending; its other buttons are disabled (`busyId`).
- Done: result in place (row updated, toast, message); failure: the error next to the action,
  in words, button usable again. Never stuck pending.
- Destructive actions: `danger` variant + confirmation. `type="button"` unless it submits.
  Visible focus ring; icon-only buttons have `aria-label`.

**Fields**
- `noValidate` / `novalidate` on every form; never browser bubbles (`required`, `pattern` popups).
- Every field has a visible `<label>`; placeholders are examples, never labels.
- Errors under the field, in words that say how to fix it, with `aria-invalid` +
  `aria-describedby`; border `--danger`. Shown on blur or submit, then live while typing.
- Submit validates all, shows all errors, focuses the first wrong field, sends nothing until
  valid; the submit button is pending, Cancel disabled.
- Client rules mirror the server's validation exactly; server field errors (`422 fields`) land on
  their fields; other errors in the form's status line. Never `alert()`, never clear input on error.
- Every password field (sign-in, sign-up, reset, current password, confirmations) has a show / hide
  button, hidden by default: `.pw-input` + `<button class="pw-reveal" data-reveal-password>` with
  `bindPasswordReveal()` on `.astro` pages, `PasswordInput` in the portal. Never a bare password input.

## Machine limits: never overload the editor (NON-NEGOTIABLE)
You share the editor sandbox with the Preview dev server the owner is watching; its CPU and
memory change. Read them (`nproc`, `free -m`, `cat /sys/fs/cgroup/memory.max`) at the start and
before heavy work; stop and clean up when available memory is under ~15% or load stays above the
CPU count. ONE dev server ever (the editor's; never start `astro dev`, `vite`, `npm run preview`).
Kill what you start; no watchers (`vitest run`, not watch). One heavy command at a time
(`npm install`, `npm run build`, `prisma generate`, tests). Bound every command (no `find /`, no
grep over `node_modules`). Every dependency is a cost: never a second UI kit, date or state library.

The deployed Worker has limits too (128 MB, short CPU): bounded queries, keyset paging, no
whole-table loops, nothing big in module memory (`performance.md`).

## Recipes (details in the topic docs)
- **A Site API route**: `site-api.md` (guards in order, validator, explicit select, keyset page).
- **A portal screen** (all of it, every time; `ui.md` has the full example): its reads as `queryOptions` /
  `infiniteQueryOptions` in `src/portal/queries.ts` (`api.<route>`; `useInfiniteQuery` for
  lists); the component in `src/portal/screens/<name>.tsx` using them and the kit (`../ui`); in
  `src/portal/routes.tsx` a `createRoute` with a literal path, `staticData: {title}`, a
  `loader` warming those queries (`queryClient.ensureQueryData`) and the component lazy
  (`lazyRouteComponent(() => import('./screens/<name>'), 'Name')`), plus `routeTree` and a
  `NAV_GROUPS` item with its `icon`; gated: an `ability` on its
  catalogue entry (`/me` and `Abilities` follow).
- **An admin-only feature**: ONE entry in `CATALOGUE` (`src/server/permissions.ts`: codename,
  title, group, `ability`, default `roles`; no migration), routes behind
  `requirePermission(PERMISSIONS.X)` (own records: `can`), nav item `ability: '<ability>'`
  (`roles-and-permissions.md`). Never gate on a role slug.
- **A server-rendered list + detail** (data in the Site Database, like `/jobs`): data route
  first; `src/pages/<name>/index.astro` reads the query string and calls `api` through
  `pageContext`; search is a GET `<form>`; detail sets `Astro.response.status = 404` +
  `<NotFound>` when the route answered 404, and 503 + a "not available" message when the read
  failed (a database outage is never a 404), as `src/pages/jobs/[slug].astro` does; HTML from
  outside the repo only via `sanitizeHtml`.
- **A blog post: add a Markdown file** `src/content/blog/<slug>.md` (the file name is the URL;
  never rename a published one). Front matter, checked at build by `src/content.config.ts`:
  `title`, `description`, `publishedAt` (required); `author`, `cover` (PREFERRED a file in
  `src/assets/blog/`, `cover: ../../assets/blog/x.jpg`, optimised at build; or `/images/…` in
  `public/`, or https; 1200×630), `coverAlt`, `tags`, `updatedAt`, `draft: true` (dev only).
  Headings from `##`. It goes live with the next Publish, with the list, the RSS feed, the
  sitemap and the home page's "latest". There is no blog/CMS API: never fetch posts. Markdown is
  trusted repo content: never paste untrusted HTML.
- **A static page**: `src/pages/<name>.astro` with `prerender = true`, `staticContext()`,
  `<Base isStatic title description>`; words in `src/content/site.ts`; add it to `NAV`. It is in
  the sitemap automatically (`seo.md`).
- **A collection of content in the repo** (team, FAQ, services): a content collection in
  `src/content.config.ts` like `blog` (`glob()` for Markdown, `file()` for one JSON/YAML file)
  with a strict schema, read with `getCollection()` in a prerendered page. Create the data file
  FIRST, then the collection: one added while the Preview runs, before its file exists, stays
  empty there until the dev server restarts. Content the OWNER edits on the live site (without a
  Publish) is not a collection: it is a table (next item).
- **A new table (model)**: `database.md` (schema with `@@map`, lengths and an `@@index` per
  query shape, `migrate dev --create-only`, BEGIN/COMMIT, `migrate dev`, then
  `npx prisma generate`), then a Site API route (`site-api.md`), then the page or portal screen
  that calls it.
- **A file upload** (photos, documents, attachments): `files.md`. Your route asks
  `createUpload()` (`src/platform/files.ts`), the browser sends the bytes with `putFile()`, your
  route confirms with `completeUpload()` and keeps the file id in your own table. Private by
  default; show files through your route (it checks access, then redirects to a short link).
- **Something to sell** (a product, a booking fee, a membership): `payments.md`. Create the
  sandbox price (`npm run platform -- prices add …`), put `<BuyButton price="<key>" />` on the
  page, record what was bought in `src/server/payments-hooks.ts`, gate member pages with
  `requireMembership` / `pageMembership`.
- **Something later or on a timetable** (a reminder before a booking, a daily email, a
  cleanup): `background-jobs.md`. A handler in `src/server/background.ts`, `sendJob()` from the
  route (with a `key`), a schedule in `background.json`, `npm run platform -- jobs` to check.
- **An image**: the file in `src/assets/`, rendered with `Cover` (`src/components/Cover.astro`)
  or `<Picture>` from `astro:assets` in a PRERENDERED page (optimised at build). Images in SSR
  pages and the portal are served as they are: commit them resized, or use the CDN's sizing.
- **A separate app at its own path** (`/crm`) only when asked: ONE host page
  `src/pages/crm/[...path].astro` copied from the portal's, its own router with
  `basepath: '/crm'`, the portal's shell and UI kit.

## Production rules
- Visitor data only in the request scope; module memory only for small public caches.
- Every platform call has a timeout and every page a fallback for `null`.
- **Queries: no N+1, ever.** One query per read (nested `select`, one join with `relationJoins`; an
  aggregate or several tables as ONE tagged `$queryRaw`), never a query inside a loop; independent
  reads in `Promise.all`; at most ~5 sequential round trips per request (`database.md`,
  `performance.md`).
- **Raw SQL only as a prepared statement**: the tagged `` $queryRaw`…${value}…` `` / `Prisma.sql` /
  `Prisma.join`; never `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw(input)` or SQL built
  from strings. Names (columns, sort) only from a fixed map.
- **Every route is authorized on the server**: a permission guard, the owner/team IN the query's
  `where` (not checked after loading), not found → 404, fields set field by field, output through
  `select`; and an integration test that another user gets 404 (`roles-and-permissions.md`).
- Webhook and payment handlers are idempotent; outside calls have a timeout; slow work goes to a
  background job; anything public and costly is rate limited (`security.md`).
- Read-heavy data that changes rarely (settings, hours, menus, categories, product cards, page text)
  goes through `cache.getOrSet(key, ttl, load)` with a TTL you CHOOSE from the data (required, 1 minute
  to 7 days: long when a route clears it on change, short when nothing does; `cache.md` "How long to
  keep it"), and every route that saves it calls `cache.del` / `delPrefix` right after the write.
  Never cache sessions, permissions, carts, or the prices a quote or order charges.
- Keep `@astrojs/cloudflare` 14.x, npm + committed `package-lock.json`, no wrangler config,
  `imageService: 'compile'` (build-time only; never a runtime transform), `session: false`,
  `security.csp` on, `public/_headers` in step with `src/platform/headers.ts`.
- Before saying a task is done: `npm run build` and `npm test` pass (integration tests too when
  `TEST_DATABASE_URL` is available: `database.md`); the Preview shows it;
  `security.md`'s checklist holds.

## Never
- **Send a password, in ANY form, to ANYONE, the user included**: not plain, hashed (`passwordHash`),
  encrypted or masked; not in a response, an email ("your password is…"), a page, a log, the cache,
  an export, an error or an outside service. A forgotten password gets a reset link, never the
  password. The same for sign-in codes, tokens, recovery codes and secrets once issued.
- **Send another person's email address anywhere others can see it.** An email is treasure: it
  leaves the server ONLY to its own owner, or to a signed-in admin whose permission the server
  checked (`site:user:read`). Never in a public page or API, a list, a search result, a comment or
  author line, an error ("that email is taken by…"), a URL, a log, analytics, a cache key or value
  others can read, or an outside service the person didn't ask for. Show a name instead; if a
  person must recognise an address, mask it (`m•••@gmail.com`). Never copy emails into your own
  tables (join on `users.id`).
- Edit `src/platform/**` or `docs/agent/**` (managed), weaken a guard, `sameOrigin`, `csrf`,
  the rate limits, the cookie flags or the CSP, or write auth, token, cookie or password code.
- Put a secret in code, a file, a log, the browser or git; read `env` outside `config`; ask for
  a secret's value; call another service with a key from anywhere but `config.ownerSecret`, or
  send it a user's data the feature doesn't need.
- Trust input: every route validates type, length and format with `hono/validator`; no
  `data: body` spreads, no ids, roles or owners from the client.
- `$queryRawUnsafe`, string-built SQL, `set:html`/`innerHTML` with data, `style=""` attributes
  or inline handlers (the CSP blocks them), `target="_blank"` without `rel="noopener noreferrer"`.
- Unbounded or un-indexed queries, offset paging, `count()` per request, a query per row,
  awaiting independent reads one after the other.
- `Cache-Control: public` on anything that read the visitor (`pageContext`, `withViewer`).
- `setTimeout`/`setInterval` for later work, or a page someone must visit to run it: send a job.
- A signed-in app as one `.astro` page per screen, a second UI kit, a second lockfile.

## How changes go live
You edit a working copy; the OWNER publishes from the editor: Prepare → Build (`npm ci`,
`npm run build`) → Migrate → Deploy (`publishing.md`). Keep `npm run dev` working at `/`.
