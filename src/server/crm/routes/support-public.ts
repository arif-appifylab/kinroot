import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {getViewer} from '../../../platform/auth';
import {problem} from '../../../platform/guards';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import type {AppContext, AppEnv} from '../kit/guards';
import {fieldError, notFound, valid} from '../lib/http';
import {connectionLimits, rateLimit} from '../lib/rate-limit';
import {notify} from '../lib/notify';
import {richBody, richHtml} from '../lib/rich-text';
import {
  contactForEmail,
  customerReply,
  getTicketSettings,
  prepareTicket,
  sendPortalLink,
  ticketEvent,
  ticketCreated,
  ticketFromCsatToken,
  ticketLink,
} from '../lib/tickets';
import {onceOf, runOnce} from '../lib/once';
import {sign} from '../kit/crypto';
import {defuseMerge} from '../email/render';
import type {Ticket} from '../../../generated/prisma/client';
import {publicFileUrl} from './files';
import {strings} from '../lib/json-list';

export type PortalConfig = {enabled: boolean; intro: string; categories: string[]};

async function portalConfig(db: Db): Promise<PortalConfig> {
  const s = await getTicketSettings(db);
  return {enabled: s.portalEnabled, intro: s.portalIntro, categories: s.categories};
}

export type CsatState = {number: number; subject: string; firstName: string | null; rating: number | null; comment: string | null} | null;

async function csatState(db: Db, token: string): Promise<CsatState> {
  const id = await ticketFromCsatToken(db, token);
  const t = id ? await db.ticket.findUnique({where: {id}, include: {contact: {select: {firstName: true}}}}) : null;
  return t ? {number: t.number, subject: t.subject, firstName: t.contact?.firstName ?? null, rating: t.csatRating, comment: t.csatComment} : null;
}

/**
 * The customer: the site's own sign-in (an account with a 6-digit code or a password), whose
 * CONFIRMED email is the address their requests came from. Every contact with that address is
 * theirs (the oldest is the one new requests go to). An expired session answers 401 token_expired so
 * the browser refreshes it once (`siteFetch`).
 */
async function portalSession(c: AppContext) {
  const viewer = await getViewer(c.req.raw);
  if (viewer.state === 'returning') {
    const res = c.json(problem('token_expired', 'Your session needs refreshing.'), 401);
    throw new HTTPException(401, {res, message: 'Your session needs refreshing.'});
  }
  if (viewer.state !== 'user' || !viewer.emailVerified || !viewer.email) return null;
  // Case-insensitive on the lower(email) index (Prisma's `mode: 'insensitive'` is ILIKE: no index), one query.
  const contacts = await c.var.db.$queryRaw<{id: string; firstName: string; lastName: string | null; email: string | null}[]>`
    SELECT id, "firstName", "lastName", email FROM "Contact"
    WHERE lower(email) = ${viewer.email.trim().toLowerCase()}
    ORDER BY "createdAt" ASC, id ASC LIMIT 20`;
  const contact = contacts[0];
  return contact ? {contact, contactIds: contacts.map((x) => x.id), email: viewer.email} : {contact: null, contactIds: [] as string[], email: viewer.email};
}

async function requirePortal(c: AppContext) {
  if (!(await getTicketSettings(c.var.db)).portalEnabled) throw notFound('Support portal');
}

