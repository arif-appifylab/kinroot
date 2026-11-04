/**
 * CSV exports of contacts, companies and deals (the list page's filters or a
 * list / segment's members, always within the requester's `userScope`).
 * Up to DIRECT_EXPORT_ROWS rows are written during the request; bigger ones
 * run as `export.run` jobs that append 1,000 rows per ExportChunk and queue
 * themselves until done (up to 50 MB), then go to platform storage as one
 * file (export-chunks.ts). The file is purpose `export`, deleted
 * by `pruneJobs()` after 7 days; the requester gets a notification and, when
 * asked (always for job exports), an email with a signed, expiring link.
 */
import type {Export, Prisma} from '../../../generated/prisma/client';
import type {JobRun} from '../kit/job-run';
import type {User} from '../kit/guards';
import {DEAL_STATUSES, DIRECT_EXPORT_ROWS, IO_ENTITIES, IO_FILE_DAYS, MAX_EXPORT_BYTES, exportColumns, type IoEntity} from '@/lib/import-export';
import {LIFECYCLE} from '@/lib/format';
import type {Db} from '../kit/db';
import {contactWhere} from '../routes/contacts';
import {companyWhere} from '../routes/companies';
import {dealWhere} from '../routes/deals';
import {publicFileUrl} from '../routes/files';
import {sendSystemEmail} from '../email/service';
import type {AppContext} from '../kit/guards';
import {audit} from './audit';
import {CSV_BOM, csvLine} from './csv';
import {chunkStream, chunkedSize, writeChunk} from './export-chunks';
import {maskEmail} from '../../../platform/auth/admin';
import {CRM_API} from '../kit/config';
import {purgeFiles, storeStream} from '../kit/storage';
import {memberWithEmail} from './users';
import {userScope} from './http';
import {enqueue} from './jobs';
import {notify} from './notify';
import {scoreBandWhere} from './scoring';
import {listContactWhere} from './segments';
import {shownEmail} from './owner-account';
import {strings} from './json-list';

const PAGE = 1_000;
const BUDGET_MS = 8_000;

type Row = Record<string, unknown> & {id: string; custom: unknown};

/** The owner as an export shows them: the name, and the address only of the requester's own records (others masked). */
const ownerSelect = {select: {id: true, name: true, user: {select: {email: true}}}} as const;
const ownerEmailOf = (owner: {id: string; user: {email: string} | null} | null, user: User) =>
  !owner?.user || !shownEmail(owner.user.email) ? null : owner.id === user.id ? owner.user.email : maskEmail(owner.user.email);

/** The export's rows as a where: the saved filters, the list, and what the requester may see. */
async function exportWhere(db: Db, exp: Export, user: User) {
  const f = exp.filters as Record<string, string>;
  const scope = await userScope(db, user);
  if (exp.entity === 'contact') {
    const and: Prisma.ContactWhereInput[] = [await contactWhere(db, f, scope)];
    if (f.scoreBand) and.push(await scoreBandWhere(db, f.scoreBand));
    const listId = exp.listId ?? f.listId;
    if (listId) and.push(await listContactWhere(db, listId));
    return {AND: and, ...scope} satisfies Prisma.ContactWhereInput;
  }
  if (exp.entity === 'company') {
    const where = companyWhere(f);
    if (f.industry) where.industry = f.industry;
    return {AND: [where], ...scope} satisfies Prisma.CompanyWhereInput;
  }
  const where = await dealWhere(db, {...f, createdDays: f.createdDays ? Number(f.createdDays) : undefined, closedDays: undefined} as Parameters<typeof dealWhere>[1], scope);
  const and: Prisma.DealWhereInput[] = [where];
  // "Rotting" on the deals page: no activity for longer than the pipeline allows.
  if (f.rotting === '1' && f.pipelineId) {
    const p = await db.pipeline.findUnique({where: {id: f.pipelineId}, select: {rottingDays: true}});
    if (p) and.push({lastActivityAt: {lt: new Date(Date.now() - p.rottingDays * 86_400_000)}});
  }
  return {AND: and, ...scope} satisfies Prisma.DealWhereInput;
}

export async function countExport(db: Db, exp: Export, user: User) {
  const where = await exportWhere(db, exp, user);
  return exp.entity === 'contact'
    ? db.contact.count({where: where as Prisma.ContactWhereInput})
    : exp.entity === 'company'
      ? db.company.count({where: where as Prisma.CompanyWhereInput})
      : db.deal.count({where: where as Prisma.DealWhereInput});
}

