import type {EmailAccount, EmailThread, Ticket} from '../../../generated/prisma/client';
import {SUBJECT_TOKEN, ticketRef} from '@/lib/tickets';
import type {Db} from '../kit/db';
import {htmlToText} from '../email/render';
import type {IncomingMessage} from '../email/service';
import {logActivity} from './activity';
import {emit} from './events';
import {changeStatus, contactForEmail, createTicket, customerReply, getTicketSettings} from './tickets';
import {teamAddresses} from './users';

const baseSubject = (s: string) =>
  s.replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').replace(SUBJECT_TOKEN, '').replace(/\s{2,}/g, ' ').trim() || '(no subject)';

/** Bounces and out-of-office replies never open or reopen tickets. */
const automated = (m: IncomingMessage) =>
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)[@+]/i.test(m.from.email) ||
  /^\s*(auto(matic)?[ -]?reply|out of (the )?office|undeliver(able|ed)|delivery status notification|mail delivery (failed|subsystem))/i.test(m.subject);

/** Drops the quoted history under a reply ("On … wrote:", "> …", Outlook's "From:" block). */
export function stripQuoted(text: string) {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^>/.test(line)) continue;
    if (/^On .{4,300}wrote:$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) || /^_{8,}$/.test(line) || (out.length > 0 && /^From:\s.+@/.test(line))) break;
    out.push(raw);
  }
  return out.join('\n').trim() || text.trim();
}

async function storeEmail(db: Db, account: EmailAccount | null, thread: EmailThread, m: IncomingMessage, outbound: boolean, contactId: string | null) {
  const at = m.date ?? new Date();
  const message = await db.emailMessage.create({
    data: {
      threadId: thread.id,
      accountId: account?.id,
      direction: outbound ? 'OUTBOUND' : 'INBOUND',
      status: outbound ? 'SENT' : 'RECEIVED',
      fromEmail: m.from.email.toLowerCase(),
      fromName: m.from.name,
      to: m.to.map((a) => a.email),
      cc: m.cc.map((a) => a.email),
      subject: m.subject || '(no subject)',
      html: m.html,
      text: m.text ?? (m.html ? htmlToText(m.html) : null),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      externalId: m.externalId,
      contactId,
      sentAt: at,
    },
  });
  // Ticket mail is worked from the ticket, so it doesn't light up the shared inbox.
  await db.emailThread.update({where: {id: thread.id}, data: {lastMessageAt: at, externalThreadId: thread.externalThreadId ?? m.externalThreadId}});
  return message;
}

/**
 * Routes a received or synced email into the ticket system, called first thing
 * in `ingestMessage()`. Replies thread into their ticket by reply headers, then
 * by a `[#1042]` subject token (only from that ticket's contact or the team);
 * other mail to the support address opens a ticket. Returns the stored
 * EmailMessage, or null to let normal email ingestion handle the message.
 */
