/**
 * Broadcasts: one email to everyone in a list or segment (no follow-ups).
 *
 *   resolveAudience(db, list, scope)   who would get it, and who is left out
 *   startBroadcast        job "broadcast.start" at the scheduled time: freezes the recipients
 *   sendBroadcastBatch    job "broadcast.batch": BATCH emails through sendEmail(), then queues the next
 *   cancelBroadcast       stops a scheduled or sending broadcast
 *   broadcastStats        sent / failed / opened / clicked / unsubscribed per broadcast
 *
 * Every email goes through `sendEmail()` (branded layout with the unsubscribe
 * link, tracking, inbox thread, timeline entry, email.sent), so a broadcast is
 * just many normal sends. Members only reach contacts they can see: the
 * creator's `userScope()` is applied when the recipients are resolved.
 */
import {HTTPException} from 'hono/http-exception';

import type {Broadcast, ContactList, Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {sendEmail} from '../email/service';
import {emit} from './events';
import {userScope} from './http';
import {enqueue} from './jobs';
import {notify} from './notify';
import {listContactWhere} from './segments';

/** Emails per job run; small so one run stays well inside a Worker's time budget. */
export const BATCH = 25;
/** A list bigger than this needs splitting (or a dedicated newsletter tool). */
export const MAX_RECIPIENTS = 20_000;
/** Delivery errors in a row before the broadcast pauses (the account is probably down). */
const MAX_FAILURES_IN_A_ROW = 5;
const PAUSE_MS = 15 * 60_000;
const DAY = 86_400_000;
const PAGE = 5000;

export type Audience = {
  /** contacts in the list the user may see */
  contacts: number;
  noEmail: number;
  optedOut: number;
  duplicates: number;
  /** one per address, the first contact (oldest) wins */
  recipients: {email: string; contactId: string}[];
};

const usable = (email: string | null): email is string => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/**
 * Who a broadcast to this list reaches: every visible member with an email
 * address, minus opted-out addresses (any contact with that address opted out,
 * the same rule sendEmail() applies) and duplicate addresses.
 */
export async function resolveAudience(db: Db, list: Pick<ContactList, 'id' | 'kind' | 'rules'>, scope: {ownerId?: string}): Promise<Audience> {
  const where: Prisma.ContactWhereInput = {AND: [await listContactWhere(db, list)], ...scope};
  const out: Audience = {contacts: 0, noEmail: 0, optedOut: 0, duplicates: 0, recipients: []};
  const candidates = new Map<string, string>(); // email → contactId
  let duplicates = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.contact.findMany({
      where,
      select: {id: true, email: true, emailOptOut: true},
      orderBy: [{createdAt: 'asc'}, {id: 'asc'}],
      take: PAGE,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });
    for (const r of rows) {
      out.contacts++;
      if (!usable(r.email)) out.noEmail++;
      else if (r.emailOptOut) out.optedOut++;
      else {
        const email = r.email.trim().toLowerCase();
        if (candidates.has(email)) duplicates++;
        else candidates.set(email, r.id);
      }
    }
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1]!.id;
  }
  // An address is out when any contact with it opted out (also outside the list).
  const blocked = new Set<string>();
  const emails = [...candidates.keys()];
  for (let i = 0; i < emails.length; i += PAGE) {
    const rows = await db.contact.findMany({where: {email: {in: emails.slice(i, i + PAGE), mode: 'insensitive'}, emailOptOut: true}, select: {email: true}});
    for (const r of rows) blocked.add(r.email!.toLowerCase());
  }
  for (const [email, contactId] of candidates) {
    if (blocked.has(email)) out.optedOut++;
    else out.recipients.push({email, contactId});
  }
  out.duplicates = duplicates;
  return out;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

async function stop(db: Db, id: string, error: string) {
  await db.broadcast.updateMany({where: {id, status: {in: ['SCHEDULED', 'SENDING']}}, data: {status: 'CANCELED', canceledAt: new Date(), error}});
  await db.broadcastRecipient.updateMany({where: {broadcastId: id, status: 'PENDING'}, data: {status: 'CANCELED'}});
}

/** "broadcast.start": at the scheduled time, freeze the recipients and start sending. Safe to run twice. */
export async function startBroadcast(db: Db, p: {broadcastId?: unknown}) {
  const b = await db.broadcast.findUnique({where: {id: String(p.broadcastId)}, include: {list: true, createdBy: true}});
  if (!b || b.status !== 'SCHEDULED') return;
  if (!b.list) return stop(db, b.id, 'The list was deleted before sending started');
  if (!b.createdBy?.active) return stop(db, b.id, 'The person who scheduled it no longer has access');

  const audience = await resolveAudience(db, b.list, await userScope(db, b.createdBy));
  if (audience.recipients.length > MAX_RECIPIENTS) return stop(db, b.id, `More than ${MAX_RECIPIENTS.toLocaleString('en-US')} recipients`);
  for (let i = 0; i < audience.recipients.length; i += 1000) {
    await db.broadcastRecipient.createMany({data: audience.recipients.slice(i, i + 1000).map((r) => ({broadcastId: b.id, ...r})), skipDuplicates: true});
  }
  const {noEmail, optedOut, duplicates} = audience;
  const started = await db.broadcast.updateMany({
    where: {id: b.id, status: 'SCHEDULED'}, // canceled in the meantime: leave it
    data: {status: 'SENDING', startedAt: new Date(), total: audience.recipients.length, excluded: {noEmail, optedOut, duplicates}},
  });
  if (!started.count) {
    await db.broadcastRecipient.updateMany({where: {broadcastId: b.id, status: 'PENDING'}, data: {status: 'CANCELED'}});
    return;
  }
  await enqueue(db, 'broadcast.batch', {broadcastId: b.id});
}

