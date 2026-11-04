import {createFileRoute} from '@tanstack/react-router';
import {Copy, ExternalLink, Loader2, MessageSquareReply, Pencil, Plus, Trash2} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {RichEditor} from '@/components/email-editor';
import {TagInput} from '@/components/pickers';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {useCannedReplies, useTicketSettings} from '@/components/tickets/ticket-badges';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, NativeSelect, Switch, Textarea} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {LoadError} from '@/components/data-table';
import {EmptyState} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import {timeZones} from '@/lib/format';
import {keys, useApiMutation, useMe, useSettings, useTeam} from '@/lib/queries';
import {TICKET_PRIORITIES, type TicketSettings} from '@/lib/tickets';
import type {CannedReply} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/tickets')({
  component: TicketSettingsPage,
});

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Toggle({label, hint, checked, onChange, disabled}: {label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/** Hours input backed by minutes (blank = no target). */
function HoursInput({value, onChange, disabled, label}: {value: number | null; onChange: (mins: number | null) => void; disabled?: boolean; label: string}) {
  const [draft, setDraft] = useState(value ? String(+(value / 60).toFixed(2)) : '');
  useEffect(() => setDraft(value ? String(+(value / 60).toFixed(2)) : ''), [value]);
  return (
    <div className="relative">
      <Input
        aria-label={label}
        type="number"
        inputMode="decimal"
        step="0.25"
        disabled={disabled}
        className="h-9 pr-10"
        value={draft}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft && Number(draft) > 0 ? Math.max(1, Math.round(Number(draft) * 60)) : null)}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">h</span>
    </div>
  );
}

