---
title: Upgrading a site to the current template
read-when: this site's template.json is older than the required version in AGENTS.md, or the owner asks to upgrade
---
A site's code stays as it was built. Rules reach it at once, but fixes only reach it through an upgrade and a
Publish. Below the required version, upgrade as your first step without asking (`AGENTS.md`). Nothing reaches visitors until they publish.

## Steps
Start with a clean git tree: commit or stash first.
1. Get the template and apply it. In the editor, `SITE_KEY` and `SITE_URL` are already set:
   ```bash
   rm -rf /tmp/site-template /tmp/site-template.zip
   curl -fsS -H "Authorization: Bearer $SITE_KEY" "$SITE_URL{{API_PREFIX}}/site/v1/template/download" -o /tmp/site-template.zip
   mkdir /tmp/site-template && unzip -q /tmp/site-template.zip -d /tmp/site-template
   npm run platform -- upgrade --from /tmp/site-template
   ```
   On your own machine without a Site Key: download the App template from the dashboard, unzip it, and use `--from` the same way.
   Plain `npm run platform -- upgrade` fails with `no template.json`: always pass `--from`.
2. It replaces the managed files and lists what it left as it was. Go through that list. Keep this site's own changes.
3. **Required for 0.10.11**, because `package.json` and `prisma/schema.prisma` are usually on that list. Skip what's already there:
   - `package.json` → `dependencies`, these exact versions: `"@prisma/driver-adapter-utils": "7.10.1"`, `"@prisma/ppg": "1.0.1"`,
     `"pg-types": "4.0.2"`, `"postgres-array": "3.0.4"`. On another Prisma version, move Prisma to the template's first.
   - `prisma/schema.prisma`:
     - in `model User`: `platformOwnerId String? @unique @map("platform_owner_id") @db.VarChar(64)`
     - in `model AuthState`: `ownerEnvId String? @map("owner_env_id") @db.VarChar(64)`
     - in BOTH `generator` blocks: `previewFeatures = ["relationJoins"]`
     - the new `model IdempotencyKey`, copied whole from `/tmp/site-template/prisma/schema.prisma`
   - The new migration folders arrive with the upgrade. Never edit them.
   - Checkout keys, so a double click or a retry can't start a second checkout. Copy these five from `/tmp/site-template/`; if this site
     changed one, bring the `idempotency` and `paid` lines into its copy instead: `src/lib/idempotency.ts`, `src/lib/checkout-session.ts`,
     `src/lib/checkout-transport.ts`, `src/lib/buy-button.ts`, `src/server/routes/checkout.ts`.
   - The page progress bar, for an older site (an optional extra, skip it if it clashes): copy `src/lib/page-progress.ts`, the `.page-progress` block at the end of `src/styles/global.css`, and the `installPageProgress` lines in `src/layouts/Base.astro` and `src/portal/PortalApp.tsx`.
   - Anything this site charges, books or limits with its own code: bring it up to `docs/agent/orders-and-stock.md`, and tell the owner what you changed.
   - In this site's own code, remove anything that makes an owner: `ownerEmails` in `src/server/auth-settings.ts`, a hardcoded address,
     a seeded admin, a read of `SITE_OWNER_EMAILS` or `config.ownerEmails`. To email the owner, send kind `notification` with no `to`.
   - A `String[]` column: move it to a related table or `Json` (`database.md`).
   - The template's own tests: copy them over, because old copies check old behaviour: `cp -R /tmp/site-template/tests/. tests/`. Tests this
     site added stay. If it changed one of the template's tests, redo that change after copying.
4. Check it:
   ```bash
   npm install
   npx prisma generate
   npx prisma migrate deploy
   npm test
   npm run build
   ```
   `tests/upgrade.test.ts` fails with what's missing if a schema line was skipped.
5. In the Preview: open the admin with the shield in the bar, sign up as a normal user and check they get no admin, and check the pages this site changed.
6. Commit, do the owner's task, and at the end tell them in plain words, and that it goes live when they publish:
   - Password sign-up and sign-in work now, and pages load faster.
   - After publishing, they open the admin once with **View as admin** in the dashboard. It's the only way in from now on.
   - Whoever was an owner in the site before is now a normal user, and admins stay. Team members get in by signing up on the app; the owner gives them a role under Users.

## If it can't finish
Stop before committing, restore with `git checkout .` and `git clean -fd` on what the upgrade added, do the owner's task, and tell them it didn't finish. The site keeps
working as it did, and you try again next session. Never publish a half-done upgrade.
