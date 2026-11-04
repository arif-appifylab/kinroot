import {useMutation, useQuery, useQueryClient, type QueryKey} from '@tanstack/react-query';
import {toast} from 'sonner';

import {api, shownInPlace} from '@/lib/api';
import type {CustomField, EmailAccount, EmailDesignResponse, EmailTemplate, EntityType, Me, Pipeline, SettingsResponse} from '@/lib/types';

export const keys = {
  auth: ['auth'] as const,
  team: ['team'] as const,
  pipelines: ['pipelines'] as const,
  settings: ['settings'] as const,
  fields: (entity?: EntityType) => ['fields', entity ?? 'all'] as const,
  contacts: ['contacts'] as const,
  companies: ['companies'] as const,
  deals: ['deals'] as const,
  tasks: ['tasks'] as const,
  timeline: ['timeline'] as const,
  notes: ['notes'] as const,
  email: ['email'] as const,
  dashboard: ['dashboard'] as const,
  views: (entity: EntityType) => ['views', entity] as const,
  tags: ['tags'] as const,
  notifications: ['notifications'] as const,
  files: ['files'] as const,
  follows: ['follows'] as const,
  webhooks: ['webhooks'] as const,
  incomingWebhooks: ['incoming-webhooks'] as const,
  dataIn: ['data-in'] as const,
  forms: ['forms'] as const,
  lists: ['lists'] as const,
  reports: ['reports'] as const,
  dashboards: ['dashboards'] as const,
  goals: ['goals'] as const,
  forecast: ['forecast'] as const,
  tickets: ['tickets'] as const,
  emailDesign: ['email', 'design'] as const,
  scheduling: ['scheduling'] as const,
  calendar: ['calendar'] as const,
  scoring: ['scoring'] as const,
  audit: ['audit'] as const,
  recycleBin: ['recycle-bin'] as const,
  duplicates: ['duplicates'] as const,
  automations: ['automations'] as const,
  imports: ['imports'] as const,
  exports: ['exports'] as const,
  inbox: ['inbox'] as const,
  badges: ['badges'] as const,
};

/** The app shell's numbers (GET /badges: one capped query; counts above 99 show as "99+"). */
export type Badges = {tasks: number; reminders: number; inbox: number; tickets: number; notifications: number; latestNotificationId: string | null};

/**
 * Shared by the sidebar and the notification bell (one request for both). Polled every 30 s while
 * the tab is visible (never in the background); any successful write refreshes it (app-shell).
 */
export const badgesQuery = {queryKey: keys.badges, queryFn: () => api.get<Badges>('/badges'), refetchInterval: 30_000} as const;

/** A badge's text: "99+" past 99. */
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * Who is here (GET /auth/state). Signing in is the site's (`/account/login/`); `user` is the team
 * member, null for a signed-in account that is not on the team yet (it needs an invite).
 */
export type AuthState = {needsSetup: boolean; signedIn: boolean; user: Me | null; brandName: string};

export const authQuery = {queryKey: keys.auth, queryFn: () => api.get<AuthState>('/auth/state'), staleTime: 60_000};

export function useAuth() {
  return useQuery(authQuery);
}

/** Signed-in user (the app layout guarantees one). */
export function useMe() {
  const {data} = useAuth();
  const me = data?.user;
  return {me: me!, isAdmin: me?.role === 'OWNER' || me?.role === 'ADMIN', canEdit: me?.role !== 'VIEWER'};
}

export function useTeam() {
  return useQuery({queryKey: keys.team, queryFn: () => api.get<{users: Me[]}>('/team'), select: (d) => d.users, staleTime: 5 * 60_000});
}

export function usePipelines() {
  return useQuery({queryKey: keys.pipelines, queryFn: () => api.get<{rows: Pipeline[]}>('/pipelines'), select: (d) => d.rows, staleTime: 5 * 60_000});
}

export function useSettings() {
  return useQuery({queryKey: keys.settings, queryFn: () => api.get<SettingsResponse>('/settings'), staleTime: 5 * 60_000});
}

export function useFields(entity: EntityType) {
  return useQuery({
    queryKey: keys.fields(entity),
    queryFn: () => api.get<{rows: CustomField[]}>('/fields', {entity}),
    select: (d) => d.rows,
    staleTime: 5 * 60_000,
  });
}

export function useEmailAccounts() {
  return useQuery({queryKey: [...keys.email, 'accounts'], queryFn: () => api.get<{rows: EmailAccount[]}>('/email/accounts'), select: (d) => d.rows});
}

export function useTemplates() {
  return useQuery({queryKey: [...keys.email, 'templates'], queryFn: () => api.get<{rows: EmailTemplate[]}>('/email/templates'), select: (d) => d.rows});
}

/** Branded layout settings + the brand as emails show it (header logo URL, colour). */
export function useEmailDesign() {
  return useQuery({queryKey: keys.emailDesign, queryFn: () => api.get<EmailDesignResponse>('/email/design'), staleTime: 5 * 60_000});
}

/**
 * Mutation that toasts errors (and optionally success) and refreshes the given
 * query families afterwards. Keeps every screen's write path consistent.
 */
export function useApiMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: {invalidate?: QueryKey[]; success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, vars: TVars) => void} = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({queryKey})));
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(result) : opts.success);
      opts.onSuccess?.(result, vars);
    },
    // Errors a form put under its fields (`f.fail`) toast only "Check the highlighted fields."; errors
    // already shown next to their control (an inline editor) toast nothing; every other error toasts
    // its own words (a 422 nobody placed included: nothing is highlighted then). The call's own
    // `onError` (and a `mutateAsync` catch) run after this hook's, in the same task, so the decision
    // waits one tick for them to mark the error (`shownInPlace`).
    onError: (e: Error) => {
      setTimeout(() => {
        const shown = shownInPlace.get(e);
        if (shown === 'shown') return;
        toast.error(shown === 'fields' ? 'Check the highlighted fields.' : e.message);
      }, 0);
    },
  });
}

/** Everything that hangs off a record changes together. */
export const recordKeys = [keys.timeline, keys.tasks, keys.notes, keys.contacts, keys.companies, keys.deals, keys.dashboard, keys.email, keys.tags, keys.settings, keys.recycleBin, keys.duplicates, keys.inbox];
