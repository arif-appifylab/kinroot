import {isLocalHost} from './auth/cookies';
import {config} from './config';

/**
 * Security headers for every response the Worker renders (SSR pages and the
 * Site API). Prerendered pages are files served before the Worker runs: they
 * get the same headers from `public/_headers`. Keep the two in step.
 *
 * The Content-Security-Policy for pages comes from Astro itself
 * (`security.csp` in `astro.config.mjs`: hashes for every script and style it
 * emits), so there are no inline-script exceptions to maintain here.
 */
export function applySecurityHeaders(response: Response, requestUrl: URL): Response {
  const headers = response.headers;
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  try {
    set('X-Content-Type-Options', 'nosniff');
    set('Referrer-Policy', 'strict-origin-when-cross-origin');
    set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    set('Cross-Origin-Opener-Policy', 'same-origin');
    // The editor shows the Preview in a frame; everywhere else nobody may frame us.
    if (!config.preview) set('X-Frame-Options', 'DENY');
    if (requestUrl.protocol === 'https:' && !isLocalHost(requestUrl.hostname)) {
      set('Strict-Transport-Security', 'max-age=15552000');
    }
  } catch {
    // An immutable response (a pass-through asset): leave it as it is.
  }
  return response;
}
