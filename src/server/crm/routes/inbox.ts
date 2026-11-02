import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {EmailThread, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {BLOCK_KINDS, BULK_ACTIONS, CHANNEL_FILTERS, INBOX_SORTS, isMessageChannel, VIEW_KEYS, type ChannelFilter, type InboxSettings, type InboxView} from '@/lib/inbox';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {diff, logActivity} from '../lib/activity';
import {audit} from '../lib/audit';
import {associateByDomain} from '../lib/domains';
import {checkDuplicates} from '../lib/duplicates';
import {emit} from '../lib/events';
import {notFound, ownerScope, valid} from '../lib/http';
import {mentionedUsers, notify, notifyMentions} from '../lib/notify';
import {stripQuoted} from '../lib/ticket-mail';
import {createTicket, ticketScope} from '../lib/tickets';
import {userSelect} from '../lib/users';
import {sendEmail, usableAccounts} from '../email/service';
import {
  assignConversation,
  closeConversation,
  conversationLink,
  deleteConversations,
  markSpam,
  notSpam,
  reopenConversation,
  restoreConversation,
  setRead,
  snoozeConversation,
  threadEvent,
  trashConversation,
  unsnoozeConversation,
  type Who,
} from '../inbox/conversations';
import {identityLabel, lastChannelMessages, linkChannelContact} from '../inbox/channel-messages';
import {chatDetail} from '../inbox/chat-agent';
import {sanitizeEmailHtml} from '../inbox/sanitize';
import {channelWhere, inboxScope, viewWhere} from '../inbox/scope';
import {getInboxSettings, hasTeamAccess, saveInboxSettings} from '../inbox/settings';

/**
 * Shared inbox (module 10). Every read and write goes through `inboxScope()`,
 * so a conversation someone may not see is a 404 everywhere (list, detail,
 * counts, search, actions). State changes are the helpers in
 * src/server/inbox/conversations.ts; replies are normal `sendEmail()`s.
 */

export const who = (c: AppContext): Who => {
  const me = currentUser(c);
  return {c, actor: {id: me.id, name: me.name}};
};

const listQuery = z.object({
  view: z.enum(VIEW_KEYS as [InboxView, ...InboxView[]]).default('open'),
  channel: z.enum(Object.keys(CHANNEL_FILTERS) as [ChannelFilter, ...ChannelFilter[]]).optional(),
  assigneeId: z.string().max(60).optional(), // a user id, "me" or "none"
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  unread: z.enum(['1']).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(Object.keys(INBOX_SORTS) as [keyof typeof INBOX_SORTS, ...(keyof typeof INBOX_SORTS)[]]).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

function searchWhere(q: string): Prisma.EmailThreadWhereInput {
  const like = {contains: q, mode: 'insensitive' as const};
  return {
    OR: [
      {subject: like},
      {contact: {OR: [{email: like}, {firstName: like}, {lastName: like}]}},
      {messages: {some: {OR: [{fromEmail: like}, {fromName: like}, {subject: like}, {text: like}]}}},
      {channelMessages: {some: {text: like}}},
      {identity: {OR: [{name: like}, {email: like}]}},
    ],
  };
}

const listInclude = {
  assignee: {select: userSelect},
  contact: {select: {id: true, firstName: true, lastName: true, email: true}},
  account: {select: {id: true, fromEmail: true, label: true, userId: true}},
  identity: {select: {id: true, name: true, email: true, lastSeenAt: true}},
  messages: {orderBy: {sentAt: 'desc' as const}, take: 1, select: {direction: true, fromEmail: true, fromName: true, text: true, sentAt: true}},
  _count: {select: {messages: true, channelMessages: true, comments: {where: {kind: 'comment'}}}},
} satisfies Prisma.EmailThreadInclude;

/** One conversation the user may read, else 404. */
export async function loadConversation(c: AppContext, id: string) {
  const scope = await inboxScope(c.var.db, currentUser(c));
  const thread = await c.var.db.emailThread.findFirst({where: {AND: [{id}, scope.readable]}});
  if (!thread) throw notFound('Conversation');
  return {thread, scope};
}

/** Can this person read the conversation? (mentions only notify people who can open it) */
async function canRead(db: AppContext['var']['db'], user: Pick<User, 'id' | 'role'>, threadId: string) {
  const scope = await inboxScope(db, user);
  return !!(await db.emailThread.findFirst({where: {AND: [{id: threadId}, scope.readable]}, select: {id: true}}));
}

const isPersonal = async (db: AppContext['var']['db'], t: EmailThread) =>
  !!(t.accountId && (await db.emailAccount.findUnique({where: {id: t.accountId}, select: {userId: true}}))?.userId);

const settingsSchema = z.object({
  teamAccounts: z.union([z.literal('all'), z.array(z.string().max(60)).max(100)]),
  access: z.enum(['everyone', 'members']),
  memberIds: z.array(z.string().max(60)).max(500),
  visibility: z.enum(['all', 'mine_and_unassigned']),
  assignment: z.enum(['manual', 'round_robin']),
  roundRobinIds: z.array(z.string().max(60)).max(200),
  autoAssignReplies: z.boolean(),
  autoCloseDays: z.number().int().min(1).max(365).nullable(),
  blockedAddresses: z.array(z.email().transform((v) => v.toLowerCase())).max(1000),
  blockedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a domain like example.com')).max(1000),
});

export const inbox = new Hono<AppEnv>()
  // ─── Counts for the left navigation and the sidebar badge ───
  .get('/counts', async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const scope = await inboxScope(db, me);
    const count = (where: Prisma.EmailThreadWhereInput) => db.emailThread.count({where: {AND: [scope.listable, where]}});
    const open = viewWhere('open', me);
    // Agents with the app open count as online for website chat (the app polls these counts).
    if (!me.lastSeenAt || Date.now() - me.lastSeenAt.getTime() > 60_000) await db.member.update({where: {id: me.id}, data: {lastSeenAt: new Date()}});
    const chatWaiting: Prisma.EmailThreadWhereInput = {AND: [open, channelWhere('chat', me, scope.ctx), {unread: true}, {OR: [{assigneeId: me.id}, {assigneeId: null}]}]};
    const [unassigned, mine, all, snoozed, closed, spam, trash, team, personal, form, chat, unread, chatUnread, chatLatest] = await Promise.all([
      count(viewWhere('unassigned', me)),
      count(viewWhere('mine', me)),
      count(open),
      count(viewWhere('snoozed', me)),
      count(viewWhere('closed', me)),
      count(viewWhere('spam', me)),
      count(viewWhere('trash', me)),
      count({AND: [open, channelWhere('team', me, scope.ctx)]}),
      count({AND: [open, channelWhere('personal', me, scope.ctx)]}),
      count({AND: [open, channelWhere('form', me, scope.ctx)]}),
      count({AND: [open, channelWhere('chat', me, scope.ctx)]}),
      // Sidebar badge: unread conversations waiting on me or on the queue.
      count({AND: [open, {unread: true}, {OR: [{assigneeId: me.id}, {assigneeId: null}]}]}),
      // New-message sound / badge for chats: unread chats waiting on me or on the queue, and their latest message.
      count(chatWaiting),
      db.emailThread.findFirst({where: {AND: [scope.listable, chatWaiting]}, orderBy: {lastMessageAt: 'desc'}, select: {lastMessageAt: true}}),
    ]);
    return c.json({
      views: {unassigned, mine, open: all, snoozed, closed},
      channels: {team, personal, form, chat},
      folders: {spam, trash},
      unread,
      chat: {unread: chatUnread, latest: chatLatest?.lastMessageAt ?? null},
      teamAccess: scope.team,
    });
  })

  // ─── List ───
  .get('/conversations', valid('query', listQuery), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const q = c.req.valid('query');
    const scope = await inboxScope(db, me);
    const and: Prisma.EmailThreadWhereInput[] = [scope.listable, viewWhere(q.view, me)];
    if (q.channel) and.push(channelWhere(q.channel, me, scope.ctx));
    if (q.assigneeId) and.push({assigneeId: q.assigneeId === 'none' ? null : q.assigneeId === 'me' ? me.id : q.assigneeId});
    if (q.status) and.push({status: q.status});
    if (q.unread) and.push({unread: true});
    if (q.q) and.push(searchWhere(q.q));
    const where = {AND: and};
    const orderBy: Prisma.EmailThreadOrderByWithRelationInput[] =
      q.sort === 'oldest' ? [{lastMessageAt: 'asc'}] : q.sort === 'waiting' ? [{waitingSince: {sort: 'asc', nulls: 'last'}}, {lastMessageAt: 'asc'}] : [{lastMessageAt: 'desc'}];
    const [rows, total] = await Promise.all([
      db.emailThread.findMany({where, include: listInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize}),
      db.emailThread.count({where}),
    ]);
    // The person on the other side: the latest inbound sender (else the contact).
    const senders = rows.length
      ? await db.emailMessage.findMany({where: {threadId: {in: rows.map((r) => r.id)}, direction: 'INBOUND'}, orderBy: {sentAt: 'desc'}, distinct: ['threadId'], select: {threadId: true, fromEmail: true, fromName: true}})
      : [];
    const byThread = new Map(senders.map((s) => [s.threadId, s]));
    // Chat & co.: the person is the channel identity, the preview the latest channel message (or email, whichever is newer).
    const lastChannel = await lastChannelMessages(db, rows.filter((r) => isMessageChannel(r.channel)).map((r) => r.id));
    const preview = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').slice(0, 160);
    return c.json({
      rows: rows.map(({messages, identity, ...t}) => {
        const ch = lastChannel.get(t.id);
        const email = messages[0];
        const last =
          ch && (!email || ch.createdAt >= email.sentAt)
            ? {direction: ch.direction, fromEmail: identity?.email ?? '', fromName: ch.direction === 'INBOUND' && identity ? identityLabel(identity) : null, text: preview(ch.text) || (ch.fileIds.length ? 'Sent a file' : ''), sentAt: ch.createdAt}
            : email ? {...email, text: preview(email.text)} : null;
        const sender = identity ? {email: identity.email ?? '', name: identityLabel(identity)} : byThread.get(t.id) ? {email: byThread.get(t.id)!.fromEmail, name: byThread.get(t.id)!.fromName} : null;
        return {...t, _count: {...t._count, messages: t._count.messages + t._count.channelMessages}, sender, personal: !!t.account?.userId, last, online: !!identity && Date.now() - identity.lastSeenAt.getTime() < 60_000};
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  })

  // ─── Detail ───
  .get('/conversations/:id', async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const {thread: t, scope} = await loadConversation(c, c.req.param('id'));
    const [messages, comments, account] = await Promise.all([
      db.emailMessage.findMany({where: {threadId: t.id}, orderBy: {sentAt: 'asc'}, include: {sender: {select: userSelect}}}),
      db.conversationComment.findMany({where: {threadId: t.id}, orderBy: {createdAt: 'asc'}, include: {author: {select: userSelect}}}),
      t.accountId ? db.emailAccount.findUnique({where: {id: t.accountId}, select: {id: true, fromEmail: true, label: true, userId: true, provider: true}}) : null,
    ]);
    if (t.unread) await db.emailThread.update({where: {id: t.id}, data: {unread: false}});

    // Sidebar: the contact and what hangs off it, within the viewer's record visibility.
    const owner = await ownerScope(c);
    const contact = t.contactId
      ? await db.contact.findFirst({
          where: {id: t.contactId, ...owner},
          select: {id: true, firstName: true, lastName: true, email: true, phone: true, title: true, lifecycleStage: true, score: true, emailOptOut: true, owner: {select: userSelect}, companies: {orderBy: {isPrimary: 'desc'}, take: 1, select: {company: {select: {id: true, name: true, domain: true}}}}},
        })
      : null;
    const companyId = t.companyId ?? contact?.companies[0]?.company.id ?? null;
    const [company, deal, deals, tickets, activity] = await Promise.all([
      companyId ? db.company.findFirst({where: {id: companyId, ...owner}, select: {id: true, name: true, domain: true, industry: true}}) : null,
      t.dealId ? db.deal.findFirst({where: {id: t.dealId, ...owner}, select: {id: true, title: true, value: true, currency: true, status: true, stage: {select: {name: true}}}}) : null,
      contact ? db.deal.findMany({where: {status: 'OPEN', contacts: {some: {contactId: contact.id}}, ...owner}, orderBy: {updatedAt: 'desc'}, take: 5, select: {id: true, title: true, value: true, currency: true, status: true, stage: {select: {name: true}}}}) : [],
      contact ? db.ticket.findMany({where: {AND: [await ticketScope(c), {contactId: contact.id}]}, orderBy: {createdAt: 'desc'}, take: 5, select: {id: true, number: true, subject: true, status: true}}) : [],
      contact ? db.activity.findMany({where: {contactId: contact.id}, orderBy: {createdAt: 'desc'}, take: 6, select: {id: true, type: true, title: true, createdAt: true}}) : [],
    ]);
    const lastIn = [...messages].reverse().find((m) => m.direction === 'INBOUND');
    const chat = isMessageChannel(t.channel) ? await chatDetail(db, t) : null;
    const replyTo = lastIn && lastIn.fromEmail.includes('@') ? lastIn.fromEmail : (chat?.visitor?.email ?? contact?.email ?? null);
    const usable = await usableAccounts(db, me);
    return c.json({
      conversation: {
        ...t,
        assignee: t.assigneeId ? await db.member.findUnique({where: {id: t.assigneeId}, select: userSelect}) : null,
        account,
        personal: !!account?.userId,
        inInbox: !!(await db.emailThread.findFirst({where: {AND: [{id: t.id}, scope.listable]}, select: {id: true}})),
        ticket: t.channel === 'ticket' ? await db.ticket.findUnique({where: {emailThreadId: t.id}, select: {id: true, number: true}}) : null,
      },
      // Received HTML is sanitised here and shown in a sandboxed frame; our own emails show their text.
      messages: messages.map((m) => ({...m, html: m.direction === 'INBOUND' && m.html ? sanitizeEmailHtml(m.html) : null})),
      comments,
      replyTo,
      // The conversation's mailbox when the viewer may send from it, else their default one.
      canReply: chat ? true : !!replyTo && usable.length > 0,
      chat,
      sidebar: {
        contact,
        company,
        deal,
        deals,
        tickets,
        activity,
        sender: chat?.visitor ? {email: chat.visitor.email ?? '', name: chat.visitor.label} : lastIn ? {email: lastIn.fromEmail, name: lastIn.fromName} : null,
        contactHidden: !!t.contactId && !contact,
      },
    });
  })

  // ─── Reply (always an email through sendEmail(), from the conversation's account) ───
  .post('/conversations/:id/reply', valid('json', z.object({
    html: z.string().max(200_000).optional(),
    body: z.string().max(100_000).optional(),
    cc: z.array(z.email()).max(20).optional(),
    layout: z.enum(['branded', 'plain']).optional(),
    close: z.boolean().optional(),
  })), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const input = c.req.valid('json');
    if (!input.html && !input.body?.trim()) throw new HTTPException(400, {message: 'Write a reply first'});
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    if (t.channel === 'ticket') throw new HTTPException(400, {message: 'Reply from the ticket instead'});
    if (isMessageChannel(t.channel)) throw new HTTPException(400, {message: 'Reply in the chat instead'});
    const lastIn = await db.emailMessage.findFirst({where: {threadId: t.id, direction: 'INBOUND'}, orderBy: {sentAt: 'desc'}, select: {fromEmail: true}});
    const contact = t.contactId ? await db.contact.findUnique({where: {id: t.contactId}, select: {email: true}}) : null;
    const to = lastIn?.fromEmail.includes('@') ? lastIn.fromEmail : contact?.email;
    if (!to) throw new HTTPException(400, {message: 'There is no email address to reply to'});
    const usable = await usableAccounts(db, me);
    const accountId = t.accountId && usable.some((a) => a.id === t.accountId) ? t.accountId : undefined;
    const message = await sendEmail(db, me, publicOrigin(c.req.raw), {
      accountId,
      to: [to],
      cc: input.cc,
      subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`,
      html: input.html,
      body: input.body,
      layout: input.layout ?? 'plain',
      threadId: t.id,
      contactId: t.contactId,
      companyId: t.companyId,
      dealId: t.dealId,
    });
    let thread = await db.emailThread.update({where: {id: t.id}, data: {unread: false}});
    if (input.close) thread = await closeConversation(db, thread, who(c));
    return c.json({message, conversation: thread}, 201);
  })

  // ─── Internal comments (never emailed) ───
  .post('/conversations/:id/comments', valid('json', z.object({body: z.string().trim().min(1, 'Write a comment').max(10_000)})), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const {body} = c.req.valid('json');
    // Mentions only reach people who can open this conversation.
    const named = await mentionedUsers(db, body);
    const users = named.length ? await db.member.findMany({where: {id: {in: named}}}) : [];
    const allowed: string[] = [];
    for (const u of users) if (await canRead(db, u, t.id)) allowed.push(u.id);
    const comment = await db.conversationComment.create({data: {threadId: t.id, kind: 'comment', body, authorId: me.id, data: {mentions: allowed}}, include: {author: {select: userSelect}}});
    await notifyMentions(db, body, {actorId: me.id, actorName: me.name, where: `on a conversation: ${t.subject}`, link: conversationLink(t.id), only: allowed});
    // On the contact's timeline like other notes, except comments on a personal mailbox (private).
    // Without a contact yet the entry waits unlinked, like the emails; linking the contact adopts it.
    if (!(await isPersonal(db, t))) {
      await logActivity(db, {
        type: 'conversation_comment',
        title: `Commented on a conversation: ${t.subject}`,
        refId: comment.id,
        actorId: me.id,
        contactId: t.contactId,
        companyId: t.companyId,
        dealId: t.dealId,
        data: {threadId: t.id, subject: t.subject, body: body.slice(0, 2000)},
        text: body,
      });
    }
    // The assignee hears about comments from others even without a mention.
    if (t.assigneeId && !allowed.includes(t.assigneeId)) {
      await notify(db, [t.assigneeId], {type: 'comment', title: `${me.name} commented on ${t.subject}`, body, link: conversationLink(t.id), actorId: me.id});
    }
    return c.json({comment}, 201);
  })

  .delete('/conversations/:id/comments/:commentId', async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const comment = await db.conversationComment.findFirst({where: {id: c.req.param('commentId'), threadId: t.id, kind: 'comment'}});
    if (!comment) throw notFound('Comment');
    if (comment.authorId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the author can delete this comment'});
    await db.conversationComment.deleteMany({where: {id: comment.id}});
    await db.activity.deleteMany({where: {type: 'conversation_comment', refId: comment.id}});
    return c.json({ok: true});
  })

  // ─── Actions (one or many conversations) ───
  .post('/conversations/actions', valid('json', z.object({
    ids: z.array(z.string().max(60)).min(1).max(200),
    action: z.enum(BULK_ACTIONS),
    assigneeId: z.string().max(60).nullish(),
    until: z.iso.datetime({offset: true}).optional(),
    block: z.enum(BLOCK_KINDS).nullish(),
  })), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const input = c.req.valid('json');
    const scope = await inboxScope(db, me);
    const threads = await db.emailThread.findMany({where: {AND: [{id: {in: input.ids}}, scope.readable]}});
    if (!threads.length) throw notFound('Conversation');
    const w = who(c);
    const errors: string[] = [];
    let done = 0;
    let binIds: string[] = [];

    if (input.action === 'read' || input.action === 'unread') {
      await setRead(db, threads.map((t) => t.id), input.action === 'read');
      return c.json({done: threads.length, skipped: input.ids.length - threads.length, errors});
    }
    if (input.action === 'delete') {
      // Only from Trash; team conversations need an admin, personal ones their owner.
      const ok: EmailThread[] = [];
      for (const t of threads) {
        if (!t.trashedAt) errors.push(`${t.subject}: move it to Trash first`);
        else if (!isAdmin(me) && !(await isPersonal(db, t))) errors.push(`${t.subject}: only admins can delete team conversations`);
        else ok.push(t);
      }
      const bins = await deleteConversations(db, ok, w);
      binIds = bins.map((b) => b.id);
      return c.json({done: ok.length, skipped: threads.length - ok.length, errors, binIds});
    }
    if (input.action === 'snooze' && !input.until) throw new HTTPException(400, {message: 'Pick when it should come back'});

    for (const t of threads) {
      try {
        switch (input.action) {
          case 'assign':
            await assignConversation(db, t, input.assigneeId ?? null, w);
            break;
          case 'close':
            await closeConversation(db, t, w);
            break;
          case 'reopen':
            await reopenConversation(db, t, w);
            break;
          case 'snooze':
            await snoozeConversation(db, t, new Date(input.until!), w);
            break;
          case 'unsnooze':
            await unsnoozeConversation(db, t, w);
            break;
          case 'spam':
            await markSpam(db, t, w, input.block ?? null);
            break;
          case 'not_spam':
            await notSpam(db, t, w);
            break;
          case 'trash':
            await trashConversation(db, t, w);
            break;
          case 'restore':
            await restoreConversation(db, t, w);
            break;
        }
        done++;
      } catch (e) {
        if (!(e instanceof HTTPException)) throw e;
        if (threads.length === 1) throw e;
        errors.push(`${t.subject}: ${e.message}`);
      }
    }
    return c.json({done, skipped: input.ids.length - done, errors});
  })

  // ─── Sidebar: link or create the contact, associate a deal, create a ticket ───
  .post('/conversations/:id/contact', valid('json', z.object({
    contactId: z.string().max(60).nullish(),
    create: z.object({firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().max(100).nullish(), email: z.email().transform((v) => v.toLowerCase()).nullish()}).optional(),
  })), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const input = c.req.valid('json');
    let contactId = input.contactId ?? null;
    if (input.create) {
      const email = input.create.email ?? null;
      if (email && (await db.contact.findFirst({where: {email}, select: {id: true}}))) throw new HTTPException(409, {message: `A contact with ${email} already exists: link it instead`});
      const contact = await db.contact.create({data: {firstName: input.create.firstName, lastName: input.create.lastName || null, email, ownerId: me.id, source: 'Inbox', lastActivityAt: new Date()}});
      await logActivity(db, {type: 'contact_created', title: 'Contact created from the inbox', actorId: me.id, contactId: contact.id});
      await emit(db, 'contact.created', {recordId: contact.id, actorId: me.id, data: contact});
      await audit(db, c, {action: 'contact.created', entity: 'contact', recordId: contact.id, label: [contact.firstName, contact.lastName].filter(Boolean).join(' '), meta: {from: 'inbox'}});
      await associateByDomain(db, contact.id, me.id).catch(() => null);
      await checkDuplicates(db, 'contact', contact.id);
      contactId = contact.id;
    } else if (contactId && !(await db.contact.findFirst({where: {id: contactId, ...(await ownerScope(c))}, select: {id: true}}))) {
      throw notFound('Contact');
    }
    const primary = contactId ? await db.contactCompany.findFirst({where: {contactId}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}) : null;
    const thread = await db.emailThread.update({where: {id: t.id}, data: {contactId, companyId: contactId ? (t.companyId ?? primary?.companyId ?? null) : t.companyId}});
    if (contactId) {
      // Earlier messages (and their timeline entries) now belong to the contact too.
      const messages = await db.emailMessage.findMany({where: {threadId: t.id}, select: {id: true}});
      await db.emailMessage.updateMany({where: {threadId: t.id, contactId: null}, data: {contactId}});
      const comments = await db.conversationComment.findMany({where: {threadId: t.id, kind: 'comment'}, select: {id: true}});
      await db.activity.updateMany({where: {refId: {in: [...messages, ...comments].map((m) => m.id)}, contactId: null}, data: {contactId, companyId: thread.companyId}});
      await db.formSubmission.updateMany({where: {id: t.formSubmissionId ?? '', contactId: null}, data: {contactId}});
      // Chat & co.: the visitor, their messages and the conversation's timeline entry follow.
      if (isMessageChannel(t.channel)) await linkChannelContact(db, thread, contactId);
    }
    return c.json({conversation: thread});
  })

  .patch('/conversations/:id', valid('json', z.object({dealId: z.string().max(60).nullable().optional()})), async (c) => {
    const db = c.var.db;
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const {dealId} = c.req.valid('json');
    if (dealId && !(await db.deal.findFirst({where: {id: dealId, ...(await ownerScope(c))}, select: {id: true}}))) throw notFound('Deal');
    const thread = await db.emailThread.update({where: {id: t.id}, data: {dealId}});
    if (dealId !== undefined && dealId !== t.dealId) await threadEvent(db, t.id, {type: 'deal', to: dealId ?? null}, currentUser(c).id);
    return c.json({conversation: thread});
  })

  .post('/conversations/:id/ticket', valid('json', z.object({subject: z.string().trim().min(1).max(300).optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional()})), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const input = c.req.valid('json');
    const lastIn = await db.emailMessage.findFirst({where: {threadId: t.id, direction: 'INBOUND'}, orderBy: {sentAt: 'desc'}, select: {text: true, sentAt: true}});
    const lastChat = isMessageChannel(t.channel) ? await db.channelMessage.findFirst({where: {threadId: t.id, direction: 'INBOUND'}, orderBy: {createdAt: 'desc'}, select: {text: true, createdAt: true}}) : null;
    const description = lastChat && (!lastIn || lastChat.createdAt >= lastIn.sentAt) ? lastChat.text : lastIn?.text ? stripQuoted(lastIn.text) : null;
    const ticket = await createTicket(db, {
      subject: input.subject ?? t.subject,
      description,
      source: t.channel === 'form' ? 'FORM' : isMessageChannel(t.channel) ? 'MANUAL' : 'EMAIL',
      priority: input.priority,
      contactId: t.contactId,
      companyId: t.companyId,
      dealId: t.dealId,
      assigneeId: t.assigneeId,
      actorId: me.id,
    });
    await audit(db, c, {action: 'ticket.created', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`, meta: {from: 'inbox', conversationId: t.id}});
    await threadEvent(db, t.id, {type: 'ticket', ticketId: ticket.id, number: ticket.number}, me.id);
    return c.json({ticket}, 201);
  })

  // ─── Settings → Inbox (admins) ───
  .get('/settings', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const [settings, shared] = await Promise.all([getInboxSettings(db), db.emailAccount.findMany({where: {userId: null}, select: {id: true, label: true, fromEmail: true, provider: true}, orderBy: {createdAt: 'asc'}})]);
    return c.json({settings, sharedAccounts: shared});
  })

  .put('/settings', requireRole('ADMIN'), valid('json', settingsSchema), async (c) => {
    const db = c.var.db;
    const before = await getInboxSettings(db);
    const input = c.req.valid('json');
    const shared = new Set((await db.emailAccount.findMany({where: {userId: null}, select: {id: true}})).map((a) => a.id));
    const users = await db.member.findMany({where: {active: true}, select: {id: true, role: true}});
    const active = new Set(users.map((u) => u.id));
    const next: InboxSettings = {
      ...input,
      teamAccounts: input.teamAccounts === 'all' ? 'all' : input.teamAccounts.filter((id) => shared.has(id)),
      memberIds: input.memberIds.filter((id) => active.has(id)),
      roundRobinIds: [...new Set(input.roundRobinIds.filter((id) => active.has(id)))],
      blockedAddresses: [...new Set(input.blockedAddresses)],
      blockedDomains: [...new Set(input.blockedDomains)],
    };
    const noAccess = users.filter((u) => next.roundRobinIds.includes(u.id) && !hasTeamAccess(u, next));
    if (noAccess.length) throw new HTTPException(400, {message: 'Everyone in the round robin needs access to the team inbox'});
    if (next.assignment === 'round_robin' && !next.roundRobinIds.length) throw new HTTPException(400, {message: 'Pick at least one person for the round robin'});
    const settings = await saveInboxSettings(db, next);
    await audit(db, c, {action: 'settings.inbox', meta: {changes: diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)}});
    return c.json({settings});
  });
