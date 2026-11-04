import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma, Ticket} from '../../../generated/prisma/client';
import {OPEN_STATUSES} from '@/lib/tickets';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {emit} from '../lib/events';
import {contactIdByEmail} from '../lib/contact-email';
import {assertVisible, fieldError, intParam, MAX_PAGE, notFound, optStr, ownerScope, tags, valid} from '../lib/http';
import {moveToBin} from '../lib/recycle-bin';
import {companyIdsNamed, contactIdsByNameOrEmail} from '../lib/search-match';
import {richBody, richHtml} from '../lib/rich-text';
import {
  agentReply,
  assignTicket,
  changePriority,
  changeStatus,
  contactForEmail,
  createTicket,
  getTicketSettings,
  saveTicketSettings,
  ticketInclude,
  ticketRefWhere,
  ticketScope,
} from '../lib/tickets';
import {userSelect} from '../lib/users';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';
import {strings} from '../lib/json-list';

const status = z.enum(['NEW', 'WAITING_ON_CONTACT', 'WAITING_ON_US', 'RESOLVED', 'CLOSED']);
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const fileMeta = {id: true, name: true, mimeType: true, size: true} as const;

/** Open tickets past a deadline right now, or that breached one earlier. */
const breachedWhere = (now = new Date()): Prisma.TicketWhereInput => ({
  status: {in: OPEN_STATUSES},
  OR: [
    {firstResponseBreachedAt: {not: null}},
    {resolutionBreachedAt: {not: null}},
    {firstResponseAt: null, firstResponseDueAt: {lt: now}},
    {resolvedAt: null, resolutionDueAt: {lt: now}},
  ],
});

const listQuery = z.object({
  view: z.enum(['all', 'mine', 'unassigned']).default('all'),
  status: z.string().optional(), // "open" | "all" | comma-separated statuses
  priority: priority.optional(),
  category: z.string().optional(),
  queue: z.string().optional(),
  assigneeId: z.string().optional(),
  breached: z.enum(['1']).optional(),
  q: z.string().trim().max(100).optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  dealId: z.string().optional(),
  sort: z.enum(['updated', 'created', 'priority', 'due', 'number']).default('updated'),
  dir: z.enum(['asc', 'desc']).optional(),
  page: intParam(1, MAX_PAGE).default(1),
  pageSize: intParam(1, 300).default(50),
});

/** A ticket this person may open: the visibility rule is in the query's where (AUDIT-2 L-5); else 404. */
async function loadTicket(c: Parameters<typeof ticketScope>[0], ref: string) {
  const ticket = await c.var.db.ticket.findFirst({where: {AND: [ticketRefWhere(ref) as Prisma.TicketWhereInput, await ticketScope(c)]}});
  if (!ticket) throw notFound('Ticket');
  return ticket;
}

/**
 * The requester for a new ticket typed by email (AUDIT-2 M-4): an existing contact only when this
 * person may see it (else 409, as creating a contact with that email answers: never its details); a
 * new one is theirs under owner-only visibility.
 */
async function requesterFor(c: AppContext, scope: {ownerId?: string}, email: string, name: string | null | undefined) {
  const db = c.var.db;
  if (scope.ownerId) {
    const existingId = await contactIdByEmail(db, email);
    if (existingId && !(await db.contact.count({where: {id: existingId, ...scope}}))) {
      throw fieldError('email', 'A contact with that email already exists and belongs to someone else. Ask them or an admin to open the ticket.', 409);
    }
  }
  return (await contactForEmail(db, email, name, {ownerId: scope.ownerId})).id;
}

const settingsSchema = z.object({
  supportEmail: z.union([z.email(), z.literal('')]).optional(),
  replyAccountId: z.string().max(100).optional(),
  categories: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  queues: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  notifyUserIds: z.array(z.string()).max(200).optional(),
  sla: z
    .object({
      enabled: z.boolean(),
      businessHours: z.object({
        enabled: z.boolean(),
        timezone: z.string().min(1).max(100),
        days: z.array(z.number().int().min(0).max(6)).max(7),
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
      }),
      targets: z.record(priority, z.object({firstResponseMins: z.number().int().min(1).max(525_600).nullable(), resolutionMins: z.number().int().min(1).max(525_600).nullable()})),
    })
    .optional(),
  portalEnabled: z.boolean().optional(),
  portalIntro: z.string().max(1000).optional(),
  csatEnabled: z.boolean().optional(),
});

