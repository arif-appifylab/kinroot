# `src/platform/` — the template's managed core

Everything in this folder belongs to the template, not to this site. It is
how the site talks to the platform and how it signs people in, safely:

| File                 | What                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `config.ts`          | the platform's environment, read in one place                        |
| `api.ts`             | platform calls: public API, Site Key, origin rule, public cache      |
| `guards.ts`          | Site API middleware: `previewCookies`, `sameOrigin`, `csrf`, `withViewer`, `requireAuth`, `requireVerified`, `requireRole`, `requirePermission`, `withDb`, `withAuthCore` |
| `headers.ts`         | security headers on every rendered response                          |
| `request-scope.ts`   | per-request memo of the visitor, their access and the DB client      |
| `db.ts`              | the Site Database client (one per request)                           |
| `browser.ts`         | browser: `siteFetch`, session refresh, sign out, CSRF header         |
| `static-page.ts`     | browser: fills the visitor into prerendered pages                    |
| `sanitize.ts`        | cleans platform HTML before a page renders it                        |
| `types.ts`           | shared shapes (`Site`, `Viewer`, `Access`, admin rows)               |
| `auth/`              | the site's own sign-in: see below                                    |

`auth/`:

| File             | What                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `routes.ts`      | `/site-api/auth/*`: register, verify, login, refresh, logout, reset…  |
| `admin.ts`       | `/site-api/admin/*`: users, roles, audit log (anti-escalation)        |
| `session.ts`     | `getViewer()` / `getAccess()`: who is visiting, what they may do     |
| `password.ts`    | PBKDF2-SHA256 (600k, versioned hash strings), password rules         |
| `jwt.ts`         | HS256 access tokens (10 min), strict verification                    |
| `refresh.ts`     | opaque refresh tokens: families, rotation, reuse detection           |
| `rate-limit.ts`  | per email+IP / email / IP limits with exponential backoff            |
| `keys.ts`        | HKDF sub-keys of `JWT_SECRET`; keyed email/IP hashes                 |
| `cookies.ts`     | `__Host-` cookie names and attributes                                |
| `preview-cookies.ts` | the editor Preview only: auth cookies carried in headers         |
| `codenames.ts`   | core codenames, `grants()`, `canDelegate()`                          |
| `store.ts`       | the rules' Prisma stores + the bounded sweeper                       |
| `email.ts`       | account emails relayed by the platform (`/api/site/v1/emails`)       |
| `audit.ts`       | `audit_events` writer (no PII)                                       |
| `settings.ts`    | the `AuthSettings` shape (values: `src/server/auth-settings.ts`)     |

**Do not edit these files.** `npm run platform -- upgrade` replaces this
folder wholesale with the next template release (security fixes reach every
site that way), so a change here is lost. Build on it from your own code
(`src/server/`, `src/pages/`, `src/portal/`): wrap a helper, add a route, add
a guard of your own next to it. If something here is wrong or missing, ask
for it upstream.
