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

/** A record's name trigrams, made when a comparison needs them (a scan drops them after each group). */
const gramsOf = (k: {name: string; grams?: Set<string>}) => (k.grams ??= trigrams(k.name));

function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// ─── Keys & scoring ───

type ContactInput = {id?: string; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; companyIds?: string[]};
type ContactKeys = {id: string; name: string; first: string; last: string; grams?: Set<string>; emailKey: string | null; domain: string | null; phoneKey: string | null; companyIds: string[]};

function contactKeys(c: ContactInput): ContactKeys {
  const first = normName(c.firstName);
  const last = normName(c.lastName);
  const name = [first, last].filter(Boolean).join(' ');
  const emailKey = normEmail(c.email);
  return {id: c.id ?? '', name, first, last, emailKey, domain: emailKey?.split('@')[1] ?? null, phoneKey: phoneKey(c.phone), companyIds: c.companyIds ?? []};
}

function scoreContacts(a: ContactKeys, b: ContactKeys): Match | null {
  const reasons: string[] = [];
  let score = 0;
  const hit = (reason: string, s: number) => (reasons.push(reason), (score = Math.max(score, s)));
  const sim = !a.name || !b.name ? 0 : a.name === b.name ? 1 : similarity(gramsOf(a), gramsOf(b));
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
type CompanyKeys = {id: string; name: string; grams?: Set<string>; domain: string | null};

function companyKeys(c: CompanyInput): CompanyKeys {
  const name = normCompany(c.name);
  return {id: c.id ?? '', name, domain: normDomain(c.domain) ?? normDomain(c.website)};
}

function scoreCompanies(a: CompanyKeys, b: CompanyKeys): Match | null {
  const reasons: string[] = [];
  let score = 0;
  const hit = (reason: string, s: number) => (reasons.push(reason), (score = Math.max(score, s)));
  const conflict = !!a.domain && !!b.domain && a.domain !== b.domain;
  if (a.domain && a.domain === b.domain) hit('domain', 95);
  if (a.name && a.name === b.name) hit('company_name', conflict ? 50 : 85);
  else if (!conflict && a.name && b.name && similarity(gramsOf(a), gramsOf(b)) >= 0.75) hit('similar_company_name', 60);
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

/**
 * Writes found pairs. Open pairs in `scope` that were not found again are removed (never with
 * `keep`: a scan cut short); dismissed ones stay dismissed.
 */
async function syncPairs(db: Db, entity: DupEntity, found: Found, scope: {ids?: string[]; keep?: boolean}) {
  const select = {id: true, aId: true, bId: true, status: true, score: true, reasons: true} as const;
  let existing: Prisma.DuplicatePairGetPayload<{select: typeof select}>[];
  if (!scope.ids) existing = await db.duplicatePair.findMany({where: {entity}, select});
  else {
    // In chunks: a scan's scope can hold thousands of ids (each one a bound parameter).
    const byId = new Map<string, (typeof existing)[number]>();
    for (let k = 0; k < scope.ids.length; k += LOAD_CHUNK) {
      const chunk = scope.ids.slice(k, k + LOAD_CHUNK);
      for (const p of await db.duplicatePair.findMany({where: {entity, OR: [{aId: {in: chunk}}, {bId: {in: chunk}}]}, select})) byId.set(p.id, p);
    }
    existing = [...byId.values()];
  }
  const byKey = new Map(existing.map((p) => [`${p.aId}|${p.bId}`, p]));
  const create = [...found.entries()].filter(([k]) => !byKey.has(k)).map(([, m]) => ({entity, aId: m.aId, bId: m.bId, score: m.score, reasons: m.reasons}));
  if (create.length) await db.duplicatePair.createMany({data: create, skipDuplicates: true});
  const stale = scope.keep ? [] : existing.filter((p) => p.status === 'open' && !found.has(`${p.aId}|${p.bId}`)).map((p) => p.id);
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

/** Pairs one scan scores, and matches it keeps, at most: past either the scan is partial (AUDIT-2 M-12). */
export const SCAN_LIMITS = {pairs: 2_000_000, found: 20_000};

/**
 * Scores the pairs inside each group. Only matches are kept (a pair met again in another group is
 * scored again rather than remembered), name trigrams are dropped after each group, and the scan
 * stops at SCAN_LIMITS: memory stays bounded however many contacts there are.
 */
function pairsFromGroups<K extends {id: string; grams?: Set<string>}>(groups: string[][], byId: Map<string, K>, score: (a: K, b: K) => Match | null, limits = SCAN_LIMITS): {found: Found; partial: boolean} {
  const found: Found = new Map();
  let scored = 0;
  for (const group of groups) {
    const list = group.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    try {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = pairKey(list[i]!.id, list[j]!.id);
          if (found.has(key)) continue;
          if (++scored > limits.pairs || found.size >= limits.found) return {found, partial: true};
          const m = score(list[i]!, list[j]!);
          if (m) found.set(key, {...m, aId: key.split('|')[0]!, bId: key.split('|')[1]!});
        }
      }
    } finally {
      for (const k of list) k.grams = undefined;
    }
  }
  return {found, partial: false};
}

/**
 * Full scan of one entity (job `duplicates.scan`, "Scan now"): candidate groups come from SQL
 * (`candidateGroups`), only their records are loaded and scored. Also drops dismissed pairs whose
 * records are gone for good. A scan cut short by its caps keeps the open pairs it did not see.
 */
export async function scanDuplicates(db: Db, entity: DupEntity, limits = SCAN_LIMITS) {
  const groups = await candidateGroups(db, entity);
  const ids = [...new Set(groups.flat())].slice(0, MAX_RECORDS);
  let partial = groups.length >= MAX_GROUPS || ids.length >= MAX_RECORDS;
  let found: Found;
  if (entity === 'contact') {
    const byId = new Map<string, ContactKeys>();
    for (let k = 0; k < ids.length; k += LOAD_CHUNK) for (const r of await loadContacts(db, {id: {in: ids.slice(k, k + LOAD_CHUNK)}})) byId.set(r.id, r);
    const r = pairsFromGroups(groups, byId, scoreContacts, limits);
    found = r.found;
    partial ||= r.partial;
  } else {
    const byId = new Map<string, CompanyKeys>();
    for (let k = 0; k < ids.length; k += LOAD_CHUNK) for (const r of await loadCompanies(db, {id: {in: ids.slice(k, k + LOAD_CHUNK)}})) byId.set(r.id, r);
    const r = pairsFromGroups(groups, byId, scoreCompanies, limits);
    found = r.found;
    partial ||= r.partial;
  }
  // Cut short: write what was found, remove nothing (the pairs it did not reach stay as they are).
  const scopeIds = [...new Set([...found.values()].flatMap((m) => [m.aId, m.bId]))];
  const result = partial ? await syncPairs(db, entity, found, {ids: scopeIds, keep: true}) : await syncPairs(db, entity, found, {});
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

// ─── "Scan now" (Settings → Duplicates, admins) ───

/** Settings row: the entities a manual scan still has queued or running (`{contact: iso, company: iso}`); `{}` = none. */
const MANUAL_KEY = 'duplicates.manualScan';
/** A manual scan whose job never ended (it failed for good) stops blocking the button after this. */
const MANUAL_STALE_MS = 15 * 60_000;

/**
 * Queues a full scan of `entities` as background jobs, one manual scan at a time: the claim is one
 * conditional statement on one row, so two clicks (or two admins) at once queue it once.
 * Returns false when one is still queued or running.
 */
export async function queueManualScan(db: Db, entities: DupEntity[]): Promise<boolean> {
  const now = new Date();
  const value = JSON.stringify(Object.fromEntries(entities.map((e) => [e, now.toISOString()])));
  const stale = new Date(now.getTime() - MANUAL_STALE_MS);
  const claimed = await db.$queryRaw<{key: string}[]>`
    INSERT INTO "Setting" (key, value, "updatedAt") VALUES (${MANUAL_KEY}, ${value}::jsonb, ${now})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"
    WHERE "Setting".value = '{}'::jsonb OR jsonb_typeof("Setting".value) <> 'object' OR "Setting"."updatedAt" < ${stale}
    RETURNING key`;
  if (!claimed.length) return false;
  for (const entity of entities) await enqueue(db, 'duplicates.scan', {entity, manual: true}, {key: `dup-scan-${entity}-manual-${now.getTime()}`, label: 'Duplicate scan · Scan now'});
  return true;
}

/** A manual scan of `entity` ended (done or failed for good): the button is free once every entity has. */
export async function endManualScan(db: Db, entity: DupEntity) {
  await db.$executeRaw`UPDATE "Setting" SET value = value - ${entity}::text WHERE key = ${MANUAL_KEY} AND jsonb_typeof(value) = 'object'`;
}

/** Whether a manual scan is queued or running (Settings → Duplicates shows it). */
export async function manualScanRunning(db: Db) {
  const row = await db.setting.findUnique({where: {key: MANUAL_KEY}, select: {value: true, updatedAt: true}});
  const v = row?.value;
  return !!row && !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && row.updatedAt.getTime() > Date.now() - MANUAL_STALE_MS;
}

/** `duplicates.scan` job. A manual one frees "Scan now" when it ends, also when it fails on its last try. */
export async function scanJob(db: Db, entity: DupEntity, manual: boolean, lastTry: boolean) {
  if (!manual) return void (await scanDuplicates(db, entity));
  let ok = false;
  try {
    await scanDuplicates(db, entity);
    ok = true;
  } finally {
    if (ok || lastTry) await endManualScan(db, entity);
  }
}

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

/**
 * Ids of records that share a match key with `input` (cheap SQL pre-filter; scoring happens in JS).
 * One indexed branch per key (AUDIT-2 L-13: the "possible duplicate" hint ran a scan of every
 * contact per keystroke pause): the email and phone keys have expression indexes
 * (crm_duplicate_hint_indexes), names and the work domain use the trigram indexes with an ILIKE that
 * has no wildcard but the domain's, a shared company the ContactCompany index. Each branch stops at
 * 300 rows.
 */
async function contactCandidates(db: Db, k: ContactKeys, exclude: string[]) {
  const f0 = k.first.slice(0, 1);
  const branches: Prisma.Sql[] = [];
  if (k.emailKey) branches.push(Prisma.sql`SELECT c.id FROM "Contact" c WHERE ${emailKeySql(Prisma.raw('c.email'))} = ${k.emailKey} LIMIT 300`);
  // The last 10 digits equal a 7+ digit key only when the phone has 7+ digits itself.
  if (k.phoneKey) branches.push(Prisma.sql`SELECT c.id FROM "Contact" c WHERE right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${k.phoneKey} LIMIT 300`);
  // Normalised names hold only a-z, 0-9 and spaces: no LIKE wildcards, so ILIKE is an equality the trigram index serves.
  if (k.last) branches.push(Prisma.sql`SELECT c.id FROM "Contact" c WHERE c."lastName" ILIKE ${k.last} LIMIT 300`);
  else if (k.first) branches.push(Prisma.sql`SELECT c.id FROM "Contact" c WHERE c."firstName" ILIKE ${k.first} LIMIT 300`);
  if (f0 && k.companyIds.length) {
    branches.push(Prisma.sql`SELECT c.id FROM "ContactCompany" cc JOIN "Contact" c ON c.id = cc."contactId" WHERE cc."companyId" IN (${Prisma.join(k.companyIds)}) AND lower(left(c."firstName", 1)) = ${f0} LIMIT 300`);
  }
  if (f0 && k.domain && /^[a-z0-9.-]+$/.test(k.domain)) {
    branches.push(Prisma.sql`SELECT c.id FROM "Contact" c WHERE c.email ILIKE ${`%@${k.domain}`} AND lower(split_part(c.email, '@', 2)) = ${k.domain} AND lower(left(c."firstName", 1)) = ${f0} LIMIT 300`);
  }
  if (!branches.length) return [];
  const rows = await db.$queryRaw<{id: string}[]>`
    SELECT DISTINCT c.id FROM (${Prisma.join(branches.map((b) => Prisma.sql`(${b})`), ' UNION ALL ')}) c
    WHERE ${notIn(exclude)}
    LIMIT 300`;
  return rows.map((r) => r.id);
}

/**
 * Company candidates, the same way (AUDIT-2 L-13): every branch is served by a trigram index
 * (`Company_domain_trgm_idx`, `Company_name_trgm_idx`) and capped, best first. The domain as a
 * substring of the stored domain (stored as typed by imports: `www.`, a path); the name by pg_trgm
 * word similarity (`<%`) and by its first word at the start ("Acme" finds "The Acme Holdings Ltd",
 * whose legal words lower the similarity). Normalised names and the checked domain hold no LIKE
 * wildcards. A company known only by its website is left to the 6-hourly scan, which reads it.
 */
async function companyCandidates(db: Db, k: CompanyKeys, exclude: string[]) {
  const branches: Prisma.Sql[] = [];
  if (k.domain && /^[a-z0-9.-]+$/.test(k.domain)) {
    branches.push(Prisma.sql`SELECT c.id FROM "Company" c WHERE c.domain ILIKE ${`%${k.domain}%`} ORDER BY lower(c.domain) = ${k.domain}::text DESC LIMIT 50`);
  }
  if (k.name) {
    branches.push(Prisma.sql`SELECT c.id FROM "Company" c WHERE ${k.name}::text <% c.name ORDER BY word_similarity(${k.name}::text, c.name) DESC LIMIT 100`);
    // A 1-2 letter first word would match most names: the similarity branch covers those.
    const first = k.name.split(' ')[0]!;
    if (first.length >= 3) branches.push(Prisma.sql`SELECT c.id FROM "Company" c WHERE c.name ILIKE ${`${first}%`} OR c.name ILIKE ${`the ${first}%`} ORDER BY similarity(${k.name}::text, c.name) DESC LIMIT 100`);
  }
  if (!branches.length) return [];
  const rows = await db.$queryRaw<{id: string}[]>`
    SELECT DISTINCT c.id FROM (${Prisma.join(branches.map((b) => Prisma.sql`(${b})`), ' UNION ALL ')}) c
    WHERE ${notIn(exclude)}
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
