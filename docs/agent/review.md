---
title: Review before done: security (authorization first) and performance
read-when: at the END of every task that added or changed a route, a page that reads data, a query, a permission, a form, a file upload, a payment, a job or an outside call; and whenever the owner asks for a review or an audit
---
A skill: run it as written, every time, on what THIS task changed (and what it touches). It
takes a few minutes. Never skip it because the change "looks small": most leaks are one missing
`where`. Fix what you find in the same task, then report (step 7).

## 1. List what changed
```bash
git status --short && git diff --stat
git diff --name-only | grep -E 'src/(server|pages|portal|lib)/|prisma/' || true
```
Write down every new or changed: Site API route (method + path), SSR page that reads data,
portal screen that calls the API, model / migration, background job handler, payment hook,
outside call. That list is what you review.

## 2. Authorization (the most important step)
For EVERY route on the list, fill this in your head (or in the report) and check the code:

| Question | Where to look | Must be |
|---|---|---|
| Who may call it? | the route's guards | public, signed in, or a permission; written down, not implied |
| Guards in order? | `validator → withViewer → requireAuth → requirePermission(X) → withDb` | every non-public route has `requireAuth` AND a permission (`roles-and-permissions.md`) |
| Gated on a role slug? | `requireRole` | never: a codename from `CATALOGUE` |
| Object level: can user A reach user B's row by changing an id in the URL, body or query? | every `findUnique` / `findFirst` / `update` / `delete` by id | the owner (or team) is IN the query: `where: {id, ownerId: c.var.viewer.id!}`, or `can(c, X, {ownerId: row.ownerId})` right after a read of the owner only; not found → **404** (never 403: don't confirm it exists) |
| Lists | `findMany` | filtered by owner / team / `permissionScope` in the `where`, never filtered in JS after loading |
| Field level: can the caller set a field they shouldn't? | `data:` of every create / update | built field by field from the validator; `ownerId`, `teamId`, `role`, `status`, `price`, `verified`, counters come from the server, never the body (`security.md` API3) |
| Data exposure | `select` of every answer | only the fields this caller may see; no tokens, hashes, other users' data, internal ids it doesn't need |
| **Passwords** | every answer, email, log, export | a password never leaves the server in ANY form (plain, hashed, encrypted, masked), not even to its own user; no "your password is" email; resets by link (`security.md` › Passwords and email addresses) |
| **Email addresses** | every `select`, page, list, error, URL, log, job payload, cache key | another person's email reaches ONLY its owner or a permission-checked admin screen; everywhere else a name, or a masked `m•••@domain` |
| Admin-only actions | the route + the portal nav | a permission with `ability`; the nav item hidden AND the route refusing (hiding is not security) |
| Escalation | role / permission / membership changes | a user can't grant what they don't hold, can't edit their own role, can't remove the last owner |
| Pages (SSR) | `pageContext` / `pagePermission` | a gated page checks on the server, and its data comes from a route that checks too |
| Background jobs and webhooks | `src/server/background.ts`, payment hooks | trust only the platform-verified delivery; re-check the row's owner/state before acting |

Find the risky spots fast:
```bash
# reads and writes by id: each must carry the owner/team in the where, or a `can(...)` check after
grep -rnE "find(Unique|First)\(\{ *where: *\{ *id|(update|delete)\(\{ *where: *\{ *id" src/server src/pages | grep -v ownerId
# routes without a permission (each line: is it meant to be public?)
grep -rnE "\.(get|post|put|patch|delete)\('" src/server/routes | grep -v requirePermission
# every place an email or a password could leave the server: read each hit, who receives it?
grep -rnE "email|password" src/server src/pages src/portal | grep -vE "^\s*//" | head -80
# client-supplied ownership fields
grep -rnE "ownerId|teamId|createdBy|role|status" src/server/routes | grep -E "valid\('json'\)|body\." 
```
**Prove it with a test** for each new route that reads or writes by id (`database.md` › Tests):
signed out → 401; signed in without the permission → 403; another user's id → 404; the owner → 200.

## 3. Injection and input
- Every input through `hono/validator`: type, trimmed length, enum, integer (`Number.isSafeInteger`).
- SQL: only the Prisma API or a TAGGED `$queryRaw\`…\`` / `Prisma.sql` (a prepared statement:
  values are sent as parameters, never pasted into the SQL). Lists with `Prisma.join(ids)`. A
  sort column or table name only from a fixed map. Never `$queryRawUnsafe`, `$executeRawUnsafe`,
  `Prisma.raw(input)`, or SQL built with `+` / template strings outside the tag.
  ```bash
  grep -rnE "queryRawUnsafe|executeRawUnsafe|Prisma\.raw\(|\\\$queryRaw\(" src/ || echo "none"
  ```
