import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Interaction, InteractionKind, Prisma} from '../../../generated/prisma/client';
import {publicOrigin} from '../kit/config';
import {sign, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import {currentUser, isAdmin, type AppEnv} from '../kit/guards';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {notifyWatchers} from '../lib/notify';
import {isoDate, notFound, optStr, valid} from '../lib/http';
import {getSettings} from '../lib/settings';
import {userSelect} from '../lib/users';
import {sendEmail} from '../email/service';
import {cancelMeetingEvents, pushMeeting} from '../calendar/service';
import {mirrorToBooking} from '../scheduling/bookings';

const kinds = ['CALL', 'MEETING', 'EMAIL', 'SMS', 'LINKEDIN', 'WHATSAPP', 'POSTAL'] as const;

export const LABEL: Record<InteractionKind, string> = {
  CALL: 'call',
  MEETING: 'meeting',
  EMAIL: 'email',
  SMS: 'SMS',
  LINKEDIN: 'LinkedIn message',
  WHATSAPP: 'WhatsApp message',
  POSTAL: 'postal mail',
};

const body = z.object({
  kind: z.enum(kinds),
  title: optStr,
  body: optStr,
  occurredAt: isoDate,
  durationMin: z.coerce.number().int().min(0).max(24 * 60).nullish(),
  outcome: optStr,
  direction: z.enum(['INBOUND', 'OUTBOUND']).nullish(),
  locationType: z.enum(['VIDEO', 'PHONE', 'IN_PERSON', 'OTHER']).nullish(),
  location: optStr,
  attendeeIds: z.array(z.string()).max(50).optional(),
  contactId: z.string().nullish(),
  companyId: z.string().nullish(),
  dealId: z.string().nullish(),
  /** "Create a to-do to follow up in N business days" */
  followUp: z.object({days: z.number().int().min(0).max(90), type: z.enum(['TODO', 'CALL', 'EMAIL', 'MEETING']).default('TODO')}).optional(),
  /** Meetings: email the details + calendar links to attendees from this account. */
  invite: z.object({accountId: z.string().optional(), message: z.string().max(5000).optional()}).optional(),
});

function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  d.setHours(9, 0, 0, 0);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

async function attendees(db: Db, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db.contact.findMany({where: {id: {in: ids}}, select: {id: true, firstName: true, lastName: true, email: true}});
  return rows.map((r) => ({id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' '), email: r.email}));
}

function headline(i: Pick<Interaction, 'kind' | 'title' | 'occurredAt'>) {
  if (i.kind === 'MEETING') {
    const upcoming = i.occurredAt.getTime() > Date.now();
    return `${upcoming ? 'Meeting scheduled' : 'Meeting'}${i.title ? `: ${i.title}` : ''}`;
  }
  return `Logged ${LABEL[i.kind]}${i.title ? `: ${i.title}` : ''}`;
}

async function snapshot(db: Db, i: Interaction): Promise<Prisma.InputJsonValue> {
  return {
    kind: i.kind,
    title: i.title,
    body: i.body?.slice(0, 2000) ?? null,
    outcome: i.outcome,
    direction: i.direction,
    durationMin: i.durationMin,
    locationType: i.locationType,
    location: i.location,
    occurredAt: i.occurredAt.toISOString(),
    attendees: (await attendees(db, i.attendeeIds)).map(({id, name}) => ({id, name})),
  };
}

/**
 * Creates an interaction and its timeline entry. Shared by the API, bookings
 * and calendar sync so the snapshot is always built the same way. Upcoming
 * meetings are written to the author's connected calendar first, so an
 * auto-created Meet / Teams link is part of the snapshot.
 */
export async function createInteraction(db: Db, data: Prisma.InteractionUncheckedCreateInput, opts: {calendar?: boolean} = {}) {
  let interaction = await db.interaction.create({data});
  if (opts.calendar !== false) interaction = await pushMeeting(db, interaction);
  await logActivity(db, {
    type: `interaction_${interaction.kind}`,
    title: headline(interaction),
    refId: interaction.id,
    actorId: interaction.authorId,
    contactId: interaction.contactId,
    companyId: interaction.companyId,
    dealId: interaction.dealId,
    at: interaction.occurredAt,
    data: await snapshot(db, interaction),
    text: [interaction.title, interaction.body, interaction.outcome].filter(Boolean).join('\n'),
  });
  return interaction;
}

/**
 * A call, meeting or message logged by `author`: createInteraction(), the
 * `interaction.logged` event and follower notifications. Shared by this route
 * and the Data in API.
 */
