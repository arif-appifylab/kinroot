import {useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, Check, CloudOff, ExternalLink, Eye, Loader2, Monitor, Smartphone} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {FormBuilder} from '@/components/forms/builder';
import {FormSettingsPanel} from '@/components/forms/form-settings';
import {FormRenderer} from '@/components/forms/renderer';
import {ResultsPanel} from '@/components/forms/results';
import {SharePanel} from '@/components/forms/share';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {toPublicForm, type FormField, type FormSettings} from '@/lib/forms';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {FormDetail, FormStatus} from '@/lib/types';
import {cn} from '@/lib/utils';

const TABS = ['build', 'settings', 'share', 'results'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/forms/$formId')({
  validateSearch: z.object({tab: z.enum(TABS).optional()}),
  head: () => ({meta: [{title: pageTitle('Form')}]}),
  component: FormPage,
});

const STATUS: Record<FormStatus, {label: string; tone: 'green' | 'neutral' | 'amber'}> = {
  PUBLISHED: {label: 'Live', tone: 'green'},
  DRAFT: {label: 'Draft', tone: 'neutral'},
  CLOSED: {label: 'Closed', tone: 'amber'},
};

type Draft = {name: string; fields: FormField[]; settings: FormSettings};

function FormPage() {
  const {formId} = Route.useParams();
  const {tab = 'build'} = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {canEdit} = useMe();
  const q = useQuery({queryKey: [...keys.forms, formId], queryFn: () => api.get<{form: FormDetail}>(`/forms/${formId}`), select: (d) => d.form});
  const form = q.data;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [preview, setPreview] = useState(false);
  const saved = useRef('');

  useEffect(() => {
    if (form && !draft) {
      const d = {name: form.name, fields: form.fields, settings: form.settings};
      saved.current = JSON.stringify(d);
      setDraft(d);
    }
  }, [form, draft]);

  // Autosave: 700 ms after the last change.
  useEffect(() => {
    if (!draft || !canEdit) return;
    const json = JSON.stringify(draft);
    if (json === saved.current) return;
    setSaveState('saving');
    const t = setTimeout(async () => {
      try {
        await api.patch(`/forms/${formId}`, draft);
        saved.current = json;
        setSaveState('saved');
        qc.invalidateQueries({queryKey: keys.forms, exact: true});
      } catch (e) {
        setSaveState('error');
        toast.error((e as Error).message);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [draft, formId, canEdit, qc]);

  // Don't lose an edit that hasn't been saved yet.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (draft && JSON.stringify(draft) !== saved.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);

  const status = useApiMutation((next: FormStatus) => api.post(`/forms/${formId}/status`, {status: next}), {
    invalidate: [keys.forms],
    success: (r) => ((r as {form: {status: FormStatus}}).form.status === 'PUBLISHED' ? 'Form is live' : 'Form saved'),
  });
  const slug = useApiMutation((s: string) => api.patch(`/forms/${formId}`, {slug: s}), {invalidate: [keys.forms], success: 'Link updated'});

  if (q.isLoading || !form || !draft) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[480px]" />
      </div>
    );
  }

  const setTab = (t: Tab) => navigate({to: '/forms/$formId', params: {formId}, search: t === 'build' ? {} : {tab: t}, replace: true});
  const st = STATUS[form.status];
  const publicPreview = toPublicForm({id: form.id, slug: form.slug, name: draft.name, fields: draft.fields, settings: draft.settings}, {turnstileSiteKey: null, closed: null});

  async function publish() {
    // Flush pending edits first so the live form is what you see.
    if (JSON.stringify(draft) !== saved.current) {
      await api.patch(`/forms/${formId}`, draft);
      saved.current = JSON.stringify(draft);
      setSaveState('saved');
    }
    status.mutate('PUBLISHED');
  }

  return (
    <div>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/forms" aria-label="Back to forms"><ArrowLeft /></Link>
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <input
                value={draft.name}
                onChange={(e) => setDraft({...draft, name: e.target.value})}
                onBlur={() => !draft.name.trim() && setDraft({...draft, name: form.name})}
                disabled={!canEdit}
                aria-label="Form name"
                className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 text-2xl font-extrabold tracking-tight text-slate-900 outline-none hover:bg-slate-100/70 focus:bg-card focus:ring-2 focus:ring-primary/30"
              />
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              {saveState === 'saving' && <><Loader2 className="size-3 animate-spin" /> Saving…</>}
              {saveState === 'saved' && <><Check className="size-3 text-emerald-500" /> All changes saved{form.status === 'PUBLISHED' && ' · live form updated'}</>}
              {saveState === 'error' && <><CloudOff className="size-3 text-destructive" /> Not saved, check the last change</>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setPreview(true)}><Eye /> Preview</Button>
          {form.status === 'PUBLISHED' && (
            <Button variant="secondary" asChild><a href={`/f/${form.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open</a></Button>
          )}
          {canEdit &&
            (form.status === 'PUBLISHED' ? (
              <Button variant="secondary" onClick={async () => (await confirm({title: 'Close this form?', description: 'The link stays but stops accepting responses.', confirmLabel: 'Close form'})) && status.mutate('CLOSED')}>Close form</Button>
            ) : (
              <Button onClick={publish} disabled={status.isPending}>{status.isPending && <Loader2 className="animate-spin" />} {form.status === 'CLOSED' ? 'Reopen' : 'Publish'}</Button>
            ))}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="share">Share</TabsTrigger>
          <TabsTrigger value="results">Results{form.submissionCount ? ` · ${form.submissionCount}` : ''}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className={cn(!canEdit && tab !== 'results' && tab !== 'share' && 'pointer-events-none opacity-80')}>
        {tab === 'build' && <FormBuilder fields={draft.fields} settings={draft.settings} onFields={(fields) => setDraft({...draft, fields})} onSettings={(settings) => setDraft({...draft, settings})} />}
        {tab === 'settings' && <FormSettingsPanel fields={draft.fields} settings={draft.settings} onChange={(settings) => setDraft({...draft, settings})} slug={form.slug} onSlug={(s) => slug.mutate(s)} />}
        {tab === 'share' && <SharePanel slug={form.slug} status={form.status} onPublish={publish} />}
        {tab === 'results' && <ResultsPanel formId={form.id} fields={draft.fields} />}
      </div>

      {preview && <PreviewDialog form={publicPreview} onClose={() => setPreview(false)} />}
    </div>
  );
}

function PreviewDialog({form, onClose}: {form: ReturnType<typeof toPublicForm>; onClose: () => void}) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader className="flex flex-wrap items-center justify-between gap-3">
          <DialogTitle>Preview</DialogTitle>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
            {(['desktop', 'mobile'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={cn('flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold', device === d ? 'bg-card text-slate-900 shadow-soft' : 'text-slate-500')}
              >
                {d === 'desktop' ? <Monitor className="size-3.5" /> : <Smartphone className="size-3.5" />} {d === 'desktop' ? 'Desktop' : 'Mobile'}
              </button>
            ))}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 scrollbar-thin @xl:p-8">
          <div className={cn('mx-auto rounded-2xl border border-slate-100 bg-card p-6 shadow-soft transition-all sm:p-8', device === 'mobile' ? 'max-w-[380px]' : 'max-w-2xl')}>
            <FormRenderer form={form} mode="preview" />
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground">Preview only: nothing is saved and uploads are off.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
