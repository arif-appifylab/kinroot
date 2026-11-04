import type {ChannelIdentity, ChannelMessage, EmailThread, Prisma} from '../../../generated/prisma/client';
import {INBOX_CHANNELS, type InboxChannel} from '@/lib/inbox';
import {INLINE_IMAGES} from '@/lib/chat';
import type {Db} from '../kit/db';
import {logActivity} from '../lib/activity';
import {notify} from '../lib/notify';
import {conversationLink} from './conversations';
import {onInbound, onOutbound} from './routing';
import type {InboxContext} from './settings';
import {strings} from '../lib/json-list';

/**
 * The message model of every inbox channel that is not email (website chat
 * now, other channels later): a conversation is still an EmailThread (channel
 * "chat", …), each message is a `ChannelMessage` (plain text,
 * attachments as File ids, delivery status, sender identity) and the person
 * on the other side is a `ChannelIdentity`. Email keeps EmailMessage.
 *
 * - `receiveChannelMessage()` stores a message from outside and runs the
 *   inbox routing (`onInbound()`: open / reopen, spam, assignment,
 *   conversation.created) and the assignee notification;
 * - `sendChannelMessage()` stores a team message (or an automatic notice) and
 *   marks the conversation answered (`onOutbound()`); the channel's own code
 *   delivers it (chat: the visitor polls; a provider channel: its API);
 * - `refreshChannelActivity()` keeps the one timeline entry per conversation;
 * - `linkChannelContact()` links the conversation, its identity and messages
 *   to a contact.
 */

const channelLabel = (channel: string) => INBOX_CHANNELS[channel as InboxChannel]?.label ?? channel;

/** How the team sees someone who has not given a name: "Visitor 7F3A". */
export const identityLabel = (i: Pick<ChannelIdentity, 'id' | 'name' | 'email'>) => i.name || i.email || `Visitor ${i.id.slice(-4).toUpperCase()}`;

/** A sender address for the inbox routing (blocked senders); identities without an email have none. */
const fromAddress = (i: Pick<ChannelIdentity, 'email'>) => i.email ?? '';

export type ReceiveInput = {text: string; fileIds?: string[]; data?: Prisma.InputJsonObject; externalId?: string | null; at?: Date};

/** The row of a message from outside (`receiveChannelMessage` writes it; a caller may write it first, in its own transaction). */
export const inboundMessageData = (
  thread: Pick<EmailThread, 'id' | 'channel' | 'contactId'>,
  identity: Pick<ChannelIdentity, 'id' | 'contactId'>,
  input: ReceiveInput,
  at: Date,
) =>
  ({
    threadId: thread.id,
    channel: thread.channel,
    direction: 'INBOUND',
    status: 'RECEIVED',
    text: input.text,
    fileIds: input.fileIds ?? [],
    identityId: identity.id,
    contactId: identity.contactId ?? thread.contactId,
    externalId: input.externalId ?? null,
    data: input.data ?? {},
    createdAt: at,
  }) satisfies Prisma.ChannelMessageUncheckedCreateInput;

/** `stored`: the message is already saved (a website chat's first message, written with its conversation); only the rest runs. */
export async function receiveChannelMessage(db: Db, thread: EmailThread, identity: ChannelIdentity, input: ReceiveInput, ctx?: InboxContext, stored?: ChannelMessage) {
  const at = stored?.createdAt ?? input.at ?? new Date();
  const waiting = !!thread.waitingSince; // a reply nobody answered yet: the assignee already knows
  const message = stored ?? (await db.channelMessage.create({data: inboundMessageData(thread, identity, input, at)}));
  const updated = await db.emailThread.update({where: {id: thread.id}, data: {lastMessageAt: at, unread: true, contactTypingAt: null}});
  const routed = await onInbound(db, updated, {fromEmail: fromAddress(identity), sentAt: at, blocked: !!identity.blockedAt}, ctx);
  // The assignee hears about a new turn in the conversation (not every line typed while they are answering).
  if (!routed.isNew && !routed.spam && !waiting && routed.thread.assigneeId) {
    await notify(db, [routed.thread.assigneeId], {
      type: 'chat',
      title: `${identityLabel(identity)} wrote in ${channelLabel(thread.channel).toLowerCase()}`,
      body: input.text.slice(0, 300) || (input.fileIds?.length ? 'Sent a file' : null),
      link: conversationLink(thread.id),
    });
  }
  return {message, thread: routed.thread, isNew: routed.isNew, spam: routed.spam};
}

export type SendInput = {text: string; fileIds?: string[]; senderId: string | null; kind?: 'text' | 'auto'; data?: Prisma.InputJsonObject; status?: 'QUEUED' | 'SENT'};

