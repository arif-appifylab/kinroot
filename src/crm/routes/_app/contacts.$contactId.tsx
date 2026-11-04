import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, Building2, ChevronDown, CopyPlus, Download, ExternalLink, GitMerge, Globe, Handshake, Mail, MailX, Plus, Trash2, X} from 'lucide-react';
import {useState} from 'react';

import {useCreate} from '@/components/create-dialogs';
import {ContactMergeDialog} from '@/components/record-merge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {CompanyPicker, CreatableSelect, TagInput, UserSelect} from '@/components/pickers';
import {PropertyHistoryMenuItem, PropertyHistoryProvider} from '@/components/property-history';
import {ChoiceProperty, CustomFieldProperties, EditableProperty, Property, PropertyCard, SelectProperty, TextProperty} from '@/components/properties';
import {ActivityButtons, Composer, RecordTasks, Timeline} from '@/components/timeline';
import {AttachmentsCard} from '@/components/attachments';
import {AutomationsCard} from '@/components/automations/record-tools';
import {ContactListsCard} from '@/components/lists/contact-lists-card';
import {ContactScore} from '@/components/scoring/score';
import {TicketsCard} from '@/components/tickets/tickets-card';
import {FollowButton} from '@/components/notifications';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {LoadError} from '@/components/data-table';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, Skeleton} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {ago, BUYING_ROLES, fullName, LEAD_STATUSES, LIFECYCLE, money, shortDate} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useFields, useMe, useSettings} from '@/lib/queries';
import type {CompanyLite, ContactDetail, ContactLite} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/contacts/$contactId')({
  head: () => ({meta: [{title: pageTitle('Contact')}]}),
  component: ContactPage,
});

