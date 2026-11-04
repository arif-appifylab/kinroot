import {HTTPException} from 'hono/http-exception';

import type {EmailAccount} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {config} from '../kit/config';
import {randomToken} from '../kit/crypto';
import type {Db} from '../kit/db';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {notify, notifyWatchers} from '../lib/notify';
import {routeTicketEmail} from '../lib/ticket-mail';
import {conversationLink} from '../inbox/conversations';
import {onInbound, onOutbound} from '../inbox/routing';
import {cleanReceivedHtml, MAX_RECEIVED_HTML} from '../inbox/sanitize';
import {feedsTeamInbox, inboxContext} from '../inbox/settings';
import {unsubscribeUrl} from '../lib/unsubscribe';
import {composeEmail, systemEmailHtml} from './design';
import {type Address, type Attachment, newMessageId} from './mime';
import {accountCredentials} from './oauth';
import {deliver, isReservedAddress, reachesReserved} from './providers';
import {addTracking, htmlToText, mergeFields, textToHtml} from './render';
import {teamAddresses} from '../lib/users';

export type SendInput = {
  accountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string | null; // plain text; merge fields allowed
  html?: string | null; // editor HTML (rich composer / templates); wins over `body`
  layout?: 'branded' | 'plain'; // default plain: one-to-one emails look personal
  preheader?: string | null;
  threadId?: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  replyTo?: string;
  /** For a new thread: 'ticket' keeps it out of the inbox (tickets.ts); default 'email'. */
  channel?: string;
};

/** Accounts a user may send from: their own plus shared team accounts. */
export async function usableAccounts(db: Db, user: Pick<User, 'id'>) {
  return db.emailAccount.findMany({
    where: {OR: [{userId: user.id}, {userId: null}]},
    orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}],
  });
}

export async function sendEmail(db: Db, me: Pick<User, 'id' | 'name' | 'role'>, origin: string, input: SendInput) {
  const accounts = await usableAccounts(db, me);
  const account = input.accountId ? accounts.find((a) => a.id === input.accountId) : accounts.find((a) => a.userId === me.id && a.isDefault) ?? accounts[0];
  if (!account) throw new HTTPException(400, {message: 'Connect an email account in Settings → Email first'});

  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((e) => e.toLowerCase());
  const optedOut = await db.contact.findMany({where: {email: {in: recipients}, emailOptOut: true}, select: {email: true}});
  if (optedOut.length) throw new HTTPException(400, {message: `${optedOut.map((c) => c.email).join(', ')} opted out of email`});
  const reserved = reachesReserved(account.provider) ? [] : recipients.filter(isReservedAddress);
  if (reserved.length) throw new HTTPException(400, {message: `${reserved.join(', ')} can't receive email: example.com and .test addresses are for testing only`});

  const sentToday = await db.emailMessage.count({where: {accountId: account.id, direction: 'OUTBOUND', sentAt: {gte: new Date(Date.now() - 86400_000)}}});
  if (sentToday >= account.dailyLimit) throw new HTTPException(429, {message: `Daily limit of ${account.dailyLimit} emails reached for ${account.fromEmail}`});

  // Thread + reply headers
  const thread = input.threadId ? await db.emailThread.findUnique({where: {id: input.threadId}}) : null;
  const previous = thread
    ? await db.emailMessage.findMany({where: {threadId: thread.id, messageId: {not: null}}, orderBy: {sentAt: 'asc'}, select: {messageId: true}})
    : [];
  const references = previous.map((p) => p.messageId!);

  // Who is this for?
  const contact = input.contactId
    ? await db.contact.findUnique({where: {id: input.contactId}, include: {companies: {include: {company: true}, orderBy: {isPrimary: 'desc'}, take: 1}}})
    : await db.contact.findFirst({where: {email: input.to[0]?.toLowerCase()}, include: {companies: {include: {company: true}, orderBy: {isPrimary: 'desc'}, take: 1}}});
  const deal = input.dealId ? await db.deal.findUnique({where: {id: input.dealId}}) : thread?.dealId ? await db.deal.findUnique({where: {id: thread.dealId}}) : null;
  const company = input.companyId
    ? await db.company.findUnique({where: {id: input.companyId}})
    : contact?.companies[0]?.company ?? (deal?.companyId ? await db.company.findUnique({where: {id: deal.companyId}}) : null);

  const ctx = {contact, company, deal, me: {name: me.name, email: account.fromEmail}, unsubscribeUrl: contact ? await unsubscribeUrl(origin, contact.id) : null};
  const subject = mergeFields(input.subject, ctx);
  // Merge fields → signature → layout, then tracking. The text part comes from the untracked HTML.
  const composed = await composeEmail(db, {html: input.html, text: input.body, layout: input.layout ?? 'plain', preheader: input.preheader, ctx, account, origin});
  const bodyText = composed.content; // what the CRM shows (no layout header / footer)
  const trackingId = randomToken(16);
  const html = await addTracking(composed.html, trackingId, origin, {opens: account.trackOpens, clicks: account.trackClicks});
  const messageId = newMessageId(account.fromEmail);

  const t =
    thread ??
    (await db.emailThread.create({
      data: {subject, accountId: account.id, contactId: contact?.id, companyId: company?.id, dealId: deal?.id, channel: input.channel ?? 'email'},
    }));

  const message = await db.emailMessage.create({
    data: {
      threadId: t.id,
      accountId: account.id,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      fromEmail: account.fromEmail,
      fromName: account.fromName,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject,
      html,
      text: bodyText,
      messageId,
      inReplyTo: references.at(-1) ?? null,
      trackingId,
      senderId: me.id,
      contactId: contact?.id,
    },
  });

  try {
    const creds = await accountCredentials(db, account);
    const result = await deliver(
      account.provider,
      creds,
      {
        from: {email: account.fromEmail, name: account.fromName},
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        // Tickets reply-to the support address; otherwise the provider's inbound address when one is set.
        replyTo: input.replyTo ?? account.replyTo ?? undefined,
        subject,
        html,
        text: composed.text,
        messageId,
        inReplyTo: references.at(-1),
        references,
      },
      {externalThreadId: t.externalThreadId},
    );
    await db.emailMessage.update({where: {id: message.id}, data: {status: 'SENT', externalId: result.externalId, sentAt: new Date()}});
    await db.emailThread.update({
      where: {id: t.id},
      data: {lastMessageAt: new Date(), externalThreadId: result.externalThreadId ?? t.externalThreadId},
    });
    await onOutbound(db, t.id, new Date()); // shared inbox: answered, first response time
    if (account.status !== 'CONNECTED') await db.emailAccount.update({where: {id: account.id}, data: {status: 'CONNECTED', lastError: null}});
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    await db.emailMessage.update({where: {id: message.id}, data: {status: 'FAILED', error}});
    await db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR', lastError: error}});
    throw new HTTPException(502, {message: `Email not sent: ${error}`});
  }

  await logActivity(db, {
    type: 'email_out',
    title: `Email sent: ${subject}`,
    refId: message.id,
    actorId: me.id,
    contactId: contact?.id,
    companyId: company?.id,
    dealId: deal?.id ?? t.dealId,
    text: `${subject}\n${bodyText}`,
  });
  const sent = await db.emailMessage.findUnique({where: {id: message.id}});
  await emit(db, 'email.sent', {recordId: message.id, actorId: me.id, data: {...sent, html: undefined, contactId: contact?.id ?? null, dealId: deal?.id ?? t.dealId}});
  return sent;
}

