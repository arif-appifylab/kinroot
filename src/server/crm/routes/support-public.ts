import {Hono} from 'hono';
import {deleteCookie, getCookie, setCookie} from 'hono/cookie';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import type {AppContext, AppEnv} from '../kit/guards';
import {notFound, valid} from '../lib/http';
import {notify} from '../lib/notify';
import {richBody, richHtml} from '../lib/rich-text';
import {
  contactForEmail,
  contactFromPortalToken,
  createTicket,
  customerReply,
  getTicketSettings,
  sendPortalLink,
  ticketEvent,
  ticketFromCsatToken,
  ticketLink,
} from '../lib/tickets';
import {publicFileUrl} from './files';

/** Cookie holding the signed portal token from the magic link (no passwords). */
const PORTAL_COOKIE = 'portal_session';

export type PortalConfig = {enabled: boolean; intro: string; categories: string[]};

export async function portalConfig(db: Db): Promise<PortalConfig> {
  const s = await getTicketSettings(db);
  return {enabled: s.portalEnabled, intro: s.portalIntro, categories: s.categories};
}

export type CsatState = {number: number; subject: string; firstName: string | null; rating: number | null; comment: string | null} | null;

export async function csatState(db: Db, token: string): Promise<CsatState> {
  const id = await ticketFromCsatToken(token);
  const t = id ? await db.ticket.findUnique({where: {id}, include: {contact: {select: {firstName: true}}}}) : null;
  return t ? {number: t.number, subject: t.subject, firstName: t.contact?.firstName ?? null, rating: t.csatRating, comment: t.csatComment} : null;
}

async function portalSession(c: AppContext) {
  const session = await contactFromPortalToken(getCookie(c, PORTAL_COOKIE));
  if (!session) return null;
  const contact = await c.var.db.contact.findUnique({where: {id: session.contactId}, select: {id: true, firstName: true, lastName: true, email: true}});
  return contact ? {...session, contact} : null;
}

async function requirePortal(c: AppContext) {
  if (!(await getTicketSettings(c.var.db)).portalEnabled) throw notFound('Support portal');
}

/** What a customer may see of a ticket: public replies and status changes, never internal notes. */
async function portalTicket(db: Db, origin: string, contactId: string, number: number) {
  const ticket = await db.ticket.findUnique({where: {number}, include: {assignee: {select: {name: true}}}});
  if (!ticket || ticket.contactId !== contactId) return null;
  const messages = await db.ticketMessage.findMany({
    where: {ticketId: ticket.id, OR: [{kind: 'reply'}, {kind: 'event', data: {path: ['type'], equals: 'status'}}]},
    include: {author: {select: {name: true}}},
    orderBy: {createdAt: 'asc'},
  });
  const fileIds = messages.flatMap((m) => m.fileIds);
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
      files: m.fileIds.map((id) => links.get(id)).filter(Boolean),
      createdAt: m.createdAt,
    })),
  };
}

const spam = (hp?: string, startedAt?: number) => !!hp || (!!startedAt && Date.now() - startedAt < 1500);

