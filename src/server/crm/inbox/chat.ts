import {HTTPException} from 'hono/http-exception';

import type {ChannelIdentity, EmailThread, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {BRAND} from '@/lib/brand';
import {
  DEFAULT_CHAT_SETTINGS,
  hostAllowed,
  isOpenAt,
  nextOpening,
  ONLINE_MS,
  REPLY_TIMES,
  type ChatSettings,
  type PublicChatConfig,
  type VisitorConversation,
  type VisitorMessage,
} from '@/lib/chat';
import {timeIn} from '@/lib/scheduling';
import {config} from '../kit/config';
import {randomToken, sign, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import {logActivity} from '../lib/activity';
import {associateByDomain} from '../lib/domains';
import {checkDuplicates} from '../lib/duplicates';
import {emit} from '../lib/events';
import {enqueue, kickJobs} from '../lib/jobs';
import {notifyWatchers} from '../lib/notify';
import {getSettings} from '../lib/settings';
import {stripQuoted} from '../lib/ticket-mail';
import {sendEmail} from '../email/service';
import {publicFileUrl} from '../routes/files';
import {filesFor, identityLabel, inboundMessageData, linkChannelContact, receiveChannelMessage, refreshChannelActivity, sendChannelMessage} from './channel-messages';
import {conversationLink, eventData, threadEvent} from './conversations';
import {CHAT_ONLINE_CACHE_KEY, getInboxSettings, hasTeamAccess} from './settings';
import {cache} from '../../../platform/cache';
import {strings} from '../lib/json-list';

/**
 * Website live chat (module 10b). The visitor's browser talks to
 * /site-api/crm/public/chat/* (src/server/routes/chat-public.ts) with a signed
 * visitor token; agents work chats in the inbox (src/server/routes/inbox-chat.ts).
 * Messages are ChannelMessage rows (channel-messages.ts), so this file holds
 * only what is specific to chat: settings, tokens, availability, the visitor
 * session, emailing replies to visitors who left, and transcripts.
 */

const KEY = 'chat';

/** The Site Cache key of the chat settings (docs/agent/cache.md); `saveChatSettings` clears it. */
const CACHE_KEY = 'crm:chat-settings';

/**
 * Read on every visitor poll and every page that loads widget.js, changed rarely: kept in the
 * Site Cache for 10 minutes, cleared the moment Settings → Inbox → Chat saves.
 */
export async function getChatSettings(db: Db): Promise<ChatSettings> {
  return cache.getOrSet(CACHE_KEY, 600, async () => {
    const row = await db.setting.findUnique({where: {key: KEY}});
    const stored = (row?.value ?? {}) as Partial<ChatSettings>;
    return {...DEFAULT_CHAT_SETTINGS, ...stored, hours: {...DEFAULT_CHAT_SETTINGS.hours, ...(stored.hours ?? {})}};
  });
}

export async function saveChatSettings(db: Db, value: ChatSettings) {
  const json = value as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value: json}, update: {value: json}});
  await cache.del(CACHE_KEY);
  return value;
}

/** The shared mailbox chat emails go out from: the chosen one, else the first shared mailbox. */
export async function chatAccount(db: Db, s?: ChatSettings) {
  const settings = s ?? (await getChatSettings(db));
  const chosen = settings.accountId ? await db.emailAccount.findFirst({where: {id: settings.accountId, userId: null}}) : null;
  return chosen ?? (await db.emailAccount.findFirst({where: {userId: null}, orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}]}));
}

// ─── Tokens (Web Crypto HMAC) ───────────────────────────────────────────────

/** Kept in the widget's localStorage (on our origin): `<identityId>.<signature>`. */
export const visitorToken = async (identityId: string) => `${identityId}.${await sign(`chatv:${identityId}`)}`;

/** The identity id a visitor token was signed for (no database read), else null. */
export async function visitorIdFromToken(token: string | null | undefined) {
  const [id, sig] = (token ?? '').split('.');
  return id && sig && (await verifySignature(`chatv:${id}`, sig)) ? id : null;
}

export async function identityFromToken(db: Db, token: string | null | undefined) {
  const id = await visitorIdFromToken(token);
  return id ? db.channelIdentity.findFirst({where: {id, channel: 'chat'}}) : null;
}

