import {Link} from '@tanstack/react-router';
import {Eye, FileText, Loader2, Send} from 'lucide-react';
import {useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import type {EmailLayout} from '@/lib/email-layout';
import {recordKeys, useApiMutation, useEmailAccounts, useTemplates} from '@/lib/queries';

import {EmailPreview, RichEditor, Segmented} from './email-editor';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle} from './ui/dialog';
import {Input, NativeSelect} from './ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from './ui/menu';

const splitEmails = (v: string) => v.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

export type ComposerContext = {contactId?: string | null; companyId?: string | null; dealId?: string | null; threadId?: string};

export function EmailComposer({to: initialTo = [], subject: initialSubject = '', context, onSent, compact}: {to?: string[]; subject?: string; context: ComposerContext; onSent?: () => void; compact?: boolean}) {
  const accounts = useEmailAccounts();
  const templates = useTemplates();
  const [accountId, setAccountId] = useState('');
  const [to, setTo] = useState(initialTo.join(', '));
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [html, setHtml] = useState('');
  const [preheader, setPreheader] = useState('');
  // One-to-one sales emails look personal by default; templates can ask for the branded layout.
  const [layout, setLayout] = useState<EmailLayout>('plain');
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!accountId && accounts.data?.length) setAccountId((accounts.data.find((a) => a.isDefault) ?? accounts.data[0])!.id);
  }, [accounts.data, accountId]);
  useEffect(() => setTo(initialTo.join(', ')), [initialTo.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const account = accounts.data?.find((a) => a.id === accountId);
  const send = useApiMutation(
    () => api.post('/email/send', {accountId, to: splitEmails(to), cc: showCc ? splitEmails(cc) : undefined, subject, html, layout, preheader: preheader || null, ...context}),
    {invalidate: recordKeys, success: 'Email sent', onSuccess: () => (setHtml(''), setPreheader(''), !context.threadId && setSubject(''), onSent?.())},
  );

  if (accounts.isSuccess && !accounts.data.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-5 text-center">
        <p className="text-sm font-semibold text-slate-800">Connect an email account to start sending</p>
        <p className="mt-1 text-xs text-muted-foreground">Resend, Postmark, SendGrid, Mailgun, Gmail or Outlook.</p>
        <Button asChild size="sm" className="mt-3">
          <Link to="/settings/email">Connect email</Link>
        </Button>
      </div>
    );
  }

  const empty = isEmptyHtml(html);

  return (
    <form onSubmit={(e) => (e.preventDefault(), !empty && send.mutate(undefined))} className="grid gap-2.5">
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="relative">
          <Input aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" className="pr-12" required />
          {!showCc && (
            <button type="button" onClick={() => setShowCc(true)} className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer text-xs font-semibold text-slate-400 hover:text-primary">Cc</button>
          )}
        </div>
        {(accounts.data?.length ?? 0) > 1 && (
          <NativeSelect aria-label="Send from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="min-w-0">
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.fromEmail}</option>)}
          </NativeSelect>
        )}
      </div>
      {showCc && <Input aria-label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Cc" />}
      {!context.threadId && <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" required />}
      {layout === 'branded' && <Input aria-label="Preview text" value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="Preview text (shown next to the subject in the inbox)" maxLength={300} />}
      <RichEditor value={html} onChange={setHtml} compact={compact} placeholder="Write your message… add a merge field from the toolbar" />
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="sm"><FileText /> Templates</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Insert a template</DropdownMenuLabel>
            {templates.data?.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => {
                  if (!context.threadId) setSubject(t.subject);
                  setHtml(t.html || textToEditorHtml(t.body));
                  setPreheader(t.preheader ?? '');
                  setLayout(t.layout === 'branded' ? 'branded' : 'plain');
                }}
              >
                <span className="truncate">{t.name}</span>
              </DropdownMenuItem>
            ))}
            {!templates.data?.length && <p className="px-2.5 py-2 text-sm text-muted-foreground">No templates yet</p>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Segmented
          label="Email layout"
          value={layout}
          onChange={setLayout}
          options={[
            {value: 'plain', label: 'Plain'},
            {value: 'branded', label: 'Branded'},
          ]}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewing(true)} disabled={empty}><Eye /> Preview</Button>
        <Button type="submit" size="sm" className="ml-auto" disabled={send.isPending || !accountId || empty}>
          {send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send
        </Button>
      </div>
      {previewing && (
        <Dialog open onOpenChange={(o) => !o && setPreviewing(false)}>
          <DialogContent size="lg">
            <DialogHeader><DialogTitle>Preview</DialogTitle></DialogHeader>
            <DialogBody>
              <EmailPreview html={html} subject={context.threadId ? initialSubject : subject} preheader={layout === 'branded' ? preheader : null} layout={layout} signatureHtml={account?.signatureHtml || (account?.signature ? textToEditorHtml(account.signature) : null)} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </form>
  );
}
