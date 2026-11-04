import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {CHAT_LIMITS, CHAT_UPLOAD_TYPES, REPLY_TIMES, type ChatSettings, type ReplyTime} from '@/lib/chat';
import {isMessageChannel} from '@/lib/inbox';
import {isTimeZone} from '@/lib/scheduling';
import {publicOrigin} from '../kit/config';
import {currentUser, requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {notFound, valid} from '../lib/http';
import {mergeFields} from '../email/render';
import {sendChannelMessage} from '../inbox/channel-messages';
import {getChatSettings, queueVisitorEmail, saveChatSettings, sendTranscript} from '../inbox/chat';
import {closeConversation} from '../inbox/conversations';
import {loadConversation, who} from './inbox';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';
import {shownEmail} from '../lib/owner-account';

/**
 * Website chat, agent side (module 10b), next to the inbox routes: chat
 * replies, attachments, typing, transcripts and Settings → Inbox → Chat.
 * Everything else (assign, close, snooze, spam, comments, contact) is the
 * shared inbox's own routes.
 */

const range = z.object({start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^(\d{2}:\d{2}|24:00)$/)});
const settingsSchema = z.object({
  enabled: z.boolean(),
  accountId: z.string().max(60).nullable(),
  teamName: z.string().trim().max(60),
  greeting: z.string().trim().max(300),
  position: z.enum(['right', 'left']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #2563eb').nullable(),
  avatarIds: z.array(z.string().max(60)).max(3),
  replyTime: z.enum(Object.keys(REPLY_TIMES) as [ReplyTime, ...ReplyTime[]]),
  preChat: z.enum(['off', 'optional', 'required']),
  askName: z.boolean(),
  preChatIntro: z.string().trim().max(300),
  hours: z.object({
    enabled: z.boolean(),
    timezone: z.string().refine(isTimeZone, 'unknown time zone'),
    availability: z.object({weekly: z.record(z.string().regex(/^[0-6]$/), z.array(range).max(6)), overrides: z.array(z.object({date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ranges: z.array(range).max(6)})).max(100)}),
  }),
  offlineMessage: z.string().trim().min(1, 'write the away message').max(500),
  awayAfterMin: z.number().int().min(1).max(1440),
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/, 'must be a domain like example.com')).max(50),
  spamCheck: z.boolean(),
});

export const inboxChat = new Hono<AppEnv>()
  // ─── Reply in the chat (the visitor's widget picks it up on its next poll) ───
  .post('/conversations/:id/chat', valid('json', z.object({text: z.string().max(CHAT_LIMITS.messageChars).default(''), fileIds: z.array(z.string().max(60)).max(5).default([]), close: z.boolean().optional()})), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const input = c.req.valid('json');
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    if (!isMessageChannel(t.channel)) throw new HTTPException(400, {message: 'This is an email conversation: reply by email'});
    if (!input.text.trim() && !input.fileIds.length) throw new HTTPException(400, {message: 'Write a message first'});
    const files = input.fileIds.length ? await db.file.findMany({where: {id: {in: input.fileIds}, purpose: 'chat_pending', uploadedById: me.id}, select: {id: true}}) : [];
    if (files.length) await db.file.updateMany({where: {id: {in: files.map((f) => f.id)}}, data: {purpose: 'chat'}});
    // Saved replies may use merge fields ({{contact.first_name}}…), filled here like on emails.
    const contact = t.contactId ? await db.contact.findUnique({where: {id: t.contactId}, include: {companies: {include: {company: true}, orderBy: {isPrimary: 'desc'}, take: 1}}}) : null;
    const deal = t.dealId ? await db.deal.findUnique({where: {id: t.dealId}}) : null;
    const text = mergeFields(input.text.trim(), {contact, company: contact?.companies[0]?.company ?? null, deal, me: {name: me.name, email: shownEmail(me.email)}});
    const message = await sendChannelMessage(db, t, {text, fileIds: files.map((f) => f.id), senderId: me.id});
    let thread = await db.emailThread.update({where: {id: t.id}, data: {unread: false}});
    if (t.channel === 'chat') await queueVisitorEmail(db, thread, publicOrigin(c.req.raw));
    if (input.close) thread = await closeConversation(db, thread, who(c));
    return c.json({message, conversation: thread}, 201);
  })

  /** A chat attachment (upload step 1; lib/uploads.ts). It waits as "chat_pending" until the reply is sent. */
  .post('/chat/upload', valid('json', uploadBody), async (c) => {
    const me = currentUser(c);
    const checked = checkUpload(c.req.valid('json'), {accept: (mime) => CHAT_UPLOAD_TYPES.test(mime), wrongType: 'Send an image (PNG, JPG, GIF, WebP), a PDF or an office document'});
    const {file, upload} = await startUpload(c.var.db, checked, {purpose: 'chat_pending', uploadedById: me.id});
    return c.json({fileId: file.id, upload, file: {id: file.id, name: file.name, size: file.size, mimeType: file.mimeType}}, 201);
  })

  .post('/chat/upload/:fileId/complete', async (c) => {
    const me = currentUser(c);
    await completeUpload(c.var.db, {id: c.req.param('fileId'), purpose: 'chat_pending', uploadedById: me.id});
    return c.json({ok: true});
  })

  /** The agent is typing (the composer calls this at most every few seconds). */
  .post('/conversations/:id/typing', valid('json', z.object({typing: z.boolean()})), async (c) => {
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    if (isMessageChannel(t.channel)) await c.var.db.emailThread.update({where: {id: t.id}, data: {teamTypingAt: c.req.valid('json').typing ? new Date() : null}});
    return c.json({ok: true});
  })

  .post('/conversations/:id/transcript', async (c) => {
    const db = c.var.db;
    const {thread: t} = await loadConversation(c, c.req.param('id'));
    if (t.channel !== 'chat') throw notFound('Chat');
    const r = await sendTranscript(db, currentUser(c), t, publicOrigin(c.req.raw));
    await audit(db, c, {action: 'conversation.transcript', entity: 'conversation', recordId: t.id, label: t.subject, meta: {to: r.to}});
    return c.json({ok: true, to: r.to});
  })

  // ─── Settings → Inbox → Chat (admins) ───
  .get('/chat/settings', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const [settings, shared] = await Promise.all([
      getChatSettings(db),
      db.emailAccount.findMany({where: {userId: null}, select: {id: true, label: true, fromEmail: true}, orderBy: {createdAt: 'asc'}}),
    ]);
    return c.json({settings, sharedAccounts: shared, snippetUrl: `${publicOrigin(c.req.raw)}/site-api/crm/public/chat/widget.js`});
  })

  .put('/chat/settings', requireRole('ADMIN'), valid('json', settingsSchema), async (c) => {
    const db = c.var.db;
    const before = await getChatSettings(db);
    const input = c.req.valid('json');
    if (input.accountId && !(await db.emailAccount.findFirst({where: {id: input.accountId, userId: null}, select: {id: true}}))) throw new HTTPException(400, {message: 'Pick a shared mailbox'});
    const active = new Set((await db.member.findMany({where: {active: true, id: {in: input.avatarIds}}, select: {id: true}})).map((u) => u.id));
    const next: ChatSettings = {...input, avatarIds: input.avatarIds.filter((id) => active.has(id)), allowedDomains: [...new Set(input.allowedDomains)]};
    const settings = await saveChatSettings(db, next);
    await audit(db, c, {action: 'settings.chat', meta: {changes: diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)}});
    return c.json({settings});
  });
