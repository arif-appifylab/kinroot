import {useMutation, useQuery} from '@tanstack/react-query';
import {useId, useState} from 'react';

import {Button} from '@/components/ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/form';
import {Skeleton} from '@/components/ui/misc';
import {type AdminUser, siteApi, siteRolesQuery} from '@/lib/site-admin';

import {ErrorNote, PendingButton} from './common';

/**
 * Pick an account's site roles (`PUT /site-api/admin/users/:id/roles`, site:user:update; the list
 * needs site:role:read). The server refuses roles you could not grant yourself, touching someone
 * with more access than you, and taking owner from the last owner; its words show here.
 */
export function UserRolesDialog({user, self, onClose, onSaved}: {user: AdminUser; self: boolean; onClose: () => void; onSaved: (user: AdminUser) => void}) {
  const ids = useId();
  const roles = useQuery(siteRolesQuery);
  const [picked, setPicked] = useState<string[]>(user.roles);
  const save = useMutation({
    mutationFn: () => siteApi.put<{user: AdminUser}>(`/admin/users/${user.id}/roles`, {roles: picked}),
    onSuccess: (r) => onSaved(r.user),
  });
  const changed = [...picked].sort().join() !== [...user.roles].sort().join();

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="sm">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && !save.isPending) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Roles for {user.name}</DialogTitle>
            <DialogDescription>{self ? 'These are your own roles. Removing one takes its access away from you.' : user.email}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ErrorNote error={roles.error} onRetry={() => void roles.refetch()} />
            {roles.isPending ? (
              <div className="grid gap-2">{Array.from({length: 3}, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              <fieldset className="grid gap-2" disabled={save.isPending}>
                <legend className="mb-2 text-sm font-semibold text-slate-700">Site roles</legend>
                {roles.data?.roles.map((role) => {
                  const id = `${ids}-${role.slug}`;
                  return (
                    <label key={role.slug} htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-100 p-3 hover:bg-slate-50 has-[button:disabled]:cursor-not-allowed">
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        checked={picked.includes(role.slug)}
                        onCheckedChange={(v) => setPicked((cur) => (v ? [...cur, role.slug] : cur.filter((s) => s !== role.slug)))}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900">{role.name}</span>
                        {role.description && <span className="block text-xs text-muted-foreground">{role.description}</span>}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            <ErrorNote error={save.error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <PendingButton type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={!changed || roles.isPending}>
              Save roles
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
