import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Bell, Building2, CalendarClock, CheckCircle2, Handshake, Plus, Repeat, RotateCcw, Trash2, User, UserCheck} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {TASK_ICONS, useCreate} from '@/components/create-dialogs';
import {BulkBar, DataTable, SearchInput, type Column} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Checkbox, Input, NativeSelect} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {dueLabel, fullName, isOverdue, TASK_TYPES} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe, useSettings, useTeam} from '@/lib/queries';
import type {Task, TaskType} from '@/lib/types';
import {cn} from '@/lib/utils';

const TABS = [
  {id: 'all', label: 'All tasks', params: {status: 'open'}},
  {id: 'today', label: 'Due today', params: {status: 'open', due: 'today'}},
  {id: 'overdue', label: 'Overdue', params: {status: 'open', due: 'overdue'}},
  {id: 'upcoming', label: 'Upcoming', params: {status: 'open', due: 'upcoming'}},
  {id: 'nodate', label: 'No due date', params: {status: 'open', due: 'nodate'}},
  {id: 'done', label: 'Completed', params: {status: 'done'}},
] as const;

const PRIORITY: Record<string, {label: string; dot: string}> = {
  NONE: {label: '—', dot: 'bg-slate-300'},
  LOW: {label: 'Low', dot: 'bg-sky-400'},
  NORMAL: {label: 'Medium', dot: 'bg-amber-400'},
  HIGH: {label: 'High', dot: 'bg-rose-500'},
};

export const Route = createFileRoute('/_app/tasks')({
  validateSearch: z.object({
    tab: z.enum(['all', 'today', 'overdue', 'upcoming', 'nodate', 'done']).optional(),
    assignee: z.string().optional(), // user id | "all" | "none"; default: me
    type: z.string().optional(),
    priority: z.string().optional(),
    queue: z.string().optional(),
    q: z.string().optional(),
    sort: z.enum(['due', 'priority', 'created', 'title']).optional(),
  }),
  head: () => ({meta: [{title: pageTitle('Tasks')}]}),
  component: TasksPage,
});

function TasksPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({from: Route.fullPath});
  const set = (patch: Partial<typeof s>) => navigate({search: (prev) => ({...prev, ...patch}), replace: true});
  const {me, canEdit} = useMe();
  const team = useTeam();
  const settings = useSettings();
  const create = useCreate();
  const [qDraft, setQDraft] = useState(s.q ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tab = TABS.find((t) => t.id === (s.tab ?? 'all'))!;
  const assignee = s.assignee ?? me.id;

  const params = {
    ...tab.params,
    scope: 'all',
    assigneeId: assignee === 'all' ? undefined : assignee,
    type: s.type,
    priority: s.priority,
    queue: s.queue,
    q: s.q,
    sort: s.sort ?? 'due',
    tzOffset: new Date().getTimezoneOffset(),
  };
  const list = useQuery({
    queryKey: [...keys.tasks, 'page', params],
    queryFn: () => api.get<{rows: Task[]}>('/tasks', params),
    select: (d) => d.rows,
    placeholderData: keepPreviousData,
  });
  // Tab counters for the current assignee filter.
  const counts = useQuery({
    queryKey: [...keys.tasks, 'tab-counts', assignee],
    queryFn: async () => {
      const base = {scope: 'all', assigneeId: assignee === 'all' ? undefined : assignee, tzOffset: new Date().getTimezoneOffset()};
      const [today, overdue] = await Promise.all([
        api.get<{rows: Task[]}>('/tasks', {...base, status: 'open', due: 'today'}),
        api.get<{rows: Task[]}>('/tasks', {...base, status: 'open', due: 'overdue'}),
      ]);
      return {today: today.rows.length, overdue: overdue.rows.length};
    },
  });

  const toggle = useApiMutation((t: Task) => api.patch(`/tasks/${t.id}`, {done: !t.done}), {invalidate: [...recordKeys, keys.tasks]});
  const bulk = useApiMutation((body: {action: string; value?: string | null}) => api.post('/tasks/bulk', {ids: [...selected], ...body}), {
    invalidate: [...recordKeys, keys.tasks],
    success: 'Tasks updated',
    onSuccess: () => setSelected(new Set()),
  });

  const columns: Column<Task>[] = [
    {
      key: 'done',
      header: '',
      className: 'w-8 pr-0',
      cell: (t) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label={`Mark "${t.title}" ${t.done ? 'not done' : 'done'}`}
            checked={t.done}
            disabled={!canEdit || (toggle.isPending && toggle.variables?.id === t.id)}
            aria-busy={(toggle.isPending && toggle.variables?.id === t.id) || undefined}
            onCheckedChange={() => toggle.mutate(t)}
            className="rounded-full"
          />
        </span>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      cell: (t) => {
        const Icon = TASK_ICONS[t.type];
        return (
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0 text-slate-400" />
            {canEdit ? (
              <button
                type="button"
                onClick={(e) => (e.stopPropagation(), create.open({kind: 'task', task: t}))}
                className={cn('min-w-0 cursor-pointer truncate rounded text-left font-semibold text-slate-900 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30', t.done && 'text-muted-foreground line-through')}
              >
                {t.title}
              </button>
            ) : (
              <span className={cn('truncate font-semibold text-slate-900', t.done && 'text-muted-foreground line-through')}>{t.title}</span>
            )}
            {t.repeat && <Repeat className="size-3.5 shrink-0 text-slate-400" aria-label="Repeats" />}
            {t.reminderAt && !t.done && <Bell className="size-3.5 shrink-0 text-slate-400" aria-label="Has reminder" />}
          </div>
        );
      },
    },
    {
      key: 'associated',
      header: 'Associated with',
      hideBelow: 'md',
      cell: (t) => (
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs" onClick={(e) => e.stopPropagation()}>
          {t.contact && <Link to="/contacts/$contactId" params={{contactId: t.contact.id}} className="inline-flex items-center gap-1 text-primary hover:underline"><User className="size-3" />{fullName(t.contact)}</Link>}
          {t.company && <Link to="/companies/$companyId" params={{companyId: t.company.id}} className="inline-flex items-center gap-1 text-primary hover:underline"><Building2 className="size-3" />{t.company.name}</Link>}
          {t.deal && <Link to="/deals/$dealId" params={{dealId: t.deal.id}} className="inline-flex items-center gap-1 text-primary hover:underline"><Handshake className="size-3" />{t.deal.title}</Link>}
          {!t.contact && !t.company && !t.deal && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'due',
      header: 'Due date',
      cell: (t) => (
        <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', !t.done && isOverdue(t.dueAt) && 'font-semibold text-destructive')}>
          <CalendarClock className="size-3.5 text-slate-400" /> {dueLabel(t.dueAt)}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      hideBelow: 'lg',
      cell: (t) => <span className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', PRIORITY[t.priority]!.dot)} />{PRIORITY[t.priority]!.label}</span>,
    },
    {key: 'queue', header: 'Queue', hideBelow: 'xl', cell: (t) => (t.queue ? <Badge tone="neutral">{t.queue}</Badge> : <span className="text-muted-foreground">—</span>)},
    {
      key: 'assignee',
      header: 'Assigned to',
      hideBelow: 'lg',
      cell: (t) => (t.assignee ? <span className="inline-flex items-center gap-2"><Avatar name={t.assignee.name} color={t.assignee.color} src={t.assignee.avatarUrl} size="xs" />{t.assignee.name.split(' ')[0]}</span> : <span className="text-muted-foreground">Unassigned</span>),
    },
  ];

  const filtersActive = !!(s.type || s.priority || s.queue || s.q || (s.assignee && s.assignee !== me.id));

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Calls, emails, meetings and to-dos across every record."
        actions={canEdit && <Button size="sm" className="h-9" onClick={() => create.open({kind: 'task'})}><Plus /> Add task</Button>}
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-100 scrollbar-thin">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab.id === t.id}
            onClick={() => (set({tab: t.id === 'all' ? undefined : t.id}), setSelected(new Set()))}
            className={cn('-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/30', tab.id === t.id ? 'border-primary text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800')}
          >
            {t.label}
            {t.id === 'today' && !!counts.data?.today && <span className="rounded-full bg-blue-100 px-1.5 text-[11px] font-bold text-blue-700">{counts.data.today}</span>}
            {t.id === 'overdue' && !!counts.data?.overdue && <span className="rounded-full bg-rose-100 px-1.5 text-[11px] font-bold text-rose-700">{counts.data.overdue}</span>}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <FilterBar className="border-b border-slate-100 p-3" active={filtersActive} onClear={() => (setQDraft(''), navigate({search: {tab: s.tab, sort: s.sort}, replace: true}))}>
          <form noValidate onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
            <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search tasks, people, deals…" />
          </form>
          <NativeSelect size="sm" aria-label="Assigned to" value={assignee} onChange={(e) => set({assignee: e.target.value === me.id ? undefined : e.target.value})}>
            <option value={me.id}>Assigned to me</option>
            <option value="all">Anyone</option>
            <option value="none">Unassigned</option>
            {team.data?.filter((u) => u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Task type" value={s.type ?? ''} onChange={(e) => set({type: e.target.value || undefined})}>
            <option value="">Any type</option>
            {(Object.keys(TASK_TYPES) as TaskType[]).map((t) => <option key={t} value={t}>{TASK_TYPES[t]}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Priority" value={s.priority ?? ''} onChange={(e) => set({priority: e.target.value || undefined})}>
            <option value="">Any priority</option>
            <option value="HIGH">High</option>
            <option value="NORMAL">Medium</option>
            <option value="LOW">Low</option>
            <option value="NONE">None</option>
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Queue" value={s.queue ?? ''} onChange={(e) => set({queue: e.target.value || undefined})}>
            <option value="">Any queue</option>
            <option value="none">No queue</option>
            {settings.data?.settings.taskQueues.map((q) => <option key={q} value={q}>{q}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Sort by" value={s.sort ?? 'due'} onChange={(e) => set({sort: e.target.value as typeof s.sort})}>
            <option value="due">Sort: due date</option>
            <option value="priority">Sort: priority</option>
            <option value="created">Sort: newest</option>
            <option value="title">Sort: title</option>
          </NativeSelect>
        </FilterBar>
        <DataTable
          rows={list.data}
          columns={columns}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          selected={canEdit ? selected : undefined}
          onSelect={canEdit ? setSelected : undefined}
          onRowClick={(t) => canEdit && create.open({kind: 'task', task: t})}
          empty={
            <EmptyState
              icon={<CheckCircle2 />}
              title={filtersActive ? 'No tasks match the current filters' : tab.id === 'done' ? 'Nothing completed yet' : 'You’re all caught up'}
              description={filtersActive ? 'Try clearing a filter.' : 'Schedule follow-ups from any contact, company or deal so nothing slips.'}
              action={canEdit && tab.id !== 'done' && <Button onClick={() => create.open({kind: 'task'})}><Plus /> Add task</Button>}
            />
          }
        />
        {list.data && list.data.length > 0 && <p className="border-t border-slate-100 px-4 py-3 text-xs text-muted-foreground">{list.data.length} task{list.data.length === 1 ? '' : 's'}</p>}
      </Card>

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        {tab.id === 'done' ? (
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={bulk.isPending} pending={bulk.isPending && bulk.variables?.action === 'reopen'} pendingLabel="Reopening…" onClick={() => bulk.mutate({action: 'reopen'})}><RotateCcw /> Reopen</Button>
        ) : (
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={bulk.isPending} pending={bulk.isPending && bulk.variables?.action === 'complete'} pendingLabel="Completing…" onClick={() => bulk.mutate({action: 'complete'})}><CheckCircle2 /> Complete</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={bulk.isPending} pending={bulk.isPending && bulk.variables?.action === 'assign'} pendingLabel="Assigning…"><UserCheck /> Assign</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {team.data?.map((u) => <DropdownMenuItem key={u.id} onSelect={() => bulk.mutate({action: 'assign', value: u.id})}>{u.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <RescheduleMenu busy={bulk.isPending} onPick={(iso) => bulk.mutate({action: 'reschedule', value: iso})} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-rose-300 hover:bg-white/10 hover:text-rose-200" disabled={bulk.isPending} pending={bulk.isPending && bulk.variables?.action === 'delete'} pendingLabel="Deleting…"><Trash2 /> Delete</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuLabel>Delete {selected.size} tasks?</DropdownMenuLabel>
            <DropdownMenuItem destructive onSelect={() => bulk.mutate({action: 'delete'})}>Yes, delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </BulkBar>
    </div>
  );
}

function RescheduleMenu({onPick, busy}: {onPick: (iso: string) => void; busy?: boolean}) {
  const [custom, setCustom] = useState('');
  const at = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={busy}><CalendarClock /> Reschedule</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        <DropdownMenuItem onSelect={() => onPick(at(0))}>Today</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick(at(1))}>Tomorrow</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick(at(7))}>In 1 week</DropdownMenuItem>
        <div className="flex gap-1.5 p-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <Input type="date" className="h-8" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom date" />
          <Button size="sm" disabled={!custom} onClick={() => onPick(new Date(`${custom}T09:00`).toISOString())}>Set</Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
