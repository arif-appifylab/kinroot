# Changelog

Template releases. `npm run platform -- check` says when a newer one is out;
`npm run platform -- upgrade` applies it (see `scripts/platform.mjs`).
Managed by the template: replaced on upgrade.

## 0.10.10

- **Passwords and email addresses (owner's rule).** A password never leaves the server in any form
  (plain, hashed, encrypted, masked), not even to its own user; resets are by link. Another person's
  email reaches only its owner or a permission-checked admin screen; everywhere else a name or a
  masked `m•••@domain`. In `AGENTS.md` (Never), `security.md` and `review.md`. The managed admin API
  now does it: other admins see `m•••@domain`, and only the site owner can look people up by email.

- **Every task ends with a review.** New `docs/agent/review.md`, run like a skill after every task that
  touched server code or data: authorization first (route by route, owner in the query, 404 for
  another user's id, a test that proves it), injection and input, secrets and abuse, then performance
  (round trips per request, no N+1, parallel reads, cache), ending with a short report. `AGENTS.md`
  makes it rule 6 of every task.
- **One query per read.** `relationJoins` is on in `prisma/schema.prisma` (a nested `select` is one
  SQL join); `database.md` says how an older site turns it on, and to use ONE tagged `$queryRaw` for
  aggregates. Raw SQL only as prepared statements (tagged `$queryRaw` / `Prisma.sql` / `Prisma.join`).
  `performance.md`: at most ~5 sequential round trips per request, no `await` in a loop,
  `Promise.all` for independent reads.

- **Site Cache TTL is required and can be up to 7 days** (1 minute to 7 days). `cache.md` "How long to
  keep it" tells the AI how to choose: long (1–7 days) when a route clears the key on change, short
  (1–60 minutes) when nothing does. An expired value is served for at most 1 minute while one request
  refreshes it. A full cache drops the entries closest to expiring instead of refusing new ones.

- **Site Cache.** A request told to load a missing key that stores nothing (no result, a value the
  cache can't keep, a failed load) now lets the waiting requests go at once instead of after ~300 ms.
  Keys accept long slugs, SKUs, UUIDs and cuid-style ids (only token-shaped parts are refused). The
  fallback in `docs/agent/cache.md` for sites without `src/platform/cache.ts` saves through
  `waitUntil` (it never saved before) and clears a large prefix completely.

## 0.10.9

- **Site Cache.** `src/platform/cache.ts`: `cache.getOrSet(key, ttl, load)`, `get`, `set`, `del`,
  `delPrefix` and `userKey` over the platform's per-site cache (a few ms a read, against ~100–150 ms
  a query). Preview and local use an in-memory stand-in; an outage or a full cache is a miss, never an
  error. `docs/agent/cache.md` says what to cache, the keys and TTLs, what never to cache, and how to
  clear in the route that saves; `AGENTS.md` and `performance.md` point to it. The owner and the
  platform's staff can open cached values, so sign-in secrets (password, token, session, JWT…) are
  refused by the cache.
- **Site Cache hardened.** `getOrSet` serves a just-expired value while one request reloads it,
  waits for a key another request is loading, saves after the answer and never breaks a page (bad
  keys, BigInt, outages; a breaker skips the cache after 3 failures). `del` / `delPrefix` report
  whether they worked and retry. Keys are ids and slugs only (no `@`). The Preview refuses what
  production refuses (`src/platform/cache-guard.ts`). Deleting an account clears that user's keys.
  `cache.md`: shared keys hold only what every visitor sees; dates come back as strings.

## 0.10.8

- **Every task starts from the current rules.** `AGENTS.md` tells the AI to re-read the platform's
  current rules and the topic doc before each task, build what the owner asked by them, and bring code
  the task touches up to a newer rule when it matters (security, data, a broken or slow page).
- **Topic docs: the current copy first.** `AGENTS.md` points the AI to the platform's current topic
  docs (the editor's docs folder, else the site's live docs address) before this repo's
  `docs/agent/`, which is only as new as the site's last upgrade.

## 0.10.7

- **Currencies from the owner's payment providers.** `npm run platform -- prices currencies` lists
  the currencies a new price may use (and which only take one-time payments). A price in another
  currency is refused (422 `E_SITE_PAYMENTS_CURRENCY_NOT_TAKEN`); `docs/agent/payments.md` says to
  check first, and to ask the owner when no provider is connected yet.

## 0.10.6

- **Free trials need the buyer's email.** A price with a free trial starts on the payment
  provider's own page, and the checkout must name the buyer: send `email` (a signed-in buyer's
  is sent for you). Without it the checkout answers 422 `E_SITE_PAYMENTS_EMAIL_REQUIRED`.
  `CheckoutRequest` takes `email`; `docs/agent/payments.md` says so.

## 0.10.5

- **Real plans while you build.** `npm run platform -- plans` shows the owner's client plans
  (their own website only), and `--write` saves them to `src/content/plans.json`, so a pricing
  section's fallback holds the real plans in the Preview too. `docs/agent/plans-catalogue.md`
  says to run it first and never invent plans.

## 0.10.4

- **Price minimums.** A paid price must be at least the currency's minimum (1 USD, 10,000 IDR,
  100 JPY…; 422 `E_PRICE_BELOW_MINIMUM`) and whole in IDR and ISK (422 `E_PRICE_NOT_WHOLE`).
  `docs/agent/payments.md` says so.

