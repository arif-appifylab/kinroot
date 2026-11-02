import {config} from './config';

/**
 * The ONE place this site calls the platform, server side.
 *
 *   publicGet(url, path)        `/api/public/...`, no credential (brand)
 *   siteKeyPost(url, path, b)   `/api/site/v1/...` as the SITE, with the Site Key
 *                               (`config.siteKey`): relayed emails
 *
 * Every call goes to the platform origin (`platformOrigin`), carries a
 * `User-Agent` and a timeout, and never throws into a page. Server code only:
 * `env` never reaches the browser, the key is never logged.
 */

/** The header our own server-side fetches carry; see `src/middleware.ts`. */
export const SELF_FETCH_HEADER = 'x-site-self-fetch';

export const PLATFORM_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (compatible; Site/1.0)',
  [SELF_FETCH_HEADER]: '1',
};

/** True only in the editor Preview (`config.preview`). */
export function isPreview(): boolean {
  return config.preview;
}

/**
 * Where to call the platform: `SITE_URL`, the site's managed platform
 * origin, which the platform always sets (deployed, in the Preview, and in
 * `.env` on your machine). The only host that receives the visitor's address
 * and the platform's signed header; other public hosts get neither, and the
 * platform's internal network is `403 Egress blocked`. Without it (a
 * bare local checkout) the request's own origin is used, where nothing
 * answers `/api`, so sections render their fallback.
 */
export function platformOrigin(requestUrl: string | URL): string {
  return config.siteUrl ?? new URL(requestUrl).origin;
}

/** The site has no Site Key (e.g. on your own machine without one). */
export class SiteKeyMissing extends Error {}

/** The platform did not answer, or answered with an error status. */
export class PlatformError extends Error {
  constructor(readonly status: number | null) {
    super(status ? `The platform answered ${status}.` : 'The platform did not answer.');
  }
}

/** How long one platform call may take before the page renders without it. */
const TIMEOUT_MS = 8000;

async function getData<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, {headers, signal: AbortSignal.timeout(TIMEOUT_MS)});
  } catch {
    throw new PlatformError(null);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new PlatformError(res.status);
  const body = (await res.json().catch(() => null)) as {data?: T} | null;
  return body?.data ?? null;
}

/**
 * PUBLIC answers kept in this Worker isolate's memory for a few seconds, so a
 * busy page does not ask the platform for the same brand on every
 * request. Best-effort: each isolate has its own copy, it vanishes on any
 * restart, and there is no shared cache (no KV, no Redis) for a Site. Public
 * data ONLY: never a visitor's answer, never anything a session gates.
 */
const PUBLIC_CACHE = new Map<string, {at: number; value: unknown}>();
const PUBLIC_CACHE_MAX = 200;

/**
 * `GET <platform>/api/public<path>`: the `data` of the answer, `null` on 404.
 * `ttlSeconds` > 0 serves a recent identical answer from memory instead.
 * Only RESOLVED answers are kept: a Worker must not await a fetch another
 * request started.
 */
export async function publicGet<T>(
  requestUrl: string | URL,
  path: string,
  {ttlSeconds = 0}: {ttlSeconds?: number} = {}
): Promise<T | null> {
  const url = `${platformOrigin(requestUrl)}/api/public${path}`;
  if (ttlSeconds <= 0) return getData<T>(url, PLATFORM_HEADERS);

  const hit = PUBLIC_CACHE.get(url);
  if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value as T | null;

  // A failure throws and is never kept: the next request asks again.
  const value = await getData<T>(url, PLATFORM_HEADERS);
  if (PUBLIC_CACHE.size >= PUBLIC_CACHE_MAX) {
    PUBLIC_CACHE.delete(PUBLIC_CACHE.keys().next().value!);
  }
  PUBLIC_CACHE.set(url, {at: Date.now(), value});
  return value;
}

/**
 * `POST <platform>/api/site/v1<path>` with the Site Key. Resolves to the HTTP
 * status (0 = no answer); never throws, never logs the body (it may hold an
 * email address).
 */
export async function siteKeyPost(requestUrl: string | URL, path: string, body: unknown): Promise<number> {
  return (await siteKeyCall(requestUrl, path, body, false)).status;
}

/**
 * `siteKeyPost`, plus the answer's `data` when the platform answered 200 (null otherwise).
 * Status 0 = the platform did not answer.
 */
export async function siteKeyPostData<T>(
  requestUrl: string | URL,
  path: string,
  body: unknown
): Promise<{status: number; data: T | null}> {
  return siteKeyCall<T>(requestUrl, path, body, true);
}

async function siteKeyCall<T>(
  requestUrl: string | URL,
  path: string,
  body: unknown,
  read: boolean
): Promise<{status: number; data: T | null}> {
  const key = config.siteKey;
  if (!key) throw new SiteKeyMissing();
  try {
    const res = await fetch(`${platformOrigin(requestUrl)}/api/site/v1${path}`, {
      method: 'POST',
      headers: {...PLATFORM_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${key}`},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!read || res.status !== 200) {
      await res.body?.cancel();
      return {status: res.status, data: null};
    }
    const answer = (await res.json().catch(() => null)) as {data?: T} | null;
    return {status: res.status, data: answer?.data ?? null};
  } catch {
    return {status: 0, data: null};
  }
}
