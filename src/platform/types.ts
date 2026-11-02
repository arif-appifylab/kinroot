/**
 * Platform shapes shared by the platform layer and the app. Browser-safe.
 * Managed by the template: see `src/platform/README.md`.
 */

export interface Site {
  id: number;
  name: string;
  favIcon: string | null;
  logo: string | null;
}

/**
 * `user`       signed in (a valid access token for an active account)
 * `returning`  the access token is gone or expired but a refresh token is
 *              there: the BROWSER refreshes once (`refreshSession()`)
 * `guest`      signed out
 */
export type ViewerState = 'user' | 'returning' | 'guest';

export interface Viewer {
  state: ViewerState;
  /** `users.id`, when signed in. */
  id: number | null;
  name: string | null;
  /** The viewer's OWN email. Never put another user's email in a viewer. */
  email: string | null;
  emailVerified: boolean;
}

/** What a signed-in viewer may do: their role slugs and every codename those roles grant. */
export interface Access {
  roles: string[];
  permissions: string[];
}

/** A user as the admin screens see it (holders of `site:user:read` only). */
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  status: string;
  emailVerified: boolean;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
  /** Two-step sign-in is on. */
  twoFactor: boolean;
}

export interface RoleRow {
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  /**
   * How many people hold it, counted up to 100 (`more`: there are more than 100). Only on the
   * roles list (`GET /admin/roles`); a bounded count through the `(role_id, user_id)` index.
   */
  members?: {count: number; more: boolean};
}

export interface PermissionRow {
  codename: string;
  title: string;
  description: string | null;
  group: string;
}

export interface AuditRow {
  /** A bigint, as a string. Pass back as `?before=`. */
  id: string;
  actor: {id: number; name: string} | null;
  action: string;
  target: string | null;
  /** The person acted on, when the target is a user that still exists ("Sam Rivera"). */
  targetName?: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}
