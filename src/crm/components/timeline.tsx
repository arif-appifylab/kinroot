import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {
  ArchiveRestore,
  ArrowRightLeft,
  Flame,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock,
  Eye,
  Paperclip,
  History,
  LifeBuoy,
  Link2,
  ListMinus,
  ListPlus,
  Loader2,
  Mail,
  MailOpen,
  MapPin,
  MessageCircle,
  MessageSquareLock,
  MessageSquareText,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  Trophy,
  Users,
  Workflow,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';

import {api} from '@/lib/api';
import {ago, CALL_OUTCOMES, dateTime, dueLabel, fullName, LIFECYCLE, MEETING_OUTCOMES, shortDate} from '@/lib/format';
import {HISTORY_LABELS, humanizeField} from '@/lib/history';
import {keys, recordKeys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import type {Activity, ActivityComment, Interaction, InteractionKind, InteractionSnapshot, Note, Task} from '@/lib/types';
import {cn} from '@/lib/utils';

import {KINDS, LogForm, MEETING_TYPES, MeetingForm, type RecordLinks} from './activity-log';
import {useCreate, type TaskDefaults} from './create-dialogs';
import {fileIcon, fileSize} from './attachments';
import {EmailComposer} from './email-composer';
import {MentionField, MentionText} from './mentions';
import {PropertyHistoryButton} from './property-history';
import {TaskRow} from './tasks';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Card} from './ui/card';
import {confirm} from './ui/confirm';
import {Input} from './ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tooltip} from './ui/menu';
import {Avatar, EmptyState} from './ui/misc';
import {LoadError} from './data-table';

export type RecordRef = {contactId?: string; companyId?: string; dealId?: string};

const ICONS: Record<string, {icon: typeof Mail; cls: string}> = {
  note: {icon: StickyNote, cls: 'bg-amber-50 text-amber-600'},
  email_out: {icon: Mail, cls: 'bg-blue-50 text-blue-600'},
  email_in: {icon: MailOpen, cls: 'bg-teal-50 text-teal-600'},
  email_opened: {icon: Eye, cls: 'bg-sky-50 text-sky-600'},
  task_created: {icon: CalendarPlus, cls: 'bg-violet-50 text-violet-600'},
  task_done: {icon: CheckCircle2, cls: 'bg-green-50 text-green-600'},
  stage_changed: {icon: ArrowRightLeft, cls: 'bg-blue-50 text-blue-600'},
  deal_won: {icon: Trophy, cls: 'bg-green-50 text-green-600'},
  deal_lost: {icon: XCircle, cls: 'bg-rose-50 text-rose-600'},
  deal_created: {icon: Sparkles, cls: 'bg-blue-50 text-blue-600'},
  contact_created: {icon: Plus, cls: 'bg-slate-100 text-slate-500'},
  company_created: {icon: Plus, cls: 'bg-slate-100 text-slate-500'},
  associated: {icon: Link2, cls: 'bg-teal-50 text-teal-600'},
  file: {icon: Paperclip, cls: 'bg-slate-100 text-slate-600'},
  form_submitted: {icon: ClipboardList, cls: 'bg-indigo-50 text-indigo-600'},
  data_in_event: {icon: Zap, cls: 'bg-violet-50 text-violet-600'},
  ticket_created: {icon: LifeBuoy, cls: 'bg-violet-50 text-violet-600'},
  ticket_status: {icon: LifeBuoy, cls: 'bg-slate-100 text-slate-600'},
  ticket_reply: {icon: LifeBuoy, cls: 'bg-teal-50 text-teal-600'},
  conversation_comment: {icon: MessageSquareLock, cls: 'bg-amber-50 text-amber-600'},
  chat_conversation: {icon: MessageCircle, cls: 'bg-teal-50 text-teal-600'},
  meeting_rescheduled: {icon: CalendarClock, cls: 'bg-violet-50 text-violet-600'},
  meeting_canceled: {icon: XCircle, cls: 'bg-rose-50 text-rose-600'},
  list_added: {icon: ListPlus, cls: 'bg-blue-50 text-blue-600'},
  list_removed: {icon: ListMinus, cls: 'bg-slate-100 text-slate-500'},
  score_band: {icon: Flame, cls: 'bg-rose-50 text-rose-600'},
  restored: {icon: ArchiveRestore, cls: 'bg-teal-50 text-teal-600'},
  ...Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [`interaction_${k}`, {icon: v.icon, cls: v.cls}])),
};
const fallbackIcon = {icon: History, cls: 'bg-slate-100 text-slate-500'};

/** A field_changed value, readable inline (the Property history drawer has the full formatting). */
function inlineValue(field: string, v: unknown, team: Map<string, string>) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (field === 'ownerId' || field === 'assigneeId') return team.get(String(v)) ?? 'Someone';
  if (field === 'lifecycleStage') return LIFECYCLE[v as keyof typeof LIFECYCLE]?.label ?? String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(v)) return shortDate(v);
  return String(v);
}