/** When `slots` sends fit into the account's rolling 24-hour window again. */
async function nextSlot(db: Db, accountId: string, limit: number, sentInWindow: number, slots: number) {
  const since = new Date(Date.now() - DAY);
  const [oldest] = await db.emailMessage.findMany({
    where: {accountId, direction: 'OUTBOUND', sentAt: {gte: since}},
    orderBy: {sentAt: 'asc'},
    skip: Math.max(0, sentInWindow - limit + slots - 1),
    take: 1,
    select: {sentAt: true},
  });
  return new Date((oldest?.sentAt.getTime() ?? Date.now()) + DAY + 60_000);
}

/** "broadcast.batch": sends the next BATCH emails (fewer when the daily limit is near), then queues the next batch. */
export async function sendBroadcastBatch(db: Db, p: {broadcastId?: unknown}) {
  const id = String(p.broadcastId);
  const b = await db.broadcast.findUnique({where: {id}, include: {account: true, createdBy: true}});
  if (!b || b.status !== 'SENDING') return;

  // A send cut off mid-way (Worker limit, deploy) may have gone out: never retried, to avoid a duplicate.
  await db.broadcastRecipient.updateMany({
    where: {broadcastId: id, status: 'SENDING', updatedAt: {lt: new Date(Date.now() - 10 * 60_000)}},
    data: {status: 'FAILED', error: 'Interrupted while sending (not retried to avoid a duplicate)'},
  });

  const pending = await db.broadcastRecipient.count({where: {broadcastId: id, status: 'PENDING'}});
  if (!pending) return finishBroadcast(db, b);
  const problem = !b.account ? 'The sending account was removed' : !b.createdBy?.active ? 'The person who scheduled it no longer has access' : null;
  if (problem) {
    await db.broadcastRecipient.updateMany({where: {broadcastId: id, status: 'PENDING'}, data: {status: 'FAILED', error: problem}});
    await db.broadcast.update({where: {id}, data: {error: problem}});
    return finishBroadcast(db, b);
  }
  const account = b.account!;
  const sender = b.createdBy!;

  // Daily limit: the same rolling 24 hours sendEmail() checks. Full → continue when there is room again.
  const sentInWindow = await db.emailMessage.count({where: {accountId: account.id, direction: 'OUTBOUND', sentAt: {gte: new Date(Date.now() - DAY)}}});
  const room = account.dailyLimit - sentInWindow;
  if (room <= 0) {
    const at = await nextSlot(db, account.id, account.dailyLimit, sentInWindow, Math.min(BATCH, pending, account.dailyLimit));
    await db.broadcast.update({where: {id}, data: {waitingUntil: at}});
    await enqueue(db, 'broadcast.batch', {broadcastId: id}, {runAt: at});
    return;
  }
  if (b.waitingUntil || b.error) await db.broadcast.update({where: {id}, data: {waitingUntil: null, error: null}});

  const batch = await db.broadcastRecipient.findMany({where: {broadcastId: id, status: 'PENDING'}, orderBy: [{createdAt: 'asc'}, {id: 'asc'}], take: Math.min(BATCH, room)});
  let failedInARow = 0;
  let lastError = '';
  for (const r of batch) {
    // Claim the row; a cancel (PENDING → CANCELED) or a parallel run makes this a no-op.
    const claimed = await db.broadcastRecipient.updateMany({where: {id: r.id, status: 'PENDING'}, data: {status: 'SENDING'}});
    if (!claimed.count) continue;
    const optedOut = await db.contact.count({where: {email: {equals: r.email, mode: 'insensitive'}, emailOptOut: true}});
    if (optedOut) {
      await db.broadcastRecipient.update({where: {id: r.id}, data: {status: 'SKIPPED', error: 'Unsubscribed before it was sent'}});
      continue;
    }
    const contact = r.contactId ? await db.contact.findUnique({where: {id: r.contactId}, select: {id: true}}) : null;
    try {
      const message = await sendEmail(db, sender, b.origin, {
        accountId: account.id,
        to: [r.email],
        subject: b.subject,
        html: b.html,
        preheader: b.preheader,
        layout: 'branded', // always: the branded footer carries the unsubscribe link
        contactId: contact?.id ?? null,
      });
      await db.broadcastRecipient.update({where: {id: r.id}, data: {status: 'SENT', messageId: message?.id, sentAt: new Date(), error: null}});
      failedInARow = 0;
    } catch (e) {
      const status = e instanceof HTTPException ? e.status : 500;
      if (status === 429) {
        // Another send took the last slot: back in the queue, the next run waits for room.
        await db.broadcastRecipient.update({where: {id: r.id}, data: {status: 'PENDING'}});
        break;
      }
      lastError = (e as Error).message.slice(0, 500);
      await db.broadcastRecipient.update({where: {id: r.id}, data: {status: 'FAILED', error: lastError}});
      if (++failedInARow >= MAX_FAILURES_IN_A_ROW) {
        const at = new Date(Date.now() + PAUSE_MS);
        await db.broadcast.update({where: {id}, data: {waitingUntil: at, error: `Paused after ${failedInARow} failed sends in a row: ${lastError}`}});
        await enqueue(db, 'broadcast.batch', {broadcastId: id}, {runAt: at});
        return;
      }
    }
  }
  await enqueue(db, 'broadcast.batch', {broadcastId: id});
}