function CannedDialog({reply, onClose}: {reply: CannedReply | null; onClose: () => void}) {
  // Older replies were plain text: they open as paragraphs and are saved back as rich text.
  const [form, setForm] = useState({name: reply?.name ?? '', html: reply ? (reply.html ?? textToEditorHtml(reply.body)) : ''});
  const save = useApiMutation(() => (reply ? api.patch(`/tickets/canned/${reply.id}`, form) : api.post('/tickets/canned', form)), {invalidate: [keys.tickets], success: 'Canned reply saved', onSuccess: onClose});
  const f = useFormState(form, {name: [is.required('Name the reply, like "Password reset steps".'), is.maxLength(100)], html: [(v) => (isEmptyHtml(v) ? 'Write the reply.' : null)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md">
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{reply ? 'Edit canned reply' : 'New canned reply'}</DialogTitle>
            <DialogDescription>Use Merge field for the contact’s name, the company and your own name; they are filled in when the reply is sent.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Name" htmlFor="cr-name" error={f.error('name')}><Input id="cr-name" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} onBlur={f.blur('name')} placeholder="e.g. Password reset steps" /></Field>
            <Field label="Reply" error={f.error('html')}>
              <RichEditor variant="text" mergeFields minHeight={220} value={form.html} onChange={(html) => setForm({...form, html})} ariaLabel="Reply" placeholder="The answer you type most often…" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TicketSettingsPage() {
  const {isAdmin} = useMe();
  const team = useTeam();
  const app = useSettings();
  const q = useTicketSettings();
  const canned = useCannedReplies();
  const [form, setForm] = useState<TicketSettings | null>(null);
  const [editing, setEditing] = useState<CannedReply | null | 'new'>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);

  const save = useApiMutation(() => api.patch('/tickets/settings', form), {invalidate: [keys.tickets], success: 'Ticket settings saved'});
  const remove = useApiMutation((id: string) => api.del(`/tickets/canned/${id}`), {invalidate: [keys.tickets], success: 'Canned reply deleted'});
  const f = useFormState(
    {supportEmail: form?.supportEmail ?? '', portalIntro: form?.portalIntro ?? ''},
    {supportEmail: [is.email('Enter a valid address, like support@yourcompany.com.')], portalIntro: [is.maxLength(1000)]},
  );

  if (q.isError && !form) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!form) return <Loader2 className="size-5 animate-spin text-primary" />;
  const disabled = !isAdmin;
  const sla = form.sla;
  const bh = sla.businessHours;
  const setSla = (patch: Partial<TicketSettings['sla']>) => setForm({...form, sla: {...sla, ...patch}});
  const setBh = (patch: Partial<TicketSettings['sla']['businessHours']>) => setSla({businessHours: {...bh, ...patch}});
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const webhook = app.data?.inboundWebhookUrl;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Copied'));

  return (
    <div>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))}>
        <SettingsSection
          title="Support email (optional)"
          description="Only needed if customers should be able to email you for help. Mail sent to this address becomes a ticket, and their replies thread into the same ticket. Without it, tickets still come from the support portal, forms, the inbox and your team."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Support email address" htmlFor="tk-email" hint="Leave empty if you don't take support requests by email." error={f.error('supportEmail')}>
              <Input id="tk-email" type="email" disabled={disabled} value={form.supportEmail} onChange={(e) => setForm({...form, supportEmail: e.target.value.trim()})} onBlur={f.blur('supportEmail')} placeholder="support@yourcompany.com" />
            </Field>
            <Field label="Send replies from" htmlFor="tk-account" hint="Customers' replies come back to the support address either way (Reply-To).">
              <NativeSelect id="tk-account" disabled={disabled} value={form.replyAccountId} onChange={(e) => setForm({...form, replyAccountId: e.target.value})}>
                <option value="">Automatic: the support address's mailbox, else the default shared one</option>
                {q.data?.sharedAccounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.fromEmail})</option>)}
              </NativeSelect>
            </Field>
          </div>
          <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-800">Getting the mail in (pick one)</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px]">
              <li><b>Gmail / Outlook:</b> connect the support mailbox as a shared account in Settings → Email; new mail is picked up on every sync. Nothing else to set up.</li>
              <li><b>Any other address:</b> have your email provider (Resend, Postmark, Mailgun, SendGrid) forward incoming mail for it to this webhook:</li>
            </ul>
            {webhook && (
              <div className="mt-2 flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-card px-3 py-2 text-xs">{webhook}</code>
                <Button type="button" variant="secondary" size="sm" className="h-9" onClick={() => copy(webhook)}><Copy /> Copy</Button>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">Outgoing replies carry the ticket number in the subject, like “[#1042]”, so threads stay together even when reply headers are lost.</p>
          </div>
        </SettingsSection>

        <SettingsSection title="Categories & queues" description="Categories describe what a ticket is about; queues are the team that works it.">
          <div className="grid gap-4">
            <Field label="Categories" htmlFor="tk-cats"><TagInput id="tk-cats" noun="category" lowercase={false} value={form.categories} onChange={(categories) => setForm({...form, categories})} /></Field>
            <Field label="Team queues" htmlFor="tk-queues"><TagInput id="tk-queues" noun="queue" lowercase={false} value={form.queues} onChange={(queues) => setForm({...form, queues})} /></Field>
          </div>
        </SettingsSection>

        <SettingsSection title="New ticket alerts" description="Who hears about new unassigned tickets and their SLA breaches. Assigned tickets notify the assignee.">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {team.data?.filter((u) => u.active).map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <Checkbox
                  disabled={disabled}
                  checked={form.notifyUserIds.includes(u.id)}
                  onCheckedChange={(v) => setForm({...form, notifyUserIds: v === true ? [...new Set([...form.notifyUserIds, u.id])] : form.notifyUserIds.filter((x) => x !== u.id)})}
                />
                {u.name}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Nobody picked: owners and admins are notified.</p>
        </SettingsSection>

        <SettingsSection title="SLA policies" description="Targets per priority. Breaches are flagged on the ticket and notify the assignee.">
          <div className="grid gap-5">
            <Toggle label="Track SLA targets" checked={sla.enabled} disabled={disabled} onChange={(enabled) => setSla({enabled})} />
            <div className={cn('overflow-x-auto', !sla.enabled && 'opacity-60')}>
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-left text-xs font-bold tracking-wide text-slate-500 uppercase">
                    <th className="py-2 pr-4">Priority</th>
                    <th className="py-2 pr-4">First response within</th>
                    <th className="py-2">Resolve within</th>
                  </tr>
                </thead>
                <tbody>
                  {TICKET_PRIORITIES.map((p) => {
                    const target = sla.targets[p.value];
                    const setTarget = (patch: Partial<typeof target>) => setSla({targets: {...sla.targets, [p.value]: {...target, ...patch}}});
                    return (
                      <tr key={p.value} className="border-t border-slate-100">
                        <td className="py-2 pr-4 font-semibold text-slate-800"><span className="inline-flex items-center gap-2"><span className={cn('size-2 rounded-full', p.dot)} />{p.label}</span></td>
                        <td className="py-2 pr-4"><HoursInput label={`${p.label} first response hours`} disabled={disabled || !sla.enabled} value={target.firstResponseMins} onChange={(firstResponseMins) => setTarget({firstResponseMins})} /></td>
                        <td className="py-2"><HoursInput label={`${p.label} resolution hours`} disabled={disabled || !sla.enabled} value={target.resolutionMins} onChange={(resolutionMins) => setTarget({resolutionMins})} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 border-t border-slate-100 pt-5">
              <Toggle label="Count business hours only" hint="Deadlines skip nights and days off, e.g. 8 h opened Friday 4 pm is due Monday 3 pm." checked={bh.enabled} disabled={disabled || !sla.enabled} onChange={(enabled) => setBh({enabled})} />
              {bh.enabled && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Time zone" htmlFor="tk-tz" className="sm:col-span-3">
                    <NativeSelect id="tk-tz" disabled={disabled} value={bh.timezone} onChange={(e) => setBh({timezone: e.target.value})}>
                      {[...new Set(['UTC', ...timeZones()])].map((z) => <option key={z}>{z}</option>)}
                    </NativeSelect>
                  </Field>
                  <Field label="Opens" htmlFor="tk-start"><Input id="tk-start" type="time" disabled={disabled} value={bh.start} onChange={(e) => setBh({start: e.target.value})} /></Field>
                  <Field label="Closes" htmlFor="tk-end"><Input id="tk-end" type="time" disabled={disabled} value={bh.end} onChange={(e) => setBh({end: e.target.value})} /></Field>
                  <div className="grid content-start gap-1.5 sm:col-span-3">
                    <span className="text-sm font-semibold text-slate-700">Working days</span>
                    <div className="flex flex-wrap gap-1.5">
                      {DAYS.map((d, i) => {
                        const on = bh.days.includes(i);
                        return (
                          <button
                            key={d}
                            type="button"
                            disabled={disabled}
                            aria-pressed={on}
                            onClick={() => setBh({days: on ? bh.days.filter((x) => x !== i) : [...bh.days, i].sort()})}
                            className={cn('cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium transition-colors', on ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600 hover:border-primary/50')}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Customer portal"
          description="A branded page where customers open requests and follow them with a link sent to their email. No passwords."
          actions={<Button type="button" variant="secondary" size="sm" asChild><a href="/support" target="_blank" rel="noopener noreferrer"><ExternalLink /> Open portal</a></Button>}
        >
          <div className="grid gap-4">
            <Toggle label="Portal on" hint={`${origin}/support`} checked={form.portalEnabled} disabled={disabled} onChange={(portalEnabled) => setForm({...form, portalEnabled})} />
            <Field label="Welcome text" htmlFor="tk-intro" error={f.error('portalIntro')}>
              <Textarea id="tk-intro" rows={2} disabled={disabled || !form.portalEnabled} value={form.portalIntro} onChange={(e) => setForm({...form, portalIntro: e.target.value})} onBlur={f.blur('portalIntro')} />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Customer satisfaction" description="Ask for a 1–5 rating when a ticket is resolved. Ratings show on the ticket and as an average on the tickets page.">
          <Toggle label="Email a satisfaction survey on resolve" hint="Sent from a shared team mailbox (Settings → Email)." checked={form.csatEnabled} disabled={disabled} onChange={(csatEnabled) => setForm({...form, csatEnabled})} />
        </SettingsSection>

        {isAdmin && (
          <div className="mb-6 flex justify-end">
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save changes</Button>
          </div>
        )}
      </form>

      <SettingsSection title="Canned replies" description="Saved answers agents insert from the reply box." actions={isAdmin && <Button size="sm" onClick={() => setEditing('new')}><Plus /> New reply</Button>}>
        {canned.isError && !canned.data && <LoadError error={canned.error} onRetry={() => canned.refetch()} />}
        {canned.data?.length === 0 && <EmptyState icon={<MessageSquareReply />} title="No canned replies yet" description="Save the answers you type most often." />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {canned.data?.map((r) => (
            <div key={r.id} className="rounded-xl border border-slate-100 bg-card p-4 shadow-soft">
              <p className="text-sm font-bold text-slate-900">{r.name}</p>
              <p className="mt-2 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{r.body}</p>
              {isAdmin && (
                <div className="mt-3 flex gap-1">
                  <Button variant="ghost" size="sm" disabled={remove.isPending && remove.variables === r.id} onClick={() => setEditing(r)}><Pencil /> Edit</Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-rose-50 hover:text-destructive" pending={remove.isPending && remove.variables === r.id} pendingLabel="Deleting…" disabled={remove.isPending} onClick={async () => (await confirm({title: `Delete "${r.name}"?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(r.id)}><Trash2 /> Delete</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
      {editing && <CannedDialog reply={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
