import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {BookingLink, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {availabilityError, defaultAvailability, defaultQuestions, isTimeZone, RESERVED_HANDLES} from '@/lib/scheduling';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {notFound, optStr, ownerScope, valid} from '../lib/http';
import {userSelect} from '../lib/users';
import {cancelBooking, manageUrl} from '../scheduling/bookings';
import {ensureProfile, linkPath, linkPaths, uniqueHandle, uniqueLinkSlug} from '../scheduling/links';
import {strings} from '../lib/json-list';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const range = z.object({start: z.string().regex(HHMM, 'use HH:MM'), end: z.string().regex(HHMM_END, 'use HH:MM')});
const mode = z.enum(['off', 'optional', 'required']);

const linkFields = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG, 'use lowercase letters, numbers and dashes').max(60),
  description: optStr,
  durations: z.array(z.number().int().min(5).max(480)).min(1, 'offer at least one duration').max(6),
  timezone: z.string().refine((tz) => isTimeZone(tz), 'is not a known timezone'),
  availability: z.object({
    weekly: z.record(z.string().regex(/^[0-6]$/, 'use weekdays 0–6'), z.array(range).max(6)),
    overrides: z.array(z.object({date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ranges: z.array(range).max(6)})).max(200),
  }),
  bufferBefore: z.number().int().min(0).max(240),
  bufferAfter: z.number().int().min(0).max(240),
  minNoticeMin: z.number().int().min(0).max(60 * 24 * 60),
  maxDaysAhead: z.number().int().min(1).max(365),
  dailyLimit: z.number().int().min(1).max(50).nullable(),
  slotStepMin: z.number().int().min(5).max(240).nullable(),
  locationType: z.enum(['VIDEO', 'PHONE', 'IN_PERSON', 'OTHER']),
  location: optStr,
  questions: z.object({phone: mode, company: mode, notes: mode}),
  hostIds: z.array(z.string()).max(50),
  active: z.boolean(),
});

/** Members manage their own links; team links (and anyone's links) need an admin. */
function canManage(me: User, link: Pick<BookingLink, 'kind' | 'userId'>) {
  return isAdmin(me) || (link.kind === 'personal' && link.userId === me.id);
}

async function ownLink(c: AppContext, id: string) {
  const link = await c.var.db.bookingLink.findUnique({where: {id}});
  if (!link) throw notFound('Booking link');
  if (!canManage(currentUser(c), link)) throw new HTTPException(403, {message: link.kind === 'team' ? 'Only admins can change team links' : "You can only change your own booking links"});
  return link;
}

async function withPath(c: AppContext, link: BookingLink) {
  const origin = publicOrigin(c.req.raw);
  const path = await linkPath(c.var.db, link);
  return {...link, path, url: `${origin}/book/${path}`};
}