/** The link in emails back to a conversation: /chat/c/<threadId>.<identityId>.<expires>.<signature>. */
export async function continueToken(threadId: string, identityId: string, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86_400;
  return `${threadId}.${identityId}.${exp}.${await sign(`chatc:${threadId}:${identityId}:${exp}`)}`;
}

export async function fromContinueToken(token: string) {
  const [threadId, identityId, exp, sig] = token.split('.');
  if (!threadId || !identityId || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  return (await verifySignature(`chatc:${threadId}:${identityId}:${exp}`, sig)) ? {threadId, identityId} : null;
}

/** Uploaded before the message is sent: the file waits as "chat_pending", bound to the visitor. */
export const chatFileToken = (fileId: string, identityId: string) => sign(`chatfile:${fileId}:${identityId}`);

/** Verifies the visitor's upload tokens: the ids of their files still waiting to be sent (nothing claimed). */
export async function pendingFiles(db: Db | Prisma.TransactionClient, identityId: string, files: {id: string; token: string}[]) {
  const ok: string[] = [];
  for (const f of files.slice(0, 5)) {
    if (await verifySignature(`chatfile:${f.id}:${identityId}`, f.token)) ok.push(f.id);
  }
  if (!ok.length) return [];
  const pending = await db.file.findMany({where: {id: {in: ok}, purpose: 'chat_pending'}, select: {id: true}});
  return pending.map((p) => p.id);
}

/** Verifies the visitor's upload tokens and claims those files for the message. */
export async function claimFiles(db: Db | Prisma.TransactionClient, identityId: string, files: {id: string; token: string}[]) {
  const ids = await pendingFiles(db, identityId, files);
  if (ids.length) await db.file.updateMany({where: {id: {in: ids}}, data: {purpose: 'chat'}});
  return ids;
}

// ─── Availability ───────────────────────────────────────────────────────────

/** Team members who could answer now: active, signed in recently, with team-inbox access (and in the round robin when it is on). */
export async function onlineAgents(db: Db) {
  const [settings, users] = await Promise.all([
    getInboxSettings(db),
    db.member.findMany({where: {active: true, role: {not: 'VIEWER'}, lastSeenAt: {gte: new Date(Date.now() - ONLINE_MS)}}, select: {id: true, role: true}}),
  ]);
  return users.filter((u) => hasTeamAccess(u, settings) && (settings.assignment !== 'round_robin' || settings.roundRobinIds.includes(u.id))).map((u) => u.id);
}

/**
 * "Is anyone there?" for every visitor's poll: the same answer for all of them, so it is kept in
 * the Site Cache for a minute (the shortest it keeps anything). Saving the inbox settings and an
 * agent coming back online (the badges' "last seen" stamp) clear it, so it is never long wrong.
 */
const anyAgentOnline = (db: Db) => cache.getOrSet(CHAT_ONLINE_CACHE_KEY, 60, async () => (await onlineAgents(db)).length > 0);

/** An agent who was away is back: visitors should see the team as available on their next poll. */
export const agentCameOnline = () => cache.del(CHAT_ONLINE_CACHE_KEY);

export async function chatAvailability(db: Db, s: ChatSettings, now = Date.now()) {
  if (!isOpenAt(s.hours, now)) {
    const next = nextOpening(s.hours, now);
    return {away: true, reason: 'hours' as const, opensAt: next ? new Date(next).toISOString() : null};
  }
  if (!(await anyAgentOnline(db))) return {away: true, reason: 'nobody' as const, opensAt: null};
  return {away: false, reason: null, opensAt: null};
}

/** Our own pages (the in-app <ChatWidget>, /chat/c/…) are always allowed, whatever the allow-list says. */
export function embedAllowed(s: ChatSettings, hosts: (string | null | undefined)[], ownOrigin: string) {
  const own = new Set([new URL(ownOrigin).hostname, config.siteUrl() ? new URL(config.siteUrl()).hostname : null].filter(Boolean));
  const known = hosts.filter((h): h is string => !!h);
  if (!s.allowedDomains.length) return true;
  if (!known.length) return false;
  return known.every((h) => own.has(h) || hostAllowed(s.allowedDomains, h));
}

export async function publicChatConfig(db: Db, s: ChatSettings, allowed: boolean): Promise<PublicChatConfig> {
  const [brand, availability, users] = await Promise.all([
    getSettings(db),
    chatAvailability(db, s),
    s.avatarIds.length ? db.member.findMany({where: {id: {in: s.avatarIds}, active: true}, select: {id: true, name: true, color: true, avatarUrl: true}}) : [],
  ]);
  return {
    enabled: s.enabled,
    allowed,
    teamName: s.teamName || brand.brandName || BRAND.name,
    greeting: s.greeting,
    position: s.position,
    color: s.color || brand.brandPrimary || BRAND.primary,
    logo: brand.brandLogo || null,
    avatars: s.avatarIds.map((id) => users.find((u) => u.id === id)).filter((u) => !!u).slice(0, 3).map((u) => ({name: u.name.split(' ')[0]!, color: u.color, avatarUrl: u.avatarUrl})),
    replyTime: REPLY_TIMES[s.replyTime] ?? REPLY_TIMES.minutes,
    preChat: s.preChat,
    askName: s.askName,
    preChatIntro: s.preChatIntro,
    away: availability.away,
    awayReason: availability.reason,
    offlineMessage: s.offlineMessage,
    opensAt: availability.opensAt,
  };
}

// ─── Visitors ───────────────────────────────────────────────────────────────

/** What the widget reports about the page the visitor is on. */
export type VisitorMeta = {
  page?: string | null;
  title?: string | null;
  referrer?: string | null;
  utm?: Record<string, string>;
  timeZone?: string | null;
  userAgent?: string | null;
};

export type VisitorData = {
  page?: string | null;
  title?: string | null;
  referrer?: string | null;
  utm?: Record<string, string>;
  timeZone?: string | null;
  userAgent?: string | null;
  pages?: {url: string; title: string | null; at: string}[];
};

const cleanUrl = (u: string | null | undefined) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
};

