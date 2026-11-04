import {HTTPException} from 'hono/http-exception';

import type {EmailAccount, Prisma, Ticket, TicketPriority, TicketSource, TicketStatus} from '../../../generated/prisma/client';
import {cache} from '../../../platform/cache';
import type {User} from '../kit/guards';
import {defaultTicketSettings, isOpenStatus, STATUS, subjectToken, ticketRef, type TicketSettings} from '@/lib/tickets';
import {config} from '../kit/config';
import {sign, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import type {AppContext} from '../kit/guards';
import {escapeHtml} from '@/lib/email-html';
import {mergeFields} from '../email/render';
import {sendEmail, sendSystemEmail, usableAccounts} from '../email/service';
import {publicFileUrl} from '../routes/files';
import {logActivity} from './activity';
import {associateByDomain} from './domains';
import {emit} from './events';
import {ownerScope} from './http';
import {enqueue, kickJobs} from './jobs';
import {notify, notifyMentions} from './notify';
import {richBody} from './rich-text';
import {getSettings} from './settings';
import {scheduleSla, slaDueDates} from './ticket-sla';
import {userSelect} from './users';

// ─── Settings ───────────────────────────────────────────────────────────────

const KEY = 'tickets';
/** Site Cache key (docs/agent/cache.md): read by the support pages and every ticket action, cleared on save. */
const CACHE_KEY = 'crm:ticket-settings';

async function readTicketSettings(db: Db): Promise<TicketSettings> {
  const row = await db.setting.findUnique({where: {key: KEY}, select: {value: true}});
  const stored = (row?.value ?? {}) as Partial<TicketSettings>;
  const d = defaultTicketSettings();
  return {
    ...d,
    ...stored,
    sla: {...d.sla, ...stored.sla, businessHours: {...d.sla.businessHours, ...stored.sla?.businessHours}, targets: {...d.sla.targets, ...stored.sla?.targets}},
  };
}

/** Ticket settings, from the Site Cache (a day; `saveTicketSettings` clears it right after writing). */
export function getTicketSettings(db: Db): Promise<TicketSettings> {
  return cache.getOrSet(CACHE_KEY, 86_400, () => readTicketSettings(db));
}

export async function saveTicketSettings(db: Db, patch: Partial<TicketSettings>) {
  // Merged onto the stored row, never onto a cached copy.
  const value = {...(await readTicketSettings(db)), ...patch} as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value}, update: {value}});
  await cache.del(CACHE_KEY);
}

// ─── Shared shapes ──────────────────────────────────────────────────────────

export const ticketInclude = {
  assignee: {select: userSelect},
  contact: {select: {id: true, firstName: true, lastName: true, email: true, phone: true, title: true, emailOptOut: true}},
  company: {select: {id: true, name: true, domain: true}},
  deal: {select: {id: true, title: true, status: true, value: true, currency: true}},
} as const;

export const ticketLink = (t: Pick<Ticket, 'number'>) => `/tickets/${t.number}`;

/** `/tickets/1042` or a cuid. */
export const ticketRefWhere = (ref: string): Prisma.TicketWhereUniqueInput => (/^\d{1,9}$/.test(ref) ? {number: Number(ref)} : {id: ref});

/** With "members see only their own", members see tickets assigned to them and unassigned ones. */
export async function ticketScope(c: AppContext): Promise<Prisma.TicketWhereInput> {
  const scope = await ownerScope(c);
  return scope.ownerId ? {OR: [{assigneeId: scope.ownerId}, {assigneeId: null}]} : {};
}

const contactName = (c: {firstName: string; lastName: string | null} | null | undefined) => (c ? [c.firstName, c.lastName].filter(Boolean).join(' ') : null);

/** Who hears about unassigned tickets: the configured list, else admins. */
export async function ticketTeam(db: Db, settings: TicketSettings) {
  if (settings.notifyUserIds.length) return settings.notifyUserIds;
  return (await db.member.findMany({where: {active: true, role: {in: ['OWNER', 'ADMIN']}}, select: {id: true}})).map((u) => u.id);
}

