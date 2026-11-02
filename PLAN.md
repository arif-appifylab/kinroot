# Kinroot → EzyStudio Astro app: migration plan

Source: `~/Desktop/crm app` (Kinroot: TanStack Start + Hono + Prisma 7, 74 models, ~63k lines).
Template: `site-astro-app` 0.10.10. Rule: **no CRM feature changes**, only the code moved to the
template's stack and rules. Where a rule forces a visible change, it is listed below with the rule.

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Template copied here, git, install | done |
| 1 | Foundation: schema + migration, team model, Tailwind + Kinroot UI kit, `/crm` host page and router, CSP check | done |
| 2 | Shared infrastructure: server kit (guards → template), `enqueue()` → background jobs, files → platform storage, activity / audit / notifications / recycle bin | next |
| 3 | Core CRM: contacts, companies, deals, pipelines, notes, tasks, timeline, views, ⌘K search, custom fields, dashboard, team, profile, app shell | |
| 4 | Email: providers, templates + editor, tracking, inbound replies, Gmail / Outlook sync; inbox; live chat | |
| 5 | Forms, lists and segments, broadcasts | |
| 6 | Tickets + support portal, meetings + booking pages, calendar sync | |
| 7 | Lead scoring, reports, dashboards, goals, scheduled reports, automations | |
| 8 | Duplicates, import / export, outgoing webhooks, incoming webhooks, Data in API | |
| 9 | Public site pages (`/`, `/contact/`, `/demo/`), SEO, tests ported to vitest, build, `review.md` | |

## Where things live

| Kinroot app | Here |
| --- | --- |
| `src/routes/**` (file routes) | `src/crm/routes/**`, same file-route format; the router plugin in `astro.config.mjs` writes `src/crm/routeTree.gen.ts` (git-ignored) |
| `src/components`, `src/lib`, `src/styles.css` | `src/crm/components`, `src/crm/lib`, `src/crm/styles.css` (`@/…` = `src/crm`) |
| `src/server/**` | `src/server/crm/**` (phase 2), mounted in the template's Hono app |
| `src/platform/*` (own auth, db, crypto, guards) | gone; a small adapter in `src/server/crm/kit/` maps it onto the template's `src/platform` |
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
