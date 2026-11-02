import {uploadFile} from '@/lib/upload';

/** Uploads an image for an email (purpose "public") and returns its permanent URL. */
export async function uploadEmailImage(file: File) {
  const {url} = await uploadFile<{url: string}>('/files/public', file);
  return url;
}
