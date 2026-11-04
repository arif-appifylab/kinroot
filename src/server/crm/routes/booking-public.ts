import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {isTimeZone, type PublicBookingLink} from '@/lib/scheduling';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import type {AppEnv} from '../kit/guards';
import {notFound, valid} from '../lib/http';
import {connectionLimits, rateLimit} from '../lib/rate-limit';
import {bookingFromToken, cancelBooking, createBooking, manageToken, publicBooking, rescheduleBooking, type PublicBooking} from '../scheduling/bookings';
import {linkByPath, linkSlots, toPublicLink} from '../scheduling/links';

export async function publicLinkByPath(db: Db, path: string): Promise<PublicBookingLink | null> {
  const link = await linkByPath(db, path);
  return link ? toPublicLink(db, link) : null;
}

export async function publicBookingByToken(db: Db, token: string, origin: string): Promise<PublicBooking | null> {
  const b = await bookingFromToken(db, token);
  return b ? publicBooking(db, b, origin) : null;
}

const optText = (max: number) => z.string().trim().max(max).optional().nullable();

/** An ISO date-time from the booking widget (`2026-11-03T00:00:00.000Z`); anything else is refused in words. */
const isoDateTime = z.iso.datetime({offset: true, error: 'must be a date and time like 2026-11-03T09:00:00Z'});

/** Booking pages, <BookingWidget> and the forms "booking slot" field talk to these. No sign-in. */
export const bookingPublic = new Hono<AppEnv>()
  .get('/booking/links/:first/:slug', async (c) => {
    const link = await publicLinkByPath(c.var.db, `${c.req.param('first')}/${c.req.param('slug')}`);
    if (!link) throw notFound('Booking link');
    return c.json({link});
  })

  .get('/booking/links/:id', async (c) => {
    const link = await c.var.db.bookingLink.findUnique({where: {id: c.req.param('id')}});
    if (!link) throw notFound('Booking link');
    return c.json({link: await toPublicLink(c.var.db, link)});
  })

  /** Open start times (ISO, UTC) in [from, to). With `reschedule` (a manage token) the booking's own time and host are used. */
  .get(
    '/booking/slots',
    valid('query', z.object({
      linkId: z.string().max(40).optional(),
      duration: z.string().regex(/^\d{1,3}$/, 'must be minutes').transform(Number).pipe(z.number().int().min(5).max(480)),
      from: isoDateTime,
      to: isoDateTime,
      reschedule: z.string().max(200).optional(),
    })),
    async (c) => {
      const db = c.var.db;
      const q = c.req.valid('query');
      // Public and costly (calendar reads for every host): bounded per connection.
      await rateLimit(db, await connectionLimits((n) => c.req.header(n), 'booking:slots', 60, 600), 'Too many requests for open times. Please wait a moment and try again.');
      const booking = q.reschedule ? await bookingFromToken(db, q.reschedule) : null;
      if (q.reschedule && !booking) throw new HTTPException(400, {message: 'This link is not valid'});
      const link = booking?.link ?? (q.linkId ? await db.bookingLink.findUnique({where: {id: q.linkId}}) : null);
      if (!link) throw notFound('Booking link');
      if (!link.active && !booking) return c.json({slots: []});
      const slots = await linkSlots(db, link, {
        from: new Date(q.from),
        to: new Date(q.to),
        duration: q.duration,
        onlyHostId: booking?.hostId,
        exclude: booking,
      });
      c.header('cache-control', 'no-store');
      return c.json({slots: slots.map((s) => new Date(s.start).toISOString())});
    },
  )

  .post(
    '/booking/book',
    valid('json', z.object({
      linkId: z.string(),
      start: z.string(),
      duration: z.number().int().min(5).max(480),
      timezone: z.string().max(80),
      name: z.string().trim().min(1, 'is required').max(200),
      email: z.email('enter a valid email').max(200),
      phone: optText(40),
      company: optText(200),
      notes: optText(5000),
      source: z.enum(['page', 'widget']).default('page'),
      hp: z.string().optional(),
      startedAt: z.number().optional(),
    })),
    async (c) => {
      const db = c.var.db;
      const body = c.req.valid('json');
      // Honeypot filled or an inhumanly fast submit.
      if (body.hp || (body.startedAt && Date.now() - body.startedAt < 1500)) throw new HTTPException(400, {message: 'Please try again.'});
      // It sends an invitation to the address typed in: bounded per connection (docs/agent/security.md A06).
      await rateLimit(db, await connectionLimits((n) => c.req.header(n), 'booking:book', 5, 20), 'You have booked several meetings in a short time. Please wait a while and try again.');
      const link = await db.bookingLink.findUnique({where: {id: body.linkId}});
      if (!link) throw notFound('Booking link');
      const origin = publicOrigin(c.req.raw);
      const booking = await createBooking(db, link, {...body, origin});
      const full = (await bookingFromToken(db, await manageToken(booking.id)))!;
      return c.json({booking: await publicBooking(db, full, origin), token: await manageToken(booking.id)}, 201);
    },
  )

  .get('/booking/manage/:token', async (c) => {
    const booking = await publicBookingByToken(c.var.db, c.req.param('token'), publicOrigin(c.req.raw));
    if (!booking) throw notFound('Booking');
    return c.json({booking});
  })

  .post('/booking/manage/:token/cancel', valid('json', z.object({reason: z.string().max(1000).optional()})), async (c) => {
    const db = c.var.db;
    const b = await bookingFromToken(db, c.req.param('token'));
    if (!b) throw notFound('Booking');
    await cancelBooking(db, b, {reason: c.req.valid('json').reason, by: 'invitee'});
    return c.json({booking: await publicBookingByToken(db, c.req.param('token'), publicOrigin(c.req.raw))});
  })

  .post('/booking/manage/:token/reschedule', valid('json', z.object({start: z.string(), timezone: z.string().max(80).optional()})), async (c) => {
    const db = c.var.db;
    const b = await bookingFromToken(db, c.req.param('token'));
    if (!b) throw notFound('Booking');
    const body = c.req.valid('json');
    const timezone = isTimeZone(body.timezone) ? body.timezone : b.timezone;
    if (timezone !== b.timezone) await db.booking.update({where: {id: b.id}, data: {timezone}});
    await rescheduleBooking(db, {...b, timezone}, {start: body.start, by: 'invitee'});
    return c.json({booking: await publicBookingByToken(db, c.req.param('token'), publicOrigin(c.req.raw))});
  });
