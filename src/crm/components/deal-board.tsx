import {DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent} from '@dnd-kit/core';
import {useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {AlertTriangle, CalendarCheck, CalendarClock, Hourglass, Plus, Trophy, User, XCircle} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {daysSince, dueLabel, fullName, isOverdue, money, shortDate} from '@/lib/format';
import {keys, recordKeys, useMe} from '@/lib/queries';
import type {Deal, Pipeline} from '@/lib/types';
import {cn} from '@/lib/utils';

import {useCreate} from './create-dialogs';
import {LostDialog} from './deal-status';
import {Avatar} from './ui/misc';
import {Tooltip} from './ui/menu';

function DealCard({deal, overlay}: {deal: Deal; overlay?: boolean}) {
  const navigate = useNavigate();
  const {canEdit} = useMe();
  const {attributes, listeners, setNodeRef: dragRef, isDragging} = useDraggable({id: deal.id, data: {deal}, disabled: !canEdit});
  const {setNodeRef: dropRef, isOver} = useDroppable({id: `card:${deal.id}`, data: {deal}});
  const idle = daysSince(deal.lastActivityAt);
  const rotting = idle > deal.pipeline.rottingDays;

  return (
    <div ref={dropRef} className={cn('relative', isOver && !isDragging && 'before:absolute before:inset-x-1 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-primary')}>
      <div
        ref={dragRef}
        {...attributes}
        {...listeners}
        onClick={() => !isDragging && navigate({to: '/deals/$dealId', params: {dealId: deal.id}})}
        className={cn(
          'group cursor-pointer rounded-xl border bg-card p-3.5 shadow-soft transition-all duration-200 select-none hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none',
          rotting ? 'border-amber-200' : 'border-slate-100',
          isDragging && !overlay && 'opacity-30',
          overlay && 'rotate-2 shadow-lift ring-2 ring-primary/20',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          {/* The card itself drags (Space / Enter pick it up); the title is the keyboard way in. */}
          <Link
            to="/deals/$dealId"
            params={{dealId: deal.id}}
            draggable={false}
            tabIndex={overlay ? -1 : undefined}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="line-clamp-2 rounded text-sm font-semibold leading-snug text-slate-900 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            {deal.title}
          </Link>
          {deal.owner && <Avatar name={deal.owner.name} color={deal.owner.color} src={deal.owner.avatarUrl} size="xs" className="mt-0.5" />}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{deal.company?.name ?? 'No company'}</p>
        <div className="mt-2 grid gap-1 text-xs text-slate-500">
          {deal.status === 'OPEN' ? (
            <span className={cn('inline-flex items-center gap-1.5', deal.expectedCloseDate && isOverdue(deal.expectedCloseDate) && 'font-semibold text-destructive')}>
              <CalendarCheck className="size-3" /> {deal.expectedCloseDate ? `Close ${shortDate(deal.expectedCloseDate)}` : 'No close date'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5"><CalendarCheck className="size-3" /> {deal.status === 'WON' ? 'Won' : 'Lost'} {shortDate(deal.closedAt)}{deal.lostReason ? ` · ${deal.lostReason}` : ''}</span>
          )}
          {deal.contacts[0] && (
            <span className="inline-flex min-w-0 items-center gap-1.5"><User className="size-3 shrink-0" /> <span className="truncate">{fullName(deal.contacts[0].contact)}{deal.contacts.length > 1 ? ` +${deal.contacts.length - 1}` : ''}</span></span>
          )}
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="text-sm font-extrabold text-slate-900">{money(deal.value, deal.currency)}</span>
          {rotting && deal.status === 'OPEN' && (
            <Tooltip content={`No activity for ${idle} days`}>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-700"><Hourglass className="size-3" /> {idle}d</span>
            </Tooltip>
          )}
        </div>
        {deal.status === 'OPEN' && <div className="mt-2.5 border-t border-slate-50 pt-2 text-xs">
          {deal.nextTask ? (
            <span className={cn('inline-flex items-center gap-1 font-medium', isOverdue(deal.nextTask.dueAt) ? 'text-destructive' : 'text-slate-500')}>
              <CalendarClock className="size-3" />
              <span className="truncate">{dueLabel(deal.nextTask.dueAt)} · {deal.nextTask.title}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold text-amber-600"><AlertTriangle className="size-3" /> No upcoming activity</span>
          )}
        </div>}
      </div>
    </div>
  );
}

/** Totals pinned to the bottom of each column, like HubSpot: total and weighted amount. */
function ColumnFooter({total, weighted, probability, currency, label}: {total: number; weighted?: number; probability: number; currency: string; label?: string}) {
  return (
    <div className="mt-2 rounded-xl border-t border-slate-200/70 px-2 pt-2 text-xs">
      <p className="text-slate-500"><span className="font-bold text-slate-900">{money(total, currency)}</span> · Total amount</p>
      <p className="text-slate-500">
        {label ?? (
          <>
            <span className="font-bold text-slate-900">{money(weighted ?? 0, currency)}</span> ({probability}%) · Weighted
          </>
        )}
      </p>
    </div>
  );
}

function Column({stage, deals, pipelineId, currency}: {stage: Pipeline['stages'][number]; deals: Deal[]; pipelineId: string; currency: string}) {
  const create = useCreate();
  const {canEdit} = useMe();
  const {setNodeRef, isOver} = useDroppable({id: `stage:${stage.id}`, data: {stageId: stage.id}});
  const total = deals.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="size-2.5 rounded-full" style={{background: stage.color}} />
        <h2 className="truncate text-sm font-bold text-slate-900">{stage.name}</h2>
        <span className="rounded-full bg-slate-200/70 px-1.5 text-[11px] font-bold text-slate-600">{deals.length}</span>
      </div>
      <div ref={setNodeRef} className={cn('flex min-h-40 flex-1 flex-col gap-2.5 rounded-2xl p-2 transition-colors', isOver ? 'bg-accent ring-2 ring-primary/20' : 'bg-slate-100/70')}>
        {canEdit && (
          <button type="button" aria-label={`Add a deal in ${stage.name}`} onClick={() => create.open({kind: 'deal', defaults: {stageId: stage.id, pipelineId}})} className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2 text-xs font-semibold text-muted-foreground transition-colors outline-none hover:border-primary hover:bg-card hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30">
            <Plus className="size-3.5" /> Deal
          </button>
        )}
        {deals.map((d) => <DealCard key={d.id} deal={d} />)}
        <div className="flex-1" />
        <ColumnFooter total={total} weighted={(total * stage.probability) / 100} probability={stage.probability} currency={currency} />
      </div>
    </div>
  );
}

/** Closed won / closed lost as real columns: drop to close, drag out to reopen. */
function ClosedColumn({status, deals, currency}: {status: 'WON' | 'LOST'; deals: Deal[]; currency: string}) {
  const {setNodeRef, isOver} = useDroppable({id: status === 'WON' ? 'outcome:won' : 'outcome:lost'});
  const total = deals.reduce((s, d) => s + d.value, 0);
  const won = status === 'WON';
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-3 flex items-center gap-2 px-1">
        {won ? <Trophy className="size-3.5 text-green-600" /> : <XCircle className="size-3.5 text-rose-600" />}
        <h2 className="text-sm font-bold text-slate-900">{won ? 'Closed won' : 'Closed lost'}</h2>
        <span className="rounded-full bg-slate-200/70 px-1.5 text-[11px] font-bold text-slate-600">{deals.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-40 flex-1 flex-col gap-2.5 rounded-2xl p-2 transition-colors',
          won ? 'bg-green-50/70' : 'bg-rose-50/60',
          isOver && (won ? 'ring-2 ring-green-400/40' : 'ring-2 ring-rose-400/40'),
        )}
      >
        {deals.map((d) => <DealCard key={d.id} deal={d} />)}
        {deals.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Drop a deal here to mark it {won ? 'won' : 'lost'}</p>}
        <div className="flex-1" />
        <ColumnFooter total={total} probability={won ? 100 : 0} currency={currency} label={won ? 'Won (100%)' : 'Lost (0%)'} />
      </div>
    </div>
  );
}

function OutcomeZone({id, label, icon: Icon, tone}: {id: string; label: string; icon: typeof Trophy; tone: 'won' | 'lost'}) {
  const {setNodeRef, isOver} = useDroppable({id});
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-5 text-sm font-bold transition-all',
        tone === 'won' ? 'border-green-300 bg-green-50 text-green-700' : 'border-rose-300 bg-rose-50 text-rose-700',
        isOver && (tone === 'won' ? 'scale-[1.02] border-solid bg-green-100' : 'scale-[1.02] border-solid bg-rose-100'),
      )}
    >
      <Icon className="size-5" /> {label}
    </div>
  );
}

