# Kinroot → EzyStudio Astro app: migration plan

Source: `~/Desktop/crm app` (Kinroot: TanStack Start + Hono + Prisma 7, 74 models, ~63k lines).
Template: `site-astro-app` 0.10.10. Rule: **no CRM feature changes**, only the code moved to the
template's stack and rules. Where a rule forces a visible change, it is listed below with the rule.

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Template copied here, git, install | done |
| 1 | Foundation: schema + migration, team model, Tailwind + Kinroot UI kit, `/crm` host page and router, CSP check | done |
| 2 | Server: all of Kinroot's server code moved to `src/server/crm`, compiling and mounted at `/site-api/crm`; kit on the template's auth, database, jobs and storage; team, invites, uploads, exports / imports storage; integration tests | done |
| 3 | Core CRM screens: shell, setup, invite, no-access, profile, contacts, companies, deals, pipelines, notes, tasks, timeline, views, ⌘K search, custom fields, dashboard, team (all signed-in screens compile; public pages are their phases) | done |
| 4 | Email: providers, templates + editor, tracking, inbound replies, Gmail / Outlook sync; inbox; live chat | done |
| 5 | Forms, lists and segments, broadcasts | done |
| 6 | Tickets + support portal, meetings + booking pages, calendar sync | done |
| 7 | Lead scoring, reports, dashboards, goals, scheduled reports, automations | done |
| 8 | Duplicates, import / export, outgoing webhooks, incoming webhooks, Data in API | next |
| 9 | Public site pages (`/`, `/contact/`, `/demo/`), SEO, tests ported to vitest, build, `review.md` | |

## Where things live

| Kinroot app | Here |
| --- | --- |
| `src/routes/**` (file routes) | `src/crm/routes/**`, same file-route format; the router plugin in `astro.config.mjs` writes `src/crm/routeTree.gen.ts` (git-ignored) |
| `src/components`, `src/lib`, `src/styles.css` | `src/crm/components`, `src/crm/lib`, `src/crm/styles.css` (`@/…` = `src/crm`) |
| `src/server/**` | `src/server/crm/**`, mounted at `/site-api/crm` (`crmHooks` before `csrf`, `crmApp` after; `src/server/app.ts`) |
| `src/platform/*` (own auth, db, crypto, guards) | `src/server/crm/kit/`: the same names (`createDb`, `loadUser`, `requireRole`…) on the template's auth, database, storage |
| `Job` table + `/jobs/run` cron | `enqueue()` sends platform jobs (`crm-<type>` lists, `background.json`, handlers in `src/server/background.ts`); schedules `crm-tick` (1 min), `crm-sync` (5 min), `crm-prune` (daily) |
| `File.data` bytes | platform storage (`kit/storage.ts`); uploads in two calls + the browser's PUT (`lib/uploads.ts`) |
| `__root.tsx` head (title, favicon, fonts, theme, brand colours) | `src/layouts/Crm.astro` + host page `src/pages/crm/[...path].astro` |

## Decisions (made in phase 1)

- **Team = `Member` table**, its own `cuid` ids (so every CRM foreign key and the code that uses
  them stay as they were), one link `userId → users.id`. Team roles Owner / Admin / Member / Viewer
  stay Kinroot's own data (`Member.role`, enum `TeamRole` because the template has a `Role`
  model) as `roles-and-permissions.md` › Teams prescribes. Invites stay: a pending `Member` with
  `inviteEmail`, a hashed token and an expiry; accepting links the signed-in account whose
  verified email matches. `name` is a display copy of `users.name`, synced on each request;
  emails are never copied (join `user`).
- **First owner:** holders of the site codename `site:crm:own` (owners, via `*`) become a team
  Owner on their first visit. This replaces `/setup`.
- **Kinroot table names kept** (PascalCase, no `@@map`) so its raw SQL keeps working; template
  tables keep theirs. Enums kept as Postgres enums. Ids stay `cuid` strings.
- **Removed models:** `User` (→ `Member` + template `users`), `Session` (template auth), `Job`
  (platform background jobs), `FileChunk` (platform storage). `File.data` (bytes) →
  `File.storageId` (platform `file_…` id).
