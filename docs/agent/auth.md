---
title: Auth: the site's own sign-in
read-when: before anything that depends on who the visitor is: sign-in links, signed-in pages, a greeting, a route that needs a user, anything touching passwords, sessions or account emails
---
This site OWNS its sign-in: users, passwords and sessions live in its Site Database, run by the
managed core in `src/platform/auth/` (never edit it; `npm run platform -- upgrade` replaces it).
You USE it: guards on routes, `getViewer()` in pages, `siteFetch()` in the browser. You never
write your own login, token, cookie or password code.

## What exists (use it, don't rebuild it)
- Pages (prerendered): `/account/login` (password, then the two-step code when it is on),
  `/account/register`, `/account/forgot`, `/account/reset/?token=`, `/account/verify/?token=`,
  `/account/confirm-email/?token=` (a new address). `?next=<path>` = where to go after sign-in.
- Signed-in screens: the portal's `/dashboard/account`: name, email address, password, two-step
  sign-in (authenticator app + recovery codes), signed-in devices (sign one out, or all), delete
  the account. Admins: Users can switch two-step sign-in off for someone who lost their phone.
- API `/site-api/auth/*`: `register`, `verify-email`, `resend-verification`, `login`,
  `login/two-factor`, `code` + `code/verify` (a 6-digit code by email, no password), `refresh`,
  `logout`, `logout-all`, `me` (GET/PATCH), `forgot-password`, `reset-password`, `change-password`,
  `owner` (one click from the dashboard: GET live, POST in the Preview), `two-factor` (GET, `setup`,
  `enable`, `disable`, `recovery-codes`), `email`, `email/confirm`, `sessions` (GET, DELETE `:id`),
  `delete-account`. Files: `routes.ts`, `code-routes.ts`, `owner.ts`, `security-routes.ts`, `two-factor.ts`.
- Settings (yours): `src/server/auth-settings.ts` → `registration`, `requireEmailVerification`,
  `firstUserBecomesOwner`, `ownerEmails`, `defaultRole`, `afterSignInPath`.