/** What a customer may see of a ticket: public replies and status changes, never internal notes. */
async function portalTicket(db: Db, origin: string, contactIds: string[], number: number) {
  const ticket = await db.ticket.findUnique({where: {number}, include: {assignee: {select: {name: true}}}});
  if (!ticket || !ticket.contactId || !contactIds.includes(ticket.contactId)) return null;
  const messages = await db.ticketMessage.findMany({
    where: {ticketId: ticket.id, OR: [{kind: 'reply'}, {kind: 'event', data: {path: ['type'], equals: 'status'}}]},
    include: {author: {select: {name: true}}},
    orderBy: {createdAt: 'asc'},
  });
  const fileIds = messages.flatMap((m) => strings(m.fileIds));
  const files = fileIds.length ? await db.file.findMany({where: {id: {in: fileIds}}, select: {id: true, name: true, size: true}}) : [];
  const links = new Map(await Promise.all(files.map(async (f) => [f.id, {name: f.name, size: f.size, url: await publicFileUrl(origin, f.id, 1)}] as const)));
  return {
    number: ticket.number,
    subject: ticket.subject,
    description: ticket.description,
    descriptionHtml: ticket.descriptionHtml,
    status: ticket.status,
    createdAt: ticket.createdAt,
    lastMessageAt: ticket.lastMessageAt,
    messages: messages.map((m) => ({
      id: m.id,
      kind: m.kind as 'reply' | 'event',
      fromCustomer: m.direction === 'INBOUND',
      author: m.direction === 'INBOUND' ? m.fromName || 'You' : m.author?.name.split(' ')[0] ?? 'Support',
      body: m.body,
      html: m.html,
      status: m.kind === 'event' ? ((m.data as {to?: string}).to ?? null) : null,
      files: strings(m.fileIds).map((id) => links.get(id)).filter(Boolean),
      createdAt: m.createdAt,
    })),
  };
}

const spam = (hp?: string, startedAt?: number) => !!hp || (!!startedAt && Date.now() - startedAt < 1500);

/** A request number from the URL: digits only (`1.5`, `1e3` or `-1` are no request), else 0, which matches none. */
const ticketNumber = (v: string) => (/^\d{1,9}$/.test(v) ? Number(v) : 0);

