import type {BookingLink} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {slugify} from '@/lib/forms';
import {
  availabilityOf,
  computeSlots,
  isTimeZone,
  localDate,
  questionsOf,
  RESERVED_HANDLES,
  type Interval,
  type LocationType,
  type PublicBookingLink,
} from '@/lib/scheduling';
import type {Db} from '../kit/db';
import {calendarBusy} from '../calendar/service';

const DAY = 86_400_000;

// ─── Profiles (handle + default timezone) ───────────────────────────────────

/** The user's scheduling profile, created on first use with a handle from their name. */
export async function ensureProfile(db: Db, user: Pick<User, 'id' | 'name' | 'email'>, timezone?: string | null) {
  const existing = await db.schedulingProfile.findUnique({where: {userId: user.id}});
  if (existing) return existing;
  const handle = await uniqueHandle(db, user.name || user.email.split('@')[0]!);
  return db.schedulingProfile.upsert({
    where: {userId: user.id},
    create: {userId: user.id, handle, timezone: isTimeZone(timezone) ? timezone : 'UTC'},
    update: {},
  });
}

export async function uniqueHandle(db: Db, base: string, exceptUserId?: string) {
  let root = slugify(base).slice(0, 40);
  if (RESERVED_HANDLES.includes(root)) root = `${root}-1`;
  for (let i = 0; i < 50; i++) {
    const handle = i ? `${root}-${i + 1}` : root;
    const taken = await db.schedulingProfile.findFirst({where: {handle, ...(exceptUserId ? {userId: {not: exceptUserId}} : {})}, select: {userId: true}});
    if (!taken) return handle;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Slugs are unique per owner (personal) or among team links. */
export async function uniqueLinkSlug(db: Db, link: {kind: string; userId: string | null}, base: string, exceptId?: string) {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${root}-${i + 1}` : root;
    const taken = await db.bookingLink.findFirst({
      where: {slug, kind: link.kind, ...(link.kind === 'personal' ? {userId: link.userId} : {}), ...(exceptId ? {id: {not: exceptId}} : {})},
      select: {id: true},
    });
    if (!taken) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// ─── Public view ────────────────────────────────────────────────────────────

/** "sales-team/intro-call" or "team/demo" → the link, when it's live. */
export async function linkByPath(db: Db, path: string) {
  const [first, slug] = path.split('/');
  if (!first || !slug) return null;
  if (first === 'team') return db.bookingLink.findFirst({where: {kind: 'team', slug}, include: {user: true}});
  const profile = await db.schedulingProfile.findUnique({where: {handle: first}});
  if (!profile) return null;
  return db.bookingLink.findFirst({where: {kind: 'personal', userId: profile.userId, slug}, include: {user: true}});
}

export async function linkPath(db: Db, link: Pick<BookingLink, 'kind' | 'slug' | 'userId'>) {
  if (link.kind === 'team') return `team/${link.slug}`;
  const profile = link.userId ? await db.schedulingProfile.findUnique({where: {userId: link.userId}}) : null;
  return `${profile?.handle ?? 'unknown'}/${link.slug}`;
}

export function locationLabel(type: string, location: string | null) {
  switch (type as LocationType) {
    case 'VIDEO':
      return 'Video call';
    case 'PHONE':
      return location ? 'Phone call' : 'Phone call (we call you)';
    case 'IN_PERSON':
      return location ? `In person · ${location}` : 'In person';
    default:
      return location || 'Details after booking';
  }
}

/** Active hosts of a link, in rotation order. */
export async function hostsFor(db: Db, link: Pick<BookingLink, 'kind' | 'userId' | 'hostIds'>) {
  const ids = link.kind === 'team' ? link.hostIds : link.userId ? [link.userId] : [];
  if (!ids.length) return [];
  const users = await db.member.findMany({where: {id: {in: ids}, active: true}});
  return ids.map((id) => users.find((u) => u.id === id)).filter((u): u is User => !!u);
}

export async function toPublicLink(db: Db, link: BookingLink): Promise<PublicBookingLink> {
  const hosts = await hostsFor(db, link);
  return {
    id: link.id,
    kind: link.kind === 'team' ? 'team' : 'personal',
    path: await linkPath(db, link),
    name: link.name,
    description: link.description,
    durations: link.durations.length ? link.durations : [30],
    locationType: link.locationType as LocationType,
    locationLabel: locationLabel(link.locationType, link.location),
    questions: questionsOf(link.questions),
    hosts: hosts.map((h) => ({name: h.name, color: h.color, avatarUrl: h.avatarUrl})),
    maxDaysAhead: link.maxDaysAhead,
    active: link.active && hosts.length > 0,
  };
}

// ─── Slots ──────────────────────────────────────────────────────────────────

/**
 * Busy blocks of one host: upcoming CRM meetings they organise (bookings are
 * meetings too) plus their connected calendars. `exclude` is the booking being
 * rescheduled, so its own time doesn't block itself.
 */
export async function hostBusy(db: Db, hostId: string, from: Date, to: Date, exclude?: {interactionId: string | null; startAt: Date; endAt: Date} | null): Promise<Interval[]> {
  const meetings = await db.interaction.findMany({
    where: {
      kind: 'MEETING',
      authorId: hostId,
      occurredAt: {gte: new Date(from.getTime() - DAY), lt: to},
      OR: [{outcome: null}, {outcome: {not: 'Canceled'}}],
      ...(exclude?.interactionId ? {id: {not: exclude.interactionId}} : {}),
    },
    select: {occurredAt: true, durationMin: true},
  });
  const own = meetings.map((m) => ({start: m.occurredAt.getTime(), end: m.occurredAt.getTime() + (m.durationMin ?? 30) * 60_000}));
  const calendar = await calendarBusy(db, hostId, from, to);
  // The booking's own calendar event shows up as busy too.
  const skip = exclude ? {start: exclude.startAt.getTime(), end: exclude.endAt.getTime()} : null;
  return [...own, ...calendar.filter((b) => !skip || b.start !== skip.start || b.end !== skip.end)];
}

export type Slot = {start: number; hostIds: string[]};

/**
 * Open start times of a link between `from` and `to` (at most ~6 weeks), with
 * the hosts free at each. Team links offer a time when any host is free.
 */
export async function linkSlots(
  db: Db,
  link: BookingLink,
  opts: {from: Date; to: Date; duration: number; now?: number; onlyHostId?: string | null; exclude?: {id: string; interactionId: string | null; startAt: Date; endAt: Date} | null},
): Promise<Slot[]> {
  const now = opts.now ?? Date.now();
  const from = new Date(Math.max(opts.from.getTime(), now));
  const to = new Date(Math.min(opts.to.getTime(), from.getTime() + 45 * DAY, now + (link.maxDaysAhead + 2) * DAY));
  if (to <= from) return [];
  const hosts = (await hostsFor(db, link)).filter((h) => !opts.onlyHostId || h.id === opts.onlyHostId);
  const byStart = new Map<number, string[]>();
  for (const host of hosts) {
    const busy = await hostBusy(db, host.id, new Date(from.getTime() - 2 * DAY), new Date(to.getTime() + DAY), opts.exclude);
    const booked = await db.booking.findMany({
      where: {linkId: link.id, hostId: host.id, status: 'CONFIRMED', startAt: {gte: new Date(from.getTime() - 2 * DAY), lt: new Date(to.getTime() + 2 * DAY)}, ...(opts.exclude ? {id: {not: opts.exclude.id}} : {})},
      select: {startAt: true, endAt: true},
    });
    const bookedPerDay: Record<string, number> = {};
    for (const b of booked) {
      const d = localDate(b.startAt.getTime(), link.timezone);
      bookedPerDay[d] = (bookedPerDay[d] ?? 0) + 1;
      // Earlier bookings of this link keep their own buffers too.
      if (link.bufferBefore) busy.push({start: b.startAt.getTime() - link.bufferBefore * 60_000, end: b.startAt.getTime()});
      if (link.bufferAfter) busy.push({start: b.endAt.getTime(), end: b.endAt.getTime() + link.bufferAfter * 60_000});
    }
    const slots = computeSlots({
      availability: availabilityOf(link.availability),
      timezone: link.timezone,
      duration: opts.duration,
      step: link.slotStepMin,
      bufferBefore: link.bufferBefore,
      bufferAfter: link.bufferAfter,
      minNoticeMin: link.minNoticeMin,
      maxDaysAhead: link.maxDaysAhead,
      dailyLimit: link.dailyLimit,
      busy,
      bookedPerDay,
      from: from.getTime(),
      to: to.getTime(),
      now,
    });
    for (const s of slots) byStart.set(s, [...(byStart.get(s) ?? []), host.id]);
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, hostIds]) => ({start, hostIds}));
}

/** Round robin: of the hosts free at that time, whoever was booked least recently on this link. */
export async function pickHost(db: Db, link: BookingLink, candidates: string[]) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const last = await db.booking.groupBy({by: ['hostId'], where: {linkId: link.id, hostId: {in: candidates}}, _max: {createdAt: true}});
  const lastAt = (id: string) => last.find((l) => l.hostId === id)?._max.createdAt?.getTime() ?? 0;
  const order = (id: string) => link.hostIds.indexOf(id);
  return [...candidates].sort((a, b) => lastAt(a) - lastAt(b) || order(a) - order(b))[0]!;
}
