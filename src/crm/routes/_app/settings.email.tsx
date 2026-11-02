import {createFileRoute} from '@tanstack/react-router';
import {ArrowRight, CheckCircle2, Copy, Inbox, KeyRound, Loader2, Mail, MessageSquareReply, MoreHorizontal, PenLine, RefreshCw, Send, Server, Star, Trash2, Zap} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {EmailDesignSection, SignatureDialog} from '@/components/email-design';
import {ReplyCaptureLine, RepliesDialog} from '@/components/email-replies';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, Label, NativeSelect, Switch} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useEmailAccounts, useMe, useSettings} from '@/lib/queries';
import type {EmailAccount, EmailProvider} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/email')({
  validateSearch: z.object({connected: z.string().optional(), error: z.string().optional()}),
  component: EmailSettings,
});

const API_PROVIDERS: {id: Extract<EmailProvider, 'RESEND' | 'POSTMARK' | 'SENDGRID' | 'MAILGUN'>; name: string; note: string}[] = [
  {id: 'RESEND', name: 'Resend', note: 'Developer-friendly, quick domain setup'},
  {id: 'POSTMARK', name: 'Postmark', note: 'Best-in-class deliverability + inbound'},
  {id: 'SENDGRID', name: 'SendGrid', note: 'High volume, Inbound Parse'},
  {id: 'MAILGUN', name: 'Mailgun', note: 'US or EU region, inbound routes'},
];

const SMTP_PRESETS = [
  {name: 'Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls'},
  {name: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls'},
  {name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'tls'},
  {name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls'},
  {name: 'cPanel / other', host: '', port: 465, security: 'tls'},
] as const;

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success('Copied');
}

function CopyField({label, value, hint}: {label: string; value: string; hint?: string}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="secondary" size="icon" onClick={() => copy(value)} aria-label={`Copy ${label}`}><Copy /></Button>
      </div>
    </Field>
  );
}

// ─── Option picker ───

function OptionCard({step, icon, title, description, bullets, onClick, tone}: {step: number; icon: React.ReactNode; title: string; description: string; bullets: string[]; onClick: () => void; tone: 'blue' | 'teal' | 'violet'}) {
  return (
    <Card interactive className="group relative flex flex-col p-5">
      <span className="absolute top-4 right-4 flex size-6 items-center justify-center rounded-full bg-brand text-[11px] font-extrabold text-white shadow-glow">{step}</span>
      <IconBadge tone={tone} className="size-12">{icon}</IconBadge>
      <h3 className="mt-4 text-base font-bold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <ul className="mt-3 grid flex-1 gap-1.5 text-sm text-slate-600">
        {bullets.map((b) => <li key={b} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />{b}</li>)}
      </ul>
      <Button variant="secondary" className="mt-5 w-full" onClick={onClick}>
        Set up <ArrowRight className="transition-transform group-hover:translate-x-1" />
      </Button>
    </Card>
  );
}

// ─── Forms ───

type Meta = {fromName: string; fromEmail: string; shared: boolean};

function SenderFields({meta, setMeta}: {meta: Meta; setMeta: (m: Meta) => void}) {
  const {isAdmin} = useMe();
  return (
    <div className="grid gap-4 border-t border-slate-100 pt-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="From name" htmlFor="m-name"><Input id="m-name" required value={meta.fromName} onChange={(e) => setMeta({...meta, fromName: e.target.value})} /></Field>
        <Field label="From email" htmlFor="m-email"><Input id="m-email" type="email" required value={meta.fromEmail} onChange={(e) => setMeta({...meta, fromEmail: e.target.value})} /></Field>
      </div>
      <p className="text-xs text-muted-foreground">Add a signature (with a logo or headshot) from the account's menu once it's connected.</p>
      {isAdmin && (
        <div className="flex items-center gap-2">
          <Checkbox id="m-shared" checked={meta.shared} onCheckedChange={(v) => setMeta({...meta, shared: v === true})} />
          <Label htmlFor="m-shared" className="font-medium">Shared team account (everyone can send from it)</Label>
        </div>
      )}
    </div>
  );
}

