/**
 * Permissions are CODENAMES: `site:<resource>:<action>`, granted to ROLES,
 * roles given to users (tables `permissions`, `roles`, `role_permissions`,
 * `user_roles`). Wildcards grant a whole branch: `site:user:*`, `site:*`, `*`.
 *
 * Every codename the site checks is declared ONCE, in a catalogue
 * (`definePermissions`): the core one below, plus the site's own in
 * `src/server/permissions.ts`. From it come the codename constants, the `/me`
 * abilities and their type, and the rows of the `permissions` table
 * (`src/platform/permission-sync.ts` inserts new ones at runtime, granting
 * their default roles once). docs/agent/roles-and-permissions.md.
 */

/** One permission, as declared in a catalogue. */
export interface PermissionDef {
  /** `site:<resource>:<action>`. Never rename one that has shipped: roles hold it by codename. */
  readonly codename: string;
  /** What the roles screen shows (≤ 120 characters). */
  readonly title: string;
  /** One sentence: what holding it lets someone do (≤ 255). */
  readonly description?: string;
  /** Groups the roles screen ("Users", "Jobs"; ≤ 48). */
  readonly group: string;
  /** The key in `/me` `abilities` the UI reads (`abilities.manageJobs`). Omit when no UI needs it. */
  readonly ability?: string;
  /**
   * Role slugs that get it the FIRST time it reaches the database, never
   * again (an owner who takes it away keeps it away). `owner` holds `*`
   * already; a slug with no role is skipped.
   */
  readonly roles?: readonly string[];
}

export type Catalogue = Readonly<Record<string, PermissionDef>>;

/** `site:job:manage`, `site:job:*`, `*`: lowercase segments, `*` only last. */
export const CODENAME_RE = /^(\*|[a-z][a-z0-9_-]{0,31}(:[a-z][a-z0-9_-]{0,31}){0,3}(:\*)?)$/;

const ABILITY_RE = /^[a-z][A-Za-z0-9]{0,47}$/;

/** What is wrong with a catalogue (empty when nothing). */
export function catalogueProblems(catalogue: Catalogue): string[] {
  const problems: string[] = [];
  const codenames = new Set<string>();
  const abilities = new Set<string>();
  for (const [key, def] of Object.entries(catalogue)) {
    if (!CODENAME_RE.test(def.codename)) problems.push(`${key}: bad codename "${def.codename}"`);
    if (codenames.has(def.codename)) problems.push(`${key}: codename "${def.codename}" is declared twice`);
    codenames.add(def.codename);
    if (!def.title || def.title.length > 120) problems.push(`${key}: title must be 1-120 characters`);
    if ((def.description?.length ?? 0) > 255) problems.push(`${key}: description must be at most 255 characters`);
    if (!def.group || def.group.length > 48) problems.push(`${key}: group must be 1-48 characters`);
    if (def.ability !== undefined) {
      if (!ABILITY_RE.test(def.ability)) problems.push(`${key}: ability "${def.ability}" must be camelCase`);
      if (abilities.has(def.ability)) problems.push(`${key}: ability "${def.ability}" is declared twice`);
      abilities.add(def.ability);
    }
  }
  return problems;
}

/**
 * Declares a catalogue, keeping its literal types (so `Abilities` and the
 * codename constants are exact). Throws at load on a malformed entry: a typo
 * fails the dev server and the build at once, not a user later.
 */
export function definePermissions<const T extends Catalogue>(catalogue: T): T {
  const problems = catalogueProblems(catalogue);
  if (problems.length) throw new Error(`Invalid permission catalogue:\n  ${problems.join('\n  ')}`);
  return catalogue;
}

/** `{USER_READ: 'site:user:read', …}` from a catalogue. */
export type CodenamesOf<T extends Catalogue> = {readonly [K in keyof T]: T[K]['codename']};

export function codenamesOf<const T extends Catalogue>(catalogue: T): CodenamesOf<T> {
  return Object.fromEntries(Object.entries(catalogue).map(([key, def]) => [key, def.codename])) as CodenamesOf<T>;
}

/** `{manageJobs: boolean, …}`: one flag per entry that names an `ability`. */
export type AbilitiesOf<T extends Catalogue> = {
  [K in keyof T as T[K] extends {readonly ability: infer A extends string} ? A : never]: boolean;
};

export function abilitiesOf<const T extends Catalogue>(catalogue: T, permissions: ReadonlySet<string>): AbilitiesOf<T> {
  const out: Record<string, boolean> = {};
  for (const def of Object.values(catalogue)) {
    if (def.ability) out[def.ability] = grants(permissions, def.codename);
  }
  return out as AbilitiesOf<T>;
}

