import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {beginUpload, finishUpload, StorageError} from '../kit/storage';

/**
 * Kinroot's uploads on the platform's storage, in two calls where there used to be one multipart
 * POST (the Site API takes no file bodies: docs/agent/files.md):
 *
 *   POST <route>                       {name, contentType, size, …}  → what the old route answered + {fileId, upload}
 *   (browser)  PUT upload.url                                          the bytes, straight to storage
 *   POST <route>/:fileId/complete                                     → {ok: true} (or the route's own answer)
 *
 * The browser side is `uploadFile()` in src/crm/lib/upload.ts. Limits and types are checked here,
 * before any storage is asked for, with the same words as before.
 */

/** Every Kinroot upload is up to 5 MB, as before. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const uploadBody = z.object({
  name: z.string().trim().max(500).default('file'),
  contentType: z.string().trim().max(100).default(''),
  size: z.number().int().min(0).max(1024 * 1024 * 1024),
});
export type UploadBody = z.infer<typeof uploadBody>;

type Rules = {maxBytes?: number; tooBig?: string; accept?: (mime: string) => boolean; wrongType?: string; empty?: string};

/** The file's name, type and size once they pass this upload's rules (else a 4xx in words). */
export function checkUpload(input: UploadBody, rules: Rules = {}) {
  const maxBytes = rules.maxBytes ?? MAX_FILE_BYTES;
  if (!input.size) throw new HTTPException(400, {message: rules.empty ?? 'That file is empty'});
  if (input.size > maxBytes) throw new HTTPException(413, {message: rules.tooBig ?? 'Files can be up to 5 MB'});
  const mime = (input.contentType || 'application/octet-stream').toLowerCase();
  if (rules.accept && !rules.accept(mime)) throw new HTTPException(415, {message: rules.wrongType ?? 'That type of file can not be uploaded here'});
  return {name: input.name.slice(0, 200) || 'file', mimeType: mime.slice(0, 100), size: input.size};
}

/** Storage refusals (not turned on, full, a type it never takes) as the route's error answer. */
function asHttp(e: unknown): never {
  if (e instanceof StorageError) throw new HTTPException(e.status as 400 | 402 | 503, {message: e.message});
  throw e;
}

/** Step 1 for a route: the pending row and the upload grant. */
export async function startUpload(db: Db, file: ReturnType<typeof checkUpload>, row: Omit<Prisma.FileUncheckedCreateInput, 'name' | 'mimeType' | 'size'>) {
  try {
    return await beginUpload(db, {...file, ...row});
  } catch (e) {
    return asHttp(e);
  }
}

/** Step 3 for a route: confirms the caller's pending file (`where` says whose), or 404. */
export async function completeUpload(db: Db, where: Prisma.FileWhereInput & {id: string}) {
  try {
    const file = await finishUpload(db, where);
    if (!file) throw new HTTPException(404, {message: 'That upload was not found. Upload the file again.'});
    return file;
  } catch (e) {
    return asHttp(e);
  }
}
