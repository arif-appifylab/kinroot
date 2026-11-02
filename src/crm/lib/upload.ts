import {putFile, type UploadGrant} from '../../platform/files-browser';
import {api, ApiError} from './api';

/**
 * Uploads a file the way the site's storage works (docs/agent/files.md): three steps where Kinroot
 * used to send one multipart POST.
 *
 *   1. POST <path>                 {name, contentType, size, …extra} → {fileId, upload, …}
 *   2. PUT upload.url              the bytes, straight to storage (never through the Site API)
 *   3. POST <path>/<fileId>/complete   {…extra} → the route's answer
 *
 * Resolves to step 1's answer merged with step 3's (minus the upload grant), so call sites read
 * the same fields the old single POST returned.
 */
export async function uploadFile<T extends object = Record<string, unknown>>(path: string, file: File, extra: Record<string, unknown> = {}): Promise<T> {
  const start = await api.post<{fileId: string; upload: UploadGrant['upload']} & Record<string, unknown>>(path, {
    name: file.name,
    contentType: file.type,
    size: file.size,
    ...extra,
  });
  const put = await putFile(start.upload, file);
  if (!put.ok) throw new ApiError(put.message, put.status || 502);
  const done = await api.post<Record<string, unknown>>(`${path}/${start.fileId}/complete`, extra);
  const {upload: _upload, ...rest} = start;
  return {...rest, ...done} as T;
}