// ─── Composer ───

function NoteComposer({record}: {record: RecordRef}) {
  const [body, setBody] = useState('');
  const save = useApiMutation(() => api.post('/notes', {body, ...record}), {invalidate: [keys.timeline, keys.notes], success: 'Note saved', onSuccess: () => setBody('')});
  return (
    <form noValidate onSubmit={(e) => (e.preventDefault(), body.trim() && !save.isPending && save.mutate(undefined))} className="grid gap-2.5">
      <MentionField
        aria-label="Note"
        value={body}
        onChange={setBody}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim() && !save.isPending && save.mutate(undefined)}
        rows={4}
        placeholder="Write a note… what did you learn, what was agreed, what's next? Type @ to mention a teammate."
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">⌘ + Enter to save · @ to mention</span>
        <Button type="submit" size="sm" disabled={!body.trim()} pending={save.isPending} pendingLabel="Saving…">
          Save note
        </Button>
      </div>
    </form>
  );
}

type ComposerTab = 'note' | 'email' | InteractionKind;
const COMPOSE_EVENT = 'crm:compose';

/** Header shortcuts (Note, Email, Call, Task, Meeting, More), HubSpot style. They drive the composer below. */
export function ActivityButtons({taskDefaults}: {taskDefaults: TaskDefaults}) {
  const create = useCreate();
  const {canEdit} = useMe();
  if (!canEdit) return null;
  const open = (tab: ComposerTab) => window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, {detail: tab}));
  const btn = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button key={label} type="button" onClick={onClick} className="group flex w-14 cursor-pointer flex-col items-center gap-1 text-xs font-medium text-slate-600 hover:text-primary">
      <span className="flex size-10 items-center justify-center rounded-full border border-border bg-card text-slate-600 transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:text-primary group-hover:shadow-soft [&_svg]:size-4">{icon}</span>
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {btn('Note', <StickyNote />, () => open('note'))}
      {btn('Email', <Mail />, () => open('email'))}
      {btn('Call', <Phone />, () => open('CALL'))}
      {btn('Task', <CalendarPlus />, () => create.open({kind: 'task', defaults: taskDefaults}))}
      {btn('Meeting', <CalendarClock />, () => open('MEETING'))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {btn('More', <MoreHorizontal />, () => {})}
        </DropdownMenuTrigger>
        <MoreLogItems onPick={open} />
      </DropdownMenu>
    </div>
  );
}

