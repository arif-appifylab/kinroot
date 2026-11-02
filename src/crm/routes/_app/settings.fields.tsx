import {createFileRoute} from '@tanstack/react-router';
import {Loader2, Plus, Trash2} from 'lucide-react';
import {useState} from 'react';

import {TagInput} from '@/components/pickers';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {keys, useApiMutation, useFields, useMe} from '@/lib/queries';
import type {EntityType, FieldType} from '@/lib/types';

export const Route = createFileRoute('/_app/settings/fields')({
  component: FieldSettings,
});

const TYPES: Record<FieldType, string> = {
  TEXT: 'Text',
  NUMBER: 'Number',
  CURRENCY: 'Money',
  DATE: 'Date',
  SELECT: 'Single choice',
  MULTISELECT: 'Multiple choice',
  URL: 'Link',
  CHECKBOX: 'Yes / no',
};

function FieldSettings() {
  const {isAdmin} = useMe();
  const [entity, setEntity] = useState<EntityType>('CONTACT');
  const fields = useFields(entity);
  const [draft, setDraft] = useState({label: '', type: 'TEXT' as FieldType, options: [] as string[]});
  const create = useApiMutation(() => api.post('/fields', {...draft, entity}), {invalidate: [keys.fields(entity)], success: 'Field added', onSuccess: () => setDraft({label: '', type: 'TEXT', options: []})});
  const remove = useApiMutation((id: string) => api.del(`/fields/${id}`), {invalidate: [keys.fields(entity)], success: 'Field removed'});
  const needsOptions = draft.type === 'SELECT' || draft.type === 'MULTISELECT';

  return (
    <div>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <Tabs value={entity} onValueChange={(v) => setEntity(v as EntityType)} className="mb-5">
        <TabsList>
          <TabsTrigger value="CONTACT">Contacts</TabsTrigger>
          <TabsTrigger value="COMPANY">Companies</TabsTrigger>
          <TabsTrigger value="DEAL">Deals</TabsTrigger>
        </TabsList>
      </Tabs>
      <SettingsSection title="Custom fields" description="Extra properties shown on records, forms and CSV exports.">
        <div className="divide-y divide-slate-100">
          {fields.data?.length === 0 && <p className="pb-2 text-sm text-muted-foreground">No custom fields yet.</p>}
          {fields.data?.map((f) => (
            <div key={f.id} className="flex items-center gap-3 py-3 first:pt-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">{f.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <code className="rounded bg-slate-100 px-1">{f.key}</code> {f.options.length > 0 && `· ${f.options.join(', ')}`}
                </p>
              </div>
              <Badge tone="blue">{TYPES[f.type]}</Badge>
              {isAdmin && (
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${f.label}`} onClick={async () => (await confirm({title: `Remove "${f.label}"?`, description: `Saved values are kept but hidden.`, confirmLabel: 'Remove', destructive: true})) && remove.mutate(f.id)}><Trash2 /></Button>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
      {isAdmin && (
        <SettingsSection title="Add a field">
          <form onSubmit={(e) => (e.preventDefault(), create.mutate(undefined))} className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Label" htmlFor="f-label"><Input id="f-label" required value={draft.label} onChange={(e) => setDraft({...draft, label: e.target.value})} placeholder="e.g. Contract renewal date" /></Field>
              <Field label="Type" htmlFor="f-type">
                <NativeSelect id="f-type" value={draft.type} onChange={(e) => setDraft({...draft, type: e.target.value as FieldType})}>
                  {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </NativeSelect>
              </Field>
            </div>
            {needsOptions && (
              <Field label="Options" htmlFor="f-opts" hint="Press Enter after each option">
                <TagInput id="f-opts" noun="option" lowercase={false} value={draft.options} onChange={(options) => setDraft({...draft, options})} />
              </Field>
            )}
            <div><Button type="submit" disabled={create.isPending}>{create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add field</Button></div>
          </form>
        </SettingsSection>
      )}
    </div>
  );
}