export function DealBoard({pipeline, deals: initial, closed, currency = 'USD'}: {pipeline: Pipeline; deals: Deal[]; closed?: Deal[]; currency?: string}) {
  const qc = useQueryClient();
  const [deals, setDeals] = useState(initial);
  const [dragging, setDragging] = useState<Deal | null>(null);
  const [losing, setLosing] = useState<Deal | null>(null);
  useEffect(() => setDeals(initial), [initial]);

  const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 6}}), useSensor(KeyboardSensor));
  const byStage = (stageId: string) => deals.filter((d) => d.stageId === stageId).sort((a, b) => a.position - b.position);
  const refresh = () => Promise.all(recordKeys.map((queryKey) => qc.invalidateQueries({queryKey})));

  async function setStatus(deal: Deal, status: 'WON' | 'LOST', lostReason?: string) {
    if (deal.status === status) return;
    setDeals((ds) => ds.filter((d) => d.id !== deal.id));
    try {
      await api.post(`/deals/${deal.id}/status`, {status, lostReason});
      toast.success(status === 'WON' ? `🎉 ${deal.title} won!` : 'Marked as lost');
    } catch (e) {
      toast.error((e as Error).message);
    }
    refresh();
  }

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const deal = e.active.data.current?.deal as Deal | undefined;
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!deal || !overId) return;
    if (overId === 'outcome:won' || overId === 'zone:won') return setStatus(deal, 'WON');
    if (overId === 'outcome:lost' || overId === 'zone:lost') return deal.status === 'LOST' ? undefined : setLosing(deal);

    let stageId: string;
    let beforeId: string | null = null;
    if (overId.startsWith('card:')) {
      const target = e.over!.data.current?.deal as Deal;
      if (target.id === deal.id) return;
      stageId = target.stageId;
      beforeId = target.id;
    } else {
      stageId = String(e.over!.data.current?.stageId);
    }
    const column = byStage(stageId).filter((d) => d.id !== deal.id);
    const idx = beforeId ? column.findIndex((d) => d.id === beforeId) : column.length;
    const after = column[idx - 1] ?? null;
    const before = column[idx] ?? null;
    const position = after && before ? (after.position + before.position) / 2 : after ? after.position + 1 : before ? before.position - 1 : 0;
    const stage = pipeline.stages.find((s) => s.id === stageId)!;
    if (deal.status !== 'OPEN') {
      // Dragged out of a closed column: reopen, then place it.
      try {
        await api.post(`/deals/${deal.id}/status`, {status: 'OPEN'});
        await api.post(`/deals/${deal.id}/move`, {stageId, beforeId: before?.id ?? null, afterId: after?.id ?? null});
        toast.success('Deal reopened');
      } catch (err) {
        toast.error((err as Error).message);
      }
      return refresh();
    }

    // Optimistic: move locally first, reconcile from the server after.
    setDeals((ds) => ds.map((d) => (d.id === deal.id ? {...d, stageId, stage, position, lastActivityAt: stageId !== deal.stageId ? new Date().toISOString() : d.lastActivityAt} : d)));
    try {
      await api.post(`/deals/${deal.id}/move`, {stageId, beforeId: before?.id ?? null, afterId: after?.id ?? null});
    } catch (err) {
      toast.error((err as Error).message);
    }
    qc.invalidateQueries({queryKey: keys.timeline});
    qc.invalidateQueries({queryKey: keys.dashboard});
  }

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current?.deal as Deal) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="-mx-4 overflow-x-auto px-4 pb-28 scrollbar-thin sm:-mx-6 sm:px-6">
        <div className="flex gap-4">
          {pipeline.stages.map((s) => <Column key={s.id} stage={s} deals={byStage(s.id)} pipelineId={pipeline.id} currency={currency} />)}
          {closed && (
            <>
              <ClosedColumn status="WON" deals={closed.filter((d) => d.status === 'WON')} currency={currency} />
              <ClosedColumn status="LOST" deals={closed.filter((d) => d.status === 'LOST')} currency={currency} />
            </>
          )}
        </div>
      </div>
      {dragging && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-card/90 p-4 backdrop-blur-md animate-in slide-in-from-bottom-8 lg:left-64">
          <div className="mx-auto flex max-w-2xl gap-4">
            <OutcomeZone id="zone:lost" label="Drop to mark lost" icon={XCircle} tone="lost" />
            <OutcomeZone id="zone:won" label="Drop to mark won" icon={Trophy} tone="won" />
          </div>
        </div>
      )}
      <DragOverlay dropAnimation={null}>{dragging && <div className="w-[264px]"><DealCard deal={dragging} overlay /></div>}</DragOverlay>
      {losing && <LostDialog onClose={() => setLosing(null)} onConfirm={(reason) => (setStatus(losing, 'LOST', reason), setLosing(null))} />}
    </DndContext>
  );
}
