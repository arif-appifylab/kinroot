/**
 * Record writes shared by the inputs that create CRM data outside a signed-in
 * page: the Data in webhook (src/server/crm/lib/data-in.ts). Every write keeps the timeline, events
 * (and so scoring, automations and outgoing webhooks), audit log,
 * notifications, duplicate checks and domain links in step, the way the
 * contact / company / deal routes do. Callers validate first (`contactBody`,
 * `companyBody`, `dealBody`, `cleanCustom()`).
 */
import {Prisma, type Company, type Contact} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {contactName} from '../routes/contacts';
import {customDiff, diff, logActivity} from './activity';
import {audit} from './audit';
import {contactIdByEmail} from './contact-email';
import {adoptContactsForDomain, associateByDomain, nameFromDomain} from './domains';
import {phoneKey, queueDuplicateCheck} from './duplicates';
import {emit} from './events';
import {notify, recordLink} from './notify';
import {rememberOption} from './settings';
import {clip, COMPANY_LIMITS, CONTACT_LIMITS, DEAL_LIMITS} from '@/lib/record-limits';

export type Writer = {
  /** Reads after "Created by" / "Updated by": `Data in URL`. */
  by: string;
  /** Timeline `data.source`: property history shows "API: <name>". */
  source: {kind: 'api'; name: string};
  /** Extra timeline data on every entry (e.g. {dataInUrl}). */
  data?: Record<string, unknown>;
  /** Audit meta on every entry (e.g. {source, dataInUrl, action}). */
  meta: Record<string, unknown>;
  /** The teammate the write acts for (the admin who turned the Data in webhook on). */
  actor?: {id: string; name: string; email: string} | null;
};

type Change = {field: string; from: unknown; to: unknown};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const actorId = (w: Writer) => w.actor?.id ?? null;
const auditActor = (w: Writer) => (w.actor ? {actor: w.actor} : {});
const timelineData = (w: Writer, extra: Record<string, unknown> = {}) => ({...extra, source: w.source, ...w.data}) as Prisma.InputJsonValue;
const assignedTitle = (w: Writer, what: string, name: string) => `${capital(w.by)} assigned you a ${what}: ${name}`;

/** Only the fields that really change, plus the custom JSON when a custom field changed. */
function changedWrites(before: Record<string, unknown>, data: Record<string, unknown>, custom: Record<string, unknown> | undefined) {
  const changes: Change[] = [...diff(before, data), ...(custom ? customDiff(before.custom, custom) : [])];
  const fields = new Set(changes.map((c) => c.field));
  const writes: Record<string, unknown> = Object.fromEntries(Object.entries(data).filter(([k]) => fields.has(k)));
  if (custom && changes.some((c) => c.field.startsWith('custom.'))) writes.custom = custom as Prisma.InputJsonValue;
  return {changes, writes};
}

// ─── Lookups ────────────────────────────────────────────────────────────────

