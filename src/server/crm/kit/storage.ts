import type {File as FileRow, Prisma} from '../../../generated/prisma/client';
import {config as site} from '../../../platform/config';
import {completeUpload, createUpload, deleteFile, fileUrl, forwardPlatformFiles, publicFileUrl} from '../../../platform/files';
import type {Db} from './db';

/**
 * Kinroot's files in the PLATFORM's storage (docs/agent/files.md). Kinroot keeps its `File` table
 * (who uploaded what, for which record, its `purpose`) and refers to files by that row's id as
 * before; the bytes live in storage, `File.storageId` is the platform's `file_…` id.
 *
 * Browser uploads take three steps: `beginUpload` (a row, not ready, and a one-time upload URL),
 * the browser's PUT (`src/crm/lib/upload.ts`), then `finishUpload` (confirmed, ready). Files the
 * server makes itself (import error rows, exports) go through `storeBytes`. Showing a file is a
 * redirect to a short-lived link, made per view after the route's access check (`redirectTo`).
 */

/** Purposes whose files anyone may load by link (email images, avatars). Everything else is private. */
const PUBLIC_PURPOSES = new Set(['public']);

const origin = () => site.siteUrl ?? 'http://localhost';

/** A storage refusal, in words for people (no storage pack, full, wrong type…). */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const refuse = (r: {code: string; message: string; status: number}): never => {
  const message =
    r.code === 'E_STORAGE_NEEDS_PACK' || r.code === 'E_STORAGE_OFF' || r.code === 'E_STORAGE_UNAVAILABLE'
      ? 'File storage is not turned on for this site yet. The site owner can turn it on in the app’s Storage tab.'
      : r.message;
  throw new StorageError(message, r.code, r.status === 402 ? 402 : r.status >= 500 || r.status === 0 ? 503 : 400);
};

type NewFile = Omit<Prisma.FileUncheckedCreateInput, 'id' | 'storageId' | 'ready' | 'createdAt'>;

/** Step 1: a `File` row (not ready) and the one-time URL the browser PUTs the bytes to. */
export async function beginUpload(db: Db, input: NewFile) {
  const grant = await createUpload(origin(), {
    name: input.name,
    contentType: input.mimeType,
    size: input.size,
    visibility: PUBLIC_PURPOSES.has(input.purpose ?? 'attachment') ? 'public' : 'private',
  });
  if (!grant.ok) return refuse(grant);
  const file = await db.file.create({data: {...input, storageId: grant.data.file.id, ready: false}});
  return {file, upload: grant.data.upload};
}

/** Step 3: after the browser's PUT. `where` scopes which pending row the caller may confirm. */
export async function finishUpload(db: Db, where: Prisma.FileWhereInput & {id: string}) {
  const file = await db.file.findFirst({where: {...where, ready: false, storageId: {not: null}}});
  if (!file) return null;
  const done = await completeUpload(origin(), file.storageId!);
  if (!done.ok) return refuse(done);
  return db.file.update({where: {id: file.id}, data: {ready: true, size: done.data.size}});
}

/** A file the server made itself (import error rows, exports): stored and ready in one go. */
export async function storeBytes(db: Db, input: Omit<NewFile, 'size'>, bytes: Uint8Array) {
  return storeStream(db, input, new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), bytes.byteLength);
}

/** The same for a stream of exactly `size` bytes (big exports, read from the database as they go). */
export async function storeStream(db: Db, input: Omit<NewFile, 'size'>, body: ReadableStream<Uint8Array>, size: number) {
  const grant = await createUpload(origin(), {
    name: input.name,
    contentType: input.mimeType,
    size,
    visibility: PUBLIC_PURPOSES.has(input.purpose ?? 'attachment') ? 'public' : 'private',
  });
  if (!grant.ok) return refuse(grant);
  const {upload} = grant.data;
  // The browser's PUT, made in-process: the template's own forwarder sends it to the platform.
  const url = new URL(upload.url, origin());
  const headers = new Headers(upload.headers);
  headers.set('content-length', String(size));
  const put = await forwardPlatformFiles(new Request(url, {method: 'PUT', headers, body, duplex: 'half'} as RequestInit), url);
  if (!put.ok) return refuse({code: `HTTP_${put.status}`, message: 'Storage did not take the file. Try again.', status: put.status});
  const done = await completeUpload(origin(), grant.data.file.id);
  if (!done.ok) return refuse(done);
  return db.file.create({data: {...input, size, storageId: grant.data.file.id, ready: true}});
}

/** A fresh short-lived link to a ready file, for a redirect after the caller's access check. */
export async function linkTo(file: Pick<FileRow, 'storageId' | 'ready'>, opts: {download?: boolean; seconds?: number} = {}) {
  if (!file.storageId || !file.ready) return null;
  const link = await fileUrl(origin(), file.storageId, {expiresIn: opts.seconds ?? 300, download: !!opts.download});
  return link.ok ? link.data.url : null;
}

/** The permanent link of a public file (email images, avatars), on this site's address. */
export function publicLink(file: Pick<FileRow, 'storageId' | 'name'>) {
  return file.storageId ? `${origin()}${publicFileUrl({id: file.storageId, name: file.name})}` : null;
}

/** A file's bytes, server side (parsing an uploaded CSV). Bounded by the upload limits of its purpose. */
export async function readBytes(file: Pick<FileRow, 'storageId' | 'ready'>): Promise<Uint8Array> {
  const url = await linkTo(file, {seconds: 120});
  if (!url) throw new StorageError('That file is not available.', 'E_FILE_NOT_READY', 404);
  const res = await fetch(new URL(url, origin()), {signal: AbortSignal.timeout(20_000)});
  if (!res.ok) throw new StorageError('Storage did not return the file. Try again.', `HTTP_${res.status}`, 503);
  return new Uint8Array(await res.arrayBuffer());
}

/** Stored bytes deleted at the same time, per round (outside calls, each with the platform's timeout). */
const DELETE_PARALLEL = 10;

/**
 * Deletes rows AND their stored bytes, bounded (200 a call; prune jobs come back for the rest).
 * A row goes only once its bytes are gone (deleted now, or already missing: 404): when storage
 * refuses or doesn't answer, the row stays, so the next run can try again and the bytes are never
 * orphaned without a row pointing at them. Use it wherever Kinroot deleted `File` rows directly.
 */
export async function purgeFileRows(db: Db, where: Prisma.FileWhereInput): Promise<{removed: string[]; failed: string[]}> {
  const rows = await db.file.findMany({where, select: {id: true, storageId: true}, take: 200});
  const removed: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < rows.length; i += DELETE_PARALLEL) {
    const part = rows.slice(i, i + DELETE_PARALLEL);
    const gone = await Promise.all(
      part.map(async (r) => {
        if (!r.storageId) return true;
        const res = await deleteFile(origin(), r.storageId).catch(() => null);
        return !!res && (res.ok || res.status === 404);
      }),
    );
    part.forEach((r, k) => (gone[k] ? removed : failed).push(r.id));
  }
  if (removed.length) await db.file.deleteMany({where: {id: {in: removed}}});
  if (failed.length) console.error(`[storage] ${failed.length} stored file(s) could not be deleted; their rows stay for the next try`);
  return {removed, failed};
}

/** purgeFileRows(), answering how many rows (and their bytes) went. */
export async function purgeFiles(db: Db, where: Prisma.FileWhereInput) {
  return (await purgeFileRows(db, where)).removed.length;
}
