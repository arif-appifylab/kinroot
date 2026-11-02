/**
 * Settings → Email: how replies come back for each account. Gmail / Outlook
 * sync their mailbox; SMTP and API accounts set a Reply-To inbound address
 * that an email service posts to the inbound webhook.
 */
import {AlertTriangle, Copy, Loader2, MessageSquareReply, RefreshCw, Webhook} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {keys, useApiMutation, useMe, useSettings} from '@/lib/queries';
import type {EmailAccount} from '@/lib/types';

import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Field, Input, NativeSelect, Switch} from './ui/form';

// ─── Per-service guides ───

function Steps({items}: {items: React.ReactNode[]}) {
  return (
    <ol className="grid gap-1.5 text-sm text-slate-600">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-primary">{i + 1}</span>
          <span className="min-w-0">{s}</span>
        </li>
      ))}
    </ol>
  );
}

const Code = ({children}: {children: React.ReactNode}) => <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] break-all text-slate-800">{children}</code>;

type Service = 'RESEND' | 'POSTMARK' | 'SENDGRID' | 'MAILGUN';
const SERVICES: {id: Service; name: string}[] = [
  {id: 'RESEND', name: 'Resend Receiving'},
  {id: 'POSTMARK', name: 'Postmark inbound'},
  {id: 'SENDGRID', name: 'SendGrid Inbound Parse'},
  {id: 'MAILGUN', name: 'Mailgun routes'},
];

function WebhookGuide({service, url}: {service: Service; url: string}) {
  const hook = url ? <Code>{url}</Code> : <span className="font-semibold">the inbound webhook URL (ask an admin)</span>;
  switch (service) {
    case 'RESEND':
      return <Steps items={[<>In Resend, open <b>Receiving</b> and turn it on for your domain (MX record), or use your <Code>…@&lt;id&gt;.resend.app</Code> address.</>, <>Add a webhook for the <Code>email.received</Code> event pointing to {hook}.</>, <>Enter the receiving address (e.g. <Code>replies@yourdomain.com</Code>) as the reply-to address below.</>]} />;
    case 'POSTMARK':
      return <Steps items={[<>In Postmark, open your server → <b>Default Inbound Stream</b> → Settings.</>, <>Set the inbound webhook to {hook}.</>, <>Copy the inbound address (<Code>…@inbound.postmarkapp.com</Code>, or your own inbound domain) into the reply-to address below.</>]} />;
    case 'SENDGRID':
      return <Steps items={[<>Point an MX record for a subdomain (e.g. <Code>reply.yourdomain.com</Code>) to <Code>mx.sendgrid.net</Code>.</>, <>In SendGrid → Settings → <b>Inbound Parse</b>, add that host with the URL {hook}.</>, <>Use any address at that host (e.g. <Code>replies@reply.yourdomain.com</Code>) as the reply-to address below.</>]} />;
    case 'MAILGUN':
      return <Steps items={[<>In Mailgun → <b>Receiving</b>, create a route: match recipient <Code>replies@mg.yourdomain.com</Code>.</>, <>Action: forward to {hook}.</>, <>Enter that address as the reply-to address below.</>]} />;
  }
}

// ─── Status line on the account row ───

const CAPTURE = {
  sync: {icon: RefreshCw, tone: 'green', label: 'Two-way mailbox sync'},
  webhook: {icon: Webhook, tone: 'green', label: 'Reply-To inbound address'},
  none: {icon: AlertTriangle, tone: 'amber', label: 'Replies are not captured'},
} as const;

export function ReplyCaptureLine({account, onSetup}: {account: EmailAccount; onSetup: () => void}) {
  const c = CAPTURE[account.replyCapture];
  if (account.replyCapture === 'none') {
    return (
      <div className="mt-2 flex flex-col gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:flex-row sm:items-center">
        <AlertTriangle className="size-4 shrink-0" />
        <p className="flex-1">
          <b>Replies are not captured.</b> They land in {account.fromEmail} and never reach the CRM. Add a reply-to inbound address.
        </p>
        <Button size="sm" variant="secondary" className="h-7" onClick={onSetup}>Set up replies</Button>
      </div>
    );
  }
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="font-semibold text-slate-600">Replies:</span>
      <Badge tone={c.tone}><c.icon /> {c.label}</Badge>
      {account.replyCapture === 'webhook' && <span>{account.replyTo}</span>}
    </p>
  );
}