/** Records where the visitor is (and has been). Only identified visitors (who chatted) are tracked. */
export async function touchVisitor(db: Db, identity: ChannelIdentity, meta: VisitorMeta, opts: {force?: boolean} = {}) {
  const data = (identity.data ?? {}) as VisitorData;
  const page = cleanUrl(meta.page);
  const pageChanged = !!page && page !== data.page;
  const stale = Date.now() - identity.lastSeenAt.getTime() > 15_000;
  if (!pageChanged && !stale && !opts.force) return identity;
  const next: VisitorData = {...data};
  if (page) next.page = page;
  if (meta.title !== undefined && pageChanged) next.title = meta.title?.slice(0, 200) ?? null;
  if (meta.referrer && !data.referrer) next.referrer = cleanUrl(meta.referrer);
  if (meta.utm && Object.keys(meta.utm).length && !data.utm) next.utm = meta.utm;
  if (meta.timeZone) next.timeZone = meta.timeZone.slice(0, 64);
  if (meta.userAgent) next.userAgent = meta.userAgent.slice(0, 300);
  if (pageChanged) next.pages = [{url: page!, title: meta.title?.slice(0, 200) ?? null, at: new Date().toISOString()}, ...(data.pages ?? [])].slice(0, 20);
  return db.channelIdentity.update({where: {id: identity.id}, data: {lastSeenAt: new Date(), data: next as Prisma.InputJsonObject}});
}

export async function newVisitor(db: Db, meta: VisitorMeta) {
  const identity = await db.channelIdentity.create({data: {channel: 'chat', externalId: randomToken(12)}});
  return touchVisitor(db, identity, meta, {force: true});
}

/** Finds the contact with this email or creates one (source "Chat"), with the usual duplicate checks. */
export async function contactForVisitor(db: Db, email: string, name?: string | null) {
  const address = email.trim().toLowerCase();
  const existing = await db.contact.findFirst({where: {email: {equals: address, mode: 'insensitive'}}, select: {id: true}});
  if (existing) return existing.id;
  const [first, ...rest] = (name?.trim() || address.split('@')[0]!).split(/\s+/);
  const contact = await db.contact.create({
    data: {firstName: (first || address).slice(0, 100), lastName: rest.join(' ').slice(0, 100) || null, email: address, source: 'Chat', lastActivityAt: new Date()},
  });
  await logActivity(db, {type: 'contact_created', title: 'Contact created from a website chat', contactId: contact.id});
  await associateByDomain(db, contact.id).catch(() => null);
  await emit(db, 'contact.created', {recordId: contact.id, data: contact});
  await checkDuplicates(db, 'contact', contact.id);
  return contact.id;
}

