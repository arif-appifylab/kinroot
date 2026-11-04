/**
 * Settings → Email: the branded layout ("Email design") and per-account
 * HTML signatures with images.
 */
import {ImagePlus, Palette} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {GALLERY} from '@/lib/email-gallery';
import {textToEditorHtml} from '@/lib/email-html';
import {DEFAULT_EMAIL_DESIGN, type EmailDesign} from '@/lib/email-layout';
import {keys, useApiMutation, useEmailDesign} from '@/lib/queries';
import type {EmailAccount} from '@/lib/types';

import {EmailPreview, RichEditor, Segmented, uploadEmailImage} from './email-editor';
import {SettingsSection} from './settings-section';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Field, Input, Switch, Textarea} from './ui/form';
import {is, useFormState} from './ui/form-state';
import {LoadError} from './data-table';

const SAMPLE = GALLERY.find((g) => g.id === 'welcome-onboarding')!;

/** Same rule as the server (PUT /email/design): `#rrggbb`, or empty for the brand colour. */
const HEX = is.pattern(/^#[0-9a-f]{6}$/i, 'Enter a colour like #2563eb, or Reset to use the brand colour.');

function ColorField({id, label, value, onChange, fallback, error, onBlur}: {id: string; label: string; value: string; onChange: (v: string) => void; fallback: string; error?: string; onBlur?: () => void}) {
  return (
    <Field label={label} htmlFor={id} hint={value ? undefined : 'Brand colour'} error={error}>
      <div className="flex gap-2">
        <input type="color" aria-label={`${label} picker`} value={value || fallback} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-card p-1" />
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={fallback} className="font-mono text-xs" />
        {value && <Button type="button" variant="ghost" size="sm" className="h-10" onClick={() => onChange('')}>Reset</Button>}
      </div>
    </Field>
  );
}

/** Admin: header logo and colours, footer company details, unsubscribe options, with a live preview. */
export function EmailDesignSection() {
  const q = useEmailDesign();
  const [design, setDesign] = useState<EmailDesign>(DEFAULT_EMAIL_DESIGN);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (q.data) setDesign(q.data.design);
  }, [q.data]);
  const save = useApiMutation(() => api.put('/email/design', design), {invalidate: [keys.emailDesign], success: 'Email design saved'});
  const f = useFormState(design, {
    headerColor: [HEX],
    accentColor: [HEX],
    companyName: [is.maxLength(120)],
    address: [is.maxLength(500)],
    footerText: [is.maxLength(1000)],
  });
  const set = (patch: Partial<EmailDesign>) => setDesign((d) => ({...d, ...patch}));
  const primary = q.data?.brand.primary || '#2563eb';
  const brandLogoUsable = !!q.data?.brand.logoSrc;

  const onFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      set({logo: 'upload', logoUrl: await uploadEmailImage(file)});
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <SettingsSection
      title="Email design"
      description="The branded layout: a fixed header and footer wrapped around branded templates, the form autoresponder and any email sent with the Branded layout."
      actions={<Button type="submit" form="email-design-form" size="sm" disabled={!q.data} pending={save.isPending} pendingLabel="Saving…"><Palette /> Save design</Button>}
    >
      {q.isError && !q.data && <LoadError error={q.error} onRetry={() => q.refetch()} />}
      <form id="email-design-form" {...f.form(() => !save.isPending && save.mutate(undefined, {onError: f.fail}))} className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <p className="text-xs font-bold tracking-wide text-slate-400 uppercase">Header</p>
          <Field label="Logo" group>
            <Segmented
              label="Header logo"
              value={design.logo}
              onChange={(logo) => set({logo})}
              options={[
                {value: 'brand', label: 'Brand logo'},
                {value: 'upload', label: 'Upload'},
                {value: 'none', label: 'Name only'},
              ]}
            />
          </Field>
          {design.logo === 'brand' && !brandLogoUsable && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">No PNG, JPEG or WebP logo in Settings → General → Branding (SVG doesn't show in most mail clients), so the header shows the brand name. Upload an image here instead.</p>
          )}
          {design.logo === 'upload' && (
            <div className="flex flex-wrap items-center gap-3">
              {design.logoUrl && <img src={design.logoUrl} alt="" className="h-10 max-w-40 rounded border border-slate-100 bg-white object-contain p-1" />}
              <Button type="button" variant="secondary" size="sm" pending={uploading} pendingLabel="Uploading…" onClick={() => fileRef.current?.click()}>
                <ImagePlus /> {design.logoUrl ? 'Replace image' : 'Upload image'}
              </Button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
          )}
          {design.logo !== 'none' && (
            <Field label={`Logo width: ${design.logoWidth}px`} htmlFor="d-width">
              <input id="d-width" type="range" min={40} max={280} step={10} value={design.logoWidth} onChange={(e) => set({logoWidth: Number(e.target.value)})} className="accent-primary" />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ColorField id="d-header" label="Header colour" value={design.headerColor} onChange={(headerColor) => set({headerColor})} fallback={primary} error={f.error('headerColor')} onBlur={f.blur('headerColor')} />
            <ColorField id="d-accent" label="Buttons & links" value={design.accentColor} onChange={(accentColor) => set({accentColor})} fallback={primary} error={f.error('accentColor')} onBlur={f.blur('accentColor')} />
          </div>
          <p className="pt-2 text-xs font-bold tracking-wide text-slate-400 uppercase">Footer</p>
          <Field label="Company name" htmlFor="d-company" error={f.error('companyName')}><Input id="d-company" value={design.companyName} onChange={(e) => set({companyName: e.target.value})} onBlur={f.blur('companyName')} placeholder={q.data?.brand.name} /></Field>
          <Field label="Postal address" htmlFor="d-address" error={f.error('address')} hint="Anti-spam laws (CAN-SPAM, GDPR guidance) expect a physical address in marketing email.">
            <Textarea id="d-address" rows={2} value={design.address} onChange={(e) => set({address: e.target.value})} onBlur={f.blur('address')} placeholder={'123 Market Street, Suite 4\nSan Francisco, CA 94105'} />
          </Field>
          <Field label="Footer text" htmlFor="d-footer" error={f.error('footerText')}><Textarea id="d-footer" rows={2} value={design.footerText} onChange={(e) => set({footerText: e.target.value})} onBlur={f.blur('footerText')} placeholder="You're receiving this because you're a customer or asked to hear from us." /></Field>
          <p className="text-xs text-muted-foreground">The unsubscribe link is always part of the branded footer.</p>
          <label className="flex items-start gap-2.5 text-sm">
            <Switch checked={design.plainUnsubscribe} onCheckedChange={(plainUnsubscribe) => set({plainUnsubscribe})} className="mt-0.5" />
            <span>
              <span className="font-semibold text-slate-800">Add an unsubscribe line to plain emails</span>
              <span className="block text-xs text-muted-foreground">Plain (one-to-one) emails normally look like a personal message, without a footer.</span>
            </span>
          </label>
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-sm font-semibold text-slate-700">Preview</p>
          <EmailPreview html={SAMPLE.html} subject={SAMPLE.subject} preheader={SAMPLE.preheader} layout="branded" design={design} height={600} />
        </div>
      </form>
    </SettingsSection>
  );
}