export const tickets = new Hono<AppEnv>()
  .get('/', valid('query', listQuery), async (c) => {
    const q = c.req.valid('query');
    const me = currentUser(c);
    const db = c.var.db;
    const and: Prisma.TicketWhereInput[] = [await ticketScope(c)];
    if (q.view === 'mine') and.push({assigneeId: me.id});
    if (q.view === 'unassigned') and.push({assigneeId: null});
    if (q.status === 'open' || !q.status) and.push({status: {in: OPEN_STATUSES}});
    else if (q.status !== 'all') and.push({status: {in: q.status.split(',').filter((s) => status.safeParse(s).success) as Ticket['status'][]}});
    if (q.priority) and.push({priority: q.priority});
    if (q.category) and.push({category: q.category});
    if (q.queue) and.push({queue: q.queue});
    if (q.assigneeId) and.push({assigneeId: q.assigneeId === 'none' ? null : q.assigneeId});
    if (q.breached) and.push(breachedWhere());
    if (q.contactId) and.push({contactId: q.contactId});
    if (q.companyId) and.push({companyId: q.companyId});
    if (q.dealId) and.push({dealId: q.dealId});
    if (q.q) {
      const n = q.q.replace(/^#/, '');
      // The requester and company are looked up first (trigram indexes), so every branch is index-served (lib/search-match.ts).
      const [contactIds, companyIds] = await Promise.all([contactIdsByNameOrEmail(db, q.q), companyIdsNamed(db, q.q)]);
      and.push({
        OR: [
          ...(/^\d{1,9}$/.test(n) ? [{number: Number(n)}] : []),
          {subject: {contains: q.q, mode: 'insensitive'}},
          ...(contactIds.length ? [{contactId: {in: contactIds}}] : []),
          ...(companyIds.length ? [{companyId: {in: companyIds}}] : []),
        ],
      });
    }
    const dir = q.dir ?? (q.sort === 'due' ? 'asc' : 'desc');
    const orderBy: Prisma.TicketOrderByWithRelationInput[] =
      q.sort === 'priority'
        ? [{priority: dir}, {lastMessageAt: 'desc'}]
        : q.sort === 'due'
          ? [{resolutionDueAt: {sort: dir, nulls: 'last'}}]
          : q.sort === 'created'
            ? [{createdAt: dir}]
            : q.sort === 'number'
              ? [{number: dir}]
              : [{lastMessageAt: dir}];
    const where = {AND: and};
    const [rows, total] = await Promise.all([
      db.ticket.findMany({where, include: ticketInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize}),
      db.ticket.count({where}),
    ]);
    return c.json({rows, total, page: q.page, pageSize: q.pageSize});
  })

  /** Nav badge and the stat tiles on the tickets page. */
  .get('/counts', async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const scope = await ticketScope(c);
    const open = {AND: [scope, {status: {in: OPEN_STATUSES}}]};
    const [mine, unassigned, openCount, breached, csat, byStatus] = await Promise.all([
      db.ticket.count({where: {AND: [open, {assigneeId: me.id}]}}),
      db.ticket.count({where: {AND: [open, {assigneeId: null}]}}),
      db.ticket.count({where: open}),
      db.ticket.count({where: {AND: [scope, breachedWhere()]}}),
      db.ticket.aggregate({where: {AND: [scope, {csatRating: {not: null}}]}, _avg: {csatRating: true}, _count: {csatRating: true}}),
      db.ticket.groupBy({by: ['status'], where: scope, _count: {_all: true}}),
    ]);
    return c.json({
      mine,
      unassigned,
      open: openCount,
      breached,
      csat: {average: csat._avg.csatRating, count: csat._count.csatRating},
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    });
  })

  // ─── Settings & canned replies ───
  .get('/settings', async (c) => {
    const db = c.var.db;
    const settings = await getTicketSettings(db);
    const accounts = await db.emailAccount.findMany({where: {userId: null}, select: {id: true, label: true, fromEmail: true}, orderBy: {createdAt: 'asc'}});
    return c.json({settings, sharedAccounts: accounts});
  })

  .patch('/settings', requireRole('ADMIN'), valid('json', settingsSchema), async (c) => {
    await saveTicketSettings(c.var.db, c.req.valid('json') as Parameters<typeof saveTicketSettings>[1]);
    await audit(c.var.db, c, {action: 'settings.tickets', meta: {changed: Object.keys(c.req.valid('json')), ...c.req.valid('json')}});
    return c.json({settings: await getTicketSettings(c.var.db)});
  })

  .get('/canned', async (c) => c.json({rows: await c.var.db.cannedReply.findMany({orderBy: [{position: 'asc'}, {name: 'asc'}]})}))

  .post('/canned', requireRole('ADMIN'), valid('json', z.object({name: z.string().trim().min(1).max(100), body: z.string().trim().max(20_000).default(''), html: richHtml})), async (c) => {
    const input = c.req.valid('json');
    const rich = richBody({html: input.html, text: input.body});
    if (!rich.text) throw fieldError('html', 'Write the reply first');
    const count = await c.var.db.cannedReply.count();
    const reply = await c.var.db.cannedReply.create({data: {name: input.name, body: rich.text, html: rich.html, position: count}});
    await audit(c.var.db, c, {action: 'canned_reply.created', entity: 'canned_reply', recordId: reply.id, label: reply.name});
    return c.json({reply}, 201);
  })

  .patch('/canned/:id', requireRole('ADMIN'), valid('json', z.object({name: z.string().trim().min(1).max(100).optional(), body: z.string().trim().max(20_000).optional(), html: richHtml})), async (c) => {
    const {name, body, html} = c.req.valid('json');
    const rich = body !== undefined || html !== undefined ? richBody({html, text: body}) : null;
    if (rich && !rich.text) throw fieldError('html', 'Write the reply first');
    const data = {...(name !== undefined ? {name} : {}), ...(rich ? {body: rich.text, html: rich.html} : {})};
    const reply = await c.var.db.cannedReply.update({where: {id: c.req.param('id')}, data}).catch(() => null);
    if (!reply) throw notFound('Canned reply');
    await audit(c.var.db, c, {action: 'canned_reply.updated', entity: 'canned_reply', recordId: reply.id, label: reply.name});
    return c.json({reply});
  })

  .delete('/canned/:id', requireRole('ADMIN'), async (c) => {
    const gone = await c.var.db.cannedReply.findUnique({where: {id: c.req.param('id')}, select: {id: true, name: true}});
    await c.var.db.cannedReply.deleteMany({where: {id: c.req.param('id')}});
    if (gone) await audit(c.var.db, c, {action: 'canned_reply.deleted', entity: 'canned_reply', recordId: gone.id, label: gone.name});
    return c.json({ok: true});
  })

  // ─── Tickets ───
  .post(
    '/',
    valid('json', z.object({
      subject: z.string().trim().min(1).max(300),
      description: optStr,
      descriptionHtml: richHtml,
      priority: priority.optional(),
      status: status.optional(),
      category: optStr,
      queue: optStr,
      assigneeId: z.string().nullish(),
      contactId: z.string().nullish(),
      email: z.union([z.email(), z.literal('')]).nullish(),
      name: optStr,
      companyId: z.string().nullish(),
      dealId: z.string().nullish(),
      tags: tags.optional(),
    })),
    async (c) => {
      const me = currentUser(c);
      const db = c.var.db;
      const body = c.req.valid('json');
      // Only records this person may open can be linked (AUDIT-2 M-4).
      const scope = await ownerScope(c);
      await assertVisible(c, {contactId: body.contactId, companyId: body.companyId, dealId: body.dealId}, scope);
      let contactId = body.contactId ?? null;
      if (!contactId && body.email) contactId = await requesterFor(c, scope, body.email, body.name);
      const desc = richBody({html: body.descriptionHtml, text: body.description});
      const ticket = await createTicket(db, {
        subject: body.subject,
        description: desc.text || null,
        descriptionHtml: desc.html,
        priority: body.priority,
        category: body.category,
        queue: body.queue,
        source: 'MANUAL',
        tags: body.tags,
        assigneeId: body.assigneeId === undefined ? me.id : body.assigneeId,
        contactId,
        companyId: body.companyId,
        dealId: body.dealId,
        actorId: me.id,
      });
      const final = body.status && body.status !== 'NEW' ? await changeStatus(db, ticket, body.status, me, {origin: publicOrigin(c.req.raw), quiet: true}) : ticket;
      await audit(db, c, {action: 'ticket.created', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`});
      return c.json({ticket: final}, 201);
    },
  )

  .get('/:ref', async (c) => {
    const db = c.var.db;
    const base = await loadTicket(c, c.req.param('ref'));
    const ticket = await db.ticket.findUniqueOrThrow({where: {id: base.id}, include: ticketInclude});
    const messages = await db.ticketMessage.findMany({where: {ticketId: ticket.id}, include: {author: {select: userSelect}}, orderBy: {createdAt: 'asc'}});
    const fileIds = messages.flatMap((m) => strings(m.fileIds));
    const files = fileIds.length ? await db.file.findMany({where: {id: {in: fileIds}}, select: fileMeta}) : [];
    const emails = messages.filter((m) => m.emailMessageId).map((m) => m.emailMessageId!);
    const delivery = emails.length ? await db.emailMessage.findMany({where: {id: {in: emails}}, select: {id: true, status: true, error: true, openCount: true}}) : [];
    const byFile = new Map(files.map((f) => [f.id, f]));
    const byEmail = new Map(delivery.map((d) => [d.id, d]));
    return c.json({
      ticket,
      messages: messages.map((m) => ({...m, files: strings(m.fileIds).map((id) => byFile.get(id)).filter(Boolean), email: m.emailMessageId ? byEmail.get(m.emailMessageId) ?? null : null})),
    });
  })

  .patch(
    '/:ref',
    valid('json', z.object({
      subject: z.string().trim().min(1).max(300).optional(),
      description: optStr,
      descriptionHtml: richHtml,
      status: status.optional(),
      priority: priority.optional(),
      category: optStr,
      queue: optStr,
      assigneeId: z.string().nullish(),
      contactId: z.string().nullish(),
      companyId: z.string().nullish(),
      dealId: z.string().nullish(),
      tags: tags.optional(),
    })),
    async (c) => {
      const me = currentUser(c);
      const db = c.var.db;
      const {status: nextStatus, priority: nextPriority, assigneeId, descriptionHtml, ...rest} = c.req.valid('json');
      // A description edit keeps its plain text and rich HTML in step (a plain-text edit clears the HTML).
      if (descriptionHtml !== undefined || rest.description !== undefined) {
        const desc = richBody({html: descriptionHtml, text: rest.description});
        Object.assign(rest, {description: desc.text || null, descriptionHtml: desc.html});
      }
      let ticket = await loadTicket(c, c.req.param('ref'));
      // A new link only to a record this person may open (AUDIT-2 M-4); clearing one is always allowed.
      const changed = <K extends 'contactId' | 'companyId' | 'dealId'>(k: K) => (rest[k] && rest[k] !== ticket[k] ? rest[k] : null);
      await assertVisible(c, {contactId: changed('contactId'), companyId: changed('companyId'), dealId: changed('dealId')});
      const before = ticket;
      const plain = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (Object.keys(plain).length) ticket = await db.ticket.update({where: {id: ticket.id}, data: plain});
      if (assigneeId !== undefined) ticket = await assignTicket(db, ticket, assigneeId, me);
      if (nextPriority) ticket = await changePriority(db, ticket, nextPriority, me);
      if (nextStatus) ticket = await changeStatus(db, ticket, nextStatus, me, {origin: publicOrigin(c.req.raw)});
      await audit(db, c, {action: 'ticket.updated', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`, meta: {changes: diff(before, c.req.valid('json'))}});
      return c.json({ticket: await db.ticket.findUniqueOrThrow({where: {id: ticket.id}, include: ticketInclude})});
    },
  )

  .post(
    '/:ref/messages',
    valid('json', z.object({
      kind: z.enum(['reply', 'note']),
      body: z.string().trim().max(50_000).default(''),
      html: richHtml,
      fileIds: z.array(z.string()).max(10).default([]),
      status: status.nullish(),
    })),
    async (c) => {
      const me = currentUser(c);
      const input = c.req.valid('json');
      if (!richBody({html: input.html, text: input.body}).text && !input.fileIds.length) throw fieldError('html', input.kind === 'note' ? 'Write a note first' : 'Write a reply first');
      const ticket = await loadTicket(c, c.req.param('ref'));
      const result = await agentReply(c.var.db, me, publicOrigin(c.req.raw), ticket, input.kind, input);
      return c.json({message: result.message, warning: result.warning}, 201);
    },
  )

  /** A file to attach to the next reply or note (upload step 1; lib/uploads.ts). */
  .post('/:ref/files', valid('json', uploadBody), async (c) => {
    const me = currentUser(c);
    const ticket = await loadTicket(c, c.req.param('ref'));
    const checked = checkUpload(c.req.valid('json'), {tooBig: 'Files can be up to 5 MB', empty: 'That file is empty'});
    const {file, upload} = await startUpload(c.var.db, checked, {purpose: 'ticket', uploadedById: me.id, contactId: ticket.contactId});
    return c.json({fileId: file.id, upload}, 201);
  })

  .post('/:ref/files/:fileId/complete', async (c) => {
    const me = currentUser(c);
    await loadTicket(c, c.req.param('ref'));
    const done = await completeUpload(c.var.db, {id: c.req.param('fileId'), purpose: 'ticket', uploadedById: me.id});
    const file = await c.var.db.file.findUniqueOrThrow({where: {id: done.id}, select: fileMeta});
    return c.json({file}, 201);
  })

  .delete('/:ref', async (c) => {
    const me = currentUser(c);
    if (!isAdmin(me)) throw new HTTPException(403, {message: 'Only admins can delete tickets'});
    const db = c.var.db;
    const ticket = await loadTicket(c, c.req.param('ref'));
    // The recycle bin keeps the thread, its files and the ticket's timeline entries for 30 days.
    const [bin] = await moveToBin(db, 'ticket', [ticket.id], me);
    await emit(db, 'ticket.deleted', {recordId: ticket.id, actorId: me.id, data: ticket});
    await audit(db, c, {action: 'ticket.deleted', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`});
    return c.json({ok: true, binId: bin?.id ?? null});
  });
