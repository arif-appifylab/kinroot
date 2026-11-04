import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Import} from '../../../generated/prisma/client';
import {IO_ENTITIES, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, NEW_OPTION, defaultImportOptions, guessMapping, importTargets, isActive, type ImportRun, type IoEntity} from '@/lib/import-export';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, requireRole, type AppEnv, type AppContext} from '../kit/guards';
import {audit} from '../lib/audit';
import {parseCsv} from '../lib/csv';
import {addNewOptions, errorCsv, queuePhase} from '../lib/imports';
import {notFound, valid} from '../lib/http';
import {purgeFiles, readBytes} from '../kit/storage';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';
import {strings, withStrings} from '../lib/json-list';

const entity = z.enum(['contact', 'company', 'deal']);

const optionsSchema = z.object({
  mode: z.enum(['create', 'update', 'upsert']),
  skipBlanks: z.boolean(),
  dateOrder: z.enum(['mdy', 'dmy']),
  listId: z.string().nullable(),
  tag: z.string().trim().max(40).nullable(),
  defaultOwner: z.string().nullable(),
  createCompanies: z.boolean(),
  pipelineId: z.string().nullable(),
  emailMe: z.boolean(),
  valueMap: z.record(z.string(), z.record(z.string(), z.string().max(80))),
});

/** What the drawer gets: no job token, plus whether the files are still there. */
function importJson(imp: Import): ImportRun {
  const {token: _t, ...rest} = imp;
  const stats = {...(imp.stats as Record<string, unknown>)};
  delete stats.origin;
  for (const k of Object.keys(stats)) if (k.startsWith('owner:')) delete stats[k];
  return {...JSON.parse(JSON.stringify(rest)), stats, hasFile: !!imp.fileId, hasErrorFile: !!imp.errorFileId};
}

async function mine(c: AppContext) {
  const imp = await c.var.db.import.findUnique({where: {id: c.req.param('id')}});
  const me = currentUser(c);
  if (!imp || (imp.userId !== me.id && !isAdmin(me))) throw notFound('Import');
  return imp;
}

