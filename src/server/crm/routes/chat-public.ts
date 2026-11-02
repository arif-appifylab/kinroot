import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {ChannelIdentity} from '../../../generated/prisma/client';
import {CHAT_LIMITS, CHAT_UPLOAD_TYPES, hostOf, type ChatSettings, type VisitorSession} from '@/lib/chat';
import {publicOrigin} from '../kit/config';
import type {AppContext, AppEnv} from '../kit/guards';
import {notFound, valid} from '../lib/http';
import {ipKey, rateLimit} from '../lib/rate-limit';
import {
  chatAvailability,
  chatFileToken,
  claimFiles,
  currentConversation,
  embedAllowed,
  fromContinueToken,
  getChatSettings,
  identifyVisitor,
  identityFromToken,
  newVisitor,
  publicChatConfig,
  startChat,
  touchVisitor,
  visitorMessage,
  visitorPresence,
  visitorToken,
  visitorView,
  type VisitorMeta,
} from '../inbox/chat';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';

/**
 * Website live chat, visitor side (module 10b). No sign-in: the visitor is a
 * signed token kept in the widget's localStorage on our origin, and every
 * conversation is checked against it. Visitors only ever see chat messages
 * and their own email replies, never comments or event lines.
 */

const ip = (c: AppContext) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

const meta = z
  .object({
    page: z.string().max(2000).nullish(),
    title: z.string().max(300).nullish(),
    referrer: z.string().max(2000).nullish(),
    ancestor: z.string().max(300).nullish(), // location.ancestorOrigins[0] inside the iframe, when the browser has it
    timeZone: z.string().max(64).nullish(),
    utm: z.record(z.string().max(40), z.string().max(200)).optional(),
  })
  .default({});

const fileRefs = z.array(z.object({id: z.string().max(60), token: z.string().max(60)})).max(5).default([]);
const text = z.string().max(CHAT_LIMITS.messageChars).default('');

const UTM = /^utm_(source|medium|campaign|term|content)$/;
/** UTM tags as the widget sent them, else read from the page URL. */
const utmOf = (m: z.infer<typeof meta>) => {
  const given = Object.entries(m.utm ?? {}).filter(([k]) => UTM.test(k));
  if (given.length) return Object.fromEntries(given);
  try {
    return Object.fromEntries([...new URL(m.page ?? '').searchParams.entries()].filter(([k]) => UTM.test(k)).map(([k, v]) => [k, v.slice(0, 200)]));
  } catch {
    return {};
  }
};

const visitorMeta = (c: AppContext, m: z.infer<typeof meta>): VisitorMeta => ({
  page: m.page,
  title: m.title,
  referrer: m.referrer,
  timeZone: m.timeZone,
  utm: utmOf(m),
  userAgent: c.req.header('user-agent') ?? null,
});

const nothing = () => new HTTPException(400, {message: 'Write a message first'});

/** The chat must be on, and the embedding site on the allow-list. */
async function requireChat(c: AppContext, m: {page?: string | null; ancestor?: string | null}) {
  const s = await getChatSettings(c.var.db);
  if (!s.enabled) throw new HTTPException(404, {message: 'Chat is not available'});
  if (!embedAllowed(s, [hostOf(m.page), hostOf(m.ancestor)], publicOrigin(c.req.raw))) throw new HTTPException(403, {message: 'Chat is not available on this site'});
  return s;
}

async function requireVisitor(c: AppContext, token: string | null | undefined) {
  const identity = await identityFromToken(c.var.db, token);
  if (!identity) throw new HTTPException(401, {message: 'Your chat session expired. Reload the page to start again.'});
  return identity;
}

async function visitorConversation(c: AppContext, identity: ChannelIdentity, id: string) {
  const t = await c.var.db.emailThread.findFirst({where: {id, identityId: identity.id, channel: 'chat', trashedAt: null}});
  if (!t) throw notFound('Conversation');
  return t;
}

async function session(c: AppContext, identity: ChannelIdentity): Promise<VisitorSession> {
  const t = await currentConversation(c.var.db, identity);
  return {token: await visitorToken(identity.id), name: identity.name, email: identity.email, conversation: t ? await visitorView(c.var.db, t, publicOrigin(c.req.raw)) : null};
}

