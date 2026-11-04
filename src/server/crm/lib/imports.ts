/**
 * CSV imports (contacts, companies, deals), run as background jobs.
 *
 *   import.validate   dry run: every row through the same code as the real
 *                     run, nothing written; per-row errors / warnings and the
 *                     create / update / skip counts land on the Import.
 *   import.run        the real thing, 200 rows per batch, ~8 s per job, then
 *                     the job queues the next one (self-chaining).
 *
 * Retries never duplicate rows: every record, link, note and timeline entry an
 * import creates gets an id derived from (import, row), so a batch that is run
 * again finds its own rows (`skipDuplicates`) and only fires events for rows it
 * really inserted. Records go through the API's zod schemas (`contactBody`…),
 * so an import accepts exactly what the forms accept. Shapes, targets and value
 * parsers are shared with the drawer in src/lib/import-export.ts.
 */
import {Prisma, type CustomFieldDef, type Import} from '../../../generated/prisma/client';
import type {JobRun} from '../kit/job-run';
import type {User} from '../kit/guards';
import {
  IO_ENTITIES,
  IO_FILE_DAYS,
  NEW_OPTION,
  cleanCell,
  emailOf,
  importTargets,
  parseCell,
  type ImportCounts,
  type ImportOptions,
  type ImportStats,
  type ImportTarget,
  type IoEntity,
} from '@/lib/import-export';
import {config, CRM_APP} from '../kit/config';
import {randomToken, sha256Hex} from '../kit/crypto';
import type {Db} from '../kit/db';
import {companyBody, normalizeDomain} from '../routes/companies';
import {contactBody} from '../routes/contacts';
import {dealBody} from '../routes/deals';
import {publicFileUrl} from '../routes/files';
import {sendSystemEmail} from '../email/service';
import {customDiff, diff, logActivity} from './activity';
import {audit} from './audit';
import {CSV_BOM, csvLine, parseCsv} from './csv';
import {nameFromDomain, workDomain} from './domains';
import {emitMany} from './events';
import {enqueue} from './jobs';
import {notify} from './notify';
import {queueRescore} from './scoring-hook';
import {addToList} from './segments';
import {getSettings, rememberOption, type AppSettings} from './settings';
import {userScope} from './http';
import {readBytes, storeBytes} from '../kit/storage';
import {memberWithEmail} from './users';
import {strings, withStrings} from './json-list';

const BATCH = 200;
/** Deal updates write history, timeline and events per row: smaller batches keep each one short. */
const DEAL_UPDATE_BATCH = 25;
/** Every raw lookup is bounded: a batch's keys can match at most this many rows (ten per key). */
const LOOKUP_LIMIT = BATCH * 10;
/** A job's time for batches (checked before each one; a job has 60 s): fewer, fuller jobs within the platform's job rate. */
const BUDGET_MS = 25_000;
/** Issues kept per phase; counts stay exact beyond this. */
const MAX_ISSUES = 50_000;

type Phase = 'validate' | 'run';
type Level = 'error' | 'warning';
type Issue = {level: Level; column: string | null; message: string};
type Pipe = Prisma.PipelineGetPayload<{include: {stages: true}}>;
type CompanyRef = {key: string; name?: string; domain?: string};

type Ctx = {
  db: Db;
  imp: Import;
  phase: Phase;
  dry: boolean;
  entity: IoEntity;
  options: ImportOptions;
  mapping: (string | null)[];
  targets: Map<string, ImportTarget>;
  /** target key → column header (for issue messages). */
  columnOf: Map<string, string>;
  defs: Map<string, CustomFieldDef>;
  user: User;
  scopeOwnerId: string | null;
  usersByEmail: Map<string, string>;
  usersByName: Map<string, string>;
  defaultOwnerId: string | null;
  pipelines: Pipe[];
  settings: AppSettings;
  /** match key → index of the first row that has it (in-file duplicates). */
  firstIndex: Map<string, number>;
  /** company key → id, or NEW while dry-running. */
  companies: Map<string, string | null>;
  now: Date;
  tagged: string | null;
};

const NEW = '__new__';

/** A cuid-looking id that is the same every time for the same (import, row, kind). */
async function detId(...parts: (string | number)[]) {
  return `c${(await sha256Hex(parts.join(':'))).slice(0, 24)}`;
}

const lower = (s: string) => s.trim().toLowerCase();

// ─── Loading ────────────────────────────────────────────────────────────────

async function loadImportFile(db: Db, imp: Pick<Import, 'fileId' | 'delimiter'>) {
  const file = imp.fileId ? await db.file.findUnique({where: {id: imp.fileId}, select: {storageId: true, ready: true}}) : null;
  if (!file?.ready) throw new Error('The uploaded file is gone (files are kept for 7 days). Upload it again.');
  return parseCsv(await readBytes(file), imp.delimiter);
}

async function loadContext(db: Db, imp: Import, phase: Phase, rows: string[][]): Promise<Ctx> {
  const entity = imp.entity as IoEntity;
  const user = imp.userId ? await memberWithEmail(db, {id: imp.userId}) : null;
  if (!user || !user.active) throw new Error('The person who started this import no longer has access');
  const options = imp.options as unknown as ImportOptions;
  const mapping = imp.mapping as unknown as (string | null)[];
  const defs = (await db.customFieldDef.findMany({where: {entity: IO_ENTITIES[entity].fieldEntity}})).map((d) => withStrings(d, 'options'));
  const settings = await getSettings(db);
  // Known pick-list values keep their casing ("software" → "Software").
  const lists: Record<string, string[]> = {industry: settings.industries, type: entity === 'company' ? settings.companyTypes : [], source: settings.sources, lostReason: settings.lostReasons};
  const targets = new Map(importTargets(entity, defs).map((t) => [t.key, lists[t.key]?.length ? {...t, suggest: [...(t.suggest ?? []), ...lists[t.key]!]} : t]));
  const columnOf = new Map<string, string>();
  mapping.forEach((key, i) => key && columnOf.set(key, strings(imp.headers)[i] || `Column ${i + 1}`));
  // Invited teammates who have not joined yet own records by their invite address, as in the original.
  const users = (await db.member.findMany({where: {active: true}, select: {id: true, name: true, inviteEmail: true, user: {select: {email: true}}}})).map((u) => ({id: u.id, name: u.name, email: u.user?.email ?? '', inviteEmail: u.inviteEmail ?? ''}));
  const usersByName = new Map<string, string>();
  for (const u of users) if (u.name && !usersByName.has(lower(u.name))) usersByName.set(lower(u.name), u.id);
  const usersByEmail = new Map<string, string>();
  for (const u of users) for (const e of [u.email, u.inviteEmail]) if (e && !usersByEmail.has(lower(e))) usersByEmail.set(lower(e), u.id);
  const scope = await userScope(db, user);
  const ctx: Ctx = {
    db,
    imp,
    phase,
    dry: phase === 'validate',
    entity,
    options,
    mapping,
    targets,
    columnOf,
    defs: new Map(defs.map((d) => [d.key, d])),
    user,
    scopeOwnerId: scope.ownerId ?? null,
    usersByEmail,
    usersByName,
    defaultOwnerId: options.defaultOwner === 'me' ? user.id : options.defaultOwner && users.some((u) => u.id === options.defaultOwner) ? options.defaultOwner : null,
    pipelines: entity === 'deal' ? await db.pipeline.findMany({include: {stages: {orderBy: {position: 'asc'}}}, orderBy: [{isDefault: 'desc'}, {position: 'asc'}]}) : [],
    settings,
    firstIndex: new Map(),
    companies: new Map(),
    now: new Date(),
    tagged: options.tag?.trim().toLowerCase().slice(0, 40) || null,
  };
  rows.forEach((cells, index) => {
    for (const key of matchKeys(ctx, cells)) if (!ctx.firstIndex.has(key)) ctx.firstIndex.set(key, index);
  });
  return ctx;
}

// ─── Reading one row ────────────────────────────────────────────────────────

/** Cell for a target: undefined when not mapped, '' when blank. */
function cell(ctx: Ctx, cells: string[], key: string): string | undefined {
  const col = ctx.mapping.indexOf(key);
  return col < 0 ? undefined : cleanCell(cells[col]);
}


function companyRef(ctx: Ctx, cells: string[]): CompanyRef | undefined {
  const name = cell(ctx, cells, 'company') || undefined;
  const domain = normalizeDomain(cell(ctx, cells, 'companyDomain')) || undefined;
  if (!name && !domain) return undefined;
  return {key: domain ? `d:${domain}` : `n:${lower(name!)}`, name: name?.slice(0, 200), domain};
}

