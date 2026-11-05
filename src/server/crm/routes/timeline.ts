import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {AppContext, AppEnv} from '../kit/guards';
import {intParam, notFound, ownerScope, shownLink, valid} from '../lib/http';
import {shownEntry, titleSearch} from '../lib/shown-activity';
import {userSelect} from '../lib/users';

const GROUPS: Record<string, string[]> = {
  notes: ['note'],
  emails: ['email_out', 'email_in', 'email_opened', 'interaction_EMAIL', 'conversation_comment'],
  calls: ['interaction_CALL'],
  meetings: ['interaction_MEETING'],
  messages: ['interaction_SMS', 'interaction_LINKEDIN', 'interaction_WHATSAPP', 'interaction_POSTAL', 'chat_conversation'],
  tasks: ['task_created', 'task_done'],
  forms: ['form_submitted'],
  tickets: ['ticket_created', 'ticket_status', 'ticket_reply'],
  changes: ['stage_changed', 'field_changed', 'deal_won', 'deal_lost', 'deal_reopened', 'deal_created', 'contact_created', 'company_created', 'merged', 'restored', 'associated', 'list_added', 'list_removed', 'score_band'],
};

const GROUP_NAMES = ['all', 'notes', 'emails', 'calls', 'meetings', 'messages', 'tasks', 'forms', 'tickets', 'changes'] as const;
const recordQuery = z.object({contactId: z.string().optional(), companyId: z.string().optional(), dealId: z.string().optional()});

/** Every activity on a record's feed. Company and deal feeds include their people's activity. */
async function feedWhere(c: AppContext, q: z.infer<typeof recordQuery>): Promise<Prisma.ActivityWhereInput> {
  const db = c.var.db;
  const scope = await ownerScope(c);
  if (q.contactId) {
    if (!(await db.contact.findFirst({where: {id: q.contactId, ...scope}, select: {id: true}}))) throw notFound('Contact');
    return {contactId: q.contactId};
  }
  if (q.companyId) {
    if (!(await db.company.findFirst({where: {id: q.companyId, ...scope}, select: {id: true}}))) throw notFound('Company');
    // Its people and deals as joins (no id lists in memory), only those the user may see.
    return {OR: [{companyId: q.companyId}, {contact: {companies: {some: {companyId: q.companyId}}, ...scope}}, {deal: {companies: {some: {companyId: q.companyId}}, ...scope}}]};
  }
  if (q.dealId) {
    if (!(await db.deal.findFirst({where: {id: q.dealId, ...scope}, select: {id: true}}))) throw notFound('Deal');
    // A deal's feed also shows its contacts' emails and notes, the context reps actually need.
    return {OR: [{dealId: q.dealId}, {contact: {deals: {some: {dealId: q.dealId}}, ...scope}, type: {in: ['email_out', 'email_in', 'note', 'interaction_CALL', 'interaction_MEETING']}}]};
  }
  throw new HTTPException(400, {message: 'Pass contactId, companyId or dealId'});
}

export const timeline = new Hono<AppEnv>()
  // How many entries each tab has, so the feed only shows tabs with something in them.
  .get('/counts', valid('query', recordQuery), async (c) => {
    const where = await feedWhere(c, c.req.valid('query'));
    const byType = await c.var.db.activity.groupBy({by: ['type'], where, _count: {_all: true}});
    const counts: Record<string, number> = Object.fromEntries(GROUP_NAMES.map((g) => [g, 0]));
    for (const row of byType) {
      counts.all! += row._count._all;
      for (const [group, types] of Object.entries(GROUPS)) if (types.includes(row.type)) counts[group]! += row._count._all;
    }
    return c.json({counts});
  })

  .get(
  '/',
  valid('query', recordQuery.extend({
    group: z.enum(GROUP_NAMES).default('all'),
    q: z.string().trim().max(100).optional(),
    before: z.iso.datetime().optional(), // ISO cursor (nextCursor); anything else is a 422, never an Invalid Date
    take: intParam(1, 100).default(40),
  })),
  async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const [feed, scope] = await Promise.all([feedWhere(c, q), ownerScope(c)]);
    let where = feed;
    if (q.group !== 'all') where = {AND: [where, {type: {in: GROUPS[q.group]}}]};
    if (q.before) where = {AND: [where, {createdAt: {lt: new Date(q.before)}}]};
    if (q.q) where = {AND: [where, {OR: [titleSearch(q.q, scope), {text: {contains: q.q, mode: 'insensitive'}}]}]};

    const rows = await db.activity.findMany({
      where,
      include: {
        actor: {select: userSelect},
        contact: {select: {id: true, firstName: true, lastName: true, ownerId: true}},
        deal: {select: {id: true, title: true, ownerId: true}},
        company: {select: {ownerId: true}},
        _count: {select: {comments: true}},
      },
      orderBy: {createdAt: 'desc'},
      take: q.take + 1,
    });
    const page = rows.slice(0, q.take);

    // Hydrate email events with the message so the feed can render subject, snippet and opens.
    const emailIds = page.filter((a) => a.type.startsWith('email_') && a.refId).map((a) => a.refId!);
    const messages = emailIds.length
      ? await db.emailMessage.findMany({
          where: {id: {in: emailIds}},
          select: {id: true, threadId: true, subject: true, text: true, fromEmail: true, fromName: true, to: true, status: true, error: true, openCount: true, clickCount: true, firstOpenedAt: true, sentAt: true, direction: true},
        })
      : [];
    const byId = new Map(messages.map((m) => [m.id, {...m, text: m.text?.slice(0, 600) ?? null}]));

    return c.json({
      // An entry's other record (a deal on a contact's feed) shows only when this person may open it,
      // and its stored title is replaced when it names a record they can't (AUDIT-2 L-2).
      rows: page.map((a) => ({...shownEntry(a, scope), contact: shownLink(a.contact, scope), deal: shownLink(a.deal, scope), email: a.refId ? byId.get(a.refId) ?? null : null})),
      nextCursor: rows.length > q.take ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  },
);
