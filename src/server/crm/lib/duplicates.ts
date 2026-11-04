import {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {enqueue} from './jobs';
import {strings} from './json-list';

/**
 * Duplicate detection for contacts and companies. Records are reduced to
 * match keys (normalised email / phone / name / domain); a full scan lets the
 * database group records that share a key, scores the pairs inside each group
 * and syncs the result into `DuplicatePair` (dismissed pairs are never
 * re-opened). The same scoring runs for one record after it is created, edited
 * or restored (`checkDuplicates()`, as a job through `queueDuplicateCheck()`)
 * and for the "Possible duplicate" hint in the create dialogs
 * (`findLikelyDuplicates()`), so all three always agree.
 */

export type DupEntity = 'contact' | 'company';
export type Match = {score: number; reasons: string[]};

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com',
]);

/** Case-insensitive, without +tags; Gmail also ignores dots (j.doe@gmail.com = jdoe@googlemail.com). Mirrors emailKeySql(). */
function normEmail(email?: string | null) {
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
function normName(s?: string | null) {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const LEGAL = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|plc|bv|nv|srl|pty|oy|ab|as|group|holding|holdings)\b/g;
const normCompany = (name?: string | null) => normName(name).replace(/^the /, '').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

function normDomain(v?: string | null) {
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

function similarity(a: Set<string>, b: Set<string>) {
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

/** Groups bigger than this are skipped (too generic to mean anything). */
const MAX_BLOCK = 400;

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
    if (p.status === 'open' && m && (m.score !== p.score || m.reasons.join() !== strings(p.reasons).join())) {
      await db.duplicatePair.update({where: {id: p.id}, data: {score: m.score, reasons: m.reasons}});
      updated++;
    }
  }
  return {found: found.size, created: create.length, removed: stale.length, updated};
}

const SCAN_KEY = 'duplicates.lastScan';

/** Groups (records sharing a match key) one scan looks at, and records it loads; past either the scan is partial. */
const MAX_GROUPS = 20_000;
const MAX_RECORDS = 50_000;
const LOAD_CHUNK = 1000;

/** Lower case, common accents folded, anything else not a-z0-9 → space, trimmed (close to normName()). */
const nameSql = (col: Prisma.Sql) =>
  Prisma.sql`trim(regexp_replace(translate(lower(coalesce(${col}, '')), 'àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿžšß', 'aaaaaaaccceeeeeeiiiiinnooooooouuuuuyyzss'), '[^a-z0-9]+', ' ', 'g'))`;
/** normDomain() in SQL: no scheme, no www., no path; only values with a dot. */
const domainSql = (col: Prisma.Sql) =>
  Prisma.sql`NULLIF(rtrim(regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(${col}, ''))), '^https?://', ''), '^www\\.', ''), '[/?#].*$', ''), '.'), '')`;

/**
 * Candidate groups of one entity (ids are cuids: no commas), found by the database: records that share a normalised email,
 * phone, last name (first name when there is none), first initial + company or + work domain
 * (contacts); a domain or a name prefix (companies). Groups of one, and groups too generic to mean
 * anything (over MAX_BLOCK), are left out. Only these records are loaded and scored, never the table.
 */
async function candidateGroups(db: Db, entity: DupEntity): Promise<string[][]> {
  if (entity === 'contact') {
    const last = nameSql(Prisma.raw('c."lastName"'));
    const first = nameSql(Prisma.raw('c."firstName"'));
    const rows = await db.$queryRaw<{ids: string}[]>`
      WITH k AS (
        SELECT c.id, 'e:' || ${emailKeySql(Prisma.raw('c.email'))} AS g FROM "Contact" c WHERE c.email LIKE '%@%'
        UNION ALL
        SELECT c.id, 'p:' || right(regexp_replace(c.phone, '\\D', '', 'g'), 10) FROM "Contact" c WHERE length(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g')) >= 7
        UNION ALL
        SELECT c.id, 'l:' || ${last} FROM "Contact" c WHERE ${last} <> ''
        UNION ALL
        SELECT c.id, 'f:' || ${first} FROM "Contact" c WHERE ${last} = '' AND ${first} <> ''
        UNION ALL
        SELECT c.id, 'c:' || left(${first}, 1) || ':' || cc."companyId" FROM "Contact" c JOIN "ContactCompany" cc ON cc."contactId" = c.id WHERE ${first} <> ''
        UNION ALL
        SELECT c.id, 'd:' || left(${first}, 1) || ':' || lower(split_part(c.email, '@', 2)) FROM "Contact" c
        WHERE c.email LIKE '%@%' AND ${first} <> '' AND lower(split_part(c.email, '@', 2)) NOT IN (${Prisma.join([...FREE_MAIL])})
      )
      SELECT string_agg(id, ',') AS ids FROM k GROUP BY g HAVING count(*) BETWEEN 2 AND ${MAX_BLOCK} ORDER BY g LIMIT ${MAX_GROUPS}`;
    return rows.map((r) => r.ids.split(','));
  }
  const domain = Prisma.sql`COALESCE(${domainSql(Prisma.raw('c.domain'))}, ${domainSql(Prisma.raw('c.website'))})`;
  const rows = await db.$queryRaw<{ids: string}[]>`
    WITH k AS (
      SELECT c.id, 'd:' || ${domain} AS g FROM "Company" c WHERE position('.' in coalesce(${domain}, '')) > 0
      UNION ALL
      SELECT c.id, 'b:' || lower(left(regexp_replace(regexp_replace(lower(c.name), '^the\\s+', ''), '[^a-z0-9]', '', 'g'), 3)) FROM "Company" c
      WHERE regexp_replace(regexp_replace(lower(c.name), '^the\\s+', ''), '[^a-z0-9]', '', 'g') <> ''
    )
    SELECT string_agg(id, ',') AS ids FROM k GROUP BY g HAVING count(*) BETWEEN 2 AND ${MAX_BLOCK} ORDER BY g LIMIT ${MAX_GROUPS}`;
  return rows.map((r) => r.ids.split(','));
}

/** Scores every pair inside each group (each pair once). */
function pairsFromGroups<K extends {id: string}>(groups: string[][], byId: Map<string, K>, score: (a: K, b: K) => Match | null): Found {
  const seen = new Set<string>();
  const found: Found = new Map();
  for (const group of groups) {
    const list = group.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
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

/**
 * Full scan of one entity (job `duplicates.scan`, "Scan now"): candidate groups come from SQL
 * (`candidateGroups`), only their records are loaded and scored. Also drops dismissed pairs whose
 * records are gone for good. A scan cut short by its caps keeps the open pairs it did not see.
 */
export async function scanDuplicates(db: Db, entity: DupEntity) {
  const groups = await candidateGroups(db, entity);
  const ids = [...new Set(groups.flat())].slice(0, MAX_RECORDS);
  const partial = groups.length >= MAX_GROUPS || ids.length >= MAX_RECORDS;
  const found: Found = new Map();
  if (entity === 'contact') {
    const byId = new Map<string, ContactKeys>();
    for (let k = 0; k < ids.length; k += LOAD_CHUNK) for (const r of await loadContacts(db, {id: {in: ids.slice(k, k + LOAD_CHUNK)}})) byId.set(r.id, r);
    for (const [key, m] of pairsFromGroups(groups, byId, scoreContacts)) found.set(key, m);
  } else {
    const byId = new Map<string, CompanyKeys>();
    for (let k = 0; k < ids.length; k += LOAD_CHUNK) for (const r of await loadCompanies(db, {id: {in: ids.slice(k, k + LOAD_CHUNK)}})) byId.set(r.id, r);
    for (const [key, m] of pairsFromGroups(groups, byId, scoreCompanies)) found.set(key, m);
  }
  const result = partial ? await syncPairs(db, entity, found, {ids}) : await syncPairs(db, entity, found, {});
  // Dismissed pairs of merged / purged records (binned ones stay, they may come back).
  if (entity === 'contact') {
    await db.$executeRaw`
      DELETE FROM "DuplicatePair" p WHERE p.entity = 'contact' AND p.status = 'dismissed' AND (
        (NOT EXISTS (SELECT 1 FROM "Contact" x WHERE x.id = p."aId") AND NOT EXISTS (SELECT 1 FROM "DeletedRecord" d WHERE d.entity = 'contact' AND d."recordId" = p."aId"))
        OR (NOT EXISTS (SELECT 1 FROM "Contact" x WHERE x.id = p."bId") AND NOT EXISTS (SELECT 1 FROM "DeletedRecord" d WHERE d.entity = 'contact' AND d."recordId" = p."bId")))`;
  } else {
    await db.$executeRaw`
      DELETE FROM "DuplicatePair" p WHERE p.entity = 'company' AND p.status = 'dismissed' AND (
        (NOT EXISTS (SELECT 1 FROM "Company" x WHERE x.id = p."aId") AND NOT EXISTS (SELECT 1 FROM "DeletedRecord" d WHERE d.entity = 'company' AND d."recordId" = p."aId"))
        OR (NOT EXISTS (SELECT 1 FROM "Company" x WHERE x.id = p."bId") AND NOT EXISTS (SELECT 1 FROM "DeletedRecord" d WHERE d.entity = 'company' AND d."recordId" = p."bId")))`;
  }
  const row = await db.setting.findUnique({where: {key: SCAN_KEY}});
  const value = {...((row?.value ?? {}) as object), [entity]: new Date().toISOString()};
  await db.setting.upsert({where: {key: SCAN_KEY}, create: {key: SCAN_KEY, value}, update: {value}});
  return {...result, records: ids.length, ...(partial ? {partial: true} : {})};
}

export async function lastScans(db: Db) {
  const row = await db.setting.findUnique({where: {key: SCAN_KEY}});
  return (row?.value ?? {}) as Partial<Record<DupEntity, string>>;
}

const SCAN_EVERY_MS = 6 * 60 * 60_000;

/** Called by the `crm-tick` schedule (every minute; one settings read): queues a full scan per entity every 6 hours. */
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

/** `c.id` not one of `ids` (bound one by one: the live driver can't bind an array parameter). */
const notIn = (ids: string[]) => (ids.length ? Prisma.sql`NOT (c.id IN (${Prisma.join(ids)}))` : Prisma.sql`TRUE`);

/** Ids of records that share a match key with `input` (cheap SQL pre-filter; scoring happens in JS). */
async function contactCandidates(db: Db, k: ContactKeys, exclude: string[]) {
  const f0 = k.first.slice(0, 1);
  const sameCompany = k.companyIds.length ? Prisma.sql`cc."companyId" IN (${Prisma.join(k.companyIds)})` : Prisma.sql`FALSE`;
  const rows = await db.$queryRaw<{id: string}[]>`
    SELECT c.id FROM "Contact" c
    WHERE ${notIn(exclude)} AND (
      (${k.emailKey}::text IS NOT NULL AND c.email IS NOT NULL AND ${emailKeySql(Prisma.raw('c.email'))} = ${k.emailKey})
      OR (${k.phoneKey}::text IS NOT NULL AND length(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g')) >= 7 AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${k.phoneKey})
      OR (${k.last}::text <> '' AND lower(c."lastName") = ${k.last})
      OR (${k.last}::text = '' AND lower(c."firstName") = ${k.first})
      OR (${f0}::text <> '' AND lower(left(c."firstName", 1)) = ${f0} AND (
        EXISTS (SELECT 1 FROM "ContactCompany" cc WHERE cc."contactId" = c.id AND ${sameCompany})
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
    WHERE ${notIn(exclude)} AND (
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

/**
 * Queues the duplicate check of one record after it was created, edited or restored, instead of
 * running it inside the request (it reads the table for candidates). One job per version of the
 * record (its `updatedAt` is in the key): repeated calls for the same save queue it once.
 */
export async function queueDuplicateCheck(db: Db, entity: DupEntity, id: string): Promise<void> {
  try {
    const row = entity === 'contact' ? await db.contact.findUnique({where: {id}, select: {updatedAt: true}}) : await db.company.findUnique({where: {id}, select: {updatedAt: true}});
    if (!row) return;
    await enqueue(db, 'duplicates.check', {entity, id}, {key: `dup-check-${id}-${row.updatedAt.getTime()}`});
  } catch (e) {
    console.error('[duplicates] queue', entity, String((e as Error)?.message ?? e).slice(0, 200));
  }
}

/** Pairs that mention these records are gone (after a merge, the dropped record). */
export async function forgetPairs(db: Db, ids: string[]) {
  await db.duplicatePair.deleteMany({where: {OR: [{aId: {in: ids}}, {bId: {in: ids}}]}});
}