## How a request knows the visitor
`getViewer(request)` (once per request, memoized): access JWT cookie → HMAC verify → ONE primary-key
read of `users` (status must be `active`, `session_version` must match the token's `sv`). States:
`user`, `returning` (access cookie gone but a refresh cookie is there: the browser refreshes once),
`guest`. `getAccess(request)` → `{roles, permissions}` (one bounded query, memoized).

## Guards (Site API routes), in THIS order
`validator → withViewer → requireAuth → requirePermission('site:x:y') → withDb`
- `requireAuth`: 401 `token_expired` (browser refreshes and retries) or 401 `signed_out`.
- `requireVerified`: 403 unless the email is confirmed (add it for anything sensitive).
- `requirePermission(codename)` over `requireRole(slug)`: roles are renamed, codenames are not.
- Never trust an id, role or permission from the request body, query or a header. The user is
  `c.var.viewer.id`, always.

## Tokens and cookies (fixed; do not change)
| Cookie | Holds | Life | Flags |
| --- | --- | --- | --- |
| `__Host-site_at` | HS256 JWT `{sub, sid, sv, typ, iat, exp}` | 10 min | HttpOnly, Secure, SameSite=Lax, Path=/ |
| `__Host-site_rt` | opaque 256-bit refresh token (DB stores SHA-256 only) | 30 days sliding, 90 absolute | same |
| `__Host-site_csrf` | CSRF double-submit token | 1 year | readable by JS |
- In the editor Preview only, the gateway drops cookies: the managed core then carries these
  three in headers and the browser keeps them for the tab (`publishing.md` › Preview). Nothing
  changes on the live site; never copy that mechanism.
- Refresh rotates on every use. A used token presented again after 10 s = theft: the whole family
  (device session) is revoked and `refresh_reuse_detected` is audited. Within 10 s = two tabs
  racing: refused with 409, nothing revoked. A revoked family can't refresh again, and an access
  token issued from it stops working at once too: every signed-in request also checks that the
  token's sign-in (`sid`) still has an unrevoked refresh token, so "Sign out" on one device ends
  a copied access token there and then.
- Password change, reset, suspension and "sign out everywhere" bump `users.session_version`:
  every access token dies at once, every refresh family is revoked.
- `JWT_SECRET` is platform-managed. HKDF derives separate keys from it (JWT signing, rate-limit
  hashes, the two-step challenge, sealing authenticator secrets). Never read it outside
  `src/platform/`, never log it. Rotating it signs everyone out and makes sealed authenticator
  secrets unreadable (those users sign in with a recovery code, or an admin switches it off).

## Passwords
PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP's figure), 16-byte salt per user, NFKC-normalized,
stored as `pbkdf2-sha256$v1$600000$<salt>$<key>`. A lower stored cost (210,000 before 0.4.2) is
re-hashed at the next login.
Rules: 10–128 characters, not the email's name, not a common password (`passwordProblem()`).
Cost is ~45 ms CPU per hash: that is why the routes that hash a password a stranger chooses
(login, register, forgot, resend, change) are rate-limited first. Reset and verify take a 256-bit
single-use token and hash only after it checks out.

## Rules you must keep
- No user enumeration: login says "Email or password is incorrect." for both cases (and verifies
  a dummy hash for unknown emails); forgot-password and resend always answer the same; register
  with verification on answers "check your inbox" for new AND taken emails.
- Rate limits are in `login_attempts` (no KV/Redis), as a free allowance then exponential
  backoff (not hard caps): login 5 per email+IP per 15 min, then 1→2→4→8→15 min waits; 20 per
  email from any IP; 50 per IP. Register 5/h per IP. Reset and resend 3/h per email, 10–20/h per
  IP, then backoff. A 429 carries `Retry-After`; show its message. Each attempt holds a
  per-scope lock (a Postgres advisory lock on the IP and email hashes, for one short
  transaction), is RECORDED BEFORE the limit is checked and counts only the attempts recorded
  before it, so a burst of parallel requests gets exactly the free allowance through
  (`takeAttempt()`); a refused attempt leaves no row. Forgot-password and resend do their account lookup after answering, so
  their timing says nothing either.
- Account emails are RELAYED by the platform (`src/platform/auth/email.ts`): the site sends
  `{kind, to, path}` with the Site Key to `POST <{{SITE_URL_ENV}}>{{EMAIL_ENDPOINT}}`. Send a PATH
  (≤ {{EMAIL_PATH_MAX}} characters), never an absolute URL (the platform builds the link on the
  site's primary domain). Kinds: {{EMAIL_KINDS}}; a link lives at most
  {{EMAIL_EXPIRES_MAX_MINUTES}} minutes. The platform caps relaying at {{EMAIL_SITE_HOURLY_LIMIT}}
  emails an hour and {{EMAIL_SITE_DAILY_LIMIT}} a day per site, {{EMAIL_RECIPIENT_HOURLY_LIMIT}} an
  hour per recipient: over that it answers 429 and the email is not sent (the visitor sees the
  same "check your inbox" answer).
- Links in emails carry single-use tokens (reset: 30 min, verify: 24 h), stored hashed. Pages that
  read one strip it from the URL (`takeToken()`) and send `Referrer-Policy: no-referrer`.
- Redirect after sign-in only to a same-site PATH (`safeNext()` / `nextPath()`): never a URL.
- Sessions are cookies only. Never put a token in `localStorage`, a URL, a log or a response body
  (the Preview's header-carried cookies are the managed core's, Preview-only exception).
- THE ADMIN IS MADE BY THE PLATFORM, NEVER BY YOU. The owner addresses are `ownerEmails` in
  `src/server/auth-settings.ts` plus `SITE_OWNER_EMAILS`, which the platform sets on the live site
  at each Publish AND in the editor Preview (the account owner and members whose role holds
  `account:*`; `config.ownerEmails`). Each owner address gets its account, holding `owner`, with NO
  password, made by `ensureOwnerAccounts()` (owner.ts) before its first sign-in code or one-click
  sign-in. Never create, edit or delete that account or its role, never seed an admin in a
  migration or `seed.sql`, never ask the owner for a password to create one.
- HOW THE ADMIN SIGNS IN: an emailed 6-digit code (`/account/login/`, the default; `code-routes.ts`:
  10 minutes, one use, 5 wrong tries spend it, a new code ends the older one, only a keyed hash is
  stored, the same answer whether or not the email has an account), or ONE CLICK from the dashboard:
  "Open live portal" on the app's page in the dashboard (`GET /site-api/auth/owner?ticket=…`) and
  the shield in the editor Preview's bar (`/dashboard/?owner_ticket=…`, which the portal POSTs to
  `/site-api/auth/owner`: the Preview's cookies only travel with a fetch). Either way the ticket is
  one use, 2 minutes, spent with the platform (Site Key) and live and Preview tickets never cross.
  A password and two-step sign-in are optional: the admin sets them in the portal (Account →
  Security); other admins are made in the portal (Users). Tell the owner exactly that when they ask
  how to reach the admin. Anyone else may sign in by code too. The other way to claim owner:
  an owner address signs up here and sets its password THROUGH AN EMAILED LINK (anyone can
  register an owner address first, so a confirmation link alone proves nothing): confirming an
  owner address drops the registered password, ends its sessions and emails a link to choose one
  (`setPassword: true`); that link, or Forgot password, claims owner. Signing up again on an
  unconfirmed address keeps NEITHER password and kills its older links.
  The owner SEAT (`auth_state.owner_user_id`) follows the owner list: when the seat holder's
  address is no longer on it (the account changed hands), the next owner address to
  sign in takes the seat and the old holder loses `owner` (account and other roles kept). Owners
  added by hand in Users keep it. On the LIVE site with no owner address at all, NOBODY becomes
  owner: a warning is logged and `/site-api/health` answers `ownerSetup: false`. Only local dev
  and the Preview let the first account win without a list. Never weaken this (`ownerClaimMode()`,
  `claimOwnerIfFirst()`), and never add another way to become owner.
- TWO-STEP SIGN-IN (`two-factor.ts`): TOTP (RFC 6238, 6 digits, 30 s, any authenticator app) with
  10 one-use recovery codes. The secret is stored SEALED (AES-GCM, bound to the user), each code
  works once (`totp_last_step`), recovery codes are stored hashed. With it on, `/login` answers
  202 `{twoFactor: true, challenge}` and NO session; `/login/two-factor {challenge, code}` (5
  minutes, voided by a password change) finishes it. Rate-limited like login. A sign-in code
  (`/code/verify`) and the one-click owner sign-in ask for it too: GET `/owner` goes to
  `/account/login/?mfa=<challenge>`, POST `/owner` answers 202 like `/login`.
- NEW EMAIL: `/email {email, password}` mails a link to the NEW address (24 h, single use) and
  changes nothing until it is opened; a taken address gets no link but the same answer.
  Confirming moves the account, bumps `session_version` (every device signs in again) and tells
  the OLD address (`email_changed`).
- DEVICES: `/sessions` lists the signed-in devices (a refresh family each: "Chrome on macOS",
  last active, this one marked); `DELETE /sessions/:id` ends one at once.
- DELETE ACCOUNT: `/delete-account {password, confirm: "DELETE"}`. The last owner can't (409
  `last_owner`). Rows the user made in your own tables are NOT deleted (no foreign key to
  `users`, like `jobs.created_by`): decide per table, and say so in the feature.
- A password is asked again (`password`) for setup/disable of two-step sign-in, a new email and
  deleting the account, unless the account has none (it came in through Open admin).

## Recipes
**A signed-in-only route**
```ts
export const notesRoutes = new Hono()
  .get('/', withViewer, requireAuth, withDb, async c => {
    const rows = await c.var.db.note.findMany({
      where: {ownerId: c.var.viewer.id!}, select: {id: true, body: true}, orderBy: {id: 'desc'}, take: 21,
    });
    return c.json({notes: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19]!.id : null});
  });
```
**Browser call** (adds CSRF on writes, refreshes once on `token_expired`):
```ts
import {siteFetch} from '../platform/browser';
const res = await siteFetch('/site-api/notes', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({body})});
```
In React use the typed client `api` (`src/portal/api.ts`), which already goes through `siteFetch`.

**A page that shows something to signed-in users** (SSR): `const {viewer} = await pageContext(...)`
and branch on `viewer.state === 'user'`. In a prerendered page use `data-user-only` /
`data-guest-only` elements (filled in the browser). Never put user data in a prerendered page.

**Sign-in links**: `<a href={`/account/login?next=${encodeURIComponent(path)}`}>Sign in</a>`.

## Never
A second login form, your own JWT/cookie/session/two-step code, `verifyPassword` /
`hashPassword` called from your own routes (they have no rate limit: a password-guessing endpoint), another way to become owner,
an invite, "magic link" or sign-in code of your own (the site has them: `code-routes.ts`, "Open live portal"), an admin account made by you, `Astro.session`, tokens in JS-readable
storage, passwords in logs or audit `meta`, emails of other users in a response (only the user
themself and holders of `site:user:read`), or reading `env` outside `src/platform/config.ts`.