## 0.10.3

- **Every payment opens without leaving your site.** The checkout's `embedded` answer now has a
  `kind`: `element` (the provider's form on the page, Stripe), `popup` (the provider's popup over
  the page, Razorpay: closed, Pay opens the same one again) or `window` (the provider's page in a
  small payment window, Xendit and PayPal: the page waits, checks the checkout and goes to the
  thanks page once paid). `embedded` is always there; the old `checkoutUrl` redirect is gone.
  `Base.astro` calls `notifyPaymentOpener()` so a return page loaded inside the payment window
  hands back and closes.
- **One checkout session.** `src/lib/checkout-session.ts` (`CheckoutSession`: `load()`,
  `selectGateway()`, `continue()`, `subscribe()`; and `openCheckout(result, {onDismiss})`) drives
  the checkout island over the site's own routes (`src/lib/checkout-transport.ts`); the same file
  ships in the static template. Tested in `tests/checkout-session.test.ts`.
- **A pricing section.** `<PriceList />` (`src/components/payments/PriceList.astro`) shows the
  catalogue's prices with a Buy / Subscribe button each, or "Coming soon" while the site can't
  take payments. `docs/agent/payments.md` › Selling, in three steps.
- **The buyer chooses how to pay.** With more than one payment provider that takes the price,
  `/checkout/?price=…` lists them (`listGateways()`, `GET /site-api/checkout/gateways`) and posts
  the choice as `gateway`. A buyer who already had the free trial is asked to continue without it
  (`noTrial`, 409 `E_SITE_PAYMENTS_TRIAL_USED`).

## 0.10.2

- **The payment form on your page is now the usual checkout.** The platform answers `embedded`
  for every site whose gateway takes inline payments (Stripe, Razorpay), not only sites on an
  agency's own domain; the Buy button already sends those to `/checkout/?id=…`. Xendit and PayPal
  still open the provider's own page. A gateway the form has no driver for shows a clear message
  instead of a blank form. Docs and one message: no change to your code.
- **Plans that can't be bought yet show "Coming soon".** The live plans answer has
  `checkoutOpen` (and `opensLaterReason`): while it is `false`, a pricing section shows paid
  plans with a "Coming soon" state instead of a Start link; free plans keep theirs.
  `docs/agent/plans-catalogue.md` › Not open yet. Docs only: no change to your code.

## 0.10.1

- **Calling other services.** Deployed server code may now call public APIs (a payment provider,
  mail, SMS, AI, a webhook out) with keys the owner adds as site secrets
  (`config.ownerSecret('NAME')`); the platform's internal network stays unreachable. Rules and a
  checklist: `docs/agent/security.md` › Calling other services; inbound webhooks verify the
  sender's signature (A08). Docs and comments only: no code change.

