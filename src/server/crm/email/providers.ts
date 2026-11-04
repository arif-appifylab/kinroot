import type {EmailProvider} from '../../../generated/prisma/client';
import {toB64} from '../kit/crypto';
import {buildMime, formatAddress, mimeToBase64Url, type OutgoingMessage} from './mime';
import {config as site} from '../../../platform/config';
import {fetchOut} from '../kit/outbound';
import {MailboxCallError, MailboxSetupError} from './errors';

/**
 * Two ways to connect email, one interface:
 *   1. Transactional API: Resend, Postmark, SendGrid, Mailgun (HTTPS, best deliverability)
 *   2. Mailbox OAuth: Gmail / Microsoft 365 (send from the real inbox + two-way sync)
 * Custom SMTP is not available: the site may open no raw TCP connections (AGENTS.md › Environment).
 *
 * API keys never live in the database: each provider's key is a secret the owner adds in the
 * dashboard (`API_KEY_SECRETS`), read when sending (`withKey`). An account keeps only what is not
 * secret (Postmark's message stream, Mailgun's domain and region).
 */

/** An old SMTP account's settings (no longer used to send). */
export type SmtpCreds = {host: string; port: number; security: string; username?: string; password?: string};
export type ResendCreds = {apiKey: string};
export type PostmarkCreds = {serverToken: string; messageStream?: string};
export type SendgridCreds = {apiKey: string};
export type MailgunCreds = {apiKey: string; domain: string; region: 'us' | 'eu'};
export type OAuthCreds = {accessToken: string; refreshToken: string; expiresAt: number; scope?: string};

export type Credentials = SmtpCreds | ResendCreds | PostmarkCreds | SendgridCreds | MailgunCreds | OAuthCreds;

export type SendResult = {externalId?: string | null; externalThreadId?: string | null};

/**
 * How replies get back into the CRM: OAuth mailboxes sync both ways. SMTP and
 * API accounts only send, so they set Reply-To to an inbound address (Resend
 * Receiving, Postmark inbound, SendGrid Inbound Parse or Mailgun routes, any
 * of them works with any sending setup) that posts replies to the inbound
 * webhook /site-api/crm/inbound/:token. `inboundWebhook`: the account uses that route.
 */
export const PROVIDER_INFO: Record<EmailProvider, {label: string; kind: 'smtp' | 'api' | 'oauth'; inbound: string; inboundWebhook: boolean}> = {
  SMTP: {label: 'Custom SMTP (not available)', kind: 'smtp', inbound: 'Replies via a Reply-To inbound address', inboundWebhook: true},
  RESEND: {label: 'Resend', kind: 'api', inbound: 'Replies via Resend Receiving (Reply-To)', inboundWebhook: true},
  POSTMARK: {label: 'Postmark', kind: 'api', inbound: 'Replies via Postmark inbound (Reply-To)', inboundWebhook: true},
  SENDGRID: {label: 'SendGrid', kind: 'api', inbound: 'Replies via SendGrid Inbound Parse (Reply-To)', inboundWebhook: true},
  MAILGUN: {label: 'Mailgun', kind: 'api', inbound: 'Replies via Mailgun routes (Reply-To)', inboundWebhook: true},
  GMAIL: {label: 'Gmail / Google Workspace', kind: 'oauth', inbound: 'Two-way sync', inboundWebhook: false},
  OUTLOOK: {label: 'Outlook / Microsoft 365', kind: 'oauth', inbound: 'Two-way sync', inboundWebhook: false},
};

/**
 * Reserved test domains (RFC 2606 / 6761): example.com/.net/.org and the .test, .example,
 * .invalid and .localhost TLDs. Public email services refuse or bounce them (Resend: 422
 * "Invalid `to` field"); a local SMTP sink is the only place they can go.
 */
export function isReservedAddress(email: string) {
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return /(^|\.)example\.(com|net|org)$/.test(domain) || /(^|\.)(test|example|invalid|localhost)$/.test(domain);
}