async function notifyTicket(db: Db, ticket: Ticket, input: {title: string; body?: string | null; actorId?: string | null; type?: 'ticket' | 'assigned'}) {
  const ids = ticket.assigneeId ? [ticket.assigneeId] : await ticketTeam(db, await getTicketSettings(db));
  await notify(db, ids, {type: input.type ?? 'ticket', title: input.title, body: input.body, link: ticketLink(ticket), actorId: input.actorId});
}

const activityLink = (t: Ticket) => ({contactId: t.contactId, companyId: t.companyId, dealId: t.dealId});
const activityData = (t: Ticket, extra: Record<string, unknown> = {}) => ({ticketId: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, ...extra});

// ─── Contacts by email ──────────────────────────────────────────────────────

/** Finds the contact with this email or creates one (source "Support"). */
export async function contactForEmail(db: Db, email: string, name?: string | null) {
  const address = email.trim().toLowerCase();
  const existing = await db.contact.findFirst({where: {email: {equals: address, mode: 'insensitive'}}, include: {companies: {orderBy: {isPrimary: 'desc'}, take: 1}}});
  if (existing) return existing;
  const [first, ...rest] = (name?.trim() || address.split('@')[0]!).split(/\s+/);
  const contact = await db.contact.create({
    data: {firstName: (first || address).slice(0, 100), lastName: rest.join(' ').slice(0, 100) || null, email: address, source: 'Support', lastActivityAt: new Date()},
  });
  await logActivity(db, {type: 'contact_created', title: 'Contact created from a support request', contactId: contact.id});
  await associateByDomain(db, contact.id).catch(() => null);
  await emit(db, 'contact.created', {recordId: contact.id, data: contact});
  return db.contact.findUniqueOrThrow({where: {id: contact.id}, include: {companies: {orderBy: {isPrimary: 'desc'}, take: 1}}});
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type CreateTicketInput = {
  subject: string;
  description?: string | null;
  /** Sanitised rich text of the description (richBody()); `description` is its plain text. */
  descriptionHtml?: string | null;
  priority?: TicketPriority;
  category?: string | null;
  queue?: string | null;
  source: TicketSource;
  tags?: string[];
  assigneeId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  emailThreadId?: string | null;
  actorId?: string | null;
  at?: Date;
};

/** Creates a ticket with its SLA deadlines, timeline entry, event and notifications. */
export async function createTicket(db: Db, input: CreateTicketInput) {
  const prepared = await prepareTicket(db, input);
  return ticketCreated(db, await db.ticket.create({data: prepared.data}), input, prepared.settings);
}

/**
 * What `createTicket` writes, worked out first (the settings and the contact's company are read
 * here), so a caller can insert it inside its own transaction (`tx.ticket.create({data})`, the
 * public support form's idempotent write) and run `ticketCreated` after it.
 */
export async function prepareTicket(db: Db, input: CreateTicketInput) {
  const settings = await getTicketSettings(db);
  const at = input.at ?? new Date();
  const priority = input.priority ?? 'NORMAL';
  let companyId = input.companyId ?? null;
  if (!companyId && input.contactId) {
    companyId = (await db.contactCompany.findFirst({where: {contactId: input.contactId}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}))?.companyId ?? null;
  }
  const data = {
    subject: input.subject.trim().slice(0, 300) || '(no subject)',
    description: input.description?.slice(0, 50_000) || null,
    descriptionHtml: input.descriptionHtml || null,
    priority,
    category: input.category || null,
    queue: input.queue || null,
    source: input.source,
    tags: input.tags ?? [],
    assigneeId: input.assigneeId || null,
    contactId: input.contactId || null,
    companyId,
    dealId: input.dealId || null,
    emailThreadId: input.emailThreadId || null,
    createdAt: at,
    lastMessageAt: at,
    ...slaDueDates(settings, priority, at),
  } satisfies Prisma.TicketUncheckedCreateInput;
  return {data, settings};
}

/** A new ticket's SLA timers, timeline entry, event and notifications (once, after it is saved). */
export async function ticketCreated(db: Db, ticket: Ticket, input: CreateTicketInput, settings: TicketSettings) {
  const at = ticket.createdAt;
  await scheduleSla(db, ticket);
  await logActivity(db, {
    type: 'ticket_created',
    title: `Ticket ${ticketRef(ticket.number)} opened: ${ticket.subject}`,
    refId: ticket.id,
    actorId: input.actorId,
    ...activityLink(ticket),
    data: activityData(ticket, {source: ticket.source, body: ticket.description?.slice(0, 600) ?? null}),
    text: `${ticket.subject}\n${ticket.description ?? ''}`,
    at,
  });
  await emit(db, 'ticket.created', {recordId: ticket.id, actorId: input.actorId, data: ticket});
  const who = contactName(input.contactId ? await db.contact.findUnique({where: {id: input.contactId}, select: {firstName: true, lastName: true}}) : null);
  if (ticket.assigneeId && ticket.assigneeId !== input.actorId) {
    await notify(db, [ticket.assigneeId], {type: 'assigned', title: `New ticket assigned to you: ${ticketRef(ticket.number)} ${ticket.subject}`, body: ticket.description, link: ticketLink(ticket), actorId: input.actorId});
  } else if (!ticket.assigneeId) {
    await notify(db, await ticketTeam(db, settings), {type: 'ticket', title: `New ticket ${ticketRef(ticket.number)}${who ? ` from ${who}` : ''}: ${ticket.subject}`, body: ticket.description, link: ticketLink(ticket), actorId: input.actorId});
  }
  return ticket;
}

// ─── Updates ────────────────────────────────────────────────────────────────

type Actor = {id: string; name: string} | null;

export async function ticketEvent(db: Db, ticketId: string, data: Prisma.InputJsonObject, authorId?: string | null) {
  await db.ticketMessage.create({data: {ticketId, kind: 'event', authorId: authorId ?? null, data}});
}

/** Moves a ticket through the pipeline, keeping resolved/closed timestamps and CSAT in step. */
export async function changeStatus(db: Db, before: Ticket, to: TicketStatus, actor: Actor, opts: {origin?: string; quiet?: boolean} = {}) {
  if (before.status === to) return before;
  const now = new Date();
  const ticket = await db.ticket.update({
    where: {id: before.id},
    data: {
      status: to,
      resolvedAt: to === 'RESOLVED' ? now : to === 'CLOSED' ? (before.resolvedAt ?? now) : null,
      closedAt: to === 'CLOSED' ? now : null,
    },
  });
  await ticketEvent(db, ticket.id, {type: 'status', from: before.status, to}, actor?.id);
  await logActivity(db, {
    type: 'ticket_status',
    title: `Ticket ${ticketRef(ticket.number)} ${to === 'RESOLVED' ? 'resolved' : to === 'CLOSED' ? 'closed' : isOpenStatus(before.status) ? `moved to ${STATUS[to].label.toLowerCase()}` : 'reopened'}`,
    refId: ticket.id,
    actorId: actor?.id,
    ...activityLink(ticket),
    data: activityData(ticket, {from: before.status, to}),
  });
  await emit(db, 'ticket.status_changed', {recordId: ticket.id, actorId: actor?.id, data: {...ticket, from: before.status, to}});
  // Reopened: deadlines that already passed get re-checked.
  if (isOpenStatus(to) && !isOpenStatus(before.status)) await scheduleSla(db, ticket);
  if (to === 'RESOLVED' && !ticket.csatSentAt && ticket.contactId) {
    const settings = await getTicketSettings(db);
    if (settings.csatEnabled) {
      await enqueue(db, 'ticket.csat', {ticketId: ticket.id, origin: opts.origin ?? ''});
      kickJobs();
    }
  }
  if (!opts.quiet && actor && ticket.assigneeId && ticket.assigneeId !== actor.id) {
    await notify(db, [ticket.assigneeId], {type: 'ticket', title: `${actor.name} set ${ticketRef(ticket.number)} to ${STATUS[to].label.toLowerCase()}`, body: ticket.subject, link: ticketLink(ticket), actorId: actor.id});
  }
  return ticket;
}

export async function assignTicket(db: Db, before: Ticket, assigneeId: string | null, actor: Actor) {
  if (before.assigneeId === assigneeId) return before;
  const ticket = await db.ticket.update({where: {id: before.id}, data: {assigneeId}});
  const user = assigneeId ? await db.member.findUnique({where: {id: assigneeId}, select: {name: true}}) : null;
  await ticketEvent(db, ticket.id, {type: 'assigned', to: assigneeId, name: user?.name ?? null}, actor?.id);
  await emit(db, 'ticket.assigned', {recordId: ticket.id, actorId: actor?.id, data: {...ticket, previousAssigneeId: before.assigneeId}});
  if (assigneeId && assigneeId !== actor?.id) {
    await notify(db, [assigneeId], {type: 'assigned', title: `${actor?.name ?? 'Someone'} assigned you ticket ${ticketRef(ticket.number)}: ${ticket.subject}`, link: ticketLink(ticket), actorId: actor?.id});
  }
  return ticket;
}

/** Priority changes move the SLA deadlines (measured from when the ticket was opened). */
export async function changePriority(db: Db, before: Ticket, priority: TicketPriority, actor: Actor) {
  if (before.priority === priority) return before;
  const settings = await getTicketSettings(db);
  const due = slaDueDates(settings, priority, before.createdAt);
  const ticket = await db.ticket.update({
    where: {id: before.id},
    data: {
      priority,
      ...due,
      // A breach under the old target no longer applies when the new deadline is later.
      firstResponseBreachedAt: due.firstResponseDueAt && due.firstResponseDueAt > new Date() ? null : before.firstResponseBreachedAt,
      resolutionBreachedAt: due.resolutionDueAt && due.resolutionDueAt > new Date() ? null : before.resolutionBreachedAt,
    },
  });
  await ticketEvent(db, ticket.id, {type: 'priority', from: before.priority, to: priority}, actor?.id);
  if (isOpenStatus(ticket.status)) await scheduleSla(db, ticket);
  return ticket;
}

// ─── Conversation ───────────────────────────────────────────────────────────

/** The mailbox replies go out from: the configured one, the support address's, else the default shared one. */
export async function replyAccount(db: Db, me: User, settings: TicketSettings): Promise<EmailAccount | null> {
  const accounts = await usableAccounts(db, me);
  const support = settings.supportEmail.toLowerCase();
  return (
    (settings.replyAccountId && accounts.find((a) => a.id === settings.replyAccountId)) ||
    (support && accounts.find((a) => a.fromEmail.toLowerCase() === support)) ||
    accounts.find((a) => a.userId === null) ||
    accounts[0] ||
    null
  );
}

/** A "How did we do?" link works for this long after it was sent (when the ticket was resolved). */
export const CSAT_DAYS = 30;

/** `<ticket id>.<issued at, unix seconds in base 36>.<signature of both>`: the time is signed, so it can't be moved. */
export async function csatToken(ticketId: string, issuedAt = Date.now()) {
  const t = Math.floor(issuedAt / 1000).toString(36);
  return `${ticketId}.${t}.${await sign(`csat:${ticketId}:${t}`)}`;
}

/**
 * The ticket a CSAT link is for, or null (not ours, or expired). Links sent before the time was in
 * the token (`<id>.<sig>`) expire 30 days after the ticket's CSAT email went out.
 */
export async function ticketFromCsatToken(db: Db, token: string, now = Date.now()): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length === 3) {
    const [ticketId, t, sig] = parts as [string, string, string];
    if (!ticketId || !/^[0-9a-z]{1,9}$/.test(t) || !(await verifySignature(`csat:${ticketId}:${t}`, sig))) return null;
    return parseInt(t, 36) * 1000 + CSAT_DAYS * 86_400_000 > now ? ticketId : null;
  }
  const [ticketId, sig] = parts;
  if (parts.length !== 2 || !ticketId || !sig || !(await verifySignature(`csat:${ticketId}`, sig))) return null;
  const sent = await db.ticket.findUnique({where: {id: ticketId}, select: {csatSentAt: true}});
  return sent?.csatSentAt && sent.csatSentAt.getTime() + CSAT_DAYS * 86_400_000 > now ? ticketId : null;
}