## 0.10.0

- **Payments, built in.** Sell anything with `<BuyButton price="<key>" />`
  (`src/components/payments/`): one-time purchases and subscriptions, a hosted checkout or, for
  sites on an agency's own domain, an embedded payment form (`EmbeddedCheckout`, its gateway's
  hosts added to that one page's CSP). Prices live in the site's catalogue and are referenced by
  key, never by amount; `npm run platform -- prices` lists them and `prices add` creates sandbox
  ones from the editor. Everything outside the live site is sandbox; the live site switches to
  real payments by itself when the owner connects a live gateway (`TestModeBadge` until then).
  Guide: `docs/agent/payments.md`.
- **Orders and memberships in the Site Database.** A new migration adds `orders`, `memberships`
  and `payment_events` (`// payments (MANAGED)` in `prisma/schema.prisma`). The platform's signed
  payment events arrive at `/site-api/_platform/payments` (`src/platform/payments.ts`, same
  signature as job deliveries, each event handled once) and call your hooks in
  `src/server/payments-hooks.ts`, which record them by default. `/thanks/` confirms a payment
  itself, so it works in the Preview too.
- **Members-only content**: `requireMembership([...keys])` for routes and `pageMembership()` for
  on-demand pages (`src/server/memberships.ts`); `GET /site-api/memberships` and
  `POST /site-api/memberships/:id/cancel` for a member's own screen.
- **Site API:** `POST /site-api/checkout` (also a plain form post without JavaScript, guarded by
  the new `formCsrf`) and `GET /site-api/checkout/:id`. Run `npm install` (adds
  `@stripe/stripe-js`) and apply the migration.
- `config.ownerSecret(NAME)` reads a secret the owner added, for a direct customer's own payment
  provider (`payments.md` "Your own provider instead").

## 0.9.0

- **A finished admin dashboard, on its own UI kit.** `src/portal/ui/` is the kit every screen is
  built from: `PageHeader`, `Card`, `SettingRow`, `Stat`, `DataTable` + `LoadMore`, `Badge`,
  `StatusBadge`, `Person`, `Avatar`, `Button`, `IconButton`, `Menu`, `Modal`, `Drawer`,
  `useConfirm()`, `useToast()`, `Tabs`, `SegmentedControl`, form controls (`Field`, `useForm`,
  `Select`, `Checkbox`, `Switch`, `RadioCards`, `SearchInput`, `PasswordInput`), `Notice`,
  `EmptyState`, skeletons, `Sparkline`, `BarChart`, `ProgressBar` and 47 inline icons. The
  shell has the site's logo, icons in the nav, a theme menu (light, dark, device) and a user
  menu; the overview has a setup checklist; users, roles, activity, jobs and account are
  rebuilt on the kit. `/dashboard/components` shows every piece in the Preview (dev only).
  Rules: `docs/agent/ui.md`. `src/portal/ui.tsx` is now the folder `src/portal/ui/` (same
  imports, `from '../ui'`); `Avatar`, `ErrorNote` and `Stat` moved there from `shared.tsx`.
- **The dashboard is at `/dashboard`.** `/portal/*` redirects there with its query string, so
  the dashboard's one-click owner sign-in, old links and bookmarks keep working. The folder stays
  `src/portal/`.
- **One set of design tokens** in `src/styles/global.css` for the website and the dashboard,
  light and dark, with `data-theme` to force one: rebrand with `--accent`. The dashboard's
  styles moved to `src/styles/app.css`, loaded only by `App.astro`.
- **A new home page**: split hero with a product picture, features, how it works, the blog,
  live open roles, FAQ and a closing call to action; a cleaner header and footer.
- **Production guides**: `security.md` maps the OWASP Top 10 (2025) and the API Security Top 10
  onto this app; `roles-and-permissions.md` covers deny by default, row-level and team
  scoping, field rules and escalation; `database.md` covers column types, constraints,
  indexes, safe migrations and deletion; `performance.md` covers Worker budgets, caching,
  bundle size and Core Web Vitals.
