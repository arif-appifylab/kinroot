import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, Building2, Check, Hourglass, Link2, MoreHorizontal, Plus, RotateCcw, Trash2, Trophy, X, XCircle} from 'lucide-react';
import {useState} from 'react';

import {useCreate} from '@/components/create-dialogs';
import {LostDialog} from '@/components/deal-status';
import {SingleCompanyPicker, SingleContactPicker, TagInput, UserSelect} from '@/components/pickers';
import {PropertyHistoryProvider} from '@/components/property-history';
import {ChoiceProperty, CustomFieldProperties, EditableProperty, Property, PropertyCard, TextProperty} from '@/components/properties';
import {ActivityButtons, Composer, RecordTasks, Timeline} from '@/components/timeline';
import {AttachmentsCard} from '@/components/attachments';
import {AutomationsCard} from '@/components/automations/record-tools';
import {ScoreBadge} from '@/components/scoring/score';
import {TicketsCard} from '@/components/tickets/tickets-card';
import {FollowButton} from '@/components/notifications';
import {Badge} from '@/components/ui/badge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Input, NativeSelect} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip} from '@/components/ui/menu';
import {Avatar, Skeleton} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {daysSince, fullName, money, shortDate, toDateInput} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useFields, useMe, usePipelines} from '@/lib/queries';
import type {DealDetail} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/deals/$dealId')({
  head: () => ({meta: [{title: pageTitle('Deal')}]}),
  component: DealPage,
});

