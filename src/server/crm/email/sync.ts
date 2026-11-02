import type {EmailAccount} from '../../../generated/prisma/client';
import {fromB64} from '../kit/crypto';
import type {Db} from '../kit/db';
import {parseAddressList, stripAngle} from './mime';
import {accountCredentials} from './oauth';
import type {OAuthCreds} from './providers';
import {ingestMessage, type IncomingMessage} from './service';

const MAX_PER_RUN = 40; // keeps one run well inside a Worker's request budget
const FIRST_SYNC_DAYS = 14;

const b64urlToText = (data: string) => new TextDecoder().decode(fromB64(data.replace(/-/g, '+').replace(/_/g, '/')));

type GmailPart = {mimeType: string; body?: {data?: string}; parts?: GmailPart[]; headers?: {name: string; value: string}[]};

function gmailBodies(part: GmailPart, out: {html?: string; text?: string} = {}) {
  if (part.mimeType === 'text/html' && part.body?.data && !out.html) out.html = b64urlToText(part.body.data);
  if (part.mimeType === 'text/plain' && part.body?.data && !out.text) out.text = b64urlToText(part.body.data);
  for (const p of part.parts ?? []) gmailBodies(p, out);
  return out;
}

async function syncGmail(db: Db, account: EmailAccount, creds: OAuthCreds) {
  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const q = `after:${Math.floor(since.getTime() / 1000) - 60} -in:chats -in:spam -in:trash`;
  const auth = {authorization: `Bearer ${creds.accessToken}`};
  const list = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_PER_RUN}&q=${encodeURIComponent(q)}`, {headers: auth})).json()) as {
    messages?: {id: string; threadId: string}[];
    error?: {message: string};
  };
  if (list.error) throw new Error(`Gmail: ${list.error.message}`);

  let stored = 0;
  let newest = since;
  for (const {id} of [...(list.messages ?? [])].reverse()) {
    if (await db.emailMessage.findFirst({where: {accountId: account.id, externalId: id}, select: {id: true}})) continue;
    const msg = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {headers: auth})).json()) as {
      id: string;
      threadId: string;
      internalDate: string;
      payload: GmailPart;
    };
    const h = (name: string) => msg.payload.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? null;
    const bodies = gmailBodies(msg.payload);
    const date = new Date(Number(msg.internalDate));
    if (date > newest) newest = date;
    const incoming: IncomingMessage = {
      from: parseAddressList(h('from'))[0] ?? {email: 'unknown@unknown'},
      to: parseAddressList(h('to')),
      cc: parseAddressList(h('cc')),
      subject: h('subject') ?? '(no subject)',
      html: bodies.html,
      text: bodies.text,
      messageId: stripAngle(h('message-id')),
      inReplyTo: stripAngle(h('in-reply-to')),
      references: (h('references') ?? '').split(/\s+/).map(stripAngle).filter(Boolean) as string[],
      externalId: msg.id,
      externalThreadId: msg.threadId,
      date,
    };
    if (await ingestMessage(db, account, incoming)) stored++;
  }
  return {stored, newest, more: (list.messages?.length ?? 0) >= MAX_PER_RUN};
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  internetMessageId: string;
  receivedDateTime: string;
  from?: {emailAddress: {address: string; name: string}};
  toRecipients: {emailAddress: {address: string; name: string}}[];
  ccRecipients: {emailAddress: {address: string; name: string}}[];
  body: {contentType: 'html' | 'text'; content: string};
};

async function syncOutlook(db: Db, account: EmailAccount, creds: OAuthCreds) {
  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${new Date(since.getTime() - 60_000).toISOString()}`,
    $orderby: 'receivedDateTime asc',
    $top: String(MAX_PER_RUN),
    $select: 'id,conversationId,subject,internetMessageId,receivedDateTime,from,toRecipients,ccRecipients,body',
  });
  const res = (await (await fetch(`https://graph.microsoft.com/v1.0/me/messages?${params}`, {headers: {authorization: `Bearer ${creds.accessToken}`}})).json()) as {
    value?: GraphMessage[];
    error?: {message: string};
  };
  if (res.error) throw new Error(`Microsoft Graph: ${res.error.message}`);

  const addr = (a: {emailAddress: {address: string; name: string}}) => ({email: a.emailAddress.address.toLowerCase(), name: a.emailAddress.name});
  let stored = 0;
  let newest = since;
  for (const m of res.value ?? []) {
    const date = new Date(m.receivedDateTime);
    if (date > newest) newest = date;
    const incoming: IncomingMessage = {
      from: m.from ? addr(m.from) : {email: account.fromEmail},
      to: m.toRecipients.map(addr),
      cc: m.ccRecipients.map(addr),
      subject: m.subject ?? '(no subject)',
      html: m.body.contentType === 'html' ? m.body.content : null,
      text: m.body.contentType === 'text' ? m.body.content : null,
      messageId: stripAngle(m.internetMessageId),
      externalId: m.id,
      externalThreadId: m.conversationId,
      date,
    };
    if (await ingestMessage(db, account, incoming)) stored++;
  }
  return {stored, newest, more: (res.value?.length ?? 0) >= MAX_PER_RUN};
}

export async function syncAccount(db: Db, account: EmailAccount) {
  // SMTP and API accounts only send; their replies arrive through the inbound webhook (Reply-To).
  if (account.provider !== 'GMAIL' && account.provider !== 'OUTLOOK') return {stored: 0, skipped: true};
  try {
    const creds = (await accountCredentials(db, account)) as OAuthCreds;
    const r = account.provider === 'GMAIL' ? await syncGmail(db, account, creds) : await syncOutlook(db, account, creds);
    await db.emailAccount.update({where: {id: account.id}, data: {lastSyncedAt: r.newest, status: 'CONNECTED', lastError: null}});
    return {stored: r.stored, more: r.more};
  } catch (e) {
    await db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR', lastError: (e as Error).message.slice(0, 500)}});
    return {stored: 0, error: (e as Error).message};
  }
}

export async function syncAll(db: Db) {
  const accounts = await db.emailAccount.findMany({where: {provider: {in: ['GMAIL', 'OUTLOOK']}}});
  const results = [];
  for (const a of accounts) results.push({account: a.fromEmail, ...(await syncAccount(db, a))});
  return results;
}
