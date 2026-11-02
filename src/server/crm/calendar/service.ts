import type {CalendarConnection, Interaction} from '../../../generated/prisma/client';
import type {Interval} from '@/lib/scheduling';
import type {Db} from '../kit/db';
import {createInteraction, refreshInteractionActivity} from '../routes/interactions';
import {connectionCredentials, type CalendarProvider} from './oauth';
import {busyTimes, cancelEvent, createEvent, listCalendars, listEvents, updateEvent, type CalendarInfo, type EventInput} from './providers';
import {teamAddresses} from '../lib/users';

const DAY = 86_400_000;

const fail = (db: Db, conn: CalendarConnection, e: unknown) =>
  db.calendarConnection.update({where: {id: conn.id}, data: {status: 'ERROR', lastError: (e as Error).message.slice(0, 500)}}).catch(() => null);

export const calendarsOf = (conn: Pick<CalendarConnection, 'calendars'>) => (conn.calendars ?? []) as CalendarInfo[];

/** Re-reads the account's calendars; on first connect the primary one is checked for conflicts. */
export async function refreshCalendars(db: Db, conn: CalendarConnection) {
  const creds = await connectionCredentials(db, conn);
  const calendars = await listCalendars(conn.provider as CalendarProvider, creds);
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  return db.calendarConnection.update({
    where: {id: conn.id},
    data: {
      calendars,
      busyCalendarIds: conn.busyCalendarIds.length ? conn.busyCalendarIds.filter((id) => calendars.some((c) => c.id === id)) : primary ? [primary.id] : [],
      targetCalendarId: conn.targetCalendarId && calendars.some((c) => c.id === conn.targetCalendarId) ? conn.targetCalendarId : primary?.id ?? null,
      status: 'CONNECTED',
      lastError: null,
    },
  });
}

// ─── Busy times for booking pages ───────────────────────────────────────────

/**
 * Busy blocks from every connected calendar of a user. A calendar that can't
 * be read is skipped (and flagged in Settings → Calendar) rather than hiding
 * every slot.
 */
export async function calendarBusy(db: Db, userId: string, from: Date, to: Date): Promise<Interval[]> {
  const conns = await db.calendarConnection.findMany({where: {userId}});
  const out: Interval[] = [];
  for (const conn of conns) {
    if (!conn.busyCalendarIds.length) continue;
    try {
      const creds = await connectionCredentials(db, conn);
      out.push(...(await busyTimes(conn.provider as CalendarProvider, creds, conn.busyCalendarIds, from, to)));
    } catch (e) {
      await fail(db, conn, e);
    }
  }
  return out;
}

/** The connection (and calendar) new meetings of this user are written to. */
export async function writeTarget(db: Db, userId: string) {
  const conn = await db.calendarConnection.findFirst({where: {userId}, orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}]});
  if (!conn) return null;
  return {conn, calendarId: conn.targetCalendarId ?? 'primary'};
}

// ─── CRM meetings → the organiser's calendar ────────────────────────────────

async function eventInput(db: Db, i: Interaction): Promise<EventInput> {
  const people = i.attendeeIds.length
    ? await db.contact.findMany({where: {id: {in: i.attendeeIds}, email: {not: null}}, select: {firstName: true, lastName: true, email: true}})
    : [];
  const attendees = new Map<string, {email: string; name?: string | null}>();
  for (const p of people) attendees.set(p.email!.toLowerCase(), {email: p.email!, name: [p.firstName, p.lastName].filter(Boolean).join(' ')});
  return {
    title: i.title ?? 'Meeting',
    description: i.body,
    start: i.occurredAt,
    end: new Date(i.occurredAt.getTime() + (i.durationMin ?? 30) * 60_000),
    location: i.location,
    attendees: [...attendees.values()],
    video: i.locationType === 'VIDEO' && !i.location,
  };
}