// ─── Dialog ───

export function RepliesDialog({account, onClose}: {account: EmailAccount; onClose: () => void}) {
  const {isAdmin} = useMe();
  const settings = useSettings();
  const webhookUrl = isAdmin ? (settings.data?.inboundWebhookUrl ?? '') : '';
  const [service, setService] = useState<Service>(account.provider === 'SMTP' || account.info.kind === 'oauth' ? 'RESEND' : (account.provider as Service));
  const [replyTo, setReplyTo] = useState(account.replyTo ?? '');
  const [forward, setForward] = useState(account.forwardReplies);
  const save = useApiMutation(() => api.patch<{account: EmailAccount}>(`/email/accounts/${account.id}`, {replyTo: replyTo.trim(), forwardReplies: forward}), {
    invalidate: [keys.email],
    success: 'Reply settings saved',
    onSuccess: onClose,
  });
  const testReply = useApiMutation(() => api.post<{contact: string; subject: string}>(`/email/accounts/${account.id}/test-reply`), {
    invalidate: [keys.email, keys.timeline],
    onSuccess: (r) => toast.success(`Test reply from ${r.contact} stored`, {description: `“${r.subject}” is in the inbox and on their timeline.`}),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <form onSubmit={(e) => (e.preventDefault(), save.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>How replies come back</DialogTitle>
            <DialogDescription>
              {account.fromEmail} · {account.info.label}. Outgoing emails carry a Reply-To header, so replies go to an inbound address that posts them to the CRM: they land on the
              contact's timeline and in the inbox, and the sender is notified.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <section className="grid gap-3 rounded-xl border border-slate-100 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-bold text-slate-900"><Webhook className="size-4 text-secondary" /> 1. Create an inbound address</p>
                <NativeSelect className="h-8 w-auto py-0 text-xs" value={service} onChange={(e) => setService(e.target.value as Service)} aria-label="Inbound service">
                  {SERVICES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </NativeSelect>
              </div>
              {account.provider === 'SMTP' && <p className="text-xs text-muted-foreground">Any of these works with SMTP sending; it only receives the replies.</p>}
              <WebhookGuide service={service} url={webhookUrl} />
              {webhookUrl && (
                <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => (navigator.clipboard.writeText(webhookUrl), toast.success('Copied'))}>
                  <Copy /> Copy webhook URL
                </Button>
              )}
            </section>

            <section className="grid gap-3 rounded-xl border border-slate-100 p-4">
              <p className="flex items-center gap-2 text-sm font-bold text-slate-900"><MessageSquareReply className="size-4 text-primary" /> 2. Use it as the reply-to address</p>
              <Field label="Reply-to address" htmlFor="r-to" hint="Leave empty to let replies go to the From address (the CRM won't see them).">
                <Input id="r-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="replies@inbound.yourdomain.com" />
              </Field>
              <label className="flex items-start gap-2.5 text-sm">
                <Switch checked={forward} onCheckedChange={setForward} disabled={!replyTo.trim()} className="mt-0.5" />
                <span>
                  <span className="font-semibold text-slate-800">Forward a copy of each reply to the sender's mailbox</span>
                  <span className="block text-xs text-muted-foreground">So reps still see replies in their own mail app. Reply-To on the copy is the contact.</span>
                </span>
              </label>
            </section>

            <section className="flex flex-col gap-3 rounded-xl bg-slate-50 p-4 sm:flex-row sm:items-center">
              <div className="flex-1">
                <p className="text-sm font-bold text-slate-900">3. Check it</p>
                <p className="text-xs text-muted-foreground">Stores a reply to your latest email from {account.fromEmail} through the same path as the webhook. Works before the URL is public.</p>
              </div>
              <Button type="button" variant="secondary" size="sm" disabled={testReply.isPending} onClick={() => testReply.mutate(undefined)}>
                {testReply.isPending ? <Loader2 className="animate-spin" /> : <MessageSquareReply />} Send a test reply
              </Button>
            </section>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
