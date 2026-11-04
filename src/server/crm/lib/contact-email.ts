import {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';

/**
 * Contacts by email address, ignoring case, on the expression index "Contact_email_lower_idx"
 * (`lower("email")`, migration 20261103091653_crm_indexes; see the note on `model Contact`).
 *
 * Contact emails are NOT guaranteed lower-cased in the database (the contact form, merges and
 * older imports keep what was typed), so an exact `{email}` lookup would miss "Ann@X.com", and
 * Prisma's `mode: 'insensitive'` compiles to ILIKE, which can't use any b-tree index. This is the
 * one indexed, case-insensitive form: `lower(email) IN (…)`, values bound one by one (never an
 * array parameter: src/platform/db-socket.ts can't bind those).
 */

type Opts = {
  /** Owner-only visibility: only this member's contacts (`ownerScope()` → `{ownerId}`). */
  ownerId?: string;
  /** Only contacts that unsubscribed. */
  optedOut?: boolean;
  /** At most this many rows (default 100). */
  take?: number;
};

export type EmailHit = {id: string; email: string};

/** The contacts using any of `emails` (case-insensitive), oldest first; `email` comes back lower-cased. */
export async function contactsByEmail(db: Db | Prisma.TransactionClient, emails: readonly (string | null | undefined)[], opts: Opts = {}): Promise<EmailHit[]> {
  const keys = [...new Set(emails.flatMap((e) => (e && e.trim() ? [e.trim().toLowerCase()] : [])))];
  if (!keys.length) return [];
  const take = Math.max(1, Math.min(opts.take ?? 100, 5000));
  return db.$queryRaw<EmailHit[]>`
    SELECT id, lower(email) AS email FROM "Contact"
    WHERE lower(email) IN (${Prisma.join(keys)})
    ${opts.ownerId ? Prisma.sql`AND "ownerId" = ${opts.ownerId}` : Prisma.empty}
    ${opts.optedOut ? Prisma.sql`AND "emailOptOut" = true` : Prisma.empty}
    ORDER BY "createdAt" ASC, id ASC
    LIMIT ${take}`;
}

/** The oldest contact using `email` (case-insensitive), or null. */
export async function contactIdByEmail(db: Db | Prisma.TransactionClient, email: string | null | undefined, opts: Omit<Opts, 'take'> = {}): Promise<string | null> {
  return (await contactsByEmail(db, [email], {...opts, take: 1}))[0]?.id ?? null;
}

/** The lower-cased addresses among `emails` that some contact unsubscribed from (one query per 1000). */
export async function optedOutEmails(db: Db | Prisma.TransactionClient, emails: readonly string[]): Promise<Set<string>> {
  const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    // One row per address is enough: DISTINCT keeps the answer within the chunk's size.
    const rows = await db.$queryRaw<{email: string}[]>`
      SELECT DISTINCT lower(email) AS email FROM "Contact"
      WHERE lower(email) IN (${Prisma.join(chunk)}) AND "emailOptOut" = true
      LIMIT ${chunk.length}`;
    for (const r of rows) out.add(r.email);
  }
  return out;
}