/**
 * Writes an upcoming CRM meeting to its author's calendar (or moves the event
 * it already has). A video meeting without a link gets a Google Meet / Teams
 * link, which is saved on the interaction. Never throws: a calendar problem
 * must not fail the booking or the meeting.
 */
export async function pushMeeting(db: Db, interaction: Interaction): Promise<Interaction> {
  if (interaction.kind !== 'MEETING' || !interaction.authorId || interaction.outcome === 'Canceled') return interaction;
  const linked = await db.calendarEvent.findFirst({where: {interactionId: interaction.id}, include: {connection: true}});
  if (!linked && interaction.occurredAt.getTime() < Date.now()) return interaction;
  const target = linked ? {conn: linked.connection, calendarId: linked.calendarId} : await writeTarget(db, interaction.authorId);
  if (!target) return interaction;
  try {
    const creds = await connectionCredentials(db, target.conn);
    const provider = target.conn.provider as CalendarProvider;
    const input = await eventInput(db, interaction);
    const result = linked
      ? await updateEvent(provider, creds, target.calendarId, linked.externalId, input)
      : await createEvent(provider, creds, target.calendarId, input);
    if (linked) await db.calendarEvent.update({where: {id: linked.id}, data: {changeKey: result.changeKey}});
    else await db.calendarEvent.create({data: {connectionId: target.conn.id, calendarId: target.calendarId, externalId: result.id, interactionId: interaction.id, changeKey: result.changeKey}});
    if (result.meetingUrl && !interaction.location) {
      return db.interaction.update({where: {id: interaction.id}, data: {location: result.meetingUrl, locationType: 'VIDEO'}});
    }
  } catch (e) {
    await fail(db, target.conn, e);
  }
  return interaction;
}

/** Cancels the calendar events of a CRM meeting (attendees are told by the provider). */
export async function cancelMeetingEvents(db: Db, interactionId: string, comment?: string) {
  const linked = await db.calendarEvent.findMany({where: {interactionId}, include: {connection: true}});
  for (const l of linked) {
    try {
      const creds = await connectionCredentials(db, l.connection);
      await cancelEvent(l.connection.provider as CalendarProvider, creds, l.calendarId, l.externalId, comment);
      await db.calendarEvent.delete({where: {id: l.id}});
    } catch (e) {
      await fail(db, l.connection, e);
    }
  }
}

// ─── Calendar → CRM (sync job) ──────────────────────────────────────────────

const FIRST_SYNC_DAYS = 14;
const AHEAD_DAYS = 30;
const MAX_NEW_PER_RUN = 40;

/**
 * Logs calendar events that have a known contact among the attendees as
 * meetings (like email sync, unrelated events are never stored), and applies
 * moves / cancellations made in the calendar to meetings it already knows.
 */
