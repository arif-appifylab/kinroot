import {HTTPException} from 'hono/http-exception';

import type {EmailThread, Prisma} from '../../../generated/prisma/client';
import {domainOf, isMessageChannel, MESSAGE_CHANNELS, TRASH_DAYS, type BlockKind} from '@/lib/inbox';
import type {Db} from '../kit/db';
import type {AppContext} from '../kit/guards';
import {audit} from '../lib/audit';
import {emit} from '../lib/events';
import {enqueue, kickJobs} from '../lib/jobs';
import {notify} from '../lib/notify';
import {moveToBin} from '../lib/recycle-bin';
import {refreshChannelActivity} from './channel-messages';
import {getInboxSettings, hasTeamAccess, inboxContext, saveInboxSettings} from './settings';

/**
 * Conversation state changes. Every change goes through these helpers so the
 * thread's event lines, domain events (conversation.*), notifications and the
 * audit log stay in step. Status changes never touch the contact timeline.
 * `c` is the request (audit actor, IP); jobs pass null and show as "System".
 */
export type Actor = {id: string; name: string} | null;
export type Who = {c: AppContext | null; actor: Actor};
export const SYSTEM: Who = {c: null, actor: null};

export const conversationLink = (id: string) => `/inbox?thread=${id}`;

/** Snapshot for events and automations: always carries contactId / dealId so triggers find the record. */
export const eventData = (t: EmailThread, extra: Record<string, unknown> = {}) => ({
  conversationId: t.id,
  subject: t.subject,
  channel: t.channel,
  status: t.status,
  assigneeId: t.assigneeId,
  accountId: t.accountId,
  contactId: t.contactId,
  companyId: t.companyId,
  dealId: t.dealId,
  ...extra,
});

/** An event line in the conversation (assigned, closed, snoozed…). */
export async function threadEvent(db: Db, threadId: string, data: Prisma.InputJsonObject, authorId?: string | null) {
  await db.conversationComment.create({data: {threadId, kind: 'event', authorId: authorId ?? null, data}});
}

const auditLabel = (t: EmailThread) => t.subject;

export async function assignConversation(db: Db, before: EmailThread, assigneeId: string | null, who: Who, opts: {via?: 'round_robin' | 'owner' | 'reply'; quiet?: boolean} = {}) {
  if (before.assigneeId === assigneeId) return before;
  if (assigneeId) {
    const account = before.accountId ? await db.emailAccount.findUnique({where: {id: before.accountId}, select: {userId: true}}) : null;
    // Personal mailboxes stay private: only their owner can hold the conversation.
    if (account?.userId && account.userId !== assigneeId) throw new HTTPException(400, {message: 'Conversations in a personal mailbox can only be assigned to its owner'});
    const user = await db.member.findFirst({where: {id: assigneeId, active: true}, select: {id: true, role: true}});
    if (!user) throw new HTTPException(400, {message: 'Pick an active team member'});
    // Team conversations go to people who can open the team inbox.
    if (!account?.userId && before.channel !== 'ticket' && !hasTeamAccess(user, await getInboxSettings(db))) {
      throw new HTTPException(400, {message: 'That person has no access to the team inbox (Settings → Inbox)'});
    }
  }
  const t = await db.emailThread.update({where: {id: before.id}, data: {assigneeId, assignedAt: assigneeId ? new Date() : null}});
  const user = assigneeId ? await db.member.findUnique({where: {id: assigneeId}, select: {name: true}}) : null;
  await threadEvent(db, t.id, {type: 'assigned', to: assigneeId, name: user?.name ?? null, via: opts.via ?? null}, who.actor?.id);
  await emit(db, 'conversation.assigned', {recordId: t.id, actorId: who.actor?.id, data: eventData(t, {previousAssigneeId: before.assigneeId, via: opts.via ?? 'manual'})});
  if (opts.via !== 'owner') {
    await audit(db, who.c, {action: 'conversation.assigned', entity: 'conversation', recordId: t.id, label: auditLabel(t), meta: {changes: [{field: 'assigneeId', from: before.assigneeId, to: assigneeId}], via: opts.via ?? 'manual'}});
  }
  if (assigneeId && !opts.quiet) {
    await notify(db, [assigneeId], {type: 'assigned', title: `${who.actor?.name ?? 'Inbox'} assigned you a conversation: ${t.subject}`, link: conversationLink(t.id), actorId: who.actor?.id});
  }
  return t;
}

export async function closeConversation(db: Db, before: EmailThread, who: Who, opts: {reason?: 'manual' | 'auto'} = {}) {
  if (before.status === 'CLOSED') return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {status: 'CLOSED', closedAt: new Date(), snoozedUntil: null}});
  await threadEvent(db, t.id, {type: 'closed', reason: opts.reason ?? 'manual'}, who.actor?.id);
  await emit(db, 'conversation.closed', {recordId: t.id, actorId: who.actor?.id, data: eventData(t, {reason: opts.reason ?? 'manual'})});
  await audit(db, who.c, {action: 'conversation.closed', entity: 'conversation', recordId: t.id, label: auditLabel(t), meta: {reason: opts.reason ?? 'manual'}});
  // Chat & co. keep one timeline entry per conversation: it now shows the summary.
  if (isMessageChannel(t.channel)) await refreshChannelActivity(db, t.id);
  return t;
}

