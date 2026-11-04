import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowDownUp, ArrowLeft, ChevronDown, CopyPlus, Download, GitMerge, Globe, Handshake, Link2, Plus, Search, Trash2, X} from 'lucide-react';
import {useMemo, useState} from 'react';

import {useCreate} from '@/components/create-dialogs';
import {CompanyMergeDialog} from '@/components/record-merge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {SingleContactPicker, TagInput, UserSelect} from '@/components/pickers';
import {PropertyHistoryMenuItem, PropertyHistoryProvider} from '@/components/property-history';
import {ChoiceProperty, CustomFieldProperties, EditableProperty, NumberProperty, Property, PropertyCard, TextProperty} from '@/components/properties';
import {ActivityButtons, Composer, RecordTasks, Timeline} from '@/components/timeline';
import {AttachmentsCard} from '@/components/attachments';
import {AutomationsCard} from '@/components/automations/record-tools';
import {TicketsCard} from '@/components/tickets/tickets-card';
import {FollowButton} from '@/components/notifications';
import {ScoreBadge} from '@/components/scoring/score';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {LoadError} from '@/components/data-table';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Input} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, Skeleton} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {ago, COMPANY_SIZES, fullName, LIFECYCLE, money, shortDate, timeZones} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useFields, useMe, useSettings} from '@/lib/queries';
import type {CompanyDetail} from '@/lib/types';
import {COMPANY_LIMITS} from '@/lib/record-limits';

/** The page gets the 50 most recent contacts and deals; totals come counted (capped at 1000). */
type CompanyPageData = CompanyDetail & {contactCount: number; dealCount: number; openValue: number; wonValue: number};
const upTo = (n: number) => (n >= 1000 ? '1000+' : String(n));

export const Route = createFileRoute('/_app/companies/$companyId')({
  head: () => ({meta: [{title: pageTitle('Company')}]}),
  component: CompanyPage,
});

