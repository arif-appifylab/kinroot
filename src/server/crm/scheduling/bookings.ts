import {HTTPException} from 'hono/http-exception';

import type {Booking, BookingLink, Contact, Prisma} from '../../../generated/prisma/client';
import {durationLabel, isTimeZone, questionsOf, whenIn} from '@/lib/scheduling';
import {sign, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import {cancelMeetingEvents, pushMeeting} from '../calendar/service';
import {logActivity} from '../lib/activity';
import {associateByDomain} from '../lib/domains';
import {emit} from '../lib/events';
import {enqueue} from '../lib/jobs';
import {notify, recordLink} from '../lib/notify';
import {rememberOption} from '../lib/settings';
import {createInteraction, refreshInteractionActivity} from '../routes/interactions';
import {hostsFor, linkSlots, pickHost} from './links';
import {numbers} from '../lib/json-list';
import {lockFor, runOnce, type Once} from '../lib/once';

// ─── Signed manage links (/book/manage/:token) ──────────────────────────────

export const manageToken = async (bookingId: string) => `${bookingId}.${await sign(`booking|${bookingId}`)}`;

/** A manage link works until a week after the meeting ends (its current end, after any reschedule). */
const MANAGE_DAYS_AFTER = 7;

export async function bookingFromToken(db: Db, token: string, now = Date.now()) {
  const [id, sig] = token.split('.');
  if (!id || !sig || !(await verifySignature(`booking|${id}`, sig))) return null;
  const booking = await db.booking.findUnique({where: {id}, include: {link: true, host: true}});
  return booking && booking.endAt.getTime() + MANAGE_DAYS_AFTER * 86_400_000 > now ? booking : null;
}

export const manageUrl = async (origin: string, bookingId: string) => `${origin}/book/manage/${await manageToken(bookingId)}`;
/** The meeting's .ics, served by the existing signed invite route. */
export const icsUrl = async (origin: string, interactionId: string) => `${origin}/site-api/crm/meetings/${interactionId}/invite.ics?s=${await sign(`ics|${interactionId}`)}`;

// ─── Book ───────────────────────────────────────────────────────────────────

export type BookInput = {
  start: string;
  duration: number;
  timezone: string;
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  notes?: string | null;
  source: 'page' | 'widget' | 'form';
  /** Forms resolve the contact themselves. */
  contactId?: string | null;
  meta?: Record<string, string>;
  origin: string;
};

const SLOT_TAKEN = 'That time is no longer available. Please pick another one.';

function bookingLocation(link: BookingLink, input: Pick<BookInput, 'phone'>) {
  // Phone without a number on the link: the host calls the invitee.
  if (link.locationType === 'PHONE' && !link.location) return input.phone?.trim() || null;
  return link.location ?? null;
}

/** Contact by email (case-insensitive), created when new, with the company they typed or their work domain. */
async function upsertContact(db: Db, link: BookingLink, hostId: string, input: BookInput) {
  const email = input.email.trim().toLowerCase();
  // Case-insensitive on the lower(email) index (`mode: 'insensitive'` is ILIKE: no index), the oldest one.
  const [found] = await db.$queryRaw<{id: string; phone: string | null; ownerId: string | null}[]>`
    SELECT id, phone, "ownerId" FROM "Contact" WHERE lower(email) = ${email} ORDER BY "createdAt" ASC, id ASC LIMIT 1`;
  let contact: Contact;
  const isNew = !found;
  const [firstName, ...rest] = input.name.trim().split(/\s+/);
  if (found) {
    contact = await db.contact.update({
      where: {id: found.id},
      data: {phone: found.phone ?? input.phone ?? undefined, ownerId: found.ownerId ?? hostId},
    });
  } else {
    const source = `Booking: ${link.name}`.slice(0, 100);
    contact = await db.contact.create({
      data: {firstName: firstName || email.split('@')[0]!, lastName: rest.join(' ') || null, email, phone: input.phone ?? null, source, ownerId: hostId, lastActivityAt: new Date()},
    });
    await rememberOption(db, 'sources', source);
    await logActivity(db, {type: 'contact_created', title: `Contact created from ${link.name} booking`, contactId: contact.id});
  }
  let companyId: string | null = null;
  const name = input.company?.trim();
  if (name) {
    const company =
      (await db.company.findFirst({where: {name: {equals: name, mode: 'insensitive'}}, select: {id: true}})) ??
      (await db.company.create({data: {name, ownerId: contact.ownerId, lastActivityAt: new Date()}, select: {id: true}}));
    const links = await db.contactCompany.findMany({where: {contactId: contact.id}, select: {companyId: true}});
    if (!links.some((l) => l.companyId === company.id)) await db.contactCompany.create({data: {contactId: contact.id, companyId: company.id, isPrimary: links.length === 0}});
    companyId = company.id;
  } else {
    companyId = (await associateByDomain(db, contact.id))?.id ?? (await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}}))?.companyId ?? null;
  }
  return {contact, companyId, isNew};
}