/** Contact ids whose phone ends in the same 10 digits (formatting ignored). */
export async function contactIdByPhone(db: Db, phone: string | null | undefined, opts: {withoutEmail?: boolean; ownerId?: string} = {}) {
  const pk = phoneKey(phone);
  if (!pk) return null;
  const rows = await db.$queryRaw<{id: string}[]>`SELECT id FROM "Contact" WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${pk} ${opts.withoutEmail ? Prisma.sql`AND (email IS NULL OR email = '')` : Prisma.empty} ${opts.ownerId ? Prisma.sql`AND "ownerId" = ${opts.ownerId}` : Prisma.empty} ORDER BY "createdAt" LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * The contact with this email (case-insensitive), else with this phone. Phone
 * matching skips contacts with another email when an email was given, so a
 * shared office number never hands one person's record to another.
 */
export async function findContact(db: Db, ref: {email?: string | null; phone?: string | null}, scope: {ownerId?: string} = {}): Promise<Contact | null> {
  if (ref.email) {
    // Case-insensitive on the lower(email) index (`mode: 'insensitive'` is ILIKE: no index), the oldest one.
    const foundId = await contactIdByEmail(db, ref.email, {ownerId: scope.ownerId});
    const found = foundId ? await db.contact.findUnique({where: {id: foundId}}) : null;
    if (found) return found;
  }
  const id = await contactIdByPhone(db, ref.phone, {withoutEmail: !!ref.email, ownerId: scope.ownerId});
  return id ? db.contact.findUnique({where: {id}}) : null;
}

/** The company with this domain, else this name (case-insensitive). */
export async function findCompany(db: Db, ref: {name?: string | null; domain?: string | null}, scope: {ownerId?: string} = {}): Promise<Company | null> {
  return (
    (ref.domain ? await db.company.findFirst({where: {domain: ref.domain, ...scope}, orderBy: {createdAt: 'asc'}}) : null) ??
    (ref.name ? await db.company.findFirst({where: {name: {equals: ref.name, mode: 'insensitive'}, ...scope}, orderBy: {createdAt: 'asc'}}) : null)
  );
}

// ─── Contacts ───────────────────────────────────────────────────────────────

/** Creates a contact from validated fields: timeline, event, audit, owner notification. Caller links companies and checks duplicates. */
export async function createContactRecord(db: Db, w: Writer, data: Prisma.ContactUncheckedCreateInput, custom?: Record<string, unknown>) {
  // Callers validate; names they build (a domain's name, an email's local part) are cut to the columns here.
  const contact = await db.contact.create({data: {...clip(data, CONTACT_LIMITS), custom: (custom ?? {}) as Prisma.InputJsonValue, lastActivityAt: new Date()}});
  await rememberOption(db, 'sources', contact.source);
  await logActivity(db, {type: 'contact_created', title: `Created by ${w.by}`, actorId: actorId(w), contactId: contact.id, data: timelineData(w)});
  await emit(db, 'contact.created', {recordId: contact.id, actorId: actorId(w), data: contact});
  await audit(db, null, {action: 'contact.created', entity: 'contact', recordId: contact.id, label: contactName(contact), meta: w.meta, ...auditActor(w)});
  await notify(db, [contact.ownerId], {type: 'assigned', title: assignedTitle(w, 'contact', contactName(contact)), link: recordLink.contact(contact.id), actorId: actorId(w)});
  return contact;
}

/** Writes the fields that change (timeline `field_changed` with old values, event, audit, duplicates, domain link, owner notification). */
export async function updateContactRecord(db: Db, w: Writer, before: Contact, data: Record<string, unknown>, custom?: Record<string, unknown>) {
  const {changes, writes} = changedWrites(before, clip(data, CONTACT_LIMITS), custom);
  if (!changes.length) return {contact: before, changes};
  const contact = await db.contact.update({where: {id: before.id}, data: writes});
  await logActivity(db, {type: 'field_changed', title: `Updated by ${w.by}`, actorId: actorId(w), contactId: contact.id, data: timelineData(w, {changes})});
  await emit(db, 'contact.updated', {recordId: contact.id, actorId: actorId(w), data: {...contact, changes}});
  await audit(db, null, {action: 'contact.updated', entity: 'contact', recordId: contact.id, label: contactName(contact), meta: {changes, ...w.meta}, ...auditActor(w)});
  if (typeof writes.source === 'string') await rememberOption(db, 'sources', writes.source);
  if (writes.email) await associateByDomain(db, contact.id, actorId(w));
  // Compared with every contact: a job, not this request (P2-25).
  if (changes.some((c) => ['firstName', 'lastName', 'email', 'phone'].includes(c.field))) await queueDuplicateCheck(db, 'contact', contact.id);
  if (writes.ownerId) await notify(db, [contact.ownerId], {type: 'assigned', title: assignedTitle(w, 'contact', contactName(contact)), link: recordLink.contact(contact.id), actorId: actorId(w)});
  return {contact, changes};
}

export async function linkContactCompany(db: Db, contactId: string, companyId: string) {
  const links = await db.contactCompany.findMany({where: {contactId}, select: {companyId: true}});
  if (links.some((l) => l.companyId === companyId)) return;
  await db.contactCompany.create({data: {contactId, companyId, isPrimary: links.length === 0}});
}

// ─── Companies ──────────────────────────────────────────────────────────────

/** Creates a company from validated fields: timeline, event, audit, notification, options, domain contacts, duplicates. */
export async function createCompanyRecord(db: Db, w: Writer, data: Prisma.CompanyUncheckedCreateInput, custom?: Record<string, unknown>) {
  const company = await db.company.create({data: {...clip(data, COMPANY_LIMITS), custom: (custom ?? {}) as Prisma.InputJsonValue, lastActivityAt: new Date()}});
  await logActivity(db, {type: 'company_created', title: `Created by ${w.by}`, actorId: actorId(w), companyId: company.id, data: timelineData(w)});
  await emit(db, 'company.created', {recordId: company.id, actorId: actorId(w), data: company});
  await audit(db, null, {action: 'company.created', entity: 'company', recordId: company.id, label: company.name, meta: w.meta, ...auditActor(w)});
  await notify(db, [company.ownerId], {type: 'assigned', title: assignedTitle(w, 'company', company.name), link: recordLink.company(company.id), actorId: actorId(w)});
  await rememberOption(db, 'industries', company.industry);
  await rememberOption(db, 'companyTypes', company.type);
  await adoptContactsForDomain(db, company.id, company.domain, actorId(w));
  await queueDuplicateCheck(db, 'company', company.id);
  return company;
}

export async function updateCompanyRecord(db: Db, w: Writer, before: Company, data: Record<string, unknown>, custom?: Record<string, unknown>) {
  const {changes, writes} = changedWrites(before, clip(data, COMPANY_LIMITS), custom);
  if (!changes.length) return {company: before, changes};
  const company = await db.company.update({where: {id: before.id}, data: writes});
  await logActivity(db, {type: 'field_changed', title: `Updated by ${w.by}`, actorId: actorId(w), companyId: company.id, data: timelineData(w, {changes})});
  await emit(db, 'company.updated', {recordId: company.id, actorId: actorId(w), data: {...company, changes}});
  await audit(db, null, {action: 'company.updated', entity: 'company', recordId: company.id, label: company.name, meta: {changes, ...w.meta}, ...auditActor(w)});
  await rememberOption(db, 'industries', writes.industry as string | undefined);
  await rememberOption(db, 'companyTypes', writes.type as string | undefined);
  if (writes.domain && !before.domain) await adoptContactsForDomain(db, company.id, company.domain, actorId(w));
  if (changes.some((c) => ['name', 'domain', 'website'].includes(c.field))) await queueDuplicateCheck(db, 'company', company.id);
  if (writes.ownerId) await notify(db, [company.ownerId], {type: 'assigned', title: assignedTitle(w, 'company', company.name), link: recordLink.company(company.id), actorId: actorId(w)});
  return {company, changes};
}

/** Finds the company by domain, then name; creates it (owned by `ownerId`) when new. */
export async function resolveCompany(db: Db, w: Writer, ref: {name?: string; domain?: string}, ownerId: string | null, scope: {ownerId?: string} = {}): Promise<{id: string; name: string; created: boolean} | null> {
  const found = await findCompany(db, ref, scope);
  if (found) return {id: found.id, name: found.name, created: false};
  const name = ref.name || (ref.domain ? nameFromDomain(ref.domain) : null);
  if (!name) return null;
  const company = await createCompanyRecord(db, w, {name, domain: ref.domain ?? null, website: ref.domain ? `https://${ref.domain}` : null, ownerId});
  return {id: company.id, name, created: true};
}