/** Keys that identify a row's record; two rows sharing one are duplicates in the file. */
function matchKeys(ctx: Ctx, cells: string[]): string[] {
  const keys: string[] = [];
  const id = cell(ctx, cells, 'id');
  if (id) keys.push(`id:${id}`);
  if (ctx.entity === 'contact') {
    const email = cell(ctx, cells, 'email');
    if (email) keys.push(`email:${emailOf(email)}`);
  } else if (ctx.entity === 'company') {
    const domain = normalizeDomain(cell(ctx, cells, 'domain') || cell(ctx, cells, 'website'));
    const name = cell(ctx, cells, 'name');
    if (domain) keys.push(`d:${domain}`);
    else if (name) keys.push(`n:${lower(name)}`);
  } else {
    const title = cell(ctx, cells, 'title');
    if (title) keys.push(`t:${lower(title)}|${companyRef(ctx, cells)?.key ?? ''}`);
  }
  return keys;
}

type Prepared = {
  index: number;
  row: number;
  cells: string[];
  issues: Issue[];
  keys: string[];
  id?: string;
  /** Standard fields; null clears the value on update. */
  fields: Record<string, unknown>;
  custom: Record<string, unknown>;
  newOptions: Map<string, string[]>;
  tags: string[];
  owner?: string;
  company?: CompanyRef;
  contactEmails: string[];
  pipeline?: string;
  stage?: string;
  note?: string;
};

function prepare(ctx: Ctx, cells: string[], index: number): Prepared {
  const p: Prepared = {index, row: index + 2, cells, issues: [], keys: matchKeys(ctx, cells), fields: {}, custom: {}, newOptions: new Map(), tags: [], contactEmails: []};
  const warn = (key: string, message: string) => p.issues.push({level: 'warning', column: ctx.columnOf.get(key) ?? null, message});
  const blank = (t: ImportTarget) => (t.clearable && !ctx.options.skipBlanks ? null : undefined);

  ctx.mapping.forEach((key, col) => {
    if (!key) return;
    const t = ctx.targets.get(key);
    if (!t) return;
    const raw = cleanCell(cells[col]);
    let value: unknown;
    if (!raw) value = blank(t);
    else {
      const r = parseCell(t, raw, ctx.options);
      for (const w of r.warnings ?? []) warn(key, w);
      if (r.newOptions?.length) p.newOptions.set(key, r.newOptions);
      value = r.value;
    }
    if (value === undefined) return;
    if (key.startsWith('custom.')) p.custom[key.slice(7)] = value;
    else if (key === 'id') p.id = String(value);
    else if (key === 'tags') {
      const tags = (value as string[]).map((tag) => tag.toLowerCase());
      const long = tags.filter((tag) => tag.length > 40);
      if (long.length) warn(key, `Tags longer than 40 characters left out: ${long.join(', ').slice(0, 120)}`);
      p.tags = tags.filter((tag) => tag.length <= 40);
    } else if (key === 'owner') {
      if (value === null) return;
      const v = lower(String(value));
      const id = ctx.usersByEmail.get(v) ?? ctx.usersByName.get(v);
      if (id) p.owner = id;
      else warn(key, `No team member "${value}"; ${ctx.defaultOwnerId ? 'the default owner is used' : 'left without an owner'}`);
    } else if (key === 'contacts') p.contactEmails = (value as string[]).map(emailOf);
    else if (key === 'note') p.note = typeof value === 'string' ? value.slice(0, 20_000) : undefined;
    else if (key === 'pipeline') p.pipeline = value === null ? undefined : String(value);
    else if (key === 'stage') p.stage = value === null ? undefined : String(value);
    else if (key === 'company' || key === 'companyDomain') return; // read together below
    else p.fields[key] = value;
  });
  if (ctx.entity !== 'company') p.company = companyRef(ctx, cells);
  if (ctx.tagged) p.tags = [...new Set([...p.tags, ctx.tagged])];

  if (ctx.entity === 'contact') {
    // "Lee, Ann" or "Ann Lee"
    const full = typeof p.fields.fullName === 'string' ? p.fields.fullName.trim() : '';
    delete p.fields.fullName;
    if (full && p.fields.firstName === undefined) {
      const [a, b] = full.includes(',') ? full.split(',', 2).map((s) => s.trim()).reverse() : [full.split(/\s+/)[0], full.split(/\s+/).slice(1).join(' ')];
      p.fields.firstName = a || undefined;
      if (p.fields.lastName === undefined && b) p.fields.lastName = b;
    }
  }
  if (ctx.entity === 'company' && p.fields.domain === undefined && typeof p.fields.website === 'string') {
    p.fields.domain = normalizeDomain(p.fields.website); // the domain comes from the website when there's no domain column
  }
  if (ctx.entity === 'deal' && typeof p.fields.currency === 'string') {
    const sym: Record<string, string> = {$: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '৳': 'BDT'};
    const cur = sym[p.fields.currency.trim()] ?? p.fields.currency.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(cur)) p.fields.currency = cur;
    else {
      warn('currency', `"${p.fields.currency}" is not a 3-letter currency code; left out`);
      delete p.fields.currency;
    }
  }
  return p;
}

// ─── Resolving related records ──────────────────────────────────────────────

/** Finds (or, when allowed, creates) the companies rows point at. Fills ctx.companies. */
async function resolveCompanies(ctx: Ctx, rows: Prepared[]) {
  const wanted = new Map<string, CompanyRef & {ownerId: string | null; row: number}>();
  for (const p of rows) if (p.company && !ctx.companies.has(p.company.key) && !wanted.has(p.company.key)) wanted.set(p.company.key, {...p.company, ownerId: p.owner ?? ctx.defaultOwnerId, row: p.row});
  if (!wanted.size) return;
  const refs = [...wanted.values()];
  const domains = refs.flatMap((r) => (r.domain ? [r.domain] : []));
  const names = refs.flatMap((r) => (r.name ? [lower(r.name)] : []));
  const [byDomain, byName] = await Promise.all([
    domains.length ? ctx.db.company.findMany({where: {domain: {in: domains}}, select: {id: true, domain: true}, orderBy: {createdAt: 'asc'}}) : [],
    names.length ? ctx.db.$queryRaw<{id: string; n: string}[]>`SELECT id, lower(name) AS n FROM "Company" WHERE lower(name) IN (${Prisma.join(names)}) ORDER BY "createdAt" LIMIT ${LOOKUP_LIMIT}` : [],
  ]);
  const domainHit = new Map<string, string>();
  for (const c of byDomain) if (c.domain && !domainHit.has(c.domain)) domainHit.set(c.domain, c.id);
  const nameHit = new Map<string, string>();
  for (const c of byName) if (!nameHit.has(c.n)) nameHit.set(c.n, c.id);

  const create: (CompanyRef & {ownerId: string | null; id: string})[] = [];
  for (const r of refs) {
    const hit = (r.domain && domainHit.get(r.domain)) || (r.name && nameHit.get(lower(r.name)));
    if (hit) ctx.companies.set(r.key, hit);
    else if (!ctx.options.createCompanies) ctx.companies.set(r.key, null);
    else if (ctx.dry) ctx.companies.set(r.key, NEW);
    else create.push({...r, id: await detId(ctx.imp.id, 'company', r.key)});
  }
  if (!create.length) return;
  const inserted = await ctx.db.company.createManyAndReturn({
    data: create.map((r) => ({
      id: r.id,
      name: r.name ?? nameFromDomain(r.domain!),
      domain: r.domain ?? null,
      website: r.domain ? `https://${r.domain}` : null,
      ownerId: r.ownerId,
      tags: ctx.tagged ? [ctx.tagged] : [],
      lastActivityAt: ctx.now,
    })),
    skipDuplicates: true,
  });
  for (const r of create) ctx.companies.set(r.key, r.id);
  await companiesCreated(ctx, inserted, 'Company created by import');
}

/** Timeline, events and counts for companies an import created (also used when importing companies). */
async function companiesCreated(ctx: Ctx, rows: {id: string; name: string}[], title: string) {
  if (!rows.length) return;
  await ctx.db.activity.createMany({
    data: await Promise.all(rows.map(async (c) => ({id: await detId(ctx.imp.id, 'act-company', c.id), type: 'company_created', title, actorId: ctx.user.id, companyId: c.id, data: {importId: ctx.imp.id}}))),
    skipDuplicates: true,
  });
  await emitMany(ctx.db, 'company.created', rows.map((c) => ({recordId: c.id, actorId: ctx.user.id, data: c})));
  bump(ctx, 'companiesCreated', rows.length);
}

