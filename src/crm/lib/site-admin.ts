// The site's own admin API (`/site-api/admin/*`, `src/platform/auth/admin.ts`) for Kinroot's
// Settings → Team (account actions, the Customers tab), Roles and the "Sign-in & security" part of the Audit log.
//
// Not Kinroot's `api` helper: that one targets `/site-api/crm` and sends a 401 to the sign-in page.
// These calls go through `siteFetch` (CSRF header on writes, ONE shared refresh on an expired
// session, the editor Preview's header-carried cookies) and answer errors as `SiteApiError`, so a
// screen shows them in place. Every route checks the site permission again on the server; the
// abilities below only decide what a screen SHOWS.

import {infiniteQueryOptions, queryOptions, useQuery} from '@tanstack/react-query';

import {refreshSession, siteFetch} from '../../platform/browser';
import type {AdminUser, AuditRow, PermissionRow, RoleRow, Viewer} from '../../platform/types';
import type {Abilities} from '../../server/permissions';

export type {AdminUser, AuditRow, PermissionRow, RoleRow};

/** A Site API refusal: its words, its status, and its field errors (`422 {fields}`). */
export class SiteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Query = Record<string, string | undefined>;

async function call<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) params.set(k, v ?? '');
  const search = params.toString();
  let res: Response;
  try {
    res = await siteFetch(`/site-api${path}${search ? `?${search}` : ''}`, {
      method,
      headers: body !== undefined ? {'content-type': 'application/json'} : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SiteApiError('The site did not answer. Check your connection and try again.', 0);
  }
  const data = (await res.json().catch(() => null)) as (T & {message?: string; fields?: Record<string, string>}) | null;
  if (!res.ok) {
    const fallback =
      res.status === 401 ? 'Your session ended. Sign in again.' : res.status === 403 ? 'You do not have permission to do that.' : `Something went wrong (${res.status}). Try again.`;
    throw new SiteApiError(data?.message ?? fallback, res.status, data?.fields ?? {});
  }
  return data as T;
}

export const siteApi = {
  get: <T>(path: string, query?: Query) => call<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

/** Query keys, all under one prefix (`siteKeys.all` refreshes every one). */
export const siteKeys = {
  all: ['site-admin'] as const,
  me: ['site-admin', 'me'] as const,
  access: ['site-admin', 'access'] as const,
  users: ['site-admin', 'users'] as const,
  roles: ['site-admin', 'roles'] as const,
  permissions: ['site-admin', 'permissions'] as const,
  audit: ['site-admin', 'audit'] as const,
};

// ─── Who is looking ───

export type SiteMe = {viewer: Viewer; roles: string[]; abilities: Abilities};

/**
 * `GET /site-api/me`: the visitor, their site roles and what the UI may show them (one flag per
 * permission: `manageUsers` = site:user:read, `updateUsers` = site:user:update, `manageRoles` =
 * site:role:read, `editRoles` = site:role:update, `readAudit` = site:audit:read). An expired
 * session is refreshed once.
 */
const siteMeQuery = queryOptions({
  queryKey: siteKeys.me,
  queryFn: async () => {
    const me = await siteApi.get<SiteMe>('/me');
    if (me.viewer.state === 'returning' && (await refreshSession())) return siteApi.get<SiteMe>('/me');
    return me;
  },
  staleTime: 60_000,
});

export function useSiteMe() {
  const q = useQuery(siteMeQuery);
  const me = q.data;
  return {
    query: q,
    loading: q.isPending,
    error: q.error,
    me,
    abilities: me?.abilities,
    viewerId: me?.viewer.id ?? null,
    /** The site's owner: the only one who sees every address and may look people up by email. */
    isOwner: Boolean(me?.roles.includes('owner')),
  };
}

/** `GET /site-api/auth/me`: every codename the viewer holds, for "you can only grant what you hold". */
export const siteAccessQuery = queryOptions({
  queryKey: siteKeys.access,
  queryFn: () => siteApi.get<{roles: string[]; permissions: string[]}>('/auth/me'),
  staleTime: 60_000,
});

// ─── Accounts ───

export type StatusFilter = '' | 'active' | 'suspended';
export type UsersPage = {users: AdminUser[]; nextBefore: number | null};

/** `GET /site-api/admin/users` (site:user:read): every account, newest first, 25 a page (keyset). */
export const siteUsersQuery = (filter: {email: string; status: StatusFilter}) =>
  infiniteQueryOptions({
    queryKey: [...siteKeys.users, filter],
    initialPageParam: '',
    queryFn: ({pageParam}) => siteApi.get<UsersPage>('/admin/users', {before: pageParam, email: filter.email, status: filter.status}),
    getNextPageParam: (last) => (last.nextBefore ? String(last.nextBefore) : undefined),
  });

// ─── Roles ───

/** `GET /site-api/admin/roles` (site:role:read). */
export const siteRolesQuery = queryOptions({
  queryKey: siteKeys.roles,
  queryFn: () => siteApi.get<{roles: RoleRow[]}>('/admin/roles'),
});

/** `GET /site-api/admin/permissions` (site:role:read): the catalogue; changes only with a deploy. */
export const sitePermissionsQuery = queryOptions({
  queryKey: siteKeys.permissions,
  queryFn: () => siteApi.get<{permissions: PermissionRow[]}>('/admin/permissions'),
  staleTime: 5 * 60_000,
});

/** The owner role: everything, always; nobody edits or deletes it. */
export const OWNER_ROLE = 'owner';

/** The SAME limits `src/platform/auth/admin.ts` enforces on a role. */
const ROLE_SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;

export function roleFieldErrors(values: {slug: string; name: string; description: string}, creating: boolean) {
  const errors: Partial<Record<'slug' | 'name' | 'description', string>> = {};
  const slug = values.slug.trim().toLowerCase();
  if (creating) {
    if (!slug) errors.slug = 'Enter a short id, like “editor”.';
    else if (!ROLE_SLUG_RE.test(slug)) errors.slug = 'Use 2 to 48 lowercase letters, digits or dashes, starting with a letter.';
  }
  const name = values.name.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > 80) errors.name = 'Use at most 80 characters.';
  if (values.description.trim().length > 255) errors.description = 'Use at most 255 characters.';
  return errors;
}

// ─── Sign-in & security events ───

export type AuditPage = {events: AuditRow[]; nextBefore: string | null};

/** `GET /site-api/admin/audit` (site:audit:read): the site's `audit_events`, newest first, 25 a page. */
export const siteAuditQuery = infiniteQueryOptions({
  queryKey: siteKeys.audit,
  initialPageParam: '',
  queryFn: ({pageParam}) => siteApi.get<AuditPage>('/admin/audit', {before: pageParam}),
  getNextPageParam: (last) => last.nextBefore ?? undefined,
});

export type EventKind = 'signup' | 'signin' | 'signout' | 'email' | 'password' | 'twoFactor' | 'warning' | 'roles' | 'owner' | 'blocked' | 'deleted' | 'other';

/** One event in words: who (bold), what they did, and the kind (its icon and colour). */
export type EventLine = {who: string | null; what: string; kind: EventKind; detail?: string};

const splitTarget = (target: string): [string, string] => {
  const at = target.indexOf(':');
  return at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at + 1)];
};