- **One migration** `20261102120000_kinroot_crm` (fresh install; Kinroot had no live data to carry).
- **Design kept:** Tailwind 4 (`@tailwindcss/vite`), Radix, lucide, sonner, as in Kinroot. This
  departs from `ui.md` ("one UI kit"); the owner chose to keep Kinroot's look.
- **CSP:** unchanged. Theme boot script is inline with its hash added per page
  (`Astro.csp.insertScriptHash`); fonts self-hosted (`@fontsource-variable/plus-jakarta-sans`,
  never inlined as `data:`); sonner's CSS and Radix's scroll lock CSS loaded from
  `src/crm/styles.css` (their runtime `<style>` injection is blocked, harmless: sonner still logs
  one CSP message per page load).
- **Address:** the CRM lives at `/crm/…`. TODO phase 3: Kinroot's dashboard (`/admin`) becomes
  `/crm/` (today `src/crm/routes/index.tsx` is a temporary foundation check).

## Decisions (phase 2)

- Kinroot's API lives under `/site-api/crm/*` (the template already uses `/site-api/auth` and `/site-api/jobs`).
- `c.var.user` is the `Member` row plus the viewer's OWN email. Another member's email is joined
  (`withEmail`, `memberWithEmail`) only server side, to send them mail; lists and pickers carry
  no emails (`userSelect`); the team list shows full addresses only to their owner and the site's
  owner, masked to everyone else (`publicUser`), the template's own rule.
- Audit log: actor emails stored masked, IPs as a keyed hash (the template's "no raw IPs").
- Exports: CSV built in `ExportChunk` rows by jobs, streamed into storage as one file at the end.
  The "Owner email" column shows the requester's own address, other owners' masked.
- Setup: the Owner's first visit asks for the workspace name and demo data (no account form).
  The demo teammate is a `Member` without an account (no demo password).
- Invites: token hashed, 14 days, bound to the verified signed-in account with that email.
- OAuth client secrets: owner secrets `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` (IDs may be
  saved in Settings or added as `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID`).
- Stored secrets (mailbox / calendar tokens) and signed links use keys derived (HKDF) from the
  owner secret `KINROOT_SECRET_KEY` when added, else `JWT_SECRET`.
- `@hono/zod-validator` kept (it is `hono/validator` with zod schemas) and TypeScript added as a
  dev tool (`npm run typecheck`; the template's own files have 11 errors of their own).

## Decisions (phase 3)

- The CRM's home (Kinroot's `/admin` dashboard) is `/crm/`; every other screen keeps its path under `/crm`.
- Signed-in screens: Kinroot's `_app` file routes as they were; `_app.tsx` sends signed-out visitors to the
  site's `/account/login/` and signed-in non-members to `/crm/no-access`; the Owner's first visit to `/crm/setup`.
- Profile: the name is the account's (`PATCH /site-api/auth/me`, then Kinroot's copy); password, two-step
  sign-in and devices link to the site's `/dashboard/account`.
- Brand: `GET /site-api/crm/public/brand` (Site Cache, 1 day, cleared on save) and `/public/brand.css`
  (validated `#hex` colours only); the root route loads it for `useBrand()`, the host page for the head.
- "Last seen" in Settings → Team is refreshed on requests, at most every 10 minutes.

## Decisions (phase 4)