- **Admin API:** `GET /site-api/admin/roles` gives each role `members` (`{count, more}`: up to
  100, one bounded query for all roles); `GET /site-api/admin/audit` names the person acted on
  (`targetName`). The Users screen can turn off a user's two-step sign-in (lost phone).

## 0.8.2

- **The site builds again.** Four password fields in the portal's account screen
  (`src/portal/screens/account.tsx`) had escaped quotes (`field(\'password\')`) that stopped
  `npm run build`. They are plain quotes again.
- **Integration tests, step by step.** The README now says how to start a throwaway Postgres,
  migrate it and point `TEST_DATABASE_URL` at it.

## 0.8.1

- **A previous owner loses `owner` at once.** When a deploy changes the owner list (the site
  changed hands), the account holding the owner seat with an address no longer on the list loses
  `owner` on the first signed-in request after it, without waiting for the new owner to sign in
  (`src/platform/auth/owner-seat.ts`). Its account and other roles stay; the seat is free for the
  next owner address. Owners you added by hand in Users are not touched: review them.

## 0.8.0

- **File storage.** Photos, documents, audio and video people upload, kept by the platform
  (`docs/agent/files.md`). Server helpers in `src/platform/files.ts` (`createUpload`,
  `completeUpload`, `fileUrl`, `deleteFile`, `listFiles`, `storageUsage`, `publicFileUrl`), the
  browser's `putFile` in `src/platform/files-browser.ts`. Uploads go to a one-time path on the
  site's own address, so the CSP is unchanged for them; the owner adds a storage pack and turns it on in the
  dashboard. In the editor Preview and on your machine the middleware hands `/__platform/files/*`
  to the platform.
- **Audio and video from https.** The CSP now has `media-src 'self' https: blob:` (stored files
  play from their signed links), like `img-src`.

## 0.7.0

- **Client navigation on public pages.** `<ClientRouter />` (Astro) in `Base.astro`: a click
  swaps the next page in without a reload (prefetched first), focus moves and the new title is
  announced; every page is still real server-rendered HTML. `/portal` has no router, so a link to
  it stays a full load. Page scripts now run on `astro:page-load` and return early on other
  pages: if you added a `<script>` of your own, do the same (`docs/agent/performance.md`
  "Scripts with the ClientRouter"), and keep `history.state` when you call `replaceState`.
- **Background jobs: times are to the minute.** A job due less than 60 s ahead runs now; the first
  retry waits 1 minute (then 2 min, 10 min, 1 h). A site may add 10 jobs a minute by default
  (`E_JOBS_RATE_LIMITED`, 429); a paused site's sends get `E_JOBS_PAUSED` (423)
  (`docs/agent/background-jobs.md`).


## 0.6.0

- **The admin signs in with an emailed code.** `/account/login/` now sends a 6-digit code first
  (10 minutes, one use); "Use a password instead" stays for accounts that set one. The site's
  owner addresses (`SITE_OWNER_EMAILS`) get their admin accounts made for them, with no password,
  before their first code: nobody needs to sign up. New table `sign_in_codes` (migration
  `20261026120000_sign_in_codes`, additive).
- **One click still asks for two-step sign-in.** "Open live portal" from the dashboard now goes to
  the authenticator code step when the admin turned two-step sign-in on (it used to skip it).
- **The portal opens signed in from the editor Preview.** `/portal/?owner_ticket=…` (the Preview's
  shield) signs the owner in with a fetch, since the Preview can't keep a page-load session.
- **Neutral platform names.** Nothing in the site's code, variables, headers or paths names the
  company that hosts it. Rename these in your own `.env` and code:
  `SITE_KEY` (was `EZYSTUDIO_SITE_KEY`), `SITE_URL`, `SITE_PREVIEW`, `SITE_OWNER_EMAILS`,
  `SITE_JOBS_SECRET` (each was `EZYSTUDIO_…`), `SITE_DIR` for `npm run platform`.
  Background jobs arrive at `POST /site-api/_platform/jobs`, signed in `x-site-signature`.
  Site Keys start `stk_`. Installed apps keep their records in `.platform/apps/`.

