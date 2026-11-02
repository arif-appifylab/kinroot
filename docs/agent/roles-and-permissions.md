---
title: Roles and permissions
read-when: before gating a feature on who may use it, adding an admin screen, a new permission or a role
---
Who may do what is decided by CODENAMES (`site:<resource>:<action>`) granted to ROLES, roles
given to USERS. Tables: `permissions` (catalogue), `roles`, `role_permissions`, `user_roles`.
ONE source of truth: the catalogue `CATALOGUE` in `src/server/permissions.ts` (yours; the core
entries come from `src/platform/auth/codenames.ts`, managed). From it come `PERMISSIONS.<KEY>`
(the codenames), the `/me` `abilities` and their `Abilities` type, and the `permissions` rows.

## Seeded
| Role | Grants | Notes |
| --- | --- | --- |
| `owner` | `*` | Cannot be edited or deleted. Claimed once (`auth_state`). The last owner keeps it. |
| `admin` | `site:user:*`, `site:role:read`, `site:audit:read`, `site:job:manage` | Editable by owners. |
| `member` | (nothing) | Every new account (`defaultRole`). |

Core codenames: `site:user:read`, `site:user:update`, `site:role:read`, `site:role:update`,
`site:audit:read`; the template's feature: `site:job:manage`. Wildcards: `site:user:*`, `site:*`, `*`.