/** The visitor told us who they are: remember it, match / create the contact, link their conversations. */
export async function identifyVisitor(db: Db, identity: ChannelIdentity, input: {name?: string | null; email?: string | null}) {
  const name = input.name?.trim().slice(0, 120) || identity.name;
  const email = input.email?.trim().toLowerCase().slice(0, 200) || identity.email;
  const contactId = email ? await contactForVisitor(db, email, name) : identity.contactId;
  const updated = await db.channelIdentity.update({where: {id: identity.id}, data: {name, email, contactId}});
  if (contactId) {
    const threads = await db.emailThread.findMany({where: {identityId: identity.id, contactId: null}});
    for (const t of threads) await linkChannelContact(db, t, contactId);
  }
  return updated;
}

// ─── Conversations ──────────────────────────────────────────────────────────

const excerpt = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Shown once per conversation (and again after 30 minutes) while the team is away. */
async function awayNotice(db: Db, thread: EmailThread, s: ChatSettings, identity: ChannelIdentity) {
  const recent = await db.channelMessage.findFirst({where: {threadId: thread.id, kind: 'auto', createdAt: {gte: new Date(Date.now() - 30 * 60_000)}}, select: {id: true}});
  if (recent) return;
  const ask = identity.email ? `We'll reply to ${identity.email}.` : 'Leave your email below so we can reply.';
  await sendChannelMessage(db, thread, {text: `${s.offlineMessage}\n${ask}`.trim(), senderId: null, kind: 'auto'});
}

/** Where a new conversation goes, read before it is written: the chat mailbox, and the known contact's company and open deal. */
export async function chatPlacement(db: Db, s: ChatSettings, contactId: string | null) {
  const [account, records] = await Promise.all([chatAccount(db, s), contactRecords(db, contactId)]);
  return {accountId: account?.id ?? null, contactId, ...records};
}

/** A conversation's company and deal from its contact: their primary company and latest open deal. */
async function contactRecords(db: Db, contactId: string | null) {
  const [company, deal] = contactId
    ? await Promise.all([
        db.contactCompany.findFirst({where: {contactId}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}),
        db.deal.findFirst({where: {status: 'OPEN', contacts: {some: {contactId}}}, orderBy: {lastActivityAt: 'desc'}, select: {id: true}}),
      ])
    : [null, null];
  return {companyId: company?.companyId ?? null, dealId: deal?.id ?? null};
}

export type OpenChatInput = {
  /** The returning visitor; null makes a new one. */
  identity: Pick<ChannelIdentity, 'id' | 'contactId'> | null;
  text: string;
  /** The visitor's upload tokens: their files are claimed here. */
  files: {id: string; token: string}[];
  page: string | null;
};

/**
 * A website chat's first write, in the caller's transaction (the start's idempotent write): the
 * visitor when new, the conversation, and the first message with its files. Only ids come back;
 * the routing, notices and events follow in `chatOpened`.
 */
export async function openChat(tx: Prisma.TransactionClient, place: Awaited<ReturnType<typeof chatPlacement>>, input: OpenChatInput) {
  const identity = input.identity ?? (await tx.channelIdentity.create({data: {channel: 'chat', externalId: randomToken(12)}, select: {id: true, contactId: true}}));
  // A new visitor has no files: an upload makes the visitor first, and its token is bound to them.
  const fileIds = input.identity ? await claimFiles(tx, identity.id, input.files) : [];
  if (!input.text && !fileIds.length) throw new HTTPException(400, {message: 'Write a message first'});
  const thread = await tx.emailThread.create({
    data: {
      subject: excerpt(input.text, 80) || (fileIds.length ? 'Sent a file' : 'Website chat'),
      channel: 'chat',
      accountId: place.accountId,
      identityId: identity.id,
      contactId: place.contactId,
      companyId: place.companyId,
      dealId: place.dealId,
    },
  });
  const message = await tx.channelMessage.create({
    data: inboundMessageData(thread, identity, {text: input.text, fileIds, data: {page: input.page}}, new Date()),
    select: {id: true},
  });
  return {identityId: identity.id, threadId: thread.id, messageId: message.id};
}