/** Checks a requested time against the link's live availability and picks the host. */
export async function claimSlot(db: Db, link: BookingLink, start: Date, duration: number, opts: {onlyHostId?: string | null; exclude?: Booking | null} = {}) {
  if (!numbers(link.durations).includes(duration)) throw new HTTPException(400, {message: 'Pick one of the offered durations'});
  if (Number.isNaN(start.getTime())) throw new HTTPException(400, {message: 'Pick a time'});
  const slots = await linkSlots(db, link, {from: start, to: new Date(start.getTime() + 60_000), duration, onlyHostId: opts.onlyHostId, exclude: opts.exclude});
  const slot = slots.find((s) => s.start === start.getTime());
  if (!slot) throw new HTTPException(409, {message: SLOT_TAKEN});
  return opts.onlyHostId ?? (await pickHost(db, link, slot.hostIds));
}

/** A CONFIRMED booking of this host overlapping [start, end) (other than `exceptId`), checked under the host's lock. */
async function hostBusy(tx: Prisma.TransactionClient, hostId: string, start: Date, end: Date, exceptId?: string) {
  const clash = await tx.booking.findFirst({
    where: {hostId, status: 'CONFIRMED', startAt: {lt: end}, endAt: {gt: start}, ...(exceptId ? {id: {not: exceptId}} : {})},
    select: {id: true},
  });
  return !!clash;
}

/**
 * The database decides who gets a time (docs/agent/orders-and-stock.md): one host's bookings are
 * written one at a time, under a lock held until the transaction ends, so two visitors (or two
 * reschedules) can never both get overlapping times with the same host.
 */
const lockHost = (tx: Prisma.TransactionClient, hostId: string) => lockFor(tx, `booking-host:${hostId}`);

/**
 * Books a slot: re-checks availability, picks the host (round robin on team
 * links), creates / updates the contact, the MEETING interaction (written to
 * the host's calendar, with a Meet / Teams link for video), the timeline
 * entry, the event, the host notification, confirmation emails and reminders.
 *
 * With `once` (the public booking page's idempotency key), the same attempt sent again books
 * nothing more: it answers the first booking's id with `replayed: true` and none of the above runs.
 */