// ─── Inbound / synced messages ──────────────────────────────────────────────

export type IncomingMessage = {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  html?: string | null;
  text?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  externalId?: string | null;
  externalThreadId?: string | null;
  date?: Date;
};

const baseSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').trim() || '(no subject)';

/**
 * Stores a received or BCC-logged email if it involves a known contact (the
 * CRM never hoovers up unrelated mail), or when it was sent to a shared
 * account that feeds the team inbox (Settings → Inbox), where unknown senders
 * start conversations too. Returns null when it was skipped.
 */
export async function ingestMessage(db: Db, account: EmailAccount | null, incoming: IncomingMessage) {
  // Received HTML is capped and cleaned once, here, for every path that stores it (ticket mail too),
  // so reading it later costs nothing and a crafted message can't hold the CPU on every open.
  const m: IncomingMessage = {
    ...incoming,
    html: await cleanReceivedHtml(incoming.html),
    text: incoming.text && incoming.text.length > MAX_RECEIVED_HTML ? incoming.text.slice(0, MAX_RECEIVED_HTML) : incoming.text,
  };
  const ticketMail = await routeTicketEmail(db, account, m); // support address / ticket replies (src/server/lib/ticket-mail.ts)
  if (ticketMail) return ticketMail;
  if (m.messageId && (await db.emailMessage.findFirst({where: {messageId: m.messageId}, select: {id: true}}))) return null;
  if (account && m.externalId && (await db.emailMessage.findFirst({where: {accountId: account.id, externalId: m.externalId}, select: {id: true}}))) return null;

  const teamEmails = new Set([
    ...(await teamAddresses(db)),
    ...(await db.emailAccount.findMany({select: {fromEmail: true}})).map((a) => a.fromEmail.toLowerCase()),
  ]);
  const outbound = teamEmails.has(m.from.email.toLowerCase());
  const others = (outbound ? [...m.to, ...m.cc] : [m.from]).map((a) => a.email.toLowerCase()).filter((e) => !teamEmails.has(e));

  // Thread match: reply headers → provider thread id → none.
  const refs = [m.inReplyTo, ...(m.references ?? [])].filter(Boolean) as string[];
  const parent = refs.length ? await db.emailMessage.findFirst({where: {messageId: {in: refs}}, include: {thread: true}}) : null;
  let thread =
    parent?.thread ??
    (account && m.externalThreadId ? await db.emailThread.findFirst({where: {accountId: account.id, externalThreadId: m.externalThreadId}}) : null);

  const contact = others.length
    ? await db.contact.findFirst({where: {email: {in: others}}, include: {companies: {orderBy: {isPrimary: 'desc'}, take: 1}}})
    : null;
  const inbox = await inboxContext(db);
  const teamMail = !outbound && others.length > 0 && feedsTeamInbox(inbox, account);
  if (!contact && !thread && !teamMail) return null;

  if (!thread) {
    const openDeal = contact ? await db.deal.findFirst({where: {status: 'OPEN', contacts: {some: {contactId: contact.id}}}, orderBy: {lastActivityAt: 'desc'}, select: {id: true}}) : null;
    thread = await db.emailThread.create({
      data: {
        subject: baseSubject(m.subject),
        accountId: account?.id,
        externalThreadId: m.externalThreadId,
        contactId: contact?.id,
        companyId: contact?.companies[0]?.companyId,
        dealId: openDeal?.id,
      },
    });
  }

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
      contactId: contact?.id ?? thread.contactId,
      sentAt: at,
    },
  });
  await db.emailThread.update({where: {id: thread.id}, data: {lastMessageAt: at, unread: !outbound || thread.unread}});
  // Shared inbox: open / reopen, assignment, blocked senders → Spam (src/server/inbox/routing.ts).
  const routed = outbound ? (await onOutbound(db, thread.id, at), null) : await onInbound(db, thread, message, inbox);
  await logActivity(db, {
    type: outbound ? 'email_out' : 'email_in',
    title: outbound ? `Email sent: ${message.subject}` : `Email received: ${message.subject}`,
    refId: message.id,
    contactId: message.contactId,
    companyId: thread.companyId,
    dealId: thread.dealId,
    at,
    text: `${message.subject}\n${message.text ?? ''}`,
  });
  if (!outbound) {
    await emit(db, 'email.received', {recordId: message.id, data: {...message, html: undefined, dealId: thread.dealId, companyId: thread.companyId}});
    if (routed?.spam) return message; // Spam (blocked sender): nobody is notified
    // The rep who sent the last email in this thread hears about the reply even
    // when they don't own or follow the record, and so does the conversation's
    // assignee (a brand-new one was just told it was assigned); watchers get it
    // once, minus them.
    const lastSent = await db.emailMessage.findFirst({where: {threadId: thread.id, direction: 'OUTBOUND', senderId: {not: null}}, orderBy: {sentAt: 'desc'}, select: {senderId: true}});
    const sender = lastSent?.senderId ?? null;
    const assignee = routed && !routed.isNew ? routed.thread.assigneeId : null;
    const told = [...new Set([sender, assignee].filter((id): id is string => !!id))];
    if (told.length) {
      await notify(db, told, {
        type: 'email_in',
        title: `${m.from.name || m.from.email} replied: ${message.subject}`,
        body: message.text?.slice(0, 300),
        link: conversationLink(thread.id),
      });
    }
    await notifyWatchers(db, {contactId: message.contactId, dealId: thread.dealId}, {
      type: 'email_in',
      title: `Email from ${m.from.name || m.from.email}: ${message.subject}`,
      body: message.text?.slice(0, 300),
      except: told,
    });
  }
  return message;
}