async function page(db: Db, exp: Export, user: User): Promise<Row[]> {
  const [base, scope] = await Promise.all([exportWhere(db, exp, user), userScope(db, user)]);
  const after = exp.cursor ? {id: {gt: exp.cursor}} : {};
  const args = {orderBy: {id: 'asc' as const}, take: PAGE};
  if (exp.entity === 'contact') {
    const rows = await db.contact.findMany({...args, where: {AND: [base as Prisma.ContactWhereInput, after]}, include: {owner: ownerSelect, companies: {where: {isPrimary: true}, take: 1, include: {company: {select: {name: true, domain: true}}}}}});
    return rows.map((r) => ({...r, company: r.companies[0]?.company.name, companyDomain: r.companies[0]?.company.domain, owner: r.owner?.name, ownerEmail: ownerEmailOf(r.owner, user), lifecycleStage: LIFECYCLE[r.lifecycleStage].label}));
  }
  if (exp.entity === 'company') {
    const rows = await db.company.findMany({...args, where: {AND: [base as Prisma.CompanyWhereInput, after]}, include: {owner: ownerSelect, _count: {select: {contacts: true, deals: {where: {status: 'OPEN'}}}}}});
    return rows.map((r) => ({...r, contactCount: r._count.contacts, openDeals: r._count.deals, owner: r.owner?.name, ownerEmail: ownerEmailOf(r.owner, user)}));
  }
  const rows = await db.deal.findMany({
    ...args,
    where: {AND: [base as Prisma.DealWhereInput, after]},
    // Linked contacts' addresses only of contacts the requester may see, as the deal page (AUDIT-2 L-1).
    include: {owner: ownerSelect, pipeline: {select: {name: true}}, stage: {select: {name: true}}, company: {select: {name: true, domain: true}}, contacts: {where: {contact: scope}, include: {contact: {select: {email: true}}}}},
  });
  return rows.map((r) => ({
    ...r,
    pipeline: r.pipeline.name,
    stage: r.stage.name,
    status: DEAL_STATUSES[r.status].label,
    company: r.company?.name,
    companyDomain: r.company?.domain,
    contacts: r.contacts.flatMap((l) => (l.contact.email ? [l.contact.email] : [])),
    owner: r.owner?.name,
    ownerEmail: ownerEmailOf(r.owner, user),
    expectedCloseDate: r.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
  }));
}

/** Cells as people read them: Yes / No, "a; b" lists, ISO dates. */
function show(v: unknown) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (Array.isArray(v)) return v.join('; ');
  return v;
}

/** Writes pages until done or out of time. Returns true when every row is in the file. */
async function writePages(db: Db, exp: Export, user: User, budgetMs: number) {
  const started = Date.now();
  const custom = new Map((await db.customFieldDef.findMany({where: {entity: IO_ENTITIES[exp.entity as IoEntity].fieldEntity}})).map((d) => [`custom.${d.key}`, d.key]));
  let cur = exp;
  while (Date.now() - started < budgetMs) {
    const rows = await page(db, cur, user);
    if (!rows.length) return {exp: cur, done: true};
    const text = rows
      .map((r) => csvLine(strings(cur.columns).map((col) => show(custom.has(col) ? (r.custom as Record<string, unknown>)?.[custom.get(col)!] : r[col]))))
      .join('\r\n');
    await writeChunk(db, cur.id, cur.chunks + 1, `\r\n${text}`);
    cur = await db.export.update({where: {id: cur.id}, data: {cursor: rows.at(-1)!.id, chunks: cur.chunks + 1, processed: cur.processed + rows.length}});
    if (rows.length < PAGE) return {exp: cur, done: true};
  }
  return {exp: cur, done: false};
}

/** New export: the file with its header row, then written now (small) or by jobs (big). */
export async function startExport(db: Db, c: AppContext, user: User, input: {entity: IoEntity; filters: Record<string, string>; listId: string | null; columns: string[]; emailMe: boolean; origin: string; fileName: string}) {
  const defs = await db.customFieldDef.findMany({where: {entity: IO_ENTITIES[input.entity].fieldEntity}});
  const known = new Map(exportColumns(input.entity, defs).map((col) => [col.key, col.label]));
  const columns = input.columns.filter((col) => known.has(col));
  let exp = await db.export.create({data: {entity: input.entity, userId: user.id, filters: input.filters, listId: input.listId, columns, fileName: input.fileName, emailMe: input.emailMe, origin: input.origin}});
  await writeChunk(db, exp.id, 0, CSV_BOM + csvLine(columns.map((col) => known.get(col))));
  const total = await countExport(db, exp, user);
  exp = await db.export.update({where: {id: exp.id}, data: {total}});
  if (total <= DIRECT_EXPORT_ROWS) {
    const r = await writePages(db, {...exp, status: 'running'}, user, 25_000);
    if (r.done) return finishExport(db, c, r.exp, user);
    exp = r.exp;
  }
  // Big exports always go to the inbox as well.
  exp = await db.export.update({where: {id: exp.id}, data: {status: 'queued', emailMe: true}});
  await enqueue(db, 'export.run', {exportId: exp.id}, {key: `export-${exp.id}-start`});
  return exp;
}

