import {toB64, toB64Url} from '../kit/crypto';

export type Address = {email: string; name?: string | null};

/** A file sent with the message (report CSVs). Every provider supports it, see providers.ts. */
export type Attachment = {filename: string; contentType: string; content: Uint8Array};

export type OutgoingMessage = {
  from: Address;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  messageId: string; // without angle brackets
  inReplyTo?: string | null;
  references?: string[];
  attachments?: Attachment[];
};

const enc = new TextEncoder();
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeader(value: string) {
  return isAscii(value) ? value : `=?UTF-8?B?${toB64(enc.encode(value))}?=`;
}

export function formatAddress({email, name}: Address) {
  if (!name) return email;
  const safe = isAscii(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeHeader(name);
  return `${safe} <${email}>`;
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

export function newMessageId(fromEmail: string) {
  const domain = fromEmail.split('@')[1] ?? 'crm.local';
  return `${crypto.randomUUID()}@${domain}`;
}

/** RFC 2231 file name parameter, so non-ASCII names survive. */
const fileParam = (name: string) => (isAscii(name) ? `filename="${name.replace(/["\\]/g, '')}"` : `filename*=UTF-8''${encodeURIComponent(name)}`);

/**
 * Builds an RFC 5322 multipart/alternative message (text + HTML, base64
 * bodies). With attachments it is multipart/mixed: the alternative part first,
 * then one base64 part per file.
 */
export function buildMime(m: OutgoingMessage, {includeBcc = false} = {}): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const mixed = m.attachments?.length ? `m_${crypto.randomUUID().replace(/-/g, '')}` : null;
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.join(', ')}`,
    m.cc?.length ? `Cc: ${m.cc.join(', ')}` : null,
    includeBcc && m.bcc?.length ? `Bcc: ${m.bcc.join(', ')}` : null,
    m.replyTo ? `Reply-To: ${m.replyTo}` : null,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${m.messageId}>`,
    m.inReplyTo ? `In-Reply-To: <${m.inReplyTo}>` : null,
    m.references?.length ? `References: ${m.references.map((r) => `<${r}>`).join(' ')}` : null,
    'MIME-Version: 1.0',
    mixed ? `Content-Type: multipart/mixed; boundary="${mixed}"` : `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(toB64(enc.encode(body)))].join('\r\n');

  const alternative = [part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`];
  if (!mixed) return [...headers, '', ...alternative, ''].join('\r\n');
  const files = m.attachments!.map((a) =>
    [`--${mixed}`, `Content-Type: ${a.contentType}; name="${a.filename.replace(/["\\]/g, '')}"`, `Content-Disposition: attachment; ${fileParam(a.filename)}`, 'Content-Transfer-Encoding: base64', '', wrap76(toB64(a.content))].join('\r\n'),
  );
  return [...headers, '', `--${mixed}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...alternative, ...files, `--${mixed}--`, ''].join('\r\n');
}

export const mimeToBase64Url = (mime: string) => toB64Url(enc.encode(mime));

/** Very small RFC 5322 address-list parser: "Name <a@b.c>, d@e.f" → addresses. */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  for (const raw of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = (m?.[2] ?? raw).trim().toLowerCase();
    if (email.includes('@')) out.push({email, name: m?.[1]?.trim() || null});
  }
  return out;
}

export const stripAngle = (v: string | null | undefined) => v?.trim().replace(/^<|>$/g, '') || null;
