import {abilitiesOf, type AbilitiesOf, codenamesOf, CORE_PERMISSIONS, definePermissions} from '../platform/auth/codenames';

/**
 * THE permission catalogue: every codename this site checks, declared ONCE.
 * Adding an entry here is the whole job (docs/agent/roles-and-permissions.md):
 *
 *   - `PERMISSIONS.<KEY>` is its codename, for `requirePermission` / `can`;
 *   - `ability` adds a flag to `/me` `abilities` (and to the `Abilities` type)
 *     for the UI: portal nav items, buttons, `pageContext()` pages;
 *   - the row reaches the `permissions` table (the roles screen) on the next
 *     signed-in request after deploy, and `roles` get it that first time only
 *     (`src/platform/permission-sync.ts`). No migration.
 *
 * Never rename or reuse a shipped codename: roles hold it by name. Browser-safe
 * (no server imports): the portal reads the `Abilities` type from here.
 */
export const CATALOGUE = definePermissions({
  ...CORE_PERMISSIONS,
  /** Post, edit, close and delete jobs (`/dashboard/jobs`). */
  JOB_MANAGE: {
    codename: 'site:job:manage',
    title: 'Manage jobs',
    description: 'Post, edit, close and delete jobs on the job board.',
    group: 'Jobs',
    ability: 'manageJobs',
    roles: ['admin'],
  },
  /**
   * Kinroot: who may claim the CRM workspace. A holder with no team row becomes its Owner on
   * the first visit (it replaces Kinroot's old first-run setup). Everyone else joins through a
   * team invite; ranks inside the team (Owner, Admin, Member, Viewer) are the CRM's own data
   * (`Member.role`, src/server/lib/member.ts). Owners only (`*`) unless granted.
   */
  CRM_OWN: {
    codename: 'site:crm:own',
    title: 'Own the CRM',
    description: 'Become an Owner of the Kinroot workspace without an invite.',
    group: 'CRM',
    ability: 'ownCrm',
  },
});

/** Codenames by key: `PERMISSIONS.JOB_MANAGE` is `'site:job:manage'`. */
export const PERMISSIONS = codenamesOf(CATALOGUE);

export type Codename = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** What the UI may SHOW the visitor (`/me`); every route checks again. */
export type Abilities = AbilitiesOf<typeof CATALOGUE>;

/** The abilities a set of granted codenames gives (`/me`). */
export const abilitiesFor = (permissions: ReadonlySet<string>): Abilities => abilitiesOf(CATALOGUE, permissions);

/** A guest's abilities: every flag false. */
export const NO_ABILITIES: Abilities = abilitiesFor(new Set());
