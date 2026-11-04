import type {EmailAccount} from '../../../generated/prisma/client';
import {fromB64} from '../kit/crypto';
import type {Db} from '../kit/db';
import {parseAddressList, stripAngle} from './mime';
import {accountCredentials} from './oauth';
import type {OAuthCreds} from './providers';
import {ingestMessage, type IncomingMessage} from './service';
import {fetchOut} from '../kit/outbound';
import {enqueue} from '../lib/jobs';
import {logMailboxError, mailboxErrorText, MailboxCallError} from './errors';

const MAX_PER_RUN = 40; // keeps one run well inside a Worker's request budget
const FIRST_SYNC_DAYS = 14;
/** One sync job's time for messages (a job has 60 s; the provider calls each wait up to their timeout). */
const JOB_BUDGET_MS = 40_000;
/** Mailboxes queued per `crm-sync` run, the ones synced longest ago first; the rest go next time. */
const QUEUE_PER_RUN = 20;
const SLOT_MS = 5 * 60_000;

const b64urlToText = (data: string) => new TextDecoder().decode(fromB64(data.replace(/-/g, '+').replace(/_/g, '/')));

type GmailPart = {mimeType: string; body?: {data?: string}; parts?: GmailPart[]; headers?: {name: string; value: string}[]};

function gmailBodies(part: GmailPart, out: {html?: string; text?: string} = {}) {
  if (part.mimeType === 'text/html' && part.body?.data && !out.html) out.html = b64urlToText(part.body.data);
  if (part.mimeType === 'text/plain' && part.body?.data && !out.text) out.text = b64urlToText(part.body.data);
  for (const p of part.parts ?? []) gmailBodies(p, out);
  return out;
}

async function syncGmail(db: Db, account: EmailAccount, creds: OAuthCreds, deadline: number) {
  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const q = `after:${Math.floor(since.getTime() / 1000) - 60} -in:chats -in:spam -in:trash`;
  const auth = {authorization: `Bearer ${creds.accessToken}`};
  const listRes = await fetchOut(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_PER_RUN}&q=${encodeURIComponent(q)}`, {headers: auth});
  const list = (await listRes.json()) as {
    messages?: {id: string; threadId: string}[];
    error?: {message: string; code?: number};
  };
  if (list.error || !listRes.ok) throw new MailboxCallError(`Gmail: ${list.error?.message ?? listRes.statusText}`, listRes.ok ? (list.error?.code ?? 400) : listRes.status);

  let stored = 0;
  let newest = since;
  let more = (list.messages?.length ?? 0) >= MAX_PER_RUN;
  const known = await knownIds(db, account.id, (list.messages ?? []).map((m) => m.id));
  for (const {id} of [...(list.messages ?? [])].reverse()) {
    if (known.has(id)) continue;
    // Out of time: the rest is fetched next time, from the newest message stored.
    if (Date.now() > deadline) {
      more = true;
      break;
    }
    const msg = (await (await fetchOut(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {headers: auth})).json()) as {
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
  return {stored, newest, more};
}

/** Messages of this mailbox already stored, in one query. */
async function knownIds(db: Db, accountId: string, externalIds: string[]) {
  if (!externalIds.length) return new Set<string>();
  const rows = await db.emailMessage.findMany({where: {accountId, externalId: {in: externalIds}}, select: {externalId: true}});
  return new Set(rows.map((r) => r.externalId!));
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

async function syncOutlook(db: Db, account: EmailAccount, creds: OAuthCreds, deadline: number) {
  const since = account.lastSyncedAt ?? new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${new Date(since.getTime() - 60_000).toISOString()}`,
    $orderby: 'receivedDateTime asc',
    $top: String(MAX_PER_RUN),
    $select: 'id,conversationId,subject,internetMessageId,receivedDateTime,from,toRecipients,ccRecipients,body',
  });
  const graphRes = await fetchOut(`https://graph.microsoft.com/v1.0/me/messages?${params}`, {headers: {authorization: `Bearer ${creds.accessToken}`}});
  const res = (await graphRes.json()) as {
    value?: GraphMessage[];
    error?: {message: string};
  };
  if (res.error || !graphRes.ok) throw new MailboxCallError(`Microsoft Graph: ${res.error?.message ?? graphRes.statusText}`, graphRes.ok ? 400 : graphRes.status);

  const addr = (a: {emailAddress: {address: string; name: string}}) => ({email: a.emailAddress.address.toLowerCase(), name: a.emailAddress.name});
  let stored = 0;
  let newest = since;
  let more = (res.value?.length ?? 0) >= MAX_PER_RUN;
  const known = await knownIds(db, account.id, (res.value ?? []).map((m) => m.id));
  for (const m of res.value ?? []) {
    if (Date.now() > deadline) {
      more = true;
      break;
    }
    const date = new Date(m.receivedDateTime);
    if (date > newest) newest = date;
    if (known.has(m.id)) continue;
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
  return {stored, newest, more};
}

