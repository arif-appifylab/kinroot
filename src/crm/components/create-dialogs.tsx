import {useNavigate} from '@tanstack/react-router';
import {Calendar, CheckSquare, Flag, Loader2, Mail, Phone, Users} from 'lucide-react';
import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';

import {api} from '@/lib/api';
import {LEAD_STATUSES, LIFECYCLE, TASK_TYPES, timeZones} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useFields, useMe, usePipelines, useSettings} from '@/lib/queries';
import type {Company, CompanyLite, Contact, ContactLite, Deal, EntityType, LifecycleStage, Task, TaskType} from '@/lib/types';
import {cn} from '@/lib/utils';

import {TaskDialog} from './task-dialog';

import {CustomFieldInput} from './custom-fields';
import {DuplicateHint} from './duplicates';
import {CompanyPicker, ContactsPicker, CreatableSelect, TagInput, UserSelect} from './pickers';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Field, Input, NativeSelect, Textarea} from './ui/form';

// ─── Global "create" controller so any screen (or ⌘K) can open a form ───

export type TaskDefaults = {
  contactId?: string;
  companyId?: string;
  dealId?: string;
  /** Display names for the pre-filled associations. */
  contactName?: string;
  companyName?: string;
  dealTitle?: string;
  label?: string;
  title?: string;
  type?: TaskType;
};
type DealDefaults = {company?: CompanyLite | null; contacts?: ContactLite[]; stageId?: string; pipelineId?: string};
type ContactDefaults = {company?: CompanyLite | null};

type OpenState =
  | {kind: 'deal'; defaults?: DealDefaults}
  | {kind: 'contact'; defaults?: ContactDefaults}
  | {kind: 'company'}
  | {kind: 'task'; defaults?: TaskDefaults; task?: Task}
  | null;

const CreateCtx = createContext<{open: (s: Exclude<OpenState, null>) => void}>({open: () => {}});
export const useCreate = () => useContext(CreateCtx);

export function CreateProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<OpenState>(null);
  const ctx = useMemo(() => ({open: (s: Exclude<OpenState, null>) => setState(s)}), []);
  const close = () => setState(null);
  return (
    <CreateCtx.Provider value={ctx}>
      {children}
      {state?.kind === 'deal' && <DealDialog defaults={state.defaults} onClose={close} />}
      {state?.kind === 'contact' && <ContactDialog defaults={state.defaults} onClose={close} />}
      {state?.kind === 'company' && <CompanyDialog onClose={close} />}
      {state?.kind === 'task' && <TaskDialog defaults={state.defaults} task={state.task} onClose={close} />}
    </CreateCtx.Provider>
  );
}

function CustomFieldsSection({entity, value, onChange}: {entity: EntityType; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void}) {
  const fields = useFields(entity);
  if (!fields.data?.length) return null;
  return (
    <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
      {fields.data.map((f) => (
        <Field key={f.id} label={f.label} htmlFor={`cf-${f.key}`}>
          <CustomFieldInput field={f} value={value[f.key]} onChange={(v) => onChange({...value, [f.key]: v})} />
        </Field>
      ))}
    </div>
  );
}

