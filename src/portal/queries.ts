import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import type {AdminUser, AuditRow, JobsPage, PermissionRow, RoleRow} from '../lib/types';
import {refreshSession} from '../platform/browser';
import {api, read} from './api';
import type {Me} from './shared';

/**
 * Every portal read, ONCE: the screen (`useQuery(x)`) and its route's loader
 * (`queryClient.ensureQueryData(x)`, src/portal/routes.tsx) use the same
 * options, so a hover on a link fetches what the screen will show and the
 * screen renders from the cache. Kept apart from the screens so the routes can
 * import them without pulling the (lazy) screen code into the first bundle.
 *
 * A save invalidates by key prefix (`['users']`, `['jobs']`, `['roles']`).
 */

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    const me = await read<Me>(api.me.$get());
    // The access token ran out but the refresh token is still there: refresh ONCE.
    if (me.viewer.state === 'returning' && (await refreshSession())) return read<Me>(api.me.$get());
    return me;
  },
  staleTime: 60_000,
});

/** The brand, for the sidebar. Public and cached on the server. */
export const siteQuery = queryOptions({
  queryKey: ['site'],
  queryFn: () => read<{site: {name: string; logo: string | null} | null}>(api.site.$get()),
  staleTime: 5 * 60_000,
});

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => read<{database: boolean; auth: boolean; siteKey: boolean; ownerSetup: boolean}>(api.health.$get()),
});

export type UsersPage = {users: AdminUser[]; nextBefore: number | null};
export type AuditPage = {events: AuditRow[]; nextBefore: string | null};

/** The overview's tiles: the FIRST page of each list, under the lists' own key prefixes. */
export const firstUsersQuery = queryOptions({
  queryKey: ['users', 'first'],
  queryFn: () => read<UsersPage>(api.admin.users.$get({query: {before: '', email: '', status: ''}})),
});
export const firstJobsQuery = queryOptions({
  queryKey: ['jobs', 'manage', 'first'],
  queryFn: () => read<JobsPage>(api.jobs.manage.$get({query: {before: ''}})),
});
export const firstAuditQuery = queryOptions({
  queryKey: ['audit', 'first'],
  queryFn: () => read<AuditPage>(api.admin.audit.$get({query: {before: ''}})),
});

/** `/dashboard/users`: every account, newest first, filtered by exact email and status. */
export const usersQuery = (filter: {email: string; status: string}) =>
  infiniteQueryOptions({
    queryKey: ['users', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<UsersPage>(api.admin.users.$get({query: {before: pageParam ?? '', email: filter.email, status: filter.status}})),
    getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
  });

/** `/dashboard/jobs`: every job, open and closed. */
export const manageJobsQuery = infiniteQueryOptions({
  queryKey: ['jobs', 'manage'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<JobsPage>(api.jobs.manage.$get({query: {before: pageParam ?? ''}})),
  getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
});

/** `/dashboard/activity`: the audit log, newest first. */
export const auditQuery = infiniteQueryOptions({
  queryKey: ['audit'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<AuditPage>(api.admin.audit.$get({query: {before: pageParam ?? ''}})),
  getNextPageParam: last => last.nextBefore ?? undefined,
});

export const rolesQuery = queryOptions({
  queryKey: ['roles'],
  queryFn: () => read<{roles: RoleRow[]}>(api.admin.roles.$get()),
});

/** The permission catalogue: changes only with a migration. */
export const permissionsQuery = queryOptions({
  queryKey: ['permissions'],
  queryFn: () => read<{permissions: PermissionRow[]}>(api.admin.permissions.$get()),
  staleTime: 5 * 60_000,
});

/** Two-step sign-in, for the account screen. */
export type TwoFactorStatus = {enabled: boolean; recoveryCodesLeft: number; hasPassword: boolean};
export const twoFactorQuery = queryOptions({
  queryKey: ['account', 'two-factor'],
  queryFn: () => read<TwoFactorStatus>(api.auth['two-factor'].$get()),
});

/** The devices signed in to this account (this one marked `current`). */
export type DeviceSession = {id: string; device: string; lastActiveAt: string; current: boolean};
export const sessionsQuery = queryOptions({
  queryKey: ['account', 'sessions'],
  queryFn: () => read<{sessions: DeviceSession[]}>(api.auth.sessions.$get()),
});
