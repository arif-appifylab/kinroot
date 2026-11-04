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
import {createTicket} from '../lib/tickets';
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
import {ONLINE_MS} from '@/lib/chat';
import {filesFor, identityLabel, lastChannelMessages, linkChannelContact} from '../inbox/channel-messages';
import {agentCameOnline, getChatSettings} from '../inbox/chat';
import {agentMessage, chatDetail, markSeenByTeam, visitorPresence} from '../inbox/chat-agent';
import {receivedHtmlReader} from '../inbox/sanitize';
import {channelWhere, findReadable, inboxScope, viewWhere, withVisibleTickets, type InboxScope} from '../inbox/scope';
import {getInboxSettings, hasTeamAccess, saveInboxSettings} from '../inbox/settings';
import {getSettings} from '../lib/settings';
import {strings} from '../lib/json-list';

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
  const thread = await findReadable(c.var.db, scope, id);
  if (!thread) throw notFound('Conversation');
  return {thread, scope};
}

/** The agent "last seen" stamp (who is online for website chat): at most one write a minute per person. */
export async function stampLastSeen(db: AppContext['var']['db'], me: Pick<User, 'id' | 'lastSeenAt'>) {
  const last = me.lastSeenAt?.getTime() ?? 0;
  if (Date.now() - last <= 60_000) return;
  await db.member.update({where: {id: me.id}, data: {lastSeenAt: new Date()}});
  if (Date.now() - last >= ONLINE_MS) await agentCameOnline(); // back after being away: visitors see the team as available
}

/** Email messages the detail sends at once (the newest); older ones come from `/messages?before=`. */
const DETAIL_MESSAGES = 200;

/**
 * Of these people, who can read the conversation? (mentions only notify people who can open it)
 * The inbox settings and shared accounts are read once for all of them, and the checks run side by side.
 */