export async function createBooking(db: Db, link: BookingLink, input: BookInput, once: Once | null = null): Promise<{id: string; replayed: boolean}> {
  if (!link.active) throw new HTTPException(403, {message: 'This booking link is turned off.'});
  // Forms ask their own questions; the link's apply to its booking page.
  const q = questionsOf(link.questions);
  if (input.source !== 'form') {
    if (q.phone === 'required' && !input.phone?.trim()) throw new HTTPException(400, {message: 'Phone number is required'});
    if (q.company === 'required' && !input.company?.trim()) throw new HTTPException(400, {message: 'Company is required'});
    if (q.notes === 'required' && !input.notes?.trim()) throw new HTTPException(400, {message: 'Please add a note'});
  }
  const start = new Date(input.start);
  const hostId = await claimSlot(db, link, start, input.duration);
  const host = (await hostsFor(db, link)).find((h) => h.id === hostId);
  if (!hostId || !host) throw new HTTPException(409, {message: SLOT_TAKEN});
  const end = new Date(start.getTime() + input.duration * 60_000);

  const title = `${link.name}: ${host.name} & ${input.name.trim()}`.slice(0, 300);
  // Only the clash check and the insert run under the host's lock; everything else comes after,
  // the contact too (found or made from the address once, by the request that booked).
  const made: {row?: Booking} = {};
  const {value, replayed} = await runOnce(db, once, async (tx) => {
    await lockHost(tx, hostId);
    if (await hostBusy(tx, hostId, start, end)) throw new HTTPException(409, {message: SLOT_TAKEN});
    const row = await tx.booking.create({
      data: {
        linkId: link.id,
        hostId,
        title,
        startAt: start,
        endAt: end,
        timezone: isTimeZone(input.timezone) ? input.timezone : link.timezone,
        name: input.name.trim().slice(0, 200),
        email: input.email.trim().toLowerCase(),
        phone: input.phone?.trim() || null,
        company: input.company?.trim() || null,
        notes: input.notes?.trim() || null,
        locationType: link.locationType,
        location: bookingLocation(link, input),
        source: input.source,
        meta: {...input.meta, origin: input.origin},
      },
    });
    made.row = row;
    return {id: row.id};
  });
  if (replayed || !made.row) return {id: value.id, replayed: true};
  let booking: Booking = made.row;

  const resolved = input.contactId ? await db.contact.findUnique({where: {id: input.contactId}}) : null;
  const {contact, companyId, isNew} = resolved
    ? {contact: resolved, companyId: (await db.contactCompany.findFirst({where: {contactId: resolved.id}, orderBy: {isPrimary: 'desc'}}))?.companyId ?? null, isNew: false}
    : await upsertContact(db, link, hostId, input);

  const openDeal = await db.deal.findFirst({where: {status: 'OPEN', contacts: {some: {contactId: contact.id}}}, orderBy: {lastActivityAt: 'desc'}, select: {id: true}});
  const details = [
    `Booked via ${link.name} (${durationLabel(input.duration)}).`,
    booking.phone && `Phone: ${booking.phone}`,
    booking.company && `Company: ${booking.company}`,
    booking.notes && `Notes: ${booking.notes}`,
  ].filter(Boolean);
  const interaction = await createInteraction(db, {
    kind: 'MEETING',
    title,
    body: details.join('\n'),
    occurredAt: start,
    durationMin: input.duration,
    locationType: link.locationType,
    location: booking.location,
    outcome: 'Scheduled',
    attendeeIds: [contact.id],
    contactId: contact.id,
    companyId,
    dealId: openDeal?.id ?? null,
    authorId: hostId,
  });
  booking = await db.booking.update({where: {id: booking.id}, data: {contactId: contact.id, interactionId: interaction.id, location: interaction.location}});
  await db.bookingLink.update({where: {id: link.id}, data: {bookingCount: {increment: 1}}});

  if (isNew) await emit(db, 'contact.created', {recordId: contact.id, data: contact});
  await emit(db, 'meeting.booked', {entity: 'interaction', recordId: interaction.id, data: eventData(booking, link)});
  await notify(db, [hostId, contact.ownerId], {
    type: 'meeting',
    title: `${booking.name} booked ${link.name}`,
    body: whenIn(start, link.timezone),
    link: recordLink.contact(contact.id),
  });
  await afterChange(db, booking, 'booked');
  return {id: booking.id, replayed: false};
}

const eventData = (b: Booking, link: Pick<BookingLink, 'id' | 'name'> | null) => ({
  bookingId: b.id,
  link: link ? {id: link.id, name: link.name} : null,
  hostId: b.hostId,
  contactId: b.contactId,
  interactionId: b.interactionId,
  status: b.status,
  startAt: b.startAt.toISOString(),
  endAt: b.endAt.toISOString(),
  timezone: b.timezone,
  invitee: {name: b.name, email: b.email, phone: b.phone, company: b.company, notes: b.notes},
  location: b.location,
  locationType: b.locationType,
  source: b.source,
  cancelReason: b.cancelReason,
});

