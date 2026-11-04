import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Ban, KeyRound, LogOut, RotateCcw, ShieldCheck} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {confirm} from '@/components/ui/confirm';
import {DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator} from '@/components/ui/menu';
import {type AdminUser, siteApi, siteKeys} from '@/lib/site-admin';

import {UserRolesDialog} from './user-roles-dialog';

/**
 * A site account's sign-in actions (the site's own admin API, `/site-api/admin/users/:id/*`): block or
 * unblock, sign out everywhere, turn off two-step sign-in, site roles. Shared by Settings → Team's two
 * tabs (a team member's account, a customer's account). Every call is checked again on the server
 * (site:user:update, roles also site:role:read; never someone with more access than you, never the
 * site owner); these only decide what the menu shows.
 */
export function useAccountActions(viewerId: number | null) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const refresh = () => qc.invalidateQueries({queryKey: siteKeys.users});

  const setStatus = useMutation({
    mutationFn: ({user, status}: {user: AdminUser; status: 'active' | 'suspended'}) => siteApi.patch(`/admin/users/${user.id}`, {status}),
    onSuccess: (_r, {user, status}) => (void refresh(), toast.success(status === 'suspended' ? `${user.name} is blocked and signed out.` : `${user.name} can sign in again.`)),
    onError: (e) => toast.error(e.message),
  });
  const endSessions = useMutation({
    mutationFn: (user: AdminUser) => siteApi.post(`/admin/users/${user.id}/sessions/revoke`),
    onSuccess: (_r, user) => toast.success(`${user.name} is signed out everywhere.`),
    onError: (e) => toast.error(e.message),
  });
  // Lost phone and recovery codes: they set two-step sign-in up again after their next sign-in.
  const disableTwoFactor = useMutation({
    mutationFn: (user: AdminUser) => siteApi.post(`/admin/users/${user.id}/two-factor/disable`),
    onSuccess: (_r, user) => (void refresh(), toast.success(`Two-step sign-in is off for ${user.name}.`)),
    onError: (e) => toast.error(e.message),
  });
  /** The account an action is running for (its row shows pending; every row's menu waits). */
  const busyId: number | null = (setStatus.isPending && setStatus.variables?.user.id) || (endSessions.isPending && endSessions.variables?.id) || (disableTwoFactor.isPending && disableTwoFactor.variables?.id) || null;

  const askStatus = async (user: AdminUser) => {
    const block = user.status === 'active';
    const ok = await confirm(
      block
        ? {title: `Block ${user.name}?`, description: 'They are signed out at once and cannot sign in, to the CRM or the support portal, until you unblock them.', confirmLabel: 'Block', destructive: true}
        : {title: `Unblock ${user.name}?`, description: 'They can sign in again with their usual details.', confirmLabel: 'Unblock'},
    );
    if (ok) setStatus.mutate({user, status: block ? 'suspended' : 'active'});
  };
  const askEndSessions = async (user: AdminUser) => {
    const ok = await confirm({title: `Sign ${user.name} out everywhere?`, description: 'Every device they are signed in on is signed out. They can sign in again.', confirmLabel: 'Sign out everywhere'});
    if (ok) endSessions.mutate(user);
  };
  const askDisableTwoFactor = async (user: AdminUser) => {
    const ok = await confirm({
      title: `Turn off two-step sign-in for ${user.name}?`,
      description: 'For someone who lost their phone and their recovery codes. They sign in with their password or an emailed code, then can set it up again.',
      confirmLabel: 'Turn it off',
      destructive: true,
    });
    if (ok) disableTwoFactor.mutate(user);
  };

  const rolesDialog = editing && (
    <UserRolesDialog
      key={editing.id}
      user={editing}
      self={editing.id === viewerId}
      onClose={() => setEditing(null)}
      onSaved={() => {
        toast.success(`Roles saved for ${editing.name}.`);
        const self = editing.id === viewerId;
        setEditing(null);
        void refresh();
        void qc.invalidateQueries({queryKey: siteKeys.roles});
        // Your own roles changed: what these screens may show you changed too.
        if (self) void qc.invalidateQueries({queryKey: siteKeys.me});
      }}
    />
  );

  return {busyId, askStatus, askEndSessions, askDisableTwoFactor, editRoles: setEditing, rolesDialog, viewerId};
}

export type AccountActions = ReturnType<typeof useAccountActions>;

/**
 * The account's items in a row's ⋯ menu. The site owner's account (it comes from the dashboard) has
 * none; your own account has no block or two-step reset (the server refuses both too).
 */
export function AccountMenuItems({user, actions, canRoles, heading}: {user: AdminUser; actions: AccountActions; canRoles: boolean; heading?: boolean}) {
  if (user.platformOwner) return null;
  const self = user.id === actions.viewerId;
  return (
    <>
      {heading && <DropdownMenuLabel>Sign-in account</DropdownMenuLabel>}
      {canRoles && (
        <DropdownMenuItem onSelect={() => actions.editRoles(user)}>
          <ShieldCheck /> Site roles…
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => void actions.askEndSessions(user)}>
        <LogOut /> Sign out everywhere…
      </DropdownMenuItem>
      {user.twoFactor && !self && (
        <DropdownMenuItem onSelect={() => void actions.askDisableTwoFactor(user)}>
          <KeyRound /> Turn off two-step sign-in…
        </DropdownMenuItem>
      )}
      {!self &&
        (user.status === 'active' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => void actions.askStatus(user)}>
              <Ban /> Block…
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => void actions.askStatus(user)}>
            <RotateCcw /> Unblock…
          </DropdownMenuItem>
        ))}
    </>
  );
}

/** `GET /site-api/admin/users/:id` (site:user:read): one account, read when its menu opens. */
export function useSiteAccount(accountId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: [...siteKeys.users, 'one', accountId],
    queryFn: () => siteApi.get<{user: AdminUser}>(`/admin/users/${accountId}`).then((r) => r.user),
    enabled: enabled && accountId !== null,
    staleTime: 30_000,
  });
}
