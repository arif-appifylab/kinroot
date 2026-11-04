import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {Loader2} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';

import {TagInput} from '@/components/pickers';
import {LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Checkbox, Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {DEFAULT_INBOX_SETTINGS, type InboxSettings} from '@/lib/inbox';
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

/** Same rule as the server (Settings → Inbox): domains like example.com. */
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function People({ids, onChange, disabled, invalid}: {ids: string[]; onChange: (ids: string[]) => void; disabled?: (id: string) => boolean; invalid?: boolean}) {
  const team = useTeam();
  const people = team.data?.filter((u) => u.active && u.role !== 'VIEWER') ?? [];
  // The first person who can be picked carries the error, so a failed save focuses the list.
  const first = people.find((u) => !disabled?.(u.id))?.id;
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {people.map((u) => (
        <label key={u.id} className={cn('flex cursor-pointer items-center gap-2 text-sm text-slate-700', disabled?.(u.id) && 'opacity-50')}>
          <Checkbox
            disabled={disabled?.(u.id)}
            aria-invalid={invalid && u.id === first ? true : undefined}
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
  const adminIds = new Set((team.data ?? []).filter((u) => u.role === 'ADMIN' || u.role === 'OWNER').map((u) => u.id));
  const activeIds = new Set((team.data ?? []).filter((u) => u.active).map((u) => u.id));
  // The server's rules (PUT /inbox/settings), so nothing is sent until they hold.
  const f = useFormState(form ?? DEFAULT_INBOX_SETTINGS, {
    roundRobinIds: [
      (ids, v) => (v.assignment === 'round_robin' && !ids.length ? 'Pick at least one person for the round robin.' : null),
      (ids, v) => (v.assignment === 'round_robin' && ids.some((id) => activeIds.has(id) && !adminIds.has(id) && v.access !== 'everyone' && !v.memberIds.includes(id)) ? 'Everyone in the round robin needs access to the team inbox: pick them under Who works the team inbox, or untick them here.' : null),
    ],
    blockedAddresses: [
      (list) => {
        const wrong = list.find((a) => is.email()(a));
        return wrong ? `Remove or fix ${wrong}: enter addresses like name@example.com.` : null;
      },
    ],
    blockedDomains: [
      (list) => {
        const wrong = list.find((d) => !DOMAIN.test(d));
        return wrong ? `Remove or fix ${wrong}: enter domains like example.com.` : null;
      },
    ],
  });

  if (!isAdmin) return <AdminOnly />;
  if (q.isError && !q.data) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!form || !q.data) return <Loader2 className="size-5 animate-spin text-primary" />;
  const set = (patch: Partial<InboxSettings>) => setForm({...form, ...patch});
  const shared = q.data.sharedAccounts;
  const picked = form.teamAccounts === 'all' ? shared.map((a) => a.id) : form.teamAccounts;
  const admins = new Set((team.data ?? []).filter((u) => u.role === 'ADMIN' || u.role === 'OWNER').map((u) => u.id));
  const canWork = (id: string) => admins.has(id) || form.access === 'everyone' || form.memberIds.includes(id);

  return (
    <form {...f.form(() => !save.isPending && save.mutate(undefined, {onError: f.fail}))}>
      <SettingsSection title="Team inbox mailboxes" description="Mail to these shared mailboxes lands in the team inbox, from known contacts and new senders alike. Personal mailboxes always stay private to their owner.">
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared mailboxes yet. <Link to="/settings/email" className="font-semibold text-primary hover:underline">Connect one in Settings → Email</Link> (as a shared team account).</p>
        ) : (
          <div className="grid gap-3">
            <div role="radiogroup" aria-label="Team inbox mailboxes" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          <div role="radiogroup" aria-label="Who works the team inbox" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Choice checked={form.access === 'everyone'} onChange={() => set({access: 'everyone'})} label="Everyone on the team" />
            <Choice checked={form.access === 'members'} onChange={() => set({access: 'members'})} label="Only the people I pick" />
          </div>
          {form.access === 'members' && (
            <div role="group" aria-label="People who work the team inbox">
              <People ids={form.memberIds} onChange={(memberIds) => set({memberIds})} disabled={(id) => admins.has(id)} />
            </div>
          )}
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
          <div role="radiogroup" aria-label="Assignment" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Choice checked={form.assignment === 'manual'} onChange={() => set({assignment: 'manual'})} label="Manual" hint="New conversations wait under Unassigned." />
            <Choice checked={form.assignment === 'round_robin'} onChange={() => set({assignment: 'round_robin'})} label="Round robin" hint="Shared in turn: whoever was assigned least recently goes next." />
          </div>
          {form.assignment === 'round_robin' && (
            <Field label="Share among" group error={f.error('roundRobinIds')}>
              <People ids={form.roundRobinIds} onChange={(roundRobinIds) => set({roundRobinIds})} disabled={(id) => !canWork(id) && !form.roundRobinIds.includes(id)} invalid={f.invalid('roundRobinIds')} />
            </Field>
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
              <Input id="ib-days" type="number" inputMode="numeric" value={form.autoCloseDays} onChange={(e) => set({autoCloseDays: Math.max(1, Math.min(365, Number(e.target.value) || 1))})} />
            </Field>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Blocked senders" description="Mail from these addresses or domains skips the inbox and lands in Spam. “Spam & block” on a conversation adds them here.">
        <div className="grid gap-4">
          <Field label="Addresses" htmlFor="ib-addr" error={f.error('blockedAddresses')}><TagInput id="ib-addr" noun="address" value={form.blockedAddresses} onChange={(blockedAddresses) => set({blockedAddresses})} /></Field>
          <Field label="Domains" htmlFor="ib-dom" hint="e.g. spammy.example" error={f.error('blockedDomains')}><TagInput id="ib-dom" noun="domain" value={form.blockedDomains} onChange={(blockedDomains) => set({blockedDomains})} /></Field>
        </div>
      </SettingsSection>

      <div className="mb-6 flex justify-end">
        <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save changes</Button>
      </div>
    </form>
  );
}