/** Only a local SMTP sink could deliver to reserved test domains, and SMTP is not available here. */
export const reachesReserved = (_provider: EmailProvider) => false;

/** The secret each API provider's key comes from (added by the owner in the dashboard, live and Preview). */
export const API_KEY_SECRETS = {
  RESEND: 'RESEND_API_KEY',
  POSTMARK: 'POSTMARK_SERVER_TOKEN',
  SENDGRID: 'SENDGRID_API_KEY',
  MAILGUN: 'MAILGUN_API_KEY',
} as const satisfies Partial<Record<EmailProvider, string>>;

type ApiProvider = keyof typeof API_KEY_SECRETS;
const isApi = (p: EmailProvider): p is ApiProvider => p in API_KEY_SECRETS;

/** Which provider keys (and OAuth client secrets) the owner has added: booleans only, for Settings → Email. */
export function secretsPresent() {
  const names = [...Object.values(API_KEY_SECRETS), 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET'];
  return Object.fromEntries(names.map((n) => [n, !!site.ownerSecret(n)])) as Record<string, boolean>;
}

/** The account's stored settings plus its provider's key from the owner's secret (a refused send when missing). */
function withKey(provider: EmailProvider, stored: Credentials): Credentials {
  if (provider === 'SMTP') throw new MailboxSetupError('Custom SMTP is not available on this site. Connect Resend, Postmark, SendGrid, Mailgun, Gmail or Outlook instead.');
  if (!isApi(provider)) return stored;
  const name = API_KEY_SECRETS[provider];
  const key = site.ownerSecret(name);
  if (!key) throw new MailboxSetupError(`Add the ${name} secret in the site dashboard to send with ${PROVIDER_INFO[provider].label}.`);
  return provider === 'POSTMARK' ? {...stored, serverToken: key} : {...stored, apiKey: key};
}

/**
 * A refused request: 4xx other than 429 won't succeed on retry, so jobs fail it straight away. Its
 * text is the provider's: shown only as words (`mailboxErrorText`), logged raw.
 */
class ProviderError extends MailboxCallError {
  readonly permanent: boolean;
  constructor(message: string, status: number) {
    super(message, status);
    this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

async function expectOk(res: Response, provider: string) {
  if (res.ok) return res;
  let detail = '';
  try {
    const body = (await res.json()) as Record<string, any>;
    detail = body.message ?? body.Message ?? body.error?.message ?? body.errors?.[0]?.message ?? JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  throw new ProviderError(`${provider} ${res.status}: ${detail}`, res.status);
}

// ─── Transactional APIs ─────────────────────────────────────────────────────

/** Attachments as each JSON API wants them (base64 content); undefined when there are none. */
const files = <T>(m: OutgoingMessage, shape: (a: {filename: string; contentType: string; base64: string}) => T): T[] | undefined =>
  m.attachments?.length ? m.attachments.map((a) => shape({filename: a.filename, contentType: a.contentType, base64: toB64(a.content)})) : undefined;

const threadHeaders = (m: OutgoingMessage) => ({
  'Message-ID': `<${m.messageId}>`,
  ...(m.inReplyTo ? {'In-Reply-To': `<${m.inReplyTo}>`, References: (m.references ?? [m.inReplyTo]).map((r) => `<${r}>`).join(' ')} : {}),
});

async function sendResend(c: ResendCreds, m: OutgoingMessage): Promise<SendResult> {
  const res = await fetchOut('https://api.resend.com/emails', {
    method: 'POST',
    headers: {authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      from: formatAddress(m.from),
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      reply_to: m.replyTo,
      subject: m.subject,
      html: m.html,
      text: m.text,
      headers: threadHeaders(m),
      attachments: files(m, (a) => ({filename: a.filename, content: a.base64, content_type: a.contentType})),
    }),
  });
  const body = (await (await expectOk(res, 'Resend')).json()) as {id: string};
  return {externalId: body.id};
}

async function sendPostmark(c: PostmarkCreds, m: OutgoingMessage): Promise<SendResult> {
  const res = await fetchOut('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {'x-postmark-server-token': c.serverToken, 'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({
      From: formatAddress(m.from),
      To: m.to.join(','),
      Cc: m.cc?.join(','),
      Bcc: m.bcc?.join(','),
      ReplyTo: m.replyTo,
      Subject: m.subject,
      HtmlBody: m.html,
      TextBody: m.text,
      MessageStream: c.messageStream || 'outbound',
      TrackOpens: false, // the CRM does its own tracking
      Headers: Object.entries(threadHeaders(m)).map(([Name, Value]) => ({Name, Value})),
      Attachments: files(m, (a) => ({Name: a.filename, Content: a.base64, ContentType: a.contentType})),
    }),
  });
  const body = (await (await expectOk(res, 'Postmark')).json()) as {MessageID: string};
  return {externalId: body.MessageID};
}

async function sendSendgrid(c: SendgridCreds, m: OutgoingMessage): Promise<SendResult> {
  const list = (xs?: string[]) => (xs?.length ? xs.map((email) => ({email})) : undefined);
  const res = await fetchOut('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      personalizations: [{to: list(m.to), cc: list(m.cc), bcc: list(m.bcc)}],
      from: {email: m.from.email, name: m.from.name ?? undefined},
      reply_to: m.replyTo ? {email: m.replyTo} : undefined,
      subject: m.subject,
      content: [
        {type: 'text/plain', value: m.text},
        {type: 'text/html', value: m.html},
      ],
      headers: threadHeaders(m),
      attachments: files(m, (a) => ({content: a.base64, filename: a.filename, type: a.contentType, disposition: 'attachment'})),
      tracking_settings: {click_tracking: {enable: false}, open_tracking: {enable: false}},
    }),
  });
  await expectOk(res, 'SendGrid');
  return {externalId: res.headers.get('x-message-id')};
}