const originOf = (origin?: string | null) => config.siteUrl() || origin || '';

/** `html` is the rich editor's HTML (sanitised and merged here); `body` the plain text fallback. */
type AgentReply = {body: string; html?: string | null; fileIds?: string[]; status?: TicketStatus | null};

/**
 * A team reply. Public replies are emailed to the contact through `sendEmail`
 * (threaded on the ticket's EmailThread, subject token, Reply-To the support
 * address); internal notes notify @mentions. Returns a warning when a public
 * reply could only be saved for the portal.
 */
export async function agentReply(db: Db, me: User, origin: string, before: Ticket, kind: 'reply' | 'note', input: AgentReply) {
  const fileIds = input.fileIds?.length
    ? (await db.file.findMany({where: {id: {in: input.fileIds}, purpose: 'ticket'}, select: {id: true}})).map((f) => f.id)
    : [];
  let ticket = before;
  let warning: string | null = null;

  if (kind === 'note') {
    const note = richBody({html: input.html, text: input.body});
    const message = await db.ticketMessage.create({data: {ticketId: ticket.id, kind: 'note', body: note.text, html: note.html, authorId: me.id, via: 'app', fileIds}});
    await notifyMentions(db, note.text, {actorId: me.id, actorName: me.name, where: `on ticket ${ticketRef(ticket.number)}`, link: ticketLink(ticket)});
    if (input.status) ticket = await changeStatus(db, ticket, input.status, me, {origin});
    return {message, ticket, warning};
  }

  const settings = await getTicketSettings(db);
  const full = await db.ticket.findUniqueOrThrow({where: {id: ticket.id}, include: {contact: true, company: true, deal: true}});
  const to = full.contact?.email;
  const account = await replyAccount(db, me, settings);
  const ctx = {contact: full.contact, company: full.company, deal: full.deal, me: {name: me.name, email: account?.fromEmail ?? me.email}};
  const rich = richBody({html: input.html, text: input.body}, (s, html) => mergeFields(s, ctx, {html}));
  const body = rich.text;

  let emailMessageId: string | null = null;
  if (to && account) {
    const files = fileIds.length ? await db.file.findMany({where: {id: {in: fileIds}}, select: {id: true, name: true}}) : [];
    const links = await Promise.all(files.map(async (f) => `${f.name}: ${await publicFileUrl(originOf(origin), f.id, 30)}`));
    // The customer signs in with the address this went to (the site's sign-in) to see it online.
    const portal = settings.portalEnabled && full.contactId ? `${originOf(origin)}/support/tickets/${ticket.number}` : null;
    const footer = [links.length ? `Attachments:\n${links.join('\n')}` : null, portal ? `View this request online: ${portal}` : null].filter(Boolean).join('\n\n');
    const footerHtml = [
      files.length ? `<p>Attachments:<br>${(await Promise.all(files.map(async (f) => `<a href="${escapeHtml(await publicFileUrl(originOf(origin), f.id, 30))}">${escapeHtml(f.name)}</a>`))).join('<br>')}</p>` : '',
      portal ? `<p>View this request online: <a href="${escapeHtml(portal)}">${escapeHtml(portal)}</a></p>` : '',
    ].join('');
    const subject = `${ticket.emailThreadId ? 'Re: ' : ''}${ticket.subject} ${subjectToken(ticket.number)}`;
    const sent = await sendEmail(db, me, origin, {
      accountId: account.id,
      to: [to],
      subject,
      ...(rich.html ? {html: rich.html + footerHtml} : {body: footer ? `${body}\n\n${footer}` : body}),
      threadId: ticket.emailThreadId ?? undefined,
      channel: 'ticket', // worked from the ticket, not the shared inbox
      contactId: full.contactId,
      companyId: full.companyId,
      dealId: full.dealId,
      replyTo: settings.supportEmail && settings.supportEmail.toLowerCase() !== account.fromEmail.toLowerCase() ? settings.supportEmail : undefined,
    });
    if (sent) {
      emailMessageId = sent.id;
      if (!ticket.emailThreadId) ticket = await db.ticket.update({where: {id: ticket.id}, data: {emailThreadId: sent.threadId}});
      // One "Ticket reply" entry on the timeline instead of a generic "Email sent".
      await db.activity.updateMany({
        where: {type: 'email_out', refId: sent.id},
        data: {type: 'ticket_reply', title: `Replied on ticket ${ticketRef(ticket.number)}`, data: activityData(ticket, {direction: 'OUTBOUND', body: body.slice(0, 600)}) as Prisma.InputJsonValue},
      });
    }
  } else if (!settings.portalEnabled) {
    throw new HTTPException(400, {message: !to ? 'This ticket has no contact email to reply to' : 'Connect an email account in Settings → Email first'});
  } else {
    warning = !to ? 'Saved for the portal: the contact has no email address' : 'Saved for the portal, not emailed: connect an email account in Settings → Email';
  }

  const message = await db.ticketMessage.create({
    data: {ticketId: ticket.id, kind: 'reply', direction: 'OUTBOUND', via: 'app', body, html: rich.html, authorId: me.id, emailMessageId, fileIds, data: emailMessageId ? {emailed: true} : {emailed: false}},
  });
  const now = new Date();
  ticket = await db.ticket.update({where: {id: ticket.id}, data: {lastMessageAt: now, firstResponseAt: ticket.firstResponseAt ?? now}});
  if (!emailMessageId) {
    await logActivity(db, {type: 'ticket_reply', title: `Replied on ticket ${ticketRef(ticket.number)}`, refId: message.id, actorId: me.id, ...activityLink(ticket), data: activityData(ticket, {direction: 'OUTBOUND', body: body.slice(0, 600)}), text: body});
  }
  await emit(db, 'ticket.replied', {recordId: ticket.id, actorId: me.id, data: {ticket, message: {...message, direction: 'OUTBOUND'}}});
  const next = input.status ?? (ticket.status === 'NEW' || ticket.status === 'WAITING_ON_US' ? 'WAITING_ON_CONTACT' : null);
  if (next) ticket = await changeStatus(db, ticket, next, me, {origin, quiet: true});
  return {message, ticket, warning};
}