## 0.5.0

- **Sign-in works on the live site.** The session and CSRF cookies are now `__Host-site_at`,
  `__Host-site_rt` and `__Host-site_csrf` (`site_at`… on your machine). The old names were the
  platform's own, which the platform edge removes before a request reaches a site, so a deployed
  site saw every signed-in visitor as signed out.
- **Background jobs reach the live site.** Deliveries come to `POST /site-api/_platform/jobs`,
  signed in `x-site-signature` (was `/_ezy/jobs` and `x-platform-*`, which the edge also removed).
- Platform variables are the platform-only names: `SITE_URL`, `SITE_PREVIEW`,
  `SITE_OWNER_EMAILS` (were `EZY_*`). Rename them in your own `.env`.
- **One-click owner sign-in.** "Open admin" in the dashboard signs an owner address
  straight into `/portal` as owner, with no sign-up and no email (`GET /site-api/auth/owner`,
  `src/platform/auth/owner.ts`). The owner role now follows the owner list: when the account
  holding it is no longer an owner address, the next owner address to sign in takes it over and
  the old holder loses `owner`.
- **Two-step sign-in**: an authenticator app (TOTP, QR code) with 10 one-use recovery codes, set
  up in `/portal/account`. With it on, sign-in asks for the code after the password. Admins can
  switch it off for someone who lost their phone (Users).
- **Account**: change the email address (a link to the new address; the old one is told),
  signed-in devices (sign one out), and delete the account (not the last owner).
- **Roles**: a permission is ONE entry in `CATALOGUE` (`src/server/permissions.ts`): its row,
  default roles, `/me` ability and the `Abilities` type follow. `requirePermission(code, {orOwn})`
  and `can(c, code, {ownerId})` enforce "own records only"; `pagePermission()` gates an SSR page.
- **Instant navigation**: public pages prefetch on hover (nav links when visible) and use
  cross-document view transitions; the portal preloads a screen and its data on hover, caches
  reads for 30 s, code-splits every screen, restores scroll, and sets the tab title and focus
  per screen. JSON-LD: `WebSite`/`Organization`, `BlogPosting`, `JobPosting`.
- robots.txt only disallows `/site-api/`, so crawlers can read the `noindex` on account and
  portal pages.
- New migration `20261026090000_account_security` (additive: two-step columns, `email_changes`,
  `recovery_codes`). New dependency `uqr` (QR codes, no dependencies of its own).

## 0.4.2

- Sign-in, owner role: owner now goes only with a password chosen through an emailed link.
  Before, someone who registered the owner's address first (with their own password) became
  owner the moment the real owner clicked the confirmation mail. Now confirming an owner address
  drops the registered password, ends its sessions and emails a link to choose one; that link
  (or Forgot password) claims owner, so a squatter can no longer lock the owner out either. With
  `requireEmailVerification: false`, registering an owner address no longer makes anyone owner
  without proof. Signing up again on an unconfirmed address keeps neither sign-up's password and
  kills its older confirmation links; confirming the new link emails a link to choose the
  password, so whoever holds the inbox sets it (a late sign-up can no longer replace the real
  person's password, nor an early one keep the squatter's). Two sign-ups at the very same moment
  are handled the same way (the one that lost the race used to leave the other's password in place).
- Rate limits: each attempt takes a per-scope advisory lock, is recorded and then checked, so a
  burst of parallel requests gets exactly the allowance through (`takeAttempt()`; the
  `AttemptStore` interface gained `settle`, `discard` and an optional `exclusive`, and `record`
  answers the row id). A busy lock is tried, not waited on: a waiter gives its database connection
  back, retries for up to 2 seconds and is then refused like any rate-limited attempt, so a burst
  on one IP can't use up the Site Database's connections.
- Confirm email: when an owner address must choose its password first, the page points to the
  inbox instead of showing a Sign in link that could not work.
- Passwords: PBKDF2 at 600,000 iterations (was 210,000); older hashes re-hash at the next login.
- Sessions: "Sign out" on one device ends that device's access token at once (the session
  lookup also checks the sign-in is not revoked), not up to 10 minutes later.