/** Per-account HTML signature with images (logo / headshot) and size control. */
export function SignatureDialog({account, onClose}: {account: EmailAccount; onClose: () => void}) {
  const [html, setHtml] = useState(account.signatureHtml || (account.signature ? textToEditorHtml(account.signature) : ''));
  const save = useApiMutation(() => api.patch(`/email/accounts/${account.id}`, html ? {signatureHtml: html} : {signatureHtml: null, signature: null}), {invalidate: [keys.email], success: 'Signature saved', onSuccess: onClose});
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <form noValidate onSubmit={(e) => (e.preventDefault(), !save.isPending && save.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Signature for {account.fromEmail}</DialogTitle>
            <DialogDescription>Added below every email sent from this account. Insert a logo or headshot with the image button, then pick a size.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid-cols-1 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              <RichEditor value={html} onChange={setHtml} compact minHeight={220} placeholder="Your name, title, phone… and a logo or headshot" ariaLabel="Signature" />
              {account.signature && !account.signatureHtml && <p className="text-xs text-muted-foreground">Started from your plain-text signature. Saving replaces it in new emails.</p>}
            </div>
            <div className="min-w-0">
              <EmailPreview html={'<p>Hi <span data-merge="contact.first_name" data-fallback="there"></span>,</p><p>Thanks for your time today.</p>'} signatureHtml={html} layout="plain" height={360} />
            </div>
          </DialogBody>
          <DialogFooter>
            {account.signatureHtml && <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setHtml('')}>Remove signature</Button>}
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save signature</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
