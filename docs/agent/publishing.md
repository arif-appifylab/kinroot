---
title: How changes go live, and the Preview
read-when: before git push, when the owner asks how changes go live, when the Preview misbehaves, or before changing scripts, dependencies or config
---
## Going live
- You edit a working copy. Nothing visitors see changes until the OWNER publishes from the
  the editor (typed "publish"). You cannot publish or deploy: there are no platform
  credentials here, and you never ask for any.
- Publish → Deployment: Prepare (detect the framework) → Build (`npm ci`, `npm run build`) →
  Migrate (pending `prisma/migrations` on the live Site Database; a failure keeps the old version
  live; destructive SQL waits for approval) → Deploy → Live. Redeploy of an earlier deployment is
  the rollback (database migrations stay applied: they must be backward-compatible, `database.md`).
- The site answers on its free address (`{{SITE_ORIGIN_PATTERN}}`) and on any custom domain the
  owner connects in the site's Domains tab. `{{API_PREFIX}}/*` on every one of those hosts is the
  platform's, never this app's.
- Before telling the owner it is ready: `npm run build` passes, `npm test` passes (with
  `TEST_DATABASE_URL` when a test database is available, `database.md`), the Preview
  shows every changed page, the forms follow AGENTS.md, and `security.md`'s checklist holds.

## What the platform expects (Prepare refuses otherwise)
- `astro` + `@astrojs/cloudflare` (14.x) in `package.json`; never `@astrojs/node|vercel|netlify`,
  never Next.js or another framework beside Astro.
- npm with ONE lockfile (`package-lock.json`, committed); `allowScripts` lists approved install
  scripts. No `wrangler.*` files (the platform writes the deploy config), no KV/R2/D1/queues/
  Durable Objects/service bindings, no `.github/workflows`.
- No `base` path, no `Astro.session`, no on-demand image transforms (`imageService: 'compile'`
  optimises prerendered images at build and passes the rest through), no secrets in files.
  `/robots.txt`, `/sitemap.xml` and `/rss.xml` are this site's own (`seo.md`): keep them.
- The Build prerenders with `{{SITE_URL_ENV}}` set to the site's address (that is how
  canonical URLs and the sitemap know it); nothing secret reaches the Build.
- The project sits at the repository root. `node_modules`, `dist`, `.env`, `.dev.vars`,
  `src/generated` are never committed (`.gitignore`).

## Preview (the editor)
- The editor runs `npm run dev` for the Preview pane: keep it working and serving at `/`. Never
  start a second dev server; never `npm run preview`.
- In the Preview, `SITE_PREVIEW=1`, `DATABASE_URL` is the Preview Database, `JWT_SECRET` and the
  Site Key are the editor's own. Sign-in works for real against the Preview Database, and the
  first account to confirm its email there becomes owner (no owner list in the Preview).
- The editor's gateway drops every `Cookie` and `Set-Cookie` header, so in the Preview the auth
  cookies travel in headers instead (`x-ezs-preview-cookie` / `x-ezs-preview-set-cookie`, kept
  by `src/platform/browser.ts` in the tab's `sessionStorage`; `src/platform/auth/preview-cookies.ts`).
  Consequences: the server never sees the session on a full page load there, so every page
  fills the visitor in in the browser and `/dashboard` starts the app and checks `/site-api/me`
  itself. Browser calls must go through `siteFetch()` / the portal's `api` (a plain `fetch` to
  `/site-api` is signed out in the Preview). The live site never sends or reads those headers.
- Account emails are relayed with links on the site's LIVE address. A confirmation or reset
  link for a Preview account therefore opens the live site, which does not know that token:
  open the same path on the Preview instead (`/account/verify/?token=…` in the Preview pane).
- The Preview is framed by the editor, so `X-Frame-Options` is not sent there; `sameOrigin` is
  skipped (the editor's gateway checks origins). Never rely on any of these differences in your
  code, and never build your own cookie or header workaround: use `siteFetch()`.
- Deployed server code reaches the platform, the Site Database and public APIs, never the
  platform's internal network (`security.md` › Calling other services); an owner secret added
  only in `production` is `null` in the Preview. Only a Publish proves the Build.

## Template upgrades
- `template.json` records the template version. `npm run platform -- check` says if a newer one
  exists; `npm run platform -- upgrade` (clean git tree, owner's OK) replaces the MANAGED paths
  (`src/platform/**`, `docs/agent/**`, `scripts/platform.mjs`, `CHANGELOG.md`) and 3-way merges
  everything else. Then read `CHANGELOG.md`, resolve conflicts, `npm install`, `npm run build`,
  `npm test`.
- `npm run platform -- docs` (or `--site <this site's address>`) saves the platform's live
  agent docs to `.platform/docs/`; when they differ from `docs/agent/`, the live ones win.

## Git
- Commit small, reviewable changes with clear messages. Push with plain `git push` to `origin`
  only when the owner set up a repository; never `--force`, `--all` or `--tags`.
