import {Link} from '@tanstack/react-router';
import {Bell, Building2, Handshake, MoreHorizontal, Pencil, Repeat, Trash2, User} from 'lucide-react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {dateTime, dueLabel, fullName, isOverdue, TASK_TYPES} from '@/lib/format';
import {keys, recordKeys, useApiMutation, useMe} from '@/lib/queries';
import type {Task} from '@/lib/types';
import {cn} from '@/lib/utils';

import {TASK_ICONS, useCreate} from './create-dialogs';
import {Badge} from './ui/badge';
import {confirm} from './ui/confirm';
import {Checkbox} from './ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from './ui/menu';
import {Avatar} from './ui/misc';
import {Tooltip} from './ui/menu';

export function TaskRow({task, compact, showRecord = true}: {task: Task; compact?: boolean; showRecord?: boolean}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const Icon = TASK_ICONS[task.type];
  const overdue = !task.done && isOverdue(task.dueAt);

  const toggle = useApiMutation((done: boolean) => api.patch<{next: Task | null}>(`/tasks/${task.id}`, {done}), {
    invalidate: [...recordKeys, keys.tasks],
    onSuccess: (r, done) => {
      if (!done) return;
      if (r.next) return toast.success(`Task completed · next one due ${dueLabel(r.next.dueAt)}`);
      // Pipedrive's habit: finishing a step prompts the next one.
      toast.success('Task completed', {
        action: {
          label: 'Schedule next',
          onClick: () =>
            create.open({
              kind: 'task',
              defaults: {
                contactId: task.contactId ?? undefined,
                contactName: task.contact ? fullName(task.contact) : undefined,
                companyId: task.companyId ?? undefined,
                companyName: task.company?.name,
                dealId: task.dealId ?? undefined,
                dealTitle: task.deal?.title,
                label: task.deal?.title ?? (task.contact ? fullName(task.contact) : task.company?.name),
              },
            }),
        },
      });
    },
  });
  const remove = useApiMutation(() => api.del(`/tasks/${task.id}`), {invalidate: [...recordKeys, keys.tasks], success: 'Task deleted'});

  return (
    <div className={cn('group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-slate-50', task.done && 'opacity-60')}>
      <Checkbox className="mt-0.5" checked={task.done} disabled={!canEdit || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v === true)} aria-label={`Mark "${task.title}" ${task.done ? 'not done' : 'done'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Tooltip content={TASK_TYPES[task.type]}>
            <Icon className="size-3.5 shrink-0 text-slate-400" />
          </Tooltip>
          {canEdit ? (
            <button
              type="button"
              onClick={() => create.open({kind: 'task', task})}
              aria-label={`Edit task: ${task.title}`}
              className={cn('min-w-0 cursor-pointer truncate rounded text-left text-sm font-medium text-slate-800 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30', task.done && 'line-through')}
            >
              {task.title}
            </button>
          ) : (
            <p className={cn('truncate text-sm font-medium text-slate-800', task.done && 'line-through')}>{task.title}</p>
          )}
          {task.priority === 'HIGH' && !task.done && <Badge tone="rose">High</Badge>}
          {task.repeat && (
            <Tooltip content="Repeats">
              <Repeat className="size-3.5 shrink-0 text-slate-400" />
            </Tooltip>
          )}
          {task.reminderAt && !task.done && (
            <Tooltip content={`Reminder ${dateTime(task.reminderAt)}`}>
              <Bell className="size-3.5 shrink-0 text-slate-400" />
            </Tooltip>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className={cn(overdue && 'font-semibold text-destructive')}>{dueLabel(task.dueAt)}</span>
          {task.queue && <span className="rounded bg-slate-100 px-1.5 py-px font-medium text-slate-600">{task.queue}</span>}
          {showRecord && task.deal && (
            <Link to="/deals/$dealId" params={{dealId: task.deal.id}} className="inline-flex items-center gap-1 hover:text-primary">
              <Handshake className="size-3" /> {task.deal.title}
            </Link>
          )}
          {showRecord && task.contact && (
            <Link to="/contacts/$contactId" params={{contactId: task.contact.id}} className="inline-flex items-center gap-1 hover:text-primary">
              <User className="size-3" /> {fullName(task.contact)}
            </Link>
          )}
          {showRecord && task.company && !task.contact && (
            <Link to="/companies/$companyId" params={{companyId: task.company.id}} className="inline-flex items-center gap-1 hover:text-primary">
              <Building2 className="size-3" /> {task.company.name}
            </Link>
          )}
        </div>
      </div>
      {!compact && task.assignee && <Avatar name={task.assignee.name} color={task.assignee.color} src={task.assignee.avatarUrl} size="xs" className="mt-0.5" />}
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={remove.isPending} aria-busy={remove.isPending || undefined} className="cursor-pointer rounded-md p-1 text-slate-400 opacity-0 transition-opacity outline-none group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-card hover:text-slate-700 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed data-[state=open]:opacity-100 pointer-coarse:opacity-100" aria-label={`Actions for task ${task.title}`}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => create.open({kind: 'task', task})}><Pencil /> Edit</DropdownMenuItem>
            <DropdownMenuItem
              destructive
              onSelect={async () => (await confirm({title: `Delete the task "${task.title}"?`, description: "This can't be undone.", confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