/**
 * The template's core permissions, used by the managed admin routes. Their
 * rows were also seeded by the first migration; keep titles in step.
 */
export const CORE_PERMISSIONS = definePermissions({
  ALL: {codename: '*', title: 'Everything', description: 'Every permission, now and in the future. Owners only.', group: 'Site'},
  USER_ALL: {codename: 'site:user:*', title: 'Manage users', description: 'Every user permission.', group: 'Users', roles: ['admin']},
  /** See users (email, status, roles) in the admin screens. */
  USER_READ: {
    codename: 'site:user:read',
    title: 'See users',
    description: 'List users with their email, status and roles.',
    group: 'Users',
    ability: 'manageUsers',
  },
  /** Suspend / reactivate users, end their sessions, change their roles. */
  USER_UPDATE: {
    codename: 'site:user:update',
    title: 'Change users',
    description: 'Suspend or reactivate users, end their sessions, change their roles.',
    group: 'Users',
    ability: 'updateUsers',
  },
  ROLE_ALL: {codename: 'site:role:*', title: 'Manage roles', description: 'Every role permission.', group: 'Roles'},
  /** See roles and the permission catalogue. */
  ROLE_READ: {
    codename: 'site:role:read',
    title: 'See roles',
    description: 'See roles and what each one allows.',
    group: 'Roles',
    ability: 'manageRoles',
    roles: ['admin'],
  },
  /** Create, edit and delete custom roles. */
  ROLE_UPDATE: {
    codename: 'site:role:update',
    title: 'Change roles',
    description: 'Create, edit and delete custom roles.',
    group: 'Roles',
    ability: 'editRoles',
  },
  /** Read the audit log. */
  AUDIT_READ: {
    codename: 'site:audit:read',
    title: 'See the activity log',
    description: 'Sign-ins, password changes, role changes.',
    group: 'Security',
    ability: 'readAudit',
    roles: ['admin'],
  },
});

/** The core codenames: `CORE.USER_READ` is `'site:user:read'`. */
export const CORE = codenamesOf(CORE_PERMISSIONS);

/** Seeded system roles (slugs). `owner` holds `*` and cannot be edited or deleted. */
export const SYSTEM_ROLES = {OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member'} as const;

/**
 * Does a set of codenames grant `codename`? The exact codename, or a wildcard
 * parent (`site:user:*`, `site:*`, `*`).
 */
export function grants(permissions: ReadonlySet<string>, codename: string): boolean {
  if (permissions.has(codename) || permissions.has('*')) return true;
  const parts = codename.split(':');
  for (let i = parts.length - 1; i > 0; i--) {
    if (permissions.has(`${parts.slice(0, i).join(':')}:*`)) return true;
  }
  return false;
}

/**
 * OWN-RECORDS variants: `site:job:update` lets you act on every job,
 * `site:job:update_own` only on jobs whose owner is you. Declare both in the
 * catalogue; check them with `scopeOf` / `allows` (server: `can`,
 * `permissionScope` in `src/platform/guards.ts`), never by hand.
 */
export const ownCodename = (codename: string) => (codename.endsWith('_own') ? codename : `${codename}_own`);

/** `'all'` (holds `codename`), `'own'` (holds only its `_own` variant) or `'none'`. */
export function scopeOf(permissions: ReadonlySet<string>, codename: string): 'all' | 'own' | 'none' {
  const own = ownCodename(codename);
  if (own !== codename && grants(permissions, codename)) return 'all';
  if (grants(permissions, own)) return 'own';
  return 'none';
}

/**
 * May `viewerId` do `codename` to a record owned by `ownerId`? Yes with
 * `codename` itself; with `<codename>_own` only when the record is theirs. A
 * record with no owner (`null`) is nobody's own.
 */
export function allows(
  permissions: ReadonlySet<string>,
  codename: string,
  viewerId: number | null,
  ownerId: number | null | undefined
): boolean {
  const scope = scopeOf(permissions, codename);
  if (scope === 'all') return true;
  return scope === 'own' && viewerId !== null && ownerId !== null && ownerId !== undefined && ownerId === viewerId;
}

/**
 * Anti-escalation: may someone holding `held` hand out `wanted`? Only when
 * every wanted codename is already granted to them, wildcard for wildcard
 * (`site:user:*` needs `site:user:*`, `site:*` or `*`).
 */
export function canDelegate(held: ReadonlySet<string>, wanted: Iterable<string>): boolean {
  for (const codename of wanted) {
    if (!grants(held, codename)) return false;
  }
  return true;
}