- Forgot password and resend answer before looking the account up (no timing difference); a
  suspended account cannot confirm its email; two owners removing each other at once can no
  longer leave a site with no owner; a signed but malformed job delivery is a 400, not a 500.
- Background jobs, replay guard: with a Site Database, a delivery already taken (same job and
  try) is remembered in the new managed `job_deliveries` table, so a replayed copy runs nothing
  on any Worker instance, not only the one that took it (migration
  `20261023080001_job_deliveries`). Without a Site Database, or before the migration ran, it is
  still per instance. The guard uses raw SQL, so it works whether or not your client has the
  model.
- Upgrading: `prisma/schema.prisma` is yours. If `upgrade` lists it as differing, copy the
  `model JobDelivery { … @@map("job_deliveries") }` block from this release into it (next to
  the other managed models) BEFORE `npx prisma migrate dev`, then `npx prisma generate`.
  Without the model, `migrate dev` sees a table the schema does not have and proposes a
  migration that drops `job_deliveries`: never apply that one (delete it and add the model).

## 0.4.1

- Background jobs, safer delivery: a list named like a built-in (`constructor`, `tostring`) no
  longer finds a handler it never had; a delivery body over 64 KB is refused even without a
  `Content-Length`; on your machine and in the Preview a failed job says how many tries its
  list really has (`background.json` `retries`).
- Background jobs, secret replacement: a delivery may carry two signatures (`v1=…,v1=…`) while an
  owner's replaced jobs secret waits for the next publish; either one verifies. A copy of a
  delivery this Worker already took (same job and try) runs nothing.
- Docs (`docs/agent/background-jobs.md`): a `key` stays with a waiting job however far ahead it
  was sent (so `cancelJob` by key always reaches it); jobs at once per site by plan; at most 100
  lists per site (`E_JOBS_TOO_MANY_LISTS`); a later job does not hold its ordered group.

## 0.4.0

- Background jobs: do something later, on a schedule, with retries, run and watched by
  the platform (`docs/agent/background-jobs.md`). New managed `src/platform/background.ts`
  (`sendJob`, `sendJobs`, `cancelJob`, `defineBackground`, `DontRetry`); your handlers in
  `src/server/background.ts`; schedules and list settings in `background.json`;
  `npm run platform -- jobs` checks both. The platform delivers each job to
  `POST /site-api/_platform/jobs`, signed with the new platform secret `SITE_JOBS_SECRET`
  (`config.jobsSecret`); `src/pages/site-api/[...path].ts` answers it before the Site API. In the
  editor Preview and on your machine, jobs run locally, right away, with a log line.
- Ordered lists: `"ordered": true` in `background.json` + `sendJob(…, {group})` run one job at a
  time per group, in send order (`job.group` in the handler).
- Upgrading: `src/pages/site-api/[...path].ts`, `src/server/background.ts` and `background.json`
  are yours: add them as in this release if `upgrade` lists a conflict.

## 0.3.1

- Preview: sign-in works in the editor Preview. Its gateway drops every `Cookie` and
  `Set-Cookie` header, so every form there failed with "This form has expired". Now, in the
  Preview only (`SITE_PREVIEW=1`), the new `previewCookies` middleware (mounted first in
  `src/server/app.ts`; `src/platform/auth/preview-cookies.ts`) mirrors the auth cookies into
  `x-ezs-preview-set-cookie` and reads them back from `x-ezs-preview-cookie`.
  `src/platform/browser.ts` keeps them for the tab in `sessionStorage` and sends them on every
  `siteFetch`. CSRF, refresh rotation and sign-out work unchanged. The live site never sends or
  reads those headers: its cookies stay `__Host-`, HttpOnly and Secure.
- Preview: `/portal` starts the app even when the server sees no session (Preview only), and
  the portal shell sends a signed-out visitor to `/account/login/?next=…` (everywhere). On
  every page, `<Base>` fills the visitor in in the browser when the server could not see them.
  `useMe()` refreshes an expired session once instead of showing the portal signed out.
