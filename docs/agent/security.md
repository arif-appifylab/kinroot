---
title: Security: OWASP Top 10 on this stack
read-when: before any route, form, query, upload, HTML rendering, outbound call, secret, header, dependency or log line; and before telling the owner a feature is done
---
Defaults are secure; keep them. Below: the OWASP Top 10 (2025) and the OWASP API Security Top 10
items that matter here, each with what the template ALREADY does (keep it) and what YOUR new code
must do. The managed core (`src/platform/**`) is never edited: if a control you need is missing
there, say so to the owner (it ships with `npm run platform -- upgrade`).

## What every request already passes through
| Layer | Where | Does |
| --- | --- | --- |
| Request memo | `src/middleware.ts` → `inRequestScope` (`src/platform/request-scope.ts`) | viewer, access, DB client per request (AsyncLocalStorage), never shared |
| Security headers | `applySecurityHeaders` (`src/platform/headers.ts`); `public/_headers` for prerendered files | nosniff, Referrer-Policy, Permissions-Policy, COOP, `X-Frame-Options: DENY` (not in the Preview), HSTS on https |
| CSP | `security.csp` in `astro.config.mjs` | hashes for Astro's own scripts/styles; `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri`/`form-action 'self'` |
| Site API, app-wide | `src/server/app.ts` | `previewCookies` → `sameOrigin` → `csrf` → `bodyLimit` 64 KB → `syncPermissions`; JSON `notFound` / `onError` |
| Site API, per route | `src/platform/guards.ts` | `validator → withViewer → requireAuth → requirePermission → withDb` |
| Auth | `src/platform/auth/` | scrypt passwords, short JWT + rotating refresh, rate limits, two-step, audit |

## A01 Broken access control (+ API1 object level, API5 function level, API7 SSRF)
Template: the guards above; `requirePermission(codename, {orOwn})`, `can`, `permissionScope`
(`guards.ts`); `pagePermission` for SSR pages (`src/server/page-access.ts`); anti-escalation
`canDelegate` in the admin API; `safeNext()` for redirects; `sameOrigin`; no CORS headers.
You must:
- **Deny by default.** A route under `/site-api` with no guard is PUBLIC. Every non-public route
  starts `withViewer, requireAuth` and gates on a codename (`roles-and-permissions.md`). Hiding a
  button or a nav item is not access control; the route checks again.
- **Object level (BOLA).** Ids are sequential integers: anyone can guess `/notes/42`. Every read,
  update and delete by id is scoped to who may see it, in the SAME query:
  ```ts
  // WRONG: any signed-in user reads anyone's note
  const note = await db.note.findUnique({where: {id}});
  // RIGHT: the owner (or team) comes from the server, the row is filtered in the query
  const note = await db.note.findFirst({where: {id, ownerId: c.var.viewer.id!}, select});
  if (!note) return c.json(problem('not_found', 'No such note.'), 404); // 404, not 403: no oracle
  ```
  Writes: `updateMany` / `deleteMany` with the same `where` and check `count`
  (`src/server/routes/jobs.ts` delete). Mixed "all or own": `can(c, X, {ownerId: row.ownerId})`
  after loading the owner from the DATABASE, `permissionScope` for lists.
- **Linked ids too.** `{projectId}` in a body is an id from the client: check the project is the
  caller's (same owner / team) before you attach anything to it.
- **Function level.** Admin and bulk routes get `requirePermission`, even when only an admin
  screen calls them. A `GET /manage` beside a public `GET /` is a different route with its own
  guard (as in `jobs.ts`).
- **Share links**: never the id. A random token (below, A04), stored hashed, revocable.
- **Files**: show them through YOUR route, which checks access, then redirects to a short link
  (`files.md`).
- **Redirects**: same-site paths only, through `safeNext(value, fallback)` (`src/platform/auth`).
  Never redirect to a URL from the query string.
- **SSRF.** Platform calls go through `src/platform/api.ts` (fixed origin, timeout); other
  services by a fixed `https:` origin in YOUR code (Calling other services, below). The platform's
  internal network is never reachable (`403 Egress blocked`), but your code still never fetches,
  proxies or "previews" a URL a user typed, and never builds a path from raw input:
  `encodeURIComponent` each segment.
- **CORS**: none. Never add `Access-Control-Allow-Origin`; the browser talks to its own origin.