function ContactPage() {
  const {contactId} = Route.useParams();
  const navigate = useNavigate();
  const create = useCreate();
  const {canEdit} = useMe();
  const fields = useFields('CONTACT');
  const settings = useSettings();
  const [addingCompany, setAddingCompany] = useState(false);
  const [merging, setMerging] = useState(false);

  const q = useQuery({queryKey: [...keys.contacts, contactId], queryFn: () => api.get<{contact: ContactDetail}>(`/contacts/${contactId}`), select: (d) => d.contact});
  const save = useApiMutation((patch: Record<string, unknown>) => api.patch(`/contacts/${contactId}`, patch), {invalidate: [...recordKeys, keys.settings]});
  const link = useApiMutation((company: CompanyLite) => api.post(`/contacts/${contactId}/companies`, {companyId: company.id, isPrimary: !q.data?.companies.length}), {invalidate: recordKeys, onSuccess: () => setAddingCompany(false)});
  const unlink = useApiMutation((companyId: string) => api.del(`/contacts/${contactId}/companies/${companyId}`), {invalidate: recordKeys});
  const clone = useApiMutation(() => api.post<{contact: {id: string}}>(`/contacts/${contactId}/clone`), {
    invalidate: [keys.contacts],
    success: 'Contact cloned',
    onSuccess: ({contact}) => navigate({to: '/contacts/$contactId', params: {contactId: contact.id}}),
  });
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/contacts/${contactId}`), {invalidate: [keys.contacts, keys.recycleBin], onSuccess: (r) => (binToast('Contact', r.binId), navigate({to: '/contacts'}))});

  const c = q.data;
  if (q.isLoading || !c) {
    return q.error ? (
      <Card className="overflow-hidden">
        <LoadError error={q.error} onRetry={() => q.refetch()} title={(q.error as {status?: number}).status === 404 ? 'This contact was not found' : 'This contact could not be loaded'} />
      </Card>
    ) : (
      <Skeleton className="h-64 rounded-2xl" />
    );
  }

  const name = fullName(c);
  const primary = c.companies[0]?.company;
  const record = {contactId};
  const taskDefaults = {contactId, contactName: name, companyId: primary?.id, companyName: primary?.name, label: name};
  const currency = settings.data?.settings.currency ?? 'USD';

  return (
    <PropertyHistoryProvider entity="contact" id={contactId} name={name}>
    <div>
      <Link to="/contacts" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Contacts
      </Link>

      <Card className="relative mb-6 overflow-hidden p-5 sm:p-6">
        <div className="blob -top-24 -right-16 size-64 bg-blue-200/40" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <Avatar name={name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900">{name}</h1>
              <Badge tone={LIFECYCLE[c.lifecycleStage].tone}>{LIFECYCLE[c.lifecycleStage].label}</Badge>
              <ContactScore contactId={contactId} score={c.score} />
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[c.title, primary?.name].filter(Boolean).join(' at ') || 'No title yet'} · last activity {ago(c.lastActivityAt)}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {c.emailOptOut && <Badge tone="rose"><MailX /> Opted out of email</Badge>}
              {c.leadStatus && <Badge tone="blue">{c.leadStatus}</Badge>}
              {c.tags.map((t) => <Badge key={t} tone="teal">{t}</Badge>)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && <Button size="sm" onClick={() => create.open({kind: 'deal', defaults: {contacts: [c as ContactLite], company: primary ?? null}})}><Plus /> Deal</Button>}
            <FollowButton entity="contact" id={contactId} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={clone.isPending || remove.isPending} aria-busy={clone.isPending || remove.isPending || undefined}>Actions <ChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <PropertyHistoryMenuItem />
                <DropdownMenuItem onSelect={() => window.open(`https://www.google.com/search?q=${encodeURIComponent([name, primary?.name].filter(Boolean).join(' '))}`, '_blank', 'noopener')}><Globe /> Search in Google</DropdownMenuItem>
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => save.mutate({emailOptOut: !c.emailOptOut})}>{c.emailOptOut ? <Mail /> : <MailX />} {c.emailOptOut ? 'Opt back in to email' : 'Opt out of email'}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setMerging(true)}><GitMerge /> Merge…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => clone.mutate(undefined)}><CopyPlus /> Clone</DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onSelect={() => (window.location.href = `/site-api/crm/contacts/${contactId}/export`)}><Download /> Export contact data</DropdownMenuItem>
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete ${name}?`, description: `The contact moves to the recycle bin with its notes, tasks and activity, and can be restored for 30 days.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
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
            <TextProperty label="First name" field="firstName" value={c.firstName} onSave={(v) => v && save.mutate({firstName: v})} />
            <TextProperty label="Last name" field="lastName" value={c.lastName} onSave={(v) => save.mutate({lastName: v})} />
            <TextProperty label="Email" field="email" type="email" value={c.email} href={c.email ? `mailto:${c.email}` : undefined} onSave={(v) => save.mutate({email: v ?? ''})} />
            <TextProperty label="Phone" field="phone" type="tel" value={c.phone} href={c.phone ? `tel:${c.phone}` : undefined} onSave={(v) => save.mutate({phone: v})} />
            <TextProperty label="Job title" field="title" value={c.title} onSave={(v) => save.mutate({title: v})} />
            <TextProperty label="LinkedIn" field="linkedin" value={c.linkedin} href={c.linkedin ?? undefined} onSave={(v) => save.mutate({linkedin: v})} />
            <TextProperty label="City" field="city" value={c.city} onSave={(v) => save.mutate({city: v})} />
            <TextProperty label="Country" field="country" value={c.country} onSave={(v) => save.mutate({country: v})} />
            <SelectProperty
              label="Lifecycle" field="lifecycleStage"
              value={c.lifecycleStage}
              options={Object.entries(LIFECYCLE).map(([value, l]) => ({value, label: l.label}))}
              display={<Badge tone={LIFECYCLE[c.lifecycleStage].tone}>{LIFECYCLE[c.lifecycleStage].label}</Badge>}
              onSave={(v) => v && save.mutate({lifecycleStage: v})}
            />
            <ChoiceProperty label="Lead status" field="leadStatus" value={c.leadStatus} options={LEAD_STATUSES} onSave={(v) => save.mutate({leadStatus: v})} />
            <ChoiceProperty label="Buying role" field="buyingRole" value={c.buyingRole} options={BUYING_ROLES} onSave={(v) => save.mutate({buyingRole: v})} />
            <EditableProperty
              label="Source" field="source"
              value={c.source}
              display={c.source ?? <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <CreatableSelect noun="source" value={value} options={settings.data?.settings.sources ?? []} onChange={(v) => onChange(v as string | null)} onCreate={() => {}} />}
              onSave={(v) => save.mutate({source: v})}
            />
            <EditableProperty
              label="Owner" field="ownerId"
              value={c.ownerId}
              display={c.owner ? <span className="inline-flex items-center gap-1.5"><Avatar name={c.owner.name} color={c.owner.color} src={c.owner.avatarUrl} size="xs" />{c.owner.name}</span> : <span className="text-slate-400">Unassigned</span>}
              editor={({value, onChange}) => <UserSelect value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({ownerId: v})}
            />
            <EditableProperty label="Tags" field="tags" value={c.tags} display={c.tags.length ? <span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="teal">{t}</Badge>)}</span> : <span className="text-slate-400">—</span>} editor={({value, onChange}) => <TagInput entity="CONTACT" value={value} onChange={onChange} />} onSave={(v) => save.mutate({tags: v})} />
            <Property label="Created">{shortDate(c.createdAt)}</Property>
            {fields.data && <CustomFieldProperties fields={fields.data} values={c.custom as Record<string, unknown>} currency={currency} onSave={(key, v) => save.mutate({custom: {[key]: v}})} />}
          </PropertyCard>

          <PropertyCard
            title="Companies"
            action={canEdit && <Button variant="ghost" size="sm" onClick={() => setAddingCompany((a) => !a)}><Plus /> Link</Button>}
          >
            {addingCompany && <div className="p-2"><CompanyPicker value={null} onChange={(co) => co && !link.isPending && link.mutate(co)} /></div>}
            {c.companies.length === 0 && !addingCompany && <p className="px-3 py-3 text-sm text-muted-foreground">Not linked to a company</p>}
            {c.companies.map((l) => (
              <div key={l.companyId} className="group flex items-center gap-2.5 px-3 py-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Building2 className="size-4" /></span>
                <Link to="/companies/$companyId" params={{companyId: l.companyId}} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800 hover:text-primary">{l.company.name}</p>
                  <p className="text-xs text-muted-foreground">{l.isPrimary ? 'Primary' : l.role ?? l.company.domain}</p>
                </Link>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Unlink ${l.company.name}`}
                    disabled={unlink.isPending}
                    aria-busy={(unlink.isPending && unlink.variables === l.companyId) || undefined}
                    onClick={() => unlink.mutate(l.companyId)}
                    className="cursor-pointer rounded p-1 text-slate-300 opacity-0 outline-none group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed pointer-coarse:opacity-100"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </PropertyCard>

          <ContactListsCard contactId={contactId} />
          <AutomationsCard object="contact" recordId={contactId} />
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <div className="xl:hidden"><RecordTasks record={record} taskDefaults={taskDefaults} /></div>
          <div className="xl:hidden"><AttachmentsCard record={record} /></div>
          <div className="xl:hidden"><TicketsCard record={record} defaults={{contact: c as ContactLite, company: primary ?? null}} /></div>
          <Composer
            record={record}
            emailTo={c.email && !c.emailOptOut ? [c.email] : []}
            taskDefaults={taskDefaults}
            links={{
              contact: {id: c.id, name},
              company: primary ? {id: primary.id, name: primary.name} : null,
              dealOptions: c.deals.filter(({deal}) => deal.status === 'OPEN').map(({deal}) => ({id: deal.id, title: deal.title})),
              attendees: [c as ContactLite],
              phone: c.phone,
            }}
          />
          <Timeline record={record} />
        </div>

        <div className="hidden content-start gap-6 xl:grid">
          <RecordTasks record={record} taskDefaults={taskDefaults} />
          <AttachmentsCard record={record} />
          <TicketsCard record={record} defaults={{contact: c as ContactLite, company: primary ?? null}} />
          <PropertyCard title={`Deals · ${c.deals.length}`} action={canEdit && <Button variant="ghost" size="sm" onClick={() => create.open({kind: 'deal', defaults: {contacts: [c as ContactLite], company: primary ?? null}})}><Plus /> New</Button>}>
            {c.deals.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No deals yet</p>}
            {c.deals.map(({deal}) => (
              <Link key={deal.id} to="/deals/$dealId" params={{dealId: deal.id}} className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
                <Handshake className="size-4 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{deal.title}</p>
                  <p className="text-xs text-muted-foreground">{deal.status === 'OPEN' ? deal.stage.name : deal.status === 'WON' ? 'Won' : 'Lost'} · {money(deal.value, deal.currency, true)}</p>
                </div>
              </Link>
            ))}
          </PropertyCard>
          {c.linkedin && (
            <Button variant="secondary" asChild><a href={c.linkedin} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open LinkedIn</a></Button>
          )}
        </div>
      </div>

      {merging && (
        <ContactMergeDialog
          contact={c as unknown as MergeRec}
          onClose={() => setMerging(false)}
          onMerged={(keptId) => keptId !== contactId && navigate({to: '/contacts/$contactId', params: {contactId: keptId}})}
        />
      )}
    </div>
    </PropertyHistoryProvider>
  );
}

type MergeRec = {id: string; createdAt: string} & Record<string, unknown>;