- Preview: `npm run build` no longer breaks the running Preview. The build rewrote the dev
  server's Vite dependency cache (`node_modules/.vite/deps_ssr`) under it and every page
  answered 500 until the dev server restarted. Builds now use their own cache
  (`node_modules/.vite-build`, a small integration in `astro.config.mjs`).
- Error pages: new `src/pages/500.astro`. A page that throws on the live site now shows a
  page (500, `noindex`, security headers) instead of an empty answer. It is left out of the
  sitemap.
- Jobs: a database outage is a 503 (`Retry-After: 60`, "not available right now"), no longer a
  404 that search engines drop: `/jobs/<slug>/` tells "missing" (404) from "could not read"
  (503), and `/jobs/` answers 503 with its notice. `/sitemap.xml` is cached 5 minutes instead of
  an hour when the jobs could not be read.
- Account emails link to the trailing-slash pages (`/account/verify/?token=`,
  `/account/reset/?token=`, `/account/login/`): no redirect. Old links still work.
- Local dev: `prisma.config.ts` reads `.env` when there is one (the Prisma CLI does not by
  itself), so `npx prisma migrate dev` works on your machine as the README says. Variables
  already set (the editor, the Build) win over the file.
- Agent docs: `database.md` adds `npx prisma generate` after `migrate dev` (Prisma 7 no longer
  runs it; the new model is `undefined` until then) and notes that `--create-only` applies
  pending migrations; `site-api.md` says what the notes recipe needs; `publishing.md` explains
  the Preview's header-carried cookies and that relayed email links open the LIVE site;
  `AGENTS.md` lists the error pages, the 503 rule for detail pages, the data-file-first rule for
  collections and `siteFetch()` over plain `fetch`.
- Tests: `tests/preview-cookies.test.ts` (unit) and `tests/integration/preview.test.ts`
  (register → verify → login → refresh → logout behind a cookie-dropping gateway; CSRF still
  enforced; the header ignored off the Preview). The harness's `Browser` takes
  `gateway: 'preview'`.

## 0.3.0

- Security: on the live site the owner role is claimed ONLY by an owner address: `ownerEmails`
  plus the new platform var `SITE_OWNER_EMAILS` (the account owner's email, set at each
  Publish; `config.ownerEmails`). With no owner address, nobody becomes owner (no first-sign-up
  claim): a warning is logged, `/site-api/health` answers `ownerSetup: false` and the portal
  overview shows a setup notice. Local dev and the editor Preview keep the first-account claim.
  New `ownerClaimMode()` / `ownerEmailsFor()` in the auth core; `config.production`.
- Security: `BrandMark` no longer uses `style=""` attributes, which the CSP blocked (a console
  error on every page and unsized marks); sizes are classes (`.brand-size-<n>`).
- SEO: `<Base>` writes a meta description on every page (default `SITE.description`, new in
  `src/content/site.ts` with `lang` and `url`), a canonical URL, `og:site_name`, `og:type`,
  `og:description`, `og:url`, absolute `og:image` (+ alt), Twitter card tags and, on posts,
  `article:*` times. The address comes from the new `src/lib/seo.ts` (`SITE.url`, else
  `config.siteUrl`). The 404 renders are `noindex`.
- New routes: `/sitemap.xml` (on request, `Cache-Control: public, max-age=3600`: public pages
  found automatically, posts, the newest 1000 open jobs via the new indexed
  `GET /site-api/jobs/sitemap`), `/robots.txt` (prerendered; disallows `/account/`, `/portal`,
  `/site-api/`) and `/rss.xml` (prerendered, 20 newest posts). `<head>` links the feed and the
  sitemap; the footer links the feed.
- URLs: public links end with `/` (`/about/`, `/blog/<slug>/`, `/jobs/`, `/account/login/`…),
  where prerendered pages are served, so a click no longer costs a 307 redirect; the
  `/account` redirect targets `/account/login/`.
