/**
 * BROWSER-ONLY helpers for this site's own session. Imported by page
 * `<script>`s and the portal; never by server code.
 *
 * - `siteFetch`       fetch a `/site-api` path: same-origin cookies, the CSRF
 *                     header on writes, and ONE shared refresh on `401 token_expired`
 * - `refreshSession`  rotates the refresh cookie (once, shared by every caller
 *                     and, through `navigator.locks`, by every tab)
 * - `logout`          signs this device out, then reloads
 * - `csrfHeader`      `{'x-csrf-token': …}` for a hand-built request
 *
 * The session cookies are HttpOnly: page code can never read them, and must
 * never try to set or delete them. Only the CSRF cookie is readable.
 *
 * The editor Preview's gateway drops cookies, so THERE the server hands the
 * auth cookies over in a header instead and this file keeps them for the tab
 * (`sessionStorage`) and sends them back on every `/site-api` call
 * (`src/platform/auth/preview-cookies.ts`). A deployed site never sends that
 * header: nothing is stored there.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIES = ['__Host-site_csrf', 'site_csrf'];

// Must match src/platform/auth/preview-cookies.ts (not imported: server code).
const PREVIEW_COOKIE_HEADER = 'x-ezs-preview-cookie';
const PREVIEW_SET_COOKIE_HEADER = 'x-ezs-preview-set-cookie';
const PREVIEW_JAR = 'ezs:preview-cookies';

type PreviewJar = Record<string, {value: string; expires: number}>;

function loadJar(): PreviewJar {
  try {
    const jar = JSON.parse(sessionStorage.getItem(PREVIEW_JAR) ?? '{}') as PreviewJar;
    const now = Date.now();
    for (const [name, cookie] of Object.entries(jar)) if (!(cookie?.expires > now)) delete jar[name];
    return jar;
  } catch {
    return {};
  }
}

function saveJar(jar: PreviewJar): void {
  try {
    if (Object.keys(jar).length) sessionStorage.setItem(PREVIEW_JAR, JSON.stringify(jar));
    else sessionStorage.removeItem(PREVIEW_JAR);
  } catch {
    // Storage blocked: the Preview signs this tab out on the next call.
  }
}

/** Keeps the cookies a Preview answer handed over (`[[name, value, maxAge], …]`). */
function absorbPreviewCookies(res: Response): void {
  const raw = res.headers.get(PREVIEW_SET_COOKIE_HEADER);
  if (!raw) return;
  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(cookies)) return;
  const jar = loadJar();
  for (const cookie of cookies) {
    if (!Array.isArray(cookie)) continue;
    const [name, value, maxAge] = cookie as unknown[];
    if (typeof name !== 'string' || typeof value !== 'string' || typeof maxAge !== 'number') continue;
    if (maxAge > 0) jar[name] = {value, expires: Date.now() + maxAge * 1000};
    else delete jar[name];
  }
  saveJar(jar);
}

/** `fetch` for this site's own `/site-api`: same-origin cookies, plus the Preview's header-carried ones. */
async function sameSiteFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const jar = Object.entries(loadJar());
  if (jar.length) headers.set(PREVIEW_COOKIE_HEADER, jar.map(([name, {value}]) => `${name}=${value}`).join('; '));
  const res = await fetch(input, {...init, headers, credentials: 'same-origin'});
  absorbPreviewCookies(res);
  return res;
}

function readCsrf(): string | null {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name && CSRF_COOKIES.includes(name)) return decodeURIComponent(rest.join('='));
  }
  const jar = loadJar();
  const preview = CSRF_COOKIES.map(name => jar[name]?.value).find(Boolean);
  if (preview) {
    try {
      return decodeURIComponent(preview);
    } catch {
      return null;
    }
  }
  return null;
}

let csrfLoading: Promise<string | null> | null = null;

/** The CSRF token, fetching the cookie first when this browser has none yet. */
export async function csrfToken(): Promise<string | null> {
  const token = readCsrf();
  if (token) return token;
  csrfLoading ??= sameSiteFetch('/site-api/auth/csrf')
    .then(
      () => readCsrf(),
      () => null
    )
    .finally(() => (csrfLoading = null));
  return csrfLoading;
}

/** Synchronous, for clients that take a headers function (the portal's `hc`). */
export function csrfHeader(): Record<string, string> {
  const token = readCsrf();
  return token ? {'x-csrf-token': token} : {};
}

let refreshing: Promise<boolean> | null = null;

/**
 * ONE refresh shared by every waiting call in this tab, and serialized across
 * tabs (`navigator.locks`), so two tabs never present the same refresh token.
 * Resolves true when the browser now holds fresh cookies. Never loops.
 */
export function refreshSession(): Promise<boolean> {
  const run = async () => {
    const token = await csrfToken();
    const res = await sameSiteFetch('/site-api/auth/refresh', {
      method: 'POST',
      headers: token ? {'x-csrf-token': token} : {},
    });
    // 409: another tab refreshed a moment ago; its cookies are already ours.
    return res.ok || res.status === 409;
  };
  if (!refreshing) {
    const locked = navigator.locks
      ? (navigator.locks.request('ezs-auth-refresh', run) as unknown as Promise<boolean>)
      : run();
    refreshing = locked.catch(() => false).finally(() => setTimeout(() => (refreshing = null), 1000));
  }
  return refreshing;
}

export async function siteFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const token = await csrfToken();
      if (token) headers.set('x-csrf-token', token);
    }
    return sameSiteFetch(input, {...init, headers});
  };
  const res = await send();
  if (res.status !== 401) return res;
  const error = ((await res.clone().json().catch(() => null)) as {error?: string} | null)?.error;
  if (error !== 'token_expired') return res;
  return (await refreshSession()) ? send() : res;
}

/** Signs this device out, then reloads so every page renders signed out. */
export async function logout(): Promise<void> {
  await siteFetch('/site-api/auth/logout', {method: 'POST'}).catch(() => null);
  window.location.reload();
}
