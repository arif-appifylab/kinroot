import {createFileRoute} from '@tanstack/react-router';
import {Copy, Link2, UserPlus} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {Avatar} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import type {Role} from '@/lib/types';

export const Route = createFileRoute('/_app/settings/team')({
  component: TeamSettings,
});

const ROLES: Record<Role, {label: string; desc: string}> = {
  OWNER: {label: 'Owner', desc: 'Full access, cannot be removed'},
  ADMIN: {label: 'Admin', desc: 'Manage settings, team and all records'},
  MEMBER: {label: 'Member', desc: 'Create and edit records'},
  VIEWER: {label: 'Viewer', desc: 'Read-only'},
};

function InviteLink({url, onClose}: {url: string; onClose: () => void}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Share this invite link</DialogTitle>
          <DialogDescription>Send it to your teammate over chat or email. They sign in (or create their account) with the invited address, then join. It works once, for 14 days.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" size="icon" aria-label="Copy link" onClick={() => (navigator.clipboard.writeText(url), toast.success('Link copied'))}><Copy /></Button>
          </div>
        </DialogBody>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamSettings() {
  const {me, isAdmin} = useMe();
  const team = useTeam();
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({name: '', email: '', role: 'MEMBER'});
  const [link, setLink] = useState<string | null>(null);

  const invite = useApiMutation(() => api.post<{inviteUrl: string}>('/team/invite', form), {
    invalidate: [keys.team],
    onSuccess: (r) => (setInviting(false), setForm({name: '', email: '', role: 'MEMBER'}), f.reset(), setLink(r.inviteUrl)),
  });
  const update = useApiMutation(({id, ...patch}: {id: string; role?: string; active?: boolean}) => api.patch(`/team/${id}`, patch), {invalidate: [keys.team], success: 'Updated'});
  const relink = useApiMutation((id: string) => api.post<{inviteUrl: string}>(`/team/${id}/invite-link`), {onSuccess: (r) => setLink(r.inviteUrl)});
  const f = useFormState(form, {
    name: [is.required('Enter their name.'), is.maxLength(80)],
    email: [is.required('Enter the email address they sign in with.'), is.email(), is.maxLength(254)],
  });
  const closeInvite = () => (setInviting(false), f.reset());

  return (
    <div>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <SettingsSection
        title="Team"
        description={`${team.data?.filter((u) => u.active).length ?? 0} active members`}
        actions={isAdmin && <Button size="sm" onClick={() => setInviting(true)}><UserPlus /> Invite</Button>}
      >
        {team.isError && <LoadError error={team.error} onRetry={() => team.refetch()} />}
        <div className="divide-y divide-slate-100">
          {team.data?.map((u) => {
            const busy = (update.isPending && update.variables?.id === u.id) || (relink.isPending && relink.variables === u.id);
            return (
            <div key={u.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
              <Avatar name={u.name} color={u.color} src={u.avatarUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">{u.name}{u.id === me.id && ' (you)'}</p>
                  {u.invited && <Badge tone="amber">Invite pending</Badge>}
                  {!u.active && <Badge tone="neutral">Deactivated</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{u.email} · {u.lastSeenAt ? `last seen ${ago(u.lastSeenAt)}` : 'never signed in'}</p>
              </div>
              {isAdmin && u.role !== 'OWNER' && u.id !== me.id ? (
                <div className="flex items-center gap-2">
                  {u.invited && <Button variant="ghost" size="sm" pending={relink.isPending && relink.variables === u.id} pendingLabel="Making link…" disabled={busy} onClick={() => relink.mutate(u.id)}><Link2 /> Link</Button>}
                  <NativeSelect aria-label={`Role for ${u.name}`} className="h-9 w-32" disabled={busy} value={u.role} onChange={(e) => update.mutate({id: u.id, role: e.target.value})}>
                    {(['ADMIN', 'MEMBER', 'VIEWER'] as const).map((r) => <option key={r} value={r}>{ROLES[r].label}</option>)}
                  </NativeSelect>
                  <Button variant="secondary" size="sm" disabled={busy} pending={update.isPending && update.variables?.id === u.id && update.variables.active !== undefined} pendingLabel={u.active ? 'Deactivating…' : 'Reactivating…'} onClick={() => update.mutate({id: u.id, active: !u.active})}>{u.active ? 'Deactivate' : 'Reactivate'}</Button>
                </div>
              ) : (
                <Badge tone={u.role === 'OWNER' ? 'violet' : 'blue'}>{ROLES[u.role].label}</Badge>
              )}
            </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Roles">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Object.entries(ROLES).map(([k, r]) => (
            <div key={k} className="rounded-xl bg-slate-50 p-3">
              <p className="text-sm font-semibold text-slate-900">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
            </div>
          ))}
        </div>
      </SettingsSection>

      {inviting && (
        <Dialog open onOpenChange={(o) => !o && !invite.isPending && closeInvite()}>
          <DialogContent size="sm">
            <form {...f.form(() => invite.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
              <DialogHeader><DialogTitle>Invite a teammate</DialogTitle></DialogHeader>
              <DialogBody>
                <Field label="Name" htmlFor="i-name" error={f.error('name')}><Input id="i-name" autoFocus value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} onBlur={f.blur('name')} /></Field>
                <Field label="Email" htmlFor="i-email" error={f.error('email')}><Input id="i-email" type="email" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} onBlur={f.blur('email')} /></Field>
                <Field label="Role" htmlFor="i-role" hint={ROLES[form.role as Role].desc}>
                  <NativeSelect id="i-role" value={form.role} onChange={(e) => setForm({...form, role: e.target.value})}>
                    {(['ADMIN', 'MEMBER', 'VIEWER'] as const).map((r) => <option key={r} value={r}>{ROLES[r].label}</option>)}
                  </NativeSelect>
                </Field>
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" disabled={invite.isPending} onClick={closeInvite}>Cancel</Button>
                <Button type="submit" pending={invite.isPending} pendingLabel="Creating invite…">Create invite</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {link && <InviteLink url={link} onClose={() => setLink(null)} />}
    </div>
  );
}
