import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {Copy, Loader2} from 'lucide-react';
import {useEffect, useMemo, useState, type ReactNode} from 'react';

import {Overrides, WeeklyHours} from '@/components/booking/availability-editor';
import {copyText} from '@/components/booking/hooks';
import {TimeZoneSelect} from '@/components/booking/slot-picker';
import {ChatPanel} from '@/components/chat/chat-panel';
import type {ChatState} from '@/components/chat/use-chat';
import {TagInput} from '@/components/pickers';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Checkbox, Field, Input, NativeSelect, Switch, Textarea} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {LoadError} from '@/components/data-table';
import {api} from '@/lib/api';
import {BRAND, pageTitle} from '@/lib/brand';
import {REPLY_TIMES, type ChatSettings, type PublicChatConfig, type ReplyTime, type VisitorConversation} from '@/lib/chat';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {availabilityError} from '@/lib/scheduling';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/inbox/chat')({
  head: () => ({meta: [{title: pageTitle('Website chat settings')}]}),
  component: ChatSettingsPage,
});

type Response = {settings: ChatSettings; sharedAccounts: {id: string; label: string; fromEmail: string}[]; snippetUrl: string};

function Toggle({label, hint, checked, onChange, disabled}: {label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean}) {
  return (
    <label className={cn('flex items-start gap-3', disabled && 'opacity-60')}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

const noop = async () => false;
const SAMPLE: VisitorConversation = {
  id: 'preview',
  status: 'OPEN',
  teamTyping: true,
  messages: [
    {id: 'p1', from: 'visitor', author: null, text: 'Hi! Do you offer a free trial?', files: [], at: new Date(Date.now() - 120_000).toISOString(), seen: true, via: null},
    {id: 'p2', from: 'team', author: {name: 'Sam', color: '#0d9488'}, text: 'Hi there! Yes, 14 days, no card needed. Details: https://example.com/pricing', files: [], at: new Date(Date.now() - 60_000).toISOString(), seen: false, via: null},
  ],
};

/** The widget as visitors will see it, from the unsaved settings. Nothing is sent from the preview. */
function Preview({form}: {form: ChatSettings}) {
  const brand = useBrand();
  const team = useTeam();
  const [state, setState] = useState<'new' | 'conversation' | 'away'>('new');
  const config: PublicChatConfig = {
    enabled: true,
    allowed: true,
    teamName: form.teamName || brand.name || BRAND.name,
    greeting: form.greeting || ' ',
    position: form.position,
    color: form.color || brand.primary || BRAND.primary,
    logo: brand.logo || null,
    avatars: form.avatarIds.map((id) => team.data?.find((u) => u.id === id)).filter((u) => !!u).map((u) => ({name: u.name.split(' ')[0]!, color: u.color})),
    replyTime: REPLY_TIMES[form.replyTime],
    preChat: form.preChat,
    askName: form.askName,
    preChatIntro: form.preChatIntro,
    away: state === 'away',
    awayReason: state === 'away' ? 'nobody' : null,
    offlineMessage: form.offlineMessage,
    opensAt: null,
  };
  const chat: ChatState = {
    config,
    loading: false,
    session: null,
    conversation: state === 'conversation' ? SAMPLE : null,
    error: null,
    errorField: null,
    sending: false,
    unread: 0,
    start: noop,
    send: noop,
    upload: async () => null,
    identify: noop,
    typing: () => {},
    clearError: () => {},
  };
  return (
    <div className="grid gap-3 xl:sticky xl:top-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-900">Live preview</p>
        <NativeSelect aria-label="Preview state" className="h-8 w-44 text-xs" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
          <option value="new">New visitor</option>
          <option value="conversation">During a chat</option>
          <option value="away">Team away</option>
        </NativeSelect>
      </div>
      <div className="h-[560px] overflow-hidden rounded-2xl border border-slate-200 shadow-lift">
        <ChatPanel chat={chat} preview onClose={() => {}} />
      </div>
      <div className={cn('flex', form.position === 'left' ? 'justify-start' : 'justify-end')}>
        <span className="flex size-14 items-center justify-center rounded-full text-white shadow-lift" style={{background: config.color}} aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>
        </span>
      </div>
    </div>
  );
}

function Snippet({url}: {url: string}) {
  const code = `<script src="${url}" async></script>`;
  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-2">
        <p className="text-slate-700">Paste this before <code className="rounded bg-slate-100 px-1">&lt;/body&gt;</code> on every page of your website. It adds the chat bubble; the chat itself runs from this app, so it always uses these settings.</p>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">{code}</pre>
          <Button type="button" variant="secondary" size="sm" onClick={() => copyText(code, 'Snippet copied')}><Copy /> Copy</Button>
        </div>
      </div>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer font-semibold text-slate-800">Options and JavaScript API</summary>
        <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-slate-600">
          <li><code className="rounded bg-slate-100 px-1">data-position="left"</code> on the script tag puts the bubble on the left on that site, whatever is set here.</li>
          <li><code className="rounded bg-slate-100 px-1">data-open="1"</code> opens the chat as soon as the page loads.</li>
          <li><code className="rounded bg-slate-100 px-1">window.CrmChat.open()</code>, <code className="rounded bg-slate-100 px-1">.close()</code> and <code className="rounded bg-slate-100 px-1">.toggle()</code> control it from your own buttons.</li>
          <li>The bubble opens the chat in a small window: <code className="rounded bg-slate-100 px-1">/chat/</code> on this site (it can't sit inside another website's page). Visitors are remembered there, so they see their conversation when they come back.</li>
          <li>The settings (on / off, colour, side, allowed websites) are read when a page loads the script: changes show within a minute.</li>
          <li>Pages built in this app use <code className="rounded bg-slate-100 px-1">&lt;ChatWidget /&gt;</code> from <code className="rounded bg-slate-100 px-1">src/crm/components/chat/chat-widget.tsx</code> instead of the snippet.</li>
        </ul>
      </details>
    </div>
  );
}

function ChatSettingsPage() {
  const {isAdmin} = useMe();
  const team = useTeam();
  const brand = useBrand();
  const q = useQuery({queryKey: [...keys.inbox, 'chat-settings'], queryFn: () => api.get<Response>('/inbox/chat/settings'), enabled: isAdmin});
  const [form, setForm] = useState<ChatSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);
  const save = useApiMutation(() => api.put<{settings: ChatSettings}>('/inbox/chat/settings', form), {invalidate: [keys.inbox], success: 'Chat settings saved', onSuccess: (r) => setForm(r.settings)});
  const problem = useMemo(() => (form?.hours.enabled ? availabilityError(form.hours.availability) : null), [form]);
  const f = useFormState(
    {teamName: form?.teamName ?? '', greeting: form?.greeting ?? '', preChatIntro: form?.preChatIntro ?? '', offlineMessage: form?.offlineMessage ?? ''},
    {
      teamName: [is.maxLength(60)],
      greeting: [is.maxLength(300)],
      preChatIntro: [is.maxLength(300)],
      offlineMessage: [is.required('Write the away message visitors see.'), is.maxLength(500)],
    },
  );

  if (!isAdmin) return <AdminOnly />;
  if (q.isError && !q.data) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!form || !q.data) return <Loader2 className="size-5 animate-spin text-primary" />;
  const set = (patch: Partial<ChatSettings>) => setForm({...form, ...patch});
  const setHours = (patch: Partial<ChatSettings['hours']>) => set({hours: {...form.hours, ...patch}});
  const people = (team.data ?? []).filter((u) => u.active && u.role !== 'VIEWER');
  const shared = q.data.sharedAccounts;

  return (
    <form {...f.form(() => !problem && save.mutate(undefined, {onError: f.fail}))} className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0">
        <SettingsSection title="Website chat" description="A chat bubble on your website. Chats land in the team inbox under Chat, follow its assignment rules and work like any other conversation.">
          <div className="grid gap-4">
            <Toggle label="Show the chat on your website" hint={form.enabled ? 'On: visitors see the chat bubble.' : 'Off: the bubble is hidden from your website (the snippet can stay).'} checked={form.enabled} onChange={(enabled) => set({enabled})} />
            <Field label="Team mailbox for emails to visitors" htmlFor="ch-account" hint="Replies a visitor missed after leaving, and transcripts, go out from it. Their answers come back into the chat.">
              {shared.length ? (
                <NativeSelect id="ch-account" value={form.accountId ?? ''} onChange={(e) => set({accountId: e.target.value || null})}>
                  <option value="">The first shared mailbox ({shared[0]!.fromEmail})</option>
                  {shared.map((a) => <option key={a.id} value={a.id}>{a.fromEmail}{a.label ? ` · ${a.label}` : ''}</option>)}
                </NativeSelect>
              ) : (
                <p className="text-sm text-muted-foreground">No shared mailbox yet: <Link to="/settings/email" className="font-semibold text-primary hover:underline">connect one in Settings → Email</Link>. Until then visitors only see replies in the chat.</p>
              )}
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Appearance">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Team name" htmlFor="ch-name" hint={`Empty: ${brand.name}`} error={f.error('teamName')}><Input id="ch-name" maxLength={60} value={form.teamName} placeholder={brand.name} onChange={(e) => set({teamName: e.target.value})} onBlur={f.blur('teamName')} /></Field>
            <Field label="Reply time" htmlFor="ch-reply">
              <NativeSelect id="ch-reply" value={form.replyTime} onChange={(e) => set({replyTime: e.target.value as ReplyTime})}>
                {(Object.keys(REPLY_TIMES) as ReplyTime[]).map((k) => <option key={k} value={k}>{REPLY_TIMES[k]}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Greeting" htmlFor="ch-greeting" className="sm:col-span-2" error={f.error('greeting')}><Textarea id="ch-greeting" rows={2} maxLength={300} value={form.greeting} onChange={(e) => set({greeting: e.target.value})} onBlur={f.blur('greeting')} /></Field>
            <Field label="Colour" group hint="The brand colour from Settings → Branding unless you pick one.">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <Checkbox checked={!form.color} onCheckedChange={(v) => set({color: v === true ? null : brand.primary || BRAND.primary})} /> Brand colour
                </label>
                {form.color && <input id="ch-color" type="color" value={form.color} onChange={(e) => set({color: e.target.value})} className="h-9 w-14 cursor-pointer rounded border border-slate-200" aria-label="Chat colour" />}
              </div>
            </Field>
            <Field label="Bubble position" htmlFor="ch-pos">
              <NativeSelect id="ch-pos" value={form.position} onChange={(e) => set({position: e.target.value as ChatSettings['position']})}>
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </NativeSelect>
            </Field>
            <div className="grid gap-1.5 sm:col-span-2">
              <p className="text-sm font-semibold text-slate-800">Faces in the header <span className="font-normal text-muted-foreground">(up to 3; none shows your logo)</span></p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                {people.map((u) => {
                  const on = form.avatarIds.includes(u.id);
                  return (
                    <label key={u.id} className={cn('flex cursor-pointer items-center gap-2 text-sm text-slate-700', !on && form.avatarIds.length >= 3 && 'opacity-50')}>
                      <Checkbox checked={on} disabled={!on && form.avatarIds.length >= 3} onCheckedChange={(v) => set({avatarIds: v === true ? [...form.avatarIds, u.id] : form.avatarIds.filter((x) => x !== u.id)})} />
                      {u.name}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Pre-chat form" description="Ask for a name and email before the first message. With an email, the chat is linked to the contact (created when new).">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="ch-pre">
              <NativeSelect id="ch-pre" value={form.preChat} onChange={(e) => set({preChat: e.target.value as ChatSettings['preChat']})}>
                <option value="off">Don't ask</option>
                <option value="optional">Ask, optional</option>
                <option value="required">Required to start</option>
              </NativeSelect>
            </Field>
            {form.preChat !== 'off' && (
              <>
                <div className="flex items-end pb-2"><Toggle label="Also ask for a name" checked={form.askName} onChange={(askName) => set({askName})} /></div>
                <Field label="Intro" htmlFor="ch-intro" className="sm:col-span-2" error={f.error('preChatIntro')}><Input id="ch-intro" maxLength={300} value={form.preChatIntro} onChange={(e) => set({preChatIntro: e.target.value})} onBlur={f.blur('preChatIntro')} /></Field>
              </>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="Office hours and away" description="Outside office hours, or when nobody who works the team inbox has the app open, the widget shows “away”. Messages are still accepted; visitors are asked for an email and get the reply by email.">
          <div className="grid gap-5">
            <Toggle label="Use office hours" checked={form.hours.enabled} onChange={(enabled) => setHours({enabled})} />
            {form.hours.enabled && (
              <>
                <Field label="Time zone" className="max-w-sm"><TimeZoneSelect value={form.hours.timezone} onChange={(timezone) => setHours({timezone})} /></Field>
                <WeeklyHours value={form.hours.availability} onChange={(availability) => setHours({availability})} />
                <Overrides value={form.hours.availability} onChange={(availability) => setHours({availability})} />
                {problem && <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>}
              </>
            )}
            <Field label="Away message" htmlFor="ch-offline" error={f.error('offlineMessage')}><Textarea id="ch-offline" rows={2} maxLength={500} value={form.offlineMessage} onChange={(e) => set({offlineMessage: e.target.value})} onBlur={f.blur('offlineMessage')} /></Field>
            <Field label="Email replies after the visitor has been gone for (minutes)" htmlFor="ch-away" className="max-w-sm" hint="Replies they haven't read by then are emailed to them, with a link back to the chat.">
              <Input id="ch-away" type="number" inputMode="numeric" value={form.awayAfterMin} onChange={(e) => set({awayAfterMin: Math.max(1, Math.min(1440, Number(e.target.value) || 1))})} />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Where it runs" description="Limits which websites may show the chat, and keeps bots out.">
          <div className="grid gap-4">
            <Field label="Allowed domains" htmlFor="ch-domains" hint="Empty: any site with the snippet. example.com also covers www.example.com and shop.example.com. Pages of this app always work.">
              <TagInput id="ch-domains" noun="domain" value={form.allowedDomains} onChange={(allowedDomains) => set({allowedDomains})} />
            </Field>
            <p className="text-xs text-muted-foreground">Starting chats and sending messages are rate limited per visitor and per network address.</p>
          </div>
        </SettingsSection>

        <SettingsSection title="Add it to your website">
          <Snippet url={q.data.snippetUrl} />
        </SettingsSection>

        <div className="mb-6 flex justify-end">
          <Button type="submit" disabled={!!problem} pending={save.isPending} pendingLabel="Saving…">Save changes</Button>
        </div>
      </div>
      <aside aria-label="Preview"><Preview form={form} /></aside>
    </form>
  );
}
