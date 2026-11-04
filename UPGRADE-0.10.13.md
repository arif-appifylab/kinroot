# Template 0.10.10 → 0.10.13: what Kinroot should update

Kinroot is built on template **0.10.10**. Three releases came out since (`~/Downloads/site-astro-app-0.10.13`,
`CHANGELOG.md`). **0.10.11 is a required security upgrade**: the platform's rules now say a site below it must be
upgraded before any other work. Nothing reaches visitors until a Publish, and the site has never been published.

**How to approve:** tick boxes or reply with IDs ("all", "U-1 to U-6"…). Nothing below is done yet.

---

## A. What the new template fixes (comes with the upgrade itself)

| ✓ | ID | What changes | Why it matters for Kinroot | Effort |
|---|---|---|---|---|
| [ ] | U-1 | **Passwords: PBKDF2 (600k) → scrypt.** The live Worker refuses PBKDF2 above 100,000 iterations, so on the deployed site **every password sign-up and sign-in fails with a 500** (tests pass because Node allows it). | Kinroot's sign-in pages, Security tab and invites use passwords: they would be broken live. Managed code; no Kinroot change. | in U-5 |
| [ ] | U-2 | **Database over one WebSocket per request.** A query goes from ~130 ms to ~3 ms (10 reads: 1.3 s → 40 ms). New managed `src/platform/db-socket.ts`, used by `getDb()`. | Kinroot already gets its client from `getDb()`, so every CRM screen, poll and job gets faster with no Kinroot code change. Many audit speed items become less urgent. | in U-5 |
| [ ] | U-3 | **`catch P2002` works on the live database** (duplicates gave 500s before). | Kinroot catches unique-key conflicts in several places (invites, keys, deduped jobs). | in U-5 |
| [ ] | U-4 | **The owner comes only from "View as admin"** in the dashboard (or the shield in the Preview). Removed: owner by email (`SITE_OWNER_EMAILS`), by sign-up, code, password reset or the first account. Fixes an **admin takeover**: someone who registered the owner's address first kept their password. The owner account has no email, password or two-step on the site and can't be suspended or demoted. | Kinroot's CRM Owner is the site owner (`site:crm:own`). See section B for what Kinroot must adapt. | in U-5 |

## B. The upgrade steps (from `docs/agent/upgrade.md`)

| ✓ | ID | Step | Notes for Kinroot | Effort |
|---|---|---|---|---|
| [ ] | U-5 | Run `npm run platform -- upgrade --from ~/Downloads/site-astro-app-0.10.13`: replaces `src/platform/**`, `docs/agent/**` (adds `upgrade.md`, `orders-and-stock.md`), scripts, `template.json`, merges `AGENTS.md`. | Needs a **clean git tree first** (today it holds the clean-ups and the half-finished audit fixes: see "Order" below). | S |
| [ ] | U-6 | `package.json`: add `@prisma/driver-adapter-utils 7.10.1`, `@prisma/ppg 1.0.1`, `pg-types 4.0.2`, `postgres-array 3.0.4`; `npm install` (one lockfile). | Kinroot's own dependencies stay. | S |
| [ ] | U-7 | `prisma/schema.prisma`: `User.platformOwnerId`, `AuthState.ownerEnvId`, the new `IdempotencyKey` model; the two new migrations (`owner_from_platform`, `idempotency_keys`). | Their dates (2 Nov, 09:00 and 10:00) sort before Kinroot's own migrations; fine on a never-published database, and the local databases get them with `migrate deploy`. | S |
| [ ] | U-8 | Template's own code: `src/server/app.ts` (no `ownerClaimMode` / `ownerSetup` in `/health`), `src/server/auth-settings.ts` (no `ownerEmails`), `src/env.d.ts` (`SITE_OWNER_ID`, `SITE_DB_TRANSPORT`), `.env.example` (`SITE_OWNER_ID` instead of `SITE_OWNER_EMAILS`). | Kinroot removed the dashboard, blog, jobs and checkout files the template also updated: those updates are skipped, the checkout "idempotency" copy step too (Kinroot sells nothing). | S |
| [ ] | U-9 | Template tests: copy the new ones (`owner`, `idempotency`, `db-socket`, `upgrade`, `password`, auth/admin/preview updates), then **redo Kinroot's changes** to them (no job board or checkout tests, no `jobs` table in the reset, permissions without "Manage jobs"). Skip `list-page` and the checkout tests (features Kinroot doesn't have). | `tests/upgrade.test.ts` fails if a schema line is missing. | M |

## C. What Kinroot's own code must adapt (because of U-4, the new owner)

