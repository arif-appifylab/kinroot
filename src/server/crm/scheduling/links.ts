import type {BookingLink} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {slugify} from '@/lib/forms';
import {BOOKING_LINK_LIMITS, cut} from '@/lib/record-limits';
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
import {strings, numbers} from '../lib/json-list';

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
  // Every candidate checked in ONE query (not one query per try).
  const candidates = Array.from({length: 50}, (_, i) => (i ? `${root}-${i + 1}` : root));
  const taken = new Set(
    (await db.schedulingProfile.findMany({where: {handle: {in: candidates}, ...(exceptUserId ? {userId: {not: exceptUserId}} : {})}, select: {handle: true}, take: 50})).map((p) => p.handle),
  );
  return candidates.find((h) => !taken.has(h)) ?? `${root}-${Date.now().toString(36)}`;
}

/** Slugs are unique per owner (personal) or among team links. */
export async function uniqueLinkSlug(db: Db, link: {kind: string; userId: string | null}, base: string, exceptId?: string) {
  // Within the slug's limit: the name's slug itself, then a shorter root with room for "-50" or the time.
  const first = cut(slugify(base), BOOKING_LINK_LIMITS.slug).replace(/-+$/, '') || 'meeting';
  const root = cut(first, BOOKING_LINK_LIMITS.slug - 10).replace(/-+$/, '') || 'meeting';
  // Every candidate checked in ONE query (not one query per try).
  const candidates = Array.from({length: 50}, (_, i) => (i ? `${root}-${i + 1}` : first));
  const taken = new Set(
    (
      await db.bookingLink.findMany({
        where: {slug: {in: candidates}, kind: link.kind, ...(link.kind === 'personal' ? {userId: link.userId} : {}), ...(exceptId ? {id: {not: exceptId}} : {})},
        select: {slug: true},
        take: 50,
      })
    ).map((l) => l.slug),
  );
  return candidates.find((s) => !taken.has(s)) ?? `${root}-${Date.now().toString(36)}`;
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
  const profile = link.userId ? await db.schedulingProfile.findUnique({where: {userId: link.userId}, select: {handle: true}}) : null;
  return `${profile?.handle ?? 'unknown'}/${link.slug}`;
}

/** The paths of many links (link id → path) with ONE query for their owners' handles, never one per link. */
export async function linkPaths(db: Db, links: Pick<BookingLink, 'id' | 'kind' | 'slug' | 'userId'>[]): Promise<Map<string, string>> {
  const userIds = [...new Set(links.flatMap((l) => (l.kind !== 'team' && l.userId ? [l.userId] : [])))];
  const profiles = userIds.length ? await db.schedulingProfile.findMany({where: {userId: {in: userIds}}, select: {userId: true, handle: true}}) : [];
  const handles = new Map(profiles.map((p) => [p.userId, p.handle]));
  return new Map(links.map((l) => [l.id, l.kind === 'team' ? `team/${l.slug}` : `${(l.userId && handles.get(l.userId)) || 'unknown'}/${l.slug}`]));
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
  const ids = link.kind === 'team' ? strings(link.hostIds) : link.userId ? [link.userId] : [];
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
    durations: numbers(link.durations).length ? numbers(link.durations) : [30],
    locationType: link.locationType as LocationType,
    locationLabel: locationLabel(link.locationType, link.location),
    questions: questionsOf(link.questions),
    hosts: hosts.map((h) => ({name: h.name, color: h.color, avatarUrl: h.avatarUrl})),
    maxDaysAhead: link.maxDaysAhead,
    active: link.active && hosts.length > 0,
  };
}

// ─── Slots ──────────────────────────────────────────────────────────────────

type Exclude = {id: string; interactionId: string | null; startAt: Date; endAt: Date};

/**
 * Busy blocks of each host: CRM meetings they organise (bookings are meetings too) plus their
 * connected calendars. ONE query for all hosts' meetings, their calendars read side by side.
 * `exclude` is the booking being rescheduled, so its own time doesn't block itself.
 */
async function busyByHost(db: Db, hostIds: string[], from: Date, to: Date, exclude?: Exclude | null): Promise<Map<string, Interval[]>> {
  const [meetings, calendars] = await Promise.all([
    db.interaction.findMany({
      where: {
        kind: 'MEETING',
        authorId: {in: hostIds},
        occurredAt: {gte: new Date(from.getTime() - DAY), lt: to},
        OR: [{outcome: null}, {outcome: {not: 'Canceled'}}],
        ...(exclude?.interactionId ? {id: {not: exclude.interactionId}} : {}),
      },
      select: {authorId: true, occurredAt: true, durationMin: true},
    }),
    Promise.all(hostIds.map((id) => calendarBusy(db, id, from, to))),
  ]);
  // The booking's own calendar event shows up as busy too.
  const skip = exclude ? {start: exclude.startAt.getTime(), end: exclude.endAt.getTime()} : null;
  const out = new Map<string, Interval[]>();
  hostIds.forEach((id, i) => out.set(id, calendars[i]!.filter((b) => !skip || b.start !== skip.start || b.end !== skip.end)));
  for (const m of meetings) {
    const start = m.occurredAt.getTime();
    if (m.authorId) out.get(m.authorId)?.push({start, end: start + (m.durationMin ?? 30) * 60_000});
  }
  return out;
}

export type Slot = {start: number; hostIds: string[]};

/**
 * Open start times of a link between `from` and `to` (at most ~6 weeks), with
 * the hosts free at each. Team links offer a time when any host is free.
 * A fixed number of queries whatever the number of hosts (no query per host).
 */
export async function linkSlots(
  db: Db,
  link: BookingLink,
  opts: {from: Date; to: Date; duration: number; now?: number; onlyHostId?: string | null; exclude?: Exclude | null},
): Promise<Slot[]> {
  const now = opts.now ?? Date.now();
  const from = new Date(Math.max(opts.from.getTime(), now));
  const to = new Date(Math.min(opts.to.getTime(), from.getTime() + 45 * DAY, now + (link.maxDaysAhead + 2) * DAY));
  if (to <= from) return [];
  const hosts = (await hostsFor(db, link)).filter((h) => !opts.onlyHostId || h.id === opts.onlyHostId);
  if (!hosts.length) return [];
  const ids = hosts.map((h) => h.id);
  const [busyOf, booked] = await Promise.all([
    busyByHost(db, ids, new Date(from.getTime() - 2 * DAY), new Date(to.getTime() + DAY), opts.exclude),
    db.booking.findMany({
      where: {linkId: link.id, hostId: {in: ids}, status: 'CONFIRMED', startAt: {gte: new Date(from.getTime() - 2 * DAY), lt: new Date(to.getTime() + 2 * DAY)}, ...(opts.exclude ? {id: {not: opts.exclude.id}} : {})},
      select: {hostId: true, startAt: true, endAt: true},
    }),
  ]);
  const byStart = new Map<number, string[]>();
  for (const host of hosts) {
    const busy = busyOf.get(host.id) ?? [];
    const bookedPerDay: Record<string, number> = {};
    for (const b of booked) {
      if (b.hostId !== host.id) continue;
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
  const hostIds = strings(link.hostIds);
  const order = (id: string) => hostIds.indexOf(id);
  return [...candidates].sort((a, b) => lastAt(a) - lastAt(b) || order(a) - order(b))[0]!;
}
