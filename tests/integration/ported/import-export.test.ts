// Ported from Kinroot's scripts/test-import-export.mjs
// CSV import and export from the list pages: parsing and guessing, the dry run, modes, companies and deals,
// batches and retries, permissions, exports (small, list, deal, big as a job with an emailed signed link), expiry.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../../src/server/background'; // import / export batches run as jobs
import {app} from '../../../src/server/app';
import {importJob} from '../../../src/server/crm/lib/imports';
import {pruneImportExport} from '../../../src/server/crm/lib/io-prune';
import {runJob} from '../../../src/server/crm/lib/jobs';
import {env} from '../support/cloudflare-workers';
import {fakeStorage, resetCrm, storedFiles, teammate} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {crm, download, meOf, must, settle, stubFetch, tick, uploadCsv, workspace, type Crm, type Me} from './support-lists';
import {eventually} from '../support/wait';

const RUN = 'qz7';
const L = (s: string) => `${s} ${RUN}`;
const OWNER_EMAIL = 'owner@kinroot-mail.io'; // system emails skip reserved test domains such as example.com

type Issue = {row: number; column: string | null; message: string; level: string};
type Imp = {
  id: string; status: string; total: number; delimiter: string; headers: string[]; mapping: (string | null)[];
  created: number; updated: number; skipped: number; failed: number; processed: number;
  preview: {create: number; update: number; skip: number; errors: number; newCompanies: number};
  stats: Record<string, number>; hasErrorFile: boolean; errorFileId: string | null;
};
type Detail = {import: Imp; issues: Issue[]};
type Exp = {id: string; status: string; total: number; processed: number; fileName: string; fileId: string | null; emailMe: boolean; emailed: boolean; downloadUrl: string | null};

/** What the stubbed Resend API received (the old SMTP sink). */
const mail: {to: string[]; subject: string; text: string}[] = [];
const resend = stubFetch(
  (u) => u.hostname === 'api.resend.com',
  (url, init) => {
    if (url.pathname === '/domains') return new Response('{"data":[]}', {status: 200});
    mail.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({id: `re_${mail.length}`}), {status: 200});
  },
);

const defaults = {mode: 'upsert', skipBlanks: true, dateOrder: 'mdy', listId: null, tag: null, defaultOwner: 'me', createCompanies: true, pipelineId: null, emailMe: false, valueMap: {}};
const issue = (d: Detail, row: number, re: RegExp) => d.issues.some((i) => i.row === row && re.test(`${i.column ?? ''} ${i.message}`));

let owner: Crm;
let me: Me;
let member: Crm;
let memberUser: Me;
let viewer: Crm;
let f: Record<'tier' | 'interests' | 'vip' | 'renewal' | 'budget' | 'segment' | 'region', {id: string; key: string; label: string}>;
let list: {id: string; name: string};
let d1: Detail;
let pipe: {id: string; name: string; stages: {id: string; name: string}[]};
let exportLink: string;

const ann = `ann-${RUN}@acme-${RUN}.io`;
const bob = `bob-${RUN}@globex-${RUN}.io`;
const annEmail = `ann-renamed-${RUN}@acme-${RUN}.io`;
const BIG = 450; // the script used 5,200 against a server; 450 still spans three 200-row batches in-process
const bigTag = `big-${RUN}`;

async function waitImport(c: Crm, id: string, statuses: string[]) {
  const d = await eventually(async () => must<Detail>(await c.get(`/imports/${id}`), 'import detail'), (x) => statuses.includes(x.import.status), {timeoutMs: 20_000});
  if (!statuses.includes(d.import.status)) throw new Error(`import ${id} never reached ${statuses}`);
  return d;
}

/** Upload → validate → (start) like the drawer does. */
async function runImport(c: Crm, entity: string, name: string, text: string, {mapping, options = {}, start = true}: {mapping?: (string | null)[]; options?: Record<string, unknown>; start?: boolean} = {}) {
  const up = must<Detail>(await uploadCsv(c, entity, name, text), `upload ${name}`);
  const id = up.import.id;
  must(await c.post(`/imports/${id}/validate`, {mapping: mapping ?? up.import.mapping, options: {...defaults, ...options}}), `validate ${name}`);
  const checked = await waitImport(c, id, ['ready', 'failed']);
  if (!start) return {id, up, checked, done: checked};
  must(await c.post(`/imports/${id}/start`), `start ${name}`);
  const done = await waitImport(c, id, ['done', 'failed', 'canceled']);
  return {id, up, checked, done};
}

const contactBy = (email: string) => db.contact.findFirst({where: {email}});
type Custom = Record<string, unknown>;