// ─── System email (team notifications) ──────────────────────────────────────

/**
 * Sends a plain notification email (no tracking, no timeline entry) from a
 * shared team account, else any connected account. Returns false when no
 * account can send, so callers can fall back to in-app notifications.
 */
export async function sendSystemEmail(db: Db, input: {to: string[]; subject: string; text: string; html?: string | null; replyTo?: string | null; attachments?: Attachment[]}) {
  const account = await systemAccount(db);
  if (!account) return false;
  // Test addresses (demo users, seed data) are skipped instead of failing the whole send.
  const to = reachesReserved(account.provider) ? input.to : input.to.filter((e) => !isReservedAddress(e));
  if (!to.length) return false;
  const creds = await accountCredentials(db, account);
  await deliver(account.provider, creds, {
    from: {email: account.fromEmail, name: account.fromName},
    to,
    subject: input.subject,
    html: input.html ?? (await systemEmailHtml(db, input.text, config.siteUrl() ?? '')),
    text: input.text,
    messageId: newMessageId(account.fromEmail),
    replyTo: input.replyTo ?? undefined,
    attachments: input.attachments,
  });
  return true;
}

/** The account system email goes out from: a shared team account, else any connected one (null = none). */
export async function systemAccount(db: Db) {
  return (
    (await db.emailAccount.findFirst({where: {userId: null, status: {not: 'ERROR'}}, orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}]})) ??
    (await db.emailAccount.findFirst({where: {status: 'CONNECTED'}, orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}]}))
  );
}
