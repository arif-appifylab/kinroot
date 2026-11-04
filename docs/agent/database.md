---
title: Site Database: Prisma Postgres, schema, indexes, migrations
read-when: before touching Prisma, the schema, a migration, seed data or any table
---
The Site Database is Prisma Postgres, one per site (live) plus a separate Preview Database in the
editor. Prisma ORM 7 ONLY (`prisma`, `@prisma/client`, `@prisma/adapter-ppg`, `@prisma/adapter-pg`
pinned to 7.x). Generator `prisma-client`, `runtime = "workerd"`, output `src/generated/prisma`
(git-ignored; `npm run build` runs `prisma generate`); a second, test-only generator writes a Node
build to `src/generated/prisma-node` (never import it). `getDb()` returns the request's client, or
`null` without `DATABASE_URL`. The driver follows the URL's host: `*.prisma.io` (live, Preview) →
`src/platform/db-socket.ts`, one WebSocket per request; any other host (a local Postgres, tests) →
`adapter-pg` over TCP. Deployed sites only ever get Prisma Postgres (raw TCP is blocked there).

## Connections (serverless)
- ONE client per request from `getDb()` (`c.var.db` in routes): never `new PrismaClient()`,
  never a client in module scope, never one shared across requests.
- Live and Preview (`*.prisma.io`): `src/platform/db-socket.ts`. ONE WebSocket per request, opened
  on the first query and shared by everything in that request. There is no pool to size: Prisma
  Postgres pools on its side. Prisma's HTTPS driver stays underneath as the fallback.
  | Measured from a Worker in Frankfurt | Socket | HTTPS (older sites) |
  | --- | --- | --- |
  | a query | ~3 ms | ~130 ms |
  | opening, once per request | ~20 ms | none |
  | 10 reads, awaited one by one | ~40 ms | ~1,300 ms |
  | 10 reads in `Promise.all` | ~20 ms | ~300 ms |
  About 1 in 15 Worker instances is slow to reach the database (a query ~170 ms, opening ~1 s).
  You can't detect or avoid that from site code, and it is why the round-trip budget stays: on such
  an instance 10 awaited reads take ~2.5 s and the same reads in `Promise.all` ~1 s.
- Locally and in tests (plain Postgres): `adapter-pg` with `max: 1` and a 1 s idle timeout, a
  short-lived connection per request.
- `DATABASE_URL` is the only URL: the same direct Prisma Postgres connection string serves the
  driver and the Prisma CLI (`migrate dev`, `studio` in the editor). There is no separate
  pooled/Accelerate URL and no `directUrl`; never add one or point it anywhere else. Deploy-time
  migrations are run by the platform with its own credentials.

## What the socket means for your code
Nothing changes in how you write queries: `getDb()`, `c.var.db` and every Prisma call work as
before. Don't import `db-socket.ts`, open a session, or write your own connection handling. Know this:
- **`Promise.all` of plain reads is the fastest form**: they go down the socket together.
- **A write runs alone, in the order you wrote it.** In `Promise.all`, a write waits for the
  reads and writes before it, and what comes after it waits for it. So a read listed after a write
  sees it, and mixing writes into `Promise.all` gains nothing: await them, or use a transaction.
- **A read that fails on a lost connection is sent again by itself. A write never is**: a lost
  connection can't say whether it landed, so the write throws and the row may or may not exist.
  Writes a person may repeat (checkout, payments, anything charged) need their own safeguard:
  `idempotent()`, or a unique key on the order or request (`@@unique`, catch `P2002`), and a read-back after an
  error (`orders-and-stock.md`). Never loop and retry a write on your own without one.
- **`P2002` and Prisma's other error codes work on the socket.** On a site not yet upgraded, a driver
  error reaches your code as a plain object with `originalCode` (`23505` for a duplicate) and no `code`,
  so `catch P2002` never runs and the visitor gets a 500. Upgrade the site rather than working around it.
- **Only a plain `SELECT` counts as a read.** `INSERT/UPDATE/DELETE … RETURNING`, a `WITH` query,
  `FOR UPDATE`, `nextval()` and advisory locks run alone and are never sent again. A `SELECT` that
  calls YOUR function which writes would be treated as a read: use `$executeRaw` for it, or
  run it in a transaction, which is never retried.
- **A transaction has its own socket**, ~20 ms to open: keep using it when the writes must be all or
  nothing, not as a way to share a connection. Keep it short, and keep a row every request updates (a
  shared stock or total counter) out of it where you can: requests queue behind its lock, and past Prisma's 5 s
  limit they fail with `P2028`. In rare bursts under that load, a commit has been reported failed
  although it was saved. So treat a failed commit as unknown: read back, and use `idempotent()` for anything charged.
