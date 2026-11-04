import type {Context} from 'hono';
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, requirePermission, withAuthCore, withViewer} from '../guards';
import type {AdminUser, AuditRow, PermissionRow, RoleRow, Viewer} from '../types';
import {audit} from './audit';
import {canDelegate, CODENAME_RE, CORE, grants, SYSTEM_ROLES} from './codenames';
import {subjectHash} from './keys';
import {endAccess} from './end-access';
import {sendEmail} from './kit';
import {getAccess} from './session';
import {normalizeEmail} from './input';

/**
 * `/site-api/admin/*`: users, roles and the audit log, for the portal's admin
 * screens. Every route: signed in + a core codename (`codenames.ts`).
 *
 *   GET    /users?before=&email=&status=     site:user:read
 *   GET    /users/:id                        site:user:read
 *   PATCH  /users/:id        {status}        site:user:update
 *   PUT    /users/:id/roles  {roles}         site:user:update
 *   POST   /users/:id/sessions/revoke        site:user:update
 *   POST   /users/:id/two-factor/disable     site:user:update   (lost phone: set it up again)
 *   GET    /roles  · GET /permissions        site:role:read
 *   POST   /roles · PATCH/DELETE /roles/:slug site:role:update
 *   GET    /audit?before=                    site:audit:read
 *
 * ANTI-ESCALATION, everywhere: you can only give, take away, edit or act on
 * what you already hold. An admin cannot make an owner, edit the owner role,
 * suspend an owner or grant a codename they lack. The last owner cannot lose
 * the role. Nobody suspends themselves.
 */

type Env = {Variables: {db: PrismaClient; secret: string; viewer: Viewer}};

const PAGE = 25;

const idOf = (value: string) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;

const OWNER_IS_MANAGED = 'The site owner comes from the dashboard, and is not changed here.';

const userSelect = {
  id: true,
  email: true,
  platformOwnerId: true,
  name: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastLoginAt: true,
  totpEnabledAt: true,
  roles: {select: {role: {select: {slug: true}}}, take: 20},
} as const;

type UserRowDb = {
  id: number;
  email: string;
  platformOwnerId: string | null;
  name: string;
  status: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  totpEnabledAt: Date | null;
  roles: {role: {slug: string}}[];
};

/** `maya@gmail.com` → `m•••@gmail.com`: enough to recognise, not enough to use. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Owner's rule (2026-11-01): an email address is visible ONLY to its own user and to the site's
 * owner. Every other admin sees it masked. Worked out once per request.
 */
type EmailView = {owner: boolean; me: number | null};
async function emailView(c: Context): Promise<EmailView> {
  const {roles} = await getAccess(c.req.raw);
  const viewer = (c.var as {viewer?: Viewer}).viewer;
  return {owner: roles.includes(SYSTEM_ROLES.OWNER), me: viewer?.state === 'user' ? (viewer.id ?? null) : null};
}

const toAdminUser = (row: UserRowDb, view: EmailView): AdminUser => ({
  id: row.id,
  // The owner's account holds only a placeholder address.
  email: row.platformOwnerId ? '' : view.owner || row.id === view.me ? row.email : maskEmail(row.email),
  platformOwner: row.platformOwnerId !== null,
  name: row.name,
  status: row.status,
  emailVerified: row.emailVerifiedAt !== null,
  roles: row.roles.map(r => r.role.slug),
  createdAt: row.createdAt.toISOString(),
  lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  twoFactor: row.totpEnabledAt !== null,
});

/** Every codename a user's roles grant (bounded). */
async function permissionsOfUser(db: PrismaClient, userId: number): Promise<Set<string>> {
  const rows = await db.userRole.findMany({
    where: {userId},
    select: {role: {select: {permissions: {select: {permission: {select: {codename: true}}}, take: 500}}}},
    take: 50,
  });
  return new Set(rows.flatMap(r => r.role.permissions.map(p => p.permission.codename)));
}