- Performance: `/jobs` and `/jobs/<slug>` read the jobs in parallel with `pageContext()` (no
  waterfall). Blog covers may be files in `src/assets/` (now preferred), rendered by
  `src/components/Cover.astro` through `astro:assets` `<Picture>`; `imageService` is now
  `'compile'` (optimised at build for prerendered pages, passed through at runtime).
- Jobs: a slug taken meanwhile (unique violation) retries with a random suffix instead of
  failing; `manage` and `sitemap` are never job slugs.
- Accessibility: a "Skip to content" link and `<main id="main">` on every page, a focus ring on
  links, job titles are `<h2>` under the page's `<h1>`, a default `/favicon.svg`.
- Agent docs: new `seo.md`; `database.md` gains "Connections (serverless)" and FK-index rules;
  `performance.md` covers parallel page reads, caching headers and build-time images (Lighthouse
  target 95); `security.md` forbids `style=""`; `AGENTS.md` adds collection, model and image
  recipes and a "Never" list.

## 0.2.0

- Template source: `template.json` `repo` is now `file:templates/astro-app` (a folder in an
  the platform checkout; no published repository yet). `npm run platform -- check|upgrade` read it
  (`$SITE_DIR`, `--from DIR`; `--base DIR` for a 3-way merge), `owner/name` GitHub repos
  still work. `.wrangler/` and `.platform/` are never part of an upgrade.
- Agent docs: platform facts (the Site API and email endpoints, the Site Key's env name and
  prefix, the site's free address, email kinds and relay limits) are platform-filled
  placeholders, so they always match the platform that renders them. `auth.md` states the email
  relay limits.
- `.env.example`, `src/env.d.ts`, `src/platform/config.ts`: `SITE_URL` is the site's own
  address (no hard-coded host). Example job data is neutral.

## 0.1.0

First the platform release.

- A site stands alone: it owns its users, sign-in and data. Platform secrets `JWT_SECRET` and
  `SITE_KEY` (the Site Key); platform calls go to `SITE_URL`.
- Site-owned auth in the managed core (`src/platform/auth/`): users, roles, permissions,
  refresh-token families, password resets, email verifications, rate-limit ledger, audit log
  (migrations `20261019090100_site_auth`, `20261019090200_seed_roles`).
  - PBKDF2-SHA256 210k passwords (versioned hash strings, rehash on login), HS256 access tokens
    (10 min), opaque rotating refresh tokens with reuse detection, `session_version` revocation.
  - `__Host-` HttpOnly Secure SameSite=Lax cookies, same-origin guard + double-submit CSRF.
  - Rate limits with exponential backoff per email+IP, email and IP.
  - Account emails relayed by the platform (`POST /api/site/v1/emails`).
  - Seeded roles `owner`, `admin`, `member`; first confirmed account becomes owner
    (`ownerEmails` to restrict); anti-escalation in the admin API.
- Blog as an Astro content collection: Markdown in `src/content/blog/` (schema in
  `src/content.config.ts`), prerendered `/blog` and `/blog/<slug>`; the platform blog API and
  `/site-api/posts` are gone (the platform has no blog/CMS API).
- Pages `/account/login`, `/register`, `/forgot`, `/reset`, `/verify`; portal screens Account,
  Users, Roles, Activity (plus Jobs).
- No borrowed sessions, no members directory, no uploads (no site storage yet), no `notes`
  example table.
- Security headers on every response, Astro CSP with hashes, `public/_headers`, 64 KB body limit.
- `docs/agent/*.md`: auth, roles and permissions, security (OWASP Top 10), performance, database,
  Site API, publishing. Managed like `src/platform/`.
- Unit tests (`npm test`): password hashing, JWT, refresh rotation and reuse, rate limits,
  codenames, cookies, input. Integration tests (`TEST_DATABASE_URL=… npm test`): the real Site
  API on Postgres — register/verify/login, owner claim, enumeration, refresh rotation and reuse,
  logout/logout-all, forgot/reset, change password, rate limits, CSRF, admin anti-escalation.
- `getDb()` picks the driver by host: Prisma Postgres (`adapter-ppg`) or plain Postgres
  (`adapter-pg`, local stand-in and tests). Test-only Node client generator.