/** A visitor's first message, once saved (`openChat`): routed and assigned like any other conversation, with its notices and events. */
export async function chatOpened(db: Db, s: ChatSettings, opened: {threadId: string; messageId: string}, identity: ChannelIdentity, input: {page: string | null}) {
  let [thread, message] = await Promise.all([
    db.emailThread.findUniqueOrThrow({where: {id: opened.threadId}}),
    db.channelMessage.findUniqueOrThrow({where: {id: opened.messageId}}),
  ]);
  // Who the visitor said they are (the pre-chat answers) is saved after the conversation: it goes
  // to that contact, with their company and open deal, as if they had been known from the start.
  const contactId = identity.contactId;
  if (contactId && (thread.contactId !== contactId || !thread.dealId)) {
    const records = await contactRecords(db, contactId);
    const moved = thread.contactId !== contactId;
    if (moved || records.dealId) {
      thread = await db.emailThread.update({
        where: {id: thread.id},
        data: {contactId, companyId: moved ? records.companyId : (thread.companyId ?? records.companyId), dealId: moved ? records.dealId : (thread.dealId ?? records.dealId)},
      });
      if (message.contactId !== contactId) message = await db.channelMessage.update({where: {id: message.id}, data: {contactId}});
    }
  }
  const text = message.text;
  const received = await receiveChannelMessage(db, thread, identity, {text, fileIds: strings(message.fileIds), data: {page: input.page}}, undefined, message);
  const availability = await chatAvailability(db, s);
  if (availability.away) await awayNotice(db, received.thread, s, identity);
  await refreshChannelActivity(db, thread.id);
  const t = received.thread;
  await emit(db, 'chat.started', {
    recordId: t.id,
    data: eventData(t, {visitor: {name: identity.name, email: identity.email}, page: input.page, away: availability.away, spam: received.spam}),
  });
  if (!received.spam && t.contactId) {
    await notifyWatchers(db, {contactId: t.contactId, dealId: t.dealId}, {type: 'chat', title: (name) => `${name} started a website chat`, body: text.slice(0, 300), link: conversationLink(t.id), except: t.assigneeId ? [t.assigneeId] : []});
  }
  return t;
}

/** A visitor's next message in their conversation. */
export async function visitorMessage(db: Db, s: ChatSettings, thread: EmailThread, identity: ChannelIdentity, input: {text: string; fileIds: string[]; page: string | null}) {
  const received = await receiveChannelMessage(db, thread, identity, {text: input.text, fileIds: input.fileIds, data: {page: input.page}});
  if ((await chatAvailability(db, s)).away) await awayNotice(db, received.thread, s, identity);
  return received.message;
}

/** The visitor's conversation to show: an open one, else the latest of the last 30 days. */
export async function currentConversation(db: Db, identity: ChannelIdentity) {
  return (
    (await db.emailThread.findFirst({where: {identityId: identity.id, channel: 'chat', status: 'OPEN', trashedAt: null}, orderBy: {lastMessageAt: 'desc'}})) ??
    (await db.emailThread.findFirst({where: {identityId: identity.id, channel: 'chat', trashedAt: null, lastMessageAt: {gte: new Date(Date.now() - 30 * 86_400_000)}}, orderBy: {lastMessageAt: 'desc'}}))
  );
}

/**
 * What the visitor sees of a conversation: chat messages (team messages show
 * the agent's first name) and their own email replies. Internal comments,
 * event lines and our outgoing emails are never part of it.
 */
const visitorSender = {select: {name: true, color: true, avatarUrl: true}} as const;
type ViewMessage = Prisma.ChannelMessageGetPayload<{include: {sender: typeof visitorSender}}>;
type ViewEmail = {id: string; text: string | null; sentAt: Date};

/** The latest visitor message the team has read ("Seen" under it in the widget). */
const lastSeenByTeam = (db: Db, threadId: string) =>
  db.channelMessage.findFirst({where: {threadId, direction: 'INBOUND', readAt: {not: null}}, orderBy: {createdAt: 'desc'}, select: {createdAt: true}});

export async function visitorView(db: Db, thread: EmailThread, origin: string, after?: Date | null): Promise<VisitorConversation & {seenUpTo: string | null}> {
  const since = after ? {gt: after} : undefined;
  const [messages, emails, seen] = await Promise.all([
    db.channelMessage.findMany({where: {threadId: thread.id, createdAt: since}, orderBy: {createdAt: 'asc'}, include: {sender: visitorSender}, take: 300}),
    db.emailMessage.findMany({where: {threadId: thread.id, direction: 'INBOUND', sentAt: since}, orderBy: {sentAt: 'asc'}, select: {id: true, text: true, sentAt: true}, take: 100}),
    lastSeenByTeam(db, thread.id),
  ]);
  return toVisitorView(db, thread, origin, messages, emails, seen);
}

