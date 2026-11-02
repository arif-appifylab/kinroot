import {Hono} from 'hono';

import {publicOrigin} from '../kit/config';
import {verifySignature} from '../kit/crypto';
import type {AppEnv} from '../kit/guards';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {getSettings} from '../lib/settings';
import {parseAddressList, stripAngle, type Address} from '../email/mime';
import {verifyInbound} from '../email/inbound-auth';
import {receiveInbound, resendIncoming} from '../email/replies';
import type {IncomingMessage} from '../email/service';

/** Constant-time comparison of the URL token with the saved one. */
function sameToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 1×1 transparent GIF
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

const asList = (v: unknown): Address[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === 'string' ? parseAddressList(x) : x?.Email ? [{email: String(x.Email).toLowerCase(), name: x.Name ?? null}] : []))
    : parseAddressList(typeof v === 'string' ? v : null);

/** Normalises Postmark, Mailgun, SendGrid Inbound Parse and a generic JSON shape. */
function parseInbound(body: Record<string, unknown>): IncomingMessage | null {
  // Postmark
  if ('FromFull' in body || 'MessageID' in body) {
    const headers = (body.Headers as {Name: string; Value: string}[] | undefined) ?? [];
    const h = (n: string) => headers.find((x) => x.Name.toLowerCase() === n)?.Value ?? null;
    const from = body.FromFull as {Email: string; Name?: string} | undefined;
    return {
      from: from ? {email: from.Email.toLowerCase(), name: from.Name} : parseAddressList(String(body.From ?? ''))[0]!,
      to: asList(body.ToFull ?? body.To),
      cc: asList(body.CcFull ?? body.Cc),
      subject: String(body.Subject ?? ''),
      html: (body.HtmlBody as string) || null,
      text: (body.TextBody as string) || null,
      messageId: stripAngle(h('message-id')) ?? null,
      inReplyTo: stripAngle(h('in-reply-to')),
      references: (h('references') ?? '').split(/\s+/).map(stripAngle).filter(Boolean) as string[],
      date: body.Date ? new Date(String(body.Date)) : undefined,
    };
  }
  // Mailgun routes (form fields)
  if ('body-plain' in body || 'stripped-text' in body) {
    return {
      from: parseAddressList(String(body.from ?? body.sender ?? ''))[0]!,
      to: parseAddressList(String(body.To ?? body.recipient ?? '')),
      cc: parseAddressList(String(body.Cc ?? '')),
      subject: String(body.subject ?? ''),
      html: (body['body-html'] as string) || null,
      text: (body['body-plain'] as string) || null,
      messageId: stripAngle(body['Message-Id'] as string),
      inReplyTo: stripAngle(body['In-Reply-To'] as string),
      references: String(body.References ?? '').split(/\s+/).map(stripAngle).filter(Boolean) as string[],
    };
  }
  // SendGrid Inbound Parse (form fields; raw headers in `headers`)
  if ('envelope' in body && 'headers' in body) {
    const raw = String(body.headers);
    const h = (n: string) => raw.match(new RegExp(`^${n}:\\s*(.+)$`, 'im'))?.[1] ?? null;
    return {
      from: parseAddressList(String(body.from ?? ''))[0]!,
      to: parseAddressList(String(body.to ?? '')),
      cc: parseAddressList(String(body.cc ?? '')),
      subject: String(body.subject ?? ''),
      html: (body.html as string) || null,
      text: (body.text as string) || null,
      messageId: stripAngle(h('Message-ID')),
      inReplyTo: stripAngle(h('In-Reply-To')),
      references: (h('References') ?? '').split(/\s+/).map(stripAngle).filter(Boolean) as string[],
    };
  }
  // Generic JSON: {from, to, cc, subject, html, text, messageId, inReplyTo, references}
  if ('from' in body && 'subject' in body) {
    return {
      from: asList(body.from)[0]!,
      to: asList(body.to),
      cc: asList(body.cc),
      subject: String(body.subject ?? ''),
      html: (body.html as string) || null,
      text: (body.text as string) || null,
      messageId: stripAngle(body.messageId as string),
      inReplyTo: stripAngle(body.inReplyTo as string),
      references: (Array.isArray(body.references) ? body.references.map(String) : String(body.references ?? '').split(/\s+/)).map(stripAngle).filter(Boolean) as string[],
    };
  }
  return null;
}

