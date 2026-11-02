import type {EmailThread} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {emit} from '../lib/events';
import {assignConversation, eventData, reopenConversation, SYSTEM} from './conversations';
import {feedsTeamInbox, hasTeamAccess, inboxContext, isBlocked, type InboxContext} from './settings';

/**
 * Routing and assignment for the shared inbox, called by every ingest path
 * (`ingestMessage()` for email, `formConversation()` for forms,
 * `receiveChannelMessage()` for chat and future channels) right after a message from
 * outside the team was stored on its thread.
 *
 * - The first inbound message makes the thread a conversation: it is stamped
 *   `firstInboundAt`, opened, and `conversation.created` is emitted.
 * - Blocked senders (Settings → Inbox) go straight to Spam.
 * - Personal-mailbox conversations belong to the mailbox owner; new team
 *   conversations are assigned round robin when Settings → Inbox says so.
 * - A reply reopens a closed conversation, wakes a snoozed one and brings a
 *   trashed one back. With "auto-assign replies" off, a reply to a closed
 *   conversation goes back to the queue (and through round robin again).
 */
export async function onInbound(db: Db, thread: EmailThread, message: {fromEmail: string; sentAt: Date; blocked?: boolean}, ctx?: InboxContext) {
  if (thread.channel === 'ticket') return {thread, isNew: false, spam: false};
  const c = ctx ?? (await inboxContext(db));
  const at = message.sentAt;
  const isNew = !thread.firstInboundAt;
  const blocked = !!message.blocked || isBlocked(c.settings, message.fromEmail);
  const account = thread.accountId ? await db.emailAccount.findUnique({where: {id: thread.accountId}, select: {id: true, userId: true}}) : null;
  // Form and chat conversations always belong to the team inbox, whatever mailbox replies go out from.
  const team = thread.channel !== 'email' || feedsTeamInbox(c, account) || !account;

  let t = await db.emailThread.update({
    where: {id: thread.id},
    data: {
      firstInboundAt: thread.firstInboundAt ?? at,
      waitingSince: thread.waitingSince ?? at,
      unread: true,
      snoozedUntil: null,
      trashedAt: null,
      spamAt: blocked ? (thread.spamAt ?? new Date()) : thread.spamAt,
      ...(isNew ? {status: 'OPEN' as const, closedAt: null} : {}),
    },
  });

  if (!isNew && t.status === 'CLOSED' && !t.spamAt) {
    t = await reopenConversation(db, t, SYSTEM, {reason: 'reply'});
    if (team && !c.settings.autoAssignReplies && t.assigneeId) t = await assignConversation(db, t, null, SYSTEM, {via: 'reply', quiet: true});
    if (team && !t.assigneeId && !t.spamAt) t = await roundRobin(db, t, c);
  }

  if (isNew && !t.spamAt) {
    if (account?.userId && thread.channel === 'email') t = await assignConversation(db, t, account.userId, SYSTEM, {via: 'owner', quiet: true});
    else if (team && !t.assigneeId) t = await roundRobin(db, t, c);
  }
  if (isNew) await emit(db, 'conversation.created', {recordId: t.id, data: eventData(t, {from: message.fromEmail, spam: !!t.spamAt})});
  return {thread: t, isNew, spam: !!t.spamAt};
}

/** A message from the team (sent from the CRM or synced from a mailbox): nothing waits for an answer now. */
export async function onOutbound(db: Db, threadId: string, at: Date) {
  const t = await db.emailThread.findUnique({where: {id: threadId}, select: {firstInboundAt: true, firstResponseAt: true, waitingSince: true}});
  if (!t) return;
  const firstResponse = !t.firstResponseAt && t.firstInboundAt && at >= t.firstInboundAt;
  if (!t.waitingSince && !firstResponse) return;
  await db.emailThread.update({where: {id: threadId}, data: {waitingSince: null, ...(firstResponse ? {firstResponseAt: at} : {})}});
}

/** Round robin among the chosen members who can work the team inbox: the one assigned least recently goes next. */
export async function pickRoundRobin(db: Db, ctx: InboxContext) {
  const ids = ctx.settings.roundRobinIds;
  if (ctx.settings.assignment !== 'round_robin' || !ids.length) return null;
  const users = await db.member.findMany({where: {id: {in: ids}, active: true, role: {not: 'VIEWER'}}, select: {id: true, role: true}});
  const eligible = ids.filter((id) => users.some((u) => u.id === id && hasTeamAccess(u, ctx.settings)));
  if (!eligible.length) return null;
  const last = await db.emailThread.groupBy({by: ['assigneeId'], where: {assigneeId: {in: eligible}, assignedAt: {not: null}}, _max: {assignedAt: true}});
  const when = new Map(last.map((r) => [r.assigneeId, r._max.assignedAt?.getTime() ?? 0]));
  return [...eligible].sort((a, b) => (when.get(a) ?? 0) - (when.get(b) ?? 0))[0] ?? null;
}

async function roundRobin(db: Db, t: EmailThread, ctx: InboxContext) {
  const next = await pickRoundRobin(db, ctx);
  return next ? assignConversation(db, t, next, SYSTEM, {via: 'round_robin'}) : t;
}