function FormDialog({title, description, onClose, onSubmit, busy, submitLabel, children}: {title: string; description?: string; onClose: () => void; onSubmit: () => void; busy: boolean; submitLabel: string; children: ReactNode}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form onSubmit={(e) => (e.preventDefault(), onSubmit())} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogBody>{children}</DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Deal ───

function DealDialog({defaults, onClose}: {defaults?: DealDefaults; onClose: () => void}) {
  const navigate = useNavigate();
  const {me} = useMe();
  const pipelines = usePipelines();
  const settings = useSettings();
  const [form, setForm] = useState({
    title: '',
    value: '',
    pipelineId: defaults?.pipelineId ?? '',
    stageId: defaults?.stageId ?? '',
    company: defaults?.company ?? null,
    contacts: defaults?.contacts ?? [],
    ownerId: me.id as string | null,
    expectedCloseDate: '',
    custom: {} as Record<string, unknown>,
  });
  const pipeline = pipelines.data?.find((p) => p.id === form.pipelineId) ?? pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0];

  useEffect(() => {
    if (pipeline && !form.pipelineId) setForm((f) => ({...f, pipelineId: pipeline.id, stageId: f.stageId || pipeline.stages[0]?.id || ''}));
  }, [pipeline, form.pipelineId]);

  const create = useApiMutation(
    () =>
      api.post<{deal: Deal}>('/deals', {
        title: form.title,
        value: Number(form.value || 0),
        currency: settings.data?.settings.currency,
        pipelineId: form.pipelineId,
        stageId: form.stageId,
        companyId: form.company?.id ?? null,
        contactIds: form.contacts.map((c) => c.id),
        ownerId: form.ownerId,
        expectedCloseDate: form.expectedCloseDate || null,
        custom: form.custom,
      }),
    {invalidate: recordKeys, success: 'Deal created', onSuccess: ({deal}) => (onClose(), navigate({to: '/deals/$dealId', params: {dealId: deal.id}}))},
  );

  return (
    <FormDialog title="New deal" description="Track an opportunity through your pipeline." onClose={onClose} onSubmit={() => create.mutate(undefined)} busy={create.isPending} submitLabel="Create deal">
      <Field label="Deal name" htmlFor="d-title">
        <Input id="d-title" autoFocus required value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} placeholder="e.g. Northwind: annual plan" />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={`Value (${settings.data?.settings.currency ?? 'USD'})`} htmlFor="d-value">
          <Input id="d-value" type="number" min={0} step="any" value={form.value} onChange={(e) => setForm({...form, value: e.target.value})} placeholder="0" />
        </Field>
        <Field label="Expected close" htmlFor="d-close">
          <Input id="d-close" type="date" value={form.expectedCloseDate} onChange={(e) => setForm({...form, expectedCloseDate: e.target.value})} />
        </Field>
        {(pipelines.data?.length ?? 0) > 1 && (
          <Field label="Pipeline" htmlFor="d-pipe">
            <NativeSelect id="d-pipe" value={form.pipelineId} onChange={(e) => {
              const p = pipelines.data?.find((x) => x.id === e.target.value);
              setForm({...form, pipelineId: e.target.value, stageId: p?.stages[0]?.id ?? ''});
            }}>
              {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </NativeSelect>
          </Field>
        )}
        <Field label="Stage" htmlFor="d-stage">
          <NativeSelect id="d-stage" value={form.stageId} onChange={(e) => setForm({...form, stageId: e.target.value})}>
            {pipeline?.stages.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.probability}%</option>)}
          </NativeSelect>
        </Field>
        <Field label="Owner" htmlFor="d-owner">
          <UserSelect id="d-owner" value={form.ownerId} onChange={(v) => setForm({...form, ownerId: v})} />
        </Field>
      </div>
      <Field label="Company" htmlFor="d-company">
        <CompanyPicker id="d-company" value={form.company} onChange={(company) => setForm({...form, company})} />
      </Field>
      <Field label="People" htmlFor="d-people">
        <ContactsPicker id="d-people" value={form.contacts} onChange={(contacts) => setForm({...form, contacts})} />
      </Field>
      <CustomFieldsSection entity="DEAL" value={form.custom} onChange={(custom) => setForm({...form, custom})} />
    </FormDialog>
  );
}

// ─── Contact ───