function CompanyPage() {
  const {companyId} = Route.useParams();
  const navigate = useNavigate();
  const create = useCreate();
  const {canEdit} = useMe();
  const fields = useFields('COMPANY');
  const settings = useSettings();
  const zones = useMemo(timeZones, []);
  const q = useQuery({queryKey: [...keys.companies, companyId], queryFn: () => api.get<{company: CompanyPageData}>(`/companies/${companyId}`), select: (d) => d.company});
  const save = useApiMutation((patch: Record<string, unknown>) => api.patch(`/companies/${companyId}`, patch), {invalidate: recordKeys});
  const [merging, setMerging] = useState(false);
  const clone = useApiMutation(() => api.post<{company: {id: string}}>(`/companies/${companyId}/clone`), {
    invalidate: [keys.companies],
    success: 'Company cloned',
    onSuccess: ({company}) => navigate({to: '/companies/$companyId', params: {companyId: company.id}}),
  });
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/companies/${companyId}`), {invalidate: [keys.companies, keys.recycleBin], onSuccess: (r) => (binToast('Company', r.binId), navigate({to: '/companies'}))});

  const c = q.data;
  if (!c)
    return q.error ? (
      <Card className="overflow-hidden">
        <LoadError error={q.error} onRetry={() => q.refetch()} title={(q.error as {status?: number}).status === 404 ? 'This company was not found' : 'This company could not be loaded'} />
      </Card>
    ) : (
      <Skeleton className="h-64 rounded-2xl" />
    );

  const record = {companyId};
  const taskDefaults = {companyId, companyName: c.name, label: c.name};
  const companyLite = {id: c.id, name: c.name, domain: c.domain};
  const open = c.deals.filter((d) => d.status === 'OPEN');
  const currency = settings.data?.settings.currency ?? 'USD';
  const emails = c.contacts.map((l) => l.contact.email).filter(Boolean) as string[];

  return (
    <PropertyHistoryProvider entity="company" id={companyId} name={c.name}>
    <div>
      <Link to="/companies" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Companies
      </Link>
      <Card className="relative mb-6 overflow-hidden p-5 sm:p-6">
        <div className="blob -top-24 -right-16 size-64 bg-teal-200/40" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white shadow-glow">{c.name[0]}</span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-extrabold text-slate-900">{c.name}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{[c.type, c.industry, c.employees ? `${c.employees.toLocaleString()} employees` : c.size && `${c.size} people`, [c.city, c.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'Company'} · last activity {ago(c.lastActivityAt)}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <div className="rounded-xl bg-slate-50 px-4 py-2.5">
              <p className="text-xs font-semibold text-muted-foreground">Open pipeline</p>
              <p className="text-lg font-extrabold text-slate-900">{money(c.openValue, currency, true)}</p>
            </div>
            <div className="rounded-xl bg-green-50 px-4 py-2.5">
              <p className="text-xs font-semibold text-green-700">Won to date</p>
              <p className="text-lg font-extrabold text-slate-900">{money(c.wonValue, currency, true)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {c.website && <Button variant="secondary" size="sm" asChild><a href={c.website} target="_blank" rel="noopener noreferrer"><Globe /> Website</a></Button>}
            {canEdit && <Button size="sm" onClick={() => create.open({kind: 'deal', defaults: {company: companyLite}})}><Plus /> Deal</Button>}
            <FollowButton entity="company" id={companyId} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="secondary" size="sm" disabled={clone.isPending || remove.isPending} aria-busy={clone.isPending || remove.isPending || undefined}>Actions <ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <PropertyHistoryMenuItem />
                <DropdownMenuItem onSelect={() => window.open(`https://www.google.com/search?q=${encodeURIComponent(c.domain ?? c.name)}`, '_blank', 'noopener')}><Globe /> Search in Google</DropdownMenuItem>
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => create.open({kind: 'contact', defaults: {company: companyLite}})}><Plus /> Add contact</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setMerging(true)}><GitMerge /> Merge…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => clone.mutate(undefined)}><CopyPlus /> Clone</DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onSelect={() => (window.location.href = `/site-api/crm/companies/${companyId}/export`)}><Download /> Export company data</DropdownMenuItem>
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete ${c.name}?`, description: `Contacts stay, but are unlinked. The company can be restored from the recycle bin for 30 days.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="relative mt-5 border-t border-slate-100 pt-4">
          <ActivityButtons taskDefaults={taskDefaults} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <PropertyCard title="About">
            <TextProperty label="Name" field="name" maxLength={COMPANY_LIMITS.name} value={c.name} onSave={(v) => v && save.mutate({name: v})} />
            <TextProperty label="Domain" field="domain" maxLength={COMPANY_LIMITS.domain} value={c.domain} onSave={(v) => save.mutate({domain: v})} />
            <TextProperty label="Website" field="website" value={c.website} href={c.website ?? undefined} onSave={(v) => save.mutate({website: v})} />
            <ChoiceProperty label="Industry" field="industry" noun="industry" creatable value={c.industry} options={settings.data?.settings.industries ?? []} onSave={(v) => save.mutate({industry: v})} />
            <ChoiceProperty label="Type" field="type" noun="type" creatable value={c.type} options={settings.data?.settings.companyTypes ?? []} onSave={(v) => save.mutate({type: v})} />
            <NumberProperty label="Employees" field="employees" value={c.employees} onSave={(v) => save.mutate({employees: v})} />
            <ChoiceProperty label="Size" field="size" value={c.size} options={COMPANY_SIZES} onSave={(v) => save.mutate({size: v})} />
            <NumberProperty label="Annual revenue" field="annualRevenue" value={c.annualRevenue} format={(n) => money(n, currency)} onSave={(v) => save.mutate({annualRevenue: v})} />
            <TextProperty label="Phone" field="phone" maxLength={COMPANY_LIMITS.phone} value={c.phone} href={c.phone ? `tel:${c.phone}` : undefined} onSave={(v) => save.mutate({phone: v})} />
            <TextProperty label="Address" field="address" maxLength={COMPANY_LIMITS.address} value={c.address} onSave={(v) => save.mutate({address: v})} />
            <TextProperty label="City" field="city" maxLength={COMPANY_LIMITS.city} value={c.city} onSave={(v) => save.mutate({city: v})} />
            <TextProperty label="State / region" field="state" maxLength={COMPANY_LIMITS.state} value={c.state} onSave={(v) => save.mutate({state: v})} />
            <TextProperty label="Postal code" field="postalCode" maxLength={COMPANY_LIMITS.postalCode} value={c.postalCode} onSave={(v) => save.mutate({postalCode: v})} />
            <TextProperty label="Country" field="country" maxLength={COMPANY_LIMITS.country} value={c.country} onSave={(v) => save.mutate({country: v})} />
            <ChoiceProperty label="Time zone" field="timezone" value={c.timezone} options={zones} onSave={(v) => save.mutate({timezone: v})} />
            <TextProperty label="LinkedIn" field="linkedin" value={c.linkedin} href={c.linkedin ?? undefined} onSave={(v) => save.mutate({linkedin: v})} />
            <TextProperty label="Description" field="description" value={c.description} onSave={(v) => save.mutate({description: v})} />
            <EditableProperty
              label="Owner" field="ownerId"
              value={c.ownerId}
              display={c.owner ? <span className="inline-flex items-center gap-1.5"><Avatar name={c.owner.name} color={c.owner.color} src={c.owner.avatarUrl} size="xs" />{c.owner.name}</span> : <span className="text-slate-400">Unassigned</span>}
              editor={({value, onChange}) => <UserSelect value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({ownerId: v})}
            />
            <EditableProperty label="Tags" field="tags" value={c.tags} display={c.tags.length ? <span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="teal">{t}</Badge>)}</span> : <span className="text-slate-400">—</span>} editor={({value, onChange}) => <TagInput entity="COMPANY" value={value} onChange={onChange} />} onSave={(v) => save.mutate({tags: v})} />
            <Property label="Created">{shortDate(c.createdAt)}</Property>
            {fields.data && <CustomFieldProperties fields={fields.data} values={c.custom as Record<string, unknown>} currency={currency} onSave={(key, v) => save.mutate({custom: {[key]: v}})} />}
          </PropertyCard>

          <CompanyContacts company={c} />
          <AutomationsCard object="company" recordId={companyId} />
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <div className="xl:hidden"><RecordTasks record={record} taskDefaults={taskDefaults} /></div>
          <div className="xl:hidden"><AttachmentsCard record={record} /></div>
          <div className="xl:hidden"><TicketsCard record={record} defaults={{company: companyLite}} /></div>
          <Composer
            record={record}
            emailTo={emails.slice(0, 1)}
            taskDefaults={taskDefaults}
            links={{
              company: {id: c.id, name: c.name},
              dealOptions: open.map((d) => ({id: d.id, title: d.title})),
              attendees: c.contacts.map(({contact}) => contact).slice(0, 1),
              phone: c.phone,
              address: [c.address, c.city, c.country].filter(Boolean).join(', ') || null,
            }}
          />
          <Timeline record={record} showRecord />
        </div>

        <div className="hidden content-start gap-6 xl:grid">
          <RecordTasks record={record} taskDefaults={taskDefaults} />
          <AttachmentsCard record={record} />
          <TicketsCard record={record} defaults={{company: companyLite}} />
          <PropertyCard title={`Deals · ${upTo(c.dealCount)}`} action={canEdit && <Button variant="ghost" size="sm" onClick={() => create.open({kind: 'deal', defaults: {company: companyLite}})}><Plus /> New</Button>}>
            {c.deals.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No deals yet</p>}
            {c.deals.map((deal) => (
              <Link key={deal.id} to="/deals/$dealId" params={{dealId: deal.id}} className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
                <Handshake className="size-4 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{deal.title}</p>
                  <p className="text-xs text-muted-foreground">{deal.status === 'OPEN' ? deal.stage.name : deal.status === 'WON' ? 'Won' : 'Lost'} · {money(deal.value, deal.currency, true)}</p>
                </div>
              </Link>
            ))}
          </PropertyCard>
        </div>
      </div>

      {merging && (
        <CompanyMergeDialog
          company={c as unknown as MergeRec}
          onClose={() => setMerging(false)}
          onMerged={(keptId) => keptId !== companyId && navigate({to: '/companies/$companyId', params: {companyId: keptId}})}
        />
      )}
    </div>
    </PropertyHistoryProvider>
  );
}