function SetupDialog({kind, onClose}: {kind: 'smtp' | 'api'; onClose: () => void}) {
  const {me} = useMe();
  const [meta, setMeta] = useState<Meta>({fromName: me.name, fromEmail: me.email, shared: false});
  const [smtp, setSmtp] = useState({host: '', port: '587', security: 'starttls', username: me.email, password: ''});
  const [provider, setProvider] = useState<(typeof API_PROVIDERS)[number]['id']>('RESEND');
  const [key, setKey] = useState({apiKey: '', serverToken: '', messageStream: '', domain: '', region: 'us'});

  const create = useApiMutation(
    () => {
      const credentials =
        kind === 'smtp'
          ? {provider: 'SMTP', ...smtp, port: Number(smtp.port)}
          : provider === 'POSTMARK'
            ? {provider, serverToken: key.serverToken, messageStream: key.messageStream || undefined}
            : provider === 'MAILGUN'
              ? {provider, apiKey: key.apiKey, domain: key.domain, region: key.region}
              : {provider, apiKey: key.apiKey};
      return api.post<{account: EmailAccount}>('/email/accounts', {credentials, account: meta});
    },
    {
      invalidate: [keys.email],
      onSuccess: ({account}) => {
        if (account.status === 'ERROR') toast.error(`Saved, but the connection failed: ${account.lastError}`);
        else toast.success(`${account.fromEmail} connected`);
        onClose();
      },
    },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form onSubmit={(e) => (e.preventDefault(), create.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{kind === 'smtp' ? 'Connect custom SMTP' : 'Connect a sending API'}</DialogTitle>
            <DialogDescription>{kind === 'smtp' ? 'Works with any mail server. We test the login before saving.' : 'Deliver through a transactional email service using your verified domain.'}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {kind === 'smtp' ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {SMTP_PRESETS.map((p) => (
                    <button key={p.name} type="button" onClick={() => setSmtp({...smtp, host: p.host, port: String(p.port), security: p.security})} className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-colors', smtp.host === p.host && p.host ? 'border-primary bg-accent text-primary' : 'border-border text-slate-600 hover:border-slate-300')}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_100px]">
                  <Field label="SMTP host" htmlFor="s-host"><Input id="s-host" required value={smtp.host} onChange={(e) => setSmtp({...smtp, host: e.target.value})} placeholder="mail.yourdomain.com" /></Field>
                  <Field label="Port" htmlFor="s-port"><Input id="s-port" required type="number" value={smtp.port} onChange={(e) => setSmtp({...smtp, port: e.target.value})} /></Field>
                </div>
                <Field label="Security" htmlFor="s-sec" hint="Port 465 → SSL/TLS. Port 587 → STARTTLS. Port 25 is blocked on the hosting network.">
                  <NativeSelect id="s-sec" value={smtp.security} onChange={(e) => setSmtp({...smtp, security: e.target.value})}>
                    <option value="tls">SSL / TLS</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="none">None (not recommended)</option>
                  </NativeSelect>
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Username" htmlFor="s-user"><Input id="s-user" value={smtp.username} onChange={(e) => setSmtp({...smtp, username: e.target.value})} autoComplete="off" /></Field>
                  <Field label="Password / app password" htmlFor="s-pass"><Input id="s-pass" type="password" value={smtp.password} onChange={(e) => setSmtp({...smtp, password: e.target.value})} autoComplete="new-password" /></Field>
                </div>
                <p className="flex gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <MessageSquareReply className="size-4 shrink-0 text-primary" />
                  <span>SMTP only sends. After connecting, open the account's menu → <b>How replies come back</b> to add a reply-to inbound address so replies reach the CRM.</span>
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {API_PROVIDERS.map((p) => (
                    <button key={p.id} type="button" onClick={() => setProvider(p.id)} className={cn('cursor-pointer rounded-xl border p-3 text-left transition-all', provider === p.id ? 'border-primary bg-accent/60 ring-2 ring-primary/15' : 'border-border hover:border-slate-300')}>
                      <p className="text-sm font-bold text-slate-900">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.note}</p>
                    </button>
                  ))}
                </div>
                {provider === 'POSTMARK' ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Server API token" htmlFor="k-token"><Input id="k-token" required type="password" value={key.serverToken} onChange={(e) => setKey({...key, serverToken: e.target.value})} /></Field>
                    <Field label="Message stream" htmlFor="k-stream" hint="Default: outbound"><Input id="k-stream" value={key.messageStream} onChange={(e) => setKey({...key, messageStream: e.target.value})} placeholder="outbound" /></Field>
                  </div>
                ) : (
                  <Field label="API key" htmlFor="k-key"><Input id="k-key" required type="password" value={key.apiKey} onChange={(e) => setKey({...key, apiKey: e.target.value})} /></Field>
                )}
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Sending APIs don't receive mail. After connecting, open the account's menu → <b>How replies come back</b> to add your provider's inbound address as the reply-to.</p>
                {provider === 'MAILGUN' && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Sending domain" htmlFor="k-domain"><Input id="k-domain" required value={key.domain} onChange={(e) => setKey({...key, domain: e.target.value})} placeholder="mg.yourdomain.com" /></Field>
                    <Field label="Region" htmlFor="k-region">
                      <NativeSelect id="k-region" value={key.region} onChange={(e) => setKey({...key, region: e.target.value})}><option value="us">US</option><option value="eu">EU</option></NativeSelect>
                    </Field>
                  </div>
                )}
              </>
            )}
            <SenderFields meta={meta} setMeta={setMeta} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? <Loader2 className="animate-spin" /> : <Zap />} Test & connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OAuthDialog({onClose}: {onClose: () => void}) {
  const {isAdmin} = useMe();
  const settings = useSettings();
  const oauth = settings.data?.oauth;
  const [shared, setShared] = useState(false);
  const start = (kind: 'google' | 'microsoft') => (window.location.href = `/site-api/crm/email/oauth/${kind}/start${shared ? '?shared=1' : ''}`);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect your mailbox</DialogTitle>
          <DialogDescription>Send from your real inbox and log replies from contacts automatically.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {[
            {kind: 'google' as const, name: 'Gmail / Google Workspace', ok: oauth?.googleConfigured, color: 'bg-rose-50 text-rose-600'},
            {kind: 'microsoft' as const, name: 'Outlook / Microsoft 365', ok: oauth?.microsoftConfigured, color: 'bg-sky-50 text-sky-600'},
          ].map((p) => (
            <button key={p.kind} disabled={!p.ok} onClick={() => start(p.kind)} className="group flex cursor-pointer items-center gap-4 rounded-xl border border-border p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-lift disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none">
              <span className={cn('flex size-11 items-center justify-center rounded-xl', p.color)}><Mail className="size-5" /></span>
              <div className="flex-1">
                <p className="text-sm font-bold text-slate-900">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.ok ? 'Sign in and grant access' : isAdmin ? 'Add the OAuth app below first' : 'Ask an admin to set up the OAuth app'}</p>
              </div>
              <ArrowRight className="size-4 text-slate-400 transition-transform group-hover:translate-x-1" />
            </button>
          ))}
          {isAdmin && (
            <div className="flex items-center gap-2">
              <Checkbox id="o-shared" checked={shared} onCheckedChange={(v) => setShared(v === true)} />
              <Label htmlFor="o-shared" className="font-medium">Connect as a shared team mailbox</Label>
            </div>
          )}
          <p className="text-xs text-muted-foreground">We only store mail that involves your existing contacts. Revoke access any time from your Google or Microsoft account.</p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ─── Account list ───

const STATUS = {CONNECTED: {tone: 'green', label: 'Connected'}, ERROR: {tone: 'rose', label: 'Needs attention'}, PENDING: {tone: 'amber', label: 'Not verified'}} as const;

function AccountRow({account}: {account: EmailAccount}) {
  const [testTo, setTestTo] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'replies' | 'signature' | null>(null);
  const update = useApiMutation((patch: Record<string, unknown>) => api.patch(`/email/accounts/${account.id}`, patch), {invalidate: [keys.email]});
  const remove = useApiMutation(() => api.del(`/email/accounts/${account.id}`), {invalidate: [keys.email], success: 'Account removed'});
  const test = useApiMutation((to?: string) => api.post<{ok: boolean; detail: string}>(`/email/accounts/${account.id}/test`, {to}), {
    invalidate: [keys.email],
    onSuccess: (r) => (r.ok ? toast.success(r.detail) : toast.error(r.detail), setTestTo(null)),
  });
  const sync = useApiMutation(() => api.post<{stored: number; error?: string}>(`/email/accounts/${account.id}/sync`), {
    invalidate: [keys.email],
    onSuccess: (r) => (r.error ? toast.error(r.error) : toast.success(`${r.stored} new email${r.stored === 1 ? '' : 's'} logged`)),
  });
  const st = STATUS[account.status];

  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <IconBadge tone={account.info.kind === 'oauth' ? 'violet' : account.info.kind === 'api' ? 'teal' : 'blue'}>
        {account.info.kind === 'oauth' ? <Inbox /> : account.info.kind === 'api' ? <Zap /> : <Server />}
      </IconBadge>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-bold text-slate-900">{account.fromEmail}</p>
          <Badge tone={st.tone}>{st.label}</Badge>
          {account.isDefault && <Badge tone="blue"><Star /> Default</Badge>}
          {!account.userId && <Badge tone="outline">Team</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {account.info.label} · {account.info.inbound}
          {account.lastSyncedAt && ` · synced ${ago(account.lastSyncedAt)}`}
        </p>
        {account.lastError && <p className="mt-1 text-xs font-medium text-destructive">{account.lastError}</p>}
        <ReplyCaptureLine account={account} onSetup={() => setDialog('replies')} />
      </div>
      <div className="flex items-center gap-3 self-start sm:self-center">
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600"><Switch checked={account.trackOpens} onCheckedChange={(v) => update.mutate({trackOpens: v})} aria-label="Track opens" /> Opens</label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600"><Switch checked={account.trackClicks} onCheckedChange={(v) => update.mutate({trackClicks: v})} aria-label="Track clicks" /> Clicks</label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="secondary" size="icon-sm" aria-label="Account actions">{test.isPending || sync.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}</Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => test.mutate(undefined)}><Zap /> Test connection</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTestTo(account.fromEmail)}><Send /> Send test email…</DropdownMenuItem>
            {account.info.kind === 'oauth' && <DropdownMenuItem onSelect={() => sync.mutate(undefined)}><RefreshCw /> Sync now</DropdownMenuItem>}
            {account.info.kind !== 'oauth' && <DropdownMenuItem onSelect={() => setDialog('replies')}><MessageSquareReply /> How replies come back…</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => setDialog('signature')}><PenLine /> Signature…</DropdownMenuItem>
            {!account.isDefault && <DropdownMenuItem onSelect={() => update.mutate({isDefault: true})}><Star /> Make default</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Disconnect ${account.fromEmail}?`, confirmLabel: 'Disconnect', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Disconnect</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {dialog === 'replies' && <RepliesDialog account={account} onClose={() => setDialog(null)} />}
      {dialog === 'signature' && <SignatureDialog account={account} onClose={() => setDialog(null)} />}
      {testTo !== null && (
        <Dialog open onOpenChange={(o) => !o && setTestTo(null)}>
          <DialogContent size="sm">
            <form onSubmit={(e) => (e.preventDefault(), test.mutate(testTo))} className="flex min-h-0 flex-1 flex-col">
              <DialogHeader><DialogTitle>Send a test email</DialogTitle></DialogHeader>
              <DialogBody><Field label="Send to" htmlFor="t-to"><Input id="t-to" type="email" required value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field></DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setTestTo(null)}>Cancel</Button>
                <Button type="submit" disabled={test.isPending}>{test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send test</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Page ───

function EmailSettings() {
  const s = Route.useSearch();
  const {isAdmin} = useMe();
  const accounts = useEmailAccounts();
  const settings = useSettings();
  const [dialog, setDialog] = useState<'smtp' | 'api' | 'oauth' | null>(null);
  const [oauthForm, setOauthForm] = useState({googleClientId: '', googleClientSecret: '', microsoftClientId: '', microsoftClientSecret: '', microsoftTenant: 'common'});
  const [bcc, setBcc] = useState('');

  useEffect(() => {
    if (s.connected) toast.success(s.connected);
    if (s.error) toast.error(s.error);
  }, [s.connected, s.error]);
  useEffect(() => {
    const st = settings.data?.settings;
    if (st) {
      setOauthForm((f) => ({...f, googleClientId: st.googleClientId, microsoftClientId: st.microsoftClientId, microsoftTenant: st.microsoftTenant}));
      setBcc(st.bccAddress);
    }
  }, [settings.data]);

  const saveSettings = useApiMutation((patch: Record<string, string>) => api.patch('/settings', patch), {invalidate: [keys.settings], success: 'Saved'});
  const oauth = settings.data?.oauth;

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <OptionCard
          step={1}
          tone="blue"
          icon={<Server />}
          title="Custom SMTP"
          description="Use any mail server you already have: cPanel, Zoho, Workspace, SES…"
          bullets={['Works with every provider', 'Replies via a reply-to inbound address', 'Password stored encrypted']}
          onClick={() => setDialog('smtp')}
        />
        <OptionCard
          step={2}
          tone="teal"
          icon={<Zap />}
          title="Transactional API"
          description="Resend, Postmark, SendGrid or Mailgun over HTTPS."
          bullets={['Best deliverability', "Replies via the provider's inbound address", 'Great for templates at volume']}
          onClick={() => setDialog('api')}
        />
        <OptionCard
          step={3}
          tone="violet"
          icon={<Inbox />}
          title="Gmail or Outlook"
          description="Connect your real mailbox with one click (OAuth)."
          bullets={['Emails appear in your Sent folder', 'Two-way sync with contacts', 'No passwords stored']}
          onClick={() => setDialog('oauth')}
        />
      </div>

      <SettingsSection title="Connected accounts" description="Your accounts and shared team accounts you can send from.">
        {accounts.isLoading ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : accounts.data?.length ? (
          <div className="divide-y divide-slate-100">{accounts.data.map((a) => <AccountRow key={a.id} account={a} />)}</div>
        ) : (
          <p className="text-sm text-muted-foreground">No email accounts yet. Pick one of the three options above.</p>
        )}
      </SettingsSection>

      {isAdmin && settings.data && (
        <>
          <EmailDesignSection />

          <SettingsSection title="Inbound webhook & BCC logging" description="Gmail and Outlook sync on their own. SMTP and API accounts get replies through a reply-to inbound address; inbound addresses (Reply-To, BCC logging) post to this webhook.">
            <div className="grid gap-4">
              <CopyField label="Inbound webhook URL" value={settings.data.inboundWebhookUrl} hint="Postmark: Inbound stream → Webhook. Mailgun: Routes → forward(). SendGrid: Inbound Parse. Resend: Receiving → webhook for email.received. Treat this URL as a secret." />
              <Field label="BCC logging address" htmlFor="bcc" hint="The inbound address you created at the provider (e.g. log@inbound.yourdomain.com). Reps BCC it from any mail client and the email lands on the contact's timeline.">
                <div className="flex gap-2">
                  <Input id="bcc" type="email" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="log@inbound.yourdomain.com" />
                  <Button variant="secondary" onClick={() => saveSettings.mutate({bccAddress: bcc})}>Save</Button>
                </div>
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection title="OAuth apps for Gmail & Outlook" description="One-time admin setup. Create an OAuth client in Google Cloud / Microsoft Entra and paste the details.">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="grid content-start gap-3 rounded-xl bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-sm font-bold text-slate-900"><KeyRound className="size-4 text-rose-500" /> Google</p>
                  {oauth?.googleConfigured && <Badge tone="green">Configured</Badge>}
                </div>
                <CopyField label="Authorized redirect URI" value={oauth?.googleRedirectUri ?? ''} />
                <Field label="Client ID" htmlFor="g-id"><Input id="g-id" value={oauthForm.googleClientId} onChange={(e) => setOauthForm({...oauthForm, googleClientId: e.target.value})} /></Field>
                <Field label="Client secret" htmlFor="g-secret"><Input id="g-secret" type="password" value={oauthForm.googleClientSecret} onChange={(e) => setOauthForm({...oauthForm, googleClientSecret: e.target.value})} placeholder={oauth?.googleConfigured ? '•••••••• (saved)' : ''} /></Field>
                <p className="text-xs text-muted-foreground">Scopes: gmail.send, gmail.readonly. Public apps need Google's verification for these scopes; internal Workspace apps don't.</p>
                <Button variant="secondary" onClick={() => saveSettings.mutate({googleClientId: oauthForm.googleClientId, ...(oauthForm.googleClientSecret && {googleClientSecret: oauthForm.googleClientSecret})})}>Save Google app</Button>
              </div>
              <div className="grid content-start gap-3 rounded-xl bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-sm font-bold text-slate-900"><KeyRound className="size-4 text-sky-500" /> Microsoft</p>
                  {oauth?.microsoftConfigured && <Badge tone="green">Configured</Badge>}
                </div>
                <CopyField label="Redirect URI (Web)" value={oauth?.microsoftRedirectUri ?? ''} />
                <Field label="Application (client) ID" htmlFor="ms-id"><Input id="ms-id" value={oauthForm.microsoftClientId} onChange={(e) => setOauthForm({...oauthForm, microsoftClientId: e.target.value})} /></Field>
                <Field label="Client secret value" htmlFor="ms-secret"><Input id="ms-secret" type="password" value={oauthForm.microsoftClientSecret} onChange={(e) => setOauthForm({...oauthForm, microsoftClientSecret: e.target.value})} placeholder={oauth?.microsoftConfigured ? '•••••••• (saved)' : ''} /></Field>
                <Field label="Tenant" htmlFor="ms-tenant" hint="common, organizations, or your tenant ID"><Input id="ms-tenant" value={oauthForm.microsoftTenant} onChange={(e) => setOauthForm({...oauthForm, microsoftTenant: e.target.value})} /></Field>
                <Button variant="secondary" onClick={() => saveSettings.mutate({microsoftClientId: oauthForm.microsoftClientId, microsoftTenant: oauthForm.microsoftTenant, ...(oauthForm.microsoftClientSecret && {microsoftClientSecret: oauthForm.microsoftClientSecret})})}>Save Microsoft app</Button>
              </div>
            </div>
          </SettingsSection>
        </>
      )}

      {(dialog === 'smtp' || dialog === 'api') && <SetupDialog kind={dialog} onClose={() => setDialog(null)} />}
      {dialog === 'oauth' && <OAuthDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