- **No session state between statements**: `SET`, temporary tables and session advisory locks don't
  carry from one query to the next outside a transaction. Between statements the database connection
  may serve other work.
- **The socket closes after 5 s idle** and reopens by itself: a slow outside call in a route is fine.
- **Don't use `String[]` or other Prisma scalar lists.** Prisma's Prisma Postgres driver mishandles
  them (a write fails with `malformed array literal`, a read crashes, raw SQL returns `{a,b}` as text),
  with HTTPS too. Use a related table, or `Json` for an opaque list.
- **Leave the managed files alone**: `src/platform/db-socket*.ts` come from the template. Bumping
  `@prisma/adapter-ppg` means copying its conversion again: `tests/db-socket.test.ts` fails until
  someone does. Don't change the Prisma version without a template upgrade.

**A site built before this** has no `src/platform/db-socket.ts`. It keeps working over HTTPS, where a query costs ~130 ms, so
treat every query as ~130 ms until it's upgraded. Upgrading is required, and comes first: `upgrade.md`. A Publish alone doesn't
upgrade a site, and a new site starts on the socket.

## Tables
- MANAGED (auth core, change only through a template upgrade): `users`, `roles`, `permissions`,
  `role_permissions`, `user_roles`, `refresh_tokens`, `password_resets`, `email_verifications`,
  `email_changes`, `sign_in_codes`, `recovery_codes`, `login_attempts`, `audit_events`,
  `auth_state`, `job_deliveries` (background job replay guard). Read them through
  `src/platform/auth`; the only rows you add by migration are roles and role grants
  (`roles-and-permissions.md`). Codenames come from the catalogue, never a migration.
- Yours: `jobs`, and every table you add.

## Column types
| Data | Prisma | Why |
| --- | --- | --- |
| id | `Int @id @default(autoincrement())`; `BigInt` for append-heavy tables (logs, events) | small, ordered (keyset paging); serialize `BigInt` as a string in JSON |
| public / unguessable id | a separate `@unique` column (`token String @db.VarChar(43)`, random) | never expose sequence ids as the only secret (`security.md` › A01) |
| foreign key | `Int @map("owner_id")`, same type as the target id | |
| text | `String @db.VarChar(n)`, `n` = the validator's max | the column refuses what the validator missed |
| long text | `@db.VarChar(10000)` like `jobs.description`, or `@db.Text` with a validator cap | |
| money | `Int` minor units (`priceCents`) + `currency String @db.Char(3)` | never `Float`; `Decimal` only for rates/quantities with fixed scale |
| time | `DateTime @db.Timestamptz(3)` for new columns | an instant, stored in UTC either way; the managed tables use `TIMESTAMP(3)` (Prisma writes UTC): compare to `CURRENT_TIMESTAMP` in raw SQL only on `timestamptz` |
| a date with no time (birthday, due day) | `DateTime @db.Date` | no time-zone drift |
| flag | `Boolean @default(false)` | |
| small fixed set | `String @db.VarChar(n)` + validator allow-list + CHECK (below), like `jobs.status` | adding a value is a code change, not a type change; a Prisma `enum` is a Postgres type: renaming or removing a value is a migration that waits for approval |
| set the owner edits (categories, tags) | a lookup table with an FK | rows, not code |
| JSON | `Json @db.JsonB` only for opaque snapshots (`audit_events.meta`) | never for anything you filter, join, sort, count or validate field by field |
| email of a user | don't copy it: FK to `users.id` | one place to change and delete |
Every column is NOT NULL unless "unknown" is a real state; give new columns on existing tables a
`@default` (or make them nullable: expand, below). `createdAt @default(now())` and
`updatedAt @updatedAt` on every table. snake_case in the database (`@map`, `@@map`), camelCase
in code.

## Constraints
- **Unique** where the product says "only one": `@unique` / `@@unique([teamId, slug])`. Catch
  `P2002` in the route and answer 409 in words (`jobs.ts` create).
- **Foreign keys** with an explicit `onDelete`: `Cascade` when the child means nothing without the
  parent (team → members), `Restrict` when deleting the parent must be refused, `SetNull` when the
  child outlives it (the column nullable). Rows pointing at `users`: decide per table, since
  deleting an account deletes the user row (cascading only managed tables). `jobs.created_by`
  has no FK on purpose ("a job outlives its poster"); to keep yours, use no FK or `SetNull`;
  to drop them with the account, `Cascade`.