const limits = async (c: AppContext, identity: ChannelIdentity | null, kind: 'start' | 'message' | 'upload') => {
  const ipk = await ipKey(ip(c));
  if (kind === 'start') {
    return [
      {key: `chat:start:ip:${ipk}`, limit: CHAT_LIMITS.startsPerIpHour, windowSec: 3600},
      ...(identity ? [{key: `chat:start:v:${identity.id}`, limit: CHAT_LIMITS.startsPerVisitorHour, windowSec: 3600}] : []),
    ];
  }
  if (kind === 'upload') return [{key: `chat:upload:${identity ? `v:${identity.id}` : `ip:${ipk}`}`, limit: CHAT_LIMITS.uploadsPerVisitorHour, windowSec: 3600}];
  return [
    {key: `chat:msg:ip:${ipk}`, limit: CHAT_LIMITS.messagesPerIpMinute, windowSec: 60},
    ...(identity ? [{key: `chat:msg:v:${identity.id}`, limit: CHAT_LIMITS.messagesPerVisitorMinute, windowSec: 60}] : []),
  ];
};

const bot = (hp?: string, startedAt?: number) => !!hp || (!!startedAt && Date.now() - startedAt < 1500);

export const chatPublic = new Hono<AppEnv>()
  /**
   * The loader a company puts on its website. The site answers no cross-site calls (no CORS), so
   * the script carries its settings (on, allowed on the embedding page, colour, side), worked out
   * from the page that asked for it (its Referer). Short cache: settings changes show up quickly.
   */
  .get('/chat/widget.js', async (c) => {
    const db = c.var.db;
    const s = await getChatSettings(db);
    const page = c.req.header('referer') ?? null;
    const allowed = embedAllowed(s, [hostOf(page)], publicOrigin(c.req.raw));
    const cfg = {enabled: s.enabled, allowed, color: /^#[0-9a-f]{3,8}$/i.test(s.color ?? '') ? s.color : '#2563eb', position: s.position === 'left' ? 'left' : 'right'};
    return c.body(WIDGET_JS.replace('__CONFIG__', JSON.stringify(cfg)), 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60',
      vary: 'Referer',
    });
  })

  /** GET /site-api/crm/public/chat/link/:token: is a "continue the conversation" link still good? */
  .get('/chat/link/:token', async (c) => c.json({valid: !!(await fromContinueToken(c.req.param('token').slice(0, 300)))}))

  /** Appearance, pre-chat form and availability. Answers even when off (enabled: false), so the widget can stay hidden. */
  .post('/chat/config', valid('json', z.object({meta})), async (c) => {
    const db = c.var.db;
    const s = await getChatSettings(db);
    const m = c.req.valid('json').meta;
    const allowed = embedAllowed(s, [hostOf(m.page), hostOf(m.ancestor)], publicOrigin(c.req.raw));
    return c.json({config: await publicChatConfig(db, s, allowed)});
  })

  /** A returning visitor (token from localStorage): who they are and their current conversation. */
  .post('/chat/session', valid('json', z.object({token: z.string().max(200).nullish(), meta})), async (c) => {
    const body = c.req.valid('json');
    await requireChat(c, body.meta);
    const identity = await identityFromToken(c.var.db, body.token);
    if (!identity || identity.blockedAt) return c.json({session: null});
    const touched = await touchVisitor(c.var.db, identity, visitorMeta(c, body.meta), {force: true});
    return c.json({session: await session(c, touched)});
  })

  /** The first message (and the pre-chat answers): a new conversation in the team inbox. */
  .post(
    '/chat/start',
    valid('json', z.object({
      token: z.string().max(200).nullish(),
      name: z.string().trim().max(120).nullish(),
      email: z.email().max(200).nullish().or(z.literal('')),
      text,
      files: fileRefs,
      meta,
      hp: z.string().optional(),
      startedAt: z.number().optional(),
    })),
    async (c) => {
      const db = c.var.db;
      const body = c.req.valid('json');
      const s = await requireChat(c, body.meta);
      if (!body.text.trim() && !body.files.length) throw new HTTPException(400, {message: 'Write a message first'});
      if (s.preChat === 'required' && !body.email) {
        const known = body.token ? await identityFromToken(db, body.token) : null;
        if (!known?.email) throw new HTTPException(400, {message: 'Enter your email address to start the chat'});
      }
      let identity = body.token ? await identityFromToken(db, body.token) : null;
      if (body.token && !identity) throw new HTTPException(401, {message: 'Your chat session expired. Reload the page to start again.'});
      await rateLimit(db, await limits(c, identity, 'start'), 'You have started several chats in a short time. Please wait a while and try again.');
      if (bot(body.hp, body.startedAt)) throw new HTTPException(400, {message: 'Please try again'});
      identity = identity ? await touchVisitor(db, identity, visitorMeta(c, body.meta), {force: true}) : await newVisitor(db, visitorMeta(c, body.meta));
      if (body.name || body.email) identity = await identifyVisitor(db, identity, {name: body.name, email: body.email || null});
      const fileIds = await claimFiles(db, identity.id, body.files);
      if (!body.text.trim() && !fileIds.length) throw nothing();
      await startChat(db, s, {identity, text: body.text.trim(), fileIds, page: body.meta.page ?? null});
      return c.json({session: await session(c, identity)}, 201);
    },
  )

  .post('/chat/messages', valid('json', z.object({token: z.string().max(200), conversationId: z.string().max(60), text, files: fileRefs, meta})), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const s = await requireChat(c, body.meta);
    const identity = await requireVisitor(c, body.token);
    const thread = await visitorConversation(c, identity, body.conversationId);
    if (!body.text.trim() && !body.files.length) throw new HTTPException(400, {message: 'Write a message first'});
    await rateLimit(db, await limits(c, identity, 'message'), 'You are sending messages very quickly. Please wait a moment.');
    const fileIds = await claimFiles(db, identity.id, body.files);
    if (!body.text.trim() && !fileIds.length) throw nothing();
    const message = await visitorMessage(db, s, thread, identity, {text: body.text.trim(), fileIds, page: body.meta.page ?? null});
    await touchVisitor(db, identity, visitorMeta(c, body.meta));
    const view = await visitorView(db, (await db.emailThread.findUnique({where: {id: thread.id}}))!, publicOrigin(c.req.raw), new Date(message.createdAt.getTime() - 1));
    return c.json({conversation: view}, 201);
  })

  /**
   * Polling (no websockets on this stack): the widget calls this every few
   * seconds while open and active, slower when idle, never while the page is
   * hidden. Returns what is new since `after`.
   */
  .post(
    '/chat/poll',
    valid('json', z.object({token: z.string().max(200), conversationId: z.string().max(60).nullish(), after: z.iso.datetime({offset: true}).nullish(), typing: z.boolean().optional(), visible: z.boolean().optional(), meta})),
    async (c) => {
      const db = c.var.db;
      const body = c.req.valid('json');
      const s = await requireChat(c, body.meta);
      const identity = await requireVisitor(c, body.token);
      await touchVisitor(db, identity, visitorMeta(c, body.meta));
      const {away} = await chatAvailability(db, s);
      if (!body.conversationId) return c.json({conversation: null, away});
      const thread = await visitorConversation(c, identity, body.conversationId);
      await visitorPresence(db, thread, {typing: body.typing, visible: body.visible});
      const fresh = (await db.emailThread.findUnique({where: {id: thread.id}}))!;
      return c.json({conversation: await visitorView(db, fresh, publicOrigin(c.req.raw), body.after ? new Date(body.after) : null), away});
    },
  )

  /** A visitor's attachment (upload step 1; lib/uploads.ts). Returns an upload token; the file waits until the message is sent. A new visitor gets a token too. */
  .post('/chat/upload', valid('json', uploadBody.extend({token: z.string().max(200).nullish(), page: z.string().max(2000).nullish(), ancestor: z.string().max(2000).nullish()})), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const m = {page: body.page ?? null, ancestor: body.ancestor ?? null};
    await requireChat(c, m);
    let identity = body.token ? await requireVisitor(c, body.token) : null;
    await rateLimit(db, await limits(c, identity, 'upload'), 'Too many uploads. Please wait a while and try again.');
    const checked = checkUpload(body, {accept: (mime) => CHAT_UPLOAD_TYPES.test(mime), wrongType: 'Send an image (PNG, JPG, GIF, WebP), a PDF or an office document'});
    identity ??= await newVisitor(db, {page: m.page, userAgent: c.req.header('user-agent') ?? null});
    const {file, upload} = await startUpload(db, checked, {purpose: 'chat_pending'});
    return c.json(
      {fileId: file.id, upload, file: {id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, token: await chatFileToken(file.id, identity.id)}, token: await visitorToken(identity.id)},
      201,
    );
  })

  .post('/chat/upload/:fileId/complete', async (c) => {
    await completeUpload(c.var.db, {id: c.req.param('fileId'), purpose: 'chat_pending', uploadedById: null});
    return c.json({ok: true});
  })

  /** The visitor gave their name / email (pre-chat form later on, or the "leave your email" prompt when away). */
  .post('/chat/identify', valid('json', z.object({token: z.string().max(200), name: z.string().trim().max(120).nullish(), email: z.email().max(200), meta})), async (c) => {
    const body = c.req.valid('json');
    await requireChat(c, body.meta);
    const identity = await requireVisitor(c, body.token);
    await rateLimit(c.var.db, await limits(c, identity, 'message'));
    const updated = await identifyVisitor(c.var.db, identity, {name: body.name, email: body.email});
    return c.json({session: await session(c, updated)});
  })

  /** /chat/c/<token> from an email: hands that browser the visitor token for the conversation. */
  .post('/chat/continue', valid('json', z.object({token: z.string().max(300)})), async (c) => {
    const db = c.var.db;
    const s: ChatSettings = await getChatSettings(db);
    const parsed = await fromContinueToken(c.req.valid('json').token);
    if (!parsed || !s.enabled) throw new HTTPException(410, {message: 'This link has expired. Start a new chat from our website.'});
    const identity = await db.channelIdentity.findFirst({where: {id: parsed.identityId, channel: 'chat', blockedAt: null}});
    const thread = identity ? await db.emailThread.findFirst({where: {id: parsed.threadId, identityId: identity.id, trashedAt: null}}) : null;
    if (!identity || !thread) throw new HTTPException(410, {message: 'This conversation is no longer available.'});
    const touched = await touchVisitor(db, identity, {userAgent: c.req.header('user-agent') ?? null}, {force: true});
    return c.json({session: {token: await visitorToken(identity.id), name: touched.name, email: touched.email, conversation: await visitorView(db, thread, publicOrigin(c.req.raw))} satisfies VisitorSession});
  });