/** A reply from the customer (email or portal): reopens / moves the ticket to "Waiting on us". */
export async function customerReply(
  db: Db,
  before: Ticket,
  input: {body: string; html?: string | null; via: 'email' | 'portal'; fromEmail: string; fromName?: string | null; emailMessageId?: string | null; fileIds?: string[]; at?: Date},
) {
  const at = input.at ?? new Date();
  const message = await db.ticketMessage.create({
    data: {
      ticketId: before.id,
      kind: 'reply',
      direction: 'INBOUND',
      via: input.via,
      body: input.body.slice(0, 50_000),
      html: input.html || null,
      fromEmail: input.fromEmail.toLowerCase(),
      fromName: input.fromName ?? null,
      emailMessageId: input.emailMessageId ?? null,
      fileIds: input.fileIds ?? [],
      createdAt: at,
    },
  });
  let ticket = await db.ticket.update({where: {id: before.id}, data: {lastMessageAt: at}});
  const who = input.fromName || input.fromEmail;
  await logActivity(db, {
    type: 'ticket_reply',
    title: `${who} replied on ticket ${ticketRef(ticket.number)}`,
    refId: message.id,
    ...activityLink(ticket),
    data: activityData(ticket, {direction: 'INBOUND', body: input.body.slice(0, 600)}),
    text: input.body,
    at,
  });
  await emit(db, 'ticket.replied', {recordId: ticket.id, data: {ticket, message}});
  if (ticket.status !== 'WAITING_ON_US' && ticket.status !== 'NEW') ticket = await changeStatus(db, ticket, 'WAITING_ON_US', null);
  await notifyTicket(db, ticket, {title: `${who} replied on ${ticketRef(ticket.number)}: ${ticket.subject}`, body: input.body});
  return {message, ticket};
}

