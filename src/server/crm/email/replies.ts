import type {EmailAccount} from '../../../generated/prisma/client';
import {config} from '../kit/config';
import type {Db} from '../kit/db';
import {escapeHtml} from '@/lib/email-html';
import {parseAddressList, stripAngle, type Address} from './mime';
import {accountCredentials} from './oauth';
import {fetchResendReceived, type ResendCreds} from './providers';
import {enqueue, kickJobs} from '../lib/jobs';
import {getSettings} from '../lib/settings';
import {ingestMessage, sendSystemEmail, type IncomingMessage} from './service';

/** The SMTP / API account whose Reply-To address received this email, if any. */
export async function accountForReply(db: Db, recipients: Address[]): Promise<EmailAccount | null> {
  const emails = [...new Set(recipients.map((a) => a.email.toLowerCase()))];
  if (!emails.length) return null;
  return db.emailAccount.findFirst({where: {replyTo: {in: emails, mode: 'insensitive'}}});
}

/**
 * Resend Receiving posts `{type: 'email.received', data: {email_id, to, …}}`.
 * The body is fetched with the API key of the Resend account it was sent to
 * (falling back to any Resend account), which also proves the event is real.
 */
export async function resendIncoming(db: Db, data: {email_id?: string; to?: string[]}) {
  if (!data.email_id) return null;
  const to = (data.to ?? []).flatMap((t) => parseAddressList(t));
  const preferred = await accountForReply(db, to);
  const accounts = [
    ...(preferred?.provider === 'RESEND' ? [preferred] : []),
    ...(await db.emailAccount.findMany({where: {provider: 'RESEND', id: {not: preferred?.id ?? ''}}, orderBy: {createdAt: 'asc'}})),
  ];
  for (const account of accounts) {
    try {
      const e = await fetchResendReceived((await accountCredentials(db, account)) as ResendCreds, data.email_id);
      const h = Object.fromEntries(Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const message: IncomingMessage = {
        from: parseAddressList(e.from)[0] ?? {email: 'unknown@unknown'},
        to: e.to.flatMap((t) => parseAddressList(t)),
        cc: (e.cc ?? []).flatMap((t) => parseAddressList(t)),
        subject: e.subject ?? '',
        html: e.html,
        text: e.text,
        messageId: stripAngle(e.message_id ?? h['message-id']),
        inReplyTo: stripAngle(h['in-reply-to']),
        references: (h.references ?? '').split(/\s+/).map(stripAngle).filter(Boolean) as string[],
        externalId: `resend:${e.id}`,
        date: e.created_at ? new Date(e.created_at) : undefined,
      };
      return {message, account: preferred ?? account};
    } catch {
      // Not this account's email (or the key can't read receiving); try the next one.
    }
  }
  return null;
}

/**
 * Job "email.forward_reply": a reply that arrived on the inbound webhook never
 * reaches the rep's own mailbox, so (when the account asks for it) a copy is
 * forwarded to the rep who sent the last email in the thread, or the account
 * owner. Reply-To is the contact, so answering from the mail client works.
 */
export async function forwardReply(db: Db, messageId: string, origin = '') {
  const m = await db.emailMessage.findUnique({where: {id: messageId}, include: {account: {include: {user: {include: {user: {select: {email: true}}}}}}, thread: true}});
  if (!m || m.direction !== 'INBOUND' || !m.account?.forwardReplies) return;
  const last = await db.emailMessage.findFirst({
    where: {threadId: m.threadId, direction: 'OUTBOUND', senderId: {not: null}},
    orderBy: {sentAt: 'desc'},
    include: {sender: {select: {active: true, user: {select: {email: true}}}}},
  });
  const to = (last?.sender?.active ? last.sender.user?.email : null) ?? m.account.user?.user?.email ?? null;
  // Never forward to the inbound address itself (that would loop back here).
  if (!to || to.toLowerCase() === m.account.replyTo?.toLowerCase()) return;

  const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
  const link = `${config.siteUrl() || origin}/inbox?thread=${m.threadId}`;
  const note = `Reply from ${from}, logged in the CRM: ${link}`;
  await sendSystemEmail(db, {
    to: [to],
    subject: `Fwd: ${m.subject}`,
    text: `${note}\n\n---------- Forwarded message ----------\n${m.text ?? ''}`,
    html: m.html
      ? `<p style="font-family:Arial,sans-serif;font-size:13px;color:#475569">${escapeHtml(note)}</p><hr style="border:none;border-top:1px solid #e2e8f0">${m.html}`
      : null,
    replyTo: m.fromEmail,
  });
}

/**
 * Stores one received email the way the inbound webhook does: drops the BCC
 * logging address, matches the account by its Reply-To address, ingests it,
 * and queues the copy to the rep when the account forwards replies.
 */
export async function receiveInbound(db: Db, parsed: IncomingMessage, opts: {origin: string; account?: EmailAccount | null; forward?: boolean}) {
  const settings = await getSettings(db);
  if (settings.bccAddress) {
    const bcc = settings.bccAddress.toLowerCase();
    parsed.to = parsed.to.filter((a) => a.email !== bcc);
    parsed.cc = parsed.cc.filter((a) => a.email !== bcc);
  }
  const account = opts.account ?? (await accountForReply(db, [...parsed.to, ...parsed.cc]));
  const message = await ingestMessage(db, account, parsed);
  if (message?.direction === 'INBOUND' && account?.forwardReplies && opts.forward !== false) {
    await enqueue(db, 'email.forward_reply', {messageId: message.id, origin: opts.origin}, {maxAttempts: 3});
    kickJobs();
  }
  return message;
}
