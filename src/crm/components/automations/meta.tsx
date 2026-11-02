import {Bell, CalendarClock, CheckSquare, Hand, Handshake, Hourglass, LifeBuoy, ListMinus, ListPlus, Mail, OctagonX, PenLine, Split, Tag, Tags, Timer, UserCheck, Webhook, Zap, type LucideIcon} from 'lucide-react';

import {AUTOMATION_MERGE_FIELDS, RUN_STATUS, type RunStatus, type StepType, type TriggerKind} from '@/lib/automations';
import {cn} from '@/lib/utils';

import {Badge} from '../ui/badge';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '../ui/menu';

type Tone = 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'violet' | 'slate';

export const STEP_ICONS: Record<StepType, {icon: LucideIcon; tone: Tone}> = {
  if: {icon: Split, tone: 'violet'},
  update_field: {icon: PenLine, tone: 'blue'},
  assign_owner: {icon: UserCheck, tone: 'blue'},
  add_tag: {icon: Tag, tone: 'blue'},
  remove_tag: {icon: Tags, tone: 'slate'},
  add_to_list: {icon: ListPlus, tone: 'teal'},
  remove_from_list: {icon: ListMinus, tone: 'slate'},
  create_task: {icon: CheckSquare, tone: 'green'},
  create_deal: {icon: Handshake, tone: 'green'},
  create_ticket: {icon: LifeBuoy, tone: 'green'},
  send_email: {icon: Mail, tone: 'amber'},
  notify: {icon: Bell, tone: 'amber'},
  webhook: {icon: Webhook, tone: 'amber'},
  wait: {icon: Hourglass, tone: 'slate'},
  stop: {icon: OctagonX, tone: 'rose'},
};

export const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {event: Zap, date: CalendarClock, inactivity: Timer, manual: Hand};

export function RunStatusBadge({status, className}: {status: RunStatus; className?: string}) {
  const s = RUN_STATUS[status] ?? RUN_STATUS.done;
  return (
    <Badge tone={s.tone === 'neutral' ? 'neutral' : s.tone} className={className}>
      <span className={cn('size-1.5 rounded-full', status === 'running' ? 'animate-pulse bg-blue-500' : status === 'waiting' ? 'bg-violet-500' : status === 'done' ? 'bg-green-500' : status === 'failed' ? 'bg-rose-500' : status === 'skipped' ? 'bg-amber-500' : 'bg-slate-400')} />
      {s.label}
    </Badge>
  );
}

/** "Insert field" menu next to text inputs that take merge fields. */
export function MergeMenu({onPick, label = 'Insert field'}: {onPick: (token: string) => void; label?: string}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-primary hover:bg-accent">{'{ }'} {label}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 w-64 overflow-y-auto scrollbar-thin">
        <DropdownMenuLabel>Merge fields</DropdownMenuLabel>
        {AUTOMATION_MERGE_FIELDS.map((f) => (
          <DropdownMenuItem key={f.key} onSelect={() => onPick(`{{${f.key}}}`)}>
            <span className="min-w-0 flex-1 truncate">{f.label}</span>
            <code className="text-[10px] text-muted-foreground">{f.key}</code>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Toggle chips for picking several people. */
export function UserChips({users, value, onChange}: {users: {id: string; name: string}[]; value: string[]; onChange: (ids: string[]) => void}) {
  if (!users.length) return <p className="text-xs text-muted-foreground">No active team members.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {users.map((u) => {
        const on = value.includes(u.id);
        return (
          <button
            key={u.id}
            type="button"
            onClick={() => onChange(on ? value.filter((v) => v !== u.id) : [...value, u.id])}
            className={on ? 'cursor-pointer rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary' : 'cursor-pointer rounded-full border border-slate-200 bg-card px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-primary/50'}
          >
            {u.name}
          </button>
        );
      })}
    </div>
  );
}