## A02 Security misconfiguration (+ API8)
Template: headers and CSP above; `onError` answers `internal_error` and logs the message only;
`/site-api/health` answers booleans only; `withViewer` / `pageContext` set
`Cache-Control: private, no-store`.
You must:
- Keep `public/_headers` and `src/platform/headers.ts` in step; add, never remove.
- CSP: never `'unsafe-inline'` or `'unsafe-eval'`; no `onclick=` / `style=""` in `.astro` markup
  (use a class; React's `style={…}` prop is fine); no `is:inline` scripts, no third-party
  `<script src>`. A new embed host goes in `frame-src` (or `img-src`/`media-src`) by exact origin;
  `connect-src 'self'` stays. The one per-page exception: the embedded payment form's gateway
  hosts, added to `/checkout/` only by `allowEmbeddedCheckout(Astro.csp, gateway)` (`payments.md`).
- No debug, test or "seed" routes on the live site; no `if (isPreview())` that loosens a check
  (Preview code paths exist only for the Preview's cookie bridge and framing).
- Errors to the browser: `{error, message}` in words. Never `err.message`, a stack, SQL, a Prisma
  error, a header or an env value in a response.
- Never `Cache-Control: public` on anything that read the visitor (`performance.md`).

## A03 Software supply chain failures (+ API10)
Template: committed `package-lock.json`, `npm ci` at Build, `allowScripts` in `package.json`
(the only install scripts that may run), Prisma pinned exactly (`7.10.1`), the managed core and
docs delivered as one tested upgrade (`npm run platform -- upgrade`).
You must:
- Add a package only when the platform can't do it in a few lines: WebCrypto, `URL`, `Intl`,
  `hono/*` and React cover most needs. Never a second UI kit, date, state or crypto library.
- Before adding: exact name (typosquats: `reacts`, `hono-js`), maintained, widely used, no native
  module, runs on workerd, no install script. One that needs one: ask the owner before widening
  `allowScripts`.
- `npm install <name>@<version>`, commit `package.json` + `package-lock.json` together. No git
  or tarball URLs, no `latest`, no second lockfile, never edit `node_modules`.
- `npm audit --omit=dev` before done: report high/critical findings to the owner; never
  `npm audit fix --force` (it jumps major versions).
- Nothing loaded at runtime from another origin: no CDN scripts, styles or fonts.
- Data from the platform (`publicGet`, files, job payloads) is still input: validate its shape
  before you use it, render it escaped.

## A04 Cryptographic failures
Template: PBKDF2-SHA256 600k (`src/platform/auth/password.ts`), HS256 with HKDF-derived keys,
refresh / reset / verify tokens stored as SHA-256, authenticator secrets sealed with AES-GCM,
`constantTimeEqual` (`src/platform/auth/encoding.ts`), `__Host-` Secure HttpOnly cookies, HSTS.
You must:
- A secret token of your own (invite, share link, API token you issue):
  ```ts
  import {randomBytes, sha256Hex, toBase64Url} from '../../platform/auth/encoding';
  const token = toBase64Url(randomBytes(32));          // show/send ONCE
  await db.shareLink.create({data: {tokenHash: await sha256Hex(token), noteId, expiresAt}});
  // later: findUnique({where: {tokenHash: await sha256Hex(given)}}) — never store or log `token`
  ```
  WRONG: `Math.random()`, `Date.now()`, an id, a UUID v1, base64 of the id, the raw token in a column.
- You cannot hold keys of your own (no secrets): never invent "encryption" (base64, XOR, a key in
  code). Data that needs encryption at rest (card numbers, government ids, health records) is not
  stored: tell the owner.
- Nothing secret in a URL query (it lands in logs, history and `Referer`); tokens in emailed
  links are single-use, short-lived and stripped by the page (`takeToken()`, `auth.md`).
- HTTPS only; never an `http:` link, form action or embed.

## A05 Injection
Template: Prisma's query API (parameterized); Astro and React escape `{value}`; `sanitizeHtml()`
(`src/platform/sanitize.ts`) for outside HTML; `safeApplyUrl` (`jobs.ts`) for links.
You must:
- **SQL**: the Prisma API. Raw SQL only as a tagged template, values as `${…}`; lists with
  `Prisma.join`; an identifier (sort column, table) only from a fixed map:
  ```ts
  import {Prisma} from '../../generated/prisma/client';
  // WRONG: db.$queryRawUnsafe(`SELECT … ORDER BY ${c.req.query('sort')}`)
  const SORT = {newest: Prisma.sql`created_at DESC, id DESC`, title: Prisma.sql`title ASC, id ASC`} as const;
  const order = SORT[input.sort as keyof typeof SORT] ?? SORT.newest;
  await db.$queryRaw`SELECT id, title FROM notes WHERE owner_id = ${me} AND id IN (${Prisma.join(ids)}) ORDER BY ${order} LIMIT 50`;
  ```
  Never `$queryRawUnsafe` / `$executeRawUnsafe`, never `Prisma.raw` with input.
- **HTML**: `set:html` / `dangerouslySetInnerHTML` only with `sanitizeHtml()` output; browser DOM
  with `textContent`, never `innerHTML` / `insertAdjacentHTML` with data. Data for a page script
  goes in a `data-*` attribute (escaped by Astro) read with `dataset`, never into a `<script>`.
- **URLs** you render (`href`, `src`): parse with `new URL`, allow `https:` (and `mailto:` where it
  fits) on SAVE, like `safeApplyUrl`. Never `javascript:`, `data:`, `vbscript:`.
- **Validation**: every input through `hono/validator`: type, trimmed length, enum, format,
  integers with `Number.isSafeInteger` (`cursorOf` in `jobs.ts`). Reject, don't repair. No regex
  built from input; keep your own regexes linear (no nested quantifiers on input).
- No `Object.assign(target, body)` / deep merges of input (prototype pollution, mass assignment).
- Headers you set from data (`Content-Disposition` file names): strip `\r`, `\n` and `"`.

## A06 Insecure design (+ API4 resource consumption, API6 business flows)
Template: `bodyLimit` 64 KB; `take` ≤ 100 and keyset pages; auth rate limits in
`login_attempts` (`checkRateLimit` / `takeAttempt`, fixed kinds in `rate-limit.ts`); no user
enumeration; single-use hashed tokens; uploads bypass the Worker with server-side size and type
checks (`createUpload`, `MAX_FILE_BYTES`, `ALLOWED_FILE_TYPES` in `src/platform/files.ts`).
You must:
- **Limit what costs**: anything that sends email, starts a job, writes a lot or can be guessed
  gets a per-user (or per-IP-hash) limit. You can't add a kind to the managed limiter: use a
  bounded check on your own indexed table:
  ```ts
  const recent = await db.message.findMany({
    where: {senderId: me, createdAt: {gt: new Date(Date.now() - 3600_000)}},
    select: {id: true}, take: 31,                     // index (sender_id, created_at)
  });
  if (recent.length > 30) return c.json(problem('rate_limited', 'Too many messages. Try again in an hour.'), 429);
  ```
  A hard quota (seats, credits) is a counter column changed by one conditional `updateMany`
  (`where: {id, used: {lt: limit}}`, check `count`), never read-then-write.
- **Bound everything** a request can make large: list sizes, string lengths (validator AND column),
  array lengths in a body (`ids.length ≤ 100`), loop counts, `sendJobs` batch sizes.
- **Business flows**: state changes are conditional writes (`updateMany({where: {id, status:
  'pending'}, data: {status: 'approved'}})`, `count === 0` → 409); retried actions are idempotent
  (`idempotent()`, a unique key, `sendJob(…, {key})`; `orders-and-stock.md`); totals, prices, scores and timestamps are computed on the
  server, never taken from the body.
- Public lookups answer the same for "exists" and "doesn't" (sign-up, invites, "is this taken").

## A07 Authentication failures (+ API2)
Template: everything in `auth.md`: generic login errors, backoff, refresh rotation with reuse
detection, `session_version` revocation, two-step sign-in, emailed codes, password re-asked for
email change, two-step changes and account deletion.
You must:
- Use only the built-in auth: no login form, token, cookie, session, password check or "magic
  link" of your own. Never call `verifyPassword` yourself: your route has no rate limit for it,
  so it becomes a password-guessing endpoint.
- A dangerous action of your own (delete a workspace, transfer ownership, export everything):
  `requireVerified`, a typed confirmation (`confirm: "DELETE"`), an audit event, and an email to
  the affected user where a kind exists. Needs a real re-authentication: ask the owner (core).
- Never put a session, token or user id in `localStorage`, a URL or a response body.

## A08 Software or data integrity failures
Template: background job deliveries are HMAC-signed by the platform, checked in a 5-minute
window and replay-guarded (`handleJobDelivery`, `job_deliveries`); migrations are reviewed SQL
applied at Publish; the CSP blocks injected scripts.
You must:
- Never `eval`, `new Function`, `import()` of a URL or a string from data.
- `JSON.parse` input, then validate its shape; never revive classes or functions from data.
- Job handlers re-validate `data` and re-check the rows they act on (the user may be gone, the
  row closed); make them idempotent (`background-jobs.md`).
- Inbound webhooks (another service calling the site) need the sender's signing secret as an
  owner secret (`config.ownerSecret`). The route is its own Hono app mounted BEFORE `sameOrigin`
  / `csrf`; it checks the signature (HMAC over the RAW body, constant-time compare, timestamp
  window) before parsing, and handles each event id once. Payments need none of this with the
  built-in payments: the platform sends signed payment events (`payments.md`).
- Nothing alters the schema at runtime; a migration is the only way.

## A09 Logging and alerting failures
Template: `audit(db, {actorUserId, action, target, ipHash, meta})` (`src/platform/auth/audit.ts`,
never throws) writes `audit_events`; owner and code sign-ins, password, email and two-step
changes, role and user changes, account deletes and refresh-token reuse are already audited; admins read them in `/dashboard/activity`
(`site:audit:read`); `onError` logs `site-api <method> <path>: <message>`.
You must:
- Audit every sensitive action of your feature: deletes, exports, ownership or membership
  changes, permission-like settings, bulk actions:
  ```ts
  import {audit} from '../../platform/auth';
  await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'note_deleted', target: ['note', id]});
  ```
  `action` snake_case ≤ 64, target type ≤ 32; `meta` small non-personal facts (`{count: 12}`).
  `ipHash` is optional (no public helper yet): leave it out.
- NEVER log or audit: passwords, tokens, cookies, `Authorization`, codes, emails, names, full
  bodies, raw IPs, env values. `console.error` a short message with a stable prefix, never the
  error object (it can carry the request).
- A log line is read by nobody: a failure the owner must notice (a job that gave up, a sync that
  stopped) is stored where the portal shows it (a status column, an audit event).

## A10 Mishandling of exceptional conditions
Template: `onError` → 500 `internal_error`; `withDb` → 503 when there is no database;
platform calls time out and never throw into a page (`src/platform/api.ts`), `read()` gives
`null`; `src/pages/jobs/[slug].astro` answers 503, never 404, when the read failed; `audit`
never throws; `DontRetry` ends a job that can't succeed.
You must:
- **Fail closed**: an error in a check denies. Never `catch` around a guard, a permission or an
  ownership query and carry on:
  ```ts
  // WRONG: a database blip makes everyone an editor
  let allowed = true; try { allowed = await can(c, X); } catch {}
  // RIGHT: let it throw (onError answers 500), or deny
  if (!(await can(c, X))) return forbidden(c);
  ```
- Map known errors to answers: Prisma `P2002` (unique) → 409 with words, `P2025` (row gone) → 404;
  rethrow the rest (`jobs.ts` create shows the pattern).
- Multi-step writes are atomic (`$transaction`), or ordered so a crash halfway leaves nothing
  broken. No half-created records the UI can't show.
- Bad numbers: `Number('x')` is `NaN`, `Number('')` is `0`: parse with a helper like `cursorOf`.
- Optional sections degrade (`null` → hide the section); required data fails visibly (500/503
  page, error state in the portal), never an empty page that looks like "no data".

## Passwords and email addresses (owner's rule: never, no matter what)
- **A password never leaves the server, in any form, to anyone, the user included**: no plain,
  hashed, encrypted or masked password in a response, page, email, log, audit `meta`, cache, export,
  error, URL or outside call. No "your password is…" or "here is your new password" email: a
  forgotten password gets a reset link (`auth.md`); an admin who resets someone gets a link sent to
  that person, never a password to pass on. `passwordHash` is never in a `select` of an answer.
  The same for sign-in codes, tokens, recovery codes and outside API keys once issued.
- **Another person's email address is never sent where others can see it.** It goes ONLY to:
  its owner (their own account screens), or a signed-in admin with `site:user:read` checked on the
  server, in admin screens. Everything else gets a NAME (or nothing):
  | Place | Rule |
  | --- | --- |
  | public pages, public Site API routes, sitemap, RSS, `og:` tags | no emails at all |
  | lists, search, comments, reviews, "posted by", leaderboards, members of a team | name or initials, never the email |
  | errors and form messages | the same answer whether an address exists or not ("If that address has an account, we sent a link") |
  | URLs, query strings, redirects | never an email (logs, history, `Referer`) |
  | logs, audit `meta`, analytics, background job payloads | user id, never the email |
  | the cache (`cache.md`) | never an email in a key; in a value only under the user's own `userKey` |
  | outside services (mail, CRM, AI, analytics) | only the person's own address, only when THEY asked for that action |
  When someone must recognise an address that isn't theirs (an invite already sent), mask it:
  `m•••@gmail.com` (first letter, the domain). Never store copies of emails in your own tables:
  join on `users.id` (`database.md`).
- Check it in every review (`review.md` step 2): `grep -rn "email" src/server src/pages` and read
  each hit: who receives it?

## API3 Broken object property level authorization (mass assignment, data exposure)
Template: `jobBody` in `jobs.ts` builds the update field by field; every query has an explicit
`select`; `publicUser` returns only safe user fields; emails only to the user and
`site:user:read` holders.
- **In**: never `data: body` or `{...body}`. Each writable field is listed, validated, and
  allowed for THIS caller. Never from the client: `id`, `ownerId`, `teamId`, `createdBy`, `role`,
  `status` (unless the caller holds the codename that changes it), counters, timestamps.
  ```ts
  // WRONG
  await db.post.update({where: {id}, data: c.req.valid('json')});   // validator passed everything through
  // RIGHT
  const {title, body, status} = c.req.valid('json');                 // validator returned only known keys
  if (status !== undefined && !(await can(c, PERMISSIONS.POST_PUBLISH))) return forbidden(c);
  await db.post.updateMany({where: {id, ownerId: me}, data: {title, body, ...(status ? {status} : {})}});
  ```
- **Out**: a `select` per audience (public, owner, admin); build the response shape field by
  field (`src/lib/types.ts`). Never return a Prisma row, a hash, a token, another user's email or
  internal flags.

## Also
- **CSRF**: `sameOrigin` + double-submit `csrf` on the whole Site API. Browser writes go through
  `siteFetch` / the portal's `api`. Never a state change on GET. The one route before `csrf` is
  `/site-api/checkout` (`formCsrf`: the token, or a form post the browser marks
  `Sec-Fetch-Site: same-origin`), so a Buy button works without JavaScript; nothing else joins it.
- **Payments**: a price KEY from the browser, never an amount; access only from `paid` /
  membership rows (verified email or the buyer's own account); `payments.md`.
- **Secrets**: `DATABASE_URL`, `JWT_SECRET`, `{{SITE_KEY_ENV}}` (set by the platform) and the
  owner's own (`config.ownerSecret('NAME')`), read only through `config`
  (`src/platform/config.ts`). Never to the browser, a log, a file, git. You cannot add one: tell
  the owner which name to add, in which environment; never ask for the value.
- **PII**: store the minimum; never copy a user's email into your tables (join on `users.id`).
  Personal-data exports need a codename and an audit event; account deletion leaves your rows
  (decide per table: `database.md`).
- **Client code is public**: everything in a page or the portal ships to every visitor. No
  secrets, hidden admin routes or "security by obscurity" flags.
- **Links out**: `target="_blank"` always with `rel="noopener noreferrer"`.

## Calling other services
Deployed server code may call public APIs (a payment provider, mail, SMS, AI, a webhook out) with
`fetch`. The platform's internal network is never reachable: IP addresses, private and local
names answer `403 Egress blocked`; no raw TCP or outgoing WebSockets. Calls to other hosts carry
no cookies, visitor IP or platform headers. You must:
- Keep the key in a site secret the owner adds (`config.ownerSecret('NAME')`, `null` when not
  added: say which name, in which environment). Never in code, a file, the browser or a log.
- Call a fixed `https:` origin written in your code; never a host or URL from input. Send only
  the fields the call needs (no whole user rows, no tokens).
- Set a timeout (`AbortSignal.timeout(10_000)`), check `res.ok`, validate the response's shape,
  and fail closed (an error never grants access or marks something paid).
- Slow or retried work (sending many emails, an AI call over a few seconds) goes in a background
  job (`background-jobs.md`), with an idempotency key where the service offers one.
- Never forward a visitor's cookie or `Authorization` header to another service.

## Before you say "done"
Run `review.md` (it walks these and the performance checks, and ends with the report). The list:
- [ ] Every new route: guards in order; non-public ones `withViewer → requireAuth → requirePermission`.
- [ ] Every by-id read/write is scoped in the query (owner / team); not found → 404.
- [ ] Inputs validated with types and limits; writes built field by field; output via `select`.
- [ ] No raw SQL from strings; no `set:html` / `innerHTML` without `sanitizeHtml`; links checked.
- [ ] Costly or guessable actions limited; lists bounded; quotas are conditional writes.
- [ ] Sensitive actions audited; no secrets or PII in logs, audit `meta` or responses.
- [ ] Errors fail closed and answer in words; no stack or `err.message` to the browser.
- [ ] No new header/CSP weakening; `public/_headers` in step; no CDN or inline script.
- [ ] Calls to other services: fixed `https:` origin, key from `config.ownerSecret`, timeout, response validated.
- [ ] New dependency justified, pinned in the lockfile, `npm audit --omit=dev` read.
- [ ] Integration test of who may and who may not (`database.md` › Tests); `npm run build` and `npm test` pass.