export async function routeTicketEmail(db: Db, account: EmailAccount | null, m: IncomingMessage) {
  const from = m.from?.email?.toLowerCase();
  if (!from) return null;
  // Already stored, e.g. our own replies coming back through a synced Sent folder.
  if (m.messageId && (await db.emailMessage.findFirst({where: {messageId: m.messageId}, select: {id: true}}))) return null;
  if (account && m.externalId && (await db.emailMessage.findFirst({where: {accountId: account.id, externalId: m.externalId}, select: {id: true}}))) return null;

  const settings = await getTicketSettings(db);
  const support = settings.supportEmail.trim().toLowerCase();
  if (support && from === support) return null;
  const recipients = [...m.to, ...m.cc].map((a) => a.email.toLowerCase());
  const toSupport = !!support && (recipients.includes(support) || account?.fromEmail.toLowerCase() === support);

  // 1. Reply headers: the newest ticket whose email thread holds the parent message.
  const refs = [m.inReplyTo, ...(m.references ?? [])].filter(Boolean) as string[];
  let ticket: Ticket | null = null;
  if (refs.length) {
    const parents = await db.emailMessage.findMany({where: {messageId: {in: refs}}, select: {threadId: true}});
    if (parents.length) ticket = await db.ticket.findFirst({where: {emailThreadId: {in: parents.map((p) => p.threadId)}}, orderBy: {createdAt: 'desc'}});
  }
  const teamEmails = new Set([
    ...(await teamAddresses(db)),
    ...(await db.emailAccount.findMany({select: {fromEmail: true}})).map((a) => a.fromEmail.toLowerCase()),
  ]);
  const fromTeam = teamEmails.has(from);

  // 2. Subject token, trusted only from the ticket's own contact or the team.
  if (!ticket) {
    const n = m.subject.match(SUBJECT_TOKEN)?.[1];
    const byNumber = n ? await db.ticket.findUnique({where: {number: Number(n)}, include: {contact: {select: {email: true}}}}) : null;
    if (byNumber && (fromTeam || byNumber.contact?.email?.toLowerCase() === from)) ticket = byNumber;
  }

  if (!ticket && !toSupport) return null;
  if (automated(m) && !fromTeam) return null;
  if (!ticket && fromTeam) return null; // the team writing to the support address isn't a request

  const text = (m.text ?? (m.html ? htmlToText(m.html) : '')).trim();
  const body = stripQuoted(text);
  const at = m.date ?? new Date();

  // Replies into an open (or resolved) ticket.
  if (ticket && !(ticket.status === 'CLOSED' && !fromTeam)) {
    const thread =
      (ticket.emailThreadId ? await db.emailThread.findUnique({where: {id: ticket.emailThreadId}}) : null) ??
      (await db.emailThread.create({data: {subject: ticket.subject, accountId: account?.id, contactId: ticket.contactId, companyId: ticket.companyId, dealId: ticket.dealId, channel: 'ticket'}}));
    if (ticket.emailThreadId !== thread.id) ticket = await db.ticket.update({where: {id: ticket.id}, data: {emailThreadId: thread.id}});
    const message = await storeEmail(db, account, thread, m, fromTeam, ticket.contactId);

    if (!fromTeam) {
      await customerReply(db, ticket, {body, via: 'email', fromEmail: from, fromName: m.from.name, emailMessageId: message.id, at});
      return message;
    }
    // A teammate answered from their own mail client: a public reply by them.
    const user = await db.member.findFirst({where: {user: {email: from.toLowerCase()}}});
    const reply = await db.ticketMessage.create({
      data: {ticketId: ticket.id, kind: 'reply', direction: 'OUTBOUND', via: 'email', body, authorId: user?.id, fromEmail: from, fromName: m.from.name, emailMessageId: message.id, data: {emailed: true}, createdAt: at},
    });
    ticket = await db.ticket.update({where: {id: ticket.id}, data: {lastMessageAt: at, firstResponseAt: ticket.firstResponseAt ?? at}});
    await logActivity(db, {
      type: 'ticket_reply',
      title: `Replied on ticket ${ticketRef(ticket.number)}`,
      refId: reply.id,
      actorId: user?.id,
      contactId: ticket.contactId,
      companyId: ticket.companyId,
      dealId: ticket.dealId,
      data: {ticketId: ticket.id, number: ticket.number, subject: ticket.subject, status: ticket.status, direction: 'OUTBOUND', body: body.slice(0, 600)},
      text: body,
      at,
    });
    await emit(db, 'ticket.replied', {recordId: ticket.id, actorId: user?.id, data: {ticket, message: reply}});
    if (ticket.status === 'NEW' || ticket.status === 'WAITING_ON_US') await changeStatus(db, ticket, 'WAITING_ON_CONTACT', user ? {id: user.id, name: user.name} : null, {quiet: true});
    return message;
  }

  // A new request (or a reply to a closed ticket, which starts a follow-up).
  const contact = await contactForEmail(db, from, m.from.name);
  const thread = await db.emailThread.create({
    data: {subject: baseSubject(m.subject), accountId: account?.id, externalThreadId: m.externalThreadId, contactId: contact.id, companyId: contact.companies[0]?.companyId, channel: 'ticket'},
  });
  const message = await storeEmail(db, account, thread, m, false, contact.id);
  await createTicket(db, {
    subject: baseSubject(m.subject),
    description: ticket ? `Follow-up to ${ticketRef(ticket.number)}\n\n${body}` : body,
    source: 'EMAIL',
    contactId: contact.id,
    companyId: contact.companies[0]?.companyId ?? ticket?.companyId,
    dealId: ticket?.dealId,
    category: ticket?.category,
    queue: ticket?.queue,
    emailThreadId: thread.id,
    at,
  });
  return message;
}