const stats = new WeakMap<Ctx, Record<string, number>>();
function bump(ctx: Ctx, key: keyof ImportStats | `owner:${string}`, n = 1) {
  const s = stats.get(ctx) ?? {};
  s[key] = (s[key] ?? 0) + n;
  stats.set(ctx, s);
}

/** Work-email contacts without a company get the company on their domain (and it is created when Settings allow). */
async function associateByDomains(ctx: Ctx, contacts: {id: string; email: string | null; ownerId: string | null}[]) {
  if (!ctx.settings.autoAssociateCompanies) return;
  const byDomain = new Map<string, typeof contacts>();
  for (const c of contacts) {
    const d = workDomain(c.email);
    if (d) byDomain.set(d, [...(byDomain.get(d) ?? []), c]);
  }
  if (!byDomain.size) return;
  const found = await ctx.db.company.findMany({where: {domain: {in: [...byDomain.keys()]}}, select: {id: true, name: true, domain: true}, orderBy: {createdAt: 'asc'}});
  const company = new Map<string, {id: string; name: string}>();
  for (const c of found) if (c.domain && !company.has(c.domain)) company.set(c.domain, c);
  if (ctx.settings.autoCreateCompanies) {
    const missing = [...byDomain.keys()].filter((d) => !company.has(d));
    const created = await ctx.db.company.createManyAndReturn({
      data: await Promise.all(missing.map(async (d) => ({id: await detId(ctx.imp.id, 'company', `d:${d}`), name: nameFromDomain(d), domain: d, website: `https://${d}`, ownerId: byDomain.get(d)![0]!.ownerId, lastActivityAt: ctx.now}))),
      skipDuplicates: true,
    });
    for (const d of missing) company.set(d, {id: await detId(ctx.imp.id, 'company', `d:${d}`), name: nameFromDomain(d)});
    await companiesCreated(ctx, created, 'Company created from email domain (import)');
  }
  const links = [...byDomain].flatMap(([d, list]) => (company.has(d) ? list.map((c) => ({contactId: c.id, companyId: company.get(d)!.id, name: company.get(d)!.name})) : []));
  if (!links.length) return;
  await ctx.db.contactCompany.createMany({data: links.map((l) => ({contactId: l.contactId, companyId: l.companyId, isPrimary: true})), skipDuplicates: true});
  await ctx.db.activity.createMany({
    data: await Promise.all(links.map(async (l) => ({id: await detId(ctx.imp.id, 'act-assoc', l.contactId), type: 'associated', title: `Linked to ${l.name} by email domain`, actorId: ctx.user.id, contactId: l.contactId, companyId: l.companyId}))),
    skipDuplicates: true,
  });
}

/** Companies that now own a domain pick up contacts on it that have no company yet (like a normal create). */
async function adoptByDomains(ctx: Ctx, companies: {id: string; domain: string | null}[]) {
  if (!ctx.settings.autoAssociateCompanies) return;
  const domains = new Map(companies.filter((c) => c.domain && workDomain(`x@${c.domain}`)).map((c) => [c.domain!, c.id]));
  if (!domains.size) return;
  const orphans = await ctx.db.$queryRaw<{id: string; d: string}[]>`
    SELECT c.id, lower(split_part(c.email, '@', 2)) AS d FROM "Contact" c
    WHERE c.email IS NOT NULL AND lower(split_part(c.email, '@', 2)) IN (${Prisma.join([...domains.keys()])})
      AND NOT EXISTS (SELECT 1 FROM "ContactCompany" cc WHERE cc."contactId" = c.id)
    LIMIT ${LOOKUP_LIMIT}`;
  if (!orphans.length) return;
  await ctx.db.contactCompany.createMany({data: orphans.map((o) => ({contactId: o.id, companyId: domains.get(o.d)!, isPrimary: true})), skipDuplicates: true});
  const per = new Map<string, number>();
  for (const o of orphans) per.set(o.d, (per.get(o.d) ?? 0) + 1);
  await ctx.db.activity.createMany({
    data: await Promise.all([...per].map(async ([d, n]) => ({id: await detId(ctx.imp.id, 'act-adopt', d), type: 'associated', title: `${n} contact${n > 1 ? 's' : ''} linked by email domain @${d}`, actorId: ctx.user.id, companyId: domains.get(d)!}))),
    skipDuplicates: true,
  });
}

// ─── Existing records ───────────────────────────────────────────────────────

type Existing = {id: string; ownerId: string | null; tags: Prisma.JsonValue; custom: unknown} & Record<string, unknown>;

async function findExisting(ctx: Ctx, rows: Prepared[]): Promise<Map<number, Existing>> {
  const db = ctx.db;
  const out = new Map<number, Existing>();
  const ids = rows.flatMap((p) => (p.id ? [p.id] : []));
  if (ctx.entity === 'contact') {
    const emails = [...new Set(rows.flatMap((p) => (typeof p.fields.email === 'string' && p.fields.email ? [p.fields.email] : [])))];
    const byEmail = emails.length ? await db.$queryRaw<{id: string; e: string}[]>`SELECT id, lower(email) AS e FROM "Contact" WHERE lower(email) IN (${Prisma.join(emails)}) ORDER BY "createdAt" LIMIT ${LOOKUP_LIMIT}` : [];
    const records = await db.contact.findMany({where: {id: {in: [...ids, ...byEmail.map((r) => r.id)]}}, include: {companies: {select: {companyId: true}}}});
    const byId = new Map(records.map((r) => [r.id, r]));
    const emailHit = new Map<string, string>();
    const shared = new Map<string, number>();
    for (const r of byEmail) {
      shared.set(r.e, (shared.get(r.e) ?? 0) + 1);
      if (!emailHit.has(r.e)) emailHit.set(r.e, r.id);
    }
    for (const p of rows) {
      const email = typeof p.fields.email === 'string' ? p.fields.email : '';
      let hit = p.id ? byId.get(p.id) : undefined;
      if (p.id && !hit) p.issues.push({level: 'warning', column: ctx.columnOf.get('id') ?? null, message: `No contact with Record ID ${p.id}; matched by email instead`});
      // Matched by ID: the email in the file is an edit, not a match key.
      if (!hit && email && emailHit.has(email)) {
        hit = byId.get(emailHit.get(email)!);
        if ((shared.get(email) ?? 0) > 1) p.issues.push({level: 'warning', column: ctx.columnOf.get('email') ?? null, message: `${shared.get(email)} contacts use ${email}; the oldest one is updated`});
      }
      if (hit) out.set(p.index, hit as unknown as Existing);
    }
  } else if (ctx.entity === 'company') {
    const domains = [...new Set(rows.flatMap((p) => (typeof p.fields.domain === 'string' && p.fields.domain ? [p.fields.domain] : [])))];
    const names = [...new Set(rows.flatMap((p) => (typeof p.fields.name === 'string' && p.fields.name ? [lower(p.fields.name)] : [])))];
    const [byDomain, byName] = await Promise.all([
      domains.length ? db.company.findMany({where: {domain: {in: domains}}, select: {id: true, domain: true}, orderBy: {createdAt: 'asc'}}) : [],
      names.length ? db.$queryRaw<{id: string; n: string}[]>`SELECT id, lower(name) AS n FROM "Company" WHERE lower(name) IN (${Prisma.join(names)}) ORDER BY "createdAt" LIMIT ${LOOKUP_LIMIT}` : [],
    ]);
    const records = await db.company.findMany({where: {id: {in: [...ids, ...byDomain.map((r) => r.id), ...byName.map((r) => r.id)]}}});
    const byId = new Map(records.map((r) => [r.id, r]));
    const domainHit = new Map<string, string>();
    for (const r of byDomain) if (r.domain && !domainHit.has(r.domain)) domainHit.set(r.domain, r.id);
    const nameHit = new Map<string, string>();
    for (const r of byName) if (!nameHit.has(r.n)) nameHit.set(r.n, r.id);
    for (const p of rows) {
      let hit = p.id ? byId.get(p.id) : undefined;
      if (p.id && !hit) p.issues.push({level: 'warning', column: ctx.columnOf.get('id') ?? null, message: `No company with Record ID ${p.id}; matched by domain / name instead`});
      const domain = typeof p.fields.domain === 'string' ? p.fields.domain : '';
      const name = typeof p.fields.name === 'string' ? lower(p.fields.name) : '';
      hit ??= (domain && byId.get(domainHit.get(domain) ?? '')) || (name ? byId.get(nameHit.get(name) ?? '') : undefined) || undefined;
      if (hit) out.set(p.index, hit as unknown as Existing);
    }
  } else {
    const titles = [...new Set(rows.flatMap((p) => (typeof p.fields.title === 'string' && p.fields.title ? [lower(p.fields.title)] : [])))];
    const byTitle = titles.length ? await db.$queryRaw<{id: string}[]>`SELECT id FROM "Deal" WHERE lower(title) IN (${Prisma.join(titles)}) ORDER BY "createdAt" LIMIT ${LOOKUP_LIMIT}` : [];
    const records = await db.deal.findMany({where: {id: {in: [...ids, ...byTitle.map((r) => r.id)]}}, include: {contacts: {select: {contactId: true}}, stage: true}, orderBy: {createdAt: 'asc'}});
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const p of rows) {
      let hit = p.id ? byId.get(p.id) : undefined;
      if (p.id && !hit) p.issues.push({level: 'warning', column: ctx.columnOf.get('id') ?? null, message: `No deal with Record ID ${p.id}; matched by name + company instead`});
      if (!hit && typeof p.fields.title === 'string') {
        const companyId = p.company ? ctx.companies.get(p.company.key) ?? null : null;
        const t = lower(p.fields.title);
        hit = records.find((r) => lower(r.title) === t && (r.companyId ?? null) === (companyId === NEW ? '__none__' : companyId));
      }
      if (hit) out.set(p.index, hit as unknown as Existing);
    }
  }
  return out;
}

