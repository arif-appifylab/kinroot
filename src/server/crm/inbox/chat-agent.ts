import type {ChannelIdentity, ChannelMessage, EmailThread, Prisma} from '../../../generated/prisma/client';
import {tzLocation} from '@/lib/chat';
import type {Db} from '../kit/db';
import {userSelect} from '../lib/users';
import {filesFor, identityLabel} from './channel-messages';
import {getChatSettings, type VisitorData} from './chat';

/**
 * The agent's side of a chat (or any message channel) in the inbox detail:
 * its messages with attachments, the visitor (current page, pages, location
 * from the time zone, first seen, UTM), presence and typing. Opening it marks
 * the visitor's messages as read (the visitor sees "Seen").
 */
export async function chatDetail(db: Db, t: EmailThread) {
  const [messages, identity, s, conversations] = await Promise.all([
    db.channelMessage.findMany({where: {threadId: t.id}, orderBy: {createdAt: 'asc'}, include: {sender: {select: userSelect}}, take: 1000}),
    t.identityId ? db.channelIdentity.findUnique({where: {id: t.identityId}}) : null,
    getChatSettings(db),
    t.identityId ? db.emailThread.count({where: {identityId: t.identityId}}) : 0,
  ]);
  const [files] = await Promise.all([filesFor(db, messages), markSeenByTeam(db, messages)]);
  const data = (identity?.data ?? {}) as VisitorData;
  const now = Date.now();
  return {
    messages: messages.map((m) => agentMessage(m, files)),
    visitor: identity
      ? {
          id: identity.id,
          label: identityLabel(identity),
          name: identity.name,
          email: identity.email,
          blocked: !!identity.blockedAt,
          firstSeenAt: identity.firstSeenAt.toISOString(),
          ...visitorPresence(identity, s.awayAfterMin, now),
          page: data.page ?? null,
          title: data.title ?? null,
          referrer: data.referrer ?? null,
          utm: data.utm ?? {},
          timeZone: data.timeZone ?? null,
          location: tzLocation(data.timeZone),
          userAgent: data.userAgent ?? null,
          pages: data.pages ?? [],
          conversations,
        }
      : null,
    typing: !!t.contactTypingAt && now - t.contactTypingAt.getTime() < 8000,
    awayAfterMin: s.awayAfterMin,
  };
}

type AgentRow = ChannelMessage & {sender: Prisma.MemberGetPayload<{select: typeof userSelect}> | null};

/** One chat message as the inbox shows it (the detail and its `/updates`). */
export function agentMessage(m: AgentRow, files: Awaited<ReturnType<typeof filesFor>>) {
  return {
    id: m.id,
    direction: m.direction,
    kind: m.kind as 'text' | 'auto',
    status: m.status,
    text: m.text,
    files: m.fileIds.map((id) => files.get(id)).filter((f) => !!f).map((f) => ({...f, url: `/site-api/crm/files/${f.id}`})),
    sender: m.sender,
    createdAt: m.createdAt.toISOString(),
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
    emailed: !!m.emailMessageId && m.emailMessageId !== 'sending',
    emailMessageId: m.emailMessageId,
  };
}

/** Where the visitor is: on the site now, last seen, gone long enough that replies are emailed. */
export function visitorPresence(identity: Pick<ChannelIdentity, 'lastSeenAt'>, awayAfterMin: number, now = Date.now()) {
  return {
    lastSeenAt: identity.lastSeenAt.toISOString(),
    /** On the site right now (the widget polls at least every minute while the page is open). */
    online: now - identity.lastSeenAt.getTime() < 75_000,
    /** Gone long enough that replies are emailed. */
    away: now - identity.lastSeenAt.getTime() >= awayAfterMin * 60_000,
  };
}

/** An agent has the conversation open: the visitor's messages count as read (they see "Seen"). Writes only when some weren't. */
export async function markSeenByTeam(db: Db, messages: Pick<ChannelMessage, 'id' | 'direction' | 'readAt'>[]) {
  const unread = messages.filter((m) => m.direction === 'INBOUND' && !m.readAt).map((m) => m.id);
  if (unread.length) await db.channelMessage.updateMany({where: {id: {in: unread}}, data: {readAt: new Date(), status: 'READ'}});
}

export type ChatDetail = Awaited<ReturnType<typeof chatDetail>>;
