import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {Loader2} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';

import {TagInput} from '@/components/pickers';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Checkbox, Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import type {InboxSettings} from '@/lib/inbox';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/inbox/')({
  head: () => ({meta: [{title: pageTitle('Inbox settings')}]}),
  component: InboxSettingsPage,
});

type Response = {settings: InboxSettings; sharedAccounts: {id: string; label: string; fromEmail: string; provider: string}[]};

function Toggle({label, hint, checked, onChange}: {label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function Choice({checked, onChange, label, hint}: {checked: boolean; onChange: () => void; label: string; hint?: string}) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors', checked ? 'border-primary/40 bg-accent/50' : 'border-slate-200 hover:border-slate-300')}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-1 accent-[var(--primary)]" />
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function People({ids, onChange, disabled}: {ids: string[]; onChange: (ids: string[]) => void; disabled?: (id: string) => boolean}) {
  const team = useTeam();
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {team.data?.filter((u) => u.active && u.role !== 'VIEWER').map((u) => (
        <label key={u.id} className={cn('flex cursor-pointer items-center gap-2 text-sm text-slate-700', disabled?.(u.id) && 'opacity-50')}>
          <Checkbox
            disabled={disabled?.(u.id)}
            checked={ids.includes(u.id)}
            onCheckedChange={(v) => onChange(v === true ? [...new Set([...ids, u.id])] : ids.filter((x) => x !== u.id))}
          />
          {u.name} {(u.role === 'ADMIN' || u.role === 'OWNER') && <span className="text-xs text-muted-foreground">admin</span>}
        </label>
      ))}
    </div>
  );
}

function InboxSettingsPage() {
  const {isAdmin} = useMe();
  const team = useTeam();
  const q = useQuery({queryKey: [...keys.inbox, 'settings'], queryFn: () => api.get<Response>('/inbox/settings'), enabled: isAdmin});
  const [form, setForm] = useState<InboxSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);
  const save = useApiMutation(() => api.put<{settings: InboxSettings}>('/inbox/settings', form), {invalidate: [keys.inbox], success: 'Inbox settings saved', onSuccess: (r) => setForm(r.settings)});

  if (!isAdmin) return <AdminOnly />;
  if (!form || !q.data) return <Loader2 className="size-5 animate-spin text-primary" />;
  const set = (patch: Partial<InboxSettings>) => setForm({...form, ...patch});
  const shared = q.data.sharedAccounts;
  const picked = form.teamAccounts === 'all' ? shared.map((a) => a.id) : form.teamAccounts;
  const admins = new Set((team.data ?? []).filter((u) => u.role === 'ADMIN' || u.role === 'OWNER').map((u) => u.id));
  const canWork = (id: string) => admins.has(id) || form.access === 'everyone' || form.memberIds.includes(id);

  return (
    <form onSubmit={(e) => (e.preventDefault(), save.mutate(undefined))}>
      <SettingsSection title="Team inbox mailboxes" description="Mail to these shared mailboxes lands in the team inbox, from known contacts and new senders alike. Personal mailboxes always stay private to their owner.">
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared mailboxes yet. <Link to="/settings/email" className="font-semibold text-primary hover:underline">Connect one in Settings → Email</Link> (as a shared team account).</p>
        ) : (
          <div className="grid gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Choice checked={form.teamAccounts === 'all'} onChange={() => set({teamAccounts: 'all'})} label="Every shared mailbox" hint="New shared mailboxes join automatically." />
              <Choice checked={form.teamAccounts !== 'all'} onChange={() => set({teamAccounts: picked})} label="Only the ones I pick" />
            </div>
            {form.teamAccounts !== 'all' && (
              <div className="grid gap-1.5">
                {shared.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <Checkbox checked={picked.includes(a.id)} onCheckedChange={(v) => set({teamAccounts: v === true ? [...new Set([...picked, a.id])] : picked.filter((x) => x !== a.id)})} />
                    <span className="font-medium">{a.fromEmail}</span> <span className="truncate text-xs text-muted-foreground">{a.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Who works the team inbox" description="Admins always have access. Form and website chat conversations follow the same rule.">
        <div className="grid gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Choice checked={form.access === 'everyone'} onChange={() => set({access: 'everyone'})} label="Everyone on the team" />
            <Choice checked={form.access === 'members'} onChange={() => set({access: 'members'})} label="Only the people I pick" />
          </div>
          {form.access === 'members' && <People ids={form.memberIds} onChange={(memberIds) => set({memberIds})} disabled={(id) => admins.has(id)} />}
          <Field label="Members see" htmlFor="ib-vis" hint="Admins always see every team conversation.">
            <NativeSelect id="ib-vis" value={form.visibility} onChange={(e) => set({visibility: e.target.value as InboxSettings['visibility']})}>
              <option value="all">Every team conversation</option>
              <option value="mine_and_unassigned">Only theirs and unassigned ones</option>
            </NativeSelect>
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title="Assignment" description="What happens to new conversations in the team inbox.">
        <div className="grid gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Choice checked={form.assignment === 'manual'} onChange={() => set({assignment: 'manual'})} label="Manual" hint="New conversations wait under Unassigned." />
            <Choice checked={form.assignment === 'round_robin'} onChange={() => set({assignment: 'round_robin'})} label="Round robin" hint="Shared in turn: whoever was assigned least recently goes next." />
          </div>
          {form.assignment === 'round_robin' && (
            <div className="grid gap-1.5">
              <p className="text-sm font-semibold text-slate-800">Share among</p>
              <People ids={form.roundRobinIds} onChange={(roundRobinIds) => set({roundRobinIds})} disabled={(id) => !canWork(id)} />
            </div>
          )}
          <Toggle
            label="Keep replies with the current assignee"
            hint="When a contact answers a closed conversation it reopens with the same person. Off: it goes back to Unassigned (and through round robin)."
            checked={form.autoAssignReplies}
            onChange={(autoAssignReplies) => set({autoAssignReplies})}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Auto-close" description="Tidy up conversations that went quiet after your reply.">
        <div className="grid gap-3">
          <Toggle label="Close conversations without a reply" checked={form.autoCloseDays !== null} onChange={(on) => set({autoCloseDays: on ? 7 : null})} />
          {form.autoCloseDays !== null && (
            <Field label="Days without a reply" htmlFor="ib-days" className="max-w-48">
              <Input id="ib-days" type="number" min={1} max={365} value={form.autoCloseDays} onChange={(e) => set({autoCloseDays: Math.max(1, Math.min(365, Number(e.target.value) || 1))})} />
            </Field>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Blocked senders" description="Mail from these addresses or domains skips the inbox and lands in Spam. “Spam & block” on a conversation adds them here.">
        <div className="grid gap-4">
          <Field label="Addresses" htmlFor="ib-addr"><TagInput id="ib-addr" noun="address" value={form.blockedAddresses} onChange={(blockedAddresses) => set({blockedAddresses})} /></Field>
          <Field label="Domains" htmlFor="ib-dom" hint="e.g. spammy.example"><TagInput id="ib-dom" noun="domain" value={form.blockedDomains} onChange={(blockedDomains) => set({blockedDomains})} /></Field>
        </div>
      </SettingsSection>

      <div className="mb-6 flex justify-end">
        <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save changes</Button>
      </div>
    </form>
  );
}
