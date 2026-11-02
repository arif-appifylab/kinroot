import {useQuery} from '@tanstack/react-query';
import {GitBranch, Plus, ShieldCheck, Trash2} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {api} from '@/lib/api';
import {LIFECYCLE} from '@/lib/format';
import {newId, type Ending, type FormField, type FormSettings} from '@/lib/forms';
import {TICKET_PRIORITIES, type TicketPriority} from '@/lib/tickets';
import {keys, useApiMutation, useEmailAccounts, useMe, usePipelines, useTeam} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {ListMultiSelect} from '../lists/list-picker';
import {TagInput} from '../pickers';
import {SettingsSection} from '../settings-section';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Checkbox, Field, Input, NativeSelect, Switch, Textarea} from '../ui/form';
import {useTicketSettings} from '../tickets/ticket-badges';
import {RuleGroupEditor} from './logic-editor';

type Props = {fields: FormField[]; settings: FormSettings; onChange: (s: FormSettings) => void; slug: string; onSlug: (slug: string) => void};

function Toggle({label, hint, checked, onChange}: {label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

const toLocal = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export function FormSettingsPanel({fields, settings: s, onChange, slug, onSlug}: Props) {
  const set = (p: Partial<FormSettings>) => onChange({...s, ...p});
  const team = useTeam();
  const pipelines = usePipelines();
  const [slugDraft, setSlugDraft] = useState(slug);
  const owner = s.owner ?? {mode: 'none'};
  const deal = s.createDeal ?? {enabled: false};
  const ticket = s.createTicket ?? {enabled: false};
  const ticketSettings = useTicketSettings();
  const inbox = s.inbox ?? {enabled: false, accountId: null};
  const sharedAccounts = useEmailAccounts().data?.filter((a) => a.userId === null) ?? [];
  const pipeline = pipelines.data?.find((p) => p.id === deal.pipelineId) ?? pipelines.data?.[0];
  const auto = s.autoresponder ?? {enabled: false, subject: '', body: ''};
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const users = team.data?.filter((u) => u.active) ?? [];

  const toggleUser = (list: string[] | undefined, id: string, on: boolean) => (on ? [...new Set([...(list ?? []), id])] : (list ?? []).filter((x) => x !== id));

  return (
    <div className="max-w-3xl">
      <SettingsSection title="Link" description="Where the hosted form lives.">
        <Field label="Form address" hint="Changing it breaks links you already shared.">
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-card pl-3 text-sm focus-within:ring-2 focus-within:ring-ring/30">
              <span className="shrink-0 text-muted-foreground">{origin}/f/</span>
              <input className="h-10 min-w-0 flex-1 bg-transparent pr-3 outline-none" value={slugDraft} onChange={(e) => setSlugDraft(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            </div>
            <Button variant="secondary" disabled={!slugDraft || slugDraft === slug} onClick={() => onSlug(slugDraft.replace(/^-+|-+$/g, ''))}>Save</Button>
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection title="When someone submits" description="Responses create a contact, or update the one with the same email.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Contact source" hint="Set on new contacts only.">
            <Input value={s.contactSource ?? ''} onChange={(e) => set({contactSource: e.target.value})} placeholder="e.g. Website" />
          </Field>
          <Field label="Lifecycle stage" hint="Never moves a contact backwards.">
            <NativeSelect value={s.lifecycleStage ?? ''} onChange={(e) => set({lifecycleStage: e.target.value || null})}>
              <option value="">Leave as is (new contacts: Lead)</option>
              {Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Add tags" className="sm:col-span-2">
            <TagInput value={s.tags ?? []} onChange={(tags) => set({tags})} entity="CONTACT" />
          </Field>
          <Field label="Add respondents to lists" hint="Static lists only; segments pick people up from their rules." className="sm:col-span-2">
            <ListMultiSelect value={s.listIds ?? []} onChange={(listIds) => set({listIds})} />
          </Field>
        </div>

        <div className="mt-5 grid gap-3 border-t border-slate-100 pt-5">
          <p className="text-sm font-semibold text-slate-800">Owner of new contacts</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['none', 'Nobody'],
                ['user', 'One person'],
                ['round_robin', 'Rotate between people'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => set({owner: {...owner, mode}})}
                className={cn('cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium transition-colors', owner.mode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600 hover:border-primary/50')}
              >
                {label}
              </button>
            ))}
          </div>
          {owner.mode === 'user' && (
            <NativeSelect value={owner.userId ?? ''} onChange={(e) => set({owner: {...owner, userId: e.target.value || null}})}>
              <option value="">Pick a teammate…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </NativeSelect>
          )}
          {owner.mode === 'round_robin' && (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {users.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <Checkbox checked={owner.userIds?.includes(u.id) ?? false} onCheckedChange={(v) => set({owner: {...owner, userIds: toggleUser(owner.userIds, u.id, v === true)}})} />
                  {u.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5">
          <Toggle label="Create a deal" hint="Opens a deal for the contact in the pipeline you choose." checked={deal.enabled} onChange={(v) => set({createDeal: {...deal, enabled: v}})} />
          {deal.enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Pipeline">
                <NativeSelect value={pipeline?.id ?? ''} onChange={(e) => set({createDeal: {...deal, pipelineId: e.target.value, stageId: null}})}>
                  {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Stage">
                <NativeSelect value={deal.stageId ?? ''} onChange={(e) => set({createDeal: {...deal, pipelineId: pipeline?.id, stageId: e.target.value || null}})}>
                  <option value="">First stage</option>
                  {pipeline?.stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Deal name" hint="Merge fields: {{contact.full_name}}, {{company.name}}">
                <Input value={deal.title ?? ''} onChange={(e) => set({createDeal: {...deal, title: e.target.value}})} placeholder="{{company.name}} – inbound" />
              </Field>
              <Field label="Value" hint="Or map a number question to “Deal · Value”.">
                <Input type="number" min={0} value={deal.value ?? ''} onChange={(e) => set({createDeal: {...deal, value: e.target.value === '' ? null : Number(e.target.value)}})} />
              </Field>
            </div>
          )}
        </div>
        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5">
          <Toggle label="Create a ticket from each response" hint="For support and contact forms: the answers become the ticket description." checked={ticket.enabled} onChange={(v) => set({createTicket: {...ticket, enabled: v}})} />
          {ticket.enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Ticket subject" hint="Merge fields: {{contact.full_name}}" className="sm:col-span-2">
                <Input value={ticket.subject ?? ''} onChange={(e) => set({createTicket: {...ticket, subject: e.target.value}})} placeholder="Support request · {{contact.full_name}}" />
              </Field>
              <Field label="Priority">
                <NativeSelect value={ticket.priority ?? 'NORMAL'} onChange={(e) => set({createTicket: {...ticket, priority: e.target.value as TicketPriority}})}>
                  {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Category">
                <NativeSelect value={ticket.category ?? ''} onChange={(e) => set({createTicket: {...ticket, category: e.target.value || null}})}>
                  <option value="">No category</option>
                  {ticketSettings.data?.settings.categories.map((c) => <option key={c}>{c}</option>)}
                </NativeSelect>
              </Field>
            </div>
          )}
        </div>
        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5">
          <Toggle
            label="Send responses to the inbox"
            hint="Each response becomes a conversation in the team inbox (Forms channel), linked to the contact. Replying there emails the respondent from the mailbox below."
            checked={inbox.enabled}
            onChange={(v) => set({inbox: {...inbox, enabled: v, accountId: inbox.accountId ?? sharedAccounts[0]?.id ?? null}})}
          />
          {inbox.enabled && (
            <Field label="Shared mailbox" hint={sharedAccounts.length ? 'Replies go out from this mailbox, and answers come back to it.' : 'Connect a shared team mailbox in Settings → Email first.'}>
              <NativeSelect value={inbox.accountId ?? ''} onChange={(e) => set({inbox: {...inbox, accountId: e.target.value || null}})}>
                <option value="">Pick a shared mailbox</option>
                {sharedAccounts.map((a) => <option key={a.id} value={a.id}>{a.fromEmail}</option>)}
              </NativeSelect>
            </Field>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Notifications" description="Who hears about new responses, and what the respondent receives.">
        <div className="grid gap-5">
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-800">Notify in the app</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {users.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <Checkbox checked={s.notifyUserIds?.includes(u.id) ?? false} onCheckedChange={(v) => set({notifyUserIds: toggleUser(s.notifyUserIds, u.id, v === true)})} />
                  {u.name}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">The contact's owner is always notified.</p>
          </div>
          <Field label="Also email these addresses" hint="Comma separated. Sent from a shared team mailbox (Settings → Email).">
            <EmailList value={s.notifyEmails ?? []} onChange={(notifyEmails) => set({notifyEmails})} />
          </Field>
          <div className="grid gap-3 border-t border-slate-100 pt-5">
            <Toggle label="Send an autoresponder" hint="A thank-you email to the respondent, from the form creator's mailbox. Logged on their timeline." checked={auto.enabled} onChange={(v) => set({autoresponder: {...auto, enabled: v}})} />
            {auto.enabled && (
              <>
                <Field label="Subject"><Input value={auto.subject} onChange={(e) => set({autoresponder: {...auto, subject: e.target.value}})} /></Field>
                <Field label="Message" hint="Merge fields: {{contact.first_name|there}}, {{company.name}}, {{me.name}}, {{unsubscribe_url}}">
                  <Textarea rows={6} value={auto.body} onChange={(e) => set({autoresponder: {...auto, body: e.target.value}})} />
                </Field>
              </>
            )}
          </div>
        </div>
      </SettingsSection>

      <EndingsSection fields={fields} endings={s.endings} onChange={(endings) => set({endings})} />

      <SettingsSection title="Availability">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Opens at" hint="Empty: open as soon as it's published.">
            <Input type="datetime-local" value={toLocal(s.opensAt)} onChange={(e) => set({opensAt: fromLocal(e.target.value)})} />
          </Field>
          <Field label="Closes at">
            <Input type="datetime-local" value={toLocal(s.closesAt)} onChange={(e) => set({closesAt: fromLocal(e.target.value)})} />
          </Field>
          <Field label="Response limit" hint="Closes after this many responses.">
            <Input type="number" min={1} value={s.responseLimit ?? ''} onChange={(e) => set({responseLimit: e.target.value ? Math.max(1, Number(e.target.value)) : null})} placeholder="No limit" />
          </Field>
          <Field label="Message when closed">
            <Input value={s.closedMessage ?? ''} onChange={(e) => set({closedMessage: e.target.value})} placeholder="This form is closed." />
          </Field>
        </div>
        <div className="mt-4">
          <Toggle label="One response per person" hint="Blocks a second response from the same email address." checked={!!s.onePerContact} onChange={(v) => set({onePerContact: v})} />
        </div>
      </SettingsSection>

      <SpamSection enabled={!!s.spamCheck} onChange={(spamCheck) => set({spamCheck})} />
    </div>
  );
}

function EmailList({value, onChange}: {value: string[]; onChange: (v: string[]) => void}) {
  const [draft, setDraft] = useState(value.join(', '));
  const parse = (v: string) => [...new Set(v.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
  return <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => (onChange(parse(draft)), setDraft(parse(draft).join(', ')))} placeholder="sales@company.com, founder@company.com" />;
}

function EndingsSection({fields, endings, onChange}: {fields: FormField[]; endings: Ending[]; onChange: (e: Ending[]) => void}) {
  const update = (i: number, p: Partial<Ending>) => onChange(endings.map((e, j) => (j === i ? {...e, ...p} : e)));
  return (
    <SettingsSection
      title="Thank-you screens"
      description="What people see after submitting. Add more screens and pick one by their answers, e.g. qualified vs not."
      actions={
        <Button variant="secondary" size="sm" onClick={() => onChange([...endings, {id: newId('end'), title: 'Thanks!', message: '', when: {match: 'all', rules: [{fieldId: '', op: 'is', value: ''}]}}])}>
          <Plus /> Add screen
        </Button>
      }
    >
      <div className="grid gap-4">
        {endings.map((e, i) => (
          <div key={e.id} className="grid gap-3 rounded-xl border border-slate-200 p-4">
            <div className="flex items-center gap-2">
              {i === 0 ? <Badge tone="neutral">Default</Badge> : <Badge tone="violet"><GitBranch /> Shown when rules match</Badge>}
              {i > 0 && (
                <Button variant="ghost" size="icon-sm" className="ml-auto text-slate-400 hover:text-destructive" onClick={() => onChange(endings.filter((_, j) => j !== i))} aria-label="Remove screen"><Trash2 /></Button>
              )}
            </div>
            <Field label="Title"><Input value={e.title} onChange={(ev) => update(i, {title: ev.target.value})} /></Field>
            <Field label="Message"><Textarea rows={3} value={e.message} onChange={(ev) => update(i, {message: ev.target.value})} /></Field>
            <Field label="Redirect to a page instead (optional)" hint="Respondents are sent here a moment after submitting.">
              <Input type="url" value={e.redirectUrl ?? ''} onChange={(ev) => update(i, {redirectUrl: ev.target.value || undefined})} placeholder="https://example.com/thank-you" />
            </Field>
            {i > 0 && e.when && <RuleGroupEditor group={e.when} sources={fields} onChange={(when) => update(i, {when})} />}
          </div>
        ))}
        {endings.length > 1 && <p className="text-xs text-muted-foreground">The first screen whose rules match is shown; otherwise the default.</p>}
      </div>
    </SettingsSection>
  );
}

function SpamSection({enabled, onChange}: {enabled: boolean; onChange: (v: boolean) => void}) {
  const {isAdmin} = useMe();
  const cfg = useQuery({queryKey: [...keys.forms, 'turnstile'], queryFn: () => api.get<{siteKey: string; configured: boolean}>('/forms/turnstile'), enabled: isAdmin});
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const save = useApiMutation(() => api.put('/forms/turnstile', {siteKey: (siteKey ?? cfg.data?.siteKey ?? '').trim(), secret: secret.trim() || undefined}), {
    invalidate: [[...keys.forms, 'turnstile']],
    success: 'Turnstile keys saved',
    onSuccess: () => setSecret(''),
  });
  return (
    <SettingsSection title="Spam protection" description="Every form has an invisible honeypot and a speed check. Add Cloudflare Turnstile for stronger protection.">
      <div className="grid gap-4">
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <ShieldCheck className="size-4" /> Honeypot and speed check are on for every form.
        </div>
        <Toggle label="Require Cloudflare Turnstile" hint="A privacy-friendly check (usually no puzzle). Needs the keys below." checked={enabled} onChange={onChange} />
        {isAdmin && (
          <div className="grid gap-3 rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-800">
              Turnstile keys <span className="font-normal text-muted-foreground">(shared by all forms)</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Site key"><Input value={siteKey ?? cfg.data?.siteKey ?? ''} onChange={(e) => setSiteKey(e.target.value)} placeholder="0x4AAAA…" /></Field>
              <Field label="Secret key" hint={cfg.data?.configured ? 'Saved. Leave empty to keep it.' : undefined}>
                <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.data?.configured ? '••••••••' : '0x4AAAA…'} autoComplete="off" />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              <a className="text-xs font-semibold text-primary hover:underline" href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noopener noreferrer">Get keys in the Cloudflare dashboard</a>
              <Button size="sm" variant="secondary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>Save keys</Button>
            </div>
          </div>
        )}
        {enabled && !isAdmin && <p className="text-xs text-muted-foreground">An admin needs to add the Turnstile keys for this to work.</p>}
      </div>
    </SettingsSection>
  );
}
