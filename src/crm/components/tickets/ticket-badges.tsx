import {useQuery} from '@tanstack/react-query';
import {AlarmClock, Star, TimerReset} from 'lucide-react';
import {useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {dateTime} from '@/lib/format';
import {keys} from '@/lib/queries';
import {durationLabel, PRIORITY, slaState, STATUS, type TicketPriority, type TicketStatus} from '@/lib/tickets';
import type {CannedReply, TicketRow, TicketSettingsResponse} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Badge} from '../ui/badge';
import {Tooltip} from '../ui/menu';

export function useTicketSettings() {
  return useQuery({queryKey: [...keys.tickets, 'settings'], queryFn: () => api.get<TicketSettingsResponse>('/tickets/settings'), staleTime: 5 * 60_000});
}

export function useCannedReplies() {
  return useQuery({queryKey: [...keys.tickets, 'canned'], queryFn: () => api.get<{rows: CannedReply[]}>('/tickets/canned'), select: (d) => d.rows, staleTime: 60_000});
}

export function StatusBadge({status, className}: {status: TicketStatus; className?: string}) {
  const s = STATUS[status];
  return <Badge tone={s.tone} className={className}><span className="size-1.5 rounded-full" style={{background: s.color}} />{s.label}</Badge>;
}

export function PriorityLabel({priority, className}: {priority: TicketPriority; className?: string}) {
  const p = PRIORITY[priority];
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', priority === 'URGENT' && 'font-semibold text-rose-700', className)}><span className={cn('size-2 rounded-full', p.dot)} />{p.label}</span>;
}

/** Re-renders every 30 s so countdowns stay current. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Countdown to the SLA deadline that matters now (first response, then resolution). */
export function SlaBadge({ticket, compact}: {ticket: Pick<TicketRow, 'status' | 'firstResponseAt' | 'firstResponseDueAt' | 'firstResponseBreachedAt' | 'resolvedAt' | 'resolutionDueAt' | 'resolutionBreachedAt'>; compact?: boolean}) {
  const now = useNow();
  const sla = slaState(ticket, now);
  if (!sla) return null;
  const what = sla.kind === 'first_response' ? 'First response' : 'Resolution';
  const soon = !sla.breached && sla.msLeft < 60 * 60_000;
  const label = sla.breached ? `${compact ? '' : `${what} `}overdue ${durationLabel(sla.msLeft)}` : `${compact ? '' : `${what} in `}${durationLabel(sla.msLeft)}`;
  return (
    <Tooltip content={`${what} due ${dateTime(sla.dueAt)}`}>
      <span>
        <Badge tone={sla.breached ? 'rose' : soon ? 'amber' : 'neutral'}>
          {sla.breached ? <AlarmClock /> : <TimerReset />} {label}
        </Badge>
      </span>
    </Tooltip>
  );
}

export function Stars({rating, className}: {rating: number; className?: string}) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={cn('size-3.5', n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />)}
    </span>
  );
}
