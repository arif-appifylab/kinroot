import {createFileRoute} from '@tanstack/react-router';
import {Copy, Eye, FileText, LayoutTemplate, Loader2, Pencil, Plus, Sparkles, Trash2} from 'lucide-react';
import {useState} from 'react';

import {EmailPreview, RichEditor, Segmented} from '@/components/email-editor';
import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, Label} from '@/components/ui/form';
import {EmptyState} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {GALLERY, GALLERY_CATEGORIES, type GalleryTemplate} from '@/lib/email-gallery';
import {isEmptyHtml, mergeLabel, textToEditorHtml} from '@/lib/email-html';
import type {EmailLayout} from '@/lib/email-layout';
import {keys, useApiMutation, useMe, useTemplates} from '@/lib/queries';
import type {EmailTemplate} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/templates')({
  component: TemplateSettings,
});

/** "Hi {{contact.first_name|there}}" → "Hi [First name]" chips, so cards read like the email. */
function MergeText({text}: {text: string}) {
  const parts = text.split(/(\{\{\s*[a-z_.]+\s*(?:\|[^}]*)?\}\})/gi);
  return (
    <>
      {parts.map((part, i) => {
        const key = part.match(/^\{\{\s*([a-z_.]+)/i)?.[1];
        return key ? (
          <span key={i} className="rounded bg-primary/10 px-1 py-px text-[0.92em] font-semibold whitespace-nowrap text-primary">{mergeLabel(key.toLowerCase())}</span>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

const LAYOUTS: {value: EmailLayout; label: string}[] = [
  {value: 'plain', label: 'Plain'},
  {value: 'branded', label: 'Branded'},
];

function TemplateDialog({template, onClose}: {template: EmailTemplate | null; onClose: () => void}) {
  const [form, setForm] = useState({
    name: template?.name ?? '',
    subject: template?.subject ?? '',
    preheader: template?.preheader ?? '',
    html: template ? template.html || textToEditorHtml(template.body) : '',
    layout: (template?.layout === 'branded' ? 'branded' : 'plain') as EmailLayout,
    shared: template?.shared ?? true,
  });
  const save = useApiMutation(
    () => {
      const body = {...form, preheader: form.preheader || null};
      return template ? api.patch(`/email/templates/${template.id}`, body) : api.post('/email/templates', body);
    },
    {invalidate: [keys.email], success: 'Template saved', onSuccess: onClose},
  );
  const empty = isEmptyHtml(form.html);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <form onSubmit={(e) => (e.preventDefault(), !empty && save.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{template ? 'Edit template' : 'New template'}</DialogTitle>
            <DialogDescription>Merge fields fill in per recipient; add a fallback for empty values. The preview uses sample data.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid-cols-1 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Template name" htmlFor="tp-name"><Input id="tp-name" required value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} /></Field>
                <Field label="Layout" hint={form.layout === 'branded' ? 'Header, footer and unsubscribe link' : 'Looks like a personal email'}>
                  <Segmented label="Layout" value={form.layout} onChange={(layout) => setForm({...form, layout})} options={LAYOUTS} />
                </Field>
              </div>
              <Field label="Subject" htmlFor="tp-subject"><Input id="tp-subject" required value={form.subject} onChange={(e) => setForm({...form, subject: e.target.value})} placeholder="e.g. Great speaking with you, {{contact.first_name|there}}" /></Field>
              <Field label="Preview text" htmlFor="tp-pre" hint="Shown after the subject in most inboxes."><Input id="tp-pre" value={form.preheader} maxLength={300} onChange={(e) => setForm({...form, preheader: e.target.value})} /></Field>
              <Field label="Message">
                <RichEditor value={form.html} onChange={(html) => setForm((f) => ({...f, html}))} minHeight={320} />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="tp-shared" checked={form.shared} onCheckedChange={(v) => setForm({...form, shared: v === true})} />
                <Label htmlFor="tp-shared" className="font-medium">Share with the team</Label>
              </div>
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-sm font-semibold text-slate-700">Live preview</p>
              <EmailPreview html={form.html} subject={form.subject} preheader={form.preheader} layout={form.layout} height={560} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || empty}>{save.isPending && <Loader2 className="animate-spin" />} Save template</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GalleryPreview({template, onClose, onUse, busy}: {template: GalleryTemplate; onClose: () => void; onUse: () => void; busy: boolean}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{template.description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <EmailPreview html={template.html} subject={template.subject} preheader={template.preheader} layout={template.layout} height={480} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={onUse} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Copy />} Use this template</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Gallery({onCreated}: {onCreated: (t: EmailTemplate) => void}) {
  const [category, setCategory] = useState<string>('All');
  const [previewing, setPreviewing] = useState<GalleryTemplate | null>(null);
  const use = useApiMutation((id: string) => api.post<{template: EmailTemplate}>(`/email/templates/gallery/${id}`), {
    invalidate: [keys.email],
    success: 'Added to your templates',
    onSuccess: ({template}) => (setPreviewing(null), onCreated(template)),
  });
  const shown = category === 'All' ? GALLERY : GALLERY.filter((g) => g.category === category);

  return (
    <SettingsSection title="Template gallery" description="Well-written starting points. Using one copies it into your templates, ready to adjust.">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {['All', ...GALLERY_CATEGORIES].map((c) => (
          <button key={c} type="button" onClick={() => setCategory(c)} className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-colors', category === c ? 'border-primary bg-accent text-primary' : 'border-border text-slate-600 hover:border-slate-300')}>
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((g) => (
          <div key={g.id} className="group flex flex-col rounded-xl border border-slate-100 bg-card p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-lift">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-bold text-slate-900">{g.name}</p>
              <Badge tone={g.layout === 'branded' ? 'teal' : 'outline'}>{g.layout === 'branded' ? 'Branded' : 'Plain'}</Badge>
            </div>
            <p className="mt-1 flex-1 text-xs text-muted-foreground">{g.description}</p>
            <p className="mt-2 truncate text-xs font-medium text-slate-600"><MergeText text={g.subject} /></p>
            <div className="mt-3 flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setPreviewing(g)}><Eye /> Preview</Button>
              <Button variant="soft" size="sm" onClick={() => use.mutate(g.id)} disabled={use.isPending}><Copy /> Use</Button>
            </div>
          </div>
        ))}
      </div>
      {previewing && <GalleryPreview template={previewing} onClose={() => setPreviewing(null)} onUse={() => use.mutate(previewing.id)} busy={use.isPending} />}
    </SettingsSection>
  );
}

function TemplateSettings() {
  const {me, isAdmin} = useMe();
  const templates = useTemplates();
  const [editing, setEditing] = useState<EmailTemplate | null | 'new'>(null);
  const remove = useApiMutation((id: string) => api.del(`/email/templates/${id}`), {invalidate: [keys.email], success: 'Template deleted'});

  return (
    <div>
      <SettingsSection title="Email templates" description="Reusable emails with merge fields, available in every composer." actions={<Button size="sm" onClick={() => setEditing('new')}><Plus /> New template</Button>}>
        {templates.data?.length === 0 && <EmptyState icon={<FileText />} title="No templates yet" description="Start from the gallery below or write your own." />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {templates.data?.map((t) => (
            <div key={t.id} className="group rounded-xl border border-slate-100 bg-card p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-lift">
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-bold text-slate-900">{t.html ? <Sparkles className="size-3.5 text-primary" /> : <LayoutTemplate className="size-3.5 text-slate-400" />}{t.name}</p>
                <div className="flex gap-1">
                  {t.layout === 'branded' && <Badge tone="teal">Branded</Badge>}
                  {!t.shared && <Badge tone="outline">Private</Badge>}
                </div>
              </div>
              <p className="mt-1 truncate text-xs font-medium text-slate-600"><MergeText text={t.subject} /></p>
              <p className="mt-2 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground"><MergeText text={t.body} /></p>
              {(t.ownerId === me.id || isAdmin) && (
                <div className="mt-3 flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(t)}><Pencil /> Edit</Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-rose-50 hover:text-destructive" onClick={async () => (await confirm({title: `Delete "${t.name}"?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(t.id)}><Trash2 /> Delete</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
      <Gallery onCreated={(t) => setEditing(t)} />
      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