export async function reopenConversation(db: Db, before: EmailThread, who: Who, opts: {reason?: 'manual' | 'reply'} = {}) {
  if (before.status === 'OPEN') return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {status: 'OPEN', closedAt: null}});
  await threadEvent(db, t.id, {type: 'reopened', reason: opts.reason ?? 'manual'}, who.actor?.id);
  await emit(db, 'conversation.reopened', {recordId: t.id, actorId: who.actor?.id, data: eventData(t, {reason: opts.reason ?? 'manual'})});
  if (opts.reason !== 'reply') await audit(db, who.c, {action: 'conversation.reopened', entity: 'conversation', recordId: t.id, label: auditLabel(t)});
  if (isMessageChannel(t.channel)) await refreshChannelActivity(db, t.id);
  return t;
}

/** Leaves the open views until `until`; the `inbox.wake` job (and the job runner's tick) bring it back. */
export async function snoozeConversation(db: Db, before: EmailThread, until: Date, who: Who) {
  if (until.getTime() <= Date.now() + 30_000) throw new HTTPException(400, {message: 'Pick a time in the future'});
  const open = before.status === 'CLOSED' ? await reopenConversation(db, before, who) : before;
  const t = await db.emailThread.update({where: {id: open.id}, data: {snoozedUntil: until}});
  await threadEvent(db, t.id, {type: 'snoozed', until: until.toISOString()}, who.actor?.id);
  await enqueue(db, 'inbox.wake', {threadId: t.id, until: until.toISOString()}, {runAt: until});
  return t;
}

export async function unsnoozeConversation(db: Db, before: EmailThread, who: Who) {
  if (!before.snoozedUntil) return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {snoozedUntil: null}});
  await threadEvent(db, t.id, {type: 'unsnoozed'}, who.actor?.id);
  return t;
}

/** Job "inbox.wake": a snoozed conversation is due. Safe to run twice (a woken one has no snoozedUntil). */
export async function wakeConversation(db: Db, threadId: string) {
  const t = await db.emailThread.findUnique({where: {id: threadId}});
  if (!t?.snoozedUntil || t.snoozedUntil.getTime() > Date.now() + 1000) return;
  const woke = await db.emailThread.updateMany({where: {id: t.id, snoozedUntil: t.snoozedUntil}, data: {snoozedUntil: null, unread: true}});
  if (!woke.count) return;
  await threadEvent(db, t.id, {type: 'woke'});
  if (t.assigneeId) await notify(db, [t.assigneeId], {type: 'activity', title: `Snoozed conversation is back: ${t.subject}`, link: conversationLink(t.id)});
}

export async function setRead(db: Db, ids: string[], read: boolean) {
  await db.emailThread.updateMany({where: {id: {in: ids}}, data: {unread: !read}});
}

/**
 * Spam, optionally blocking the sender's address or domain so their next mail
 * skips the inbox, or (chat) the visitor, whose next messages go to Spam too.
 */
export async function markSpam(db: Db, before: EmailThread, who: Who, block: BlockKind | null = null) {
  const t = before.spamAt ? before : await db.emailThread.update({where: {id: before.id}, data: {spamAt: new Date(), snoozedUntil: null}});
  let blocked: string | null = null;
  if (block === 'visitor') {
    const identity = t.identityId ? await db.channelIdentity.findUnique({where: {id: t.identityId}}) : null;
    if (identity) {
      await db.channelIdentity.update({where: {id: identity.id}, data: {blockedAt: identity.blockedAt ?? new Date()}});
      blocked = identity.name || identity.email || 'this visitor';
    }
  } else if (block) {
    const last = await db.emailMessage.findFirst({where: {threadId: t.id, direction: 'INBOUND'}, orderBy: {sentAt: 'desc'}, select: {fromEmail: true}});
    const identity = !last && t.identityId ? await db.channelIdentity.findUnique({where: {id: t.identityId}, select: {email: true}}) : null;
    const from = (last?.fromEmail ?? identity?.email)?.toLowerCase();
    if (from?.includes('@')) {
      const s = await getInboxSettings(db);
      if (block === 'address' && !s.blockedAddresses.includes(from)) await saveInboxSettings(db, {blockedAddresses: [...s.blockedAddresses, from]});
      if (block === 'domain' && !s.blockedDomains.includes(domainOf(from))) await saveInboxSettings(db, {blockedDomains: [...s.blockedDomains, domainOf(from)]});
      blocked = block === 'address' ? from : domainOf(from);
    }
  }
  if (!before.spamAt) await threadEvent(db, t.id, {type: 'spam', blocked}, who.actor?.id);
  await audit(db, who.c, {action: 'conversation.spam', entity: 'conversation', recordId: t.id, label: auditLabel(t), meta: blocked ? {blocked, block} : {}});
  return t;
}