async function sendMailgun(c: MailgunCreds, m: OutgoingMessage): Promise<SendResult> {
  const host = c.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  const form = new FormData();
  form.set('from', formatAddress(m.from));
  for (const to of m.to) form.append('to', to);
  for (const cc of m.cc ?? []) form.append('cc', cc);
  for (const bcc of m.bcc ?? []) form.append('bcc', bcc);
  if (m.replyTo) form.set('h:Reply-To', m.replyTo);
  form.set('subject', m.subject);
  form.set('html', m.html);
  form.set('text', m.text);
  for (const [k, v] of Object.entries(threadHeaders(m))) form.set(`h:${k}`, v);
  for (const a of m.attachments ?? []) form.append('attachment', new Blob([a.content as Uint8Array<ArrayBuffer>], {type: a.contentType}), a.filename);
  const res = await fetchOut(`https://${host}/v3/${c.domain}/messages`, {
    method: 'POST',
    headers: {authorization: `Basic ${btoa(`api:${c.apiKey}`)}`},
    body: form,
  });
  const body = (await (await expectOk(res, 'Mailgun')).json()) as {id: string};
  return {externalId: body.id};
}

/** Resend Receiving: the `email.received` webhook only has metadata; the content comes from this API. */
export async function fetchResendReceived(stored: Credentials, emailId: string) {
  const c = withKey('RESEND', stored) as ResendCreds;
  const res = await fetchOut(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {headers: {authorization: `Bearer ${c.apiKey}`}});
  return (await (await expectOk(res, 'Resend')).json()) as {
    id: string;
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    html: string | null;
    text: string | null;
    headers?: Record<string, string>;
    message_id?: string;
    created_at?: string;
  };
}

// ─── Mailbox APIs (token refresh is handled by the caller, see oauth.ts) ────

async function sendGmail(c: OAuthCreds, m: OutgoingMessage, threadId?: string | null): Promise<SendResult> {
  const res = await fetchOut('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({raw: mimeToBase64Url(buildMime(m, {includeBcc: true})), threadId: threadId ?? undefined}),
  });
  const body = (await (await expectOk(res, 'Gmail')).json()) as {id: string; threadId: string};
  return {externalId: body.id, externalThreadId: body.threadId};
}

