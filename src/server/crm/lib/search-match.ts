import type {Db} from '../kit/db';

/**
 * Search through a related record (a contact's company name, a deal's company, a ticket's
 * contact), resolved to ids FIRST (AUDIT P3-20). Postgres can't use an index for an OR that holds a
 * subquery (`id IN (SELECT …)` is checked row by row over the whole table), but it can combine the
 * trigram indexes of the plain columns with an `id IN (…)` list (BitmapOr). Each lookup here is
 * served by a trigram index itself and capped: a term matching more related records than that is
 * too broad to narrow anything.
 */
export const RELATED_CAP = 500;

const like = (term: string) => ({contains: term, mode: 'insensitive' as const});

/** Companies whose name contains `term` that the user may see (`scope`: ownerScope). */
export async function companyIdsNamed(db: Db, term: string, scope: {ownerId?: string} = {}): Promise<string[]> {
  const rows = await db.company.findMany({where: {name: like(term), ...scope}, select: {id: true}, take: RELATED_CAP});
  return rows.map((r) => r.id);
}

/** Contacts linked to a company whose name contains `term`, among the companies the user may see. */
export async function contactIdsAtCompaniesNamed(db: Db, term: string, scope: {ownerId?: string} = {}): Promise<string[]> {
  const rows = await db.contactCompany.findMany({where: {company: {name: like(term), ...scope}}, select: {contactId: true}, take: RELATED_CAP});
  return [...new Set(rows.map((r) => r.contactId))];
}

/** Contacts whose email or first name contains `term` (the tickets list's "requester" match). */
export async function contactIdsByNameOrEmail(db: Db, term: string): Promise<string[]> {
  const rows = await db.contact.findMany({where: {OR: [{email: like(term)}, {firstName: like(term)}]}, select: {id: true}, take: RELATED_CAP});
  return rows.map((r) => r.id);
}

/** Search terms of a list's `q`: words, at most 5 (each costs a lookup). */
export const searchTerms = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