async function syncAccount(db: Db, account: EmailAccount, {deadline = Date.now() + JOB_BUDGET_MS}: {deadline?: number} = {}) {
  // SMTP and API accounts only send; their replies arrive through the inbound webhook (Reply-To).
  if (account.provider !== 'GMAIL' && account.provider !== 'OUTLOOK') return {stored: 0, skipped: true};
  try {
    const creds = (await accountCredentials(db, account)) as OAuthCreds;
    const r = account.provider === 'GMAIL' ? await syncGmail(db, account, creds, deadline) : await syncOutlook(db, account, creds, deadline);
    await db.emailAccount.update({where: {id: account.id}, data: {lastSyncedAt: r.newest, status: 'CONNECTED', lastError: null}});
    return {stored: r.stored, more: r.more};
  } catch (e) {
    // The provider's text only in the log; the account shows it in words.
    logMailboxError(`sync ${account.provider}`, e);
    const error = mailboxErrorText(e);
    await db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR', lastError: error}});
    return {stored: 0, error};
  }
}

/** `email.sync_account` job: one mailbox, within its own job's time. */
export async function syncAccountJob(db: Db, accountId: string) {
  const account = await db.emailAccount.findUnique({where: {id: accountId}});
  if (!account) return; // removed since it was queued
  await syncAccount(db, account);
}

/** Queues one mailbox's sync now ("Sync now"): a keyed job per minute, so a double click queues it once. */
export async function queueAccountSync(db: Db, accountId: string): Promise<void> {
  await enqueue(db, 'email.sync_account', {accountId}, {key: `sync-${accountId}-m${Math.floor(Date.now() / 60_000)}`});
}

/**
 * From `crm-sync` (every 5 minutes): one job per Gmail / Outlook mailbox, keyed per 5-minute slot,
 * the ones synced longest ago first. Mailboxes whose job still waits here (for the job rate) are
 * not queued again.
 */
export async function queueMailboxSyncs(db: Db) {
  const slot = Math.floor(Date.now() / SLOT_MS);
  const waiting = await db.jobBacklog.findMany({where: {list: 'crm-email-sync-account', failedAt: null}, select: {data: true}, take: 500});
  const skip = waiting.map((w) => String((w.data as {accountId?: unknown})?.accountId ?? '')).filter(Boolean);
  const accounts = await db.emailAccount.findMany({
    where: {provider: {in: ['GMAIL', 'OUTLOOK']}, ...(skip.length ? {id: {notIn: skip}} : {})},
    orderBy: {lastSyncedAt: {sort: 'asc', nulls: 'first'}},
    take: QUEUE_PER_RUN,
    select: {id: true},
  });
  for (const a of accounts) await enqueue(db, 'email.sync_account', {accountId: a.id}, {key: `sync-${a.id}-${slot}`});
  return {queued: accounts.length};
}