export async function notSpam(db: Db, before: EmailThread, who: Who) {
  if (!before.spamAt) return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {spamAt: null}});
  if (t.identityId) await db.channelIdentity.updateMany({where: {id: t.identityId, blockedAt: {not: null}}, data: {blockedAt: null}});
  await threadEvent(db, t.id, {type: 'not_spam'}, who.actor?.id);
  await audit(db, who.c, {action: 'conversation.not_spam', entity: 'conversation', recordId: t.id, label: auditLabel(t)});
  return t;
}

export async function trashConversation(db: Db, before: EmailThread, who: Who) {
  if (before.trashedAt) return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {trashedAt: new Date(), snoozedUntil: null}});
  await threadEvent(db, t.id, {type: 'trashed'}, who.actor?.id);
  await audit(db, who.c, {action: 'conversation.trashed', entity: 'conversation', recordId: t.id, label: auditLabel(t)});
  return t;
}

export async function restoreConversation(db: Db, before: EmailThread, who: Who) {
  if (!before.trashedAt) return before;
  const t = await db.emailThread.update({where: {id: before.id}, data: {trashedAt: null}});
  await threadEvent(db, t.id, {type: 'restored'}, who.actor?.id);
  await audit(db, who.c, {action: 'conversation.restored', entity: 'conversation', recordId: t.id, label: auditLabel(t), meta: {from: 'trash'}});
  return t;
}

/**
 * "Delete forever" from Trash: the conversation (messages, tracking, comments)
 * moves to the recycle bin, where admins can still restore it for 30 days.
 */
export async function deleteConversations(db: Db, threads: EmailThread[], who: Who) {
  if (!threads.length) return [];
  const bins = await moveToBin(db, 'conversation', threads.map((t) => t.id), who.actor);
  for (const t of threads) {
    await audit(db, who.c, {action: 'conversation.deleted', entity: 'conversation', recordId: t.id, label: auditLabel(t), meta: {channel: t.channel, trashedAt: t.trashedAt}});
  }
  return bins;
}

// ─── Job runner tick ────────────────────────────────────────────────────────

/**
 * Runs from /jobs/run: wakes snoozed conversations whose time passed (the
 * `inbox.wake` job normally does it), auto-closes team conversations without
 * a reply for N days (Settings → Inbox), and moves conversations trashed more
 * than 30 days ago to the recycle bin.
 */
/** Per pass and per loop: the rest waits for the next minute (oldest first, so nothing starves). */
const TICK_CAP = 25;

/**
 * The every-minute inbox step (lib/ticks.ts): snoozed conversations wake, quiet ones auto-close,
 * 30-day-old Trash goes to the recycle bin. `until` (ms since 1970) is the tick's shared deadline:
 * each loop stops once it has passed, so one slow step never eats the minute.
 */
export async function inboxTick(db: Db, opts: {until?: number} = {}) {
  const now = new Date();
  const late = () => opts.until !== undefined && Date.now() > opts.until;
  const due = await db.emailThread.findMany({where: {snoozedUntil: {lte: now}}, orderBy: {snoozedUntil: 'asc'}, select: {id: true}, take: TICK_CAP});
  let woke = 0;
  for (const t of due) {
    if (late()) break;
    await wakeConversation(db, t.id);
    woke++;
  }

  const ctx = await inboxContext(db);
  let closed = 0;
  const days = ctx.settings.autoCloseDays;
  if (days && days > 0 && !late()) {
    const stale = await db.emailThread.findMany({
      where: {
        status: 'OPEN',
        firstInboundAt: {not: null},
        waitingSince: null, // nothing from the contact waits for an answer
        snoozedUntil: null,
        spamAt: null,
        trashedAt: null,
        lastMessageAt: {lt: new Date(now.getTime() - days * 86_400_000)},
        OR: [{channel: 'email', accountId: {in: ctx.teamAccountIds}}, {channel: {in: ['form', ...MESSAGE_CHANNELS]}}],
      },
      orderBy: {lastMessageAt: 'asc'},
      take: TICK_CAP,
    });
    for (const t of stale) {
      if (late()) break;
      await closeConversation(db, t, SYSTEM, {reason: 'auto'});
      closed++;
    }
  }

  const expired = late() ? [] : await db.emailThread.findMany({where: {trashedAt: {lt: new Date(now.getTime() - TRASH_DAYS * 86_400_000)}}, orderBy: {trashedAt: 'asc'}, take: TICK_CAP});
  if (expired.length) await deleteConversations(db, expired, SYSTEM);
  if (woke || closed || expired.length) kickJobs();
  return {woke, closed, purged: expired.length};
}