// ─── Customer emails (jobs) ─────────────────────────────────────────────────

/** Job "ticket.csat": the "How did we do?" email after a ticket is resolved. */
export async function sendCsat(db: Db, payload: Record<string, unknown>) {
  const ticket = await db.ticket.findUnique({where: {id: String(payload.ticketId)}, include: {contact: true}});
  if (!ticket || ticket.csatSentAt || ticket.csatRating || !ticket.contact?.email || ticket.status !== 'RESOLVED') return;
  const settings = await getTicketSettings(db);
  if (!settings.csatEnabled) return;
  const origin = originOf(payload.origin as string | undefined);
  const brand = (await getSettings(db)).brandName;
  const url = `${origin}/csat/${await csatToken(ticket.id)}`;
  const sent = await sendSystemEmail(db, {
    to: [ticket.contact.email],
    subject: `How did we do? ${subjectToken(ticket.number)} ${ticket.subject}`,
    text: [
      `Hi ${ticket.contact.firstName},`,
      `Your request "${ticket.subject}" (${ticketRef(ticket.number)}) was marked as resolved. How satisfied are you with the help you got?`,
      [5, 4, 3, 2, 1].map((n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${url}?rating=${n}`).join('\n'),
      `If something is still not right, just reply to this email and the request reopens.`,
      `Thanks,\n${brand}`,
    ].join('\n\n'),
    replyTo: settings.supportEmail || null,
  });
  if (!sent) return; // no mailbox connected; nothing to retry
  await db.ticket.update({where: {id: ticket.id}, data: {csatSentAt: new Date()}});
  await ticketEvent(db, ticket.id, {type: 'csat_sent'});
}

/** The portal magic link ("view my tickets"), optionally confirming a new request. */
export async function sendPortalLink(db: Db, contactId: string, origin: string, created?: Ticket) {
  const contact = await db.contact.findUnique({where: {id: contactId}});
  if (!contact?.email) return false;
  const settings = await getTicketSettings(db);
  const brand = (await getSettings(db)).brandName;
  const base = originOf(origin);
  const link = created ? `${base}/support/tickets/${created.number}` : `${base}/support/tickets`;
  return sendSystemEmail(db, {
    to: [contact.email],
    subject: created ? `We received your request ${subjectToken(created.number)} ${created.subject}` : `Your support requests at ${brand}`,
    text: [
      `Hi ${contact.firstName},`,
      created
        ? `Thanks for getting in touch. Your request "${created.subject}" is ${ticketRef(created.number)}. We'll reply by email; you can also follow it and reply here:`
        : `Here is your link to see your requests with ${brand} and reply to them:`,
      link,
      `To see it, sign in (or create your account) with this email address, ${contact.email}.`,
      brand,
    ].join('\n\n'),
    replyTo: settings.supportEmail || null,
  }).catch((e) => (console.error('[tickets] portal link', String((e as Error)?.message ?? e).slice(0, 200)), false));
}