## Rules
- Gate on a CODENAME, never on a role slug or a user id (`requireRole` exists; don't use it).
  Owners rename and edit roles; codenames never change. One codename per capability, the
  narrowest that fits.
- The route guard is the enforcement; `abilities` only hides UI. Every gated screen has both.
- Anti-escalation is built into the admin API (`canDelegate`): nobody grants, removes, edits or
  acts on access they do not hold themselves. Keep that rule in any role logic you add.
- Permissions are re-read from the database on every request (memoized per request), never put
  in the JWT: a role change applies on the next request.
- A codename is DECLARED in the catalogue, never written in a migration, never created from the
  browser. On the first signed-in request after a deploy, `syncPermissions`
  (`src/platform/permission-sync.ts`) inserts new entries and grants their `roles` ONCE, in one
  statement; it updates changed titles and never deletes. Never rename or reuse a shipped
  codename (roles hold it by name); to retire one, drop the entry and stop checking it.
- Own records: `<codename>_own` (`site:note:update_own`) means "only records whose owner is
  me". Enforce it with the helpers below, never with your own `if`. The owner id comes from
  the DATABASE row, never from the request body.
- Prerendered pages have no visitor: they cannot be gated per user. Gate in the portal
  (preferred) or in an on-demand page with `pagePermission`.

## Deny by default
- A Site API route with no guard is public. Every route that is not meant for everyone starts
  `withViewer, requireAuth` and then gates: `requirePermission(codename)` for a capability, a
  scoped query (below) for "mine". Signed in is not permission: `requireAuth` alone means "any
  account", and anyone can register one (`registration` in `src/server/auth-settings.ts`).
- New capability → new codename, granted to nobody but owners (`*`) unless its entry names
  `roles`. Never widen `member` by default; owners grant in `/dashboard/roles`.
- Check the CAPABILITY, not who someone is: `can(c, PERMISSIONS.INVOICE_REFUND)`, never
  `roles.includes('admin')`, `viewer.id === 1` or an email allow-list.

## Object level: every row, every time
The codename says "may update notes"; the query decides WHICH notes. Both, in the same handler:
| Shape | Do |
| --- | --- |
| only my rows | `where: {id, ownerId: c.var.viewer.id!}` in the read/`updateMany`/`deleteMany`; no row → 404 |
| all or own (`_own`) | `requirePermission(X, {orOwn: true})` + `can(c, X, {ownerId: row.ownerId})` per row, `permissionScope` for lists |
| everyone's, by staff | `requirePermission(X)`; the row still exists check → 404 |
| public rows | an explicit public filter in the query (`status: 'open'`, `jobs.ts`), a public `select` |
| team/workspace rows | the membership check below, and `teamId` in every `where` |
Ids in the URL or body only SELECT; they never prove access. A 404 for "not yours" (same as "not
there") tells nobody which ids exist.

## Teams, workspaces, organisations (when you add one)
Site roles are site-wide ("may manage jobs"). Roles INSIDE a team are your own data:
```prisma
model Team {
  id        Int      @id @default(autoincrement())
  name      String   @db.VarChar(80)
  createdAt DateTime @default(now()) @map("created_at")
  @@map("teams")
}
model TeamMember {
  teamId    Int      @map("team_id")
  userId    Int      @map("user_id")
  role      String   @db.VarChar(16)        // 'owner' | 'admin' | 'member', checked in the validator
  createdAt DateTime @default(now()) @map("created_at")
  team      Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
  @@id([teamId, userId])
  @@index([userId, teamId])                 // "my teams"
  @@map("team_members")
}
```
Every team-owned table has `teamId` (NOT NULL, FK, first column of its indexes: `@@index([teamId,
id])`, `@@unique([teamId, slug])`). Then, in `src/server/teams.ts`, ONE helper every team route calls:
```ts
const TEAM_RANK = {member: 1, admin: 2, owner: 3} as const;
export async function membership(db: PrismaClient, teamId: number, userId: number) {
  const m = await db.teamMember.findUnique({where: {teamId_userId: {teamId, userId}}, select: {role: true}});
  return m ? {role: m.role as keyof typeof TEAM_RANK, rank: TEAM_RANK[m.role as keyof typeof TEAM_RANK] ?? 0} : null;
}
// route: /site-api/teams/:teamId/projects/:id
const m = await membership(db, teamId, c.var.viewer.id!);
if (!m) return c.json(problem('not_found', 'No such team.'), 404);
const project = await db.project.findFirst({where: {id, teamId}, select});   // teamId in EVERY query
```
- The team comes from the path, but access comes from `team_members` for `c.var.viewer.id`, read
  on the server per request. Never trust a `teamId` in the body, a header or local storage alone.
- Cross-team links: attaching record A to B (a task to a project, a file to a note) checks both
  have the SAME `teamId`, in the query (`findFirst({where: {id: projectId, teamId}})`).
- Inside a team, gate on rank or a small capability map (`m.rank >= TEAM_RANK.admin`); site
  staff who may see every team get a site codename (`site:team:read`), checked with `can`, and
  their access to someone's team is audited.
- The last team owner can't leave, be removed or be demoted (one conditional write, `409`).
- Invites to a team: a random hashed token (`security.md` › A04) bound to the team and an email,
  single use, expiring; accepting adds a `member` row for the SIGNED-IN user, never for an id in
  the link. It is never a sign-in link: the invited person signs in or registers through the
  built-in pages first (`auth.md` › Never).

## Field level: who may change which field
- One validator per audience, or one that drops what the caller may not set. Fields like
  `status`, `featured`, `ownerId`, `price`, `role`, `verified` need their own codename:
  ```ts
  if (input.status !== undefined && !(await can(c, PERMISSIONS.POST_PUBLISH))) return forbidden(c);
  ```
- Never accept `ownerId`, `teamId`, `createdBy`, counters or timestamps from the client
  (`security.md` › API3). Moving a row to another owner or team is its own route and codename.
- Reading: a `select` per audience. Emails of other people only with `site:user:read`; staff-only
  columns (internal notes, flags) only in the staff route's `select`.

## Admin-only screens
- A portal screen + routes behind ONE codename with an `ability` (recipes below). The nav item
  hides by `abilities`; every route behind it checks `requirePermission` again.
- Admin routes live under their own path (`/site-api/<feature>/manage…`, like `jobs.ts`), never a
  `?admin=1` flag on a public route.
- Never an admin backdoor: no "if the email is X", no hidden route, no seed admin (`auth.md`).

## No privilege escalation
- The managed admin API refuses to grant, remove or edit access the actor does not hold
  (`canDelegate` in `src/platform/auth/codenames.ts`, wildcard for wildcard), and the last owner
  keeps `owner`. Your own role-like logic (team roles, delegated access, API tokens you issue)
  follows the same rule:
  ```ts
  import {canDelegate} from '../../platform/auth';
  const {permissions} = await getAccess(c.req.raw);
  if (!canDelegate(new Set(permissions), wanted)) return forbidden(c);   // site codenames
  if (TEAM_RANK[input.role] > m.rank) return forbidden(c);               // team roles: never above your own
  ```
- Nobody changes their own access (role, rank, status) except to lower it; nobody acts on someone
  who out-ranks them.

## Audit sensitive actions
Every grant, revoke, membership change, ownership transfer, staff access to someone else's data,
export and delete of your feature writes one `audit()` event (`security.md` › A09): actor, action
(`team_member_added`), target (`['team', teamId]`), small non-personal `meta`. The managed admin
API already audits its own changes (`/dashboard/activity`).

## Recipe: add a permission (ONE edit)
Add an entry to `CATALOGUE` in `src/server/permissions.ts`. That is all: no migration, no
`/me` change, no type change.
```ts
CRM_READ: {
  codename: 'site:crm:read',
  title: 'See contacts',                     // the roles screen, ≤ 120
  description: 'Open the CRM and read contacts.',
  group: 'CRM',
  ability: 'seeContacts',                    // optional: `abilities.seeContacts` for the UI
  roles: ['admin'],                          // optional: who gets it the first time (owners hold `*`)
},
```
A malformed entry (bad codename, duplicate codename or ability, empty title) throws at load:
the dev server and the build fail at once. `tests/permissions.test.ts` checks the catalogue.

## Recipe: gate an API route
`validator → withViewer → requireAuth → requirePermission(PERMISSIONS.CRM_READ) → withDb`.
A handler-level check: `if (!(await can(c, PERMISSIONS.CRM_READ))) return forbidden(c);`
(`src/platform/guards.ts`).

## Recipe: own records only
Declare both entries (`NOTE_UPDATE: 'site:note:update'`, `NOTE_UPDATE_OWN:
'site:note:update_own'`). Then:
```ts
.patch('/:id', body, withViewer, requireAuth, requirePermission(PERMISSIONS.NOTE_UPDATE, {orOwn: true}), withDb, async c => {
  const note = await c.var.db.note.findUnique({where: {id}, select: {id: true, ownerId: true}});
  if (!note) return c.json(problem('not_found', 'No such note.'), 404);
  if (!(await can(c, PERMISSIONS.NOTE_UPDATE, {ownerId: note.ownerId}))) return forbidden(c);
  …
})
```
Lists: `const scope = await permissionScope(c, PERMISSIONS.NOTE_UPDATE)` is `'all' | 'own' |
'none'`; for `'own'` add `where: {ownerId: c.var.viewer.id!}`. `{orOwn: true}` without `can` /
`permissionScope` in the handler is a hole. A wildcard (`site:note:*`) grants both.

## Recipe: gate a portal screen or nav item
Give the entry an `ability`; the portal reads `me.data?.abilities.<ability>`: a `NAV_GROUPS`
item takes `ability: '<ability>'`, a button `{abilities?.<ability> && …}`. The screen's API
routes are still guarded.

## Recipe: gate an on-demand (SSR) page
```astro
---
import NoAccess from '../../components/NoAccess.astro';
import Base from '../../layouts/Base.astro';
import {read} from '../../server/backend';
import {pagePermission} from '../../server/page-access';
import {PERMISSIONS} from '../../server/permissions';
export const prerender = false;
const page = await pagePermission(Astro, PERMISSIONS.REPORT_READ);
const report = page.allowed ? await read<Report>(page.api.reports.$get()) : null;
---
<Base site={page.site} viewer={page.viewer} title="Reports" noindex>
  {page.allowed ? <main>…</main> : <NoAccess site={page.site} denied={page.denied} />}
</Base>
```
`pagePermission` is `pageContext()` plus `allowed` / `denied` (`signed_out` 401, `refreshing`
401 — the layout refreshes and reloads, `forbidden` 403). It never redirects: the editor
Preview drops cookies, so a gated page there always shows the sign-in prompt; check it on the
live site, or build the screen in the portal. Never gate on `viewer.state` alone.

## Recipe: a new role with defaults
Prefer letting the owner create it in `/dashboard/roles`. If the site needs it from day one, a
migration: `INSERT INTO "roles" ("slug","name","description","is_system","updated_at") VALUES
('editor','Editor','Writes and edits posts.', false, CURRENT_TIMESTAMP) ON CONFLICT ("slug") DO NOTHING;`
in the SAME deploy as (or before) the catalogue entries that name it in `roles`: defaults are
granted only when the codename is first inserted, and a slug with no role is skipped. To give an
EXISTING codename to a new role, grant it in that migration (`INSERT INTO "role_permissions" …
SELECT … ON CONFLICT DO NOTHING`, matched by slug and codename). Never mark your own roles
`is_system`.

## Admin API (managed, `/site-api/admin/*`)
`GET /users?before=&email=&status=` (exact email match, keyset by id), `GET /users/:id`,
`PATCH /users/:id {status}`, `PUT /users/:id/roles {roles}`, `POST /users/:id/sessions/revoke`,
`GET /roles`, `GET /permissions`, `POST /roles`, `PATCH /roles/:slug`, `DELETE /roles/:slug`,
`GET /audit?before=`. Screens: `/dashboard/users`, `/dashboard/roles`, `/dashboard/activity`.
Every change writes `audit_events`. Show user emails only on these screens.