- **CHECK constraints**: Prisma's schema can't express them; add them in the migration SQL. Prisma
  ignores them afterwards (they survive later migrations):
  ```sql
  ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check"
    CHECK ("status" IN ('pending', 'paid', 'cancelled'));
  ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK ("total_cents" >= 0);
  ```
- The validator still checks everything first: a constraint error is a 500 unless you map it.

## Indexes
Each index speeds reads and costs every insert/update. One per QUERY SHAPE, no more.
- **Order**: equality columns first, then the ONE range or sort column, ending in `id` so it
  covers the keyset order:
  | Query | Index |
  | --- | --- |
  | my rows, newest first (`where ownerId`, `orderBy id desc`) | `@@index([ownerId, id])` |
  | open rows by id (`jobs`) | `@@index([status, id])` |
  | a team's rows by time (`where teamId`, `orderBy [createdAt desc, id desc]`) | `@@index([teamId, createdAt(sort: Desc), id(sort: Desc)])` |
  | lookup by a unique value | `@unique` (it is the index) |
  | rate check (`senderId`, `createdAt > t`) | `@@index([senderId, createdAt])` |
- **Foreign keys**: Postgres does not index them. Every FK column is the FIRST column of some
  index (or of the primary key), else a cascade delete or "children of X" scans the table.
- **Partial indexes** (only the rows a query reads: not-deleted, open, pending) and **expression
  indexes** (`lower(email)`) are SQL in the migration; Prisma's schema can't hold them:
  ```sql
  CREATE INDEX "notes_owner_live_idx" ON "notes" ("owner_id", "id") WHERE "deleted_at" IS NULL;
  CREATE UNIQUE INDEX "teams_slug_live_key" ON "teams" ("slug") WHERE "deleted_at" IS NULL;
  CREATE UNIQUE INDEX "contacts_team_email_key" ON "contacts" ("team_id", lower("email"));
  ```
  Then open EVERY later `--create-only` migration: if it contains `DROP INDEX` for one of yours,
  delete that line before applying.
- **Case-insensitive unique** (emails, handles): store it normalized (trimmed, lower-cased in the
  validator, as `users.email` is) with a plain `@unique`; or the `lower()` unique index above.
  Query with the same normalization. `mode: 'insensitive'` (ILIKE) can't use a b-tree index.
- **Search**: `contains` scans; fine for hundreds of rows. Before thousands, a `pg_trgm` GIN index
  or a `tsvector` column (migration SQL) or exact-value search only.
- **Write-heavy tables** (events, logs, counters): the primary key plus the one or two indexes
  their reads need; no index "just in case".
