import type {Booking, BookingLink, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {durationLabel, whenIn} from '@/lib/scheduling';
import {config, CRM_APP} from '../kit/config';
import type {Db} from '../kit/db';
import {sendSystemEmail} from '../email/service';
import {getSettings} from '../lib/settings';
import {googleCalendarUrl} from '../routes/interactions';
import {icsUrl, manageUrl} from './bookings';
import {linkPath} from './links';

type Meta = Record<string, unknown> & {origin?: string; sent?: Record<string, string>};
type Full = Booking & {link: BookingLink | null; host: User | null};

const where = (b: Booking) => {
  if (!b.location) return b.locationType === 'VIDEO' ? 'Video call (the link follows in a calendar invitation)' : null;
  if (b.locationType === 'VIDEO') return `Join: ${b.location}`;
  if (b.locationType === 'PHONE') return `Phone: ${b.location}`;
  if (b.locationType === 'IN_PERSON') return `Address: ${b.location}`;
  return b.location;
};

async function load(db: Db, bookingId: string) {
  return db.booking.findUnique({where: {id: bookingId}, include: {link: true, host: true}}) as Promise<Full | null>;
}

/** Records that one email went out, so a retried job never sends it twice. */
async function once(db: Db, b: Full, key: string, send: () => Promise<boolean>) {
  const meta = (b.meta ?? {}) as Meta;
  if (meta.sent?.[key]) return;
  const ok = await send();
  const fresh = ((await db.booking.findUnique({where: {id: b.id}, select: {meta: true}}))?.meta ?? {}) as Meta;
  await db.booking.update({where: {id: b.id}, data: {meta: {...fresh, sent: {...fresh.sent, [key]: ok ? new Date().toISOString() : 'no-account'}} as Prisma.InputJsonValue}});
}

/**
 * Job "booking.email": confirmation / reschedule / cancellation emails to the
 * invitee and the host. Sent from the shared team mailbox (sendSystemEmail);
 * without one, the host still has the in-app notification.
 */
export async function bookingEmail(db: Db, p: {bookingId: string; change: 'booked' | 'rescheduled' | 'canceled'; at?: string}) {
  const b = await load(db, p.bookingId);
  if (!b) return;
  const origin = config.siteUrl() || ((b.meta ?? {}) as Meta).origin || '';
  const brand = (await getSettings(db)).brandName;
  const title = b.link?.name ?? b.title;
  const hostName = b.host?.name ?? brand;
  const minutes = Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60_000);
  const manage = await manageUrl(origin, b.id);
  const interaction = b.interactionId ? await db.interaction.findUnique({where: {id: b.interactionId}}) : null;
  const ics = interaction ? await icsUrl(origin, interaction.id) : null;
  const key = `${p.change}:${p.at ?? ''}`;

  const verb = {booked: 'Confirmed', rescheduled: 'Rescheduled', canceled: 'Canceled'}[p.change];
  const inviteeLines = [
    `Hi ${b.name.split(' ')[0]},`,
    '',
    p.change === 'canceled'
      ? `Your ${title} with ${hostName} has been canceled.${b.cancelReason ? `\nReason: ${b.cancelReason}` : ''}`
      : p.change === 'rescheduled'
        ? `Your ${title} with ${hostName} has moved to a new time.`
        : `You're booked in for ${title} with ${hostName}.`,
    '',
    `When: ${whenIn(b.startAt, b.timezone)}, ${durationLabel(minutes)}`,
    p.change !== 'canceled' ? where(b) : null,
    '',
    ...(p.change === 'canceled'
      ? [b.link ? `Book a new time: ${origin}/book/${await linkPath(db, b.link)}` : null]
      : [
          interaction ? `Add to Google Calendar: ${googleCalendarUrl(interaction)}` : null,
          ics ? `Add to Outlook / Apple Calendar: ${ics}` : null,
          '',
          `Need to reschedule or cancel? ${manage}`,
        ]),
  ].filter((l) => l !== null);

  await once(db, b, `${key}:invitee`, () =>
    sendSystemEmail(db, {to: [b.email], subject: `${verb}: ${title} with ${hostName}`, text: inviteeLines.join('\n'), replyTo: b.host?.email}),
  );

  if (b.host?.email) {
    const contactUrl = b.contactId ? `${origin}${CRM_APP}/contacts/${b.contactId}` : `${origin}${CRM_APP}/meetings`;
    const hostLines = [
      p.change === 'canceled'
        ? `${b.name} canceled ${title}.${b.cancelReason ? `\nReason: ${b.cancelReason}` : ''}`
        : p.change === 'rescheduled'
          ? `${b.name} moved ${title} to a new time.`
          : `${b.name} booked ${title}.`,
      '',
      `When: ${whenIn(b.startAt, b.link?.timezone ?? b.timezone)}, ${durationLabel(minutes)}`,
      `Invitee: ${b.name} <${b.email}>${b.phone ? `, ${b.phone}` : ''}`,
      b.company ? `Company: ${b.company}` : null,
      b.notes ? `Notes: ${b.notes}` : null,
      p.change !== 'canceled' ? where(b) : null,
      '',
      `Open in ${brand}: ${contactUrl}`,
    ].filter((l) => l !== null);
    await once(db, b, `${key}:host`, () =>
      sendSystemEmail(db, {to: [b.host!.email], subject: `${p.change === 'booked' ? 'New booking' : verb}: ${title} with ${b.name}`, text: hostLines.join('\n'), replyTo: b.email}),
    );
  }
}

/** Job "booking.reminder": 24 h and 1 h before, unless it was canceled or moved since. */
export async function bookingReminder(db: Db, p: {bookingId: string; kind: '24h' | '1h'; startAt: string}) {
  const b = await load(db, p.bookingId);
  if (!b || b.status !== 'CONFIRMED' || b.startAt.toISOString() !== p.startAt || b.startAt.getTime() < Date.now()) return;
  const origin = config.siteUrl() || ((b.meta ?? {}) as Meta).origin || '';
  const title = b.link?.name ?? b.title;
  const hostName = b.host?.name ?? (await getSettings(db)).brandName;
  const lines = [
    `Hi ${b.name.split(' ')[0]},`,
    '',
    `A reminder: ${title} with ${hostName} starts ${p.kind === '1h' ? 'in about an hour' : 'tomorrow'}.`,
    '',
    `When: ${whenIn(b.startAt, b.timezone)}`,
    where(b),
    '',
    `Need to reschedule or cancel? ${await manageUrl(origin, b.id)}`,
  ].filter((l) => l !== null);
  await once(db, b, `reminder:${p.kind}:${p.startAt}`, () =>
    sendSystemEmail(db, {to: [b.email], subject: `Reminder: ${title} ${p.kind === '1h' ? 'in 1 hour' : 'tomorrow'}`, text: lines.join('\n'), replyTo: b.host?.email}),
  );
}
