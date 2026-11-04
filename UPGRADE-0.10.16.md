# Template 0.10.13 → 0.10.16: what Kinroot should change

Kinroot is on **0.10.13** (`UPGRADE-0.10.13.md`). Three releases since (`~/Downloads/site-astro-app-0.10.16`, `CHANGELOG.md`):
**0.10.15 is a required security release** (sign-up and sign-in), and 0.10.14 / 0.10.16 only raise the required
version and change the upgrade steps. Nothing reaches visitors until a Publish.

**How to approve:** reply with IDs ("all", "V-1 to V-6"…). Nothing below is done yet.

---

## A. Comes with the upgrade itself (managed code: no Kinroot change)

| ✓ | ID | What changes | What it means for Kinroot |
|---|---|---|---|
| [ ] | V-1 | **No account exists until the inbox is proven.** Sign-up keeps a *pending* sign-up for that browser and emails a 6-digit code and a link; only that browser, with the code or link, creates the account. | Someone can no longer sign up with a teammate's or a customer's address. New migrations: `pending_sign_ups`, `sign_up_by_address`, `no_email_change_undo`. |
| [ ] | V-2 | **Every security event ends every way back in**: password reset or change, new email, "sign out everywhere", suspension (`end-access.ts`). | Also covers Kinroot's Settings → Security and Accounts actions. |
| [ ] | V-3 | **Email changes** need the password and the new inbox; the old address is told at once and can cancel while it waits (new page `/account/cancel-email/`). | Kinroot needs that page in its design (B, V-6). |
| [ ] | V-4 | **Rate limits counted by the database**, IPv6 /56 counted as one address, fewer locks; notices for two-step on/off and new recovery codes; password sign-ins in the audit log. | Nothing to do. |
| [ ] | V-5 | **A site changing hands**: a former owner's admin ends within 10 minutes. | Nothing to do. |

## B. Kinroot must adapt (it redesigned the sign-in pages in Phase 10)

| ✓ | ID | Change | Why | Effort |
|---|---|---|---|---|
| [ ] | V-6 | Run `npm run platform -- upgrade --from ~/Downloads/site-astro-app-0.10.16 --base ~/Downloads/site-astro-app-0.10.13`; delete the template pages and files it adds back (blog, jobs, checkout, portal, `list-page`); add the `PendingSignUp` model to `schema.prisma`; migrate the local databases; delete `tests/rate-limit-lock.test.ts` (the template removed it); redo Kinroot's edit to `tests/upgrade.test.ts` (no checkout files). | The upgrade guide's steps for this release. | S |
| [ ] | V-7 | **Sign-up page** (`src/crm/public/auth/register.tsx`): after `/register`, remember the address for this tab and go to `/account/verify/` (no message-only screen). | Without it a new person sees "check your email" with nowhere to type the code. | S |
| [ ] | V-8 | **Verify page** (`src/crm/public/auth/verify.tsx`): add the code form (email + 6-digit code, "send a new code") posting to `/site-api/auth/register/verify`; the emailed link also goes there (`{token}`); keep the older `verify-email` link working. In Kinroot's design. | The new way every account is created: team invites and support-portal customers included. | M |
| [ ] | V-9 | **Sign-in page** (`src/crm/public/auth/login.tsx`): an account never confirmed answers `needsCode` → go to the code page. | Otherwise those people can't finish signing in. | S |
| [ ] | V-10 | **New page `/account/cancel-email/`** in Kinroot's design (`CrmPublic` layout, like the other account pages). | The "cancel this change" link in the old inbox's email lands there. | S |
| [ ] | V-11 | `src/lib/account.ts`: the template's `rememberSignUpEmail` / `signUpEmail`. `src/server/auth-settings.ts`: drop `requireEmailVerification` (does nothing now). Remove `src/lib/verify-outcome.ts`'s `setPassword` branch if the new verify answer no longer sends it. | Template files Kinroot changed. | S |
| [ ] | V-12 | **Kinroot's tests**: the harness's `signedIn` follows the new flow (comes with the merge); check `teammate()`, invites, the support portal and the site-admin tests still sign people up correctly, and add one Kinroot test: an invited teammate signs up with the code and joins. | Every CRM test signs people up. | S–M |
| [ ] | V-13 | Check, then commit: `npm install`, `prisma generate`, `migrate deploy`, typecheck, the full suite, build, and in the browser: sign up with the code, sign in, change email and cancel it, all in Kinroot's design. | The guide's check. | S |

## C. The app rules (your screenshot): where Kinroot stands

| Rule | Kinroot today | To change |
|---|---|---|
| **Postgres only** | ✅ The app uses only the site's Postgres (Prisma). `mysql2` is in the lockfile only because the Prisma CLI (a build tool) depends on it, same as the template; Redis / SQLite / PlanetScale appear only as optional peers and aren't installed. | Nothing. |
| **Your own folders** (never edit the site's own files) | ✅ `src/platform/`, `docs/agent/` and `scripts/platform.mjs` are byte-for-byte the 0.10.13 template's. Kinroot's code lives in its own folders (`src/crm/`, `src/server/crm/`, its pages and tests). | Nothing. |
| **Nothing hidden**: no secrets | ✅ No keys or passwords in tracked files (the only match is a dummy key in a template test); `.env` is git-ignored; outside services' keys come only from `config.ownerSecret`. | Nothing. |
| **Nothing hidden**: no install scripts | ✅ No `postinstall` / `prepare` scripts; only the template's `allowScripts` (Prisma, esbuild, workerd). | Nothing. |
| **Nothing hidden**: exact versions | ⚠️ 11 packages use `^` ranges: `@astrojs/cloudflare`, `@astrojs/react`, `@tanstack/react-query`, `astro`, `hono`, `react`, `react-dom`, `xss`, `@types/node`, `@types/react`, `@types/react-dom`. They are the template's own (0.10.16 still has them); every package Kinroot added is exact, and the lockfile fixes what is installed. | **V-14** (S): pin those 11 to the versions in `package-lock.json` (no package changes, only the `^` goes). |

## Suggested order
1. V-6 (upgrade), then V-7 to V-11 (Kinroot's sign-in pages), V-12 (tests), V-13 (check). One commit.
2. V-14 (exact versions), in the same commit or right after.