- HTML: no `set:html` / `dangerouslySetInnerHTML` / `innerHTML` with data unless through `sanitizeHtml`.
- URLs you store or render: `https:` (and `mailto:`) only; redirects only to your own paths (`safeNext`).
- Uploads: through `files.md` (size, type, private by default); never trust the file name.

## 4. Secrets, errors, logs, abuse
- No secret in code, logs, responses, the browser or git; outside keys only via `config.ownerSecret`.
- Errors: fail closed, answer in words, no stack / `err.message` / SQL to the browser.
- Logs and audit `meta`: no passwords, tokens, full emails or card data.
- Anything costly, public or guessable (sign-up-like forms, search, sending email, AI calls) is
  rate limited and bounded (`security.md` A06).
- Outside calls: fixed `https:` origin, timeout (`AbortSignal.timeout`), response validated, never
  user-supplied URLs fetched by the server (SSRF).
- Webhooks and payments: signature checked by the platform helper; handlers IDEMPOTENT (the same
  delivery twice changes nothing: a unique key or a conditional `updateMany`).
- Anything charged or booked has an idempotency key, the same across retries. Anything limited is decided by the
  database in one conditional statement, a unique index or a short lock, never by a read then a write, and has a test
  running it many times at once (`orders-and-stock.md`).
- Cache (`cache.md`): shared keys hold only what every visitor sees; no secrets; money and access
  never from the cache.

## 5. Performance (backend first)
For every route and data-reading page on the list, count the database round trips of ONE request:
- **Budget: at most ~5 sequential round trips per request**, ideally 1–3. Each is ~3 ms normally,
  ~170 ms on a slow Worker instance. `Promise.all` of plain reads counts as one.
- **No N+1, ever.** A query inside a loop, a `.map(async …)` that queries, or one query per row
  of a list is a bug, not a style choice:
  ```bash
  grep -rnE "for \(.*\) \{|\.forEach\(|\.map\(async" src/server src/pages | head -50   # then check each body for db. / await
  grep -rnE "await .*db\.[a-zA-Z]+\.(find|count|aggregate)" src/server src/pages | wc -l
  ```
- **One query per read**: related rows in the same query with a nested `select` (one SQL query
  with `relationJoins` on, `database.md` › One query per read). For aggregates or several tables
  that Prisma can't express in one query, ONE tagged `$queryRaw` instead of several queries.
- **Independent reads in parallel**: `Promise.all([…])`; sequential only when one needs the other.
- Explicit `select`, `take ≤ 100`, keyset paging, an index for every `where` + `orderBy` shape,
  no `count()` of a growing table per request (`performance.md`).
- A read that repeats on many requests and rarely changes, with no cache: consider `cache.md` › "Should this be cached?", because every
  query is billed. For each cache key this task added or touched, search for every write to the tables behind it, and check each one clears it, then
  check the key against `cache.md` › "How caches go wrong". A place that doesn't clear is a bug. So is a cached read on an edit screen, or of a price an order charges.
- Slow or later work (emails, reports, outside calls not needed for the answer): a background
  job (`background-jobs.md`) or `waitUntil`, never in the request.

## 6. Prove it
```bash
npm run build && npm test
```
Plus the authorization tests from step 2. Open the changed pages in the Preview signed out, as a
plain user and as an admin.

## 7. Report (always, in your final message, short)
```
Review: <n> routes/pages checked.
Authorization: <each route: who may call it; object-level check where>. Tests: <added/updated>.
Security: <issues found and fixed, or "none found">.
Performance: <round trips per request for the main route; N+1 fixed / none; parallel reads; cache>.
Left open: <anything you could not fix, and why> (or "nothing").
```
If you found a problem outside this task's code, fix it when it is about security, lost or wrong
data, or a broken or slow page (AGENTS.md › Every task, rule 3); otherwise list it under "Left open".

## The full security check
Not part of every task. Run it when the owner asks for a security check, and when they first ask to go live. Follow the machine
limits in `AGENTS.md`. Only ever against the Preview and its database, never the live site.
1. List every route, form, permission, payment and file this site's own code adds.
2. Test each by running it: a real request as another user, as a signed-out visitor, and with bad input, plus many requests at once
   where something is limited. Reading the code isn't enough.
3. Fix holes in the site's own code in the same task, with a test for each.
4. A hole in `src/platform/**`: never patch it. Check for a newer template and upgrade, once. If there is none, give the owner a
   short description in plain words to send to support: what goes wrong, not how to do it.
5. End with a short report: what was tested, what was fixed, what is left. Remind the owner that fixes reach visitors only when they publish.