/** `user_roles_changed` keeps `{added, removed}`: "Added admin · Removed editor". */
function roleChanges(meta: Record<string, unknown>): string | undefined {
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  const added = list(meta.added);
  const removed = list(meta.removed);
  const parts = [added.length ? `Added ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The actions the site's auth writes to `audit_events` (`grep -rn "audit(" src/platform`), as the
 * template's Activity screen worded them. An action not listed here still shows, in its own words.
 */
export function describeSiteEvent(event: AuditRow): EventLine {
  const who = event.actor?.name ?? 'Someone';
  const [kind, id] = event.target ? splitTarget(event.target) : [null, null];
  const onSelf = kind === 'user' && event.actor !== null && String(event.actor.id) === id;
  const user = kind === 'user' && id ? (onSelf ? 'themselves' : (event.targetName ?? `user #${id}`)) : 'someone';
  const role = kind === 'role' && id ? `the “${id}” role` : 'a role';
  const meta = event.meta ?? {};

  switch (event.action) {
    case 'user_registered':
    case 'registered':
      return {who, what: 'signed up', kind: 'signup'};
    case 'signed_in_with_code':
      return {who, what: 'signed in with an emailed code', kind: 'signin'};
    case 'owner_signed_in':
      return {who, what: 'signed in from the platform as the owner', kind: 'signin'};
    case 'logout_all':
      return {who, what: 'signed out on every device', kind: 'signout'};
    case 'device_signed_out':
      return {who, what: 'signed out one of their devices', kind: 'signout'};
    case 'email_verified':
      return {who, what: 'confirmed their email', kind: 'email'};
    case 'email_change_requested':
      return {who, what: 'asked to change their email', kind: 'email'};
    case 'email_changed':
      return {who, what: 'changed their email', kind: 'email'};
    case 'password_changed':
      return {who, what: 'changed their password', kind: 'password'};
    case 'password_reset':
      return {who, what: 'reset their password', kind: 'password'};
    case 'password_reset_requested':
      return {who: null, what: `A password reset was asked for ${user}`, kind: 'password'};
    case 'two_factor_enabled':
      return {who, what: 'turned on two-step sign-in', kind: 'twoFactor'};
    case 'two_factor_disabled':
      return {who, what: 'turned off two-step sign-in', kind: 'warning'};
    case 'owner_link_two_factor':
      return {who, what: 'signed in from the platform with two-step sign-in', kind: 'twoFactor'};
    case 'recovery_codes_renewed':
      return {who, what: 'made new recovery codes', kind: 'twoFactor'};
    case 'recovery_code_used':
      return {who, what: 'signed in with a recovery code', kind: 'warning'};
    case 'user_two_factor_disabled':
      return {who, what: `turned off two-step sign-in for ${user}`, kind: 'warning'};
    case 'refresh_reuse_detected':
      return {who: null, what: `A reused sign-in token was refused, so ${user} was signed out`, kind: 'warning'};
    case 'user_sessions_revoked':
      return {who, what: `signed ${user} out everywhere`, kind: 'signout'};
    case 'user_roles_changed':
      return {who, what: onSelf ? 'changed their own roles' : `changed the roles of ${user}`, kind: 'roles', detail: roleChanges(meta)};
    case 'role_created':
      return {who, what: `created ${role}`, kind: 'roles'};
    case 'role_updated':
      return {who, what: `edited ${role}`, kind: 'roles'};
    case 'role_deleted':
      return {who, what: `deleted ${role}`, kind: 'deleted'};
    case 'owner_claimed':
      return {who, what: 'became the owner', kind: 'owner'};
    case 'owner_transferred':
      return {who, what: `took the owner seat from ${user}`, kind: 'owner'};
    case 'owner_removed':
      return {who: null, what: `The owner role was taken from ${user}`, kind: 'warning'};
    case 'user_suspended':
      return {who, what: `blocked ${user}`, kind: 'blocked'};
    case 'user_reactivated':
      return {who, what: `unblocked ${user}`, kind: 'signup'};
    case 'account_deleted':
      return {who: null, what: `The account of ${user} was deleted`, kind: 'deleted'};
    default:
      return {who, what: event.action.replaceAll('_', ' ') + (event.target ? ` (${event.target})` : ''), kind: 'other'};
  }
}
