import {DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core';
import {useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {Building2, User} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {ago, fullName} from '@/lib/format';
import {keys, useMe} from '@/lib/queries';
import {TICKET_STATUSES, type TicketStatus} from '@/lib/tickets';
import type {TicketRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Avatar} from '../ui/misc';
import {PriorityLabel, SlaBadge} from './ticket-badges';

function TicketCard({ticket, overlay}: {ticket: TicketRow; overlay?: boolean}) {
  const navigate = useNavigate();
  const {canEdit} = useMe();
  const {attributes, listeners, setNodeRef, isDragging} = useDraggable({id: ticket.id, data: {ticket}, disabled: !canEdit});
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => !isDragging && navigate({to: '/tickets/$ticketId', params: {ticketId: String(ticket.number)}})}
      className={cn(
        'cursor-pointer rounded-xl border border-slate-100 bg-card p-3.5 shadow-soft transition-all duration-200 select-none hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none',
        ticket.priority === 'URGENT' && 'border-rose-200',
        isDragging && !overlay && 'opacity-30',
        overlay && 'rotate-2 shadow-lift ring-2 ring-primary/20',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900">
          {/* The card drags; this link opens the ticket (keyboard and screen readers too). */}
          <Link
            to="/tickets/$ticketId"
            params={{ticketId: String(ticket.number)}}
            tabIndex={overlay ? -1 : undefined}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <span className="text-muted-foreground">#{ticket.number}</span> {ticket.subject}
          </Link>
        </p>
        {ticket.assignee && <Avatar name={ticket.assignee.name} color={ticket.assignee.color} src={ticket.assignee.avatarUrl} size="xs" className="mt-0.5" />}
      </div>
      <div className="mt-1.5 grid gap-1 text-xs text-slate-500">
        {ticket.contact && <span className="inline-flex min-w-0 items-center gap-1.5"><User className="size-3 shrink-0" /><span className="truncate">{fullName(ticket.contact)}</span></span>}
        {ticket.company && <span className="inline-flex min-w-0 items-center gap-1.5"><Building2 className="size-3 shrink-0" /><span className="truncate">{ticket.company.name}</span></span>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <PriorityLabel priority={ticket.priority} />
        {ticket.category && <span className="text-slate-500">{ticket.category}</span>}
        <span className="ml-auto text-muted-foreground">{ago(ticket.lastMessageAt)}</span>
      </div>
      <div className="mt-2 empty:hidden"><SlaBadge ticket={ticket} compact /></div>
    </div>
  );
}

function Column({status, tickets}: {status: (typeof TICKET_STATUSES)[number]; tickets: TicketRow[]}) {
  const {setNodeRef, isOver} = useDroppable({id: `status:${status.value}`, data: {status: status.value}});
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="size-2.5 rounded-full" style={{background: status.color}} />
        <h2 className="truncate text-sm font-bold text-slate-900">{status.label}</h2>
        <span className="rounded-full bg-slate-200/70 px-1.5 text-[11px] font-bold text-slate-600">{tickets.length}</span>
      </div>
      <div ref={setNodeRef} className={cn('flex min-h-40 flex-1 flex-col gap-2.5 rounded-2xl p-2 transition-colors', isOver ? 'bg-accent ring-2 ring-primary/20' : 'bg-slate-100/70')}>
        {tickets.map((t) => <TicketCard key={t.id} ticket={t} />)}
        {tickets.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No tickets</p>}
      </div>
    </div>
  );
}

/** Kanban by status; dropping a card on a column changes its status. */
export function TicketBoard({tickets: initial}: {tickets: TicketRow[]}) {
  const qc = useQueryClient();
  const [tickets, setTickets] = useState(initial);
  const [dragging, setDragging] = useState<TicketRow | null>(null);
  useEffect(() => setTickets(initial), [initial]);
  const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 6}}), useSensor(KeyboardSensor));

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const ticket = e.active.data.current?.ticket as TicketRow | undefined;
    const status = e.over?.data.current?.status as TicketStatus | undefined;
    if (!ticket || !status || status === ticket.status) return;
    setTickets((ts) => ts.map((t) => (t.id === ticket.id ? {...t, status} : t)));
    try {
      await api.patch(`/tickets/${ticket.id}`, {status});
    } catch (err) {
      toast.error((err as Error).message);
    }
    qc.invalidateQueries({queryKey: keys.tickets});
    qc.invalidateQueries({queryKey: keys.timeline});
  }

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging((e.active.data.current?.ticket as TicketRow) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="-mx-4 overflow-x-auto px-4 pb-8 scrollbar-thin sm:-mx-6 sm:px-6">
        <div className="flex gap-4">
          {TICKET_STATUSES.map((s) => <Column key={s.value} status={s} tickets={tickets.filter((t) => t.status === s.value)} />)}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <div className="w-[264px]"><TicketCard ticket={dragging} overlay /></div>}</DragOverlay>
    </DndContext>
  );
}
