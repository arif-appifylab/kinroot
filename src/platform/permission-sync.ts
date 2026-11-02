import {createMiddleware} from 'hono/factory';

import type {PrismaClient} from '../generated/prisma/client';
import type {Catalogue} from './auth/codenames';
import {PREVIEW_COOKIE_HEADER} from './auth/preview-cookies';
import {getDb} from './db';

/**
 * Keeps the `permissions` table in step with the code's catalogue
 * (`src/server/permissions.ts`), so adding a permission needs no migration.
 *
 * - A codename the table lacks is INSERTED, and granted to its `roles` in the
 *   SAME statement, only when this statement created the row: the default
 *   grant happens once, ever. An owner who later removes it from a role keeps
 *   it removed; a concurrent isolate that loses the insert race grants nothing.
 * - A changed title, description or group is updated (the code is the source).
 * - Nothing is ever deleted: a codename dropped from the code stays in the
 *   table (harmless, still listed) until a migration removes it on purpose.
 *
 * Cost: one indexed SELECT per catalogue per isolate (a Worker instance); a
 * write only on the first request after a deploy that changed the catalogue.
 * Only the `synced` flag lives in module memory, never a promise or a client,
 * so no request ever waits on another request's I/O.
 */
export async function ensurePermissions(
  db: PrismaClient,
  catalogue: Catalogue
): Promise<{created: string[]; updated: string[]}> {
  const defs = Object.values(catalogue);
  const existing = await db.permission.findMany({
    where: {codename: {in: defs.map(def => def.codename)}},
    select: {codename: true, title: true, description: true, groupName: true},
    take: 1000,
  });
  const byCodename = new Map(existing.map(row => [row.codename, row]));
  const rowOf = (def: (typeof defs)[number]) => ({
    codename: def.codename,
    title: def.title,
    description: def.description ?? null,
    group_name: def.group,
  });
  const missing = defs.filter(def => !byCodename.has(def.codename));
  const changed = defs.filter(def => {
    const row = byCodename.get(def.codename);
    return row && (row.title !== def.title || row.description !== (def.description ?? null) || row.groupName !== def.group);
  });

  if (missing.length) {
    const rows = JSON.stringify(missing.map(rowOf));
    const defaults = JSON.stringify(missing.flatMap(def => (def.roles ?? []).map(slug => ({codename: def.codename, slug}))));
    // ONE statement, so the insert and its default grants commit together.
    await db.$executeRaw`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${rows}::jsonb)
          AS x(codename text, title text, description text, group_name text)
      ), created AS (
        INSERT INTO "permissions" ("codename", "title", "description", "group_name")
        SELECT codename, title, description, group_name FROM input
        ON CONFLICT ("codename") DO NOTHING
        RETURNING "id", "codename"
      )
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT r."id", c."id"
      FROM created c
      JOIN jsonb_to_recordset(${defaults}::jsonb) AS g(codename text, slug text) ON g.codename = c.codename
      JOIN "roles" r ON r."slug" = g.slug
      ON CONFLICT DO NOTHING`;
  }
  if (changed.length) {
    const rows = JSON.stringify(changed.map(rowOf));
    await db.$executeRaw`
      UPDATE "permissions" p
      SET "title" = x.title, "description" = x.description, "group_name" = x.group_name
      FROM jsonb_to_recordset(${rows}::jsonb) AS x(codename text, title text, description text, group_name text)
      WHERE p."codename" = x.codename
        AND (p."title", p."description", p."group_name") IS DISTINCT FROM (x.title, x.description, x.group_name)`;
  }
  return {created: missing.map(def => def.codename), updated: changed.map(def => def.codename)};
}

const synced = new WeakSet<Catalogue>();

/**
 * Site API middleware (`src/server/app.ts`): runs `ensurePermissions` until it
 * has succeeded once in this isolate, then never again. Only for requests
 * that carry cookies: a guest holds no permission, so nothing they do needs
 * the catalogue. A failure is logged and retried on the next request; the
 * request itself goes on (permissions already in the table still work).
 */
export const syncPermissions = (catalogue: Catalogue) =>
  createMiddleware(async (c, next) => {
    if (!synced.has(catalogue) && (c.req.header('cookie') || c.req.header(PREVIEW_COOKIE_HEADER))) {
      const db = getDb();
      if (db) {
        try {
          await ensurePermissions(db, catalogue);
          synced.add(catalogue);
        } catch (err) {
          console.error(`permission sync failed: ${(err as Error).message}`);
        }
      }
    }
    await next();
  });