export async function syncConnection(db: Db, conn: CalendarConnection) {
  if (!conn.syncMeetings) return {logged: 0, updated: 0, skipped: true};
  try {
    const creds = await connectionCredentials(db, conn);
    const provider = conn.provider as CalendarProvider;
    const started = new Date();
    const range = {
      from: new Date(started.getTime() - (conn.lastSyncedAt ? 2 : FIRST_SYNC_DAYS) * DAY),
      to: new Date(started.getTime() + AHEAD_DAYS * DAY),
      // Google can return only what changed (incl. deletions); Graph pages through the window.
      updatedSince: provider === 'google' && conn.lastSyncedAt ? new Date(conn.lastSyncedAt.getTime() - 5 * 60_000) : null,
    };
    const calendarIds = conn.busyCalendarIds.length ? conn.busyCalendarIds.slice(0, 3) : [conn.targetCalendarId ?? 'primary'];
    const team = new Set([
      ...(await teamAddresses(db)),
      ...(await db.calendarConnection.findMany({select: {email: true}})).map((c) => c.email.toLowerCase()),
    ]);

    let logged = 0;
    let updated = 0;
    for (const calendarId of calendarIds) {
      for (const e of await listEvents(provider, creds, calendarId, range)) {
        if (e.allDay) continue;
        const known = await db.calendarEvent.findUnique({where: {connectionId_externalId: {connectionId: conn.id, externalId: e.id}}});
        if (known) {
          if (known.changeKey === e.changeKey) continue;
          if (known.interactionId && (await applyEventChange(db, known.interactionId, e))) updated++;
          await db.calendarEvent.update({where: {id: known.id}, data: {changeKey: e.changeKey}});
          continue;
        }
        if (e.canceled || logged >= MAX_NEW_PER_RUN) continue;
        const emails = e.attendees.map((a) => a.email).filter((x) => !team.has(x));
        if (!emails.length) continue;
        const contacts = await db.contact.findMany({
          where: {email: {in: emails, mode: 'insensitive'}},
          select: {id: true, companies: {orderBy: {isPrimary: 'desc'}, take: 1, select: {companyId: true}}},
          orderBy: {createdAt: 'asc'},
        });
        if (!contacts.length) continue;
        const interaction = await createInteraction(
          db,
          {
            kind: 'MEETING',
            title: e.title.slice(0, 300),
            body: e.description?.slice(0, 5000) ?? null,
            occurredAt: e.start,
            durationMin: Math.max(1, Math.round((e.end.getTime() - e.start.getTime()) / 60_000)),
            locationType: e.meetingUrl ? 'VIDEO' : e.location ? 'IN_PERSON' : null,
            location: e.meetingUrl ?? e.location,
            outcome: e.start.getTime() > Date.now() ? 'Scheduled' : 'Completed',
            attendeeIds: contacts.map((c) => c.id),
            contactId: contacts[0]!.id,
            companyId: contacts[0]!.companies[0]?.companyId ?? null,
            authorId: conn.userId,
          },
          {calendar: false},
        );
        await db.calendarEvent.create({data: {connectionId: conn.id, calendarId, externalId: e.id, interactionId: interaction.id, changeKey: e.changeKey}});
        logged++;
      }
    }
    await db.calendarConnection.update({where: {id: conn.id}, data: {lastSyncedAt: started, status: 'CONNECTED', lastError: null}});
    return {logged, updated};
  } catch (e) {
    await fail(db, conn, e);
    return {logged: 0, updated: 0, error: (e as Error).message};
  }
}

/** A meeting moved, renamed or cancelled in the calendar. Bookings follow along (the provider already told attendees). */
async function applyEventChange(db: Db, interactionId: string, e: {title: string; start: Date; end: Date; canceled: boolean}) {
  const current = await db.interaction.findUnique({where: {id: interactionId}});
  if (!current) return false;
  const durationMin = Math.max(1, Math.round((e.end.getTime() - e.start.getTime()) / 60_000));
  const moved = current.occurredAt.getTime() !== e.start.getTime() || current.durationMin !== durationMin;
  const canceled = e.canceled && current.outcome !== 'Canceled';
  if (!moved && !canceled && current.title === e.title) return false;
  const interaction = await db.interaction.update({
    where: {id: interactionId},
    data: canceled ? {outcome: 'Canceled'} : {occurredAt: e.start, durationMin, title: e.title.slice(0, 300)},
  });
  await refreshInteractionActivity(db, interaction);
  const booking = await db.booking.findUnique({where: {interactionId}});
  if (booking && booking.status === 'CONFIRMED') {
    await db.booking.update({
      where: {id: booking.id},
      data: canceled ? {status: 'CANCELED', canceledAt: new Date(), cancelReason: 'Canceled in the calendar'} : {startAt: e.start, endAt: e.end},
    });
  }
  return true;
}

export async function syncAllCalendars(db: Db) {
  const conns = await db.calendarConnection.findMany({where: {syncMeetings: true}});
  const results = [];
  for (const c of conns) results.push({calendar: c.email, ...(await syncConnection(db, c))});
  return results;
}