/** The /support portal (the site's sign-in, see portalSession) and the CSAT page (a signed token). */
export const supportPublic = new Hono<AppEnv>()
  .get('/support/config', async (c) => c.json(await portalConfig(c.var.db)))

  .post(
    '/support/tickets',
    valid('json', z.object({
      name: z.string().trim().max(120).optional(),
      email: z.email().max(200).optional(),
      subject: z.string().trim().min(1).max(300),
      description: z.string().trim().max(20_000).default(''),
      descriptionHtml: richHtml,
      category: z.string().trim().max(60).optional(),
      hp: z.string().optional(),
      startedAt: z.number().optional(),
    })),
    async (c) => {
      await requirePortal(c);
      const db = c.var.db;
      const body = c.req.valid('json');
      if (spam(body.hp, body.startedAt)) return c.json({ok: true, signedIn: false});
      // It sends an email to the address typed in: bounded per connection (docs/agent/security.md A06).
      await rateLimit(db, await connectionLimits((n) => c.req.header(n), 'support:request', 5, 20), 'You have sent several requests in a short time. Please wait a while and try again.');
      const desc = richBody({html: body.descriptionHtml, text: body.description});
      if (!desc.text) throw fieldError('description', 'Tell us what you need help with');
      const session = await portalSession(c);
      const email = session?.email ?? body.email;
      if (!email) throw fieldError('email', 'Enter your email address');
      const settings = await getTicketSettings(db);
      const input = {
        subject: defuseMerge(body.subject), // never filled in when the team replies (AUDIT-2 L-6)
        description: desc.text,
        descriptionHtml: desc.html,
        category: body.category && settings.categories.includes(body.category) ? body.category : null,
        source: 'PORTAL' as const,
      };
      // One request per attempt (the browser's idempotency key, scoped to the sender's address,
      // kept as a keyed hash): a retry after a lost answer opens no second request, makes no second
      // contact and sends no second email. Older pages send no key and are saved as before.
      const once = onceOf(c.req.raw, `support:${await sign(`support:${email.trim().toLowerCase()}`)}`, {
        subject: body.subject,
        description: body.description,
        descriptionHtml: body.descriptionHtml ?? null,
        category: body.category ?? null,
        name: body.name ?? null,
      });
      // The request is saved first; its contact (found or made from the address) is linked right after.
      const prepared = await prepareTicket(db, input);
      const made: {row?: Ticket} = {};
      const {value} = await runOnce(db, once, async (tx) => {
        made.row = await tx.ticket.create({data: prepared.data});
        return {id: made.row.id, number: made.row.number};
      });
      if (made.row) {
        const contact = session?.contact ?? (await contactForEmail(db, email, body.name));
        const companyId = (await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}))?.companyId ?? null;
        const saved = await db.ticket.update({where: {id: made.row.id}, data: {contactId: contact.id, companyId}});
        const ticket = await ticketCreated(db, saved, {...input, contactId: contact.id}, prepared.settings);
        // Signed-in customers see it right away; everyone gets a confirmation by email.
        await sendPortalLink(db, contact.id, publicOrigin(c.req.raw), ticket);
      }
      // Signed in with a confirmed address: the request is theirs to see now (its contact has that address).
      const signedIn = !!session;
      return c.json({ok: true, signedIn, number: signedIn ? value.number : undefined}, 201);
    },
  )

  .get('/support/me', async (c) => {
    await requirePortal(c);
    const session = await portalSession(c);
    if (!session) return c.json({session: null});
    const rows = await c.var.db.ticket.findMany({
      where: {contactId: {in: session.contactIds}},
      select: {number: true, subject: true, status: true, createdAt: true, lastMessageAt: true},
      orderBy: {lastMessageAt: 'desc'},
      take: 100,
    });
    return c.json({session: {firstName: session.contact?.firstName ?? null, email: session.email}, tickets: rows});
  })

  .get('/support/tickets/:number', async (c) => {
    await requirePortal(c);
    const session = await portalSession(c);
    if (!session) return c.json({session: null, ticket: null});
    const ticket = await portalTicket(c.var.db, publicOrigin(c.req.raw), session.contactIds, ticketNumber(c.req.param('number')));
    return c.json({session: {firstName: session.contact?.firstName ?? null, email: session.email}, ticket});
  })

  .post('/support/tickets/:number/reply', valid('json', z.object({body: z.string().trim().max(20_000).default(''), html: richHtml})), async (c) => {
    await requirePortal(c);
    const db = c.var.db;
    const session = await portalSession(c);
    if (!session?.contact) throw new HTTPException(403, {message: 'Sign in with the email address of your request to reply.'});
    const number = ticketNumber(c.req.param('number'));
    const ticket = number ? await db.ticket.findUnique({where: {number}}) : null;
    if (!ticket || !ticket.contactId || !session.contactIds.includes(ticket.contactId)) throw notFound('Request');
    if (ticket.status === 'CLOSED') throw new HTTPException(400, {message: 'This request is closed. Please open a new one.'});
    const input = c.req.valid('json');
    const reply = richBody({html: input.html, text: input.body});
    if (!reply.text) throw fieldError('html', 'Write a message first');
    await customerReply(db, ticket, {
      body: reply.text,
      html: reply.html,
      via: 'portal',
      fromEmail: session.email,
      fromName: [session.contact.firstName, session.contact.lastName].filter(Boolean).join(' '),
    });
    return c.json({ticket: await portalTicket(db, publicOrigin(c.req.raw), session.contactIds, ticket.number)});
  })

  // ─── CSAT ───
  .get('/csat/:token', async (c) => {
    const state = await csatState(c.var.db, c.req.param('token'));
    if (!state) throw notFound('Link');
    return c.json(state);
  })

  .post('/csat/:token', valid('json', z.object({rating: z.number().int().min(1).max(5), comment: z.string().trim().max(5000).optional()})), async (c) => {
    const db = c.var.db;
    const id = await ticketFromCsatToken(db, c.req.param('token'));
    const before = id ? await db.ticket.findUnique({where: {id}}) : null;
    if (!before) throw notFound('Link');
    const {rating, comment} = c.req.valid('json');
    const ticket = await db.ticket.update({where: {id: before.id}, data: {csatRating: rating, csatComment: comment || null, csatAt: new Date()}});
    await ticketEvent(db, ticket.id, {type: 'csat', rating, comment: comment || null});
    if (!before.csatRating && ticket.assigneeId) {
      await notify(db, [ticket.assigneeId], {type: 'ticket', title: `#${ticket.number} was rated ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`, body: comment || ticket.subject, link: ticketLink(ticket)});
    }
    return c.json(await csatState(db, c.req.param('token')));
  });
