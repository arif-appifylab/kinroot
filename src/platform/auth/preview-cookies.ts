import {ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE} from './cookies';

/**
 * THE EDITOR PREVIEW ONLY: the auth cookies, carried in headers.
 *
 * The editor shows the Preview through its own gateway, which drops every
 * `Cookie` and `Set-Cookie` header on the way (nothing behind it may
 * authenticate by cookie). Sign-in would fail there ("This form has
 * expired": no CSRF cookie ever arrives). So, in the Preview and nowhere
 * else (`config.preview`, set only by the platform), the server mirrors the
 * auth cookies it sets into `x-ezs-preview-set-cookie`, the browser keeps
 * them for the tab (`src/platform/browser.ts`, `sessionStorage`) and sends
 * them back in `x-ezs-preview-cookie`, which `previewCookies`
 * (`src/platform/guards.ts`) turns back into the request's `Cookie` header
 * before anything reads it. Every rule (CSRF double-submit, refresh
 * rotation, `session_version`) then runs unchanged.
 *
 * Deployed, the server never sends the header and ignores the request one:
 * there, the cookies stay HttpOnly and nothing is stored by page script.
 * Only this site's auth cookies are carried, never another cookie.
 */
export const PREVIEW_COOKIE_HEADER = 'x-ezs-preview-cookie';
export const PREVIEW_SET_COOKIE_HEADER = 'x-ezs-preview-set-cookie';

const BRIDGED = new Set(
  [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE].flatMap(base => [base, `__Host-${base}`])
);

/** A request header longer than this is ignored (three cookies fit in far less). */
const MAX_HEADER = 8192;

const COOKIE_VALUE = /^[A-Za-z0-9!#$%&'()*+\-./:<=>?@[\]^_`{|}~]*$/;

/**
 * The `Cookie` header a Preview request should carry: its own (normally
 * none) plus the bridged auth cookies. Null when there is nothing to add.
 */
export function bridgedCookieHeader(
  cookieHeader: string | null | undefined,
  previewHeader: string | null | undefined
): string | null {
  if (!previewHeader || previewHeader.length > MAX_HEADER) return null;
  const pairs: string[] = [];
  for (const part of previewHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (BRIDGED.has(name) && COOKIE_VALUE.test(value)) pairs.push(`${name}=${value}`);
  }
  if (!pairs.length) return null;
  return [cookieHeader?.trim(), ...pairs].filter(Boolean).join('; ');
}

/**
 * The value of `x-ezs-preview-set-cookie` for a response's `Set-Cookie`
 * lines: `[[name, value, maxAgeSeconds], …]` (JSON), auth cookies only, the
 * value exactly as the cookie carries it. Null when there is none.
 */
export function mirroredSetCookies(setCookies: readonly string[]): string | null {
  const out: [string, string, number][] = [];
  for (const line of setCookies) {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!BRIDGED.has(name) || !COOKIE_VALUE.test(value)) continue;
    const maxAge = attributes
      .map(attribute => attribute.trim().match(/^max-age=(-?\d+)$/i)?.[1])
      .find(found => found !== undefined);
    // Every auth cookie is set with a Max-Age; without one it lives for the tab.
    out.push([name, value, maxAge === undefined ? 86_400 : Math.max(0, Number(maxAge))]);
  }
  return out.length ? JSON.stringify(out) : null;
}