- **Big live tables**: `CREATE INDEX CONCURRENTLY` doesn't lock writes but can't run in a
  transaction, and a migration file runs as one: put it ALONE in its own migration (one
  statement, no `BEGIN`), name it as Prisma would (`<table>_<cols>_idx`) so the schema's
  `@@index` matches, and use `IF NOT EXISTS`. A failed concurrent build leaves an INVALID index:
  check `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, drop it and retry in
  a new migration. Small tables (a few thousand rows): a normal index in the transaction is fine.
- Check a doubtful plan with `EXPLAIN` in Prisma Studio / psql on the Preview Database.

## One query per read (each query is a round trip: ~3 ms, ~170 ms on a slow instance)
- **`relationJoins` is on** (`prisma/schema.prisma`, both generators: `previewFeatures =
  ["relationJoins"]`): a nested `select` of related rows runs as ONE SQL query (a join), not one
  extra query per relation. A site built before it has `previewFeatures` missing: add that line to
  BOTH `generator` blocks, run `npx prisma generate`, then `npm test` (no migration; the database
  doesn't change). Then read related rows in the same query:
  ```ts
  const order = await db.order.findFirst({
    where: {id, userId: me},                       // owner IN the query (object-level access)
    relationLoadStrategy: 'join',                  // one SQL query (the default once relationJoins is on)
    select: {id: true, status: true, lines: {select: {sku: true, qty: true}, take: 100}},
  });
  ```
- **Several tables or an aggregate Prisma can't express in one query** (totals per category,
  "top 10 with their counts", a report): ONE tagged `$queryRaw` instead of several queries or a
  loop. Typed, bounded, and a PREPARED STATEMENT (below):
  ```ts
  type Row = {category_id: number; name: string; products: bigint};
  const rows = await db.$queryRaw<Row[]>`
    SELECT c.id AS category_id, c.name, count(p.id) AS products
    FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active'
    WHERE c.store_id = ${storeId}
    GROUP BY c.id, c.name ORDER BY c.name LIMIT 100`;
  // count() comes back as BigInt: Number(row.products) before JSON.
  ```
- **Raw SQL is always a prepared statement.** Only the TAGGED forms: `` db.$queryRaw`…${value}…` ``,
  `` db.$executeRaw`…` ``, `` Prisma.sql`…` `` pieces, `Prisma.join(ids)` for `IN (…)`. Prisma sends
  every `${value}` as a bound parameter, never pasted into the SQL text, so input can't change the
  query. Column / table / sort names can't be parameters: pick them from a fixed map
  (`security.md` A05). NEVER `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw(input)`, or SQL
  built with `+`, `.join()` or a plain template string.
- **Snake_case in raw SQL** (the `@map` names: `owner_id`, `created_at`), and a `LIMIT` always.

## Queries
- Explicit `select` always; `take` ≤ 100; keyset paging, never `skip` (`performance.md`).
- **No N+1**: related rows in the same query or one `in` query:
  ```ts
  // WRONG: one query per row
  for (const p of posts) p.author = await db.user.findUnique({where: {id: p.authorId}});
  // RIGHT: one query, only the fields shown
  const posts = await db.post.findMany({
    where: {teamId}, orderBy: {id: 'desc'}, take: 21,
    select: {id: true, title: true, author: {select: {id: true, name: true}}},
  });
  ```
  Without a relation (no FK): collect ids, `findMany({where: {id: {in: ids}}, select})` (bounded),
  join in a `Map`. A nested `include` of a to-many relation is bounded too (`take`).
- **Independent reads go in `Promise.all`**: on the socket they travel together, so 10 of them take
  about as long as 2. Awaiting them one by one costs a round trip each.
- **Transactions**: the batch form `db.$transaction([a, b])` (as the admin routes do), or the
  callback form for a read-then-write that must be consistent. Keep them short: no platform
  call, `sendJob` or email inside one (do those after commit). A single conditional `updateMany`
  (`where: {id, status: 'open'}`, check `count`) is often all you need.
- **Counts kept on write**: never `count()` a growing table per request. Keep a counter column
  and change it in the SAME transaction as the row:
  ```ts
  await db.$transaction([
    db.comment.create({data: {postId, authorId: me, body}, select: {id: true}}),
    db.post.update({where: {id: postId}, data: {commentCount: {increment: 1}}, select: {id: true}}),
  ]);
  ```
  Delete decrements the same way. Exact totals for an admin report: a background job writes them.

## Soft delete, hard delete, personal data
- **Hard delete** by default: it is what "delete" means to a person, and what privacy law expects
  for personal data. `deleteMany({where: {id, ownerId}})`, check `count`.
- **Soft delete** (`deletedAt DateTime? @db.Timestamptz(3)`) only when the product needs undo,
  a trash or history: every read adds `deletedAt: null`, the partial indexes above cover it,
  unique rules are partial unique indexes, and a scheduled job (`background-jobs.md`) purges rows
  older than the retention period in bounded batches.
- **Account deletion** removes the `users` row and its managed rows; your rows stay unless their
  FK cascades. Decide per table and say so in the feature: personal content (notes, messages,
  profiles) → `Cascade` or a cleanup job; shared records (orders, posts others rely on) →
  `SetNull` / no FK, with the personal fields cleared.
- **Export** (a person asks for their data): a route gated by a codename (or the user themself),
  building a bounded JSON of THEIR rows with explicit `select`s, audited. Large exports are a
  background job.
- Store the minimum: no copies of emails, no free-text fields "for later", no raw IPs.

## Migrations: forward-only
1. Edit `prisma/schema.prisma`.
2. `npx prisma migrate dev --create-only --name <what_changed>` (snake_case).
3. Open the new `prisma/migrations/<ts>_<name>/migration.sql`: check it, add CHECKs / partial
   indexes, and wrap it in `BEGIN;` … `COMMIT;` (unless it is a `CREATE INDEX CONCURRENTLY`:
   then that ONE statement, no BEGIN).
4. `npx prisma migrate dev` applies it to the Preview Database.
5. `npx prisma generate`: Prisma 7's `migrate dev` no longer regenerates the client, and until
   you do, `db.<newModel>` is `undefined` in the running Preview ("Cannot read properties of
   undefined (reading 'findMany')"). The dev server reloads by itself after it. Run the app,
   then commit the schema and the migration.
- `migrate dev --create-only` first APPLIES any migration that is still pending (a second
  `--create-only` applies the first): write and check one migration at a time.
- On your own machine the Prisma CLI reads `DATABASE_URL` (and `SHADOW_DATABASE_URL`) from
  `.env` (`prisma.config.ts`); in the editor they are already in the environment.
- Never edit, rename or delete a migration that exists in git: it may already be applied live.
- Publish applies pending migrations BEFORE the new code goes live; a failure keeps the old
  version serving. A migration that drops, truncates or changes a type waits for the owner's
  approval at Publish.
- The OLD code keeps running for a while on the NEW schema (and a redeploy can roll code back):
  every migration must be safe for the previous version too.

## Expand, migrate, contract
Renaming `title` → `name`, splitting a column, or making one required is several Publishes:
1. EXPAND: add the new column nullable (or with a default); code writes both, reads the old.
2. BACKFILL: `UPDATE "t" SET "name" = "title" WHERE "name" IS NULL;` For a big table, in
   batches (`WHERE "id" IN (SELECT "id" FROM "t" WHERE "name" IS NULL LIMIT 5000)` across
   several migrations, or a bounded background job), never one statement over millions of rows.
3. SWITCH: code reads the new column (and still writes both).
4. CONTRACT, a later Publish once nothing reads the old column (owner approves): stop writing it,
   then drop it; `SET NOT NULL` after the backfill is complete.
Never in one release: rename or drop a column/table the running code reads, add a `NOT NULL`
column without a default to a table with rows, change a column's type in place, add a unique
constraint before the duplicates are gone, or drop a column in the same release the code stops
using it.

## A new model, end to end
The model with `@@map("snake_table")`, `@map` columns, lengths, types from the table above,
`createdAt`/`updatedAt`, FKs with `onDelete` and their indexes, one `@@index` per query shape →
migration (+ CHECKs, partial indexes) → `npx prisma generate` → a route with an explicit `select`,
keyset paging and the access checks (`roles-and-permissions.md`) → an integration test of who may
and may not (add its table to the `TRUNCATE` in `tests/integration/support/harness.ts`).

## Tests against a real database
`TEST_DATABASE_URL=postgresql://…/<throwaway db> npm test` runs `tests/integration/*` (the real
Site API, cookies, CSRF) after `npx prisma migrate deploy` on that database. The tests EMPTY its
tables: never point it at a database you care about. Without the variable they are skipped.
Add an integration test for every new route that guards data (who may, who may not).