/** CSV imports from the list pages. Members and up; viewers are read-only. */
export const imports = new Hono<AppEnv>()
  .use('*', requireRole('MEMBER'))

  // The person's recent imports (the drawer's history).
  .get('/', valid('query', z.object({entity: entity.optional()})), async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.import.findMany({where: {userId: me.id, status: {not: 'draft'}, ...(c.req.valid('query').entity ? {entity: c.req.valid('query').entity} : {})}, orderBy: {createdAt: 'desc'}, take: 10});
    return c.json({rows: rows.map(importJson)});
  })

  /** A CSV to import (upload step 1; lib/uploads.ts). Up to 10 MB; read and checked once stored. */
  .post('/', valid('json', uploadBody), async (c) => {
    const me = currentUser(c);
    const body = c.req.valid('json');
    if (!body.size) throw new HTTPException(400, {message: 'Choose a CSV file'});
    // Browsers name CSV types differently; the content is what is checked (step 3).
    const checked = checkUpload({...body, contentType: 'text/csv'}, {maxBytes: MAX_IMPORT_BYTES, tooBig: 'CSV files can be up to 10 MB. Split the file and import the parts.', empty: 'Choose a CSV file'});
    const {file, upload} = await startUpload(c.var.db, checked, {purpose: 'import', uploadedById: me.id});
    return c.json({fileId: file.id, upload}, 201);
  })

  /** Upload step 3 with the entity, optional delimiter and listId: reads the stored CSV and guesses the mapping. */
  .post('/:fileId/complete', valid('json', z.object({entity, delimiter: z.string().max(2).nullish(), listId: z.string().max(40).nullish()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const form = c.req.valid('json');
    const file = await completeUpload(db, {id: c.req.param('fileId'), purpose: 'import', uploadedById: me.id});
    const refuse = async (status: 400 | 413, message: string) => {
      await purgeFiles(db, {id: file.id});
      throw new HTTPException(status, {message});
    };
    const parsed = parseCsv(await readBytes(file), form.delimiter && [',', ';', '\t', '|'].includes(form.delimiter) ? form.delimiter : undefined);
    if (!parsed.headers.some(Boolean)) return refuse(400, 'The first row should hold the column names');
    if (!parsed.rows.length) return refuse(400, 'The file has a header but no rows');
    if (parsed.rows.length > MAX_IMPORT_ROWS) return refuse(413, `Up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows per import. Split the file and import the parts.`);
    const defs = (await db.customFieldDef.findMany({where: {entity: IO_ENTITIES[form.entity].fieldEntity}})).map((d) => withStrings(d, 'options'));
    const listId = form.listId || null;
    const imp = await db.import.create({
      data: {
        entity: form.entity,
        fileName: file.name,
        fileId: file.id,
        userId: me.id,
        headers: parsed.headers,
        delimiter: parsed.delimiter,
        total: parsed.rows.length,
        mapping: guessMapping(form.entity, parsed.headers, defs),
        options: {...defaultImportOptions(), listId: form.entity === 'contact' ? listId : null},
      },
    });
    return c.json({import: importJson(imp), sample: parsed.rows.slice(0, 5), badEncoding: parsed.badEncoding}, 201);
  })

  .get('/:id', async (c) => {
    const imp = await mine(c);
    const phase = ['draft', 'validating', 'ready'].includes(imp.status) ? 'validate' : 'run';
    const [issues, issueCount] = await Promise.all([
      c.var.db.importIssue.findMany({where: {importId: imp.id, phase}, orderBy: [{row: 'asc'}, {level: 'asc'}], take: 200}),
      c.var.db.importIssue.count({where: {importId: imp.id, phase}}),
    ]);
    return c.json({import: importJson(imp), issues, issueCount});
  })

  // Saves the mapping and options and starts the dry run.
  .post('/:id/validate', valid('json', z.object({mapping: z.array(z.string().nullable()).max(500), options: optionsSchema})), async (c) => {
    const db = c.var.db;
    const imp = await mine(c);
    if (!['draft', 'ready', 'validating'].includes(imp.status)) throw new HTTPException(400, {message: 'This import has already run'});
    const {mapping, options} = c.req.valid('json');
    const kind = imp.entity as IoEntity;
    if (mapping.length !== strings(imp.headers).length) throw new HTTPException(400, {message: 'Map every column (or skip it)'});
    const defs = (await db.customFieldDef.findMany({where: {entity: IO_ENTITIES[kind].fieldEntity}})).map((d) => withStrings(d, 'options'));
    const targets = new Map(importTargets(kind, defs).map((t) => [t.key, t]));
    const used = mapping.filter((m): m is string => !!m);
    for (const key of used) if (!targets.has(key)) throw new HTTPException(400, {message: `Unknown field "${key}"`});
    const twice = used.find((k, i) => used.indexOf(k) !== i);
    if (twice) throw new HTTPException(400, {message: `Two columns go to ${targets.get(twice)!.label}; pick one`});
    const need = {contact: ['firstName', 'fullName', 'email'], company: ['name', 'domain', 'website'], deal: ['title']}[kind];
    const hasId = used.includes('id') && options.mode === 'update';
    if (!hasId && !need.some((k) => used.includes(k))) throw new HTTPException(400, {message: kind === 'contact' ? 'Map a name or email column' : kind === 'company' ? 'Map a name or domain column' : 'Map the deal name column'});
    if (options.listId) {
      const list = await db.contactList.findUnique({where: {id: options.listId}, select: {kind: true}});
      if (!list || list.kind !== 'STATIC') throw new HTTPException(400, {message: 'Pick a static list (segments fill themselves)'});
    }
    if (options.pipelineId && !(await db.pipeline.findUnique({where: {id: options.pipelineId}}))) throw new HTTPException(400, {message: 'That pipeline no longer exists'});
    const addsOptions = Object.values(options.valueMap).some((m) => Object.values(m).some((v) => v.startsWith(NEW_OPTION)));
    if (addsOptions && !isAdmin(currentUser(c))) throw new HTTPException(403, {message: 'Only admins can add new options to a field; map the values to existing options or skip them'});
    await db.import.update({where: {id: imp.id}, data: {mapping, options}});
    await queuePhase(db, imp.id, 'validate', publicOrigin(c.req.raw));
    return c.json({import: importJson(await db.import.findUniqueOrThrow({where: {id: imp.id}}))});
  })

  // Runs the import as validated.
  .post('/:id/start', async (c) => {
    const db = c.var.db;
    const imp = await mine(c);
    if (imp.status !== 'ready') throw new HTTPException(400, {message: imp.status === 'validating' ? 'Wait for the check to finish' : 'Check the file first'});
    const options = imp.options as unknown as z.infer<typeof optionsSchema>;
    const added = await addNewOptions(db, imp.entity as IoEntity, imp.mapping as (string | null)[], options);
    for (const a of added) await audit(db, c, {action: 'custom_field.updated', entity: 'custom_field', recordId: a.id, label: a.label, meta: {addedOptions: a.options, via: 'import', importId: imp.id}});
    await queuePhase(db, imp.id, 'run', publicOrigin(c.req.raw));
    return c.json({import: importJson(await db.import.findUniqueOrThrow({where: {id: imp.id}}))});
  })

  .post('/:id/cancel', async (c) => {
    const db = c.var.db;
    const imp = await mine(c);
    if (imp.status === 'validating') await db.import.update({where: {id: imp.id}, data: {status: 'draft', token: null}});
    else if (imp.status === 'queued') {
      await db.import.update({where: {id: imp.id}, data: {status: 'canceled', token: null, finishedAt: new Date()}});
      await audit(db, c, {action: 'import.canceled', category: 'export', entity: 'import', recordId: imp.id, label: imp.fileName, meta: {object: IO_ENTITIES[imp.entity as IoEntity].many, rows: imp.total}});
    } else if (imp.status === 'running') await db.import.update({where: {id: imp.id}, data: {status: 'canceled'}}); // the running batch finishes, then the job stops and logs it
    else throw new HTTPException(400, {message: 'Nothing to cancel'});
    return c.json({import: importJson(await db.import.findUniqueOrThrow({where: {id: imp.id}}))});
  })

  // Rows with errors (dry run or run), as the original columns plus the reason.
  .get('/:id/errors.csv', valid('query', z.object({phase: z.enum(['validate', 'run']).default('validate')})), async (c) => {
    const imp = await mine(c);
    const body = await errorCsv(c.var.db, imp, c.req.valid('query').phase);
    if (!body) throw new HTTPException(404, {message: 'No rows with errors'});
    return new Response(body, {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(imp.fileName.replace(/\.csv$/i, '') + '-errors.csv')}`}});
  });