/** Job `export.run`. Safe to run twice: chunks are keyed by number and the cursor only moves after a chunk is stored. */
export async function exportJob(db: Db, p: {exportId: string}, job: JobRun) {
  let exp = await db.export.findUnique({where: {id: p.exportId}});
  if (!exp || !['queued', 'running'].includes(exp.status)) return;
  const user = exp.userId ? await memberWithEmail(db, {id: exp.userId}) : null;
  if (!user || !user.active) return void (await failExport(db, exp, 'The person who asked for this export no longer has access'));
  try {
    if (exp.status === 'queued') exp = await db.export.update({where: {id: exp.id}, data: {status: 'running'}});
    const r = await writePages(db, exp, user, BUDGET_MS);
    if ((await chunkedSize(db, exp.id)) > MAX_EXPORT_BYTES) return void (await failExport(db, r.exp, 'The export is larger than 50 MB. Narrow the filters or pick fewer columns.'));
    if (r.done) await finishExport(db, null, r.exp, user);
    else {
      // Keyed by this job: a retried try of it never queues a second next step.
      await enqueue(db, 'export.run', {exportId: exp.id}, {key: `export-${exp.id}-after-${job.id}`});
    }
  } catch (e) {
    if (job.attempts < job.maxAttempts) throw e;
    await failExport(db, exp, (e as Error).message);
  }
}

async function failExport(db: Db, exp: Export, error: string) {
  if (exp.fileId) await purgeFiles(db, {id: exp.fileId}).catch(() => {});
  await db.exportChunk.deleteMany({where: {exportId: exp.id}});
  await db.export.update({where: {id: exp.id}, data: {status: 'failed', error: error.slice(0, 500), finishedAt: new Date()}});
  const user = exp.userId ? await memberWithEmail(db, {id: exp.userId}) : null;
  await audit(db, null, {action: 'export.failed', entity: 'export', recordId: exp.id, label: exp.fileName, actor: user && {id: user.id, name: user.name, email: user.email}, meta: {object: IO_ENTITIES[exp.entity as IoEntity].many, error}});
  if (user) await notify(db, [user.id], {type: 'export', title: `Export failed: ${exp.fileName}`, body: error, link: IO_ENTITIES[exp.entity as IoEntity].path});
}

/** The export's file through the files route (only its owner or an admin may open it). */
export const exportDownloadPath = (fileId: string) => `${CRM_API}/files/${fileId}?download=1`;

async function finishExport(db: Db, c: AppContext | null, exp: Export, user: User) {
  const size = await chunkedSize(db, exp.id);
  if (size > MAX_EXPORT_BYTES) {
    await failExport(db, exp, 'The export is larger than 50 MB. Narrow the filters or pick fewer columns.');
    return db.export.findUniqueOrThrow({where: {id: exp.id}});
  }
  // The written chunks become one file in platform storage, then the chunks go.
  if (!exp.fileId) {
    const file = await storeStream(db, {name: exp.fileName, mimeType: 'text/csv', purpose: 'export', uploadedById: user.id}, chunkStream(db, exp.id), size);
    exp = await db.export.update({where: {id: exp.id}, data: {fileId: file.id}});
  }
  await db.exportChunk.deleteMany({where: {exportId: exp.id}});
  const noun = IO_ENTITIES[exp.entity as IoEntity];
  let emailed = false;
  // Claimed before sending (AUDIT-2 L-12): a retried or doubled finish never emails the link twice.
  const claimed = exp.emailMe ? (await db.export.updateMany({where: {id: exp.id, emailed: false}, data: {emailed: true}})).count === 1 : false;
  if (claimed) {
    const url = await publicFileUrl(exp.origin ?? '', exp.fileId!, IO_FILE_DAYS);
    emailed = await sendSystemEmail(db, {
      to: [user.email],
      subject: `Your export is ready: ${exp.fileName}`,
      text: [`Your export of ${exp.processed.toLocaleString('en-US')} ${noun.many} is ready.`, '', `Download (the link works for ${IO_FILE_DAYS} days, no sign-in needed):`, url].join('\n'),
    }).catch((e) => (console.error('[export] email', String((e as Error)?.message ?? e).slice(0, 200)), false));
  }
  // Not claimed: an earlier run sent it, and its `emailed` stays.
  const done = await db.export.update({where: {id: exp.id}, data: {status: 'done', emailed: claimed ? emailed : undefined, finishedAt: new Date()}});
  // Small exports download right away in the browser; only background ones need a nudge.
  if (!c) await notify(db, [user.id], {type: 'export', title: `Export ready: ${exp.fileName}`, body: `${exp.processed.toLocaleString('en-US')} ${noun.many}${emailed ? ' · the link was emailed to you' : ''}`, link: exportDownloadPath(exp.fileId!)});
  const defs = await db.customFieldDef.findMany({where: {entity: noun.fieldEntity}, select: {key: true, label: true}});
  const labels = new Map(exportColumns(exp.entity as IoEntity, defs).map((col) => [col.key, col.label]));
  await audit(db, c, {
    action: 'export.completed',
    entity: 'export',
    recordId: exp.id,
    label: exp.fileName,
    actor: c ? undefined : {id: user.id, name: user.name, email: user.email},
    meta: {object: noun.many, rows: exp.processed, filters: exp.filters, listId: exp.listId, columns: strings(exp.columns).map((col) => labels.get(col) ?? col), fileName: exp.fileName, fileId: exp.fileId, size, emailed, background: !c},
  });
  return done;
}