async function readersOf(db: AppContext['var']['db'], users: Pick<User, 'id' | 'role'>[], threadId: string, ctx: InboxScope['ctx']) {
  const ownerOnly = (await getSettings(db)).recordVisibility === 'owner';
  const ok = await Promise.all(users.map(async (u) => !!(await findReadable(db, await inboxScope(db, u, ctx, ownerOnly), threadId))));
  return users.filter((_, i) => ok[i]).map((u) => u.id);
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
    // Agents with the app open count as online for website chat (the inbox polls these counts, the shell the badges).
    await stampLastSeen(db, me);
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
            ? {direction: ch.direction, fromEmail: identity?.email ?? '', fromName: ch.direction === 'INBOUND' && identity ? identityLabel(identity) : null, text: preview(ch.text) || (strings(ch.fileIds).length ? 'Sent a file' : ''), sentAt: ch.createdAt}
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
    const now = new Date(); // the client's first `after` for /updates
    const id = c.req.param('id');
    const scope = await inboxScope(db, me);
    // The thread with its assignee and mailbox in one query (joined in the database).
    const found = await db.emailThread.findFirst({
      where: {AND: [{id}, scope.readable]},
      include: {assignee: {select: userSelect}, account: {select: {id: true, fromEmail: true, label: true, userId: true, provider: true}}},
    });
    if (!found || !(await withVisibleTickets(db, scope, [found])).length) throw notFound('Conversation');
    const {assignee, account, ...t} = found;
    const owner = scope.owner;

    // Everything that needs only the thread, side by side.
    const [newest, comments, contact, deal, inInbox, ticket, chat, usable, html] = await Promise.all([
      db.emailMessage.findMany({where: {threadId: t.id}, orderBy: [{sentAt: 'desc'}, {id: 'desc'}], take: DETAIL_MESSAGES + 1, include: {sender: {select: userSelect}}}),
      db.conversationComment.findMany({where: {threadId: t.id}, orderBy: {createdAt: 'asc'}, include: {author: {select: userSelect}}}),
      // Sidebar: the contact and what hangs off it, within the viewer's record visibility.
      t.contactId
        ? db.contact.findFirst({
            where: {id: t.contactId, ...owner},
            select: {id: true, firstName: true, lastName: true, email: true, phone: true, title: true, lifecycleStage: true, score: true, emailOptOut: true, owner: {select: userSelect}, companies: {orderBy: {isPrimary: 'desc'}, take: 1, select: {company: {select: {id: true, name: true, domain: true}}}}},
          })
        : null,
      t.dealId ? db.deal.findFirst({where: {id: t.dealId, ...owner}, select: {id: true, title: true, value: true, currency: true, status: true, stage: {select: {name: true}}}}) : null,
      db.emailThread.findFirst({where: {AND: [{id: t.id}, scope.listable]}, select: {id: true}}),
      t.channel === 'ticket' ? db.ticket.findUnique({where: {emailThreadId: t.id}, select: {id: true, number: true}}) : null,
      isMessageChannel(t.channel) ? chatDetail(db, t) : null,
      usableAccounts(db, me),
      receivedHtmlReader(),
      t.unread ? db.emailThread.update({where: {id: t.id}, data: {unread: false}}) : null,
    ]);
    const olderMessages = newest.length > DETAIL_MESSAGES;
    const messages = newest.slice(0, DETAIL_MESSAGES).reverse();

    // What hangs off the visible contact.
    const companyId = t.companyId ?? contact?.companies[0]?.company.id ?? null;
    const [company, deals, tickets, activity] = await Promise.all([
      companyId ? db.company.findFirst({where: {id: companyId, ...owner}, select: {id: true, name: true, domain: true, industry: true}}) : null,
      contact ? db.deal.findMany({where: {status: 'OPEN', contacts: {some: {contactId: contact.id}}, ...owner}, orderBy: {updatedAt: 'desc'}, take: 5, select: {id: true, title: true, value: true, currency: true, status: true, stage: {select: {name: true}}}}) : [],
      contact ? db.ticket.findMany({where: {AND: [scope.tickets ?? {}, {contactId: contact.id}]}, orderBy: {createdAt: 'desc'}, take: 5, select: {id: true, number: true, subject: true, status: true}}) : [],
      contact ? db.activity.findMany({where: {contactId: contact.id}, orderBy: {createdAt: 'desc'}, take: 6, select: {id: true, type: true, title: true, createdAt: true}}) : [],
    ]);
    const lastIn = newest.find((m) => m.direction === 'INBOUND');
    const replyTo = lastIn && lastIn.fromEmail.includes('@') ? lastIn.fromEmail : (chat?.visitor?.email ?? contact?.email ?? null);
    return c.json({
      now: now.toISOString(),
      conversation: {
        ...t,
        assignee,
        account,
        personal: !!account?.userId,
        inInbox: !!inInbox,
        ticket,
      },
      // Received HTML was cleaned when it arrived (older mail is cleaned here) and shows in an EmailFrame; our own emails show their text.
      messages: messages.map((m) => ({...m, html: m.direction === 'INBOUND' ? html(m.html) : null})),
      olderMessages,
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

  /** Older email messages of a long conversation ("Load older"), newest first in pages of 200, by (sentAt, id). */
  .get('/conversations/:id/messages', valid('query', z.object({before: z.iso.datetime({offset: true}), beforeId: z.string().max(60)})), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    const before = new Date(q.before);
    const [rows, html] = await Promise.all([
      db.emailMessage.findMany({
        where: {threadId: t.id, OR: [{sentAt: {lt: before}}, {sentAt: before, id: {lt: q.beforeId}}]},
        orderBy: [{sentAt: 'desc'}, {id: 'desc'}],
        take: DETAIL_MESSAGES + 1,
        include: {sender: {select: userSelect}},
      }),
      receivedHtmlReader(),
    ]);
    const page = rows.slice(0, DETAIL_MESSAGES).reverse();
    return c.json({messages: page.map((m) => ({...m, html: m.direction === 'INBOUND' ? html(m.html) : null})), more: rows.length > DETAIL_MESSAGES});
  })

  /**
   * What changed in an open conversation since `after`, for the client's poll (every 3 s for a
   * chat, 20 s for email); the full detail loads only on open, on focus and after a write. New chat
   * messages and those whose delivery / read changed, new comments and events, typing, the
   * visitor's presence, and the thread's state (the client reloads the detail when that moved or a
   * new email arrived). The scope, then ONE query for the thread and all of it (joined in the database).
   */
  .get('/conversations/:id/updates', valid('query', z.object({after: z.iso.datetime({offset: true})})), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const now = new Date();
    // A little overlap: rows carry the database's or the Worker's clock; the client merges by id.
    const since = new Date(new Date(c.req.valid('query').after).getTime() - 5_000);
    const [scope, chatSettings] = await Promise.all([inboxScope(db, me), getChatSettings(db)]);
    const found = await db.emailThread.findFirst({
      where: {AND: [{id: c.req.param('id')}, scope.readable]},
      select: {
        id: true,
        channel: true,
        status: true,
        assigneeId: true,
        snoozedUntil: true,
        spamAt: true,
        trashedAt: true,
        contactId: true,
        dealId: true,
        companyId: true,
        unread: true,
        contactTypingAt: true,
        identity: {select: {lastSeenAt: true}},
        channelMessages: {
          where: {OR: [{createdAt: {gt: since}}, {direction: 'OUTBOUND', OR: [{deliveredAt: {gt: since}}, {readAt: {gt: since}}]}]},
          orderBy: {createdAt: 'asc'},
          take: 200,
          include: {sender: {select: userSelect}},
        },
        comments: {where: {createdAt: {gt: since}}, orderBy: {createdAt: 'asc'}, take: 200, include: {author: {select: userSelect}}},
        messages: {orderBy: [{sentAt: 'desc'}, {id: 'desc'}], take: 1, select: {id: true}},
      },
    });
    if (!found || !(await withVisibleTickets(db, scope, [found])).length) throw notFound('Conversation');
    const {identity, channelMessages, comments, messages, unread, contactTypingAt, ...state} = found;
    const chat = isMessageChannel(found.channel);
    // The agent is looking at it: the visitor's new messages count as read, and so does the conversation.
    const [files] = await Promise.all([
      chat ? filesFor(db, channelMessages) : new Map(),
      chat ? markSeenByTeam(db, channelMessages) : null,
      unread ? db.emailThread.update({where: {id: found.id}, data: {unread: false}}) : null,
    ]);
    return c.json({
      now: now.toISOString(),
      state: {...state, lastEmailId: messages[0]?.id ?? null},
      chat: chat
        ? {
            messages: channelMessages.map((m) => agentMessage(m, files)),
            typing: !!contactTypingAt && now.getTime() - contactTypingAt.getTime() < 8000,
            visitor: identity ? visitorPresence(identity, chatSettings.awayAfterMin, now.getTime()) : null,
          }
        : null,
      comments,
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
    const {thread: t, scope} = await loadConversation(c, c.req.param('id'));
    const {body} = c.req.valid('json');
    // Mentions only reach people who can open this conversation.
    const named = await mentionedUsers(db, body);
    const users = named.length ? await db.member.findMany({where: {id: {in: named.slice(0, 50)}}, select: {id: true, role: true}}) : [];
    const allowed = users.length ? await readersOf(db, users, t.id, scope.ctx) : [];
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
    const threads = await withVisibleTickets(db, scope, await db.emailThread.findMany({where: {AND: [{id: {in: input.ids}}, scope.readable]}}));
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
      // Which accounts are personal: one query for the whole selection (not one per conversation).
      const accountIds = isAdmin(me) ? [] : [...new Set(threads.flatMap((t) => (t.trashedAt && t.accountId ? [t.accountId] : [])))];
      const personal = new Set(
        accountIds.length ? (await db.emailAccount.findMany({where: {id: {in: accountIds}, userId: {not: null}}, select: {id: true}})).map((a) => a.id) : [],
      );
      const ok: EmailThread[] = [];
      for (const t of threads) {
        if (!t.trashedAt) errors.push(`${t.subject}: move it to Trash first`);
        else if (!isAdmin(me) && !(t.accountId && personal.has(t.accountId))) errors.push(`${t.subject}: only admins can delete team conversations`);
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