## Seed and tools
- `prisma/seed.sql`: fake rows for the Preview Database only (example.com addresses, no users or
  passwords), idempotent (`WHERE NOT EXISTS`). `npx prisma db seed` runs it.
- `npm run studio` opens Prisma Studio on port 5555 (Preview Database). Resetting the Preview
  Database (`prisma migrate reset`) is the owner's call: ask first.
- No `DATABASE_URL` = the Site Database is not enabled: routes answer 503. Ask the owner to enable
  it in the site's Database tab; never point it anywhere else.

## What the live database has
You can't reach the live database, and never ask for its address. The platform writes what it has applied to
`{{LIVE_MIGRATIONS_FILE}}` in the editor: names and statuses, never rows. It's refreshed each time the editor opens and after
each publish, and `readAt` says when. Read it before you write a migration, and first thing when a publish fails on one.

| Field | Meaning |
| --- | --- |
| `state` | `ready`; `no_database` (not created yet); `unavailable` (couldn't be read: don't guess, say so and try after the next Open) |
| `applied` | On the live database, oldest first. Never edit or delete one of these files: write a new migration |
| `failed` | Started and never finished. Every later publish stops here until it's resolved |
| `rolledBack` | Marked rolled back. Its file may run again |
| `lastPublish` | The live site's last publish: `status`, `errorCode`, `error`, `pending`, and `destructive` (SQL waiting for the owner's approval) |
| `lastStagingPublish` | The same for the staging site. `applied` and `failed` are the live database's only: check the staging database yourself |

**A publish failed on a migration (`migrate_failed`):**
1. Compare `prisma/migrations/` with `applied` and `failed`, and read `lastPublish.error`.
2. Find out what the failed file does. A file that failed may have done part of its work, because Prisma doesn't undo it unless it ran in one transaction.
3. Write the fix as a new migration that works whether or not that part was done (`IF NOT EXISTS`, `IF EXISTS`), and test it on the staging database.
4. A failed migration blocks everything after it. Marking it rolled back or applied is the owner's step, in the site's Database tab. Tell them which one, and which to pick, in plain words:
   rolled back if it changed nothing, applied if you've made the rest of its work safe another way.
5. Then ask them to publish again.

Don't edit the failed file, unless it never ran anywhere and you're sure of that from `failed` and `applied`. Never tell the owner to run SQL by hand.