/** The /support portal and the CSAT page. No sign-in: every input is a signed token. */
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
      const desc = richBody({html: body.descriptionHtml, text: body.description});
      if (!desc.text) throw new HTTPException(400, {message: 'Tell us what you need help with'});
      const session = await portalSession(c);
      if (!session && !body.email) throw new HTTPException(400, {message: 'Enter your email address'});
      const settings = await getTicketSettings(db);
      const contact = session ? session.contact : await contactForEmail(db, body.email!, body.name);
      const ticket = await createTicket(db, {
        subject: body.subject,
        description: desc.text,
        descriptionHtml: desc.html,
        category: body.category && settings.categories.includes(body.category) ? body.category : null,
        source: 'PORTAL',
        contactId: contact.id,
      });
      // Signed-in customers see it right away; everyone else gets the link by email (that proves the address).
      await sendPortalLink(db, contact.id, publicOrigin(c.req.raw), ticket);
      return c.json({ok: true, signedIn: !!session, number: session ? ticket.number : undefined}, 201);
    },
  )

  .post('/support/link', valid('json', z.object({email: z.email().max(200)})), async (c) => {
    await requirePortal(c);
    const db = c.var.db;
    const contact = await db.contact.findFirst({where: {email: {equals: c.req.valid('json').email, mode: 'insensitive'}, tickets: {some: {}}}, select: {id: true}});
    if (contact) await sendPortalLink(db, contact.id, publicOrigin(c.req.raw));
    // Same answer either way, so the form can't be used to probe for customers.
    return c.json({ok: true});
  })

  .post('/support/session', valid('json', z.object({token: z.string().max(300)})), async (c) => {
    await requirePortal(c);
    const session = await contactFromPortalToken(c.req.valid('json').token);
    if (!session) return c.json({ok: false});
    setCookie(c, PORTAL_COOKIE, c.req.valid('json').token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: new URL(c.req.url).protocol === 'https:',
      expires: new Date(session.exp * 1000),
    });
    return c.json({ok: true});
  })

  .post('/support/logout', (c) => {
    deleteCookie(c, PORTAL_COOKIE, {path: '/'});
    return c.json({ok: true});
  })

  .get('/support/me', async (c) => {
    await requirePortal(c);
    const session = await portalSession(c);
    if (!session) return c.json({session: null});
    const rows = await c.var.db.ticket.findMany({
      where: {contactId: session.contact.id},
      select: {number: true, subject: true, status: true, createdAt: true, lastMessageAt: true},
      orderBy: {lastMessageAt: 'desc'},
      take: 100,
    });
    return c.json({session: {firstName: session.contact.firstName, email: session.contact.email}, tickets: rows});
  })

  .get('/support/tickets/:number', async (c) => {
    await requirePortal(c);
    const session = await portalSession(c);
    if (!session) return c.json({session: null, ticket: null});
    const ticket = await portalTicket(c.var.db, publicOrigin(c.req.raw), session.contact.id, Number(c.req.param('number')) || 0);
    return c.json({session: {firstName: session.contact.firstName, email: session.contact.email}, ticket});
  })

  .post('/support/tickets/:number/reply', valid('json', z.object({body: z.string().trim().max(20_000).default(''), html: richHtml})), async (c) => {
    await requirePortal(c);
    const db = c.var.db;
    const session = await portalSession(c);
    if (!session) throw new HTTPException(403, {message: 'Your link has expired. Request a new one on the support page.'});
    const ticket = await db.ticket.findUnique({where: {number: Number(c.req.param('number')) || 0}});
    if (!ticket || ticket.contactId !== session.contact.id) throw notFound('Request');
    if (ticket.status === 'CLOSED') throw new HTTPException(400, {message: 'This request is closed. Please open a new one.'});
    const input = c.req.valid('json');
    const reply = richBody({html: input.html, text: input.body});
    if (!reply.text) throw new HTTPException(400, {message: 'Write a message first'});
    await customerReply(db, ticket, {
      body: reply.text,
      html: reply.html,
      via: 'portal',
      fromEmail: session.contact.email ?? '',
      fromName: [session.contact.firstName, session.contact.lastName].filter(Boolean).join(' '),
    });
    return c.json({ticket: await portalTicket(db, publicOrigin(c.req.raw), session.contact.id, ticket.number)});
  })

  // ─── CSAT ───
  .get('/csat/:token', async (c) => {
    const state = await csatState(c.var.db, c.req.param('token'));
    if (!state) throw notFound('Link');
    return c.json(state);
  })

  .post('/csat/:token', valid('json', z.object({rating: z.number().int().min(1).max(5), comment: z.string().trim().max(5000).optional()})), async (c) => {
    const db = c.var.db;
    const id = await ticketFromCsatToken(c.req.param('token'));
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