/** Marks a broadcast sent (once), emits broadcast.sent and tells its creator. */
async function finishBroadcast(db: Db, b: Broadcast) {
  const done = await db.broadcast.updateMany({where: {id: b.id, status: 'SENDING'}, data: {status: 'SENT', finishedAt: new Date(), waitingUntil: null}});
  if (!done.count) return;
  const stats = (await broadcastStats(db, [b.id])).get(b.id) ?? EMPTY_STATS;
  await emit(db, 'broadcast.sent', {
    recordId: b.id,
    actorId: b.createdById,
    data: {id: b.id, subject: b.subject, list: {id: b.listId, name: b.listName}, accountId: b.accountId, total: b.total, sent: stats.sent, failed: stats.failed, skipped: stats.skipped},
  });
  await notify(db, [b.createdById], {
    type: 'activity',
    title: `“${b.subject}” sent to ${stats.sent.toLocaleString('en-US')} ${stats.sent === 1 ? 'contact' : 'contacts'}`,
    body: stats.failed ? `${stats.failed} could not be sent` : null,
    link: b.listId ? `/lists/${b.listId}` : '/lists/broadcasts',
  });
}

/** Stops a broadcast that hasn't finished; emails already sent stay sent. */
export async function cancelBroadcast(db: Db, id: string) {
  const {count} = await db.broadcast.updateMany({where: {id, status: {in: ['SCHEDULED', 'SENDING']}}, data: {status: 'CANCELED', canceledAt: new Date(), waitingUntil: null}});
  if (!count) throw new HTTPException(400, {message: 'Only scheduled or sending broadcasts can be canceled'});
  await db.broadcastRecipient.updateMany({where: {broadcastId: id, status: 'PENDING'}, data: {status: 'CANCELED'}});
}

// ─── Numbers ────────────────────────────────────────────────────────────────

export type BroadcastStats = {sent: number; failed: number; skipped: number; pending: number; canceled: number; opened: number; clicked: number; unsubscribed: number};
const EMPTY_STATS: BroadcastStats = {sent: 0, failed: 0, skipped: 0, pending: 0, canceled: 0, opened: 0, clicked: 0, unsubscribed: 0};
export const emptyStats = () => ({...EMPTY_STATS});

/**
 * Per broadcast: delivery outcome, unique opens / clicks (from the tracked
 * EmailMessage of each send) and unsubscribed (recipients who have opted out
 * since; they were all subscribed when it was sent).
 */
export async function broadcastStats(db: Db, ids: string[]) {
  const out = new Map<string, BroadcastStats>();
  if (!ids.length) return out;
  const rows = await db.$queryRaw<(BroadcastStats & {id: string})[]>`
    SELECT r."broadcastId" AS id,
      COUNT(*) FILTER (WHERE r.status = 'SENT')::int AS sent,
      COUNT(*) FILTER (WHERE r.status = 'FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped,
      COUNT(*) FILTER (WHERE r.status IN ('PENDING', 'SENDING'))::int AS pending,
      COUNT(*) FILTER (WHERE r.status = 'CANCELED')::int AS canceled,
      COUNT(*) FILTER (WHERE r.status = 'SENT' AND m."openCount" > 0)::int AS opened,
      COUNT(*) FILTER (WHERE r.status = 'SENT' AND m."clickCount" > 0)::int AS clicked,
      COUNT(*) FILTER (WHERE r.status = 'SENT' AND c."emailOptOut")::int AS unsubscribed
    FROM "BroadcastRecipient" r
    LEFT JOIN "EmailMessage" m ON m.id = r."messageId"
    LEFT JOIN "Contact" c ON c.id = r."contactId"
    WHERE r."broadcastId" = ANY(${ids}::text[])
    GROUP BY r."broadcastId"`;
  for (const {id, ...s} of rows) out.set(id, s);
  return out;
}