function MoreLogItems({onPick}: {onPick: (tab: ComposerTab) => void}) {
  return (
    <DropdownMenuContent align="start" className="w-60">
      <DropdownMenuLabel>Log an activity</DropdownMenuLabel>
      {(['CALL', 'MEETING', 'EMAIL', 'SMS', 'LINKEDIN', 'WHATSAPP', 'POSTAL'] as const).map((k) => {
        const Icon = KINDS[k].icon;
        return (
          <DropdownMenuItem key={k} onSelect={() => onPick(k)}>
            <Icon /> {KINDS[k].log}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  );
}

export function Composer({record, emailTo, taskDefaults, links}: {record: RecordRef; emailTo: string[]; taskDefaults: TaskDefaults; links: RecordLinks}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const [tab, setTab] = useState<ComposerTab>('note');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onCompose = (e: Event) => {
      setTab((e as CustomEvent<ComposerTab>).detail);
      ref.current?.scrollIntoView({behavior: 'smooth', block: 'center'});
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

  if (!canEdit) return null;
  const tabs: {id: ComposerTab | 'task'; label: string; icon: React.ReactNode}[] = [
    {id: 'note', label: 'Note', icon: <StickyNote />},
    {id: 'email', label: 'Email', icon: <Mail />},
    {id: 'CALL', label: 'Call', icon: <Phone />},
    {id: 'MEETING', label: 'Meeting', icon: <CalendarClock />},
    {id: 'task', label: 'Task', icon: <CalendarPlus />},
  ];
  const extra = tab !== 'note' && tab !== 'email' && tab !== 'CALL' && tab !== 'MEETING' ? tab : null;

  return (
    <Card ref={ref} className="scroll-mt-24 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl bg-slate-100/80 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => (t.id === 'task' ? create.open({kind: 'task', defaults: taskDefaults}) : setTab(t.id))}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap text-slate-500 transition-all hover:text-slate-800 [&_svg]:size-3.5',
                tab === t.id && 'bg-card text-slate-900 shadow-soft',
              )}
            >
              {t.icon} {t.label}
            </button>
          ))}
          {extra && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-card px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap text-slate-900 shadow-soft [&_svg]:size-3.5">
              {(() => {
                const Icon = KINDS[extra].icon;
                return <Icon />;
              })()}
              {KINDS[extra].label}
            </span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="shrink-0">More <ChevronDown /></Button>
          </DropdownMenuTrigger>
          <MoreLogItems onPick={setTab} />
        </DropdownMenu>
      </div>
      {tab === 'note' && <NoteComposer record={record} />}
      {tab === 'email' && <EmailComposer to={emailTo} context={record} compact />}
      {tab === 'MEETING' && <MeetingForm key="meeting" links={links} />}
      {tab !== 'note' && tab !== 'email' && tab !== 'MEETING' && <LogForm key={tab} kind={tab} links={links} />}
    </Card>
  );
}

// ─── Open tasks for a record ───

export function RecordTasks({record, taskDefaults}: {record: RecordRef; taskDefaults: TaskDefaults}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const tasks = useQuery({
    queryKey: [...keys.tasks, 'record', record],
    queryFn: () => api.get<{rows: Task[]}>('/tasks', {...record, status: 'open'}),
    select: (d) => d.rows,
  });
  const meetings = useQuery({
    queryKey: [...keys.timeline, 'upcoming-meetings', record],
    queryFn: () => api.get<{rows: Interaction[]}>('/interactions', {...record, kind: 'MEETING', upcoming: '1'}),
    select: (d) => d.rows,
  });
  const none = tasks.isSuccess && tasks.data.length === 0 && meetings.isSuccess && meetings.data.length === 0;
  return (
    <Card className={cn('overflow-hidden', none && 'border-amber-200 bg-amber-50/40')}>
      <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
        <h2 className="text-sm font-bold text-slate-900">Next steps</h2>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => create.open({kind: 'task', defaults: taskDefaults})}><Plus /> Add</Button>
        )}
      </div>
      <div className="px-1.5 pb-2">
        {none ? (
          <p className="px-3 py-2 text-sm text-amber-800">No next step scheduled. Records without one are the ones that go cold.</p>
        ) : (
          <>
            {meetings.data?.map((m) => (
              <div key={m.id} className="flex items-start gap-3 rounded-lg px-3 py-2.5">
                <span className="mt-0.5 flex size-4 items-center justify-center text-violet-500"><CalendarClock className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{m.title}</p>
                  <p className="text-xs text-muted-foreground">{dueLabel(m.occurredAt)}{m.durationMin ? ` · ${m.durationMin} min` : ''}{m.locationType ? ` · ${MEETING_TYPES[m.locationType as keyof typeof MEETING_TYPES]?.label ?? ''}` : ''}</p>
                  {m.location && /^https?:/.test(m.location) && <a href={m.location} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-primary hover:underline">Join meeting</a>}
                </div>
              </div>
            ))}
            {tasks.data?.map((t) => <TaskRow key={t.id} task={t} showRecord={false} />)}
          </>
        )}
      </div>
    </Card>
  );
}

// ─── Feed ───

/** An internal comment on an inbox conversation (never emailed). */
function ConversationCommentItem({activity}: {activity: Activity}) {
  const d = activity.data as {threadId?: string; body?: string};
  return (
    <Link to="/inbox" search={{thread: d.threadId}} className="block rounded-xl border border-amber-100 bg-amber-50/50 p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lift">
      <p className="line-clamp-4 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-800"><MentionText text={d.body ?? ''} /></p>
    </Link>
  );
}