function ContactDialog({defaults, onClose}: {defaults?: ContactDefaults; onClose: () => void}) {
  const navigate = useNavigate();
  const {me} = useMe();
  const settings = useSettings();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    title: '',
    company: defaults?.company ?? null,
    lifecycleStage: 'LEAD' as LifecycleStage,
    leadStatus: null as string | null,
    source: '',
    ownerId: me.id as string | null,
    tags: [] as string[],
    custom: {} as Record<string, unknown>,
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({...form, [k]: e.target.value});

  const create = useApiMutation(
    () => {
      const {company, ...rest} = form;
      return api.post<{contact: Contact; linkedCompany: {name: string} | null}>('/contacts', {...rest, companyId: company?.id ?? null, source: form.source || null});
    },
    {invalidate: [...recordKeys, keys.settings], success: (r) => (r.linkedCompany ? `Contact created · linked to ${r.linkedCompany.name} by email domain` : 'Contact created'), onSuccess: ({contact}) => (onClose(), navigate({to: '/contacts/$contactId', params: {contactId: contact.id}}))},
  );

  return (
    <FormDialog title="New contact" onClose={onClose} onSubmit={() => create.mutate(undefined)} busy={create.isPending} submitLabel="Create contact">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="c-first">
          <Input id="c-first" autoFocus required value={form.firstName} onChange={set('firstName')} />
        </Field>
        <Field label="Last name" htmlFor="c-last">
          <Input id="c-last" value={form.lastName} onChange={set('lastName')} />
        </Field>
        <Field label="Email" htmlFor="c-email">
          <Input id="c-email" type="email" value={form.email} onChange={set('email')} placeholder="name@company.com" />
        </Field>
        <Field label="Phone" htmlFor="c-phone">
          <Input id="c-phone" type="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <DuplicateHint className="sm:col-span-2" input={{entity: 'contact', firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone, companyId: form.company?.id ?? null}} onOpen={onClose} />
        <Field label="Job title" htmlFor="c-title">
          <Input id="c-title" value={form.title} onChange={set('title')} />
        </Field>
        <Field label="Company" htmlFor="c-company">
          <CompanyPicker id="c-company" value={form.company} onChange={(company) => setForm({...form, company})} />
        </Field>
        <Field label="Lifecycle stage" htmlFor="c-stage">
          <NativeSelect id="c-stage" value={form.lifecycleStage} onChange={set('lifecycleStage')}>
            {Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Lead status" htmlFor="c-lead">
          <CreatableSelect id="c-lead" placeholder="New, open, connected…" value={form.leadStatus} options={LEAD_STATUSES} onChange={(v) => setForm({...form, leadStatus: v as string | null})} />
        </Field>
        <Field label="Source" htmlFor="c-source">
          <CreatableSelect id="c-source" noun="source" placeholder="Where did they come from?" value={form.source || null} options={settings.data?.settings.sources ?? []} onChange={(v) => setForm({...form, source: (v as string | null) ?? ''})} onCreate={() => {}} />
        </Field>
        <Field label="Owner" htmlFor="c-owner">
          <UserSelect id="c-owner" value={form.ownerId} onChange={(v) => setForm({...form, ownerId: v})} />
        </Field>
        <Field label="Tags" htmlFor="c-tags">
          <TagInput id="c-tags" entity="CONTACT" value={form.tags} onChange={(tags) => setForm({...form, tags})} />
        </Field>
      </div>
      <CustomFieldsSection entity="CONTACT" value={form.custom} onChange={(custom) => setForm({...form, custom})} />
    </FormDialog>
  );
}

// ─── Company ───

function CompanyDialog({onClose}: {onClose: () => void}) {
  const navigate = useNavigate();
  const {me} = useMe();
  const settings = useSettings();
  const zones = useMemo(timeZones, []);
  const [form, setForm] = useState({
    domain: '',
    name: '',
    ownerId: me.id as string | null,
    industry: null as string | null,
    type: null as string | null,
    phone: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    employees: '',
    annualRevenue: '',
    timezone: null as string | null,
    description: '',
    linkedin: '',
    tags: [] as string[],
    custom: {} as Record<string, unknown>,
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({...form, [k]: e.target.value});
  // HubSpot-style: typing the domain suggests the name.
  const onDomain = (e: React.ChangeEvent<HTMLInputElement>) => {
    const domain = e.target.value;
    const guess = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0] ?? '';
    const pretty = guess.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    setForm((f) => ({...f, domain, name: !f.name || f.name === prevGuess(f.domain) ? pretty : f.name}));
  };
  const create = useApiMutation(
    () =>
      api.post<{company: Company; linkedContacts: number}>('/companies', {
        ...form,
        employees: form.employees === '' ? null : Number(form.employees),
        annualRevenue: form.annualRevenue === '' ? null : Number(form.annualRevenue),
        website: form.domain ? `https://${form.domain.replace(/^https?:\/\//, '')}` : null,
      }),
    {
      invalidate: recordKeys,
      success: (r) => (r.linkedContacts ? `Company created · ${r.linkedContacts} contact${r.linkedContacts > 1 ? 's' : ''} linked by email domain` : 'Company created'),
      onSuccess: ({company}) => (onClose(), navigate({to: '/companies/$companyId', params: {companyId: company.id}})),
    },
  );
  return (
    <FormDialog title="New company" description="Existing contacts with an email at this domain are linked automatically." onClose={onClose} onSubmit={() => create.mutate(undefined)} busy={create.isPending} submitLabel="Create company">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Company domain" htmlFor="co-domain">
          <Input id="co-domain" autoFocus value={form.domain} onChange={onDomain} placeholder="acme.com" />
        </Field>
        <Field label="Company name" htmlFor="co-name">
          <Input id="co-name" required value={form.name} onChange={set('name')} />
        </Field>
        <DuplicateHint className="sm:col-span-2" input={{entity: 'company', name: form.name, domain: form.domain}} onOpen={onClose} />
        <Field label="Company owner" htmlFor="co-owner">
          <UserSelect id="co-owner" value={form.ownerId} onChange={(v) => setForm({...form, ownerId: v})} />
        </Field>
        <Field label="Industry" htmlFor="co-industry">
          <CreatableSelect id="co-industry" noun="industry" placeholder="Choose an industry" value={form.industry} options={settings.data?.settings.industries ?? []} onChange={(v) => setForm({...form, industry: v as string | null})} onCreate={() => {}} />
        </Field>
        <Field label="Type" htmlFor="co-type">
          <CreatableSelect id="co-type" noun="type" placeholder="Prospect, partner…" value={form.type} options={settings.data?.settings.companyTypes ?? []} onChange={(v) => setForm({...form, type: v as string | null})} onCreate={() => {}} />
        </Field>
        <Field label="Phone number" htmlFor="co-phone">
          <Input id="co-phone" type="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="City" htmlFor="co-city"><Input id="co-city" value={form.city} onChange={set('city')} /></Field>
        <Field label="State / region" htmlFor="co-state"><Input id="co-state" value={form.state} onChange={set('state')} /></Field>
        <Field label="Postal code" htmlFor="co-zip"><Input id="co-zip" value={form.postalCode} onChange={set('postalCode')} /></Field>
        <Field label="Country" htmlFor="co-country"><Input id="co-country" value={form.country} onChange={set('country')} /></Field>
        <Field label="Number of employees" htmlFor="co-emp"><Input id="co-emp" type="number" min={0} value={form.employees} onChange={set('employees')} /></Field>
        <Field label={`Annual revenue (${settings.data?.settings.currency ?? 'USD'})`} htmlFor="co-rev"><Input id="co-rev" type="number" min={0} step="any" value={form.annualRevenue} onChange={set('annualRevenue')} /></Field>
        <Field label="Time zone" htmlFor="co-tz">
          <CreatableSelect id="co-tz" placeholder="Choose a time zone" value={form.timezone} options={zones} onChange={(v) => setForm({...form, timezone: v as string | null})} />
        </Field>
        <Field label="LinkedIn company page" htmlFor="co-li"><Input id="co-li" type="url" value={form.linkedin} onChange={set('linkedin')} placeholder="https://linkedin.com/company/…" /></Field>
        <Field label="Description" htmlFor="co-desc" className="sm:col-span-2"><Textarea id="co-desc" rows={3} value={form.description} onChange={set('description')} /></Field>
        <Field label="Tags" htmlFor="co-tags" className="sm:col-span-2">
          <TagInput id="co-tags" entity="COMPANY" value={form.tags} onChange={(tags) => setForm({...form, tags})} />
        </Field>
      </div>
      <CustomFieldsSection entity="COMPANY" value={form.custom} onChange={(custom) => setForm({...form, custom})} />
    </FormDialog>
  );
}

function prevGuess(domain: string) {
  const g = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0] ?? '';
  return g.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─── Task (create + edit) ───

export const TASK_ICONS: Record<TaskType, typeof Phone> = {TODO: CheckSquare, CALL: Phone, EMAIL: Mail, MEETING: Users, DEADLINE: Flag};