// ─── One batch ──────────────────────────────────────────────────────────────

type Outcome = 'create' | 'update' | 'skip' | 'error';

/** zod issues → row errors on the right column. */
function zodIssues(ctx: Ctx, error: {issues: {path: PropertyKey[]; message: string}[]}): Issue[] {
  return error.issues.map((i) => {
    const field = String(i.path[0] ?? '');
    const t = ctx.targets.get(field);
    return {level: 'error' as const, column: ctx.columnOf.get(field) ?? null, message: `${t?.label ?? field}: ${i.message}`};
  });
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Custom values coerced like cleanCustom(): only defined fields, null removes a value. */
function mergeCustom(ctx: Ctx, before: unknown, input: Record<string, unknown>) {
  const out: Record<string, unknown> = {...((before as Record<string, unknown>) ?? {})};
  for (const [key, value] of Object.entries(input)) {
    const def = ctx.defs.get(key);
    if (!def) continue;
    if (value === null) delete out[key];
    else out[key] = def.type === 'TEXT' || def.type === 'URL' ? String(value).slice(0, 2000) : value;
  }
  return out;
}

type Plan = {p: Prepared; outcome: Outcome; existing?: Existing; newId?: string; data?: Record<string, unknown>; changes?: {field: string; from: unknown; to: unknown}[]; note?: string};

async function plan(ctx: Ctx, rows: Prepared[]): Promise<Plan[]> {
  if (ctx.entity !== 'company') await resolveCompanies(ctx, rows);
  const existing = await findExisting(ctx, rows);
  const plans: Plan[] = [];
  for (const p of rows) {
    const first = p.keys.map((k) => ctx.firstIndex.get(k)).find((i) => i !== undefined && i < p.index);
    if (first !== undefined) {
      p.issues.push({level: 'warning', column: null, message: `Same ${ctx.entity === 'contact' ? 'email' : ctx.entity === 'company' ? 'company' : 'deal'} as row ${first + 2}; skipped`});
      plans.push({p, outcome: 'skip'});
      continue;
    }
    if (p.issues.some((i) => i.level === 'error')) {
      plans.push({p, outcome: 'error'});
      continue;
    }
    const hit = existing.get(p.index);
    const ownId = await detId(ctx.imp.id, ctx.entity, p.index);
    if (hit && hit.id !== ownId) {
      if (ctx.scopeOwnerId && hit.ownerId !== ctx.scopeOwnerId) {
        p.issues.push({level: 'error', column: null, message: `Matches a ${IO_ENTITIES[ctx.entity].one} you can't see`});
        plans.push({p, outcome: 'error'});
      } else if (ctx.options.mode === 'create') plans.push({p, outcome: 'skip', existing: hit});
      else plans.push(await planUpdate(ctx, p, hit));
    } else if (ctx.options.mode === 'update' && !hit) {
      p.issues.push({level: 'warning', column: null, message: `No matching ${IO_ENTITIES[ctx.entity].one} to update; skipped`});
      plans.push({p, outcome: 'skip'});
    } else plans.push(await planCreate(ctx, p, ownId));
  }
  return plans;
}

function ownerFor(ctx: Ctx, p: Prepared) {
  return p.owner ?? ctx.defaultOwnerId;
}

function pipelineFor(ctx: Ctx, p: Prepared, current?: {pipelineId: string; stageId: string}): {error: string; column: string} | {pipeline: Pipe; stage: Pipe['stages'][number]} {
  const named = p.pipeline ? ctx.pipelines.find((x) => lower(x.name) === lower(p.pipeline!)) : undefined;
  if (p.pipeline && !named) return {error: `No pipeline "${p.pipeline}"`, column: 'pipeline'};
  const pipeline = named ?? (current ? ctx.pipelines.find((x) => x.id === current.pipelineId) : undefined) ?? ctx.pipelines.find((x) => x.id === ctx.options.pipelineId) ?? ctx.pipelines[0];
  if (!pipeline || !pipeline.stages.length) return {error: 'Create a pipeline with at least one stage first', column: 'pipeline'};
  const stage = p.stage ? pipeline.stages.find((s) => lower(s.name) === lower(p.stage!)) : undefined;
  if (p.stage && !stage) return {error: `No stage "${p.stage}" in ${pipeline.name}`, column: 'stage'};
  const keep = current && current.pipelineId === pipeline.id ? pipeline.stages.find((s) => s.id === current.stageId) : undefined;
  return {pipeline, stage: stage ?? keep ?? pipeline.stages[0]!};
}

async function planCreate(ctx: Ctx, p: Prepared, id: string): Promise<Plan> {
  const fail = (issues: Issue[]): Plan => (p.issues.push(...issues), {p, outcome: 'error'});
  const custom = mergeCustom(ctx, {}, p.custom);
  if (ctx.entity === 'contact') {
    const email = typeof p.fields.email === 'string' ? p.fields.email : null;
    const firstName = (p.fields.firstName as string | undefined) || (email ? email.split('@')[0] : undefined);
    if (!firstName) return fail([{level: 'error', column: null, message: 'Needs a name or an email'}]);
    const r = contactBody.safeParse(defined({...p.fields, firstName, tags: p.tags, ownerId: ownerFor(ctx, p)}));
    if (!r.success) return fail(zodIssues(ctx, r.error));
    const {companyId: _c, custom: _x, ...data} = r.data;
    return {p, outcome: 'create', newId: id, data: {...data, source: data.source ?? 'Import', custom}, note: p.note};
  }
  if (ctx.entity === 'company') {
    const name = (p.fields.name as string | undefined) || (typeof p.fields.domain === 'string' && p.fields.domain ? nameFromDomain(p.fields.domain) : undefined);
    if (!name) return fail([{level: 'error', column: null, message: 'Needs a name or a domain'}]);
    const r = companyBody.safeParse(defined({...p.fields, name, tags: p.tags, ownerId: ownerFor(ctx, p)}));
    if (!r.success) return fail(zodIssues(ctx, r.error));
    const {custom: _x, ...data} = r.data;
    return {p, outcome: 'create', newId: id, data: {...data, custom}, note: p.note};
  }
  // deal
  const {status, lostReason, closedAt, ...rest} = p.fields as Record<string, unknown> & {status?: string; lostReason?: string | null; closedAt?: string};
  const r = dealBody.safeParse(defined({...rest, tags: p.tags, ownerId: ownerFor(ctx, p)}));
  if (!r.success) return fail(zodIssues(ctx, r.error));
  const where = pipelineFor(ctx, p);
  if ('error' in where) return fail([{level: 'error', column: ctx.columnOf.get(where.column) ?? null, message: where.error}]);
  const closed = status === 'WON' || status === 'LOST';
  if (status === 'LOST' && !lostReason) p.issues.push({level: 'warning', column: ctx.columnOf.get('status') ?? null, message: 'Lost without a lost reason'});
  const {custom: _x, contactIds: _ci, companyIds: _co, companyId: _c, pipelineId: _p, stageId: _s, ...data} = r.data;
  return {
    p,
    outcome: 'create',
    newId: id,
    note: p.note,
    data: {
      ...data,
      currency: data.currency ?? ctx.settings.currency,
      pipelineId: where.pipeline.id,
      stageId: where.stage.id,
      status: status ?? 'OPEN',
      lostReason: status === 'LOST' ? lostReason ?? null : null,
      closedAt: closed ? (closedAt ? new Date(closedAt) : ctx.now) : null,
      custom,
    },
  };
}

async function planUpdate(ctx: Ctx, p: Prepared, before: Existing): Promise<Plan> {
  const fail = (issues: Issue[]): Plan => (p.issues.push(...issues), {p, outcome: 'error', existing: before});
  const patch: Record<string, unknown> = defined(p.fields);
  const schema = ctx.entity === 'contact' ? contactBody : ctx.entity === 'company' ? companyBody : dealBody;
  const {status, lostReason, closedAt, ...rest} = patch as Record<string, unknown> & {status?: string; lostReason?: string | null; closedAt?: string};
  const r = schema.partial().safeParse(ctx.entity === 'deal' ? rest : patch);
  if (!r.success) return fail(zodIssues(ctx, r.error));
  const data: Record<string, unknown> = {...(r.data as Record<string, unknown>)};
  delete data.custom;
  delete data.companyId;
  const tags = [...new Set([...strings(before.tags), ...p.tags])];
  if (tags.length > strings(before.tags).length) data.tags = tags.slice(0, 50);
  if (p.owner && p.owner !== before.ownerId) data.ownerId = p.owner;
  if (ctx.entity === 'deal') {
    const deal = before as unknown as {pipelineId: string; stageId: string; status: string; closedAt: Date | null; lostReason: string | null};
    if (p.pipeline || p.stage) {
      const where = pipelineFor(ctx, p, deal);
      if ('error' in where) return fail([{level: 'error', column: ctx.columnOf.get(where.column) ?? null, message: where.error}]);
      if (where.pipeline.id !== deal.pipelineId) data.pipelineId = where.pipeline.id;
      if (where.stage.id !== deal.stageId) data.stageId = where.stage.id;
    }
    if (status && status !== deal.status) {
      data.status = status;
      data.closedAt = status === 'OPEN' ? null : closedAt ? new Date(closedAt) : ctx.now;
      if (status === 'LOST' && !lostReason && !deal.lostReason) p.issues.push({level: 'warning', column: ctx.columnOf.get('status') ?? null, message: 'Lost without a lost reason'});
      if (status !== 'LOST') data.lostReason = null;
    } else if (closedAt && deal.status !== 'OPEN') data.closedAt = new Date(closedAt);
    if (lostReason !== undefined && (status ?? deal.status) === 'LOST') data.lostReason = lostReason;
  }
  const companyId = p.company ? ctx.companies.get(p.company.key) ?? null : null;
  if (ctx.entity === 'deal' && companyId && companyId !== NEW && companyId !== (before.companyId ?? null)) data.companyId = companyId;
  const changes = diff(before, data);
  // A company the contact isn't linked to yet (or a new one, while dry-running) is a change too.
  const linked = ctx.entity === 'contact' ? (before as unknown as {companies: {companyId: string}[]}).companies : [];
  if (ctx.entity === 'contact' && companyId && !linked.some((l) => l.companyId === companyId)) changes.push({field: 'company', from: null, to: p.company!.name ?? p.company!.domain ?? null});
  if (ctx.entity === 'deal' && companyId === NEW) changes.push({field: 'companyId', from: before.companyId ?? null, to: p.company!.name ?? p.company!.domain ?? null});
  const custom = Object.keys(p.custom).length ? mergeCustom(ctx, before.custom, p.custom) : undefined;
  if (custom) changes.push(...customDiff(before.custom, custom));
  const fields = new Set(changes.map((ch) => ch.field));
  const writes = Object.fromEntries(Object.entries(data).filter(([k]) => fields.has(k)));
  if (custom && changes.some((ch) => ch.field.startsWith('custom.'))) writes.custom = custom;
  return {p, outcome: 'update', existing: before, data: writes, changes, note: p.note};
}

// ─── Writing ────────────────────────────────────────────────────────────────

const NAMES: Record<IoEntity, (d: Record<string, unknown>) => string> = {
  contact: (d) => [d.firstName, d.lastName].filter(Boolean).join(' '),
  company: (d) => String(d.name ?? ''),
  deal: (d) => String(d.title ?? ''),
};

async function insertRecords(ctx: Ctx, plans: Plan[]): Promise<Set<string>> {
  const db = ctx.db;
  const rows = plans.map((pl) => ({id: pl.newId!, ...pl.data, lastActivityAt: ctx.now}));
  const insert = (data: typeof rows) =>
    ctx.entity === 'contact'
      ? db.contact.createManyAndReturn({data: data as Prisma.ContactCreateManyInput[], skipDuplicates: true, select: {id: true}})
      : ctx.entity === 'company'
        ? db.company.createManyAndReturn({data: data as Prisma.CompanyCreateManyInput[], skipDuplicates: true, select: {id: true}})
        : db.deal.createManyAndReturn({data: data as Prisma.DealCreateManyInput[], skipDuplicates: true, select: {id: true}});
  try {
    return new Set((await insert(rows)).map((r) => r.id));
  } catch {
    // One bad row fails the whole insert: go row by row and keep the reason on the rows that fail.
    const ok = new Set<string>();
    for (const [i, row] of rows.entries()) {
      try {
        for (const r of await insert([row])) ok.add(r.id);
      } catch (e) {
        const pl = plans[i]!;
        pl.outcome = 'error';
        pl.p.issues.push({level: 'error', column: null, message: `Could not be saved: ${(e as Error).message.split('\n').pop()?.slice(0, 200)}`});
      }
    }
    return ok;
  }
}

async function applyCreates(ctx: Ctx, plans: Plan[]) {
  if (!plans.length) return;
  const db = ctx.db;
  if (ctx.entity === 'deal') {
    // New deals land on top of their column, like the API.
    const stageIds = [...new Set(plans.map((pl) => String(pl.data!.stageId)))];
    const mins = await db.deal.groupBy({by: ['stageId'], where: {stageId: {in: stageIds}, status: 'OPEN'}, _min: {position: true}});
    const top = new Map(mins.map((m) => [m.stageId, m._min.position ?? 1]));
    for (const pl of plans) {
      const s = String(pl.data!.stageId);
      const pos = (top.get(s) ?? 1) - 1;
      top.set(s, pos);
      const companyId = pl.p.company ? ctx.companies.get(pl.p.company.key) ?? null : null;
      Object.assign(pl.data!, {position: pos, stageEnteredAt: ctx.now, companyId});
    }
  }
  const inserted = await insertRecords(ctx, plans);
  const done = plans.filter((pl) => pl.outcome === 'create');
  const ids = done.map((pl) => pl.newId!);
  const fresh = done.filter((pl) => inserted.has(pl.newId!));
  const key = ctx.entity === 'contact' ? 'contactId' : ctx.entity === 'company' ? 'companyId' : 'dealId';
  const companyOf = (pl: Plan) => (pl.p.company ? ctx.companies.get(pl.p.company.key) ?? null : null);

  if (ctx.entity === 'contact') {
    const links = done.flatMap((pl) => (companyOf(pl) ? [{contactId: pl.newId!, companyId: companyOf(pl)!, isPrimary: true}] : []));
    if (links.length) await db.contactCompany.createMany({data: links, skipDuplicates: true});
    await associateByDomains(ctx, done.filter((pl) => !companyOf(pl)).map((pl) => ({id: pl.newId!, email: (pl.data!.email as string) ?? null, ownerId: (pl.data!.ownerId as string) ?? null})));
  }
  if (ctx.entity === 'company') await adoptByDomains(ctx, done.map((pl) => ({id: pl.newId!, domain: (pl.data!.domain as string) ?? null})));
  if (ctx.entity === 'deal') {
    const dealCompanies = done.flatMap((pl) => (pl.data!.companyId ? [{dealId: pl.newId!, companyId: String(pl.data!.companyId), isPrimary: true}] : []));
    if (dealCompanies.length) await db.dealCompany.createMany({data: dealCompanies, skipDuplicates: true});
    await linkDealContacts(ctx, done.map((pl) => ({p: pl.p, dealId: pl.newId!})));
    await db.stageChange.createMany({
      data: await Promise.all(done.map(async (pl) => ({id: await detId(ctx.imp.id, 'stage', pl.p.index), dealId: pl.newId!, toStageId: String(pl.data!.stageId), userId: ctx.user.id}))),
      skipDuplicates: true,
    });
  }
  const title = ctx.entity === 'contact' ? 'Contact created by import' : ctx.entity === 'company' ? 'Company created by import' : null;
  await db.activity.createMany({
    data: await Promise.all(
      done.map(async (pl) => ({
        id: await detId(ctx.imp.id, 'act', pl.p.index),
        type: `${ctx.entity}_created`,
        title: title ?? `Deal created: ${pl.data!.title}`,
        actorId: ctx.user.id,
        [key]: pl.newId!,
        companyId: ctx.entity === 'company' ? pl.newId! : companyOf(pl),
        data: {importId: ctx.imp.id, file: ctx.imp.fileName},
      })),
    ),
    skipDuplicates: true,
  });
  await addNotes(ctx, done.map((pl) => ({pl, recordId: pl.newId!})));
  if (fresh.length) {
    await emitMany(db, `${ctx.entity}.created`, fresh.map((pl) => ({recordId: pl.newId!, actorId: ctx.user.id, data: {id: pl.newId, ...pl.data}})));
    for (const pl of fresh) {
      const owner = pl.data!.ownerId as string | null;
      if (owner && owner !== ctx.user.id) bump(ctx, `owner:${owner}`);
    }
  }
  await remember(ctx, done);
  if (ctx.entity === 'contact') await queueRescore(db, ids);
}

/** Deal ↔ contact links from the "Contact emails" column (existing contacts only). */
async function linkDealContacts(ctx: Ctx, rows: {p: Prepared; dealId: string}[]) {
  const emails = [...new Set(rows.flatMap((r) => r.p.contactEmails))];
  if (!emails.length) return;
  const found = await ctx.db.$queryRaw<{id: string; e: string}[]>`SELECT id, lower(email) AS e FROM "Contact" WHERE lower(email) IN (${Prisma.join(emails)}) ORDER BY "createdAt" LIMIT ${LOOKUP_LIMIT}`;
  const byEmail = new Map<string, string>();
  for (const f of found) if (!byEmail.has(f.e)) byEmail.set(f.e, f.id);
  const links = rows.flatMap((r) => r.p.contactEmails.flatMap((e) => (byEmail.has(e) ? [{dealId: r.dealId, contactId: byEmail.get(e)!}] : [])));
  if (links.length) await ctx.db.dealContact.createMany({data: links, skipDuplicates: true});
  return byEmail;
}

async function addNotes(ctx: Ctx, rows: {pl: Plan; recordId: string}[]) {
  const withNote = rows.filter((r) => r.pl.note);
  if (!withNote.length) return;
  const key = ctx.entity === 'contact' ? 'contactId' : ctx.entity === 'company' ? 'companyId' : 'dealId';
  const notes = await Promise.all(withNote.map(async (r) => ({id: await detId(ctx.imp.id, 'note', r.pl.p.index), body: r.pl.note!, authorId: ctx.user.id, [key]: r.recordId})));
  const inserted = await ctx.db.note.createManyAndReturn({data: notes, skipDuplicates: true});
  await ctx.db.activity.createMany({
    data: await Promise.all(notes.map(async (n) => ({id: await detId(ctx.imp.id, 'act-note', n.id), type: 'note', title: 'Note added', refId: n.id, actorId: ctx.user.id, [key]: n[key], data: {body: n.body.slice(0, 2000)}, text: n.body.slice(0, 5000)}))),
    skipDuplicates: true,
  });
  if (inserted.length) await emitMany(ctx.db, 'note.created', inserted.map((n) => ({recordId: n.id, actorId: ctx.user.id, data: n})));
  bump(ctx, 'notes', inserted.length);
}

/** New sources / industries / types / lost reasons join the pick lists, like the API's rememberOption(). */
async function remember(ctx: Ctx, plans: Plan[]) {
  const lists: [string, 'sources' | 'industries' | 'companyTypes' | 'lostReasons'][] =
    ctx.entity === 'contact' ? [['source', 'sources']] : ctx.entity === 'company' ? [['industry', 'industries'], ['type', 'companyTypes']] : [['lostReason', 'lostReasons']];
  for (const [field, list] of lists) {
    const values = new Set(plans.flatMap((pl) => (typeof pl.data?.[field] === 'string' && pl.data[field] ? [pl.data[field] as string] : [])));
    for (const v of [...values].slice(0, 20)) await rememberOption(ctx.db, list, v);
  }
}

async function applyUpdates(ctx: Ctx, plans: Plan[]) {
  const db = ctx.db;
  const companyOf = (pl: Plan) => (pl.p.company ? ctx.companies.get(pl.p.company.key) ?? null : null);
  const changed = plans.filter((pl) => pl.changes!.length || pl.note || pl.p.contactEmails.length);
  for (const pl of plans) if (!changed.includes(pl)) pl.outcome = 'skip'; // nothing to change
  const writes = changed.filter((pl) => Object.keys(pl.data!).length);
  for (let i = 0; i < writes.length; i += 25) {
    const chunk = writes.slice(i, i + 25);
    const update = (pl: Plan) => {
      const data = {...pl.data!, lastActivityAt: ctx.now, ...(pl.data!.stageId ? {stageEnteredAt: ctx.now} : {})};
      const where = {where: {id: pl.existing!.id}, data};
      return ctx.entity === 'contact' ? db.contact.update(where as Prisma.ContactUpdateArgs) : ctx.entity === 'company' ? db.company.update(where as Prisma.CompanyUpdateArgs) : db.deal.update(where as Prisma.DealUpdateArgs);
    };
    try {
      await db.$transaction(chunk.map(update));
    } catch {
      for (const pl of chunk) {
        try {
          await update(pl);
        } catch (e) {
          pl.outcome = 'error';
          pl.p.issues.push({level: 'error', column: null, message: `Could not be saved: ${(e as Error).message.split('\n').pop()?.slice(0, 200)}`});
        }
      }
    }
  }
  const done = changed.filter((pl) => pl.outcome === 'update');
  if (!done.length) return;
  const key = ctx.entity === 'contact' ? 'contactId' : ctx.entity === 'company' ? 'companyId' : 'dealId';
  if (ctx.entity === 'contact') {
    const links = done.flatMap((pl) => {
      const cid = companyOf(pl);
      const linked = (pl.existing as unknown as {companies: {companyId: string}[]}).companies;
      return cid && !linked.some((l) => l.companyId === cid) ? [{contactId: pl.existing!.id, companyId: cid, isPrimary: linked.length === 0}] : [];
    });
    if (links.length) await db.contactCompany.createMany({data: links, skipDuplicates: true});
  }
  if (ctx.entity === 'company') {
    const gotDomain = done.filter((pl) => pl.data!.domain && !pl.existing!.domain);
    await adoptByDomains(ctx, gotDomain.map((pl) => ({id: pl.existing!.id, domain: String(pl.data!.domain)})));
  }
  if (ctx.entity === 'deal') await applyDealUpdates(ctx, done);
  const withChanges = done.filter((pl) => pl.changes!.length);
  await db.activity.createMany({
    data: await Promise.all(
      withChanges.map(async (pl) => ({
        id: await detId(ctx.imp.id, 'act', pl.p.index),
        type: 'field_changed',
        title: `${IO_ENTITIES[ctx.entity].one[0]!.toUpperCase()}${IO_ENTITIES[ctx.entity].one.slice(1)} updated by import`,
        actorId: ctx.user.id,
        [key]: pl.existing!.id,
        data: {changes: pl.changes, importId: ctx.imp.id} as Prisma.InputJsonValue,
      })),
    ),
    skipDuplicates: true,
  });
  await addNotes(ctx, done.map((pl) => ({pl, recordId: pl.existing!.id})));
  await emitMany(db, `${ctx.entity}.updated`, withChanges.map((pl) => ({recordId: pl.existing!.id, actorId: ctx.user.id, data: {...pl.existing, ...pl.data, changes: pl.changes}})));
  for (const pl of done) if (pl.data!.ownerId && pl.data!.ownerId !== ctx.user.id) bump(ctx, `owner:${pl.data!.ownerId}`);
  await remember(ctx, done);
  if (ctx.entity === 'contact') await queueRescore(db, done.map((pl) => pl.existing!.id));
}

/**
 * Stage moves and won / lost from an import update: history, timeline and events like the deal
 * page, written for the whole batch at once (one insert per kind, one event batch per type).
 */
async function applyDealUpdates(ctx: Ctx, plans: Plan[]) {
  const db = ctx.db;
  await linkDealContacts(ctx, plans.map((pl) => ({p: pl.p, dealId: pl.existing!.id})));
  type Before = {id: string; title: string; companyId: string | null; stageId: string; stage: {id: string; name: string}; contacts: {contactId: string}[]};
  const stages = new Map(ctx.pipelines.flatMap((x) => x.stages).map((st) => [st.id, st]));
  const primary: {dealId: string; companyId: string}[] = [];
  const stageChanges: Prisma.StageChangeCreateManyInput[] = [];
  const activities: Prisma.ActivityCreateManyInput[] = [];
  const moved: Parameters<typeof emitMany>[2] = [];
  const won: Parameters<typeof emitMany>[2] = [];
  const lost: Parameters<typeof emitMany>[2] = [];
  const customers = new Set<string>();
  for (const pl of plans) {
    const before = pl.existing as unknown as Before;
    if (pl.data!.companyId) primary.push({dealId: before.id, companyId: String(pl.data!.companyId)});
    if (pl.data!.stageId) {
      const to = stages.get(String(pl.data!.stageId))!;
      stageChanges.push({id: await detId(ctx.imp.id, 'stage', pl.p.index), dealId: before.id, fromStageId: before.stageId, toStageId: to.id, userId: ctx.user.id});
      activities.push({id: await detId(ctx.imp.id, 'act-stage', pl.p.index), type: 'stage_changed', title: `Moved from ${before.stage.name} to ${to.name}`, actorId: ctx.user.id, dealId: before.id, data: {from: before.stage.name, to: to.name}});
      moved.push({recordId: before.id, actorId: ctx.user.id, data: {deal: {...before, ...pl.data}, from: before.stage, to: {id: to.id, name: to.name}}});
    }
    const status = pl.data!.status as string | undefined;
    if (status) {
      const title = status === 'WON' ? `Deal won 🎉 ${before.title}` : status === 'LOST' ? `Deal lost${pl.data!.lostReason ? `: ${pl.data!.lostReason}` : ''}` : 'Deal reopened';
      activities.push({id: await detId(ctx.imp.id, 'act-status', pl.p.index), type: status === 'WON' ? 'deal_won' : status === 'LOST' ? 'deal_lost' : 'deal_reopened', title, actorId: ctx.user.id, dealId: before.id, companyId: before.companyId});
      if (status === 'WON') won.push({recordId: before.id, actorId: ctx.user.id, data: {...before, ...pl.data}});
      if (status === 'LOST') lost.push({recordId: before.id, actorId: ctx.user.id, data: {...before, ...pl.data}});
      if (status === 'WON') for (const l of before.contacts) customers.add(l.contactId);
    }
  }
  if (primary.length) {
    // The imported company becomes each deal's primary one (the others stay linked).
    await db.dealCompany.updateMany({where: {dealId: {in: primary.map((x) => x.dealId)}}, data: {isPrimary: false}});
    await db.$transaction(primary.map((x) => db.dealCompany.upsert({where: {dealId_companyId: x}, create: {...x, isPrimary: true}, update: {isPrimary: true}})));
  }
  if (stageChanges.length) await db.stageChange.createMany({data: stageChanges, skipDuplicates: true});
  if (activities.length) await db.activity.createMany({data: activities, skipDuplicates: true});
  if (customers.size) await db.contact.updateMany({where: {id: {in: [...customers]}}, data: {lifecycleStage: 'CUSTOMER'}});
  await emitMany(db, 'deal.stage_changed', moved);
  await emitMany(db, 'deal.won', won);
  await emitMany(db, 'deal.lost', lost);
}

// ─── Running a phase ────────────────────────────────────────────────────────

/** Rows the batch touched that go into the chosen list: created, updated, unchanged and "already exists" contacts the user can see. */
async function addBatchToList(ctx: Ctx, plans: Plan[]) {
  if (ctx.entity !== 'contact' || !ctx.options.listId) return;
  const ids = plans.flatMap((pl) => (pl.outcome === 'create' ? [pl.newId!] : (pl.outcome === 'update' || pl.outcome === 'skip') && pl.existing ? [pl.existing.id] : []));
  const visible = ctx.scopeOwnerId ? (await ctx.db.contact.findMany({where: {id: {in: ids}, ownerId: ctx.scopeOwnerId}, select: {id: true}})).map((r) => r.id) : ids;
  bump(ctx, 'listAdded', await addToList(ctx.db, ctx.options.listId, visible, {actorId: ctx.user.id, source: 'import'}));
}

async function processBatch(ctx: Ctx, rows: string[][], start: number) {
  const prepared = rows.map((cells, i) => prepare(ctx, cells, start + i));
  const plans = await plan(ctx, prepared);
  if (!ctx.dry) {
    await applyCreates(ctx, plans.filter((pl) => pl.outcome === 'create'));
    await applyUpdates(ctx, plans.filter((pl) => pl.outcome === 'update'));
    await addBatchToList(ctx, plans);
  } else {
    // A dry run still tells "no change" apart from an update.
    for (const pl of plans) if (pl.outcome === 'update' && !pl.changes!.length && !pl.note && !pl.p.contactEmails.length) pl.outcome = 'skip';
  }
  const count = (o: Outcome) => plans.filter((pl) => pl.outcome === o).length;
  const issues = plans.flatMap((pl) => pl.p.issues.map((i) => ({...i, row: pl.p.row})));
  return {created: count('create'), updated: count('update'), skipped: count('skip'), failed: count('error'), warnings: issues.filter((i) => i.level === 'warning').length, issues};
}

/** Job handler for `import.validate` and `import.run`: batches until the time budget is used, then queues the next job. */
export async function importJob(db: Db, phase: Phase, p: {importId: string; token: string}, job: JobRun) {
  const imp = await db.import.findUnique({where: {id: p.importId}});
  if (!imp || imp.token !== p.token) return; // superseded by a newer validate / run
  if (phase === 'validate' ? imp.status !== 'validating' : !['queued', 'running'].includes(imp.status)) return;
  try {
    await runPhase(db, imp, phase);
  } catch (e) {
    if (job.attempts < job.maxAttempts) throw e; // the job runner retries; batches already done are kept
    await db.import.update({where: {id: imp.id}, data: {status: 'failed', error: (e as Error).message.slice(0, 500), finishedAt: new Date()}});
    if (phase === 'run') await finishRun(db, (await db.import.findUniqueOrThrow({where: {id: imp.id}})), 'failed');
  }
}

async function runPhase(db: Db, imp: Import, phase: Phase) {
  const started = Date.now();
  const {rows} = await loadImportFile(db, imp);
  const ctx = await loadContext(db, imp, phase, rows);
  if (phase === 'run' && imp.status === 'queued') {
    // Only if nobody canceled it in the meantime.
    const {count} = await db.import.updateMany({where: {id: imp.id, status: 'queued', token: imp.token}, data: {status: 'running', startedAt: new Date()}});
    if (!count) return;
  }
  let issueCount = await db.importIssue.count({where: {importId: imp.id, phase}});
  let at = imp.processed;
  const batch = ctx.entity === 'deal' && ctx.options.mode !== 'create' ? DEAL_UPDATE_BATCH : BATCH;
  // The budget is checked before each row group; a group is small enough to fit in what is left.
  while (at < rows.length && Date.now() - started < BUDGET_MS) {
    const end = Math.min(at + batch, rows.length);
    const r = await processBatch(ctx, rows.slice(at, end), at);
    // A retried batch replaces its own issues instead of adding them twice.
    await db.importIssue.deleteMany({where: {importId: imp.id, phase, row: {gte: at + 2, lt: end + 2}}});
    const keep = r.issues.slice(0, Math.max(0, MAX_ISSUES - issueCount));
    if (keep.length) await db.importIssue.createMany({data: keep.map((i) => ({importId: imp.id, phase, row: i.row, level: i.level, column: i.column?.slice(0, 200) ?? null, message: i.message.slice(0, 500)}))});
    issueCount += keep.length;
    const extra = stats.get(ctx) ?? {};
    stats.delete(ctx);
    const current = await db.import.findUniqueOrThrow({where: {id: imp.id}, select: {stats: true, status: true, token: true}});
    if (current.token !== imp.token) return;
    const merged = {...(current.stats as Record<string, number>)};
    for (const [k, v] of Object.entries(extra)) merged[k] = (merged[k] ?? 0) + v;
    await db.import.update({
      where: {id: imp.id},
      data: {
        processed: end,
        created: {increment: r.created},
        updated: {increment: r.updated},
        skipped: {increment: r.skipped},
        failed: {increment: r.failed},
        warnings: {increment: r.warnings},
        stats: merged,
      },
    });
    at = end;
    if (current.status === 'canceled') return finishRun(db, await db.import.findUniqueOrThrow({where: {id: imp.id}}), 'canceled');
  }
  if (at < rows.length) {
    // Keyed by where it goes on from: a retried job never queues the same next step twice.
    await enqueue(db, phase === 'validate' ? 'import.validate' : 'import.run', {importId: imp.id, token: imp.token!}, {key: `import-${imp.token}-${phase}-${at}`, label: importLabel(phase, imp.fileName)});
    return;
  }
  const done = await db.import.findUniqueOrThrow({where: {id: imp.id}});
  if (phase === 'validate') {
    const preview: ImportCounts = {create: done.created, update: done.updated, skip: done.skipped, errors: done.failed, warnings: done.warnings, newCompanies: [...ctx.companies.values()].filter((v) => v === NEW).length};
    await db.import.update({where: {id: imp.id}, data: {status: 'ready', preview}});
  } else {
    await finishRun(db, done, 'done');
  }
}

/** Starts a phase: resets the counters and queues the first job. */
export async function queuePhase(db: Db, importId: string, phase: Phase, origin: string) {
  const token = randomToken(9);
  await db.importIssue.deleteMany({where: {importId, phase}});
  await db.import.update({
    where: {id: importId},
    data: {status: phase === 'validate' ? 'validating' : 'queued', token, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, warnings: 0, error: null, ...(phase === 'validate' ? {preview: undefined, stats: {origin}} : {stats: {origin}, startedAt: null, finishedAt: null})},
  });
  const imp = await db.import.findUnique({where: {id: importId}, select: {fileName: true}});
  await enqueue(db, phase === 'validate' ? 'import.validate' : 'import.run', {importId, token}, {key: `import-${token}-${phase}-0`, label: importLabel(phase, imp?.fileName ?? '')});
}

/** "Import · contacts.csv" in the platform's Jobs tab (the file's name only). */
const importLabel = (phase: Phase, fileName: string) => `${phase === 'validate' ? 'Import check' : 'Import'} · ${fileName}`.slice(0, 80);

/** Admin-approved new select options from the value map are added to the custom field before the run starts. */
export async function addNewOptions(db: Db, entity: IoEntity, mapping: (string | null)[], options: ImportOptions) {
  const added: {id: string; label: string; options: string[]}[] = [];
  for (const key of mapping) {
    if (!key?.startsWith('custom.')) continue;
    const labels = Object.values(options.valueMap[key] ?? {}).flatMap((v) => (v.startsWith(NEW_OPTION) ? [v.slice(NEW_OPTION.length).trim()] : [])).filter(Boolean);
    if (!labels.length) continue;
    const def = await db.customFieldDef.findUnique({where: {entity_key: {entity: IO_ENTITIES[entity].fieldEntity, key: key.slice(7)}}});
    if (!def || (def.type !== 'SELECT' && def.type !== 'MULTISELECT')) continue;
    const have = new Set(strings(def.options).map(lower));
    const fresh = [...new Set(labels.map((l) => l.slice(0, 60)))].filter((l) => !have.has(lower(l)));
    if (!fresh.length) continue;
    await db.customFieldDef.update({where: {id: def.id}, data: {options: [...strings(def.options), ...fresh].slice(0, 200)}});
    added.push({id: def.id, label: def.label, options: fresh});
  }
  return added;
}

// ─── Finishing ──────────────────────────────────────────────────────────────

/** The rows that failed, as the original columns plus "Row" and "Import errors". Null when nothing failed. */
export async function errorCsv(db: Db, imp: Import, phase: Phase) {
  const issues = await db.importIssue.findMany({where: {importId: imp.id, phase, level: 'error'}, orderBy: {row: 'asc'}, select: {row: true, column: true, message: true}});
  if (!issues.length) return null;
  const {rows} = await loadImportFile(db, imp);
  const byRow = new Map<number, string[]>();
  for (const i of issues) byRow.set(i.row, [...(byRow.get(i.row) ?? []), i.column ? `${i.column}: ${i.message}` : i.message]);
  const lines = [csvLine(['Row', ...strings(imp.headers), 'Import errors'])];
  for (const [row, messages] of byRow) lines.push(csvLine([row, ...(rows[row - 2] ?? []), messages.join('; ')]));
  return CSV_BOM + lines.join('\r\n');
}

async function finishRun(db: Db, imp: Import, status: 'done' | 'failed' | 'canceled') {
  const entity = imp.entity as IoEntity;
  const noun = IO_ENTITIES[entity];
  const user = imp.userId ? await memberWithEmail(db, {id: imp.userId}) : null;
  const options = imp.options as unknown as ImportOptions;
  const extra = imp.stats as Record<string, number>;
  let errorFileId: string | null = null;
  const errors = await errorCsv(db, imp, 'run').catch(() => null);
  if (errors) {
    const bytes = new TextEncoder().encode(errors);
    const file = await storeBytes(db, {name: `${imp.fileName.replace(/\.csv$/i, '')}-errors.csv`, mimeType: 'text/csv', purpose: 'import_errors', uploadedById: imp.userId}, bytes);
    errorFileId = file.id;
  }
  await db.import.update({where: {id: imp.id}, data: {status, errorFileId, finishedAt: new Date()}});
  const summary = `${imp.created} created · ${imp.updated} updated · ${imp.skipped} skipped${imp.failed ? ` · ${imp.failed} with errors` : ''}`;
  const actor = user ? {id: user.id, name: user.name, email: user.email} : null;
  await audit(db, null, {
    action: `import.${status === 'done' ? 'completed' : status}`,
    category: 'export',
    entity: 'import',
    recordId: imp.id,
    label: imp.fileName,
    actor,
    meta: {
      object: noun.many,
      rows: imp.total,
      created: imp.created,
      updated: imp.updated,
      skipped: imp.skipped,
      errors: imp.failed,
      warnings: imp.warnings,
      mode: options.mode,
      listId: options.listId,
      tag: options.tag,
      companiesCreated: extra.companiesCreated,
      fileId: imp.fileId,
      errorFileId,
      error: imp.error,
    },
  });
  if (status === 'canceled' || !user) return;
  if (imp.created || imp.updated) await logActivity(db, {type: 'import', title: `Imported ${imp.created + imp.updated} ${noun.many} from ${imp.fileName}`, actorId: user.id});
  const link = `${noun.path}?importId=${imp.id}`;
  await notify(db, [user.id], {
    type: 'import',
    title: status === 'done' ? `Import finished: ${imp.fileName}` : `Import failed: ${imp.fileName}`,
    body: status === 'done' ? summary : imp.error,
    link,
  });
  // Owners who got records get one summary each.
  for (const [k, n] of Object.entries(extra)) {
    if (!k.startsWith('owner:')) continue;
    await notify(db, [k.slice(6)], {type: 'assigned', title: `${user.name} imported ${n} ${n === 1 ? noun.one : noun.many} assigned to you`, link: noun.path, actorId: user.id});
  }
  // A full scan per entity; several imports finishing in the same hour share one.
  const hour = Math.floor(Date.now() / 3_600_000);
  if (imp.created && entity !== 'deal') await enqueue(db, 'duplicates.scan', {entity}, {key: `dup-scan-${entity}-import-${hour}`});
  if (extra.companiesCreated && entity !== 'company') await enqueue(db, 'duplicates.scan', {entity: 'company'}, {key: `dup-scan-company-import-${hour}`});
  if (options.emailMe) {
    const origin = (imp.stats as {origin?: string}).origin || config.siteUrl();
    const lines = [
      status === 'done' ? `Your import of ${imp.fileName} has finished.` : `Your import of ${imp.fileName} stopped: ${imp.error ?? 'an error'}.`,
      '',
      summary,
      ...(errorFileId ? ['', `Rows with errors (link valid for 7 days): ${await signedFileUrl(origin, errorFileId)}`] : []),
      '',
      `Open: ${origin}${CRM_APP}${link}`,
    ];
    await sendSystemEmail(db, {to: [user.email], subject: status === 'done' ? `Import finished: ${imp.fileName}` : `Import failed: ${imp.fileName}`, text: lines.join('\n')}).catch((e) => console.error('[import] email', String((e as Error)?.message ?? e).slice(0, 200)));
  }
}

const signedFileUrl = (origin: string, fileId: string) => publicFileUrl(origin, fileId, IO_FILE_DAYS);

