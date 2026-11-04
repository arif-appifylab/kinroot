import type {Db} from '../kit/db';
import {logActivity} from './activity';
import {getSettings} from './settings';
import {COMPANY_LIMITS, cut} from '@/lib/record-limits';

/** Personal mailbox providers never identify an employer. */
const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', 'hey.com', 'fastmail.com',
]);

export function workDomain(email: string | null | undefined) {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  return domain && domain.includes('.') && !FREE_DOMAINS.has(domain) ? domain : null;
}

/** "northwind-labs.io" → "Northwind Labs" */
export const nameFromDomain = (domain: string) =>
  domain.split('.')[0]!.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * HubSpot-style association: a contact with a work email gets linked to the
 * company that owns that domain (and the company is created if settings
 * allow it). Only applies when the contact has no company yet.
 */
export async function associateByDomain(db: Db, contactId: string, actorId?: string | null) {
  const settings = await getSettings(db);
  if (!settings.autoAssociateCompanies) return null;
  const contact = await db.contact.findUnique({where: {id: contactId}, select: {email: true, ownerId: true, _count: {select: {companies: true}}}});
  const domain = workDomain(contact?.email);
  if (!contact || !domain || contact._count.companies > 0) return null;

  let company = await db.company.findFirst({where: {domain}, select: {id: true, name: true}});
  if (!company && settings.autoCreateCompanies) {
    company = await db.company.create({
      data: {name: cut(nameFromDomain(domain), COMPANY_LIMITS.name), domain: cut(domain, COMPANY_LIMITS.domain), website: `https://${domain}`.slice(0, 2000), ownerId: contact.ownerId, lastActivityAt: new Date()},
      select: {id: true, name: true},
    });
    await logActivity(db, {type: 'company_created', title: `Company created from ${domain}`, actorId, companyId: company.id});
  }
  if (!company) return null;
  await db.contactCompany.create({data: {contactId, companyId: company.id, isPrimary: true}});
  await logActivity(db, {type: 'associated', title: `Linked to ${company.name} by email domain`, actorId, contactId, companyId: company.id});
  return company;
}

/** When a company gets a domain, pick up existing contacts on that domain that have no company yet. */
export async function adoptContactsForDomain(db: Db, companyId: string, domain: string | null | undefined, actorId?: string | null) {
  const settings = await getSettings(db);
  if (!settings.autoAssociateCompanies || !domain || FREE_DOMAINS.has(domain)) return 0;
  const orphans = await db.contact.findMany({
    where: {email: {endsWith: `@${domain}`, mode: 'insensitive'}, companies: {none: {}}},
    select: {id: true},
  });
  if (!orphans.length) return 0;
  await db.contactCompany.createMany({data: orphans.map((c) => ({contactId: c.id, companyId, isPrimary: true})), skipDuplicates: true});
  await logActivity(db, {type: 'associated', title: `${orphans.length} contact${orphans.length > 1 ? 's' : ''} linked by email domain @${domain}`, actorId, companyId});
  return orphans.length;
}