/**
 * The website chat loader:
 *   <script src="https://crm.example.com/site-api/crm/public/chat/widget.js" async></script>
 *   optional: data-position="left" (overrides the setting), data-open="1"
 *
 * A chat button on the company's page. The chat itself is a page of this site (/chat/), opened as
 * a small window: this site may not be framed by others (X-Frame-Options: DENY) nor answer their
 * pages' calls (no CORS). The window posts its unread count back; the button shows it.
 */
const WIDGET_JS = `(function () {
  if (window.CrmChat) return;
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var cfg = __CONFIG__;
  var forcedPosition = script.getAttribute('data-position');
  var openOnLoad = script.getAttribute('data-open') === '1';
  var win = null, btn, badge;
  var icon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  if (!cfg.enabled || !cfg.allowed) return;
  function side() { return forcedPosition === 'left' || (!forcedPosition && cfg.position === 'left') ? 'left' : 'right'; }
  function url() {
    var q = new URLSearchParams({page: location.href.slice(0, 2000), title: document.title.slice(0, 200)});
    if (document.referrer) q.set('ref', document.referrer.slice(0, 1000));
    return origin + '/chat/?' + q.toString();
  }
  function open() {
    if (win && !win.closed) { win.focus(); return; }
    var w = 400, h = Math.min(680, screen.availHeight - 80);
    var left = side() === 'left' ? 20 : Math.max(0, screen.availWidth - w - 20);
    win = window.open(url(), 'crm-chat', 'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + Math.max(0, screen.availHeight - h - 40));
    if (!win) location.href = url();
  }
  function mount() {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open chat');
    btn.style.cssText = 'position:fixed;bottom:20px;' + side() + ':20px;z-index:2147483000;width:56px;height:56px;border:0;border-radius:999px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;background:' + cfg.color + ';box-shadow:0 10px 30px rgba(15,23,42,.25);';
    btn.innerHTML = icon;
    badge = document.createElement('span');
    badge.setAttribute('aria-hidden', 'true');
    badge.style.cssText = 'position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#e11d48;color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center;display:none;box-sizing:border-box;';
    btn.appendChild(badge);
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
    if (openOnLoad) open();
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== 'crm-chat:unread' || !badge) return;
    var n = Number(e.data.count) || 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'block' : 'none';
    btn.setAttribute('aria-label', 'Open chat' + (n > 0 ? ' (' + n + ' unread)' : ''));
  });
  window.CrmChat = {open: open, close: function () { if (win && !win.closed) win.close(); }, toggle: function () { win && !win.closed ? win.close() : open(); }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;
