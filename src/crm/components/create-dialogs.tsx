import {useNavigate} from '@tanstack/react-router';
import {Calendar, CheckSquare, Flag, Mail, Phone, Users} from 'lucide-react';
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
import {is, useFormState} from './ui/form-state';
import {COMPANY_LIMITS, CONTACT_LIMITS, DEAL_LIMITS} from '@/lib/record-limits';

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

/** `errorOf` gives the server's words for one value (`custom.<key>`, `f.nested`). */
function CustomFieldsSection({entity, value, onChange, errorOf}: {entity: EntityType; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errorOf?: (name: string) => string | undefined}) {
  const fields = useFields(entity);
  if (!fields.data?.length) return null;
  return (
    <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
      {fields.data.map((f) => (
        <Field key={f.id} label={f.label} htmlFor={`cf-${f.key}`} error={errorOf?.(`custom.${f.key}`)}>
          <CustomFieldInput field={f} value={value[f.key]} onChange={(v) => onChange({...value, [f.key]: v})} />
        </Field>
      ))}
    </div>
  );
}

function FormDialog({title, description, onClose, form, busy, submitLabel, pendingLabel, children}: {title: string; description?: string; onClose: () => void; form: React.ComponentProps<'form'>; busy: boolean; submitLabel: string; pendingLabel: string; children: ReactNode}) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="md">
        <form {...form} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogBody>{children}</DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" pending={busy} pendingLabel={pendingLabel}>
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

  const f = useFormState(form, {
    title: [is.required('Give the deal a name.'), is.maxLength(DEAL_LIMITS.title)],
    value: [is.number({min: 0, max: 1e12, message: 'Enter an amount of 0 or more, like 2500.'})],
  });

  return (
    <FormDialog title="New deal" description="Track an opportunity through your pipeline." onClose={onClose} form={f.form(() => create.mutate(undefined, {onError: f.fail}))} busy={create.isPending} submitLabel="Create deal" pendingLabel="Creating…">
      <Field label="Deal name" htmlFor="d-title" error={f.error('title')}>
        <Input id="d-title" autoFocus value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} onBlur={f.blur('title')} placeholder="e.g. Northwind: annual plan" />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={`Value (${settings.data?.settings.currency ?? 'USD'})`} htmlFor="d-value" error={f.error('value')}>
          <Input id="d-value" type="number" inputMode="decimal" step="any" value={form.value} onChange={(e) => setForm({...form, value: e.target.value})} onBlur={f.blur('value')} placeholder="0" />
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
      <CustomFieldsSection entity="DEAL" value={form.custom} onChange={(custom) => setForm({...form, custom})} errorOf={f.nested} />
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

  const f = useFormState(form, {
    firstName: [is.required('Enter a first name.'), is.maxLength(CONTACT_LIMITS.firstName)],
    lastName: [is.maxLength(CONTACT_LIMITS.lastName)],
    email: [is.email(), is.maxLength(CONTACT_LIMITS.email)],
    phone: [is.maxLength(CONTACT_LIMITS.phone)],
    title: [is.maxLength(CONTACT_LIMITS.title)],
  });

  return (
    <FormDialog title="New contact" onClose={onClose} form={f.form(() => create.mutate(undefined, {onError: f.fail}))} busy={create.isPending} submitLabel="Create contact" pendingLabel="Creating…">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="c-first" error={f.error('firstName')}>
          <Input id="c-first" autoFocus value={form.firstName} onChange={set('firstName')} onBlur={f.blur('firstName')} />
        </Field>
        <Field label="Last name" htmlFor="c-last" error={f.error('lastName')}>
          <Input id="c-last" value={form.lastName} onChange={set('lastName')} onBlur={f.blur('lastName')} />
        </Field>
        <Field label="Email" htmlFor="c-email" error={f.error('email')}>
          <Input id="c-email" type="email" value={form.email} onChange={set('email')} onBlur={f.blur('email')} placeholder="name@company.com" />
        </Field>
        <Field label="Phone" htmlFor="c-phone" error={f.error('phone')}>
          <Input id="c-phone" type="tel" value={form.phone} onChange={set('phone')} onBlur={f.blur('phone')} />
        </Field>
        <DuplicateHint className="sm:col-span-2" input={{entity: 'contact', firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone, companyId: form.company?.id ?? null}} onOpen={onClose} />
        <Field label="Job title" htmlFor="c-title" error={f.error('title')}>
          <Input id="c-title" value={form.title} onChange={set('title')} onBlur={f.blur('title')} />
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
      <CustomFieldsSection entity="CONTACT" value={form.custom} onChange={(custom) => setForm({...form, custom})} errorOf={f.nested} />
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
  const f = useFormState(form, {
    name: [is.required('Enter the company name.'), is.maxLength(COMPANY_LIMITS.name)],
    domain: [is.maxLength(COMPANY_LIMITS.domain)],
    phone: [is.maxLength(COMPANY_LIMITS.phone)],
    city: [is.maxLength(COMPANY_LIMITS.city)],
    state: [is.maxLength(COMPANY_LIMITS.state)],
    postalCode: [is.maxLength(COMPANY_LIMITS.postalCode)],
    country: [is.maxLength(COMPANY_LIMITS.country)],
    employees: [is.number({min: 0, max: 10_000_000, integer: true, message: 'Use a whole number of 0 or more, like 50.'})],
    annualRevenue: [is.number({min: 0, max: 1e13, message: 'Enter an amount of 0 or more, like 250000.'})],
    linkedin: [is.url('Enter the full LinkedIn address, like https://linkedin.com/company/acme.')],
  });
  return (
    <FormDialog title="New company" description="Existing contacts with an email at this domain are linked automatically." onClose={onClose} form={f.form(() => create.mutate(undefined, {onError: f.fail}))} busy={create.isPending} submitLabel="Create company" pendingLabel="Creating…">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Company domain" htmlFor="co-domain" error={f.error('domain')}>
          <Input id="co-domain" autoFocus value={form.domain} onChange={onDomain} onBlur={f.blur('domain')} placeholder="acme.com" />
        </Field>
        <Field label="Company name" htmlFor="co-name" error={f.error('name')}>
          <Input id="co-name" value={form.name} onChange={set('name')} onBlur={f.blur('name')} />
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
        <Field label="Phone number" htmlFor="co-phone" error={f.error('phone')}>
          <Input id="co-phone" type="tel" value={form.phone} onChange={set('phone')} onBlur={f.blur('phone')} />
        </Field>
        <Field label="City" htmlFor="co-city" error={f.error('city')}><Input id="co-city" value={form.city} onChange={set('city')} onBlur={f.blur('city')} /></Field>
        <Field label="State / region" htmlFor="co-state" error={f.error('state')}><Input id="co-state" value={form.state} onChange={set('state')} onBlur={f.blur('state')} /></Field>
        <Field label="Postal code" htmlFor="co-zip" error={f.error('postalCode')}><Input id="co-zip" value={form.postalCode} onChange={set('postalCode')} onBlur={f.blur('postalCode')} /></Field>
        <Field label="Country" htmlFor="co-country" error={f.error('country')}><Input id="co-country" value={form.country} onChange={set('country')} onBlur={f.blur('country')} /></Field>
        <Field label="Number of employees" htmlFor="co-emp" error={f.error('employees')}><Input id="co-emp" type="number" inputMode="numeric" value={form.employees} onChange={set('employees')} onBlur={f.blur('employees')} /></Field>
        <Field label={`Annual revenue (${settings.data?.settings.currency ?? 'USD'})`} htmlFor="co-rev" error={f.error('annualRevenue')}><Input id="co-rev" type="number" inputMode="decimal" step="any" value={form.annualRevenue} onChange={set('annualRevenue')} onBlur={f.blur('annualRevenue')} /></Field>
        <Field label="Time zone" htmlFor="co-tz">
          <CreatableSelect id="co-tz" placeholder="Choose a time zone" value={form.timezone} options={zones} onChange={(v) => setForm({...form, timezone: v as string | null})} />
        </Field>
        <Field label="LinkedIn company page" htmlFor="co-li" error={f.error('linkedin')}><Input id="co-li" type="url" value={form.linkedin} onChange={set('linkedin')} onBlur={f.blur('linkedin')} placeholder="https://linkedin.com/company/…" /></Field>
        <Field label="Description" htmlFor="co-desc" className="sm:col-span-2"><Textarea id="co-desc" rows={3} value={form.description} onChange={set('description')} /></Field>
        <Field label="Tags" htmlFor="co-tags" className="sm:col-span-2">
          <TagInput id="co-tags" entity="COMPANY" value={form.tags} onChange={(tags) => setForm({...form, tags})} />
        </Field>
      </div>
      <CustomFieldsSection entity="COMPANY" value={form.custom} onChange={(custom) => setForm({...form, custom})} errorOf={f.nested} />
    </FormDialog>
  );
}

function prevGuess(domain: string) {
  const g = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0] ?? '';
  return g.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─── Task (create + edit) ───

export const TASK_ICONS: Record<TaskType, typeof Phone> = {TODO: CheckSquare, CALL: Phone, EMAIL: Mail, MEETING: Users, DEADLINE: Flag};