| ✓ | ID | Change | Why | Effort |
|---|---|---|---|---|
| [ ] | U-10 | **The owner has no email address on the site** (`viewer.email` is empty). Every Kinroot email meant for the owner (notifications, report emails, import / export done, mentions, digests) must go as a platform `notification` **with no `to`** (the platform delivers it to the owner). The owner's team row shows "Account owner" instead of an address. | Today those emails would silently go nowhere. | M |
| [ ] | U-11 | **Settings → Security** for the owner: a card "You're the site owner: your access comes from the dashboard (View as admin)", no password, two-step or delete account (as the template's account screen now does). **Settings → Accounts**: the owner row shows "Comes from the dashboard" and has no actions. | The backend refuses those actions for the owner; the screens should not offer them. | S |
| [ ] | U-12 | **Kinroot's tests**: the `owner()` helper signs in through a "View as admin" ticket (the template's new `ownerSignedIn`), and tests that relied on the owner's email address use a teammate instead. | The old helper made an owner by sign-up + role, which no longer counts. | M |
| [ ] | U-13 | **Local development**: to open the CRM as owner on this machine, add the site's **Site Key** to `.env` and open it with "View as admin" (the `DEV_OWNER_EMAIL` / `DEV_OWNER_PASSWORD` account becomes a normal user). I'll write the steps in the README. | The template allows the owner locally only with a Site Key. | S |
| [ ] | U-14 | One-click sign-in into Kinroot (`/portal/?owner_ticket=…` → `/crm/`): re-check against the new owner route and keep it working. | Kinroot redeems the ticket itself since Phase 10. | S |

## D. New rules Kinroot's code must follow

| ✓ | ID | Change | Why | Effort |
|---|---|---|---|---|
| [ ] | U-15 | **No `String[]` columns** (new database rule): Prisma's live driver mishandles them: writes fail with `malformed array literal`, reads crash. Kinroot has **22**: tags on contacts, companies, deals and tickets; email `to`/`cc`/`bcc`; file ids on messages, ticket messages and the recycle bin; custom field options; webhook events; goal kinds; booking hosts; calendar ids; duplicate reasons; import headers; export columns; report schedule users / emails / delivered; meeting attendees. Move each to `Json` (opaque lists) or a related table (tags, which are filtered and grouped), with a data-keeping migration, and update every query that uses them (segments, filters, reports' tag grouping, automations and scoring on tags, imports / exports, bulk tag). Also stop binding JS arrays as `::text[]` parameters in raw SQL (use `Prisma.join`). | **The CRM would break on the live site** wherever these are written or read. Our local Postgres doesn't show it. | L |
| [ ] | U-16 | **Bookings: once, and never twice** (`orders-and-stock.md`): the database refuses two bookings of the same host at overlapping times (a constraint or a short lock, not a read-then-write), and the booking form sends an idempotency key so a double click or retry books once. A test books the same slot many times at once. | Today two visitors can book the same slot at the same moment, and a double click can book twice. | M |
| [ ] | U-17 | **Repeatable public submissions** (support request, form response, chat start): an idempotency key from the browser so a retry after a lost connection doesn't create a second one (the new database connection never re-sends a write, so the browser retries). | Duplicate tickets, responses or chats. | S–M |
| [ ] | U-18 | **Page progress bar** (0.10.12): the template's `src/lib/page-progress.ts` (the thin bar in the site's colour while the next page loads) in Kinroot's router and public pages. Optional in the guide; the UI rules now say it's built in and not to add another. | Same feel as the template, in Kinroot's colours. | S |
| [ ] | U-19 | **Caching guidance** (every query is now billed, a cache read isn't): review Kinroot's caches (brand, chat settings, website, and the settings caches the audit adds) against `cache.md` "How caches go wrong", and check every write clears them. | Aligns with audit P2-21 / P2-26. | S |

## Not needed for Kinroot
- **List pages** (`src/lib/list-page.ts`, 0.10.13): for long public lists (jobs, products). Kinroot has no public lists, and its CRM lists keep their page numbers (your decision today).
- **Checkout idempotency files** and payment docs: Kinroot sells nothing (removed in the clean-up). The platform's own idempotency module comes with U-5 and is used by U-16 / U-17.
- `live-migrations.json` and `data-ability`: editor and template features, nothing to change.

## Changes to the audit plan
- **P3-24 (Load more instead of page numbers): dropped**, as you asked. Lists keep their pagination.
- **P2-23 (bulk tag)** and the report engine's tag grouping are redone as part of U-15 (tags stop being arrays).
- Audit speed items (P2-20, P2-21, P2-22…) still apply but matter less once U-2 makes each query ~3 ms.

## Suggested order
1. **Finish and check wave 1** of the audit fixes (the six agents are paused mid-way by the usage limit; their partial edits are in the working tree). Commit, so the tree is clean.
2. **Upgrade** (U-5 to U-9), then the owner adaptations (U-10 to U-14). Commit.
3. **`String[]` → Json / tables** (U-15). Commit.
4. Bookings and repeatable submissions (U-16, U-17), progress bar (U-18), cache review (U-19).
5. The rest of the audit (wave 2 without paging, docs, dead code, flaky tests), the full build, tests, browser and CSP checks.

(The platform's rule is "upgrade first". Step 1 comes before it only because the working tree must be clean for the
upgrade, and the half-finished fixes are easier to finish than to undo.)