/** Chevron stage track: click a stage to move the deal there. */
function StageTrack({deal, onMove}: {deal: DealDetail; onMove: (stageId: string) => void}) {
  const {canEdit} = useMe();
  const current = deal.pipeline.stages.findIndex((s) => s.id === deal.stageId);
  const closed = deal.status !== 'OPEN';
  return (
    <div className="flex overflow-x-auto rounded-xl bg-slate-100 p-1 scrollbar-thin">
      {deal.pipeline.stages.map((s, i) => {
        const done = i < current || (closed && deal.status === 'WON');
        const active = i === current && !closed;
        const days = active ? daysSince(deal.stageEnteredAt) : null;
        return (
          <Tooltip key={s.id} content={`${s.name} · ${s.probability}%${days !== null ? ` · ${days}d in stage` : ''}`}>
            <button
              disabled={!canEdit || closed || active}
              onClick={() => onMove(s.id)}
              className={cn(
                'relative flex min-w-28 flex-1 cursor-pointer items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold whitespace-nowrap transition-all first:rounded-l-lg last:rounded-r-lg disabled:cursor-default',
                active ? 'z-10 rounded-lg bg-brand text-white shadow-btn' : done ? 'text-primary hover:bg-card/60' : 'text-slate-400 hover:bg-card/60 hover:text-slate-600',
              )}
            >
              {done && <Check className="size-3.5" />}
              <span className="truncate">{s.name}</span>
              {days !== null && <span className="rounded bg-white/20 px-1 text-[10px]">{days}d</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function DealPage() {
  const {dealId} = Route.useParams();
  const navigate = useNavigate();
  const {canEdit} = useMe();
  const fields = useFields('DEAL');
  const pipelines = usePipelines();
  const [losing, setLosing] = useState(false);

  const q = useQuery({queryKey: [...keys.deals, dealId], queryFn: () => api.get<{deal: DealDetail}>(`/deals/${dealId}`), select: (d) => d.deal});
  const save = useApiMutation((patch: Record<string, unknown>) => api.patch(`/deals/${dealId}`, patch), {invalidate: recordKeys});
  const status = useApiMutation((body: {status: 'OPEN' | 'WON' | 'LOST'; lostReason?: string}) => api.post(`/deals/${dealId}/status`, body), {
    invalidate: recordKeys,
    success: (r) => ((r as {deal: {status: string}}).deal.status === 'WON' ? '🎉 Deal won!' : (r as {deal: {status: string}}).deal.status === 'LOST' ? 'Marked as lost' : 'Deal reopened'),
  });
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/deals/${dealId}`), {invalidate: [keys.deals, keys.dashboard, keys.recycleBin], onSuccess: (r) => (binToast('Deal', r.binId), navigate({to: '/deals'}))});

  const d = q.data;
  if (!d) return q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : <Skeleton className="h-64 rounded-2xl" />;

  const record = {dealId};
  const taskDefaults = {
    dealId,
    dealTitle: d.title,
    companyId: d.companyId ?? undefined,
    companyName: d.company?.name,
    contactId: d.contacts[0]?.contactId,
    contactName: d.contacts[0] ? fullName(d.contacts[0].contact) : undefined,
    label: d.title,
  };
  const idle = daysSince(d.lastActivityAt);
  const rotting = d.status === 'OPEN' && idle > d.pipeline.rottingDays;
  const people = d.contacts.map((l) => l.contact);

  return (
    <PropertyHistoryProvider entity="deal" id={dealId} name={d.title}>
    <div>
      <Link to="/deals" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Deals
      </Link>

      <Card className="relative mb-6 overflow-hidden p-5 sm:p-6">
        <div className="blob -top-24 right-10 size-72 bg-blue-200/40" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900">{d.title}</h1>
              {d.status === 'WON' && <Badge tone="green"><Trophy /> Won</Badge>}
              {d.status === 'LOST' && <Badge tone="rose"><XCircle /> Lost · {d.lostReason}</Badge>}
              {rotting && <Badge tone="amber"><Hourglass /> No activity for {idle} days</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="text-xl font-extrabold text-slate-900">{money(d.value, d.currency)}</span>
              {d.company && (
                <Link to="/companies/$companyId" params={{companyId: d.company.id}} className="inline-flex items-center gap-1 font-medium hover:text-primary">
                  <Building2 className="size-3.5" /> {d.company.name}
                </Link>
              )}
              <span>{d.pipeline.name}</span>
              {d.expectedCloseDate && <span>Closes {shortDate(d.expectedCloseDate)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <FollowButton entity="deal" id={dealId} size="default" />
            {canEdit && (
              <>
                {d.status === 'OPEN' ? (
                  <>
                    <Button variant="success" onClick={() => status.mutate({status: 'WON'})}><Trophy /> Won</Button>
                    <Button variant="secondary" className="text-destructive hover:text-destructive" onClick={() => setLosing(true)}><XCircle /> Lost</Button>
                  </>
                ) : (
                  <Button variant="secondary" onClick={() => status.mutate({status: 'OPEN'})}><RotateCcw /> Reopen</Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="secondary" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem destructive onSelect={async () => (await confirm({title: 'Delete this deal and its notes and tasks?', description: 'It can be restored from the recycle bin for 30 days.', confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete deal</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        <div className="relative mt-5">
          <StageTrack deal={d} onMove={(stageId) => save.mutate({stageId})} />
        </div>
        <div className="relative mt-4">
          <ActivityButtons taskDefaults={taskDefaults} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <PropertyCard title="Details">
            <TextProperty label="Name" field="title" value={d.title} onSave={(v) => v && save.mutate({title: v})} />
            <EditableProperty
              label="Value" field="value"
              value={String(d.value)}
              display={<span className="font-semibold">{money(d.value, d.currency)}</span>}
              editor={({value, onChange, onCommit}) => <Input autoFocus type="number" min={0} step="any" className="h-8" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onCommit()} />}
              onSave={(v) => save.mutate({value: Number(v || 0)})}
            />
            <EditableProperty
              label="Close date" field="expectedCloseDate"
              value={toDateInput(d.expectedCloseDate)}
              display={d.expectedCloseDate ? shortDate(d.expectedCloseDate) : <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <Input autoFocus type="date" className="h-8" value={value} onChange={(e) => onChange(e.target.value)} />}
              onSave={(v) => save.mutate({expectedCloseDate: v || null})}
            />
            {(pipelines.data?.length ?? 0) > 1 && (
              <EditableProperty
                label="Pipeline" field="pipelineId"
                value={d.pipelineId}
                display={d.pipeline.name}
                editor={({value, onChange}) => (
                  <NativeSelect autoFocus className="h-8" value={value} onChange={(e) => onChange(e.target.value)}>
                    {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </NativeSelect>
                )}
                onSave={(v) => save.mutate({pipelineId: v})}
              />
            )}
            <EditableProperty
              label="Owner" field="ownerId"
              value={d.ownerId}
              display={d.owner ? <span className="inline-flex items-center gap-1.5"><Avatar name={d.owner.name} color={d.owner.color} src={d.owner.avatarUrl} size="xs" />{d.owner.name}</span> : <span className="text-slate-400">Unassigned</span>}
              editor={({value, onChange}) => <UserSelect value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({ownerId: v})}
            />
            <ChoiceProperty label="Deal type" field="type" value={d.type} options={DEAL_TYPES} onSave={(v) => save.mutate({type: v})} />
            <ChoiceProperty label="Priority" field="priority" value={d.priority} options={DEAL_PRIORITIES} onSave={(v) => save.mutate({priority: v})} />
            <EditableProperty label="Tags" field="tags" value={d.tags} display={d.tags.length ? <span className="flex flex-wrap gap-1">{d.tags.map((t) => <Badge key={t} tone="teal">{t}</Badge>)}</span> : <span className="text-slate-400">—</span>} editor={({value, onChange}) => <TagInput entity="DEAL" value={value} onChange={onChange} />} onSave={(v) => save.mutate({tags: v})} />
            <Property label="Probability">{d.stage.probability}% · weighted {money((d.value * d.stage.probability) / 100, d.currency)}</Property>
            <Property label="Created">{shortDate(d.createdAt)}</Property>
            {fields.data && <CustomFieldProperties fields={fields.data} values={d.custom as Record<string, unknown>} currency={d.currency} onSave={(key, v) => save.mutate({custom: {[key]: v}})} />}
          </PropertyCard>

          <div className="grid gap-6 xl:hidden">
            <DealContactsCard deal={d} />
            <DealCompaniesCard deal={d} />
          </div>

          <PropertyCard title="Stage history">
            {d.stageChanges.map((ch, i) => {
              const next = d.stageChanges[i + 1];
              const days = Math.max(0, Math.round(((next ? new Date(next.createdAt) : new Date()).getTime() - new Date(ch.createdAt).getTime()) / 86400_000));
              return (
                <div key={ch.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                  <span className="size-2 rounded-full" style={{background: ch.toStage?.color ?? '#cbd5e1'}} />
                  <span className="flex-1 font-medium text-slate-700">{ch.toStage?.name ?? 'Removed stage'}</span>
                  <span className="text-xs text-muted-foreground">{shortDate(ch.createdAt)} · {days}d</span>
                </div>
              );
            })}
            {d.stageChanges.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No stage changes yet</p>}
          </PropertyCard>
          <AutomationsCard object="deal" recordId={dealId} />
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <div className="xl:hidden"><RecordTasks record={record} taskDefaults={taskDefaults} /></div>
          <div className="xl:hidden"><AttachmentsCard record={record} /></div>
          <div className="xl:hidden"><TicketsCard record={record} defaults={{deal: {id: d.id, title: d.title}, company: d.company, contact: people[0] ?? null}} /></div>
          <Composer
            record={record}
            emailTo={people.map((p) => p.email).filter(Boolean).slice(0, 1) as string[]}
            taskDefaults={taskDefaults}
            links={{
              deal: {id: d.id, title: d.title},
              company: d.company ? {id: d.company.id, name: d.company.name} : null,
              contact: people[0] ? {id: people[0].id, name: fullName(people[0])} : null,
              attendees: people,
            }}
          />
          <Timeline record={record} showRecord />
        </div>

        <div className="hidden content-start gap-6 xl:grid">
          <RecordTasks record={record} taskDefaults={taskDefaults} />
          <AttachmentsCard record={record} />
          <TicketsCard record={record} defaults={{deal: {id: d.id, title: d.title}, company: d.company, contact: people[0] ?? null}} />
          <DealContactsCard deal={d} />
          <DealCompaniesCard deal={d} />
        </div>
      </div>

      {losing && <LostDialog onClose={() => setLosing(false)} onConfirm={(reason) => (status.mutate({status: 'LOST', lostReason: reason}), setLosing(false))} />}
    </div>
    </PropertyHistoryProvider>
  );
}

const DEAL_TYPES = ['New business', 'Existing business', 'Renewal', 'Upsell'];
const DEAL_PRIORITIES = ['Low', 'Medium', 'High'];

function AddMenu({onCreate, children}: {onCreate: () => void; children: (close: () => void) => React.ReactNode}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm"><Plus /> Add</Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onCreate}><Plus /> Create new</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPicking(true)}><Link2 /> Add existing</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {picking && <div className="absolute inset-x-2 top-12 z-10">{children(() => setPicking(false))}</div>}
    </>
  );
}

/** People on the deal, with contact details, like HubSpot's Contacts card. */
function DealContactsCard({deal}: {deal: DealDetail}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const ids = deal.contacts.map((l) => l.contactId);
  const save = useApiMutation((contactIds: string[]) => api.patch(`/deals/${deal.id}`, {contactIds}), {invalidate: recordKeys});
  return (
    <div className="relative">
      <PropertyCard
        title={`Contacts (${deal.contacts.length})`}
        action={canEdit && (
          <AddMenu onCreate={() => create.open({kind: 'contact', defaults: {company: deal.company}})}>
            {(close) => <SingleContactPicker exclude={undefined} onChange={(id) => (id && !ids.includes(id) && save.mutate([...ids, id]), close())} />}
          </AddMenu>
        )}
      >
        {deal.contacts.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No contacts on this deal yet.</p>}
        {deal.contacts.map(({contact}) => (
          <div key={contact.id} className="group flex items-start gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
            <Avatar name={fullName(contact)} size="sm" />
            <Link to="/contacts/$contactId" params={{contactId: contact.id}} className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 hover:text-primary"><span className="truncate">{fullName(contact)}</span>{contact.score !== undefined && <ScoreBadge score={contact.score} compact />}</p>
              {contact.title && <p className="truncate text-xs text-muted-foreground">{contact.title}</p>}
              {contact.email && <p className="truncate text-xs text-muted-foreground">{contact.email}</p>}
              {contact.phone && <p className="truncate text-xs text-muted-foreground">{contact.phone}</p>}
            </Link>
            {canEdit && (
              <button aria-label={`Remove ${fullName(contact)}`} onClick={() => save.mutate(ids.filter((x) => x !== contact.id))} className="cursor-pointer rounded p-1 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-destructive">
                <X className="size-4" />
              </button>
            )}
          </div>
        ))}
      </PropertyCard>
    </div>
  );
}

/** Companies on the deal; one is primary (used on the board, reports and emails). */
function DealCompaniesCard({deal}: {deal: DealDetail}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const ids = deal.companies.map((l) => l.companyId);
  const primary = deal.companies.find((l) => l.isPrimary)?.companyId ?? null;
  const save = useApiMutation((v: {companyIds: string[]; companyId?: string | null}) => api.patch(`/deals/${deal.id}`, v), {invalidate: recordKeys});
  return (
    <div className="relative">
      <PropertyCard
        title={`Companies (${deal.companies.length})`}
        action={canEdit && (
          <AddMenu onCreate={() => create.open({kind: 'company'})}>
            {(close) => <SingleCompanyPicker onChange={(id) => (id && !ids.includes(id) && save.mutate({companyIds: [...ids, id], companyId: primary ?? id}), close())} />}
          </AddMenu>
        )}
      >
        {deal.companies.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">See the businesses involved in this deal.</p>}
        {deal.companies.map(({company, isPrimary}) => (
          <div key={company.id} className="group flex items-start gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-50 to-teal-50 text-sm font-extrabold text-primary">{company.name[0]}</span>
            <Link to="/companies/$companyId" params={{companyId: company.id}} className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-800 hover:text-primary">{company.name}</p>
              {company.domain && <p className="truncate text-xs text-muted-foreground">{company.domain}</p>}
              {company.phone && <p className="truncate text-xs text-muted-foreground">{company.phone}</p>}
              {isPrimary && <Badge tone="green" className="mt-1">Primary</Badge>}
            </Link>
            {canEdit && (
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                {!isPrimary && (
                  <button aria-label={`Make ${company.name} primary`} onClick={() => save.mutate({companyIds: ids, companyId: company.id})} className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold text-primary hover:bg-accent">Make primary</button>
                )}
                <button aria-label={`Remove ${company.name}`} onClick={() => save.mutate({companyIds: ids.filter((x) => x !== company.id), companyId: isPrimary ? null : primary})} className="cursor-pointer rounded p-1 text-slate-300 hover:text-destructive">
                  <X className="size-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </PropertyCard>
    </div>
  );
}
