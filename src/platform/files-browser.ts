/**
 * File storage, the BROWSER's half (`docs/agent/files.md`): PUT a picked file to the upload URL
 * your route got from `createUpload()` (`src/platform/files.ts`, server only). No secrets here:
 * the URL is a one-time path on this site's own address.
 */

export type FileVisibility = 'private' | 'public';

export interface StoredFile {
  /** `file_…`: keep this in your own table. */
  id: string;
  name: string;
  contentType: string;
  size: number;
  visibility: FileVisibility;
  status: 'pending' | 'ready';
  environment: 'production' | 'staging';
  createdAt: string;
  completedAt: string | null;
}

export interface UploadGrant {
  file: StoredFile;
  upload: {method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string};
}

export type FileResult<T> =
  | {ok: true; data: T}
  | {ok: false; status: number; code: string; message: string};

/**
 * PUT the picked `File` to the grant's URL. Resolves to the stored file (`ready`) or an error with
 * a message for people; shows nothing itself. Pass an AbortSignal to let people cancel.
 */
export async function putFile(
  upload: UploadGrant['upload'],
  file: Blob,
  {signal}: {signal?: AbortSignal} = {}
): Promise<FileResult<StoredFile>> {
  let res: Response;
  try {
    res = await fetch(upload.url, {method: 'PUT', headers: upload.headers, body: file, signal});
  } catch {
    return {ok: false, status: 0, code: 'E_UPLOAD_FAILED', message: 'The upload stopped. Try again.'};
  }
  const answer = (await res.json().catch(() => null)) as
    | {data?: {file: StoredFile}; errors?: Array<{code?: string; message?: string}>}
    | null;
  if (res.ok && answer?.data?.file) return {ok: true, data: answer.data.file};
  const error = answer?.errors?.[0];
  return {
    ok: false,
    status: res.status,
    code: error?.code ?? `HTTP_${res.status}`,
    message: error?.message ?? 'The upload did not work. Try again.',
  };
}
