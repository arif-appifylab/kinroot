import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {
  AlarmClock,
  ArrowLeft,
  ArrowRightLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  Eye,
  Flag,
  Globe,
  Handshake,
  Lock,
  Mail,
  MailWarning,
  MessageSquareReply,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Send,
  Smile,
  Star,
  StickyNote,
  Trash2,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import {useRef, useState} from 'react';
import {toast} from 'sonner';

import {fileIcon, fileSize} from '@/components/attachments';
import {RichEditor} from '@/components/email-editor';
import {MentionText} from '@/components/mentions';
import {RichText} from '@/components/rich-text';
import {CompanyPicker, ContactsPicker, DealPicker, TagInput, UserSelect} from '@/components/pickers';
import {PropertyHistoryButton, PropertyHistoryProvider} from '@/components/property-history';
import {ChoiceProperty, EditableProperty, Property, PropertyCard, SelectProperty} from '@/components/properties';
import {PriorityLabel, SlaBadge, Stars, StatusBadge, useCannedReplies, useTicketSettings} from '@/components/tickets/ticket-badges';
import {Badge} from '@/components/ui/badge';
import {useBinToast} from '@/components/recycle-bin-toast';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {LoadError} from '@/components/data-table';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip} from '@/components/ui/menu';
import {Avatar, Skeleton} from '@/components/ui/misc';
import {api, ApiError} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime, fullName} from '@/lib/format';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import {keys, recordKeys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {PRIORITY, SOURCE_LABELS, STATUS, TICKET_PRIORITIES, TICKET_STATUSES, type TicketStatus} from '@/lib/tickets';
import type {CompanyLite, ContactLite, TicketFile, TicketMessage, TicketRow} from '@/lib/types';
import {cn} from '@/lib/utils';
import {AutomationsCard} from '@/components/automations/record-tools';
import {uploadFile} from '@/lib/upload';

export const Route = createFileRoute('/_app/tickets/$ticketId')({
  head: () => ({meta: [{title: pageTitle('Ticket')}]}),
  component: TicketPage,
});

type Detail = {ticket: TicketRow; messages: TicketMessage[]};

const MAX_BYTES = 5 * 1024 * 1024;

function FileChips({files, onRemove}: {files: TicketFile[]; onRemove?: (id: string) => void}) {
  if (!files.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {files.map((f) => {
        const Icon = fileIcon(f.mimeType);
        return (
          <span key={f.id} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-card px-2.5 py-1.5 text-xs">
            <Icon className="size-3.5 shrink-0 text-slate-400" />
            <a href={`/site-api/crm/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-semibold text-slate-700 hover:text-primary">{f.name}</a>
            <span className="shrink-0 text-muted-foreground">{fileSize(f.size)}</span>
            {onRemove && <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.id)} className="cursor-pointer text-slate-400 hover:text-destructive"><X className="size-3.5" /></button>}
          </span>
        );
      })}
    </div>
  );
}

// ─── Thread ───

function EventLine({m, team}: {m: TicketMessage; team: Map<string, string>}) {
  const d = m.data as {type?: string; from?: string; to?: string | null; name?: string | null; sla?: string; dueAt?: string; rating?: number; comment?: string | null};
  const who = m.author?.name ?? 'System';
  let icon = ArrowRightLeft;
  let tone = 'text-slate-500';
  let text: React.ReactNode = null;
  if (d.type === 'status') text = <>{who} changed status: {STATUS[d.from as TicketStatus]?.label ?? d.from} → <span className="font-semibold text-slate-700">{STATUS[d.to as TicketStatus]?.label ?? d.to}</span></>;
  else if (d.type === 'assigned') {
    icon = UserPlus;
    text = d.to ? <>{who} assigned this to <span className="font-semibold text-slate-700">{d.name ?? team.get(d.to) ?? 'someone'}</span></> : <>{who} removed the assignee</>;
  } else if (d.type === 'priority') {
    icon = Flag;
    text = <>{who} changed priority: {PRIORITY[d.from as keyof typeof PRIORITY]?.label} → <span className="font-semibold text-slate-700">{PRIORITY[d.to as keyof typeof PRIORITY]?.label}</span></>;
  } else if (d.type === 'sla_breached') {
    icon = AlarmClock;
    tone = 'text-rose-600';
    text = <>SLA breached: {d.sla === 'first_response' ? 'first response' : 'resolution'} was due {d.dueAt ? dateTime(d.dueAt) : ''}</>;
  } else if (d.type === 'csat_sent') {
    icon = Mail;
    text = <>Satisfaction survey emailed to the contact</>;
  } else if (d.type === 'csat') {
    icon = Smile;
    tone = 'text-green-700';
    text = <>Customer rated this <Stars rating={d.rating ?? 0} className="mx-1 align-middle" />{d.comment ? <span className="italic">“{d.comment}”</span> : null}</>;
  } else return null;
  const Icon = icon;
  return (
    <li className={cn('flex items-center gap-2 px-1 text-xs', tone)}>
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
      <span className="ml-auto shrink-0 text-slate-400">{ago(m.createdAt)}</span>
    </li>
  );
}

function MessageItem({m, ticket}: {m: TicketMessage; ticket: TicketRow}) {
  if (m.kind === 'note') {
    return (
      <li className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {m.author && <Avatar name={m.author.name} color={m.author.color} src={m.author.avatarUrl} size="xs" className="ring-0" />}
          <span className="font-semibold text-slate-700">{m.author?.name ?? 'Someone'}</span> · internal note · {ago(m.createdAt)}
          <Lock className="ml-auto size-3.5 text-amber-500" aria-label="Only your team sees this" />
        </p>
        <RichText html={m.html}><MentionText text={m.body} /></RichText>
        <FileChips files={m.files} />
      </li>
    );
  }
  const inbound = m.direction === 'INBOUND';
  const name = inbound ? m.fromName || (ticket.contact ? fullName(ticket.contact) : m.fromEmail) || 'Customer' : m.author?.name ?? m.fromName ?? 'Team';
  const emailed = (m.data as {emailed?: boolean}).emailed;
  return (
    <li className={cn('rounded-xl border p-4 shadow-soft', inbound ? 'border-slate-100 bg-card' : 'border-blue-100 bg-blue-50/40')}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Avatar name={name ?? '?'} color={inbound ? '#0d9488' : m.author?.color} src={inbound ? null : m.author?.avatarUrl} size="xs" className="ring-0" />
        <span className="font-semibold text-slate-800">{name}</span>
        {inbound && m.fromEmail && <span className="truncate">{m.fromEmail}</span>}
        <Tooltip content={dateTime(m.createdAt)}><span>· {ago(m.createdAt)}</span></Tooltip>
        <span className="ml-auto flex flex-wrap gap-1">
          {m.via === 'portal' && <Badge tone="violet"><Globe /> Portal</Badge>}
          {inbound && m.via === 'email' && <Badge tone="teal"><Mail /> Email</Badge>}
          {!inbound && m.email?.status === 'FAILED' && <Badge tone="rose"><MailWarning /> Not delivered</Badge>}
          {!inbound && m.email && m.email.status !== 'FAILED' && (m.email.openCount > 0 ? <Badge tone="green"><Eye /> Opened</Badge> : <Badge tone="blue"><Mail /> Emailed</Badge>)}
          {!inbound && !m.email && emailed === false && <Badge tone="amber"><Globe /> Portal only</Badge>}
        </span>
      </div>
      <RichText html={m.html}>{m.body}</RichText>
      {m.email?.error && <p className="mt-2 text-xs font-medium text-destructive">{m.email.error}</p>}
      <FileChips files={m.files} />
    </li>
  );
}

// ─── Composer ───

function Composer({ticket}: {ticket: TicketRow}) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<TicketFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [after, setAfter] = useState<TicketStatus | ''>('WAITING_ON_CONTACT');
  const canned = useCannedReplies();
  const team = useTeam();
  const mentions = (team.data ?? []).filter((u) => u.active).map((u) => ({id: u.id, name: u.name}));
  const input = useRef<HTMLInputElement>(null);
  const email = ticket.contact?.email;
  const optedOut = ticket.contact?.emailOptOut;

  const send = useApiMutation(
    () =>
      api.post<{warning: string | null}>(`/tickets/${ticket.id}/messages`, {
        kind: mode,
        html: body,
        fileIds: files.map((f) => f.id),
        status: mode === 'reply' ? after || ticket.status : after || null,
      }),
    {
      invalidate: [keys.tickets, keys.timeline],
      success: (r) => r.warning ?? (mode === 'reply' ? (email ? 'Reply sent' : 'Reply saved') : 'Note added'),
      onSuccess: () => (setBody(''), setFiles([])),
    },
  );

  function switchMode(m: 'reply' | 'note') {
    setMode(m);
    setAfter(m === 'reply' ? 'WAITING_ON_CONTACT' : '');
  }

  async function upload(list: FileList | null) {
    for (const f of [...(list ?? [])]) {
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name}: files can be up to 5 MB`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const {file} = await uploadFile<{file: TicketFile}>(`/tickets/${ticket.id}/files`, f);
        setFiles((fs) => [...fs, file]);
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (input.current) input.current.value = '';
  }

  const empty = isEmptyHtml(body);
  const submit = () => (!empty || files.length > 0) && !send.isPending && uploading === 0 && send.mutate(undefined);

  return (
    <Card className={cn('overflow-hidden', mode === 'note' && 'ring-1 ring-amber-200')}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
        {([['reply', MessageSquareReply, 'Reply'], ['note', StickyNote, 'Internal note']] as const).map(([m, Icon, label]) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => switchMode(m)} className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors', mode === m ? (m === 'note' ? 'bg-amber-50 text-amber-700' : 'bg-accent text-primary') : 'text-slate-500 hover:text-slate-800')}>
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {mode === 'note' ? 'Only your team sees notes · Mention someone to notify them' : email ? `To ${email}` : 'No email on the contact: saved for the portal'}
        </span>
      </div>
      <div className="grid gap-2.5 p-3">
        {mode === 'reply' && optedOut && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">This contact opted out of email, so replies can't be emailed. Opt them back in on their contact page if they asked for help.</p>}
        <RichEditor
          key={mode}
          variant="text"
          compact
          minHeight={mode === 'note' ? 110 : 150}
          value={body}
          onChange={setBody}
          onSubmit={submit}
          ariaLabel={mode === 'note' ? 'Internal note' : 'Reply'}
          placeholder={mode === 'note' ? 'Share context with your team. Use Mention to notify someone.' : 'Write your reply… Merge field adds the contact’s name and more.'}
          mergeFields={mode === 'reply'}
          mentions={mode === 'note' ? mentions : undefined}
          className={mode === 'note' ? 'bg-amber-50/30' : undefined}
        />
        <FileChips files={files} onRemove={(id) => setFiles((fs) => fs.filter((f) => f.id !== id))} />
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="secondary" size="sm"><MessageSquareReply /> Canned replies <ChevronDown /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
              <DropdownMenuLabel>Insert a saved reply</DropdownMenuLabel>
              {canned.data?.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">None yet. Add them in Settings → Tickets.</p>}
              {canned.data?.map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => setBody((b) => (isEmptyHtml(b) ? '' : b) + (r.html ?? textToEditorHtml(r.body)))}>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{r.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{r.body.slice(0, 80)}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild><Link to="/settings/tickets">Manage canned replies</Link></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={input} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          <Button type="button" variant="ghost" size="sm" onClick={() => input.current?.click()} pending={uploading > 0} pendingLabel="Uploading…">
            <Paperclip /> Attach
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Then
              <NativeSelect aria-label="Status after sending" className="h-8 w-44 text-xs" value={after} onChange={(e) => setAfter(e.target.value as TicketStatus | '')}>
                <option value="">Keep status ({STATUS[ticket.status].label})</option>
                {TICKET_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </NativeSelect>
            </label>
            <Button type="button" size="sm" onClick={submit} disabled={(empty && !files.length) || uploading > 0} pending={send.isPending} pendingLabel={mode === 'note' ? 'Adding…' : 'Sending…'}>
              {mode === 'note' ? <StickyNote /> : <Send />} {mode === 'note' ? 'Add note' : 'Send reply'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Page ───

function TicketPage() {
  const {ticketId} = Route.useParams();
  const navigate = useNavigate();
  const {canEdit, isAdmin} = useMe();
  const team = useTeam();
  const settings = useTicketSettings();
  const [editingSubject, setEditingSubject] = useState<string | null>(null);
  const q = useQuery({queryKey: [...keys.tickets, 'detail', ticketId], queryFn: () => api.get<Detail>(`/tickets/${ticketId}`), refetchInterval: 30_000});
  const t = q.data?.ticket;
  const save = useApiMutation((patch: Record<string, unknown>) => api.patch(`/tickets/${t!.id}`, patch), {invalidate: [keys.tickets, ...recordKeys]});
  const binToast = useBinToast();
  const remove = useApiMutation(() => api.del<{binId: string | null}>(`/tickets/${t!.id}`), {invalidate: [keys.tickets, ...recordKeys], onSuccess: (r) => (binToast('Ticket', r.binId), navigate({to: '/tickets'}))});
  const subjectForm = useFormState({subject: editingSubject ?? ''}, {subject: [is.required('Enter a subject.'), is.maxLength(300)]});
  const saveSubject = () =>
    save.mutate({subject: (editingSubject ?? '').trim()}, {onSuccess: () => (setEditingSubject(null), subjectForm.reset()), onError: subjectForm.fail});

  if (q.isLoading || !t) {
    if (!q.error) return <Skeleton className="h-64 rounded-2xl" />;
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Card>
        <LoadError error={q.error} title={missing ? 'Ticket not found' : undefined} onRetry={missing ? undefined : () => q.refetch()} />
      </Card>
    );
  }

  const names = new Map((team.data ?? []).map((u) => [u.id, u.name]));
  const s = settings.data?.settings;
  const resolved = t.status === 'RESOLVED' || t.status === 'CLOSED';
  const due = (at: string | null, done: string | null, breached: string | null) =>
    done ? <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="size-3.5" /> {dateTime(done)}</span> : at ? <span className={cn(breached || new Date(at).getTime() < Date.now() ? 'font-semibold text-rose-700' : '')}>Due {dateTime(at)}</span> : <span className="text-slate-400">No target</span>;

  return (
    <PropertyHistoryProvider entity="ticket" id={t.id} name={`#${t.number} ${t.subject}`}>
    <div>
      <Link to="/tickets" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Tickets
      </Link>

      <Card className="relative mb-6 overflow-hidden p-5 sm:p-6">
        <div className="blob -top-24 -right-16 size-64 bg-blue-200/40" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-400">#{t.number} · {SOURCE_LABELS[t.source]} · opened {ago(t.createdAt)}</p>
            {editingSubject !== null ? (
              <form {...subjectForm.form(saveSubject)} className="mt-1 flex items-start gap-2">
                <h1 className="sr-only">{t.subject}</h1>
                <Field className="min-w-0 flex-1" error={subjectForm.error('subject')}>
                  <Input
                    autoFocus
                    aria-label="Subject"
                    value={editingSubject}
                    onChange={(e) => setEditingSubject(e.target.value)}
                    onBlur={subjectForm.blur('subject')}
                    onKeyDown={(e) => e.key === 'Escape' && !save.isPending && (setEditingSubject(null), subjectForm.reset())}
                    className="text-lg font-bold"
                  />
                </Field>
                <Button type="submit" size="sm" className="h-10" pending={save.isPending} pendingLabel="Saving…">Save</Button>
                <Button type="button" variant="ghost" size="sm" className="h-10" disabled={save.isPending} onClick={() => (setEditingSubject(null), subjectForm.reset())}>Cancel</Button>
              </form>
            ) : (
              <div className="group mt-1 flex items-start gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{t.subject}</h1>
                {canEdit && (
                  <button
                    type="button"
                    aria-label="Edit subject"
                    onClick={() => setEditingSubject(t.subject)}
                    className="mt-1.5 cursor-pointer rounded-md p-1 text-slate-400 opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:text-slate-700 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    <Pencil className="size-4" />
                  </button>
                )}
              </div>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={t.status} />
              <Badge tone={PRIORITY[t.priority].tone}><PriorityLabel priority={t.priority} /></Badge>
              <SlaBadge ticket={t} />
              {t.category && <Badge tone="outline">{t.category}</Badge>}
              {t.queue && <Badge tone="teal">{t.queue}</Badge>}
              {t.csatRating && <Badge tone="green"><Star /> {t.csatRating}/5</Badge>}
            </div>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {resolved ? (
                <Button variant="secondary" size="sm" pending={save.isPending && save.variables?.status === 'WAITING_ON_US'} pendingLabel="Reopening…" disabled={save.isPending} onClick={() => save.mutate({status: 'WAITING_ON_US'})}>Reopen</Button>
              ) : (
                <Button variant="success" size="sm" pending={save.isPending && save.variables?.status === 'RESOLVED'} pendingLabel="Resolving…" disabled={save.isPending} onClick={() => save.mutate({status: 'RESOLVED'})}><CheckCircle2 /> Resolve</Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="icon-sm" aria-label="More actions"><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {t.status !== 'CLOSED' && <DropdownMenuItem onSelect={() => save.mutate({status: 'CLOSED'})}><Lock /> Close ticket</DropdownMenuItem>}
                  {isAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete ticket #${t.number}?`, description: `It moves to the recycle bin with its conversation and attachments for 30 days.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <Card className="p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Avatar name={t.contact ? fullName(t.contact) : '?'} color="#0d9488" size="xs" className="ring-0" />
              <span className="font-semibold text-slate-800">{t.contact ? fullName(t.contact) : 'Unknown requester'}</span> opened this request · {dateTime(t.createdAt)}
            </p>
            {t.description ? <RichText html={t.descriptionHtml}>{t.description}</RichText> : <p className="text-sm text-slate-400">No description</p>}
          </Card>
          <ol className="grid gap-3">
            {q.data!.messages.map((m) => (m.kind === 'event' ? <EventLine key={m.id} m={m} team={names} /> : <MessageItem key={m.id} m={m} ticket={t} />))}
          </ol>
          {canEdit && <Composer ticket={t} />}
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <PropertyCard title="Properties" action={<PropertyHistoryButton compact />}>
            <SelectProperty label="Status" field="status" value={t.status} options={TICKET_STATUSES.map((x) => ({value: x.value, label: x.label}))} display={<StatusBadge status={t.status} />} onSave={(v) => v && save.mutate({status: v})} />
            <SelectProperty label="Priority" field="priority" value={t.priority} options={TICKET_PRIORITIES.map((x) => ({value: x.value, label: x.label}))} display={<PriorityLabel priority={t.priority} />} onSave={(v) => v && save.mutate({priority: v})} />
            <EditableProperty
              label="Assignee" field="assigneeId"
              value={t.assigneeId}
              display={t.assignee ? <span className="inline-flex items-center gap-1.5"><Avatar name={t.assignee.name} color={t.assignee.color} src={t.assignee.avatarUrl} size="xs" />{t.assignee.name}</span> : <span className="text-slate-400">Unassigned</span>}
              editor={({value, onChange}) => <UserSelect value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({assigneeId: v})}
            />
            <ChoiceProperty label="Category" field="category" value={t.category} options={s?.categories ?? []} onSave={(v) => save.mutate({category: v})} />
            <ChoiceProperty label="Queue" field="queue" value={t.queue} options={s?.queues ?? []} onSave={(v) => save.mutate({queue: v})} />
            <EditableProperty
              label="Tags" field="tags"
              value={t.tags}
              display={t.tags.length ? <span className="flex flex-wrap gap-1">{t.tags.map((x) => <Badge key={x} tone="teal">{x}</Badge>)}</span> : <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <TagInput entity="TICKET" value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({tags: v})}
            />
            <Property label="First response">{due(t.firstResponseDueAt, t.firstResponseAt, t.firstResponseBreachedAt)}</Property>
            <Property label="Resolution">{due(t.resolutionDueAt, t.resolvedAt, t.resolutionBreachedAt)}</Property>
            <Property label="Satisfaction">
              {t.csatRating ? (
                <span className="grid gap-1"><Stars rating={t.csatRating} />{t.csatComment && <span className="text-xs text-muted-foreground italic">“{t.csatComment}”</span>}</span>
              ) : t.csatSentAt ? (
                <span className="text-slate-500">Survey sent {ago(t.csatSentAt)}</span>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </Property>
          </PropertyCard>

          <PropertyCard title="Linked records">
            <EditableProperty<ContactLite | null>
              label="Contact" field="contactId"
              value={t.contact}
              display={t.contact ? <Link to="/contacts/$contactId" params={{contactId: t.contact.id}} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-primary hover:underline"><User className="size-3.5" />{fullName(t.contact)}</Link> : <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <ContactsPicker value={value ? [value] : []} onChange={(v) => onChange(v.at(-1) ?? null)} />}
              onSave={(v) => save.mutate({contactId: v?.id ?? null})}
            />
            {t.contact?.email && <Property label="Email"><a href={`mailto:${t.contact.email}`} className="text-primary hover:underline">{t.contact.email}</a></Property>}
            {t.contact?.phone && <Property label="Phone"><a href={`tel:${t.contact.phone}`} className="text-primary hover:underline">{t.contact.phone}</a></Property>}
            <EditableProperty<CompanyLite | null>
              label="Company" field="companyId"
              value={t.company}
              display={t.company ? <Link to="/companies/$companyId" params={{companyId: t.company.id}} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-primary hover:underline"><Building2 className="size-3.5" />{t.company.name}</Link> : <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <CompanyPicker value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({companyId: v?.id ?? null})}
            />
            <EditableProperty<{id: string; title: string} | null>
              label="Deal" field="dealId"
              value={t.deal}
              display={t.deal ? <Link to="/deals/$dealId" params={{dealId: t.deal.id}} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-primary hover:underline"><Handshake className="size-3.5" />{t.deal.title}</Link> : <span className="text-slate-400">—</span>}
              editor={({value, onChange}) => <DealPicker value={value} onChange={onChange} />}
              onSave={(v) => save.mutate({dealId: v?.id ?? null})}
            />
          </PropertyCard>
          <AutomationsCard object="ticket" recordId={t.id} />
        </div>
      </div>
    </div>
    </PropertyHistoryProvider>
  );
}