/**
 * The widget's poll (`POST /public/chat/poll`), in as few round trips as it can: the conversation
 * (only the visitor's own: `identityId` comes from their signed token), its identity, what is new
 * since `after` and the team messages not yet delivered / read, all in ONE query (nested selects,
 * joined in the database), next to the "seen" marker. Writes only when something changed: typing,
 * and delivered / read for exactly the team messages that weren't yet. Null: no such conversation.
 */
export async function visitorPoll(db: Db, input: {threadId: string; identityId: string; origin: string; after: Date | null; typing?: boolean; visible?: boolean}) {
  const after = input.after;
  const [found, seen] = await Promise.all([
    db.emailThread.findFirst({
      where: {id: input.threadId, identityId: input.identityId, channel: 'chat', trashedAt: null},
      include: {
        identity: true,
        channelMessages: {
          where: after ? {OR: [{createdAt: {gt: after}}, {direction: 'OUTBOUND', OR: [{deliveredAt: null}, {readAt: null}]}]} : {},
          orderBy: {createdAt: 'asc'},
          include: {sender: visitorSender},
          take: 300,
        },
        messages: {where: {direction: 'INBOUND', ...(after ? {sentAt: {gt: after}} : {})}, orderBy: {sentAt: 'asc'}, select: {id: true, text: true, sentAt: true}, take: 100},
      },
    }),
    lastSeenByTeam(db, input.threadId),
  ]);
  if (!found?.identity) return null;
  const {identity, channelMessages: rows, messages: emails, ...thread} = found;

  const now = new Date();
  const writes: Promise<unknown>[] = [];
  const typingChanged = input.typing ? !thread.contactTypingAt || now.getTime() - thread.contactTypingAt.getTime() > 3000 : !!thread.contactTypingAt;
  if (typingChanged) writes.push(db.emailThread.update({where: {id: thread.id}, data: {contactTypingAt: input.typing ? now : null}}));
  const team = rows.filter((m) => m.direction === 'OUTBOUND');
  const undelivered = team.filter((m) => !m.deliveredAt).map((m) => m.id);
  const unread = input.visible ? team.filter((m) => !m.readAt).map((m) => m.id) : [];
  // Delivered first, then read (both only for the ids just seen), as before: the status ends READ.
  if (undelivered.length || unread.length) {
    writes.push(
      (async () => {
        if (undelivered.length) await db.channelMessage.updateMany({where: {id: {in: undelivered}, deliveredAt: null}, data: {deliveredAt: now, status: 'DELIVERED'}});
        if (unread.length) await db.channelMessage.updateMany({where: {id: {in: unread}, readAt: null}, data: {readAt: now, status: 'READ'}});
      })(),
    );
  }
  await Promise.all(writes);
  for (const m of rows) {
    if (undelivered.includes(m.id)) m.deliveredAt = now;
    if (unread.includes(m.id)) m.readAt = now;
  }
  const fresh = after ? rows.filter((m) => m.createdAt > after) : rows;
  return {identity, view: await toVisitorView(db, thread, input.origin, fresh, emails, seen)};
}

async function toVisitorView(db: Db, thread: EmailThread, origin: string, messages: ViewMessage[], emails: ViewEmail[], seen: {createdAt: Date} | null): Promise<VisitorConversation & {seenUpTo: string | null}> {
  const files = await filesFor(db, messages);
  const links = new Map(await Promise.all([...files.keys()].map(async (id) => [id, await publicFileUrl(origin, id, 7)] as const)));
  const list: VisitorMessage[] = [
    ...messages.map((m) => ({
      id: m.id,
      from: m.direction === 'INBOUND' ? ('visitor' as const) : m.kind === 'auto' ? ('system' as const) : ('team' as const),
      author: m.direction === 'OUTBOUND' && m.sender ? {name: m.sender.name.split(' ')[0]!, color: m.sender.color, avatarUrl: m.sender.avatarUrl} : null,
      text: m.text,
      files: strings(m.fileIds).map((id) => files.get(id)).filter((f) => !!f).map((f) => ({...f, url: links.get(f.id)!})),
      at: m.createdAt.toISOString(),
      seen: !!m.readAt,
      via: null,
    })),
    ...emails.map((e) => ({id: e.id, from: 'visitor' as const, author: null, text: stripQuoted(e.text ?? ''), files: [], at: e.sentAt.toISOString(), seen: true, via: 'email' as const})),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    id: thread.id,
    status: thread.status,
    messages: list,
    teamTyping: !!thread.teamTypingAt && Date.now() - thread.teamTypingAt.getTime() < 8000,
    seenUpTo: seen?.createdAt.toISOString() ?? null,
  };
}