export const emailPublic = new Hono<AppEnv>()
  // The Branding logo for email headers (mail clients block data: URLs). Raster images only, never SVG.
  .get('/public/brand-logo', async (c) => {
    const logo = (await getSettings(c.var.db)).brandLogo;
    const m = logo.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
    if (!m) return c.text('No logo', 404);
    const bytes = Uint8Array.from(atob(m[2]!), (ch) => ch.charCodeAt(0));
    return new Response(bytes, {
      headers: {'content-type': m[1]!, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox"},
    });
  })

  .get('/t/o/:file', async (c) => {
    const trackingId = c.req.param('file').replace(/\.gif$/, '');
    const db = c.var.db;
    const message = await db.emailMessage.findUnique({where: {trackingId}, select: {id: true, openCount: true, sentAt: true, contactId: true, subject: true, thread: {select: {dealId: true}}}});
    // Ignore hits in the first few seconds: that's usually the sender's own client or a scanner.
    if (message && Date.now() - message.sentAt.getTime() > 5_000) {
      await db.emailMessage.update({
        where: {id: message.id},
        data: {openCount: {increment: 1}, ...(message.openCount === 0 ? {firstOpenedAt: new Date()} : {})},
      });
      await db.trackingEvent.create({data: {messageId: message.id, type: 'open', userAgent: c.req.header('user-agent')?.slice(0, 300)}});
      if (message.openCount === 0) {
        await logActivity(db, {type: 'email_opened', title: `Opened: ${message.subject}`, refId: message.id, contactId: message.contactId, dealId: message.thread.dealId});
        await emit(db, 'email.opened', {entity: 'email', recordId: message.id, data: {messageId: message.id, contactId: message.contactId, dealId: message.thread.dealId, subject: message.subject}});
      }
    }
    return new Response(PIXEL, {headers: {'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0'}});
  })

  .get('/t/c/:trackingId', async (c) => {
    const trackingId = c.req.param('trackingId');
    const url = c.req.query('u') ?? '';
    const sig = c.req.query('s') ?? '';
    // Signed links only: the tracker must never become an open redirect.
    if (!/^https?:\/\//.test(url) || !(await verifySignature(`${trackingId}|${url}`, sig))) return c.text('Invalid link', 400);
    const message = await c.var.db.emailMessage.findUnique({where: {trackingId}, select: {id: true, clickCount: true, contactId: true, subject: true, thread: {select: {dealId: true}}}});
    if (message) {
      await c.var.db.emailMessage.update({where: {id: message.id}, data: {clickCount: {increment: 1}}});
      await c.var.db.trackingEvent.create({data: {messageId: message.id, type: 'click', url: url.slice(0, 1000), userAgent: c.req.header('user-agent')?.slice(0, 300)}});
      if (message.clickCount === 0) {
        await emit(c.var.db, 'email.clicked', {entity: 'email', recordId: message.id, data: {messageId: message.id, contactId: message.contactId, dealId: message.thread.dealId, subject: message.subject, url: url.slice(0, 1000)}});
      }
    }
    return c.redirect(url, 302);
  })

  .post('/inbound/:token', async (c) => {
    const db = c.var.db;
    const settings = await getSettings(db);
    if (!settings.inboundToken || !sameToken(c.req.param('token'), settings.inboundToken)) return c.json({error: 'Unknown inbound address'}, 404);
    // Only the mail service may post here: its signature (or Basic credentials) before the body is used.
    const verified = await verifyInbound(c);
    if (!verified.ok) {
      console.warn(`[inbound] refused: ${verified.reason}`);
      return c.json({error: 'Not signed by your mail service. See Settings → Email → Inbound webhook.'}, 401);
    }
    const body = verified.body;
    // Resend Receiving sends an event without the content; it is fetched from the API.
    const resend = body.type === 'email.received' && body.data ? await resendIncoming(db, body.data as {email_id?: string; to?: string[]}) : null;
    const parsed = resend?.message ?? (body.type === 'email.received' ? null : parseInbound(body));
    if (!parsed?.from?.email) return c.json({ok: false, reason: 'Unrecognised payload'}, 200);
    const message = await receiveInbound(db, parsed, {origin: publicOrigin(c.req.raw), account: resend?.account});
    return c.json({ok: true, stored: !!message});
  });
