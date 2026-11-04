import type {Ticket} from '../../../generated/prisma/client';
import {ticketRef, type BusinessHours, type TicketPriority, type TicketSettings} from '@/lib/tickets';
import type {Db} from '../kit/db';
import {emit} from './events';
import {enqueue} from './jobs';
import {notify} from './notify';
import {getTicketSettings, ticketLink, ticketTeam} from './tickets';

// ─── Business hours ─────────────────────────────────────────────────────────

/** Wall-clock parts of `date` in `timeZone`. */
function zoned(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short'}).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

/** UTC instant for a wall-clock time in `timeZone` (day overflow is fine: 32 → next month). */
function fromZoned(y: number, m: number, d: number, hh: number, mm: number, timeZone: string) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (t: number) => {
    const z = zoned(new Date(t), timeZone);
    return Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm) - Math.floor(t / 60_000) * 60_000;
  };
  // Second pass settles DST transitions.
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return {h: h || 0, m: m || 0};
};

/** `minutes` of working time after `start`, counting only the business hours. */
function addBusinessMinutes(start: Date, minutes: number, bh: BusinessHours): Date {
  const tz = (() => {
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: bh.timezone});
      return bh.timezone;
    } catch {
      return 'UTC';
    }
  })();
  const open = hm(bh.start);
  const close = hm(bh.end);
  if (!bh.days.length || open.h * 60 + open.m >= close.h * 60 + close.m) return new Date(start.getTime() + minutes * 60_000);

  let cursor = start;
  let remaining = minutes;
  for (let i = 0; i < 800; i++) {
    const z = zoned(cursor, tz);
    if (bh.days.includes(z.weekday)) {
      const dayOpen = fromZoned(z.y, z.m, z.d, open.h, open.m, tz);
      const dayClose = fromZoned(z.y, z.m, z.d, close.h, close.m, tz);
      if (cursor < dayClose) {
        const from = cursor > dayOpen ? cursor : dayOpen;
        const available = (dayClose.getTime() - from.getTime()) / 60_000;
        if (remaining <= available) return new Date(from.getTime() + remaining * 60_000);
        remaining -= available;
      }
    }
    cursor = fromZoned(z.y, z.m, z.d + 1, 0, 0, tz);
  }
  return new Date(start.getTime() + minutes * 60_000);
}

/** First response and resolution deadlines for a ticket opened at `from`. */
export function slaDueDates(settings: TicketSettings, priority: TicketPriority, from: Date) {
  const target = settings.sla.enabled ? settings.sla.targets[priority] : null;
  const add = (mins: number | null | undefined) => {
    if (!mins) return null;
    return settings.sla.businessHours.enabled ? addBusinessMinutes(from, mins, settings.sla.businessHours) : new Date(from.getTime() + mins * 60_000);
  };
  return {firstResponseDueAt: add(target?.firstResponseMins), resolutionDueAt: add(target?.resolutionMins)};
}

// ─── Breach checks (job "ticket.sla_check") ─────────────────────────────────

/** Queues a check at each deadline. Old jobs for a moved deadline find a different due date and do nothing. */
export async function scheduleSla(db: Db, t: Pick<Ticket, 'id' | 'firstResponseDueAt' | 'resolutionDueAt' | 'firstResponseAt' | 'resolvedAt'>) {
  if (t.firstResponseDueAt && !t.firstResponseAt) {
    await enqueue(db, 'ticket.sla_check', {ticketId: t.id, kind: 'first_response', due: t.firstResponseDueAt.toISOString()}, {runAt: t.firstResponseDueAt});
  }
  if (t.resolutionDueAt && !t.resolvedAt) {
    await enqueue(db, 'ticket.sla_check', {ticketId: t.id, kind: 'resolution', due: t.resolutionDueAt.toISOString()}, {runAt: t.resolutionDueAt});
  }
  // A deadline already in the past (reopened ticket, back-dated SLA) runs right away: its runAt has passed.
}

export async function checkSla(db: Db, payload: Record<string, unknown>) {
  const kind = payload.kind === 'resolution' ? 'resolution' : 'first_response';
  const ticket = await db.ticket.findUnique({where: {id: String(payload.ticketId)}});
  if (!ticket || ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') return;
  const due = kind === 'first_response' ? ticket.firstResponseDueAt : ticket.resolutionDueAt;
  const met = kind === 'first_response' ? ticket.firstResponseAt : ticket.resolvedAt;
  const already = kind === 'first_response' ? ticket.firstResponseBreachedAt : ticket.resolutionBreachedAt;
  if (!due || met || already || due.toISOString() !== payload.due) return;
  if (due.getTime() > Date.now() + 5_000) return; // run early by a skewed clock: a later job covers it

  const now = new Date();
  const updated = await db.ticket.update({
    where: {id: ticket.id},
    data: kind === 'first_response' ? {firstResponseBreachedAt: now} : {resolutionBreachedAt: now},
  });
  const label = kind === 'first_response' ? 'First response' : 'Resolution';
  await db.ticketMessage.create({data: {ticketId: ticket.id, kind: 'event', data: {type: 'sla_breached', sla: kind, dueAt: due.toISOString()}}});
  const settings = await getTicketSettings(db);
  await notify(db, ticket.assigneeId ? [ticket.assigneeId] : await ticketTeam(db, settings), {
    type: 'sla',
    title: `SLA breached on ${ticketRef(ticket.number)}: ${label.toLowerCase()} was due`,
    body: ticket.subject,
    link: ticketLink(ticket),
  });
  await emit(db, 'ticket.sla_breached', {recordId: ticket.id, data: {ticket: updated, sla: kind, dueAt: due}});
}
