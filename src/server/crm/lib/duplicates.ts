import {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {enqueue} from './jobs';

/**
 * Duplicate detection for contacts and companies. Records are reduced to
 * match keys (normalised email / phone / name / domain); a full scan buckets
 * every record by key, scores the pairs inside each bucket and syncs the
 * result into `DuplicatePair` (dismissed pairs are never re-opened). The same
 * scoring runs for one record after it is created, edited or restored
 * (`checkDuplicates()`) and for the "Possible duplicate" hint in the create
 * dialogs (`findLikelyDuplicates()`), so all three always agree.
 */

export type DupEntity = 'contact' | 'company';
export type Match = {score: number; reasons: string[]};

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com',
]);

/** Case-insensitive, without +tags; Gmail also ignores dots (j.doe@gmail.com = jdoe@googlemail.com). Mirrors emailKeySql(). */
export function normEmail(email?: string | null) {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes('@')) return null;
  const [rawLocal = '', domain = ''] = e.split('@');
  const local = rawLocal.split('+')[0]!;
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${local.replace(/\./g, '')}@gmail.com` : `${local}@${domain}`;
}

const emailKeySql = (col: Prisma.Sql) => Prisma.sql`CASE WHEN split_part(lower(trim(${col})), '@', 2) IN ('gmail.com', 'googlemail.com')
  THEN replace(split_part(split_part(lower(trim(${col})), '@', 1), '+', 1), '.', '') || '@gmail.com'
  ELSE split_part(split_part(lower(trim(${col})), '@', 1), '+', 1) || '@' || split_part(lower(trim(${col})), '@', 2) END`;

/** Last 10 digits, so "+1 (555) 010-2030" and "555 010 2030" match. Needs 7+ digits. */
export function phoneKey(phone?: string | null) {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/** Lower case, no accents or punctuation, single spaces. */
export function normName(s?: string | null) {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const LEGAL = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|plc|bv|nv|srl|pty|oy|ab|as|group|holding|holdings)\b/g;
export const normCompany = (name?: string | null) => normName(name).replace(/^the /, '').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

export function normDomain(v?: string | null) {
  const d = v?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  return d && d.includes('.') ? d : null;
}

/** pg_trgm-style trigrams: each word padded with two spaces in front and one behind. */
function trigrams(s: string) {
  const out = new Set<string>();
  for (const w of s.split(' ').filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

export function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// ─── Keys & scoring ───

type ContactInput = {id?: string; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; companyIds?: string[]};
type ContactKeys = {id: string; name: string; first: string; last: string; grams: Set<string>; emailKey: string | null; domain: string | null; phoneKey: string | null; companyIds: string[]};

function contactKeys(c: ContactInput): ContactKeys {
  const first = normName(c.firstName);
  const last = normName(c.lastName);
  const name = [first, last].filter(Boolean).join(' ');
  const emailKey = normEmail(c.email);
  return {id: c.id ?? '', name, first, last, grams: trigrams(name), emailKey, domain: emailKey?.split('@')[1] ?? null, phoneKey: phoneKey(c.phone), companyIds: c.companyIds ?? []};
}

function scoreContacts(a: ContactKeys, b: ContactKeys): Match | null {
  const reasons: string[] = [];
  let score = 0;
  const hit = (reason: string, s: number) => (reasons.push(reason), (score = Math.max(score, s)));
  const sim = !a.name || !b.name ? 0 : a.name === b.name ? 1 : similarity(a.grams, b.grams);
  const fullNames = !!a.last && !!b.last;
  const sameCompany = a.companyIds.some((id) => b.companyIds.includes(id));
  const sameDomain = !!a.domain && a.domain === b.domain && !FREE_MAIL.has(a.domain);
  const otherEmails = !!a.emailKey && !!b.emailKey && a.emailKey !== b.emailKey;

  if (a.emailKey && a.emailKey === b.emailKey) hit('email', 95);
  // A shared phone with an unrelated name is often a company switchboard.
  if (a.phoneKey && a.phoneKey === b.phoneKey) hit('phone', sim >= 0.5 ? 85 : 55);
  if (sim === 1) {
    if (sameCompany) hit('name_company', fullNames ? 85 : 60);
    else if (sameDomain && fullNames) hit('name_domain', 75);
    else if (fullNames) hit('name', otherEmails ? 40 : 50);
  } else if (sim >= 0.6 && fullNames && (sameCompany || sameDomain)) {
    hit('similar_name', sameCompany ? 70 : 60);
  }
  return reasons.length ? {score: Math.min(99, score + 3 * (reasons.length - 1)), reasons} : null;
}

type CompanyInput = {id?: string; name?: string | null; domain?: string | null; website?: string | null};
type CompanyKeys = {id: string; name: string; grams: Set<string>; domain: string | null};

function companyKeys(c: CompanyInput): CompanyKeys {
  const name = normCompany(c.name);
  return {id: c.id ?? '', name, grams: trigrams(name), domain: normDomain(c.domain) ?? normDomain(c.website)};
}

function scoreCompanies(a: CompanyKeys, b: CompanyKeys): Match | null {
  const reasons: string[] = [];
  let score = 0;
  const hit = (reason: string, s: number) => (reasons.push(reason), (score = Math.max(score, s)));
  const conflict = !!a.domain && !!b.domain && a.domain !== b.domain;
  if (a.domain && a.domain === b.domain) hit('domain', 95);
  if (a.name && a.name === b.name) hit('company_name', conflict ? 50 : 85);
  else if (!conflict && a.name && b.name && similarity(a.grams, b.grams) >= 0.75) hit('similar_company_name', 60);
  return reasons.length ? {score: Math.min(99, score + 3 * (reasons.length - 1)), reasons} : null;
}

// ─── Loading ───

const PAGE = 2000;

async function loadContacts(db: Db, where: Prisma.ContactWhereInput = {}) {
  const out: ContactKeys[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.contact.findMany({
      where,
      select: {id: true, firstName: true, lastName: true, email: true, phone: true, companies: {select: {companyId: true}}},
      orderBy: {id: 'asc'},
      take: PAGE,
      ...(cursor ? {skip: 1, cursor: {id: cursor}} : {}),
    });
    out.push(...rows.map((r) => contactKeys({...r, companyIds: r.companies.map((l) => l.companyId)})));
    if (rows.length < PAGE) return out;
    cursor = rows.at(-1)!.id;
  }
}

async function loadCompanies(db: Db, where: Prisma.CompanyWhereInput = {}) {
  const out: CompanyKeys[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.company.findMany({where, select: {id: true, name: true, domain: true, website: true}, orderBy: {id: 'asc'}, take: PAGE, ...(cursor ? {skip: 1, cursor: {id: cursor}} : {})});
    out.push(...rows.map(companyKeys));
    if (rows.length < PAGE) return out;
    cursor = rows.at(-1)!.id;
  }
}

type Found = Map<string, Match & {aId: string; bId: string}>;
const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/** Scores every pair that shares a bucket. Blocking buckets bigger than MAX_BLOCK are skipped (too generic to mean anything). */
const MAX_BLOCK = 400;
function pairsFrom<K extends {id: string}>(rows: K[], bucketsOf: (k: K) => string[], score: (a: K, b: K) => Match | null): Found {
  const buckets = new Map<string, K[]>();
  for (const r of rows) for (const b of bucketsOf(r)) buckets.set(b, [...(buckets.get(b) ?? []), r]);
  const seen = new Set<string>();
  const found: Found = new Map();
  for (const [, list] of buckets) {
    if (list.length < 2 || list.length > MAX_BLOCK) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = pairKey(list[i]!.id, list[j]!.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const m = score(list[i]!, list[j]!);
        if (m) found.set(key, {...m, aId: key.split('|')[0]!, bId: key.split('|')[1]!});
      }
    }
  }
  return found;
}

const contactBuckets = (k: ContactKeys) => [
  k.emailKey && `e:${k.emailKey}`,
  k.phoneKey && `p:${k.phoneKey}`,
  k.name && `n:${k.name}`,
  k.last && `l:${k.last}`,
  k.first && k.last && `i:${k.first[0]}${k.last[0]}`,
].filter((x): x is string => !!x);

const companyBuckets = (k: CompanyKeys) => [k.domain && `d:${k.domain}`, k.name && `n:${k.name}`, k.name && `b:${k.name.replace(/ /g, '').slice(0, 3)}`].filter((x): x is string => !!x);

// ─── Syncing pairs ───

/** Writes found pairs. Open pairs in `scope` that were not found again are removed; dismissed ones stay dismissed. */
async function syncPairs(db: Db, entity: DupEntity, found: Found, scope: {ids?: string[]}) {
  const where: Prisma.DuplicatePairWhereInput = {entity, ...(scope.ids ? {OR: [{aId: {in: scope.ids}}, {bId: {in: scope.ids}}]} : {})};
  const existing = await db.duplicatePair.findMany({where, select: {id: true, aId: true, bId: true, status: true, score: true, reasons: true}});
  const byKey = new Map(existing.map((p) => [`${p.aId}|${p.bId}`, p]));
  const create = [...found.entries()].filter(([k]) => !byKey.has(k)).map(([, m]) => ({entity, aId: m.aId, bId: m.bId, score: m.score, reasons: m.reasons}));
  if (create.length) await db.duplicatePair.createMany({data: create, skipDuplicates: true});
  const stale = existing.filter((p) => p.status === 'open' && !found.has(`${p.aId}|${p.bId}`)).map((p) => p.id);
  if (stale.length) await db.duplicatePair.deleteMany({where: {id: {in: stale}}});
  let updated = 0;
  for (const p of existing) {
    const m = found.get(`${p.aId}|${p.bId}`);
    if (p.status === 'open' && m && (m.score !== p.score || m.reasons.join() !== p.reasons.join())) {
      await db.duplicatePair.update({where: {id: p.id}, data: {score: m.score, reasons: m.reasons}});
      updated++;
    }
  }
  return {found: found.size, created: create.length, removed: stale.length, updated};
}

const SCAN_KEY = 'duplicates.lastScan';

/** Full scan of one entity (job `duplicates.scan`, "Scan now"). Also drops pairs whose records are gone for good. */
export async function scanDuplicates(db: Db, entity: DupEntity) {
  const rows = entity === 'contact' ? await loadContacts(db) : await loadCompanies(db);
  const found = entity === 'contact' ? pairsFrom(rows as ContactKeys[], contactBuckets, scoreContacts) : pairsFrom(rows as CompanyKeys[], companyBuckets, scoreCompanies);
  const result = await syncPairs(db, entity, found, {});
  // Dismissed pairs of merged / purged records (binned ones stay, they may come back).
  const alive = new Set(rows.map((r) => r.id));
  const binned = new Set((await db.deletedRecord.findMany({where: {entity}, select: {recordId: true}})).map((r) => r.recordId));
  const dead = (await db.duplicatePair.findMany({where: {entity, status: 'dismissed'}, select: {id: true, aId: true, bId: true}}))
    .filter((p) => [p.aId, p.bId].some((id) => !alive.has(id) && !binned.has(id)))
    .map((p) => p.id);
  if (dead.length) await db.duplicatePair.deleteMany({where: {id: {in: dead}}});
  const row = await db.setting.findUnique({where: {key: SCAN_KEY}});
  const value = {...((row?.value ?? {}) as object), [entity]: new Date().toISOString()};
  await db.setting.upsert({where: {key: SCAN_KEY}, create: {key: SCAN_KEY, value}, update: {value}});
  return {...result, records: rows.length};
}

export async function lastScans(db: Db) {
  const row = await db.setting.findUnique({where: {key: SCAN_KEY}});
  return (row?.value ?? {}) as Partial<Record<DupEntity, string>>;
}

const SCAN_EVERY_MS = 6 * 60 * 60_000;

/** Called by the `crm-prune` schedule: queues a full scan per entity every 6 hours. */
export async function scheduleDuplicateScans(db: Db) {
  const scans = await lastScans(db);
  for (const entity of ['contact', 'company'] as const) {
    const last = scans[entity] ? new Date(scans[entity]!).getTime() : 0;
    if (Date.now() - last < SCAN_EVERY_MS) continue;
    // One scan per entity per 6-hour slot (the platform's dedupe key).
    await enqueue(db, 'duplicates.scan', {entity}, {key: `dup-scan-${entity}-${Math.floor(Date.now() / SCAN_EVERY_MS)}`});
  }
}

// ─── One record ───

/** Ids of records that share a match key with `input` (cheap SQL pre-filter; scoring happens in JS). */
async function contactCandidates(db: Db, k: ContactKeys, exclude: string[]) {
  const f0 = k.first.slice(0, 1);
  const rows = await db.$queryRaw<{id: string}[]>`
    SELECT c.id FROM "Contact" c
    WHERE NOT (c.id = ANY(${exclude}::text[])) AND (
      (${k.emailKey}::text IS NOT NULL AND c.email IS NOT NULL AND ${emailKeySql(Prisma.raw('c.email'))} = ${k.emailKey})
      OR (${k.phoneKey}::text IS NOT NULL AND length(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g')) >= 7 AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${k.phoneKey})
      OR (${k.last}::text <> '' AND lower(c."lastName") = ${k.last})
      OR (${k.last}::text = '' AND lower(c."firstName") = ${k.first})
      OR (${f0}::text <> '' AND lower(left(c."firstName", 1)) = ${f0} AND (
        EXISTS (SELECT 1 FROM "ContactCompany" cc WHERE cc."contactId" = c.id AND cc."companyId" = ANY(${k.companyIds}::text[]))
        OR (${k.domain}::text IS NOT NULL AND lower(split_part(c.email, '@', 2)) = ${k.domain})
      ))
    )
    LIMIT 300`;
  return rows.map((r) => r.id);
}

async function companyCandidates(db: Db, k: CompanyKeys, exclude: string[]) {
  const prefix = k.name.replace(/ /g, '').slice(0, 3);
  const rows = await db.$queryRaw<{id: string}[]>`
    SELECT c.id FROM "Company" c
    WHERE NOT (c.id = ANY(${exclude}::text[])) AND (
      (${k.domain}::text IS NOT NULL AND (lower(c.domain) = ${k.domain}
        OR regexp_replace(regexp_replace(lower(coalesce(c.website, '')), '^https?://(www\\.)?', ''), '[/?#].*$', '') = ${k.domain}))
      OR (${prefix}::text <> '' AND lower(left(regexp_replace(regexp_replace(lower(c.name), '^the\\s+', ''), '[^a-z0-9]', '', 'g'), 3)) = ${prefix})
    )
    LIMIT 300`;
  return rows.map((r) => r.id);
}

export type LikelyDuplicate = Match & {id: string};

/**
 * Existing records that `input` probably duplicates, best first. Used by the
 * create dialogs (input not saved yet) and by `checkDuplicates()`.
 * `ownerId` narrows to one owner's records (owner-only visibility).
 */
export async function findLikelyDuplicates(db: Db, entity: DupEntity, input: ContactInput | CompanyInput, opts: {exclude?: string[]; ownerId?: string; min?: number} = {}): Promise<LikelyDuplicate[]> {
  const exclude = opts.exclude ?? [];
  const owner = opts.ownerId ? {ownerId: opts.ownerId} : {};
  let matches: LikelyDuplicate[] = [];
  if (entity === 'contact') {
    const k = contactKeys(input as ContactInput);
    if (!k.emailKey && !k.phoneKey && !k.name) return [];
    const ids = await contactCandidates(db, k, exclude);
    const rows = ids.length ? await loadContacts(db, {id: {in: ids}, ...owner}) : [];
    matches = rows.flatMap((r) => {
      const m = scoreContacts(k, r);
      return m ? [{id: r.id, ...m}] : [];
    });
  } else {
    const k = companyKeys(input as CompanyInput);
    if (!k.domain && !k.name) return [];
    const ids = await companyCandidates(db, k, exclude);
    const rows = ids.length ? await loadCompanies(db, {id: {in: ids}, ...owner}) : [];
    matches = rows.flatMap((r) => {
      const m = scoreCompanies(k, r);
      return m ? [{id: r.id, ...m}] : [];
    });
  }
  return matches.filter((m) => m.score >= (opts.min ?? 0)).sort((a, b) => b.score - a.score);
}

/** Re-checks one record after it was created, edited or restored. Never throws. */
export async function checkDuplicates(db: Db, entity: DupEntity, id: string) {
  try {
    const input =
      entity === 'contact'
        ? await db.contact.findUnique({where: {id}, select: {id: true, firstName: true, lastName: true, email: true, phone: true, companies: {select: {companyId: true}}}}).then((c) => c && {...c, companyIds: c.companies.map((l) => l.companyId)})
        : await db.company.findUnique({where: {id}, select: {id: true, name: true, domain: true, website: true}});
    const matches = input ? await findLikelyDuplicates(db, entity, input, {exclude: [id]}) : [];
    const found: Found = new Map(matches.map((m) => [pairKey(id, m.id), {score: m.score, reasons: m.reasons, aId: id < m.id ? id : m.id, bId: id < m.id ? m.id : id}]));
    await syncPairs(db, entity, found, {ids: [id]});
  } catch (e) {
    console.error('[duplicates]', entity, id, String((e as Error)?.message ?? e).slice(0, 200));
  }
}

/** Pairs that mention these records are gone (after a merge, the dropped record). */
export async function forgetPairs(db: Db, ids: string[]) {
  await db.duplicatePair.deleteMany({where: {OR: [{aId: {in: ids}}, {bId: {in: ids}}]}});
}
