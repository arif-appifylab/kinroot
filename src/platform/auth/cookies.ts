/**
 * The site's auth cookies. In production every one is `__Host-` prefixed:
 * the browser then insists on `Secure`, `Path=/` and NO `Domain`, so no
 * other subdomain can set or overwrite them (no cookie tossing).
 *
 *   __Host-site_at    access JWT, 10 min          HttpOnly
 *   __Host-site_rt    refresh token, 30 days      HttpOnly
 *   __Host-site_csrf  CSRF double-submit token    readable by the page's JS
 *
 * All `SameSite=Lax`. On your own machine (`localhost`) the prefix and
 * `Secure` are dropped, because some browsers refuse Secure cookies on
 * http://localhost; the hostname decides, never a header.
 */
export const ACCESS_COOKIE = 'site_at';
export const REFRESH_COOKIE = 'site_rt';
export const CSRF_COOKIE = 'site_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/** The real cookie name for this request's host. */
export function cookieName(base: string, requestUrl: string | URL): string {
  return isLocalHost(new URL(requestUrl).hostname) ? base : `__Host-${base}`;
}

/** One cookie's value from a `Cookie` header, or null. Exact name match. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  httpOnly: boolean;
}

/** A `Set-Cookie` value. Pass `maxAgeSeconds: 0` to delete. */
export function serializeCookie(
  base: string,
  value: string,
  requestUrl: string | URL,
  {maxAgeSeconds, httpOnly}: CookieOptions
): string {
  const local = isLocalHost(new URL(requestUrl).hostname);
  const parts = [
    `${local ? base : `__Host-${base}`}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'SameSite=Lax',
  ];
  if (!local) parts.push('Secure');
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}
