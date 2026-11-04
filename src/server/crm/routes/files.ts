import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {CRM_API, publicOrigin} from '../kit/config';
import {sign, verifySignature} from '../kit/crypto';
import type {Prisma} from '../../../generated/prisma/client';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {linkTo, publicLink, purgeFiles} from '../kit/storage';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {audit} from '../lib/audit';
import {assertVisible, attachedWhere, notFound, ownerScope, valid} from '../lib/http';
import {checkUpload, completeUpload, MAX_FILE_BYTES, startUpload, uploadBody} from '../lib/uploads';
import {userSelect} from '../lib/users';

export {MAX_FILE_BYTES};

/** Files only their uploader (or an admin) may open: CSV imports, their error rows and exports. */
const PRIVATE_PURPOSES = new Set(['import', 'import_errors', 'export']);

const meta = {id: true, name: true, mimeType: true, size: true, purpose: true, contactId: true, companyId: true, dealId: true, createdAt: true, uploadedBy: {select: userSelect}} as const;

/** Images for emails (signatures, logos): purpose "public", served forever without signing in. */
export const EMAIL_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_EMAIL_IMAGE = 2 * 1024 * 1024;

/** Signed link that works without signing in, until `expires` (unix seconds). Each visit gets a fresh storage link. */
export async function publicFileUrl(origin: string, fileId: string, days = 7) {
  const exp = Math.floor(Date.now() / 1000) + days * 86_400;
  return `${origin}${CRM_API}/public/files/${fileId}?exp=${exp}&sig=${await sign(`file:${fileId}:${exp}`)}`;
}

/** No caching of a redirect to a short-lived storage link. */
const redirect = (url: string) => new Response(null, {status: 302, headers: {location: url, 'cache-control': 'private, no-store'}});

const link = z.object({contactId: z.string().max(40).nullish(), companyId: z.string().max(40).nullish(), dealId: z.string().max(40).nullish()});

/**
 * With owner-only visibility: attachments and form uploads only on records the user may see.
 * Ticket and chat files follow their conversation's access, checked where they are listed.
 * (Built only when scoped: Prisma ignores an empty `{}` inside an OR.)
 */
async function recordFileScope(c: AppContext): Promise<Prisma.FileWhereInput> {
  const scope = await ownerScope(c);
  return scope.ownerId ? {OR: [{purpose: {notIn: ['attachment', 'form']}}, attachedWhere(scope)]} : {};
}

/**
 * A file the signed-in user may open, else null: never a trashed or unfinished one; import and
 * export files only for their uploader or an admin; attachments and form uploads only on records
 * the user may see (owner-only visibility).
 */
async function openableFile(c: AppContext, id: string) {
  const me = currentUser(c);
  const file = await c.var.db.file.findFirst({where: {id, ...(await recordFileScope(c))}});
  if (!file || file.purpose === 'trash' || !file.ready) return null;
  // Import and export files hold whole tables: only the person who made them, or an admin.
  if (PRIVATE_PURPOSES.has(file.purpose) && file.uploadedById !== me.id && !isAdmin(me)) return null;
  return file;
}