/** A team message (kind "text") or an automatic notice (kind "auto", which doesn't count as an answer). */
export async function sendChannelMessage(db: Db, thread: EmailThread, input: SendInput) {
  const at = new Date();
  const kind = input.kind ?? 'text';
  const message = await db.channelMessage.create({
    data: {
      threadId: thread.id,
      channel: thread.channel,
      direction: 'OUTBOUND',
      kind,
      status: input.status ?? 'SENT',
      text: input.text,
      fileIds: input.fileIds ?? [],
      senderId: input.senderId,
      contactId: thread.contactId,
      data: input.data ?? {},
      createdAt: at,
    },
  });
  await db.emailThread.update({where: {id: thread.id}, data: {lastMessageAt: at, ...(kind === 'text' ? {teamTypingAt: null} : {})}});
  if (kind === 'text') await onOutbound(db, thread.id, at); // answered, first response time
  return message;
}

export type FileMeta = {id: string; name: string; size: number; mimeType: string; image: boolean};

/** File details for messages (attachments never render inline unless they are raster images). */
export async function filesFor(db: Db, messages: Pick<ChannelMessage, 'fileIds'>[]) {
  const ids = [...new Set(messages.flatMap((m) => strings(m.fileIds)))];
  const rows = ids.length ? await db.file.findMany({where: {id: {in: ids}, purpose: {not: 'trash'}}, select: {id: true, name: true, size: true, mimeType: true}}) : [];
  return new Map<string, FileMeta>(rows.map((f) => [f.id, {...f, image: INLINE_IMAGES.includes(f.mimeType)}]));
}

/** Last message per thread, for the conversation list. */
export async function lastChannelMessages(db: Db, threadIds: string[]) {
  if (!threadIds.length) return new Map<string, ChannelMessage>();
  const rows = await db.channelMessage.findMany({where: {threadId: {in: threadIds}}, orderBy: {createdAt: 'desc'}, distinct: ['threadId']});
  return new Map(rows.map((m) => [m.threadId, m]));
}

const excerpt = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * One timeline entry per conversation (not one per message): created when it
 * starts, updated with a short summary when it closes or reopens. Without a
 * contact the entry waits unlinked; `linkChannelContact()` adopts it.
 */
export async function refreshChannelActivity(db: Db, threadId: string) {
  const t = await db.emailThread.findUnique({where: {id: threadId}});
  if (!t || t.channel === 'email') return;
  const type = `${t.channel}_conversation`;
  const [messages, first, last] = await Promise.all([
    db.channelMessage.groupBy({by: ['direction'], where: {threadId, kind: 'text'}, _count: {_all: true}}),
    db.channelMessage.findFirst({where: {threadId, direction: 'INBOUND'}, orderBy: {createdAt: 'asc'}, select: {text: true, data: true}}),
    db.channelMessage.findFirst({where: {threadId, kind: 'text'}, orderBy: {createdAt: 'desc'}, select: {text: true, direction: true}}),
  ]);
  const count = (d: 'INBOUND' | 'OUTBOUND') => messages.find((m) => m.direction === d)?._count._all ?? 0;
  const label = channelLabel(t.channel);
  const closed = t.status === 'CLOSED';
  const total = count('INBOUND') + count('OUTBOUND');
  const title = closed ? `${label} closed · ${total} message${total === 1 ? '' : 's'}: ${excerpt(t.subject, 80)}` : `${label} started: ${excerpt(first?.text || t.subject, 80)}`;
  const data = {
    threadId,
    channel: t.channel,
    status: t.status,
    fromContact: count('INBOUND'),
    fromTeam: count('OUTBOUND'),
    first: excerpt(first?.text ?? ''),
    last: last ? excerpt(last.text) : null,
    lastFrom: last?.direction === 'OUTBOUND' ? 'team' : 'contact',
    page: ((first?.data ?? {}) as {page?: string}).page ?? null,
    startedAt: (t.firstInboundAt ?? t.createdAt).toISOString(),
    closedAt: closed ? (t.closedAt?.toISOString() ?? null) : null,
  } satisfies Prisma.InputJsonObject;
  const text = `${t.subject}\n${first?.text ?? ''}\n${last?.text ?? ''}`.slice(0, 5000);
  const existing = await db.activity.findFirst({where: {type, refId: threadId}, select: {id: true}});
  if (existing) {
    await db.activity.update({where: {id: existing.id}, data: {title: title.slice(0, 300), data, text, contactId: t.contactId, companyId: t.companyId, dealId: t.dealId}});
    return;
  }
  await logActivity(db, {type, title: title.slice(0, 300), refId: threadId, contactId: t.contactId, companyId: t.companyId, dealId: t.dealId, data, text, at: t.firstInboundAt ?? t.createdAt});
}

/** Links the conversation, its identity, its messages and its timeline entry to a contact. */
export async function linkChannelContact(db: Db, thread: EmailThread, contactId: string) {
  const primary = await db.contactCompany.findFirst({where: {contactId}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}});
  const t = await db.emailThread.update({where: {id: thread.id}, data: {contactId, companyId: thread.companyId ?? primary?.companyId ?? null}});
  if (t.identityId) await db.channelIdentity.updateMany({where: {id: t.identityId, contactId: null}, data: {contactId}});
  await db.channelMessage.updateMany({where: {threadId: t.id, contactId: null}, data: {contactId}});
  await db.activity.updateMany({where: {refId: t.id, type: `${t.channel}_conversation`}, data: {contactId, companyId: t.companyId}});
  return t;
}
