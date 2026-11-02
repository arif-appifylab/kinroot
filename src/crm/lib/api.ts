// Browser-side client for the Hono API at /site-api/*.
//
// Every call goes through the template's `siteFetch` (src/platform/browser.ts): it adds the CSRF
// header on writes, refreshes an expired session once, and carries the session in the editor
// Preview, where a plain fetch would arrive signed out (docs/agent/publishing.md).

import {siteFetch} from '../../platform/browser';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Query) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Where a signed-out visitor goes: the site's sign-in page, back here afterwards. */
export function signInPath() {
  const here = `${window.location.pathname}${window.location.search}`;
  return `/account/login/?next=${encodeURIComponent(here)}`;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await siteFetch(`/site-api${path}${qs(query)}`, {
    method,
    headers: body !== undefined ? {'content-type': 'application/json'} : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Kinroot routes answer `{error: "<words>"}`; the template's guards `{error: "<code>", message: "<words>"}`.
  const data = (await res.json().catch(() => ({}))) as {error?: string; message?: string};
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') window.location.href = signInPath();
    throw new ApiError(data.message ?? data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