export const files = new Hono<AppEnv>()
  .get('/', valid('query', z.object({contactId: z.string().max(40).optional(), companyId: z.string().max(40).optional(), dealId: z.string().max(40).optional()})), async (c) => {
    const q = c.req.valid('query');
    const or = [q.contactId && {contactId: q.contactId}, q.companyId && {companyId: q.companyId}, q.dealId && {dealId: q.dealId}].filter((x) => !!x);
    if (!or.length) throw new HTTPException(400, {message: 'Pass a contactId, companyId or dealId'});
    await assertVisible(c, q);
    const rows = await c.var.db.file.findMany({where: {OR: or, purpose: 'attachment', ready: true}, select: meta, orderBy: {createdAt: 'desc'}, take: 500});
    return c.json({rows});
  })

  /** An attachment for a contact, company or deal (upload step 1; lib/uploads.ts). */
  .post('/', valid('json', uploadBody.extend(link.shape)), async (c) => {
    const me = currentUser(c);
    const body = c.req.valid('json');
    const target = {contactId: body.contactId || null, companyId: body.companyId || null, dealId: body.dealId || null};
    if (!target.contactId && !target.companyId && !target.dealId) throw new HTTPException(400, {message: 'Attach the file to a contact, company or deal'});
    await assertVisible(c, target);
    const file = checkUpload(body);
    const {file: row, upload} = await startUpload(c.var.db, file, {uploadedById: me.id, ...target});
    return c.json({fileId: row.id, upload}, 201);
  })

  /** Upload step 3: the attachment is stored; it shows on the record and in its timeline. */
  .post('/:fileId/complete', async (c) => {
    const me = currentUser(c);
    const done = await completeUpload(c.var.db, {id: c.req.param('fileId'), uploadedById: me.id, purpose: 'attachment'});
    const file = await c.var.db.file.findUniqueOrThrow({where: {id: done.id}, select: meta});
    const target = {contactId: file.contactId, companyId: file.companyId, dealId: file.dealId};
    await logActivity(c.var.db, {
      type: 'file',
      title: `File added: ${file.name}`,
      refId: file.id,
      actorId: me.id,
      ...target,
      data: {name: file.name, size: file.size, mimeType: file.mimeType},
      text: file.name,
    });
    await emit(c.var.db, 'file.uploaded', {recordId: file.id, actorId: me.id, data: file});
    return c.json({file}, 201);
  })

  /** An image for an email (signature, header logo): stored public, with a permanent URL. */
  .post('/public', valid('json', uploadBody), async (c) => {
    const me = currentUser(c);
    const file = checkUpload(c.req.valid('json'), {
      maxBytes: MAX_EMAIL_IMAGE,
      tooBig: 'Email images can be up to 2 MB',
      accept: (mime) => EMAIL_IMAGES.has(mime),
      wrongType: 'Use a PNG, JPEG, GIF or WebP image (SVG does not show in most mail clients)',
    });
    const {file: row, upload} = await startUpload(c.var.db, file, {purpose: 'public', uploadedById: me.id});
    return c.json({fileId: row.id, upload}, 201);
  })

  .post('/public/:fileId/complete', async (c) => {
    const me = currentUser(c);
    const done = await completeUpload(c.var.db, {id: c.req.param('fileId'), uploadedById: me.id, purpose: 'public'});
    const file = await c.var.db.file.findUniqueOrThrow({where: {id: done.id}, select: meta});
    return c.json({file, url: publicLink(done)}, 201);
  })

  /** Shows (or downloads) a file: the access check, then a 5-minute storage link. */
  .get('/:id', valid('query', z.object({download: z.enum(['1']).optional()})), async (c) => {
    const file = await openableFile(c, c.req.param('id'));
    if (!file) throw notFound('File');
    const url = await linkTo(file, {download: !!c.req.valid('query').download});
    if (!url) throw new HTTPException(503, {message: 'File storage did not answer. Try again.'});
    return redirect(url);
  })

  /** A public link that works without signing in: only for record attachments the user may open (404 otherwise). */
  .post('/:id/link', valid('json', z.object({days: z.number().int().min(1).max(30).default(7)})), async (c) => {
    const file = await openableFile(c, c.req.param('id'));
    if (!file || file.purpose !== 'attachment') throw notFound('File');
    const days = c.req.valid('json').days;
    await audit(c.var.db, c, {action: 'file.share_link', entity: 'file', recordId: file.id, label: file.name, meta: {days, contactId: file.contactId, companyId: file.companyId, dealId: file.dealId}});
    return c.json({url: await publicFileUrl(publicOrigin(c.req.raw), file.id, days), expiresInDays: days});
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    // Only its uploader or an admin, on records they may see: anyone else gets 404.
    const file = await c.var.db.file.findFirst({
      where: {id: c.req.param('id'), ...(await recordFileScope(c)), ...(isAdmin(me) ? {} : {uploadedById: me.id})},
      select: {id: true},
    });
    if (!file) throw notFound('File');
    await purgeFiles(c.var.db, {id: file.id});
    await c.var.db.activity.deleteMany({where: {type: 'file', refId: file.id}});
    return c.json({ok: true});
  });

/** No sign-in: signed, expiring links from POST /files/:id/link, and permanent links for `public` images. */
export const filesPublic = new Hono<AppEnv>()
  .get('/public/files/:id/:filename', async (c) => {
    const file = await c.var.db.file.findUnique({where: {id: c.req.param('id')}});
    if (!file || file.purpose !== 'public' || !file.ready) return c.text('File not found', 404);
    const url = publicLink(file);
    return url ? c.redirect(url, 301) : c.text('File not found', 404);
  })
  .get('/public/files/:id', async (c) => {
    const id = c.req.param('id');
    const exp = Number(c.req.query('exp'));
    const sig = c.req.query('sig') ?? '';
    if (!exp || exp < Date.now() / 1000 || !(await verifySignature(`file:${id}:${exp}`, sig))) {
      return c.text('This link has expired or is not valid.', 410);
    }
    const file = await c.var.db.file.findUnique({where: {id}});
    if (!file || file.purpose === 'trash' || !file.ready) return c.text('File not found', 404);
    const url = await linkTo(file, {download: c.req.query('download') === '1'});
    return url ? redirect(url) : c.text('File storage did not answer. Try again.', 503);
  });