// ─── Replies to visitors who left ───────────────────────────────────────────

const neutral = (text: string) => text.replace(/\{\{/g, '{ {'); // visitor text is never a merge field
/** One waiting `chat.email_visitor` job per thread and time: the platform's dedupe key (minutes since 1970). */
const visitorEmailKey = (threadId: string, runAt: Date) => `chat-email-${threadId}-${Math.floor(runAt.getTime() / 60_000)}`;

/**
 * After an agent's reply: when the visitor gave an email and is not around
 * (not seen for `awayAfterMin`), the replies they haven't read are emailed to
 * them by the `chat.email_visitor` job, from the chat mailbox through the
 * normal email pipeline, with a signed link back to the conversation.
 */
export async function queueVisitorEmail(db: Db, thread: EmailThread, origin: string) {
  if (!thread.identityId) return;
  const [s, identity] = await Promise.all([getChatSettings(db), db.channelIdentity.findUnique({where: {id: thread.identityId}})]);
  if (!identity) return;
  const email = identity.email ?? (thread.contactId ? (await db.contact.findUnique({where: {id: thread.contactId}, select: {email: true}}))?.email : null);
  if (!email) return;
  const awayMs = s.awayAfterMin * 60_000;
  const runAt = new Date(Math.max(Date.now(), identity.lastSeenAt.getTime() + awayMs + 1000));
  await enqueue(db, 'chat.email_visitor', {threadId: thread.id, origin}, {runAt, key: visitorEmailKey(thread.id, runAt)});
}

/** Job "chat.email_visitor". Safe to run twice: emailed messages carry `emailMessageId`. */
export async function emailVisitor(db: Db, payload: Record<string, unknown>) {
  const thread = await db.emailThread.findUnique({where: {id: String(payload.threadId)}});
  if (!thread || thread.channel !== 'chat' || thread.spamAt || thread.trashedAt || !thread.identityId) return;
  const origin = String(payload.origin || config.siteUrl());
  const [s, identity, contact] = await Promise.all([
    getChatSettings(db),
    db.channelIdentity.findUnique({where: {id: thread.identityId}}),
    thread.contactId ? db.contact.findUnique({where: {id: thread.contactId}, select: {email: true}}) : null,
  ]);
  const to = identity?.email ?? contact?.email;
  if (!identity || !to) return;
  const pending = await db.channelMessage.findMany({where: {threadId: thread.id, direction: 'OUTBOUND', kind: 'text', readAt: null, emailMessageId: null}, orderBy: {createdAt: 'asc'}, include: {sender: true}});
  if (!pending.length) return;
  const awayMs = s.awayAfterMin * 60_000;
  if (Date.now() - identity.lastSeenAt.getTime() < awayMs) {
    // Still on the site: check again once they have been gone for a while.
    const runAt = new Date(identity.lastSeenAt.getTime() + awayMs + 1000);
    await enqueue(db, 'chat.email_visitor', {threadId: thread.id, origin}, {runAt, key: visitorEmailKey(thread.id, runAt)});
    return;
  }
  const account = (thread.accountId ? await db.emailAccount.findFirst({where: {id: thread.accountId, userId: null}}) : null) ?? (await chatAccount(db, s));
  const sender = [...pending].reverse().find((m) => m.sender?.active)?.sender ?? null;
  if (!account || !sender) {
    await threadEvent(db, thread.id, {type: 'chat_email_failed', reason: account ? 'No active team member to send as' : 'No shared mailbox to send from (Settings → Inbox → Chat)'});
    return;
  }
  const ids = pending.map((m) => m.id);
  // Claim them, so an overlapping run doesn't email the same messages again.
  const claimed = await db.channelMessage.updateMany({where: {id: {in: ids}, emailMessageId: null}, data: {emailMessageId: 'sending'}});
  if (!claimed.count) return;
  const brand = await getSettings(db);
  const teamName = s.teamName || brand.brandName || BRAND.name;
  const link = `${origin}/chat/c/${await continueToken(thread.id, identity.id)}`;
  const files = await filesFor(db, pending);
  const lines = pending.map((m) => {
    const attached = strings(m.fileIds).map((id) => files.get(id)?.name).filter(Boolean);
    return `${m.sender?.name.split(' ')[0] ?? teamName}: ${neutral(m.text)}${attached.length ? `\n(attached: ${attached.join(', ')})` : ''}`;
  });
  const body = `Hi${identity.name ? ` ${neutral(identity.name.split(' ')[0]!)}` : ''},\n\nYou have a new reply to your chat with ${teamName}:\n\n${lines.join('\n\n')}\n\nContinue the conversation: ${link}\nOr simply reply to this email.`;
  try {
    const message = await sendEmail(db, sender, origin, {accountId: account.id, to: [to], subject: `New reply from ${teamName}`, body, layout: 'branded', threadId: thread.id, contactId: thread.contactId, companyId: thread.companyId, dealId: thread.dealId});
    await db.channelMessage.updateMany({where: {id: {in: ids}}, data: {emailMessageId: message?.id ?? null}});
    await threadEvent(db, thread.id, {type: 'chat_emailed', to, count: ids.length});
  } catch (e) {
    await db.channelMessage.updateMany({where: {id: {in: ids}, emailMessageId: 'sending'}, data: {emailMessageId: null}});
    if (e instanceof HTTPException && e.status === 400) {
      await threadEvent(db, thread.id, {type: 'chat_email_failed', reason: e.message});
      return;
    }
    throw e;
  }
}

// ─── Transcript ─────────────────────────────────────────────────────────────

/** "Email transcript": the whole conversation (never internal comments) to the visitor, through sendEmail(). */
export async function sendTranscript(db: Db, me: User, thread: EmailThread, origin: string) {
  const identity = thread.identityId ? await db.channelIdentity.findUnique({where: {id: thread.identityId}}) : null;
  const contact = thread.contactId ? await db.contact.findUnique({where: {id: thread.contactId}, select: {email: true}}) : null;
  const to = identity?.email ?? contact?.email;
  if (!to || !identity) throw new HTTPException(400, {message: 'The visitor has not given an email address'});
  const s = await getChatSettings(db);
  const account = (thread.accountId ? await db.emailAccount.findFirst({where: {id: thread.accountId, userId: null}}) : null) ?? (await chatAccount(db, s));
  if (!account) throw new HTTPException(400, {message: 'Connect a shared mailbox to email transcripts (Settings → Inbox → Chat)'});
  const brand = await getSettings(db);
  const teamName = s.teamName || brand.brandName || BRAND.name;
  const view = await visitorView(db, thread, origin);
  const tz = ((identity.data ?? {}) as VisitorData).timeZone || 'UTC';
  const when = (iso: string) => {
    try {
      return timeIn(iso, tz, {dateStyle: 'medium', timeStyle: 'short'});
    } catch {
      return new Date(iso).toUTCString();
    }
  };
  const lines = view.messages.map((m) => {
    const who = m.from === 'visitor' ? identity.name || 'You' : m.from === 'system' ? teamName : (m.author?.name ?? teamName);
    const attached = m.files.length ? `\n(attached: ${m.files.map((f) => f.name).join(', ')})` : '';
    return `[${when(m.at)}] ${neutral(who)}: ${neutral(m.text)}${attached}`;
  });
  const link = `${origin}/chat/c/${await continueToken(thread.id, identity.id)}`;
  const body = `Here is a copy of your chat with ${teamName}.\n\n${lines.join('\n\n')}\n\nContinue the conversation: ${link}`;
  const message = await sendEmail(db, me, origin, {accountId: account.id, to: [to], subject: `Your chat with ${teamName}`, body, layout: 'branded', threadId: thread.id, contactId: thread.contactId, companyId: thread.companyId, dealId: thread.dealId});
  await threadEvent(db, thread.id, {type: 'transcript', to}, me.id);
  return {message, to};
}

export {identityLabel};