- SMTP removed (`email/smtp.ts`, `email/socket.ts` deleted); old SMTP accounts refuse to send with a message.
- API keys: owner secrets `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `SENDGRID_API_KEY`, `MAILGUN_API_KEY`
  (`email/providers.ts` `withKey`); an account stores only its non-secret settings. Settings → Email shows
  which are added (`GET /email/secrets`, names and yes / no) and no key fields.
- Every call to a mail / calendar service has a 15 s timeout (`kit/outbound.ts` `fetchOut`).
- Inbound webhook: the URL token plus the sender's proof (`email/inbound-auth.ts`): Resend Svix signature
  (`RESEND_WEBHOOK_SECRET`), Mailgun signature (`MAILGUN_WEBHOOK_SIGNING_KEY`), Postmark / SendGrid Basic
  credentials in the URL (`INBOUND_BASIC_AUTH`, `user:password`). Unit tests in `tests/crm-inbound-auth.test.ts`.
- Email HTML (inbox, editor preview, report email preview) renders in a shadow root (`components/email-frame.tsx`),
  not a `srcdoc` iframe, which inherited the CSP and lost every inline style.
- Live chat: `widget.js` carries its settings (worked out from the embedding page's Referer) and its button
  opens `/chat/` (an Astro page, `src/pages/chat/`) as a small window; `/chat/c/<token>` continues a chat from an
  email. Visitor calls go through `siteFetch` (CSRF); chat settings are in the Site Cache (10 min, cleared on save).

## Decisions (phase 5)

- Turnstile removed everywhere (forms, chat, settings; `components/forms/turnstile.tsx` deleted). Every form keeps
  its honeypot and speed check and gets rate limits per hashed address: 5 responses a minute, 40 an hour,
  30 uploads an hour (`routes/forms-public.ts`). Chat was already rate limited.
- Hosted form `/f/<slug>`: an Astro page (`src/pages/f/[slug].astro`) with Kinroot's renderer; a missing form is
  a 404, a failed read a 503. Public React pages get the brand through `BrandProvider` (`lib/use-brand.ts`).
- `embed.js`: `data-crm-form` becomes a button (`data-label`, `data-color`), `data-crm-form-popup` opens the form;
  both open `/f/<slug>` in a small window with the page's UTM parameters and address.
- Broadcast batches stop after 40 s (a job run has 60 s) and look up unsubscribes and contacts once per batch.
  With the default 10 jobs a minute, a large broadcast sends about 250 emails a minute.

## Decisions (phase 6)

- Support portal on the site's sign-in: no portal cookie, no `/support/link`, `/support/session`, `/support/logout`.
  A customer is the signed-in account with a CONFIRMED email; every contact with that address is theirs
  (`portalSession` in `routes/support-public.ts`), and a ticket answers only when its contact is one of them
  (another customer's number: `null` / 404). Emails link to `/support/tickets/<n>` and say "sign in (or create
  your account) with this email address". Signing out uses the site's `/site-api/auth/logout`.
- Public pages are Astro pages with React islands (`client:only`) in `CrmPublic.astro`, wrapped by `PublicPage`
  (`src/crm/public/public-page.tsx`: React Query, brand, layout, toasts, confirmations): `/support/`,
  `/support/tickets/`, `/support/tickets/<n>`, `/book/<handle>/<slug>`, `/book/manage/<token>`, `/csat/<token>`,
  `/unsubscribe/<token>`, `/report-unsubscribe/<token>`. A missing link or bad token is a 404, a failed read a 503;
  token pages are `no-store` and send no referrer.
- Meetings → "Embed": the iframe snippet becomes a "Book a meeting" button linking to the booking page.
- Support requests and bookings get per-connection limits (5 a minute, 20 an hour; `connectionLimits` in
  `lib/rate-limit.ts`): both email the address typed in (`security.md` A06). Honeypot and speed check stay.
- TipTap's base CSS is in `src/crm/tiptap.css` with `injectCSS: false`: the CSP blocked the `<style>` it injects
  (every editor, CRM and portal).
- Calendar sync already used owner secrets and the outbound helper (phase 4); nothing to change.

## Decisions (phase 7)

- Report builder SQL: every query is ONE `Prisma.sql` run with the tagged `$queryRaw`. Values (ids, dates, the
  zone, filter values, the date bucket, custom-field keys) are bound parameters; the only text pasted in is the
  constant SQL of the object and field definitions in code (`code()` in `lib/reports.ts`). `RefDef.sql` is
  `(ids) => Prisma.sql`, `list` a `Prisma.sql`, `scopeSql` `(me) => Prisma.sql`. Same for the automation date and
  inactivity triggers (`lib/automations.ts`): table and owner column from fixed maps, values bound.
  No `$queryRawUnsafe` is left in Kinroot's code.
- Automation "Send a webhook" step: only to the webhook services in `src/crm/lib/webhook-targets.ts` (Zapier,
  Make, n8n Cloud, Pipedream, Slack, Microsoft Teams, Google Chat, Discord, IFTTT), https only, no credentials or
  port. Checked in the editor, when switching on (`automationProblems`) and again before each send (visible
  change 3). Phase 8's Settings → Webhooks reuses the same list.
- `/site-api/crm/auth/state` answers `401 token_expired` for an expired session, so `siteFetch` refreshes it:
  before, the CRM bounced through the sign-in page every 10 minutes.
- Report builder dropdowns ("Group by", "Break down by", measure field, "Date range on") listed only "None": the
  field options came from a component `NativeSelect` can't read. Same bug in the original; fixed
  (`fieldOptions()` in `components/reports/builder.tsx`).
- Tests: `crm-reports` (buckets, tags, custom fields, every filter, breakdown, refs, member scope),
  `crm-automation-triggers` (date, custom date, inactivity fire once), `crm-webhook-targets`, expired session.

## Open items (tracked)

- Plain `<a href>` links to `/site-api/crm/...` downloads (exports, files) carry the session by cookie: fine live, signed out in the editor Preview.
- Email preview frame (`components/inbox/parts.tsx`) inherits the page CSP: check its styles in phase 4.
- `routes/incoming-webhooks.ts`, `routes/data-in.ts` store raw IPs in their request logs (phase 8).
- Brand logo is still a data URL in the settings row (file bytes in the database): move to a public storage file.
- The sonner toast library logs one CSP message per page load (its CSS loads from our stylesheet; harmless).
- Report filter picker lists every company name to members limited to their own records (as before; contacts are not listed).
- Automation merge field `{{owner.email}}` puts the record owner's address in emails to contacts, as before.

## Visible changes the rules force (approved by the owner)

1. SMTP sending removed (no raw TCP). Resend, Postmark, SendGrid, Mailgun, Gmail / Outlook stay.
2. Provider API keys and OAuth client secrets come from owner-added secrets
   (`config.ownerSecret`), not pasted in Settings. Settings shows which are added.
3. Outgoing webhooks and the automation "webhook" step: only to a fixed list of services written in
   code (Zapier, Make, Slack, n8n cloud…), never any URL typed in (`security.md` › Calling other services).
4. Embeds on other websites (form embed / popup script, chat widget, booking `?embed=1`) become a
   link or button that opens the hosted page (no CORS, `X-Frame-Options: DENY`).
5. Turnstile removed (outside script blocked by the CSP): rate limits + honeypot instead.
6. Support portal magic link → the site's own sign-in (6-digit code), tickets matched by verified email.
7. Inbound email and incoming webhooks verify the sender's signature with an owner-added signing secret.
8. No first-run `/setup`: the platform makes the owner. "Load demo data" becomes an owner-only button.
9. Owner turns on Storage (a pack) for uploads; jobs default to 10 new a minute (batched to fit).

## Working locally

Dev server: `npm run dev` (port 4321) with `.env` (local Postgres, `SITE_PREVIEW=1`). Locally no email is sent, so the
test owner account was confirmed in the local database; its address and password are in `.env` (`DEV_OWNER_*`).


```bash
# throwaway Postgres (phase-1 setup; any Postgres works)
LC_ALL=C initdb -D <dir> -U postgres -A trust
pg_ctl -D <dir> -o "-p 5479 -c listen_addresses=localhost -c unix_socket_directories=''" start
createdb -h localhost -p 5479 -U postgres kinroot
npx prisma migrate deploy          # .env points DATABASE_URL at it
npm run build && npm test          # TEST_DATABASE_URL=… for the integration tests
```

The CSP only applies to the BUILT site: check CSP-sensitive UI with `npx astro preview` after a
build (`.dev.vars` with `SITE_PREVIEW=1`, copied into `dist/server/`, opens `/crm` without a sign-in).
