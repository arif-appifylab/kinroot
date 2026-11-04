import {Link} from '@tanstack/react-router';
import {Eye, FileText, Send} from 'lucide-react';
import {useEffect, useId, useState} from 'react';

import {api, ApiError} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import type {EmailLayout} from '@/lib/email-layout';
import {recordKeys, useApiMutation, useEmailAccounts, useTemplates} from '@/lib/queries';

import {EmailPreview, RichEditor, Segmented} from './email-editor';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle} from './ui/dialog';
import {Field, Input, NativeSelect} from './ui/form';
import {is, useFormState} from './ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from './ui/menu';

const splitEmails = (v: string) => v.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Every address in a comma-separated list is valid (and at most 50). */
const emailList = (v: string) => {
  const list = splitEmails(v);
  const bad = list.find((x) => !EMAIL.test(x));
  if (bad) return `"${bad}" isn't a valid email address. Separate addresses with commas.`;
  return list.length > 50 ? 'Send to at most 50 addresses.' : null;
};
/** The server names list errors `to.0`, `cc.2`…: they belong on the list's field. */
const listFields = (e: unknown) =>
  e instanceof ApiError ? new ApiError(e.message, e.status, Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/\.\d+$/, ''), v]))) : e;
const inlineLabel = 'pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-slate-500';

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

  const uid = useId();
  const f = useFormState(
    {to, cc, subject, preheader},
    {
      to: [is.required('Add at least one recipient, like name@company.com.'), emailList],
      cc: [(v) => (showCc ? emailList(v) : null)],
      subject: context.threadId ? [] : [is.required('Add a subject.'), is.maxLength(500)],
      preheader: [is.maxLength(300)],
    },
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
    <form {...f.form(() => !empty && !send.isPending && send.mutate(undefined, {onError: (e) => f.fail(listFields(e))}))} className="grid gap-2.5">
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <Field htmlFor={`${uid}-to`} error={f.error('to')}>
          <div className="relative">
            <label htmlFor={`${uid}-to`} className={inlineLabel}>To</label>
            <Input id={`${uid}-to`} value={to} onChange={(e) => setTo(e.target.value)} onBlur={f.blur('to')} placeholder="name@company.com" className="pr-12 pl-10" />
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)} className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer rounded text-xs font-semibold text-slate-400 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30" aria-label="Add Cc">Cc</button>
            )}
          </div>
        </Field>
        {(accounts.data?.length ?? 0) > 1 && (
          <NativeSelect aria-label="Send from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="min-w-0">
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.fromEmail}</option>)}
          </NativeSelect>
        )}
      </div>
      {showCc && (
        <Field htmlFor={`${uid}-cc`} error={f.error('cc')}>
          <div className="relative">
            <label htmlFor={`${uid}-cc`} className={inlineLabel}>Cc</label>
            <Input id={`${uid}-cc`} value={cc} onChange={(e) => setCc(e.target.value)} onBlur={f.blur('cc')} placeholder="name@company.com" className="pl-10" />
          </div>
        </Field>
      )}
      {!context.threadId && (
        <Field htmlFor={`${uid}-subject`} error={f.error('subject')}>
          <div className="relative">
            <label htmlFor={`${uid}-subject`} className={inlineLabel}>Subject</label>
            <Input id={`${uid}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={f.blur('subject')} className="pl-[4.25rem]" />
          </div>
        </Field>
      )}
      {layout === 'branded' && (
        <Field htmlFor={`${uid}-preheader`} error={f.error('preheader')}>
          <Input id={`${uid}-preheader`} aria-label="Preview text" value={preheader} onChange={(e) => setPreheader(e.target.value)} onBlur={f.blur('preheader')} placeholder="Preview text (shown next to the subject in the inbox)" maxLength={300} />
        </Field>
      )}
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
        <Button type="submit" size="sm" className="ml-auto" disabled={!accountId || empty} pending={send.isPending} pendingLabel="Sending…">
          <Send /> Send
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
