# Kinroot

**Kinroot** is a CRM — contacts, companies, deals, a shared inbox with website chat, tickets with a
support portal, forms, booking pages, broadcasts, reports, dashboards, lead scoring and automations —
running as **one site**: its public pages and its app, built with [Astro](https://astro.build) on one
Cloudflare Worker, on the platform's Astro app template.

- **Public pages**: the home page, Contact us, Book a demo, the support portal, booking pages, forms,
  satisfaction surveys and unsubscribe pages (server-rendered, in Kinroot's design).
- **The CRM** at `/crm/` — a React app ([TanStack Router](https://tanstack.com/router) and
  [Query](https://tanstack.com/query)) with Kinroot's own UI kit, light and dark.
- **Accounts** of its own: sign-in by emailed code or password, two-step sign-in, signed-in devices —
  the template's auth, in Kinroot's design (`/account/…`, Settings → Profile and Security).
- **A backend** at `/site-api` — a [Hono](https://hono.dev) app; Kinroot's API is `/site-api/crm`.
- **A Site Database** — Prisma Postgres through [Prisma ORM 7](https://www.prisma.io).
- **Background work** on the platform's jobs: webhook deliveries, emails, mailbox and calendar sync,
  automations, scoring, report emails (`background.json`, `src/server/background.ts`).

One project, one build, one deploy.

## Put it live

**Enable the Site Database first** (this project ships migrations), then **Publish** from the editor.
The platform installs with `npm ci`, runs `npm run build`, applies new migrations to the live
database, then deploys. If a migration fails, the previous version keeps serving.

After the first Publish, open Kinroot once with **View as admin** in the dashboard: that makes you its
Owner and asks for the workspace's name. Then invite the team in Settings → Team.

## Addresses

| Address | What |
| --- | --- |
| `/`, `/contact/`, `/demo/` | the website |
| `/support/` | the support portal (new request, your requests) |
| `/book/<slug>/`, `/book/<handle>/<slug>/`, `/book/manage/<token>/` | booking pages, reschedule / cancel |
| `/f/<slug>/` | published forms |
| `/chat/` | the website chat (also a button on every public page) |
| `/csat/<token>/`, `/unsubscribe/…`, `/report-unsubscribe/…` | links in emails |
| `/account/login/`, `/account/register/`, … | sign-in pages |
| `/crm/…` | the CRM |
| `/dashboard/…`, `/portal/…` | old addresses: redirect to `/crm/…` (the platform's one-click sign-in opens them) |
| `/sitemap.xml`, `/robots.txt`, `/rss.xml` | search engines and feed readers |
| `/site-api/…` | the backend; `/api/…` is the platform's |

## Accounts

- The **owner** is your account's owner, who opens Kinroot with **View as admin** in the dashboard or the
  editor (it lands on `/crm/`). There's no owner sign-up, password or owner list, and the owner's account
  has no email address on the site: Kinroot shows it as "Account owner" and emails the owner through the
  platform. The owner invites the team in Settings → Team and manages site accounts and roles in
  Settings → Accounts and Roles.
- **Team members** sign up (or sign in) with the address they were invited with and join from the invite
  link. Their role in Kinroot (Owner, Admin, Member, Viewer) is set in Settings → Team.
- **Customers** who use the support portal have accounts too, with no access to the CRM.
- **On your machine** there is an owner only if this copy holds the site's Site Key (`SITE_URL` and
  `SITE_KEY` in `.env`): the owner route (`/site-api/auth/owner?ticket=…`) spends a "View as admin"
  ticket with the platform, as live and the Preview do. Without a Site Key there is no owner here, and
  accounts you sign up locally are normal users who join Kinroot by invite. (A local database made
  before this template version keeps its old owner while `SITE_OWNER_ID` is unset.)
- Sign-in and password emails are sent by the platform on the site's behalf. Kinroot's own emails
  (replies, broadcasts, notifications) go out through the mailboxes connected in Settings → Email.

## Running it on your machine

```bash
cp .env.example .env     # set SITE_URL, a JWT_SECRET, and a DATABASE_URL to try sign-in
npm install
npx prisma migrate deploy   # creates the tables in that database (once, and after each new migration)
npm run dev              # http://localhost:4321 (the CRM at /crm/)
npm test                 # unit tests
# + integration tests (the real Site API on a real Postgres; they EMPTY that database):
TEST_DATABASE_URL=postgresql://postgres@localhost:5479/kinroot_test npx vitest run --hookTimeout=180000
npm run typecheck
npm run build            # the Worker, into dist/
```

`.env` is for your machine only and is git-ignored — never commit it. On your machine background jobs
run as they are sent, inside the request.

## Changing the database

```bash
npx prisma migrate dev --create-only --name add_something   # 1. write the migration
# 2. wrap prisma/migrations/<…>/migration.sql in BEGIN; … COMMIT;
npx prisma migrate dev                                       # 3. apply it
npx prisma generate                                          # 4. the client gets the new model
```

Migrations only move forward: never edit one that was applied. No list columns (`String[]`) and no
array parameters in raw SQL: the live database driver can't handle them (`docs/agent/database.md`;
`tests/no-array-columns.test.ts` checks). `docs/agent/database.md` has the rules.

## Staying up to date

```bash
npm run platform -- check     # is a newer template release out?
npm run platform -- upgrade --from <new template> --base <this version's template>   # commit first
npm run platform -- docs      # the platform's latest agent docs
```

`UPGRADE-0.10.13.md` records the last upgrade and what Kinroot changed for it. Kinroot removed the
template's blog, job board, checkout and dashboard: an upgrade adds their files back, so delete them
again (`upgrade.md` in `docs/agent/`).

## Where things are

```
AGENTS.md                rules for AI agents (CLAUDE.md, GEMINI.md import it); "This site" = Kinroot's notes
PLAN.md, AUDIT.md        the migration plan and the audit, with what is done
docs/agent/              the platform's topic docs (managed)
prisma/                  tables (schema.prisma), migrations, seed data
background.json          background job types and schedules (crm-tick, crm-sync, crm-prune)
tests/                   unit tests; tests/integration/ = the Site API on a real Postgres
src/
  pages/                 public pages, /crm/ host page, account/, site-api/, sitemap, robots, rss
  layouts/               CrmPublic.astro (public pages), Crm.astro (the app)
  crm/                   the CRM app (React): routes/, components/ (ui/ = the UI kit), lib/, public/
  server/                the backend: app.ts, auth-settings.ts, permissions.ts, background.ts
  server/crm/            Kinroot's API: routes/, lib/, inbox/, email/, calendar/, scheduling/, kit/
  platform/              the MANAGED core (auth, guards, database, jobs, files, cache): replaced on upgrade
  lib/                   shared rules, form helpers, seo.ts, idempotency.ts, page-progress.ts
```