/** Queues the emails and (re)schedules the 24 h / 1 h reminders. */
async function afterChange(db: Db, booking: Booking, change: 'booked' | 'rescheduled' | 'canceled') {
  await enqueue(db, 'booking.email', {bookingId: booking.id, change, at: booking.updatedAt.toISOString()});
  if (change !== 'canceled') {
    for (const [kind, before] of [['24h', 24 * 60], ['1h', 60]] as const) {
      const runAt = new Date(booking.startAt.getTime() - before * 60_000);
      // Too late for this reminder: the confirmation is still fresh in their inbox.
      if (runAt.getTime() - Date.now() < 15 * 60_000) continue;
      await enqueue(db, 'booking.reminder', {bookingId: booking.id, kind, startAt: booking.startAt.toISOString()}, {runAt});
    }
  }
}

// ─── Reschedule / cancel ────────────────────────────────────────────────────

export async function rescheduleBooking(db: Db, booking: Booking & {link: BookingLink | null}, input: {start: string; duration?: number; by: 'invitee' | 'host'; actorId?: string | null}) {
  if (booking.status !== 'CONFIRMED') throw new HTTPException(409, {message: 'This meeting was canceled.'});
  if (booking.startAt.getTime() < Date.now()) throw new HTTPException(409, {message: 'This meeting already took place.'});
  if (!booking.link) throw new HTTPException(409, {message: 'This meeting can no longer be rescheduled online. Reply to the confirmation email instead.'});
  const duration = input.duration ?? Math.round((booking.endAt.getTime() - booking.startAt.getTime()) / 60_000);
  const start = new Date(input.start);
  // Team links keep the same host, so the person who prepared stays on it.
  await claimSlot(db, booking.link, start, duration, {onlyHostId: booking.hostId, exclude: booking});
  const from = booking.startAt;
  const history = [...(((booking.meta as Record<string, unknown>).history as unknown[]) ?? []), {from: from.toISOString(), to: start.toISOString(), by: input.by, at: new Date().toISOString()}];
  const end = new Date(start.getTime() + duration * 60_000);
  // The same lock as booking: a reschedule and a booking (or two reschedules) never land on one time.
  const updated = await db.$transaction(async (tx) => {
    if (booking.hostId) {
      await lockHost(tx, booking.hostId);
      if (await hostBusy(tx, booking.hostId, start, end, booking.id)) throw new HTTPException(409, {message: SLOT_TAKEN});
    }
    const {count} = await tx.booking.updateMany({
      where: {id: booking.id, status: 'CONFIRMED'},
      data: {startAt: start, endAt: end, meta: {...(booking.meta as object), history} as Prisma.InputJsonValue},
    });
    if (!count) throw new HTTPException(409, {message: 'This meeting was canceled.'});
    return tx.booking.findUniqueOrThrow({where: {id: booking.id}});
  });
  if (updated.interactionId) {
    let interaction = await db.interaction.update({where: {id: updated.interactionId}, data: {occurredAt: start, durationMin: duration, outcome: 'Scheduled'}});
    interaction = await pushMeeting(db, interaction);
    await refreshInteractionActivity(db, interaction);
    await logActivity(db, {
      type: 'meeting_rescheduled',
      title: `Meeting rescheduled${input.by === 'invitee' ? ` by ${booking.name}` : ''}: ${booking.link.name}`,
      refId: interaction.id,
      actorId: input.actorId ?? null,
      contactId: interaction.contactId,
      companyId: interaction.companyId,
      dealId: interaction.dealId,
      data: {from: from.toISOString(), to: start.toISOString()},
    });
  }
  await emit(db, 'meeting.rescheduled', {entity: 'interaction', recordId: updated.interactionId, actorId: input.actorId, data: {...eventData(updated, booking.link), previousStartAt: from.toISOString()}});
  if (input.by === 'invitee') {
    await notify(db, [updated.hostId], {type: 'meeting', title: `${booking.name} rescheduled ${booking.link.name}`, body: whenIn(start, booking.link.timezone), link: booking.contactId ? recordLink.contact(booking.contactId) : '/meetings'});
  }
  await afterChange(db, updated, 'rescheduled');
  return updated;
}