export const scheduling = new Hono<AppEnv>()
  // ─── Profile: booking handle + default timezone ───
  .get('/profile', valid('query', z.object({tz: z.string().optional()})), async (c) => {
    const me = currentUser(c);
    const profile = await ensureProfile(c.var.db, me, c.req.valid('query').tz);
    return c.json({profile, baseUrl: `${publicOrigin(c.req.raw)}/book/${profile.handle}`});
  })

  .patch('/profile', valid('json', z.object({handle: z.string().trim().toLowerCase().regex(SLUG, 'use lowercase letters, numbers and dashes').min(2).max(40).optional(), timezone: z.string().refine((tz) => isTimeZone(tz), 'is not a known timezone').optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const body = c.req.valid('json');
    await ensureProfile(db, me, body.timezone);
    if (body.handle) {
      if (RESERVED_HANDLES.includes(body.handle)) throw new HTTPException(400, {message: `"${body.handle}" is reserved, pick another handle`});
      const taken = await db.schedulingProfile.findFirst({where: {handle: body.handle, userId: {not: me.id}}});
      if (taken) throw new HTTPException(409, {message: `${body.handle} is taken. Try ${await uniqueHandle(db, body.handle, me.id)}`});
    }
    const profile = await db.schedulingProfile.update({where: {userId: me.id}, data: body});
    return c.json({profile, baseUrl: `${publicOrigin(c.req.raw)}/book/${profile.handle}`});
  })

  // ─── Booking links ───
  .get('/links', async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.bookingLink.findMany({
      where: isAdmin(me) ? {OR: [{kind: 'team'}, {userId: me.id}]} : {OR: [{userId: me.id}, {kind: 'team', hostIds: {array_contains: [me.id]}}]},
      include: {user: {select: userSelect}},
      orderBy: [{kind: 'asc'}, {createdAt: 'asc'}],
    });
    // Every link's path from ONE query for the owners' handles (never one per link).
    const paths = await linkPaths(c.var.db, rows);
    const origin = publicOrigin(c.req.raw);
    return c.json({rows: rows.map((r) => ({...r, path: paths.get(r.id)!, url: `${origin}/book/${paths.get(r.id)}`, user: r.user, canEdit: canManage(me, r)}))});
  })

  .get('/links/:id', async (c) => {
    const me = currentUser(c);
    const link = await c.var.db.bookingLink.findUnique({where: {id: c.req.param('id')}, include: {user: {select: userSelect}}});
    if (!link || (!canManage(me, link) && !strings(link.hostIds).includes(me.id))) throw notFound('Booking link');
    return c.json({link: {...(await withPath(c, link)), user: link.user, canEdit: canManage(me, link)}});
  })

  .post('/links', valid('json', z.object({name: z.string().trim().min(1, 'is required').max(120), kind: z.enum(['personal', 'team']).default('personal'), timezone: z.string().optional(), durations: z.array(z.number().int().min(5).max(480)).min(1).max(6).optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const body = c.req.valid('json');
    if (body.kind === 'team' && !isAdmin(me)) throw new HTTPException(403, {message: 'Only admins can create team links'});
    const profile = await ensureProfile(db, me, body.timezone);
    const timezone = isTimeZone(body.timezone) ? body.timezone : profile.timezone;
    const link = await db.bookingLink.create({
      data: {
        kind: body.kind,
        userId: me.id,
        hostIds: body.kind === 'team' ? [me.id] : [],
        name: body.name,
        slug: await uniqueLinkSlug(db, {kind: body.kind, userId: me.id}, body.name),
        durations: body.durations ?? [30],
        timezone,
        availability: defaultAvailability(),
        questions: defaultQuestions(),
      },
    });
    await audit(db, c, {action: 'booking_link.created', entity: 'booking_link', recordId: link.id, label: link.name, meta: {kind: link.kind, slug: link.slug}});
    return c.json({link: await withPath(c, link)}, 201);
  })

  .patch('/links/:id', valid('json', linkFields.partial()), async (c) => {
    const db = c.var.db;
    const link = await ownLink(c, c.req.param('id'));
    const body = c.req.valid('json');
    if (body.availability) {
      const error = availabilityError(body.availability);
      if (error) throw new HTTPException(400, {message: error});
    }
    if (body.slug && body.slug !== link.slug && (await uniqueLinkSlug(db, link, body.slug, link.id)) !== body.slug) {
      throw new HTTPException(409, {message: `The address /${body.slug} is already used by another link`});
    }
    if (body.hostIds) {
      if (link.kind !== 'team') delete body.hostIds;
      else {
        const users = await db.member.findMany({where: {id: {in: body.hostIds}, active: true, role: {not: 'VIEWER'}}, select: {id: true}});
        body.hostIds = body.hostIds.filter((id) => users.some((u) => u.id === id));
        if (!body.hostIds.length) throw new HTTPException(400, {message: 'Pick at least one person for the rotation'});
      }
    }
    if (body.durations) body.durations = [...new Set(body.durations)];
    const updated = await db.bookingLink.update({where: {id: link.id}, data: body as Prisma.BookingLinkUncheckedUpdateInput});
    await audit(db, c, {action: 'booking_link.updated', entity: 'booking_link', recordId: link.id, label: updated.name, meta: {changed: Object.keys(body), ...(body.active !== undefined ? {active: body.active} : {}), ...(body.slug ? {slug: body.slug} : {})}});
    return c.json({link: await withPath(c, updated)});
  })

  .delete('/links/:id', async (c) => {
    const link = await ownLink(c, c.req.param('id'));
    // Booked meetings stay on the timeline; their bookings just lose the link.
    await c.var.db.bookingLink.delete({where: {id: link.id}});
    await audit(c.var.db, c, {action: 'booking_link.deleted', entity: 'booking_link', recordId: link.id, label: link.name, meta: {kind: link.kind, slug: link.slug, bookings: link.bookingCount}});
    return c.json({ok: true});
  })

  // ─── Meetings (MEETING interactions, with their booking when booked online) ───
  .get('/meetings', valid('query', z.object({when: z.enum(['upcoming', 'past']).default('upcoming'), scope: z.enum(['mine', 'all']).default('mine'), take: z.coerce.number().int().min(1).max(200).default(100)})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const q = c.req.valid('query');
    const restricted = 'ownerId' in (await ownerScope(c));
    const now = new Date();
    const rows = await db.interaction.findMany({
      where: {
        kind: 'MEETING',
        ...(q.scope === 'mine' || restricted ? {authorId: me.id} : {}),
        ...(q.when === 'upcoming' ? {occurredAt: {gte: new Date(now.getTime() - 60 * 60_000)}, OR: [{outcome: null}, {outcome: {not: 'Canceled'}}]} : {occurredAt: {lt: now}}),
      },
      include: {author: {select: userSelect}, contact: {select: {id: true, firstName: true, lastName: true, email: true}}, company: {select: {id: true, name: true}}, deal: {select: {id: true, title: true}}},
      orderBy: {occurredAt: q.when === 'upcoming' ? 'asc' : 'desc'},
      take: q.take,
    });
    const ids = rows.map((r) => r.id);
    // Independent reads, side by side.
    const [bookings, events] = await Promise.all([
      db.booking.findMany({where: {interactionId: {in: ids}}, include: {link: {select: {id: true, name: true}}}}),
      db.calendarEvent.findMany({where: {interactionId: {in: ids}}, select: {interactionId: true}}),
    ]);
    const origin = publicOrigin(c.req.raw);
    const calendarIds = new Set(events.map((e) => e.interactionId));
    const bookingOf = new Map(bookings.map((b) => [b.interactionId, b]));
    return c.json({
      // No query per row: only the manage link is signed per booking (in memory).
      rows: await Promise.all(
        rows.map(async (r) => {
          const b = bookingOf.get(r.id);
          return {
            ...r,
            onCalendar: calendarIds.has(r.id),
            booking: b
              ? {id: b.id, status: b.status, source: b.source, name: b.name, email: b.email, linkName: b.link?.name ?? null, manageUrl: await manageUrl(origin, b.id)}
              : null,
          };
        }),
      ),
    });
  })

  /** The host cancels a booked meeting; the invitee gets the cancellation email. */
  .post('/bookings/:id/cancel', valid('json', z.object({reason: z.string().max(1000).optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const booking = await db.booking.findUnique({where: {id: c.req.param('id')}, include: {link: true}});
    if (!booking) throw notFound('Booking');
    if (booking.hostId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the host can cancel this meeting'});
    const updated = await cancelBooking(db, booking, {reason: c.req.valid('json').reason, by: 'host', actorId: me.id});
    await audit(db, c, {action: 'booking.canceled', entity: 'booking', recordId: booking.id, label: `${booking.title} · ${booking.name}`, meta: {startAt: booking.startAt, reason: c.req.valid('json').reason}});
    return c.json({booking: updated});
  });