type MergeRec = {id: string; createdAt: string} & Record<string, unknown>;

/** Contacts card: search, sort, primary-company label, link existing or create new. */
function CompanyContacts({company}: {company: CompanyPageData}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [linking, setLinking] = useState(false);
  const link = useApiMutation((contactId: string) => api.post(`/contacts/${contactId}/companies`, {companyId: company.id}), {invalidate: recordKeys, success: 'Contact linked', onSuccess: () => setLinking(false)});
  const unlink = useApiMutation((contactId: string) => api.del(`/contacts/${contactId}/companies/${company.id}`), {invalidate: recordKeys});
  const rows = company.contacts
    .filter(({contact}) => !q || `${fullName(contact)} ${contact.email ?? ''} ${contact.title ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) =>
      sort === 'name'
        ? fullName(a.contact).localeCompare(fullName(b.contact))
        : new Date(b.contact.lastActivityAt ?? 0).getTime() - new Date(a.contact.lastActivityAt ?? 0).getTime(),
    );

  return (
    <PropertyCard
      title={`Contacts (${upTo(company.contactCount)})`}
      action={
        canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm"><Plus /> Add</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => create.open({kind: 'contact', defaults: {company: {id: company.id, name: company.name, domain: company.domain}}})}><Plus /> Create new contact</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLinking(true)}><Link2 /> Add existing contact</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      {company.contacts.length > 2 && (
        <div className="flex items-center gap-2 px-2 pt-2 pb-1">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className="h-8 pl-8 text-xs" aria-label="Search contacts" />
          </div>
          <button type="button" aria-label={sort === 'name' ? 'Sorted A to Z; sort by recent activity' : 'Sorted by recent activity; sort A to Z'} onClick={() => setSort(sort === 'name' ? 'recent' : 'name')} className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-semibold text-slate-600 outline-none hover:border-slate-300 focus-visible:ring-2 focus-visible:ring-primary/30">
            <ArrowDownUp className="size-3.5" /> {sort === 'name' ? 'A–Z' : 'Recent'}
          </button>
        </div>
      )}
      {linking && <div className="p-2"><SingleContactPicker onChange={(id) => id && !link.isPending && link.mutate(id)} /></div>}
      {company.contacts.length === 0 && !linking && <p className="px-3 py-3 text-sm text-muted-foreground">No contacts yet. People with an @{company.domain ?? 'company'} email are linked automatically.</p>}
      {rows.map(({contact, isPrimary}) => (
        <div key={contact.id} className="group flex items-start gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
          <Avatar name={fullName(contact)} size="sm" />
          <Link to="/contacts/$contactId" params={{contactId: contact.id}} className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-800 hover:text-primary">{fullName(contact)}</p>
            {contact.title && <p className="truncate text-xs text-muted-foreground">{contact.title}</p>}
            {contact.email && <p className="truncate text-xs text-muted-foreground">{contact.email}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              {isPrimary && <Badge tone="neutral">Primary company</Badge>}
              <Badge tone={LIFECYCLE[contact.lifecycleStage].tone}>{LIFECYCLE[contact.lifecycleStage].label}</Badge>
              <ScoreBadge score={contact.score} compact />
            </div>
          </Link>
          {canEdit && (
            <button
              type="button"
              aria-label={`Unlink ${fullName(contact)}`}
              disabled={unlink.isPending}
              aria-busy={(unlink.isPending && unlink.variables === contact.id) || undefined}
              onClick={() => unlink.mutate(contact.id)}
              className="cursor-pointer rounded p-1 text-slate-300 opacity-0 outline-none group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed pointer-coarse:opacity-100"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}
    </PropertyCard>
  );
}
