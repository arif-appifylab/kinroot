---
title: File storage: uploads, private files and links
read-when: before anything that stores a file a person picks (photos, documents, attachments, avatars, audio, video) or shows one back
---
The platform stores this site's files: photos, PDFs, documents, audio and video that visitors or
staff upload. Nothing to install, no bucket, key or secret to ask for. Storage is an add-on the
owner adds in the dashboard (the app's Storage tab: a storage pack, then "Turn on"); without a pack
calls answer `E_STORAGE_NEEDS_PACK`, while it is off `E_STORAGE_OFF`. Files count against the
storage the owner has (their packs); at that limit uploads stop with `E_STORAGE_LIMIT`.

Not for: the site's own images (commit them in `src/assets/`), blog covers (Markdown), or data
(use the Site Database: store the FILE ID there, never the bytes).

## How an upload works (three steps, one file each)
```
browser ──1. POST /site-api/uploads {name,type,size}──► your route ──createUpload()──► platform
browser ◄──────────── {fileId, upload} ──────────────── your route   (checks: on, type, size, room)
browser ──2. putFile(upload, file) ── PUT upload.url (a path on THIS site) ──► platform stores it
browser ──3. POST /site-api/uploads/:id/complete ─────► your route ──completeUpload()──► ready
```
- Step 1 and 3 run in YOUR Site API route, server side: they carry the Site Key
  (`{{SITE_KEY_ENV}}`), which never goes to the browser.
- Step 2 is the browser: `upload.url` is a one-time path on this site's own address, valid
  15 minutes, exactly the size asked for. The bytes never pass through `/site-api` (its 64 KB body
  limit stays) and need no CSP change.
- Step 3 confirms before your own table points at the file.

| Helper | Where | Use |
| --- | --- | --- |
| `createUpload`, `completeUpload`, `fileUrl`, `deleteFile`, `getFile`, `listFiles`, `storageUsage`, `publicFileUrl` | `src/platform/files.ts` | server code (routes, pages) |
| `putFile` | `src/platform/files-browser.ts` | the browser (portal, page script) |
Both are MANAGED: never edit them. Every server helper resolves to `{ok: true, data}` or
`{ok: false, status, code, message}`: show `message` to people, branch on `code`.

## Private or public (decide per kind of file)
| The file is… | `visibility` | Show it with |
| --- | --- | --- |
| Personal or business documents: IDs, CVs, invoices, medical forms, anything for some people only | `private` (default) | a short-lived link from YOUR route, after your permission check |
| Meant for everyone: product photos, a menu PDF, a team photo, a public podcast episode | `public` | `publicFileUrl(file)`: a stable link on this site, no call needed |
When unsure, private. A public file's link works for anyone who has it.

## Recipe: attachments a signed-in person uploads
A table owns the files (who uploaded what, for which record). `prisma/schema.prisma`
(`database.md`: migration, `npx prisma generate`):
```prisma
model Attachment {
  id          Int      @id @default(autoincrement())
  fileId      String   @unique @map("file_id") @db.VarChar(32)
  ownerId     Int      @map("owner_id")
  name        String   @db.VarChar(200)
  contentType String   @map("content_type") @db.VarChar(127)
  size        Int
  ready       Boolean  @default(false)
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([ownerId, id])
  @@map("attachments")
}
```
The route (`src/server/routes/uploads.ts`, then `.route('/uploads', uploadRoutes)` in `app.ts`):
```ts
import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {ALLOWED_FILE_TYPES, MAX_FILE_BYTES, completeUpload, createUpload, deleteFile, fileUrl} from '../../platform/files';

const uploadBody = validator('json', (value, c) => {
  const v = (value ?? {}) as {name?: unknown; contentType?: unknown; size?: unknown};
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 200) : '';
  const contentType = typeof v.contentType === 'string' ? v.contentType : '';
  const size = typeof v.size === 'number' ? v.size : 0;
  if (!name || !(ALLOWED_FILE_TYPES as readonly string[]).includes(contentType) || size < 1 || size > MAX_FILE_BYTES) {
    return c.json(problem('invalid_input', 'Pick an image, PDF or document up to 100 MB.'), 422);
  }
  return {name, contentType, size};
});

export const uploadRoutes = new Hono()
  // 1. ask for an upload URL
  .post('/', uploadBody, withViewer, requireAuth, withDb, async c => {
    const input = c.req.valid('json');
    const grant = await createUpload(c.req.url, input); // private by default
    if (!grant.ok) return c.json(problem(grant.code, grant.message), grant.status === 402 ? 402 : 400);
    await c.var.db.attachment.create({
      data: {fileId: grant.data.file.id, ownerId: c.var.viewer.id!, ...input},
    });
    return c.json({fileId: grant.data.file.id, upload: grant.data.upload}, 201);
  })
  // 3. confirm after the browser's PUT
  .post('/:fileId/complete', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const mine = await c.var.db.attachment.findFirst({where: {fileId, ownerId: c.var.viewer.id!}, select: {id: true}});
    if (!mine) return c.json(problem('not_found', 'No such file.'), 404);
    const done = await completeUpload(c.req.url, fileId);
    if (!done.ok) return c.json(problem(done.code, done.message), 400);
    await c.var.db.attachment.update({where: {id: mine.id}, data: {ready: true}});
    return c.json({ok: true});
  })
  // show / download: check access, then redirect to a 5-minute link
  .get('/:fileId/view', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const mine = await c.var.db.attachment.findFirst({where: {fileId, ownerId: c.var.viewer.id!, ready: true}, select: {id: true}});
    if (!mine) return c.json(problem('not_found', 'No such file.'), 404);
    const link = await fileUrl(c.req.url, fileId, {expiresIn: 300, download: c.req.query('download') === '1'});
    if (!link.ok) return c.json(problem(link.code, link.message), 400);
    c.header('Cache-Control', 'private, no-store');
    return c.redirect(link.data.url, 302);
  })
  .delete('/:fileId', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const {count} = await c.var.db.attachment.deleteMany({where: {fileId, ownerId: c.var.viewer.id!}});
    if (!count) return c.json(problem('not_found', 'No such file.'), 404);
    await deleteFile(c.req.url, fileId);
    return c.json({ok: true});
  });
```
Staff who see other people's files: gate with `requirePermission(PERMISSIONS.X)` instead of the
`ownerId` filter (`roles-and-permissions.md`). Never trust a file id from the browser without
looking it up in YOUR table first.

The browser (portal screen or page script):
```ts
import {putFile} from '../../platform/files-browser'; // portal: from '../platform/files-browser'

async function upload(file: File) {
  const res = await siteFetch('/site-api/uploads', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({name: file.name, contentType: file.type, size: file.size}),
  });
  const body = await res.json();
  if (!res.ok) return showError(body.message);           // E_STORAGE_LIMIT, wrong type…
  const put = await putFile(body.upload, file);          // the bytes, straight to storage
  if (!put.ok) return showError(put.message);
  await siteFetch(`/site-api/uploads/${body.fileId}/complete`, {method: 'POST'});
}
```
- Check type and size in the browser first (same rules as the server) and say what is allowed
  before the upload starts. Show progress state on the button (`Uploading…`, disabled).
- `<input type="file" accept="image/*,application/pdf">` narrows the picker; it is not a check.
- Show a private file with `<img src="/site-api/uploads/<fileId>/view">` or a link with
  `?download=1`: every view checks access and gets a fresh short link.

## Public files (no route needed to show them)
`createUpload(c.req.url, {..., visibility: 'public'})`, then link `publicFileUrl(file)`
(`/__platform/files/<id>/<name>` on this site; it redirects to storage). Use it for images on
public pages. Still keep the file id in your table, and still delete through your route.

## Limits and errors
- One file: 1 byte to 100 MB. Types: images (PNG, JPEG, WebP, GIF, AVIF, SVG), PDF, plain text,
  CSV, JSON, ZIP, audio (MP3, WAV, OGG, M4A), video (MP4, WebM, MOV), Word, Excel, PowerPoint.
  Never HTML or JavaScript. SVG and documents always download; images, PDF, audio, video show.
- An upload URL works once, for 15 minutes. A file not completed within 1 hour is removed.
- Links from `fileUrl()` last `expiresIn` seconds (60 to 604800, default 3600). Make them per
  view; never save a link in the database.
- `storageUsage(c.req.url)` gives used and limit for the whole account (all its apps): show "space
  left" before a big upload.
- Live and the Preview keep separate files (the Preview's are staging). The editor key works.

| `code` | Means | Do |
| --- | --- | --- |
| `E_STORAGE_NEEDS_PACK` (402) | the owner has no storage pack | tell the owner: add storage in the app's Storage tab |
| `E_STORAGE_OFF` | the owner hasn't turned Storage on for this app | tell the owner: the app's Storage tab |
| `E_STORAGE_UNAVAILABLE` | this account has no storage | tell the owner |
| `E_STORAGE_LIMIT` (402) | the file doesn't fit in the storage left | say so; the owner deletes files or adds a bigger pack |
| `E_FILE_TYPE`, `E_FILE_EMPTY`, `E_FILE_TOO_LARGE` | not allowed, 0 bytes, over 100 MB | say what is allowed |
| `E_BODY_TOO_LARGE` (413, at the PUT) | more bytes than `size` | send the real size |
| `E_FILE_SIZE_MISMATCH` | fewer bytes than `size`; nothing kept | ask for a new upload |
| `E_UPLOAD_TOKEN`, `E_UPLOAD_EXPIRED` | the upload URL was used or is too old | ask for a new upload |
| `E_FILE_NOT_UPLOADED` | complete before the PUT finished | PUT first |
| `E_FILE_NOT_FOUND`, `E_FILE_NOT_READY` | wrong id, or not completed | check your table |

## Never
- Send `{{SITE_KEY_ENV}}` (or any platform call) from the browser; the browser only calls
  `/site-api/*` and `upload.url`.
- Store file bytes in the database, in `public/`, or as base64 in JSON.
- Build a storage link yourself, or save a `fileUrl()` link: links expire.
- Accept a file id from the browser without checking it is in YOUR table and theirs to see.
- Make personal documents `public`.
- Proxy file bytes through `/site-api` (body limit 64 KB, Worker memory 128 MB).