export async function logInteraction(db: Db, data: Omit<Prisma.InteractionUncheckedCreateInput, 'authorId'>, author: {id: string; name: string}) {
  const interaction = await createInteraction(db, {...data, authorId: author.id});
  await emit(db, 'interaction.logged', {recordId: interaction.id, actorId: author.id, data: interaction});
  await notifyWatchers(db, interaction, {type: 'activity', title: (record) => `${author.name} ${interaction.kind === 'MEETING' && interaction.occurredAt > new Date() ? 'scheduled a' : 'logged a'} ${LABEL[interaction.kind]} on ${record}`, body: interaction.body, actorId: author.id});
  return interaction;
}

/** Re-renders the timeline entry after the interaction changed. */
export async function refreshInteractionActivity(db: Db, interaction: Interaction) {
  await db.activity.updateMany({
    where: {refId: interaction.id, type: `interaction_${interaction.kind}`},
    data: {
      title: headline(interaction),
      createdAt: interaction.occurredAt,
      data: await snapshot(db, interaction),
      text: [interaction.title, interaction.body, interaction.outcome].filter(Boolean).join('\n'),
    },
  });
}

// ─── Calendar helpers ───

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);

function buildIcs(i: Interaction, organizer: {name: string; email: string}, people: {name: string; email: string | null}[], brand: string) {
  const end = new Date(i.occurredAt.getTime() + (i.durationMin ?? 30) * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${brand}//CRM//EN`,
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${i.id}@crm`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(i.occurredAt)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(i.title ?? 'Meeting')}`,
    i.body ? `DESCRIPTION:${icsText(i.body)}` : null,
    i.location ? `LOCATION:${icsText(i.location)}` : null,
    `ORGANIZER;CN=${icsText(organizer.name)}:mailto:${organizer.email}`,
    ...people.filter((p) => p.email).map((p) => `ATTENDEE;CN=${icsText(p.name)};RSVP=TRUE:mailto:${p.email}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .filter(Boolean)
    .join('\r\n');
}

export function googleCalendarUrl(i: Interaction) {
  const end = new Date(i.occurredAt.getTime() + (i.durationMin ?? 30) * 60_000);
  const p = new URLSearchParams({action: 'TEMPLATE', text: i.title ?? 'Meeting', dates: `${icsDate(i.occurredAt)}/${icsDate(end)}`});
  if (i.body) p.set('details', i.body);
  if (i.location) p.set('location', i.location);
  return `https://calendar.google.com/calendar/render?${p}`;
}

/** Public, signed: lets invite recipients add the meeting to any calendar. */
export const meetingsPublic = new Hono<AppEnv>().get('/meetings/:id/invite.ics', async (c) => {
  const id = c.req.param('id');
  if (!(await verifySignature(`ics|${id}`, c.req.query('s') ?? ''))) return c.text('Invalid link', 400);
  const meeting = await c.var.db.interaction.findUnique({where: {id}, include: {author: true}});
  if (!meeting || meeting.kind !== 'MEETING') return c.text('Not found', 404);
  const settings = await getSettings(c.var.db);
  const people = await attendees(c.var.db, meeting.attendeeIds);
  // The organizer's address only when it is the person downloading (another member's email never leaves the server).
  const me = c.var.user;
  const organizerEmail = meeting.author && me && meeting.author.id === me.id ? me.email : 'noreply@crm.local';
  const ics = buildIcs(meeting, {name: meeting.author?.name ?? settings.brandName, email: organizerEmail}, people, settings.brandName);
  return new Response(ics, {headers: {'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="meeting.ics"'}});
});

export const interactions = new Hono<AppEnv>()
  .get('/', valid('query', z.object({
    contactId: z.string().optional(),
    companyId: z.string().optional(),
    dealId: z.string().optional(),
    kind: z.enum(kinds).optional(),
    upcoming: z.string().optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    const where: Prisma.InteractionWhereInput = {};
    if (q.contactId) where.OR = [{contactId: q.contactId}, {attendeeIds: {has: q.contactId}}];
    if (q.companyId) where.companyId = q.companyId;
    if (q.dealId) where.dealId = q.dealId;
    if (q.kind) where.kind = q.kind;
    if (q.upcoming === '1') {
      where.occurredAt = {gte: new Date()};
      where.AND = [{OR: [{outcome: null}, {outcome: {not: 'Canceled'}}]}];
    }
    const rows = await c.var.db.interaction.findMany({
      where,
      include: {author: {select: userSelect}},
      orderBy: {occurredAt: q.upcoming === '1' ? 'asc' : 'desc'},
      take: 100,
    });
    return c.json({rows});
  })

  .post('/', valid('json', body), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {followUp, invite, ...input} = c.req.valid('json');
    if (!input.contactId && !input.companyId && !input.dealId) throw new HTTPException(400, {message: 'Log it against a contact, company or deal'});
    if (input.kind === 'MEETING' && !input.title) throw new HTTPException(400, {message: 'Give the meeting a title'});

    const attendeeIds = [...new Set([...(input.attendeeIds ?? []), ...(input.contactId ? [input.contactId] : [])])];
    const interaction = await logInteraction(db, {...input, occurredAt: input.occurredAt ?? new Date(), attendeeIds}, me);

    if (followUp) {
      await db.task.create({
        data: {
          title: `Follow up${interaction.title ? `: ${interaction.title}` : ` on ${LABEL[interaction.kind]}`}`,
          type: followUp.type,
          dueAt: addBusinessDays(new Date(), followUp.days),
          assigneeId: me.id,
          creatorId: me.id,
          contactId: interaction.contactId,
          companyId: interaction.companyId,
          dealId: interaction.dealId,
        },
      });
    }

    let invited = 0;
    if (invite && interaction.kind === 'MEETING') {
      const people = (await attendees(db, attendeeIds)).filter((p) => p.email);
      if (people.length) {
        const origin = publicOrigin(c.req.raw);
        const icsUrl = `${origin}/site-api/crm/meetings/${interaction.id}/invite.ics?s=${await sign(`ics|${interaction.id}`)}`;
        const when = interaction.occurredAt.toLocaleString('en-US', {dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC'}) + ' UTC';
        const text = [
          invite.message?.trim() || `Hi {{contact.first_name|there}},\n\nLooking forward to speaking with you.`,
          '',
          `What: ${interaction.title}`,
          `When: ${when}${interaction.durationMin ? ` (${interaction.durationMin} min)` : ''}`,
          interaction.location
            ? `${interaction.locationType === 'VIDEO' ? 'Join' : interaction.locationType === 'PHONE' ? 'Call' : 'Where'}: ${interaction.location}`
            : null,
          interaction.body ? `\n${interaction.body}` : null,
          '',
          `Add to Google Calendar: ${googleCalendarUrl(interaction)}`,
          `Add to Outlook / Apple Calendar: ${icsUrl}`,
        ]
          .filter((l) => l !== null)
          .join('\n');
        await sendEmail(db, me, origin, {
          accountId: invite.accountId,
          to: people.map((p) => p.email!),
          subject: `Invitation: ${interaction.title}`,
          body: text,
          contactId: interaction.contactId,
          companyId: interaction.companyId,
          dealId: interaction.dealId,
        });
        invited = people.length;
      }
    }
    return c.json({interaction, invited}, 201);
  })

  .patch('/:id', valid('json', body.omit({kind: true, followUp: true, invite: true}).partial()), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const existing = await db.interaction.findUnique({where: {id: c.req.param('id')}});
    if (!existing) throw notFound('Activity');
    if (existing.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the person who logged this can edit it'});
    let interaction = await db.interaction.update({where: {id: existing.id}, data: c.req.valid('json') as Prisma.InteractionUncheckedUpdateInput});
    // Keep the connected calendar in step: cancel, or move / rename the event.
    if (interaction.kind === 'MEETING') {
      if (interaction.outcome === 'Canceled' && existing.outcome !== 'Canceled') await cancelMeetingEvents(db, interaction.id);
      else if (['occurredAt', 'durationMin', 'title', 'location', 'body', 'attendeeIds'].some((k) => JSON.stringify(existing[k as keyof Interaction]) !== JSON.stringify(interaction[k as keyof Interaction]))) {
        interaction = await pushMeeting(db, interaction);
      }
      await mirrorToBooking(db, interaction);
    }
    await refreshInteractionActivity(db, interaction);
    return c.json({interaction});
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    const existing = await c.var.db.interaction.findUnique({where: {id: c.req.param('id')}});
    if (!existing) throw notFound('Activity');
    if (existing.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the person who logged this can delete it'});
    if (existing.kind === 'MEETING' && existing.occurredAt > new Date()) await cancelMeetingEvents(c.var.db, existing.id);
    await c.var.db.activity.deleteMany({where: {refId: existing.id, type: `interaction_${existing.kind}`}});
    await c.var.db.interaction.delete({where: {id: existing.id}});
    return c.json({ok: true});
  });