// ─── Deals ──────────────────────────────────────────────────────────────────

export type DealInput = {
  data: Omit<Prisma.DealUncheckedCreateInput, 'pipelineId' | 'stageId' | 'position' | 'status' | 'companyId' | 'custom' | 'contacts' | 'companies'>;
  pipelineId: string;
  stageId: string;
  status?: 'OPEN' | 'WON' | 'LOST';
  lostReason?: string | null;
  closedAt?: Date | null;
  contactId?: string | null;
  companyId?: string | null;
  custom?: Record<string, unknown>;
};

/** Creates a deal at the top of its stage with its contact / company links, stage history, timeline, events, audit and notification. */
export async function createDealRecord(db: Db, w: Writer, input: DealInput) {
  const status = input.status ?? 'OPEN';
  const closed = status === 'WON' || status === 'LOST';
  const first = await db.deal.findFirst({where: {stageId: input.stageId, status: 'OPEN'}, orderBy: {position: 'asc'}, select: {position: true}});
  const deal = await db.deal.create({
    data: {
      ...clip(input.data, DEAL_LIMITS),
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      status,
      lostReason: status === 'LOST' ? (input.lostReason?.slice(0, DEAL_LIMITS.lostReason) ?? null) : null,
      closedAt: closed ? (input.closedAt ?? new Date()) : null,
      position: (first?.position ?? 1) - 1,
      companyId: input.companyId ?? null,
      custom: (input.custom ?? {}) as Prisma.InputJsonValue,
      lastActivityAt: new Date(),
      ...(input.contactId ? {contacts: {create: {contactId: input.contactId}}} : {}),
      ...(input.companyId ? {companies: {create: {companyId: input.companyId, isPrimary: true}}} : {}),
    },
  });
  await db.stageChange.create({data: {dealId: deal.id, toStageId: input.stageId, userId: actorId(w)}});
  await logActivity(db, {type: 'deal_created', title: `Deal created by ${w.by}: ${deal.title}`, actorId: actorId(w), dealId: deal.id, contactId: input.contactId, companyId: input.companyId, data: timelineData(w)});
  await emit(db, 'deal.created', {recordId: deal.id, actorId: actorId(w), data: deal});
  if (deal.status === 'WON' || deal.status === 'LOST') await emit(db, deal.status === 'WON' ? 'deal.won' : 'deal.lost', {recordId: deal.id, actorId: actorId(w), data: deal});
  await audit(db, null, {action: 'deal.created', entity: 'deal', recordId: deal.id, label: deal.title, meta: w.meta, ...auditActor(w)});
  await notify(db, [deal.ownerId], {type: 'assigned', title: assignedTitle(w, 'deal', deal.title), link: recordLink.deal(deal.id), actorId: actorId(w)});
  if (deal.lostReason) await rememberOption(db, 'lostReasons', deal.lostReason);
  return deal;
}