describe.skipIf(!DATABASE_URL)('ported: CSV import and export (scripts/test-import-export.mjs)', () => {
  beforeAll(async () => {
    configureEnv();
    fakeStorage();
    env.RESEND_API_KEY = 're_test_ported_io';
    await resetCrm();
    storedFiles.clear();
    ({c: owner, me} = await workspace(false, OWNER_EMAIL));
    member = crm((await teammate(owner.browser, 'member@example.com', 'MEMBER')).browser);
    memberUser = await meOf(member);
    viewer = crm((await teammate(owner.browser, 'viewer@example.com', 'VIEWER')).browser);
    // A shared team mailbox: system emails (import summaries, export links) go out from it. SMTP is gone: Resend.
    must(await owner.post('/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'Team', fromEmail: 'team@kinroot-mail.io', shared: true, isDefault: true, dailyLimit: 1000}}), 'team mailbox');

    const field = async (entity: string, label: string, type: string, options: string[] = []) => must<{field: {id: string; key: string; label: string}}>(await owner.post('/fields', {entity, label, type, options}), 'field').field;
    f = {
      tier: await field('CONTACT', L('Tier'), 'SELECT', ['Gold', 'Silver']),
      interests: await field('CONTACT', L('Interests'), 'MULTISELECT', ['A', 'B']),
      vip: await field('CONTACT', L('VIP'), 'CHECKBOX'),
      renewal: await field('CONTACT', L('Renewal'), 'DATE'),
      budget: await field('CONTACT', L('Budget'), 'NUMBER'),
      segment: await field('COMPANY', L('Segment'), 'SELECT', ['SMB', 'Enterprise']),
      region: await field('DEAL', L('Region'), 'SELECT', ['EMEA', 'APAC']),
    };
    list = must<{list: {id: string; name: string}}>(await owner.post('/lists', {name: `Imported ${RUN}`, kind: 'STATIC'}), 'list').list;
    const pipes = must<{rows: (typeof pipe & {isDefault: boolean})[]}>(await owner.get('/pipelines'), 'pipelines').rows;
    pipe = pipes.find((p) => p.isDefault) ?? pipes[0]!;
  });
  afterAll(async () => {
    resend.restore();
    delete env.RESEND_API_KEY;
    await db.$disconnect();
  });

  it('parses a messy file (BOM, semicolons, quoted newlines) and guesses the mapping', async () => {
    const csv =
      '﻿' +
      [
        `E-mail;Full Name;Company name;Mobile;${L('Tier')};${L('Interests')};${L('VIP')};${L('Renewal')};${L('Budget')};Contact Owner;Lifecycle Stage;Tags;Email opt-out;City;Notes`,
        `${ann};Ann Lee;Acme ${RUN};+1 555 0100;gold;"A; New1";yes;31/03/2026;€1.250,50;${OWNER_EMAIL};Customer;t1, t2;no;Berlin;"first line\nsecond line; with ""quotes"""`,
        'not-an-email;Bad Row;;;;;;;;;;;;;',
        `${ann.toUpperCase()};Ann Again;;;;;;;;;;;;;`,
        `${bob};Smith, Bob;Globex ${RUN};;platinum;B;x;45000;12;Nobody Here;sql;;;;`,
        ';;;;;;;;;;;;;;',
        ';;;+44 1;;;;;;;;;;Paris;',
      ].join('\r\n');
    const up = must<Detail & {sample: string[][]}>(await uploadCsv(owner, 'contact', 'messy.csv', csv), 'upload messy');
    expect(up.import.delimiter, 'semicolon detected').toBe(';');
    expect(up.import.total, 'blank lines skipped, quoted newline kept in one row').toBe(5);
    expect(up.import.headers[0], 'BOM stripped from the first header').toBe('E-mail');
    const g = up.import.mapping;
    expect(g.slice(0, 4), 'synonyms auto-matched (E-mail, Full Name, Company name, Mobile)').toEqual(['email', 'fullName', 'company', 'phone']);
    expect(g.slice(4, 7), 'custom fields auto-matched by label').toEqual([`custom.${f.tier.key}`, `custom.${f.interests.key}`, `custom.${f.vip.key}`]);
    expect([g[9], g[10], g[11], g[12], g[14]], 'owner / lifecycle / tags / opt-out / notes matched').toEqual(['owner', 'lifecycleStage', 'tags', 'emailOptOut', 'note']);
    expect(up.sample[0]![14], 'quoted newline survives').toContain('\n');

    // The dry run.
    const valueMap = {[`custom.${f.tier.key}`]: {gold: 'Gold', platinum: '__skip__'}, [`custom.${f.interests.key}`]: {a: 'A', new1: '__new__:New1', b: 'B'}};
    must(await owner.post(`/imports/${up.import.id}/validate`, {mapping: g, options: {...defaults, dateOrder: 'dmy', listId: list.id, tag: `imp-${RUN}`, valueMap, emailMe: true}}), 'validate messy');
    const v1 = await waitImport(owner, up.import.id, ['ready']);
    expect({create: v1.import.preview.create, errors: v1.import.preview.errors, skip: v1.import.preview.skip}, 'dry run counts: 2 create, 2 errors, 1 skipped').toEqual({create: 2, errors: 2, skip: 1});
    expect(v1.import.preview.newCompanies, 'dry run counts new companies').toBe(2);
    expect(issue(v1, 3, /E-mail.*Email: Invalid email/), 'invalid email is an error on its column').toBe(true);
    expect(issue(v1, 4, /Same email as row 2/), 'duplicate in file (case-insensitive) is skipped').toBe(true);
    expect(issue(v1, 5, /No team member "Nobody Here"/), 'unknown owner warns').toBe(true);
    expect(issue(v1, 6, /Needs a name or an email/), 'a row without name or email fails (blank lines are skipped)').toBe(true);
    expect(await contactBy(ann), 'dry run writes nothing').toBeNull();
    const dry = await owner.get(`/imports/${up.import.id}/errors.csv?phase=validate`);
    const dryText = String(dry.json.text ?? '');
    expect(dry.status).toBe(200);
    expect(dryText.includes('not-an-email') && dryText.includes('Import errors') && !dryText.includes('Smith, Bob'), 'dry-run error CSV has only the error rows').toBe(true);

    // The run.
    must(await owner.post(`/imports/${up.import.id}/start`), 'start messy');
    d1 = await waitImport(owner, up.import.id, ['done', 'failed']);
    expect({status: d1.import.status, created: d1.import.created, failed: d1.import.failed, skipped: d1.import.skipped}, 'run counts').toEqual({status: 'done', created: 2, failed: 2, skipped: 1});
  });

  it('writes the rows: names, lifecycle, standard and custom fields, companies, notes, timeline, events, list', async () => {
    const A = (await contactBy(ann))!;
    const B = (await contactBy(bob))!;
    expect(A && B, 'both contacts created').toBeTruthy();
    expect([A.firstName, A.lastName, B.firstName, B.lastName], '"Ann Lee" and "Smith, Bob" split into first / last').toEqual(['Ann', 'Lee', 'Bob', 'Smith']);
    expect([A.lifecycleStage, B.lifecycleStage], 'lifecycle by label and synonym (sql → qualified)').toEqual(['CUSTOMER', 'QUALIFIED']);
    expect({phone: A.phone, city: A.city, emailOptOut: A.emailOptOut, ownerId: A.ownerId, source: A.source}, 'standard fields').toEqual({phone: '+1 555 0100', city: 'Berlin', emailOptOut: false, ownerId: me.id, source: 'Import'});
    expect(A.tags, 'tags + import tag').toEqual(expect.arrayContaining(['t1', 't2', `imp-${RUN}`]));
    const ca = A.custom as Custom;
    expect([ca[f.tier.key], ca[f.interests.key], ca[f.vip.key], ca[f.renewal.key], ca[f.budget.key]], 'custom: select by value map, multi with new option, checkbox, d/m/y date, decimal comma').toEqual(['Gold', ['A', 'New1'], true, '2026-03-31', 1250.5]);
    const cb = B.custom as Custom;
    expect([cb[f.tier.key], cb[f.vip.key], cb[f.renewal.key], cb[f.budget.key]], 'skipped option value left out, "x" = yes, Excel serial date').toEqual([undefined, true, '2023-03-15', 12]);
    expect(B.ownerId, 'unknown owner falls back to the default owner').toBe(me.id);
    expect((await db.customFieldDef.findUniqueOrThrow({where: {id: f.interests.id}})).options, 'new option added to the field').toContain('New1');
    const optionAudit = await db.auditLog.findMany({where: {action: 'custom_field.updated', recordId: f.interests.id}, select: {meta: true}});
    expect(optionAudit.some((a) => (a.meta as {via?: string}).via === 'import'), 'adding options is audited').toBe(true);
    const links = await db.contactCompany.findMany({where: {contactId: A.id}, select: {isPrimary: true, company: {select: {name: true}}}});
    expect(links.map((l) => [l.company.name, l.isPrimary]), 'company created and linked as primary').toEqual([[`Acme ${RUN}`, true]]);
    expect((await db.note.findFirst({where: {contactId: A.id}}))?.body, 'notes column → note (quotes and newline intact)').toBe('first line\nsecond line; with "quotes"');
    expect(await db.activity.count({where: {contactId: A.id, type: 'contact_created'}}), 'timeline entry').toBeGreaterThan(0);
    expect(await db.activity.count({where: {contactId: A.id, type: 'note'}}), 'note on the timeline').toBeGreaterThan(0);
    expect(await db.event.count({where: {type: 'contact.created', recordId: {in: [A.id, B.id]}}}), 'contact.created emitted once each').toBe(2);
    expect(await db.event.count({where: {type: 'company.created', data: {path: ['name'], equals: `Acme ${RUN}`}}}), 'company.created emitted').toBeGreaterThan(0);
    expect(await db.contactListMember.count({where: {listId: list.id, source: 'import'}}), 'added to the static list').toBe(2);
  });

  it('keeps the error file private, audits, notifies and emails a summary with a signed link', async () => {
    expect(d1.import.hasErrorFile, 'error file stored').toBe(true);
    const errFile = await download(owner, `/files/${d1.import.errorFileId}?download=1`);
    expect(errFile.status).toBe(200);
    expect(errFile.text, 'error CSV downloads').toContain('not-an-email');
    expect((await member.get(`/files/${d1.import.errorFileId}?download=1`)).status, "others can't open someone's import files").toBe(404);
    const au = await db.auditLog.findFirst({where: {action: 'import.completed', recordId: d1.import.id}});
    const meta = au?.meta as {created?: number; errors?: number; errorFileId?: string} | undefined;
    expect({category: au?.category, created: meta?.created, errors: meta?.errors, errorFileId: meta?.errorFileId, actorId: au?.actorId}, 'audit entry with counts and files').toEqual({category: 'export', created: 2, errors: 2, errorFileId: d1.import.errorFileId, actorId: me.id});
    expect(await db.notification.count({where: {userId: me.id, type: 'import', link: `/contacts?importId=${d1.import.id}`}}), 'in-app notification links back to the drawer').toBe(1);
    const importMail = mail.find((m) => m.to.includes(OWNER_EMAIL) && `${m.subject}\n${m.text}`.includes('messy.csv'));
    expect(importMail?.text, 'summary email').toMatch(/2 created .* 2 with errors/);
    expect(importMail?.text, 'summary email with a signed error-file link').toMatch(/\/site-api\/crm\/public\/files\/\w+\?exp=\d+&sig=/);
  });

  it('updates: blanks keep values, skipBlanks off clears them, create-only, Record ID first', async () => {
    const upd = await runImport(owner, 'contact', 'update.csv', `Email,City,Job title,${L('Budget')}\n${ann},,CEO,\nnobody-${RUN}@x.io,Rome,,\n`, {options: {mode: 'update'}});
    let A2 = (await contactBy(ann))!;
    expect([upd.done.import.updated, upd.done.import.skipped, A2.title, A2.city, (A2.custom as Custom)[f.budget.key]], 'update-only: blanks keep values; unknown email skipped').toEqual([1, 1, 'CEO', 'Berlin', 1250.5]);
    expect(issue(upd.done, 3, /No matching contact to update/), 'update-only warns about rows without a match').toBe(true);
    const changes = await db.activity.findMany({where: {contactId: A2.id, type: 'field_changed'}, select: {data: true}});
    expect(changes.some((a) => ((a.data as {changes?: {field: string}[]}).changes ?? []).some((ch) => ch.field === 'title')), 'update on the timeline with the diff').toBe(true);
    expect(await db.event.count({where: {type: 'contact.updated', recordId: A2.id}}), 'contact.updated emitted').toBeGreaterThan(0);

    await runImport(owner, 'contact', 'blanks.csv', `Email,City,${L('Budget')}\n${ann},,\n`, {options: {mode: 'update', skipBlanks: false}});
    A2 = (await contactBy(ann))!;
    expect([A2.city, (A2.custom as Custom)[f.budget.key], A2.firstName], 'skipBlanks off clears values (never the name)').toEqual([null, undefined, 'Ann']);

    const co = await runImport(owner, 'contact', 'create-only.csv', `Email,First name,City\n${ann},Changed,Oslo\nnew-${RUN}@x.io,New,Oslo\n`, {options: {mode: 'create'}});
    A2 = (await contactBy(ann))!;
    expect([co.done.import.created, co.done.import.skipped, A2.firstName], 'create-only leaves existing records alone').toEqual([1, 1, 'Ann']);

    const byId = await runImport(owner, 'contact', 'by-id.csv', `Record ID,Email,Job title\n${A2.id},${annEmail},CTO\n`);
    A2 = await db.contact.findUniqueOrThrow({where: {id: A2.id}});
    expect([byId.done.import.updated, A2.email, A2.title], 'Record ID matches first (email can change)').toEqual([1, annEmail, 'CTO']);
  });

  it('a big import runs in batches, creates companies once, and a retried run duplicates nothing', async () => {
    const lines = ['first_name,last_name,email,company'];
    for (let i = 0; i < BIG; i++) lines.push(`P${i},Big,big-${RUN}-${i}@bulk-${RUN}.test,"Bulk ${RUN} ${i % 7}"`);
    const big = await runImport(owner, 'contact', 'big.csv', lines.join('\n'), {options: {tag: bigTag}});
    const bigCount = () => db.contact.count({where: {email: {startsWith: `big-${RUN}-`}}});
    expect([big.done.import.status, big.done.import.created, await bigCount()], 'big import creates every row once').toEqual(['done', BIG, BIG]);
    expect(await db.company.count({where: {name: {startsWith: `Bulk ${RUN} `}}}), 'companies created once across batches').toBe(7);

    // Retry: run the same import again from the start, as a retried job would. No new rows, events or timeline entries.
    const events = async () => (await db.$queryRaw<{n: number}[]>`SELECT count(*)::int AS n FROM "Event" WHERE type = 'contact.created' AND data->>'email' LIKE ${`big-${RUN}-%`}`)[0]!.n;
    const evBefore = await events();
    const token = `retry${RUN}`;
    await db.import.update({where: {id: big.id}, data: {status: 'queued', processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, warnings: 0, token}});
    await tick(() => runJob((d) => importJob(d, 'run', {importId: big.id, token}, {id: 'retry', attempts: 1, maxAttempts: 3})));
    const again = await waitImport(owner, big.id, ['done', 'failed']);
    const acts = await db.activity.count({where: {type: 'contact_created', contact: {email: {startsWith: `big-${RUN}-`}}}});
    expect([again.import.status, await bigCount(), await events(), acts], 'retry from the start duplicates nothing (rows, events, timeline)').toEqual(['done', BIG, evBefore, BIG]);
  });

  it('an import can be stopped before its job starts, and that is audited', async () => {
    // In-process the run finishes inside the start request, so the stop is tried on an import the platform has
    // queued and not picked up yet (the script stopped one mid-run on the dev server).
    const cancelLines = ['email'];
    for (let i = 0; i < 30; i++) cancelLines.push(`cx-${RUN}-${i}@cancel.test`);
    const cx = await runImport(owner, 'contact', 'cancel.csv', cancelLines.join('\n'), {start: false});
    await db.import.update({where: {id: cx.id}, data: {status: 'queued', token: 'waiting'}});
    must(await owner.post(`/imports/${cx.id}/cancel`), 'cancel');
    const cxd = await waitImport(owner, cx.id, ['canceled', 'done']);
    expect(cxd.import.status, 'import can be stopped').toBe('canceled');
    expect(await db.auditLog.count({where: {action: 'import.canceled', recordId: cx.id}}), 'stopping is audited').toBe(1);
    // The job the platform would have run now finds nothing to do.
    await tick(() => runJob((d) => importJob(d, 'run', {importId: cx.id, token: 'waiting'}, {id: 'late', attempts: 1, maxAttempts: 3})));
    expect(await db.contact.count({where: {email: {startsWith: `cx-${RUN}-`}}}), 'nothing imported after the stop').toBe(0);
  });

  it('companies: domain then name, website → domain, adopting contacts, new select options', async () => {
    const orphan = await db.contact.create({data: {firstName: 'Orphan', email: `orphan@newco-${RUN}.io`}});
    const existingCo = must<{company: {id: string}}>(await owner.post('/companies', {name: `Old Name ${RUN}`, domain: `known-${RUN}.com`}), 'company').company;
    const csv = [
      `Company Name,Website,Industry,Number of employees,Annual revenue,Zip,${L('Segment')},Notes`,
      `NewCo ${RUN},https://www.newco-${RUN}.io/about,software,"1,200",$2.5m,10115,Enterprise,Met at a fair`,
      `Known ${RUN},known-${RUN}.com,Retail,40,,,smb,`,
      `NewCo Dup ${RUN},newco-${RUN}.io,,,,,,`,
      `Tiny ${RUN},,,,,,Startup,`,
    ];
    const ci = await runImport(owner, 'company', 'companies.csv', csv.join('\n'), {options: {valueMap: {[`custom.${f.segment.key}`]: {enterprise: 'Enterprise', smb: 'SMB', startup: '__new__:Startup'}}}});
    expect(ci.up.import.mapping, 'company headers matched').toEqual(['name', 'website', 'industry', 'employees', 'annualRevenue', 'postalCode', `custom.${f.segment.key}`, 'note']);
    expect([ci.done.import.created, ci.done.import.updated, ci.done.import.skipped], 'companies: 2 created, 1 updated (domain match), 1 duplicate').toEqual([2, 1, 1]);
    const newco = await db.company.findFirst({where: {domain: `newco-${RUN}.io`}});
    expect([newco?.name, newco?.employees, newco?.industry, newco?.postalCode, (newco?.custom as Custom)?.[f.segment.key]], 'website → domain, thousands, industry casing, custom select').toEqual([`NewCo ${RUN}`, 1200, 'Software', '10115', 'Enterprise']);
    expect(newco?.annualRevenue, '"$2.5m" is not a number: left out with a warning').toBeNull();
    const known = await db.company.findUniqueOrThrow({where: {id: existingCo.id}});
    expect([known.name, known.industry, (known.custom as Custom)[f.segment.key]], 'existing company updated by domain').toEqual([`Known ${RUN}`, 'Retail', 'SMB']);
    expect(await db.contactCompany.count({where: {contactId: orphan.id, companyId: newco!.id}}), 'new company adopts contacts on its domain').toBe(1);
    expect((await db.customFieldDef.findUniqueOrThrow({where: {id: f.segment.id}})).options, 'company select got the new option').toContain('Startup');
  });

  it('deals: pipeline and stage by name, status, owner and contacts by email, updates by name + company', async () => {
    const st = pipe.stages;
    const csv = [
      `Deal Name,Amount,Currency,Pipeline,Deal Stage,Status,Lost reason,Close Date,Deal owner,Company,Contact emails,Priority,${L('Region')}`,
      `Renewal ${RUN},"12,500.00",eur,${pipe.name},${st[1]!.name.toUpperCase()},,,2026-12-01,member@example.com,Acme ${RUN},"${annEmail}; ghost-${RUN}@x.io",high,emea`,
      `Bad stage ${RUN},100,,${pipe.name},No Such Stage,,,,,,,,`,
      `Lost one ${RUN},50,,,,lost,,03/04/2026,,,,,`,
      `Won one ${RUN},75,usd,,,closed won,,,,,,Low,apac`,
    ];
    const di = await runImport(owner, 'deal', 'deals.csv', csv.join('\n'));
    expect([di.up.import.mapping[4], di.up.import.mapping[10], di.up.import.mapping[8]], 'deal headers matched').toEqual(['stage', 'contacts', 'owner']);
    expect([di.done.import.created, di.done.import.failed], 'deals: 3 created, unknown stage fails').toEqual([3, 1]);
    expect(issue(di.done, 3, /No stage "No Such Stage"/), 'unknown stage error').toBe(true);
    expect(issue(di.done, 4, /Lost without a lost reason/), 'lost without reason warns').toBe(true);
    const D = (await db.deal.findFirst({where: {title: `Renewal ${RUN}`}}))!;
    expect(
      {value: D.value, currency: D.currency, stageId: D.stageId, ownerId: D.ownerId, priority: D.priority, region: (D.custom as Custom)[f.region.key], close: D.expectedCloseDate?.toLocaleDateString('sv')},
      'deal fields, stage by name (any case), owner by email',
    ).toEqual({value: 12500, currency: 'EUR', stageId: st[1]!.id, ownerId: memberUser.id, priority: 'High', region: 'EMEA', close: '2026-12-01'});
    expect((await db.company.findUnique({where: {id: D.companyId!}}))?.name, 'deal linked to the existing company').toBe(`Acme ${RUN}`);
    expect(await db.dealCompany.count({where: {dealId: D.id, isPrimary: true}})).toBe(1);
    expect(await db.dealContact.count({where: {dealId: D.id, contact: {email: annEmail}}}), 'deal linked to contacts by email').toBe(1);
    expect(await db.stageChange.count({where: {dealId: D.id, toStageId: st[1]!.id}}), 'stage history row').toBe(1);
    expect(await db.notification.count({where: {userId: memberUser.id, type: 'assigned', title: {contains: 'imported 1 deal assigned to you'}}}), 'owners get one summary notification').toBe(1);
    const lost = await db.deal.findFirst({where: {title: `Lost one ${RUN}`}});
    const won = await db.deal.findFirst({where: {title: `Won one ${RUN}`}});
    expect([lost?.status, !!lost?.closedAt, won?.status, won?.priority, won?.pipelineId, won?.stageId], 'status (lost / closed won), default pipeline and first stage').toEqual(['LOST', true, 'WON', 'Low', pipe.id, st[0]!.id]);

    const du = await runImport(owner, 'deal', 'deals-update.csv', `Deal name,Company,Stage\nRenewal ${RUN},Acme ${RUN},${st[2]!.name}\n`);
    const D2 = await db.deal.findUniqueOrThrow({where: {id: D.id}});
    expect([du.done.import.updated, D2.stageId], 'deal matched by name + company and moved').toEqual([1, st[2]!.id]);
    expect(await db.activity.count({where: {dealId: D.id, type: 'stage_changed'}}), 'stage move on the timeline').toBeGreaterThan(0);
    expect(await db.event.count({where: {type: 'deal.stage_changed', recordId: D.id}}), 'stage move emitted').toBeGreaterThan(0);
  });

  it('permissions: viewers, other people’s imports, new options, owner-only visibility, export counts', async () => {
    expect((await uploadCsv(viewer, 'contact', 'v.csv', 'email\nx@y.z\n')).status, 'viewers cannot import').toBe(403);
    expect((await member.get(`/imports/${d1.import.id}`)).status, "members can't open someone else's import").toBe(404);
    const mUp = must<Detail>(await uploadCsv(member, 'contact', 'member.csv', `Email,${L('Tier')}\n${annEmail},Bronze\nmine-${RUN}@x.io,Gold\n`), 'member upload');
    const mOpt = await member.post(`/imports/${mUp.import.id}/validate`, {mapping: mUp.import.mapping, options: {...defaults, valueMap: {[`custom.${f.tier.key}`]: {bronze: '__new__:Bronze'}}}});
    expect(mOpt.status, 'members cannot add options').toBe(403);
    must(await owner.patch('/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      must(await member.post(`/imports/${mUp.import.id}/validate`, {mapping: mUp.import.mapping, options: {...defaults, valueMap: {[`custom.${f.tier.key}`]: {bronze: '__skip__', gold: 'Gold'}}}}), 'member validate');
      const mv = await waitImport(member, mUp.import.id, ['ready']);
      expect(issue(mv, 2, /contact you can't see/), "owner-only visibility: members can't update records they can't see").toBe(true);
      expect(mv.import.preview.create).toBe(1);
      must(await member.post(`/imports/${mUp.import.id}/start`), 'member start');
      const md = await waitImport(member, mUp.import.id, ['done']);
      const mine = await contactBy(`mine-${RUN}@x.io`);
      expect([md.import.created, mine?.ownerId], 'member import creates their own records').toEqual([1, memberUser.id]);
      const mh = must<{rows: {id: string}[]}>(await member.get('/imports?entity=contact'), 'member history');
      expect(mh.rows.map((r) => r.id), 'members see their own import history').toEqual([mUp.import.id]);
      const mCount = must<{count: number}>(await member.post('/exports/count', {entity: 'contact', filters: {}}), 'member count').count;
      expect(mCount, 'member export count is their own contacts').toBe(await db.contact.count({where: {ownerId: memberUser.id}}));
    } finally {
      must(await owner.patch('/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
  });

  it('exports: small at once, readable values, formula-safe, audited, round trip, list, viewer, deals', async () => {
    must(await owner.post('/contacts', {firstName: 'Formula', lastName: `X${RUN}`, title: '=HYPERLINK("http://evil")', tags: [`imp-${RUN}`]}), 'formula contact');
    const cols = ['id', 'firstName', 'lastName', 'email', 'title', 'lifecycleStage', 'tags', 'company', 'owner', `custom.${f.tier.key}`, `custom.${f.interests.key}`, `custom.${f.vip.key}`, 'nonsense'];
    const small = must<{export: Exp}>(await owner.post('/exports', {entity: 'contact', filters: {tag: `imp-${RUN}`}, columns: cols}), 'small export').export;
    expect([small.status, small.total, !!small.downloadUrl], 'small export is written at once').toEqual(['done', 3, true]);
    const smallCsv = await download(owner, small.downloadUrl!);
    const lines = smallCsv.text.split('\r\n');
    expect(smallCsv.text.startsWith('﻿')).toBe(true);
    expect(lines[0], 'BOM + labelled header, unknown columns dropped').toBe(`﻿Record ID,First name,Last name,Email,Job title,Lifecycle stage,Tags,Company name,Owner,${L('Tier')},${L('Interests')},${L('VIP')}`);
    const annLine = lines.find((l) => l.includes(annEmail)) ?? '';
    expect(annLine.includes(',Customer,') && annLine.includes(`Acme ${RUN}`) && annLine.includes(',Gold,A; New1,Yes'), `values readable (lifecycle label, company, custom select / multi / checkbox): ${annLine}`).toBe(true);
    expect(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil"")"`)), 'formula-safe cells').toBe(true);
    const au = await db.auditLog.findFirst({where: {action: 'export.completed', recordId: small.id}});
    const meta = au?.meta as {rows?: number; filters?: {tag?: string}; columns?: string[]} | undefined;
    expect([String(meta?.rows), meta?.filters?.tag, meta?.columns?.includes(L('Tier'))], 'export audited with filters and column labels').toEqual(['3', `imp-${RUN}`, true]);

    // Round trip: the export imports back and matches by Record ID.
    const back = await runImport(owner, 'contact', 'roundtrip.csv', smallCsv.text, {start: false});
    expect(back.up.import.mapping[0]).toBe('id');
    expect([back.checked.import.preview.update + back.checked.import.preview.skip, back.checked.import.preview.create], 'an export imports back onto the same records').toEqual([3, 0]);

    const listExp = must<{export: Exp}>(await owner.post('/exports', {entity: 'contact', listId: list.id, columns: ['email']}), 'list export').export;
    expect([listExp.total, listExp.fileName.startsWith(`imported-${RUN}`)], 'list members export').toEqual([2, true]);
    const vExp = await viewer.post('/exports', {entity: 'company', filters: {q: RUN}, columns: ['name', 'domain']});
    expect([vExp.status, (vExp.json.export as Exp | undefined)?.status], 'viewers can export what they see').toEqual([201, 'done']);
    const dealExp = must<{export: Exp}>(await owner.post('/exports', {entity: 'deal', filters: {pipelineId: pipe.id, status: 'ALL', q: RUN}, columns: ['title', 'value', 'stage', 'status', 'contacts', 'expectedCloseDate']}), 'deal export').export;
    const dealCsv = (await download(owner, dealExp.downloadUrl!)).text;
    expect(dealExp.total).toBe(3);
    expect(dealCsv, 'deal export with filters, contacts and date').toContain(`Renewal ${RUN},12500,${pipe.stages[2]!.name},Open,${annEmail},2026-12-01`);
  });

  it('a big export runs as a job, is emailed with a signed link, notified, private, and expires', async () => {
    // More rows than are written during the request (DIRECT_EXPORT_ROWS, 2,000): the imported ones plus inserted ones.
    const extra = 2_100;
    await db.contact.createMany({data: Array.from({length: extra}, (_, i) => ({firstName: `E${i}`, email: `extra-${RUN}-${i}@bulk-${RUN}.test`, tags: [bigTag]}))});
    const total = BIG + extra;
    const mailBefore = mail.length;
    const bigExp = must<{export: Exp}>(await owner.post('/exports', {entity: 'contact', filters: {tag: bigTag}, columns: ['id', 'firstName', 'email', 'company', 'owner', 'createdAt']}), 'big export').export;
    expect([bigExp.status, bigExp.total, bigExp.emailMe], 'big export runs as a job and is always emailed').toEqual(['queued', total, true]);
    const be = await settle(async () => must<{export: Exp}>(await owner.get(`/exports/${bigExp.id}`), 'export poll').export, ['done', 'failed']);
    expect([be.status, be.processed, be.emailed], 'big export done and emailed').toEqual(['done', total, true]);
    const bigFile = await download(owner, be.downloadUrl!);
    expect(bigFile.text.split('\r\n'), 'the stored file downloads whole').toHaveLength(total + 1);
    expect((await db.file.findUniqueOrThrow({where: {id: be.fileId!}})).size, 'its size is the bytes stored').toBe(new TextEncoder().encode(bigFile.text).byteLength);

    const exportMail = mail.slice(mailBefore).find((m) => m.to.includes(OWNER_EMAIL) && /Your export of .* is ready/.test(m.text));
    const link = exportMail?.text.match(/https?:\/\/\S+\/site-api\/crm\/public\/files\/\S+/)?.[0];
    expect(link, 'email carries a signed link').toBeTruthy();
    const signed = new URL(link!);
    exportLink = signed.pathname + signed.search;
    const anon = new Browser(app, '198.51.100.40');
    const viaLink = await anon.get(exportLink);
    expect([302, 303], 'signed link works without signing in').toContain(viaLink.status);
    const linkText = await (await fetch(new URL(viaLink.headers.get('location')!, 'https://shop.example.test'))).text();
    expect(linkText.split('\r\n')).toHaveLength(total + 1);
    const tampered = await anon.get(exportLink.replace(/exp=(\d+)/, (_, n: string) => `exp=${Number(n) + 1}`));
    expect(tampered.status, 'tampered link is refused').toBe(410);
    expect(await db.notification.count({where: {userId: me.id, type: 'export', link: be.downloadUrl!}}), 'notification with the download link').toBe(1);
    expect((await member.browser.get(be.downloadUrl!)).status, "others can't download someone's export").toBe(404);
    const hist = must<{rows: Exp[]}>(await owner.get('/exports?entity=contact'), 'export history').rows;
    expect(hist.some((r) => r.id === be.id && r.downloadUrl), 'recent exports in the drawer').toBe(true);

    // Audit log page data: downloads while the files exist.
    const auditPage = must<{liveFiles: string[]; rows: {action: string; recordId: string}[]}>(await owner.get('/audit?category=export&pageSize=200'), 'audit');
    expect(auditPage.liveFiles, 'audit log knows which files still exist').toEqual(expect.arrayContaining([be.fileId, d1.import.errorFileId]));
    expect(auditPage.rows.some((r) => r.action === 'import.completed') && auditPage.rows.some((r) => r.action === 'export.completed'), 'imports and exports listed under Imports & exports').toBe(true);

    // Expiry: files older than 7 days are pruned (the daily crm-prune); links and audit downloads go away.
    await db.file.updateMany({where: {id: {in: [be.fileId!, d1.import.errorFileId!]}}, data: {createdAt: new Date(Date.now() - 8 * 86_400_000)}});
    await tick(pruneImportExport);
    expect(await db.file.count({where: {id: be.fileId!}}), 'expired export file pruned').toBe(0);
    expect((await anon.get(exportLink)).status, 'link stops working once the file is gone').toBe(404);
    const after = must<{liveFiles: string[]; rows: {recordId: string}[]}>(await owner.get('/audit?category=export&pageSize=200'), 'audit after');
    expect(after.rows.some((r) => r.recordId === be.id), 'audit entry stays').toBe(true);
    expect(after.liveFiles, '…its download disappears').not.toContain(be.fileId);
    expect(must<{rows: Exp[]}>(await owner.get('/exports?entity=contact'), 'history after').rows.find((r) => r.id === be.id)?.downloadUrl, 'history shows it expired').toBeNull();
  });

  it('the old synchronous endpoints are gone', async () => {
    expect((await owner.post('/import/contacts', {rows: []})).status).toBe(404);
    expect((await owner.get('/export/contacts.csv')).status).toBe(404);
  });
});
