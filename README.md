# Site — Astro app

A starter for a **website plus its own app**, built with [Astro](https://astro.build) on one
Cloudflare Worker:

- **Pages**: a home page made of sections and an about page (prerendered, served as files), a
  **blog** written as Markdown files (`src/content/blog/`, one page per post), and a **job board** with search and detail pages;
- **accounts of its own**: sign-up with email confirmation, sign-in, password reset, "sign out
  everywhere" — stored in your Site Database, secured with scrypt passwords, short-lived signed
  tokens, rotating refresh tokens and rate limits;
- **roles and permissions**: owner, admin and member out of the box, custom roles, and admin
  screens for users, roles and an activity log;
- a **dashboard** at `/dashboard` — a React app with [TanStack Router](https://tanstack.com/router)
  and [TanStack Query](https://tanstack.com/query), built on its own UI kit (`src/portal/ui/`:
  shell, cards, tables, drawers, dialogs, toasts, menus, forms, charts; light and dark), ready
  to build your own screens on (`docs/agent/ui.md`);
- your own **backend** at `/site-api` — a [Hono](https://hono.dev) app every page and screen
  reads through;
- your own **Site Database** — Prisma Postgres, through [Prisma ORM 7](https://www.prisma.io).

One project, one build, one deploy.

## Put it live

Pick **Astro app** when you create a site in the dashboard (or turn on "make it an app"), change what
you like in the editor (or ask your AI agent), then **Publish**.

**Enable the Site Database first.** This project ships migrations; a version with migrations is
refused until the site has a database. Only your account's owner can open the admin, with **View as
admin** in the dashboard. Anyone who signs up is a normal user, whatever email they use.

The platform sees `astro` and `@astrojs/cloudflare`, installs with `npm ci`, runs
`npm run build` (`prisma generate && astro build`), applies new migrations to your live database,
then deploys. If a migration fails, the previous version keeps serving.

## What this site controls

| Address | Served by |
| --- | --- |
| `/`, `/about/`, `/blog/`, `/jobs/` | this site |
| `/sitemap.xml`, `/robots.txt`, `/rss.xml` | this site (search engines, feed readers) |
| `/account/login`, `/account/register`, `/account/forgot`, … | this site (sign-in) |
| `/dashboard/…` | this site (the dashboard) |
| `/site-api/…` | this site (your API) |
| `/api/…` | the platform |

## Write a post

Add a Markdown file to `src/content/blog/` (`my-post.md` → `/blog/my-post/`) with a `title`,
`description` and `publishedAt` at the top (see `how-to-add-a-post.md` there), then Publish.

## Accounts

- The **owner** is your account's owner, who opens Kinroot with **View as admin** in the dashboard or the
  editor (it lands on `/crm/`). There's no owner sign-up, password or owner list, and the owner's account
  has no email address on the site: Kinroot shows it as "Account owner" and emails the owner through the
  platform. The owner invites the team in Settings → Team and manages site accounts and roles in
  Settings → Accounts and Roles.
- **On your machine** there is an owner only if this copy holds the site's Site Key (`SITE_URL` and
  `SITE_KEY` in `.env`): the owner route (`/site-api/auth/owner?ticket=…`) spends a "View as admin"
  ticket with the platform, as live and the Preview do. Without a Site Key there is no owner here, and
  accounts you sign up locally are normal users who join Kinroot by invite. (A local database made
  before this template version keeps its old owner while `SITE_OWNER_ID` is unset.)
- Confirmation and password-reset emails are sent by the platform on your site's behalf.
- Change how sign-up works in `src/server/auth-settings.ts`.

## Running it on your machine

```bash
cp .env.example .env     # set SITE_URL, a JWT_SECRET, and a DATABASE_URL to try sign-in
npm install
npx prisma migrate deploy   # creates the tables in that database (once, and after each new migration)
npm run dev              # http://localhost:4321
npm test                 # unit tests (auth crypto, tokens, rate limits)
# + integration tests (real Site API on a real Postgres; EMPTIES that database).
#   A throwaway Postgres, migrated, then the tests against it:
docker run -d --name site-test-pg -p 5470:5432 -e POSTGRES_PASSWORD=dev postgres:16
DATABASE_URL=postgresql://postgres:dev@localhost:5470/postgres npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5470/postgres npm test
npm run build            # the Worker, into dist/
```

`.env` is for your machine only and is git-ignored — never commit it.

## Changing the database

```bash
npx prisma migrate dev --create-only --name add_something   # 1. write the migration
# 2. wrap prisma/migrations/<…>/migration.sql in BEGIN; … COMMIT;
npx prisma migrate dev                                       # 3. apply it to the Preview Database
npx prisma generate                                          # 4. the client gets the new model
```

On your own machine these read `DATABASE_URL` from `.env`.

Migrations only move forward: never edit one that was applied, and change tables in steps (add,
fill, switch, drop later). `docs/agent/database.md` has the rules.

## Staying up to date

```bash
npm run platform -- check     # is a newer template release out?
npm run platform -- upgrade   # apply it, keeping your changes (commit first)
npm run platform -- docs      # the platform's latest agent docs
```

Where releases come from: `repo` in `template.json`. Today it is `file:templates/astro-app`, the
template's folder in a platform checkout (there is no published template repository yet):
set `SITE_DIR` to that checkout, or pass `--from <path to templates/astro-app>`. A folder
holds one version, so for a real 3-way merge also pass `--base <a copy of your current
version>`; without it, `upgrade` adds new files, replaces the managed ones and lists the files
you changed for you to compare. A GitHub `owner/name` with `vX.Y.Z` tags works the same way
once the templates are published.

## Where things are

```
AGENTS.md                rules for AI agents (CLAUDE.md, GEMINI.md import it)
docs/agent/              topic docs: auth, roles, security, performance, database, site API, SEO, publishing
template.json            which template version this site is on
scripts/platform.mjs     npm run platform -- docs | check | upgrade
prisma/                  tables, migrations, seed data
tests/                   unit tests; tests/integration/ = Site API on a real Postgres
public/_headers          security headers for prerendered pages
src/
  content/site.ts        navigation, home sections, about copy, SITE (description, language, address)
  assets/                images optimised at build (blog covers in assets/blog/)
  pages/                 the views (index, about, blog/, jobs/, account/, portal/, site-api/),
                         sitemap.xml, robots.txt, rss.xml
  portal/                the dashboard (React): routes.tsx, screens/, ui/ (the UI kit, docs/agent/ui.md)
  server/                YOUR backend: app.ts, routes/, auth-settings.ts, permissions.ts
  platform/              the MANAGED core (auth, guards, platform API): replaced on upgrade
  lib/                   shared types, form rules, browser form helpers, seo.ts (canonical URLs)
```