async function rolePermissions(db: PrismaClient, slugs: string[]) {
  return db.role.findMany({
    where: {slug: {in: slugs}},
    select: {id: true, slug: true, permissions: {select: {permission: {select: {codename: true}}}, take: 500}},
    take: 50,
  });
}

const actorPermissions = async (c: Context<Env>) => new Set((await getAccess(c.req.raw)).permissions);

const ipHashOf = (c: Context<Env>) => subjectHash(c.var.secret, 'ip', c.req.header('cf-connecting-ip') ?? 'local');

const forbidden = (c: Context, message = 'You cannot change someone with more access than you.') =>
  c.json(problem('forbidden', message), 403);

const toRoleRow = (role: {
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: {permission: {codename: string}}[];
}): RoleRow => ({
  slug: role.slug,
  name: role.name,
  description: role.description,
  isSystem: role.isSystem,
  permissions: role.permissions.map(p => p.permission.codename).sort(),
});

const roleSelect = {
  slug: true,
  name: true,
  description: true,
  isSystem: true,
  permissions: {select: {permission: {select: {codename: true}}}, take: 500},
} as const;

/** `{name, description, permissions}` for a role create or edit. */
const roleBody = (creating: boolean) =>
  validator('json', (value, c) => {
    const v = (value ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    const out: {slug?: string; name?: string; description?: string | null; permissions?: string[]} = {};
    if (creating) {
      const slug = typeof v.slug === 'string' ? v.slug.trim().toLowerCase() : '';
      if (!SLUG_RE.test(slug)) fields.slug = 'Use 2 to 48 lowercase letters, digits or dashes, starting with a letter.';
      out.slug = slug;
    }
    if (v.name !== undefined || creating) {
      const name = typeof v.name === 'string' ? v.name.trim() : '';
      if (!name || name.length > 80) fields.name = 'A name needs 1 to 80 characters.';
      out.name = name;
    }
    if (v.description !== undefined) {
      const description = typeof v.description === 'string' ? v.description.trim() : '';
      if (description.length > 255) fields.description = 'Use at most 255 characters.';
      out.description = description || null;
    }
    if (v.permissions !== undefined || creating) {
      const list = Array.isArray(v.permissions) ? v.permissions : [];
      if (list.length > 200 || !list.every(p => typeof p === 'string' && CODENAME_RE.test(p))) {
        fields.permissions = 'Pick permissions from the list.';
      }
      out.permissions = [...new Set(list as string[])];
    }
    if (Object.keys(fields).length) {
      return c.json({...problem('invalid_input', Object.values(fields)[0]!), fields}, 422);
    }
    return out;
  });

export const adminRoutes = new Hono<Env>()
  // ------------------------------------------------------------------ users
  .get(
    '/users',
    // Every key is optional for callers: send '' (or leave it out) for "any".
    validator('query', value => ({
      before: typeof value.before === 'string' ? value.before : '',
      email: typeof value.email === 'string' ? value.email.trim() : '',
      status: value.status === 'active' || value.status === 'suspended' ? value.status : '',
    })),
    withViewer,
    requireAuth,
    requirePermission(CORE.USER_READ),
    withAuthCore,
    async c => {
      const query = c.req.valid('query');
      const before = idOf(query.before);
      const status = query.status || null;
      const view = await emailView(c);
      // Finding someone BY email is the owner's alone: anyone else could test which addresses have accounts.
      if (query.email && !view.owner) {
        return c.json(problem('forbidden', 'Only the site owner can look people up by email.'), 403);
      }
      // Email search is an EXACT match on the unique index; a malformed one finds nobody.
      const email = query.email ? normalizeEmail(query.email) : null;
      if (query.email && !email) return c.json({users: [], nextBefore: null});
      const rows = await c.var.db.user.findMany({
        select: userSelect,
        where: {
          ...(email ? {email} : {}),
          ...(status ? {status} : {}),
          ...(before ? {id: {lt: before}} : {}),
        },
        orderBy: {id: 'desc'},
        take: PAGE + 1,
      });
      const users = rows.slice(0, PAGE).map(row => toAdminUser(row, view));
      return c.json({users, nextBefore: rows.length > PAGE ? users.at(-1)!.id : null});
    }
  )

  .get('/users/:id', withViewer, requireAuth, requirePermission(CORE.USER_READ), withAuthCore, async c => {
    const id = idOf(c.req.param('id'));
    const row = id ? await c.var.db.user.findUnique({where: {id}, select: userSelect}) : null;
    if (!row) return c.json(problem('not_found', 'No such user.'), 404);
    return c.json({user: toAdminUser(row, await emailView(c))});
  })

  .patch(
    '/users/:id',
    validator('json', (value, c) => {
      const status = (value as {status?: unknown} | null)?.status;
      return status === 'active' || status === 'suspended'
        ? {status}
        : c.json(problem('invalid_input', 'Status is active or suspended.'), 422);
    }),
    withViewer,
    requireAuth,
    requirePermission(CORE.USER_UPDATE),
    withAuthCore,
    async c => {
      const db = c.var.db;
      const id = idOf(c.req.param('id'));
      const {status} = c.req.valid('json');
      if (!id) return c.json(problem('not_found', 'No such user.'), 404);
      if (id === c.var.viewer.id) return forbidden(c, 'You cannot change your own status.');
      const target = await db.user.findUnique({where: {id}, select: {id: true, platformOwnerId: true}});
      if (!target) return c.json(problem('not_found', 'No such user.'), 404);
      if (target.platformOwnerId) return forbidden(c, OWNER_IS_MANAGED);
      if (!canDelegate(await actorPermissions(c), await permissionsOfUser(db, id))) return forbidden(c);

      // Suspending ends every session, link and code, at once and for good.
      if (status === 'suspended') await endAccess(db, id, 'suspended', {set: {status}});
      const row = await db.user.update({where: {id}, data: {status}, select: userSelect});
      await audit(db, {
        actorUserId: c.var.viewer.id,
        action: status === 'suspended' ? 'user_suspended' : 'user_reactivated',
        target: ['user', id],
        ipHash: await ipHashOf(c),
      });
      return c.json({user: toAdminUser(row, await emailView(c))});
    }
  )

  .put(
    '/users/:id/roles',
    validator('json', (value, c) => {
      const roles = (value as {roles?: unknown} | null)?.roles;
      return Array.isArray(roles) && roles.length <= 20 && roles.every(r => typeof r === 'string' && SLUG_RE.test(r))
        ? {roles: [...new Set(roles as string[])]}
        : c.json(problem('invalid_input', 'Pick roles from the list.'), 422);
    }),
    withViewer,
    requireAuth,
    requirePermission(CORE.USER_UPDATE),
    withAuthCore,
    async c => {
      const db = c.var.db;
      const id = idOf(c.req.param('id'));
      const wanted = c.req.valid('json').roles;
      const target = id ? await db.user.findUnique({where: {id}, select: userSelect}) : null;
      if (!target) return c.json(problem('not_found', 'No such user.'), 404);
      if (target.platformOwnerId) return forbidden(c, OWNER_IS_MANAGED);

      const current = target.roles.map(r => r.role.slug);
      const added = wanted.filter(slug => !current.includes(slug));
      const removed = current.filter(slug => !wanted.includes(slug));
      // Owner comes only from the dashboard: nobody gives or takes it here.
      if (added.includes(SYSTEM_ROLES.OWNER) || removed.includes(SYSTEM_ROLES.OWNER)) return forbidden(c, OWNER_IS_MANAGED);
      if (!added.length && !removed.length) return c.json({user: toAdminUser(target, await emailView(c))});

      const touched = await rolePermissions(db, [...added, ...removed]);
      if (touched.length !== added.length + removed.length) {
        return c.json(problem('invalid_input', 'One of those roles does not exist.'), 422);
      }
      // You may only change someone who does not out-rank you, and only hand out
      // or take away roles whose every permission you hold.
      const held = await actorPermissions(c);
      if (target.id !== c.var.viewer.id && !canDelegate(held, await permissionsOfUser(db, target.id))) {
        return forbidden(c);
      }
      for (const role of touched) {
        if (!canDelegate(held, role.permissions.map(p => p.permission.codename))) {
          return forbidden(c, `You cannot give or remove the “${role.slug}” role.`);
        }
      }
      const removeIds = touched.filter(role => removed.includes(role.slug)).map(role => role.id);
      const addIds = touched.filter(role => added.includes(role.slug)).map(role => role.id);
      await db.$transaction(async tx => {
        await tx.userRole.deleteMany({where: {userId: target.id, roleId: {in: removeIds}}});
        await tx.userRole.createMany({
          data: addIds.map(roleId => ({userId: target.id, roleId, grantedBy: c.var.viewer.id})),
          skipDuplicates: true,
        });
      });
      await audit(db, {
        actorUserId: c.var.viewer.id,
        action: 'user_roles_changed',
        target: ['user', target.id],
        ipHash: await ipHashOf(c),
        meta: {added, removed},
      });
      const row = await db.user.findUnique({where: {id: target.id}, select: userSelect});
      return c.json({user: toAdminUser(row!, await emailView(c))});
    }
  )

  .post(
    '/users/:id/sessions/revoke',
    withViewer,
    requireAuth,
    requirePermission(CORE.USER_UPDATE),
    withAuthCore,
    async c => {
      const db = c.var.db;
      const id = idOf(c.req.param('id'));
      const target = id ? await db.user.findUnique({where: {id}, select: {id: true, platformOwnerId: true}}) : null;
      if (!target) return c.json(problem('not_found', 'No such user.'), 404);
      if (target.platformOwnerId && id !== c.var.viewer.id) return forbidden(c, OWNER_IS_MANAGED);
      if (id !== c.var.viewer.id && !canDelegate(await actorPermissions(c), await permissionsOfUser(db, target.id))) {
        return forbidden(c);
      }
      await endAccess(db, target.id, 'admin');
      await audit(db, {
        actorUserId: c.var.viewer.id,
        action: 'user_sessions_revoked',
        target: ['user', target.id],
        ipHash: await ipHashOf(c),
      });
      return c.json({ok: true});
    }
  )

  // Lost phone and recovery codes: an admin turns two-step sign-in off; the user sets it up again.
  .post(
    '/users/:id/two-factor/disable',
    withViewer,
    requireAuth,
    requirePermission(CORE.USER_UPDATE),
    withAuthCore,
    async c => {
      const db = c.var.db;
      const id = idOf(c.req.param('id'));
      const target = id ? await db.user.findUnique({where: {id}, select: {id: true, platformOwnerId: true}}) : null;
      if (!target) return c.json(problem('not_found', 'No such user.'), 404);
      if (target.platformOwnerId && id !== c.var.viewer.id) return forbidden(c, OWNER_IS_MANAGED);
      if (id !== c.var.viewer.id && !canDelegate(await actorPermissions(c), await permissionsOfUser(db, target.id))) {
        return forbidden(c);
      }
      await db.user.update({
        where: {id: target.id},
        data: {totpSecretSealed: null, totpPendingSealed: null, totpEnabledAt: null, totpLastStep: null},
        select: {id: true},
      });
      await db.recoveryCode.deleteMany({where: {userId: target.id}});
      const notified = await db.user.findUnique({where: {id: target.id}, select: {email: true}});
      if (notified) sendEmail(c, {kind: 'two_factor_off', to: notified.email});
      await audit(db, {
        actorUserId: c.var.viewer.id,
        action: 'user_two_factor_disabled',
        target: ['user', target.id],
        ipHash: await ipHashOf(c),
      });
      const row = await db.user.findUnique({where: {id: target.id}, select: userSelect});
      return c.json({user: toAdminUser(row!, await emailView(c))});
    }
  )

  // ------------------------------------------------------------------ roles
  .get('/roles', withViewer, requireAuth, requirePermission(CORE.ROLE_READ), withAuthCore, async c => {
    const db = c.var.db;
    const [rows, counts] = await Promise.all([
      db.role.findMany({select: roleSelect, orderBy: {id: 'asc'}, take: 100}),
      // One query for every role, each count stopped at 101 rows of the (role_id, user_id) index.
      db.$queryRaw<{slug: string; n: bigint}[]>`
        SELECT r.slug, (SELECT count(*) FROM (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.id LIMIT 101) s) AS n
        FROM roles r ORDER BY r.id LIMIT 100`,
    ]);
    const members = new Map(counts.map(row => [row.slug, Number(row.n)]));
    return c.json({
      roles: rows.map(row => {
        const n = members.get(row.slug) ?? 0;
        return {...toRoleRow(row), members: {count: Math.min(n, 100), more: n > 100}};
      }),
    });
  })

  .get('/permissions', withViewer, requireAuth, requirePermission(CORE.ROLE_READ), withAuthCore, async c => {
    const rows = await c.var.db.permission.findMany({
      select: {codename: true, title: true, description: true, groupName: true},
      orderBy: [{groupName: 'asc'}, {codename: 'asc'}],
      take: 500,
    });
    const permissions: PermissionRow[] = rows.map(row => ({...row, group: row.groupName}));
    return c.json({permissions});
  })

  .post('/roles', roleBody(true), withViewer, requireAuth, requirePermission(CORE.ROLE_UPDATE), withAuthCore, async c => {
    const db = c.var.db;
    const input = c.req.valid('json') as {slug: string; name: string; description?: string | null; permissions: string[]};
    if (!canDelegate(await actorPermissions(c), input.permissions)) {
      return forbidden(c, 'You can only grant permissions you hold yourself.');
    }
    const catalogue = await db.permission.findMany({
      where: {codename: {in: input.permissions}},
      select: {id: true},
      take: 200,
    });
    if (catalogue.length !== input.permissions.length) {
      return c.json(problem('invalid_input', 'One of those permissions does not exist.'), 422);
    }
    const taken = await db.role.findUnique({where: {slug: input.slug}, select: {id: true}});
    if (taken) return c.json({...problem('invalid_input', 'A role with that slug exists.'), fields: {slug: 'Pick another slug.'}}, 422);
    const role = await db.role.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        permissions: {create: catalogue.map(p => ({permissionId: p.id, grantedBy: c.var.viewer.id}))},
      },
      select: roleSelect,
    });
    await audit(db, {
      actorUserId: c.var.viewer.id,
      action: 'role_created',
      target: ['role', role.slug],
      ipHash: await ipHashOf(c),
      meta: {permissions: input.permissions},
    });
    return c.json({role: toRoleRow(role)}, 201);
  })

  .patch(
    '/roles/:slug',
    roleBody(false),
    withViewer,
    requireAuth,
    requirePermission(CORE.ROLE_UPDATE),
    withAuthCore,
    async c => {
      const db = c.var.db;
      const input = c.req.valid('json') as {name?: string; description?: string | null; permissions?: string[]};
      const role = await db.role.findUnique({where: {slug: c.req.param('slug')}, select: {id: true, ...roleSelect}});
      if (!role) return c.json(problem('not_found', 'No such role.'), 404);
      if (role.slug === SYSTEM_ROLES.OWNER) return forbidden(c, 'The owner role cannot be changed.');

      const held = await actorPermissions(c);
      const before = role.permissions.map(p => p.permission.codename);
      if (!canDelegate(held, [...before, ...(input.permissions ?? [])])) {
        return forbidden(c, 'You can only edit roles whose permissions you hold yourself.');
      }
      let catalogue: {id: number}[] = [];
      if (input.permissions) {
        catalogue = await db.permission.findMany({
          where: {codename: {in: input.permissions}},
          select: {id: true},
          take: 200,
        });
        if (catalogue.length !== input.permissions.length) {
          return c.json(problem('invalid_input', 'One of those permissions does not exist.'), 422);
        }
      }
      await db.$transaction([
        db.role.update({
          where: {id: role.id},
          data: {
            ...(input.name !== undefined ? {name: input.name} : {}),
            ...(input.description !== undefined ? {description: input.description} : {}),
          },
          select: {id: true},
        }),
        ...(input.permissions
          ? [
              db.rolePermission.deleteMany({where: {roleId: role.id}}),
              db.rolePermission.createMany({
                data: catalogue.map(p => ({roleId: role.id, permissionId: p.id, grantedBy: c.var.viewer.id})),
              }),
            ]
          : []),
      ]);
      await audit(db, {
        actorUserId: c.var.viewer.id,
        action: 'role_updated',
        target: ['role', role.slug],
        ipHash: await ipHashOf(c),
        ...(input.permissions ? {meta: {before, after: input.permissions}} : {}),
      });
      const row = await db.role.findUnique({where: {id: role.id}, select: roleSelect});
      return c.json({role: toRoleRow(row!)});
    }
  )

  .delete('/roles/:slug', withViewer, requireAuth, requirePermission(CORE.ROLE_UPDATE), withAuthCore, async c => {
    const db = c.var.db;
    const role = await db.role.findUnique({where: {slug: c.req.param('slug')}, select: {id: true, ...roleSelect}});
    if (!role) return c.json(problem('not_found', 'No such role.'), 404);
    if (role.isSystem) return forbidden(c, 'Built-in roles cannot be deleted.');
    if (!canDelegate(await actorPermissions(c), role.permissions.map(p => p.permission.codename))) {
      return forbidden(c, 'You can only delete roles whose permissions you hold yourself.');
    }
    await db.role.delete({where: {id: role.id}, select: {id: true}});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'role_deleted', target: ['role', role.slug], ipHash: await ipHashOf(c)});
    return c.json({ok: true});
  })

  // ------------------------------------------------------------------ audit
  .get(
    '/audit',
    validator('query', value => ({
      before: typeof value.before === 'string' ? value.before : '',
    })),
    withViewer,
    requireAuth,
    requirePermission(CORE.AUDIT_READ),
    withAuthCore,
    async c => {
      const raw = c.req.valid('query').before;
      const before = /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
      const db = c.var.db;
      const rows = await db.auditEvent.findMany({
        select: {id: true, actorUserId: true, action: true, targetType: true, targetId: true, meta: true, createdAt: true},
        where: before ? {id: {lt: before}} : undefined,
        orderBy: {id: 'desc'},
        take: PAGE + 1,
      });
      const page = rows.slice(0, PAGE);
      // The actors and the people acted on, in ONE bounded lookup.
      const targetIds = page.filter(r => r.targetType === 'user').map(r => Number(r.targetId)).filter(id => Number.isSafeInteger(id) && id > 0);
      const actorIds = [...new Set([...page.map(r => r.actorUserId).filter((id): id is number => id !== null), ...targetIds])];
      const actors = actorIds.length
        ? await db.user.findMany({where: {id: {in: actorIds}}, select: {id: true, name: true}, take: PAGE * 2})
        : [];
      const names = new Map(actors.map(a => [a.id, a.name]));
      const events: AuditRow[] = page.map(row => ({
        id: row.id.toString(),
        actor: row.actorUserId === null ? null : {id: row.actorUserId, name: names.get(row.actorUserId) ?? `User ${row.actorUserId}`},
        action: row.action,
        target: row.targetType ? `${row.targetType}:${row.targetId ?? ''}` : null,
        targetName: row.targetType === 'user' ? (names.get(Number(row.targetId)) ?? null) : null,
        meta: (row.meta as Record<string, unknown> | null) ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
      return c.json({events, nextBefore: rows.length > PAGE ? events.at(-1)!.id : null});
    }
  );
