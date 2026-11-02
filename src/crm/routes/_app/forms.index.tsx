import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ClipboardList, Copy, ExternalLink, Loader2, MoreHorizontal, Plus, Trash2} from 'lucide-react';
import {useState} from 'react';

import {Badge} from '@/components/ui/badge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, PageHeader} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {FORM_TEMPLATES} from '@/lib/forms';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {FormRow, FormStatus} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/forms/')({
  head: () => ({meta: [{title: pageTitle('Forms')}]}),
  component: FormsPage,
});

const STATUS: Record<FormStatus, {label: string; tone: 'green' | 'neutral' | 'amber'}> = {
  PUBLISHED: {label: 'Live', tone: 'green'},
  DRAFT: {label: 'Draft', tone: 'neutral'},
  CLOSED: {label: 'Closed', tone: 'amber'},
};

// Capped: API or test submissions can outnumber counted views.
const pct = (a: number, b: number) => (b ? `${Math.min(100, Math.round((a / b) * 100))}%` : '—');

function FormsPage() {
  const {canEdit} = useMe();
  const [creating, setCreating] = useState(false);
  const list = useQuery({queryKey: keys.forms, queryFn: () => api.get<{rows: FormRow[]}>('/forms'), select: (d) => d.rows});
  const rows = list.data ?? [];

  return (
    <div>
      <PageHeader
        title="Forms"
        description="Capture leads from your website: every response creates or updates a contact."
        actions={canEdit && <Button onClick={() => setCreating(true)}><Plus /> New form</Button>}
      />
      {list.isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>}
      {!list.isLoading && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<ClipboardList />}
            title="No forms yet"
            description="Start from a template like Contact us or Demo request, share the link or embed it on your site."
            action={canEdit && <Button onClick={() => setCreating(true)}><Plus /> Create your first form</Button>}
          />
        </Card>
      )}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-4 py-3">Form</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Views</th>
                  <th className="px-4 py-3 text-right">Responses</th>
                  <th className="px-4 py-3 text-right">Conversion</th>
                  <th className="px-4 py-3">Last response</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((f) => <FormRowItem key={f.id} form={f} />)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {creating && <NewFormDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function FormRowItem({form: f}: {form: FormRow}) {
  const navigate = useNavigate();
  const {canEdit} = useMe();
  const duplicate = useApiMutation(() => api.post<{form: {id: string}}>(`/forms/${f.id}/duplicate`), {
    invalidate: [keys.forms],
    success: 'Form duplicated',
    onSuccess: (r) => navigate({to: '/forms/$formId', params: {formId: r.form.id}}),
  });
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/forms/${f.id}`), {invalidate: [keys.forms, keys.recycleBin], onSuccess: (r) => binToast('Form', r.binId, {reopen: false})});
  const st = STATUS[f.status];
  return (
    <tr className="group hover:bg-slate-50/70">
      <td className="px-4 py-3">
        <Link to="/forms/$formId" params={{formId: f.id}} className="font-semibold text-slate-900 hover:text-primary">{f.name}</Link>
        <p className="text-xs text-muted-foreground">/f/{f.slug} · edited {ago(f.updatedAt)}</p>
      </td>
      <td className="px-4 py-3"><Badge tone={st.tone}>{st.label}</Badge></td>
      <td className="px-4 py-3 text-right tabular-nums">{f.views.toLocaleString()}</td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">
        <Link to="/forms/$formId" params={{formId: f.id}} search={{tab: 'results'}} className="hover:text-primary">{f.submissionCount.toLocaleString()}</Link>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{pct(f.submissionCount, f.views)}</td>
      <td className="px-4 py-3 text-muted-foreground">{f.lastSubmissionAt ? ago(f.lastSubmissionAt) : '—'}</td>
      <td className="px-2 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Options for ${f.name}`}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {f.status === 'PUBLISHED' && (
              <DropdownMenuItem asChild>
                <a href={`/f/${f.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open form</a>
              </DropdownMenuItem>
            )}
            {canEdit && <DropdownMenuItem onSelect={() => duplicate.mutate(undefined)}><Copy /> Duplicate</DropdownMenuItem>}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${f.name}" and its ${f.submissionCount} responses?`, description: `Contacts stay. The form can be restored from the recycle bin for 30 days.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function NewFormDialog({onClose}: {onClose: () => void}) {
  const navigate = useNavigate();
  const [template, setTemplate] = useState('contact');
  const [name, setName] = useState('Contact us');
  const [touched, setTouched] = useState(false);
  const create = useApiMutation(() => api.post<{form: {id: string}}>('/forms', {name: name.trim(), templateId: template}), {
    invalidate: [keys.forms],
    onSuccess: (r) => navigate({to: '/forms/$formId', params: {formId: r.form.id}}),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form onSubmit={(e) => (e.preventDefault(), name.trim() && create.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New form</DialogTitle>
            <DialogDescription>Pick a starting point. You can change every question afterwards.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FORM_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTemplate(t.id);
                    if (!touched) setName(t.id === 'blank' ? 'Untitled form' : t.name);
                  }}
                  className={cn(
                    'cursor-pointer rounded-xl border p-3 text-left transition-all',
                    template === t.id ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-slate-200 hover:border-primary/50',
                  )}
                >
                  <p className="text-sm font-semibold text-slate-900">{t.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
                </button>
              ))}
            </div>
            <Field label="Form name">
              <Input value={name} onChange={(e) => (setName(e.target.value), setTouched(true))} maxLength={120} required />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />} Create form
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