/** One entry per website chat: how it started, how it ended, how much was said. */
function ChatConversationItem({activity}: {activity: Activity}) {
  const d = activity.data as {threadId?: string; status?: string; fromContact?: number; fromTeam?: number; first?: string; last?: string | null; lastFrom?: string; page?: string | null};
  return (
    <Link to="/inbox" search={{thread: d.threadId}} className="block rounded-xl border border-teal-100 bg-teal-50/40 p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lift">
      {d.first && <p className="line-clamp-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-800">“{d.first}”</p>}
      {d.status === 'CLOSED' && d.last && d.last !== d.first && (
        <p className="mt-1.5 line-clamp-2 text-xs text-slate-600"><span className="font-semibold">{d.lastFrom === 'team' ? 'Team' : 'Visitor'}:</span> {d.last}</p>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {d.fromContact ?? 0} from the visitor · {d.fromTeam ?? 0} from the team{d.status === 'OPEN' ? ' · open' : ''}
        {d.page ? <> · on <span className="break-all">{d.page.replace(/^https?:\/\//, '').slice(0, 60)}</span></> : null}
      </p>
    </Link>
  );
}

function FormItem({activity}: {activity: Activity}) {
  const d = activity.data as {formId?: string; answers?: {label: string; text: string}[]};
  const [all, setAll] = useState(false);
  const answers = d.answers ?? [];
  const shown = all ? answers : answers.slice(0, 4);
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3.5">
      <dl className="grid gap-2">
        {shown.map((a, i) => (
          <div key={i}>
            <dt className="text-xs font-semibold text-muted-foreground">{a.label}</dt>
            <dd className="text-sm whitespace-pre-wrap text-slate-800">{a.text}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex gap-3 text-xs font-semibold">
        {answers.length > 4 && (
          <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => setAll((v) => !v)}>
            {all ? 'Show less' : `Show all ${answers.length} answers`}
          </button>
        )}
        {d.formId && (
          <Link to="/forms/$formId" params={{formId: d.formId}} search={{tab: 'results'}} className="text-primary hover:underline">
            All responses
          </Link>
        )}
      </div>
    </div>
  );
}

function TicketItem({activity}: {activity: Activity}) {
  const d = activity.data as {number?: number; subject?: string; status?: string; body?: string | null; direction?: string};
  if (!d.number) return null;
  return (
    <Link to="/tickets/$ticketId" params={{ticketId: String(d.number)}} className="block rounded-xl border border-slate-100 bg-card p-3.5 shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-lift">
      <p className="truncate text-sm font-semibold text-slate-900"><span className="text-slate-400">#{d.number}</span> {d.subject}</p>
      {d.body && activity.type !== 'ticket_status' && <p className="mt-1 line-clamp-2 text-sm whitespace-pre-wrap text-slate-600">{d.body}</p>}
    </Link>
  );
}

function FileItem({activity}: {activity: Activity}) {
  const f = activity.data as {name?: string; size?: number; mimeType?: string};
  const Icon = fileIcon(f.mimeType ?? '');
  return (
    <a href={`/site-api/crm/files/${activity.refId}`} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-card px-3 py-2 transition-colors hover:border-primary/40">
      <Icon className="size-4 shrink-0 text-slate-400" />
      <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{f.name}</span>
      {f.size !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{fileSize(f.size)}</span>}
    </a>
  );
}

function NoteItem({activity}: {activity: Activity}) {
  const {me, isAdmin} = useMe();
  const [editing, setEditing] = useState(false);
  const body = (activity.data as {body?: string}).body ?? '';
  const [draft, setDraft] = useState(body);
  const update = useApiMutation((patch: Partial<Note>) => api.patch(`/notes/${activity.refId}`, patch), {invalidate: [keys.timeline, keys.notes], onSuccess: () => setEditing(false)});
  const remove = useApiMutation(() => api.del(`/notes/${activity.refId}`), {invalidate: [keys.timeline, keys.notes], success: 'Note deleted'});
  const mine = activity.actorId === me.id || isAdmin;
  const pinned = (activity.data as {pinned?: boolean}).pinned;

  return (
    <div className="group relative rounded-xl border border-amber-100 bg-amber-50/50 p-3.5">
      {pinned && <Pin className="absolute top-3 right-3 size-3.5 text-amber-500" aria-label="Pinned" />}
      {editing ? (
        <div className="grid gap-2">
          <MentionField value={draft} onChange={setDraft} rows={4} autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => (setEditing(false), setDraft(body))} disabled={update.isPending}>Cancel</Button>
            <Button size="sm" onClick={() => update.mutate({body: draft})} disabled={!draft.trim()} pending={update.isPending && update.variables?.body !== undefined} pendingLabel="Saving…">Save</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800"><MentionText text={body} /></p>
      )}
      {mine && !editing && (
        <div className="mt-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(true)} disabled={update.isPending || remove.isPending}><Pencil /> Edit</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => update.mutate({pinned: !pinned})} disabled={remove.isPending} pending={update.isPending} pendingLabel={pinned ? 'Unpinning…' : 'Pinning…'}>{pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}</Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:bg-rose-50 hover:text-destructive"
            disabled={update.isPending}
            pending={remove.isPending}
            pendingLabel="Deleting…"
            onClick={async () => (await confirm({title: 'Delete this note?', description: "This can't be undone.", confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function EmailItem({activity}: {activity: Activity}) {
  const e = activity.email;
  if (!e) return null;
  return (
    <Link to="/inbox" search={{thread: e.threadId}} className="block rounded-xl border border-slate-100 bg-card p-3.5 shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-lift">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 max-w-full truncate text-sm font-semibold text-slate-900">{e.subject}</p>
        {e.status === 'FAILED' && <Badge tone="rose">Failed</Badge>}
        {e.direction === 'OUTBOUND' && e.status === 'SENT' && (
          <>
            {e.openCount > 0 ? <Badge tone="green"><Eye /> Opened {e.openCount}×</Badge> : <Badge tone="neutral">Not opened yet</Badge>}
            {e.clickCount > 0 && <Badge tone="blue"><MousePointerClick /> {e.clickCount} click{e.clickCount > 1 ? 's' : ''}</Badge>}
          </>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {e.direction === 'INBOUND' ? `From ${e.fromName ?? e.fromEmail}` : `To ${e.to.join(', ')}`}
      </p>
      {e.text && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{e.text}</p>}
      {e.error && <p className="mt-2 text-xs font-medium text-destructive">{e.error}</p>}
    </Link>
  );
}

function InteractionItem({activity}: {activity: Activity}) {
  const {me, isAdmin} = useMe();
  const d = activity.data as InteractionSnapshot;
  const mine = activity.actorId === me.id || isAdmin;
  const update = useApiMutation((patch: Record<string, unknown>) => api.patch(`/interactions/${activity.refId}`, patch), {invalidate: recordKeys});
  const remove = useApiMutation(() => api.del(`/interactions/${activity.refId}`), {invalidate: recordKeys, success: 'Activity deleted'});
  const upcoming = new Date(d.occurredAt).getTime() > Date.now();
  const outcomes = d.kind === 'CALL' ? CALL_OUTCOMES : d.kind === 'MEETING' ? MEETING_OUTCOMES : null;
  const DirIcon = d.direction === 'INBOUND' ? PhoneIncoming : PhoneOutgoing;

  return (
    <div className="group rounded-xl border border-slate-100 bg-card p-3.5 shadow-soft">
      {d.body && <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-700">{d.body}</p>}
      <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4', d.body && 'mt-3 border-t border-slate-100 pt-3')}>
        <div>
          <dt className="text-muted-foreground">{d.kind === 'MEETING' ? 'Start' : 'Date'}</dt>
          <dd className="font-medium text-slate-800">{dateTime(d.occurredAt)}</dd>
        </div>
        {outcomes && (
          <div>
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>
              <select
                aria-label="Outcome"
                disabled={!mine || update.isPending}
                aria-busy={update.isPending || undefined}
                value={d.outcome ?? ''}
                onChange={(e) => update.mutate({outcome: e.target.value || null})}
                className="-ml-1 cursor-pointer rounded-md bg-transparent px-1 py-0.5 font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-default"
              >
                <option value="">Select outcome</option>
                {outcomes.map((o) => <option key={o}>{o}</option>)}
              </select>
            </dd>
          </div>
        )}
        {d.direction && (
          <div>
            <dt className="text-muted-foreground">Direction</dt>
            <dd className="inline-flex items-center gap-1 font-medium text-slate-800"><DirIcon className="size-3" /> {d.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}</dd>
          </div>
        )}
        {d.durationMin ? (
          <div>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="inline-flex items-center gap-1 font-medium text-slate-800"><Clock className="size-3" /> {d.durationMin} min</dd>
          </div>
        ) : null}
        {(d.location || d.locationType) && (
          <div className="col-span-2">
            <dt className="text-muted-foreground">{d.locationType ? MEETING_TYPES[d.locationType].label : 'Location'}</dt>
            <dd className="inline-flex min-w-0 items-center gap-1 font-medium text-slate-800">
              {(() => {
                const Icon = d.locationType ? MEETING_TYPES[d.locationType].icon : MapPin;
                return <Icon className="size-3 shrink-0" />;
              })()}
              {!d.location ? (
                <span className="text-slate-400">No details</span>
              ) : /^https?:/.test(d.location) ? (
                <a href={d.location} target="_blank" rel="noopener noreferrer" className="truncate text-primary hover:underline">{upcoming ? 'Join meeting' : d.location}</a>
              ) : d.locationType === 'PHONE' ? (
                <a href={`tel:${d.location}`} className="text-primary hover:underline">{d.location}</a>
              ) : d.locationType === 'IN_PERSON' ? (
                <a href={`https://www.google.com/maps/search/${encodeURIComponent(d.location)}`} target="_blank" rel="noopener noreferrer" className="truncate text-primary hover:underline">{d.location}</a>
              ) : (
                <span className="truncate">{d.location}</span>
              )}
            </dd>
          </div>
        )}
        {d.attendees.length > 0 && (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Attendees</dt>
            <dd className="inline-flex flex-wrap items-center gap-1 font-medium text-slate-800">
              <Users className="size-3" />
              {d.attendees.map((p, i) => (
                <span key={p.id}>
                  <Link to="/contacts/$contactId" params={{contactId: p.id}} className="hover:text-primary">{p.name}</Link>
                  {i < d.attendees.length - 1 ? ',' : ''}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {upcoming && d.kind === 'MEETING' && <Badge tone="violet" className="mt-3"><CalendarClock /> Upcoming</Badge>}
      {mine && (
        <div className="mt-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive hover:bg-rose-50 hover:text-destructive" pending={remove.isPending} pendingLabel="Deleting…" onClick={async () => (await confirm({title: 'Delete this activity?', description: "This can't be undone.", confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</Button>
        </div>
      )}
    </div>
  );
}

/** Comment thread under any timeline event. */
function Comments({activityId, count}: {activityId: string; count: number}) {
  const {me, isAdmin, canEdit} = useMe();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const list = useQuery({
    queryKey: [...keys.timeline, 'comments', activityId],
    queryFn: () => api.get<{rows: ActivityComment[]}>(`/comments/activity/${activityId}`),
    select: (d) => d.rows,
    enabled: open,
  });
  const add = useApiMutation(() => api.post(`/comments/activity/${activityId}`, {body}), {invalidate: [keys.timeline], onSuccess: () => setBody('')});
  const remove = useApiMutation((id: string) => api.del(`/comments/${id}`), {invalidate: [keys.timeline]});

  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
        <MessageSquareText className="size-3.5" />
        {open ? 'Hide comments' : count ? `${count} comment${count > 1 ? 's' : ''}` : 'Add comment'}
      </button>
      {open && (
        <div className="mt-2 grid gap-2 border-l-2 border-slate-100 pl-3">
          {list.data?.map((c) => (
            <div key={c.id} className="group/c flex gap-2">
              {c.author && <Avatar name={c.author.name} color={c.author.color} src={c.author.avatarUrl} size="xs" className="mt-0.5 ring-0" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground"><span className="font-semibold text-slate-700">{c.author?.name ?? 'Someone'}</span> · {ago(c.createdAt)}</p>
                <p className="text-sm whitespace-pre-wrap text-slate-700"><MentionText text={c.body} /></p>
              </div>
              {(c.authorId === me.id || isAdmin) && (
                <button
                  type="button"
                  aria-label="Delete comment"
                  disabled={remove.isPending}
                  aria-busy={(remove.isPending && remove.variables === c.id) || undefined}
                  onClick={async () => (await confirm({title: 'Delete this comment?', description: "This can't be undone.", confirmLabel: 'Delete', destructive: true})) && remove.mutate(c.id)}
                  className="cursor-pointer self-start rounded p-1 text-slate-300 opacity-0 outline-none group-hover/c:opacity-100 group-focus-within/c:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed"
                >
                  {remove.isPending && remove.variables === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <form noValidate onSubmit={(e) => (e.preventDefault(), body.trim() && !add.isPending && add.mutate(undefined))} className="flex gap-2">
              <MentionField as="input" aria-label="Comment" value={body} onChange={setBody} placeholder="Leave a comment and mention a teammate with @" className="h-9" />
              <Button type="submit" size="sm" className="h-9" disabled={!body.trim()} pending={add.isPending} pendingLabel="Sending…">Comment</Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityItem({activity, showRecord, record}: {activity: Activity; showRecord?: boolean; record: RecordRef}) {
  const {icon: Icon, cls} = ICONS[activity.type] ?? fallbackIcon;
  const changes = (activity.data as {changes?: {field: string; from: unknown; to: unknown}[]}).changes;
  // Written by an automation step: shown as the actor instead of the person / "System".
  const automation = (activity.data as {automation?: {id: string; name: string}}).automation;
  const commentable = activity.type === 'note' || activity.type.startsWith('interaction_') || activity.type === 'email_out' || activity.type === 'email_in';
  const team = useTeam();
  const names = new Map((team.data ?? []).map((u) => [u.id, u.name]));
  const labels = HISTORY_LABELS[activity.dealId ? 'deal' : activity.companyId && !activity.contactId ? 'company' : 'contact'];
  return (
    <li className="relative flex min-w-0 gap-3 pb-6 last:pb-0">
      <span className="absolute top-9 bottom-0 left-[17px] w-px bg-slate-200 group-last:hidden" aria-hidden />
      <span className={cn('relative z-10 flex size-9 shrink-0 items-center justify-center rounded-xl ring-4 ring-background', cls)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere] text-slate-800">{activity.title}</p>
          {showRecord && activity.contact && activity.contact.id !== record.contactId && (
            <Link to="/contacts/$contactId" params={{contactId: activity.contact.id}} className="text-xs font-medium text-primary hover:underline">{fullName(activity.contact)}</Link>
          )}
          {showRecord && activity.deal && activity.deal.id !== record.dealId && (
            <Link to="/deals/$dealId" params={{dealId: activity.deal.id}} className="text-xs font-medium text-primary hover:underline">{activity.deal.title}</Link>
          )}
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {automation ? <Workflow className="size-3.5 text-indigo-500" /> : activity.actor && <Avatar name={activity.actor.name} color={activity.actor.color} src={activity.actor.avatarUrl} size="xs" className="ring-0" />}
          {automation ? `Automation: ${automation.name}` : activity.actor?.name ?? 'System'} ·{' '}
          <Tooltip content={dateTime(activity.createdAt)}>
            <span>{new Date(activity.createdAt).getTime() > Date.now() ? dueLabel(activity.createdAt) : ago(activity.createdAt)}</span>
          </Tooltip>
        </p>
        {activity.type === 'note' && <div className="mt-2"><NoteItem activity={activity} /></div>}
        {activity.type.startsWith('email_') && activity.type !== 'email_opened' && <div className="mt-2"><EmailItem activity={activity} /></div>}
        {activity.type.startsWith('interaction_') && <div className="mt-2"><InteractionItem activity={activity} /></div>}
        {activity.type === 'file' && <div className="mt-2"><FileItem activity={activity} /></div>}
        {activity.type === 'form_submitted' && <div className="mt-2"><FormItem activity={activity} /></div>}
        {activity.type === 'conversation_comment' && <div className="mt-2"><ConversationCommentItem activity={activity} /></div>}
        {activity.type === 'chat_conversation' && <div className="mt-2"><ChatConversationItem activity={activity} /></div>}
        {activity.type.startsWith('ticket_') && <div className="mt-2"><TicketItem activity={activity} /></div>}
        {changes && changes.length > 0 && (
          <ul className="mt-1.5 grid gap-0.5 text-xs text-slate-500">
            {changes.slice(0, 5).map((ch) => (
              <li key={ch.field} className="line-clamp-2 [overflow-wrap:anywhere]">
                <span className="font-medium text-slate-600">{labels[ch.field] ?? humanizeField(ch.field)}</span>: {inlineValue(ch.field, ch.from, names)} → <span className="text-slate-700">{inlineValue(ch.field, ch.to, names)}</span>
              </li>
            ))}
          </ul>
        )}
        {commentable && <Comments activityId={activity.id} count={activity._count?.comments ?? 0} />}
      </div>
    </li>
  );
}

const FILTERS = [
  ['all', 'All'],
  ['notes', 'Notes'],
  ['emails', 'Emails'],
  ['calls', 'Calls'],
  ['meetings', 'Meetings'],
  ['tasks', 'Tasks'],
  ['messages', 'Messages'],
  ['forms', 'Forms'],
  ['tickets', 'Tickets'],
] as const;
/** All … Tasks are tabs while they fit; Messages, Forms and Tickets always sit under More. */
const PRIMARY = 6;

export type TimelineGroup = (typeof FILTERS)[number][0];
type Counts = Record<TimelineGroup, number>;
type Filter = (typeof FILTERS)[number];

const tabClass = (selected: boolean) =>
  cn(
    'inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:rounded-t-md focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-inset',
    selected ? 'border-primary text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800',
  );

function Count({n}: {n: number | undefined}) {
  if (n === undefined) return null;
  return <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-bold text-slate-500 tabular-nums">{n > 999 ? '999+' : n}</span>;
}

/**
 * Filter tabs that never scroll: All plus the primary groups that have entries
 * for this record, as many as fit the measured width; the rest (and every
 * secondary group with entries) go in "More". The selected tab always stays in
 * view, either as a tab or as the More button's label. Arrow keys / Home / End
 * move between tabs (tablist pattern).
 */
function FeedTabs({group, onChange, counts, panelId}: {group: TimelineGroup; onChange: (g: TimelineGroup) => void; counts: Counts | undefined; panelId: string}) {
  const uid = useId();
  const shown = FILTERS.filter(([v]) => v === 'all' || v === group || !counts || counts[v] > 0);
  const primary = shown.filter(([v]) => FILTERS.findIndex((f) => f[0] === v) < PRIMARY);
  const secondary = shown.filter(([v]) => FILTERS.findIndex((f) => f[0] === v) >= PRIMARY);
  const bar = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const [fit, setFit] = useState(primary.length);
  const signature = shown.map(([v]) => `${v}:${counts?.[v] ?? ''}`).join(',');

  useLayoutEffect(() => {
    const el = bar.current;
    const m = ruler.current;
    if (!el || !m) return;
    const measure = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      const more = widths[primary.length] ?? 0;
      const gap = 4;
      const width = (n: number) => widths.slice(0, n).reduce((a, w) => a + w + gap, 0);
      let n = primary.length;
      while (n > 1 && width(n) + (n < primary.length || secondary.length ? more : 0) > el.clientWidth) n--;
      setFit(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  let visible: Filter[] = primary.slice(0, fit);
  // A selected tab that no longer fits takes the last visible slot (All stays first).
  if (!visible.some(([v]) => v === group) && primary.some(([v]) => v === group) && visible.length > 1) visible = [...visible.slice(0, -1), primary.find(([v]) => v === group)!];
  const overflow = [...primary.filter((f) => !visible.includes(f)), ...secondary];
  const hiddenActive = overflow.find(([v]) => v === group);

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const last = visible.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    const value = visible[next]![0];
    onChange(value);
    tabs.current.get(value)?.focus();
  };

  const moreLabel = (
    <>
      {hiddenActive ? hiddenActive[1] : 'More'}
      {hiddenActive && <Count n={counts?.[hiddenActive[0]]} />}
      <ChevronDown className="size-3.5" />
    </>
  );

  return (
    // Clipped, so neither the ruler nor a tab can ever widen the page.
    <div className="relative mb-5 overflow-hidden">
      {/* Off-screen copy of every primary tab and the More button, to measure what fits. */}
      <div ref={ruler} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-1 whitespace-nowrap">
        {primary.map(([v, label]) => <span key={v} className={tabClass(false)}>{label}<Count n={counts?.[v]} /></span>)}
        <span className={tabClass(false)}>Messages<Count n={99} /><ChevronDown className="size-3.5" /></span>
      </div>
      <div ref={bar} className="flex min-w-0 items-end gap-1 shadow-[inset_0_-1px_0_var(--color-slate-100)]">
        <div role="tablist" aria-label="Filter activity" className="flex min-w-0 items-end gap-1">
          {visible.map(([v, label], i) => (
            <button
              key={v}
              ref={(el) => void (el ? tabs.current.set(v, el) : tabs.current.delete(v))}
              id={`${uid}-${v}`}
              type="button"
              role="tab"
              aria-selected={group === v}
              aria-controls={panelId}
              tabIndex={group === v || (hiddenActive && i === 0) ? 0 : -1}
              onClick={() => onChange(v)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={tabClass(group === v)}
            >
              {label}
              <Count n={counts?.[v]} />
            </button>
          ))}
        </div>
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={tabClass(!!hiddenActive)} aria-label={hiddenActive ? `More filters, showing ${hiddenActive[1]}` : 'More filters'}>{moreLabel}</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {overflow.map(([v, label]) => (
                <DropdownMenuItem key={v} onSelect={() => onChange(v)} className={cn(group === v && 'text-primary')}>
                  <span className="flex-1">{label}</span>
                  <Count n={counts?.[v]} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

const EMPTY: Record<TimelineGroup, string> = {all: 'No activity yet', notes: 'No notes yet', emails: 'No emails yet', calls: 'No calls yet', meetings: 'No meetings yet', tasks: 'No tasks yet', messages: 'No messages yet', forms: 'No form submissions yet', tickets: 'No tickets yet'};

export function Timeline({record, showRecord}: {record: RecordRef; showRecord?: boolean}) {
  const [group, setGroup] = useState<TimelineGroup>('all');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const panelId = useId();
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const counts = useQuery({
    queryKey: [...keys.timeline, 'counts', record],
    queryFn: () => api.get<{counts: Counts}>('/timeline/counts', record),
    select: (d) => d.counts,
  });
  const feed = useInfiniteQuery({
    queryKey: [...keys.timeline, record, group, search],
    queryFn: ({pageParam}) => api.get<{rows: Activity[]; nextCursor: string | null}>('/timeline', {...record, group, q: search, before: pageParam}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = feed.data?.pages.flatMap((p) => p.rows) ?? [];
  const now = Date.now();
  const upcoming = rows.filter((a) => new Date(a.createdAt).getTime() > now).reverse();
  const past = rows.filter((a) => new Date(a.createdAt).getTime() <= now);
  const label = FILTERS.find(([v]) => v === group)![1];
  const searchInput = (extra: string, autoFocus?: boolean) => (
    <div className={cn('relative', extra)}>
      <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-slate-400" />
      <Input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setSearching(false))}
        placeholder="Search activities"
        className="h-8 rounded-full pl-8 text-xs"
        aria-label="Search activities"
      />
    </div>
  );

  return (
    // A container, so the header adapts to the column it sits in, not the window.
    <div className="@container min-w-0">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <h2 className="mr-auto text-base font-bold text-slate-900">Activity</h2>
        {/* Search shares the row only when there's room; otherwise it opens on its own row. */}
        {searchInput('hidden w-56 @lg:block')}
        <Button variant="ghost" size="icon-sm" className="@lg:hidden" aria-label="Search activities" aria-expanded={searching || !!q} onClick={() => setSearching((v) => !v)}>
          <Search />
        </Button>
        <PropertyHistoryButton labelClassName="hidden @sm:inline" />
      </div>
      {(searching || q) && searchInput('mb-3 @lg:hidden', searching)}
      <FeedTabs group={group} onChange={setGroup} counts={counts.data} panelId={panelId} />
      <div id={panelId} role="tabpanel" aria-label={label} className="min-w-0">
        {feed.isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-primary" /></div>
        ) : feed.isError && rows.length === 0 ? (
          <LoadError error={feed.error} onRetry={() => feed.refetch()} title="Activity could not be loaded" />
        ) : rows.length === 0 ? (
          <EmptyState icon={<History />} title={search ? 'No matching activity' : EMPTY[group]} description={search ? 'Try a different search.' : group === 'all' ? 'Notes, emails, calls, meetings, tasks and changes will show up here.' : undefined} />
        ) : (
          <>
            {upcoming.length > 0 && (
              <>
                <h3 className="mb-3 text-xs font-bold tracking-wider text-slate-400 uppercase">Upcoming</h3>
                <ol className="mb-6 [&>li:last-child>span:first-child]:hidden">
                  {upcoming.map((a) => <ActivityItem key={a.id} activity={a} showRecord={showRecord} record={record} />)}
                </ol>
              </>
            )}
            {past.length > 0 && upcoming.length > 0 && <h3 className="mb-3 text-xs font-bold tracking-wider text-slate-400 uppercase">Past</h3>}
            <ol className="[&>li:last-child>span:first-child]:hidden">
              {past.map((a) => <ActivityItem key={a.id} activity={a} showRecord={showRecord} record={record} />)}
            </ol>
          </>
        )}
        {feed.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => feed.fetchNextPage()} pending={feed.isFetchingNextPage} pendingLabel="Loading…">
              Load older activity
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