export async function cancelBooking(db: Db, booking: Booking & {link: BookingLink | null}, input: {reason?: string | null; by: 'invitee' | 'host'; actorId?: string | null}) {
  if (booking.status === 'CANCELED') return booking;
  if (booking.startAt.getTime() < Date.now()) throw new HTTPException(409, {message: 'This meeting already took place.'});
  const reason = input.reason?.trim().slice(0, 1000) || null;
  const updated = await db.booking.update({where: {id: booking.id}, data: {status: 'CANCELED', canceledAt: new Date(), cancelReason: reason}});
  if (updated.interactionId) {
    const interaction = await db.interaction.update({where: {id: updated.interactionId}, data: {outcome: 'Canceled'}});
    await cancelMeetingEvents(db, interaction.id, reason ?? undefined);
    await refreshInteractionActivity(db, interaction);
    await logActivity(db, {
      type: 'meeting_canceled',
      title: `Meeting canceled${input.by === 'invitee' ? ` by ${booking.name}` : ''}: ${booking.link?.name ?? booking.title}`,
      refId: interaction.id,
      actorId: input.actorId ?? null,
      contactId: interaction.contactId,
      companyId: interaction.companyId,
      dealId: interaction.dealId,
      data: {reason},
      text: reason,
    });
  }
  await emit(db, 'meeting.canceled', {entity: 'interaction', recordId: updated.interactionId, actorId: input.actorId, data: eventData(updated, booking.link)});
  if (input.by === 'invitee') {
    await notify(db, [updated.hostId], {
      type: 'meeting',
      title: `${booking.name} canceled ${booking.link?.name ?? 'a meeting'}`,
      body: [whenIn(booking.startAt, booking.link?.timezone ?? 'UTC'), reason].filter(Boolean).join(' · '),
      link: booking.contactId ? recordLink.contact(booking.contactId) : '/meetings',
    });
  }
  await afterChange(db, updated, 'canceled');
  return updated;
}

/**
 * A booked meeting edited on the timeline (moved or marked canceled): the
 * booking follows without emails (the calendar invitation carries the change).
 * "Cancel booking" on the Meetings page is the way to cancel with an email.
 */
export async function mirrorToBooking(db: Db, i: {id: string; occurredAt: Date; durationMin: number | null; outcome: string | null}) {
  const booking = await db.booking.findUnique({where: {interactionId: i.id}});
  if (!booking || booking.status !== 'CONFIRMED') return;
  const end = new Date(i.occurredAt.getTime() + (i.durationMin ?? 30) * 60_000);
  if (i.outcome === 'Canceled') {
    await db.booking.update({where: {id: booking.id}, data: {status: 'CANCELED', canceledAt: new Date(), cancelReason: 'Canceled by the host'}});
  } else if (i.occurredAt.getTime() !== booking.startAt.getTime() || end.getTime() !== booking.endAt.getTime()) {
    await db.booking.update({where: {id: booking.id}, data: {startAt: i.occurredAt, endAt: end}});
  }
}

/** What the manage page shows (no internal ids beyond the booking's). */
export async function publicBooking(db: Db, b: Booking & {link: BookingLink | null; host: {name: string} | null}, origin: string) {
  return {
    id: b.id,
    status: b.status as 'CONFIRMED' | 'CANCELED',
    title: b.link?.name ?? b.title,
    linkId: b.link?.id ?? null,
    durations: numbers(b.link?.durations),
    duration: Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60_000),
    hostName: b.host?.name ?? null,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    timezone: b.timezone,
    name: b.name,
    email: b.email,
    locationType: b.locationType,
    location: b.location,
    cancelReason: b.cancelReason,
    past: b.startAt.getTime() < Date.now(),
    icsUrl: b.interactionId ? await icsUrl(origin, b.interactionId) : null,
  };
}

export type PublicBooking = Awaited<ReturnType<typeof publicBooking>>;