async function sendOutlook(c: OAuthCreds, m: OutgoingMessage): Promise<SendResult> {
  const recipients = (xs?: string[]) => (xs ?? []).map((address) => ({emailAddress: {address}}));
  const res = await fetchOut('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      message: {
        subject: m.subject,
        body: {contentType: 'HTML', content: m.html},
        toRecipients: recipients(m.to),
        ccRecipients: recipients(m.cc),
        bccRecipients: recipients(m.bcc),
        replyTo: m.replyTo ? recipients([m.replyTo]) : undefined,
        attachments: files(m, (a) => ({'@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.base64})),
      },
      saveToSentItems: true,
    }),
  });
  await expectOk(res, 'Microsoft Graph');
  return {};
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function deliver(provider: EmailProvider, stored: Credentials, m: OutgoingMessage, opts: {externalThreadId?: string | null} = {}): Promise<SendResult> {
  const creds = withKey(provider, stored);
  switch (provider) {
    case 'SMTP':
      return {};
    case 'RESEND':
      return sendResend(creds as ResendCreds, m);
    case 'POSTMARK':
      return sendPostmark(creds as PostmarkCreds, m);
    case 'SENDGRID':
      return sendSendgrid(creds as SendgridCreds, m);
    case 'MAILGUN':
      return sendMailgun(creds as MailgunCreds, m);
    case 'GMAIL':
      return sendGmail(creds as OAuthCreds, m, opts.externalThreadId);
    case 'OUTLOOK':
      return sendOutlook(creds as OAuthCreds, m);
  }
}

/** Cheap credential check that doesn't send anything. */
export async function verifyCredentials(provider: EmailProvider, stored: Credentials): Promise<string> {
  const creds = withKey(provider, stored);
  switch (provider) {
    case 'SMTP':
      return '';
    case 'RESEND': {
      // Sending-only keys can't list domains (401/403 "restricted"), which still proves the key is real.
      const res = await fetchOut('https://api.resend.com/domains', {headers: {authorization: `Bearer ${(creds as ResendCreds).apiKey}`}});
      if (res.ok) return 'API key is valid';
      const body = (await res.json().catch(() => ({}))) as {name?: string; message?: string};
      if (body.name === 'restricted_api_key') return 'API key is valid (sending only)';
      throw new ProviderError(`Resend ${res.status}: ${body.message ?? res.statusText}`, res.status);
    }
    case 'POSTMARK':
      await expectOk(await fetchOut('https://api.postmarkapp.com/server', {headers: {'x-postmark-server-token': (creds as PostmarkCreds).serverToken, accept: 'application/json'}}), 'Postmark');
      return 'Server token is valid';
    case 'SENDGRID':
      await expectOk(await fetchOut('https://api.sendgrid.com/v3/scopes', {headers: {authorization: `Bearer ${(creds as SendgridCreds).apiKey}`}}), 'SendGrid');
      return 'API key is valid';
    case 'MAILGUN': {
      const c = creds as MailgunCreds;
      const host = c.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
      await expectOk(await fetchOut(`https://${host}/v3/domains/${c.domain}`, {headers: {authorization: `Basic ${btoa(`api:${c.apiKey}`)}`}}), 'Mailgun');
      return `Domain ${c.domain} is reachable`;
    }
    case 'GMAIL':
      await expectOk(await fetchOut('https://gmail.googleapis.com/gmail/v1/users/me/profile', {headers: {authorization: `Bearer ${(creds as OAuthCreds).accessToken}`}}), 'Gmail');
      return 'Mailbox connected';
    case 'OUTLOOK':
      await expectOk(await fetchOut('https://graph.microsoft.com/v1.0/me', {headers: {authorization: `Bearer ${(creds as OAuthCreds).accessToken}`}}), 'Microsoft Graph');
      return 'Mailbox connected';
  }
}
