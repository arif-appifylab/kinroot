import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';

import type {PrismaClient} from '../generated/prisma/client';
import type {Viewer} from './types';
import {isPreview} from './api';
import {allows, scopeOf} from './auth/codenames';
import {cookieName, CSRF_COOKIE, CSRF_HEADER, readCookie, serializeCookie} from './auth/cookies';
import {constantTimeEqualText, randomBytes, toBase64Url} from './auth/encoding';
import {
  bridgedCookieHeader,
  mirroredSetCookies,
  PREVIEW_COOKIE_HEADER,
  PREVIEW_SET_COOKIE_HEADER,
} from './auth/preview-cookies';
import {getAccess, getViewer} from './auth/session';
import {config} from './config';
import {getDb} from './db';

/**
 * The Site API's building blocks. `previewCookies`, `sameOrigin` and `csrf`
 * run on the whole app; per route, combine the rest in THIS order:
 *
 *   validator → withViewer → requireAuth → requireRole / requirePermission → withDb
 *
 * so a bad input is refused before any lookup, a guest before any permission
 * query, and nobody without access learns whether a database exists.
 */

export type Problem = {error: string; message: string};

export const problem = (error: string, message: string): Problem => ({error, message});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

/**
 * Refuses every CROSS-SITE write (all methods but GET/HEAD/OPTIONS), whatever
 * its content type: the browser's `Sec-Fetch-Site` must be `same-origin` (or
 * `none`), and an `Origin` header must name this site's own host.
 *
 * Requests with neither header are not from a browser page (in-process
 * `backend()` calls, server tools); `csrf` below still needs the token. In
 * the editor Preview the Preview's own gateway has already checked the origin
 * and rewrites it, so this check is skipped there.
 */
export const sameOrigin = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || isPreview()) return next();
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return c.json(problem('cross_site', 'Cross-site requests are not allowed.'), 403);
  }
  // Hosts, not full origins: behind a TLS-terminating proxy (local dev) the
  // Worker can see `http://` while the browser sends `https://`.
  const origin = c.req.header('origin');
  if (origin && hostOf(origin) !== new URL(c.req.url).host) {
    return c.json(problem('cross_site', 'Cross-site requests are not allowed.'), 403);
  }
  await next();
});

/**
 * THE EDITOR PREVIEW ONLY (`config.preview`): the editor's gateway drops
 * `Cookie` and `Set-Cookie`, so the auth cookies travel in headers instead
 * (`src/platform/auth/preview-cookies.ts`). Before the rest of the app runs,
 * the cookies the browser sent in `x-ezs-preview-cookie` become the
 * request's `Cookie`; after it, the auth cookies it set are mirrored into
 * `x-ezs-preview-set-cookie` for `browser.ts` to keep. Everywhere else it
 * does nothing. Mounted FIRST, before `sameOrigin` and `csrf`.
 */
export const previewCookies = createMiddleware(async (c, next) => {
  if (!config.preview) return next();
  const cookie = bridgedCookieHeader(c.req.header('cookie'), c.req.header(PREVIEW_COOKIE_HEADER));
  if (cookie !== null) {
    const headers = new Headers(c.req.raw.headers);
    headers.set('cookie', cookie);
    headers.delete(PREVIEW_COOKIE_HEADER);
    c.req.raw = new Request(c.req.raw, {headers});
  }
  await next();
  const mirrored = mirroredSetCookies(c.res.headers.getSetCookie());
  if (mirrored) {
    try {
      c.res.headers.set(PREVIEW_SET_COOKIE_HEADER, mirrored);
    } catch {
      // An immutable response: nothing to mirror into.
    }
  }
});

/** A new CSRF token as a `Set-Cookie` value, readable by the page's script. */
export function csrfCookie(requestUrl: string, token: string): string {
  return serializeCookie(CSRF_COOKIE, token, requestUrl, {maxAgeSeconds: 365 * 24 * 3600, httpOnly: false});
}

export const newCsrfToken = () => toBase64Url(randomBytes(32));

/**
 * Double-submit CSRF: every write must send the `__Host-site_csrf` cookie's
 * value back in the `x-csrf-token` header (`siteFetch` in `browser.ts` does).
 * Another site can make the browser SEND the cookie but cannot READ it, so it
 * cannot forge the header. A safe request without the cookie gets one.
 *
 * A route that must accept cross-site writes (a webhook) goes in its own Hono
 * app mounted BEFORE this one, with its own authentication.
 */
export const csrf = createMiddleware(async (c, next) => {
  const name = cookieName(CSRF_COOKIE, c.req.url);
  const cookie = readCookie(c.req.header('cookie'), name);
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    if (!cookie) c.header('Set-Cookie', csrfCookie(c.req.url, newCsrfToken()), {append: true});
    return;
  }
  const sent = c.req.header(CSRF_HEADER) ?? '';
  if (!cookie || !sent || !constantTimeEqualText(cookie, sent)) {
    return c.json(problem('csrf_failed', 'This form has expired. Reload the page and try again.'), 403);
  }
  await next();
});

/**
 * `csrf` for a route that a plain HTML `<form method="post">` may also reach WITHOUT JavaScript
 * (the payments Buy button, src/server/routes/checkout.ts): mount that route BEFORE `csrf` in
 * `app.ts`, after `sameOrigin`, with this. A write passes when it carries the double-submit token
 * (the `x-csrf-token` header, or a `csrf` form field), or when it is a form post the browser
 * itself marks same-origin (`Sec-Fetch-Site: same-origin`: Fetch Metadata, which a cross-site
 * page cannot forge). Everything else is the same 403 as `csrf`.
 */
export const formCsrf = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const cookie = readCookie(c.req.header('cookie'), cookieName(CSRF_COOKIE, c.req.url));
  const type = c.req.header('content-type') ?? '';
  const isForm = type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');
  let sent = c.req.header(CSRF_HEADER) ?? '';
  if (!sent && isForm) {
    const field = (await c.req.parseBody().catch(() => ({}) as Record<string, unknown>))['csrf'];
    sent = typeof field === 'string' ? field : '';
  }
  const tokenOk = Boolean(cookie && sent && constantTimeEqualText(cookie, sent));
  const fetchMetadataOk = isForm && c.req.header('sec-fetch-site') === 'same-origin';
  if (!tokenOk && !fetchMetadataOk) {
    return c.json(problem('csrf_failed', 'This form has expired. Reload the page and try again.'), 403);
  }
  await next();
});

/**
 * Who is visiting (`c.var.viewer`). Any answer built from it is private to
 * that visitor: `Cache-Control: private, no-store`.
 */
export const withViewer = createMiddleware<{Variables: {viewer: Viewer}}>(async (c, next) => {
  c.set('viewer', await getViewer(c.req.raw));
  await next();
  c.header('Cache-Control', 'private, no-store');
});

/**
 * Signed-in users only. `401 token_expired` tells the browser to refresh once
 * and retry (`siteFetch` does); `401 signed_out` means sign in.
 */
export const requireAuth = createMiddleware<{Variables: {viewer: Viewer}}>(async (c, next) => {
  const {state} = c.var.viewer;
  if (state === 'user') return next();
  if (state === 'returning') return c.json(problem('token_expired', 'Your session needs refreshing.'), 401);
  return c.json(problem('signed_out', 'Sign in first.'), 401);
});

/** Signed-in users whose email is confirmed. */
export const requireVerified = createMiddleware<{Variables: {viewer: Viewer}}>(async (c, next) => {
  if (!c.var.viewer.emailVerified) {
    return c.json(problem('email_unverified', 'Confirm your email address first.'), 403);
  }
  await next();
});

const FORBIDDEN = problem('forbidden', 'You do not have access to this.');

/** The standard `403 forbidden` answer, for a check made inside a handler (`can`). */
export const forbidden = (c: Context) => c.json(FORBIDDEN, 403);

/**
 * Users holding ONE of these role slugs. Avoid it: gate on a codename
 * (`requirePermission`). Roles are renamed and edited by owners; codenames are not.
 */
export const requireRole = (...slugs: string[]) =>
  createMiddleware(async (c, next) => {
    const {roles} = await getAccess(c.req.raw);
    if (!roles.some(role => slugs.includes(role))) return c.json(FORBIDDEN, 403);
    await next();
  });

/**
 * Users whose roles grant `codename` (exactly or by a wildcard).
 *
 * `{orOwn: true}` also lets in holders of `<codename>_own` only; the handler
 * MUST then check the record with `can(c, codename, {ownerId})` or filter
 * its query with `permissionScope` (docs/agent/roles-and-permissions.md).
 */
export const requirePermission = (codename: string, options: {orOwn?: boolean} = {}) =>
  createMiddleware(async (c, next) => {
    const {permissions} = await getAccess(c.req.raw);
    const scope = scopeOf(new Set(permissions), codename);
    if (scope === 'none' || (scope === 'own' && !options.orOwn && !codename.endsWith('_own'))) {
      return c.json(FORBIDDEN, 403);
    }
    await next();
  });

/**
 * How much of `codename` the signed-in viewer holds: `'all'` (the codename
 * itself), `'own'` (only `<codename>_own`) or `'none'`. For LIST queries:
 *
 *   const scope = await permissionScope(c, PERMISSIONS.NOTE_UPDATE);
 *   const where = scope === 'all' ? {} : {ownerId: c.var.viewer.id!};
 */
export async function permissionScope(c: Context, codename: string): Promise<'all' | 'own' | 'none'> {
  const {permissions} = await getAccess(c.req.raw);
  return scopeOf(new Set(permissions), codename);
}

/**
 * May the viewer do `codename`, to `record` when given? With `{ownerId}`, the
 * `<codename>_own` variant counts when the record is theirs. After
 * `withViewer`; load the record's OWNER from the database, never from the body:
 *
 *   const note = await db.note.findUnique({where: {id}, select: {id: true, ownerId: true}});
 *   if (!note) return c.json(problem('not_found', 'No such note.'), 404);
 *   if (!(await can(c, PERMISSIONS.NOTE_UPDATE, {ownerId: note.ownerId}))) return forbidden(c);
 */
export async function can(
  c: Context<{Variables: {viewer: Viewer}}>,
  codename: string,
  record?: {ownerId: number | null | undefined}
): Promise<boolean> {
  const viewer = c.var.viewer;
  if (viewer?.state !== 'user') return false;
  const {permissions} = await getAccess(c.req.raw);
  const held = new Set(permissions);
  return record ? allows(held, codename, viewer.id, record.ownerId) : scopeOf(held, codename) === 'all';
}

const NO_DATABASE = problem(
  'site_database_disabled',
  'This site has no Site Database yet. The owner can turn it on in the site’s Database tab.'
);

/** A Site Database client (`c.var.db`), or 503 when the site has none yet. */
export const withDb = createMiddleware<{Variables: {db: PrismaClient}}>(async (c, next) => {
  const db = getDb();
  if (!db) return c.json(NO_DATABASE, 503);
  c.set('db', db);
  await next();
});

/** The auth core's needs: the Site Database AND `JWT_SECRET`. 503 otherwise. */
export const withAuthCore = createMiddleware<{Variables: {db: PrismaClient; secret: string}}>(async (c, next) => {
  const db = getDb();
  if (!db) return c.json(NO_DATABASE, 503);
  const secret = config.jwtSecret;
  if (!secret) {
    return c.json(problem('auth_not_configured', 'Sign-in is not set up on this site yet. Ask the owner.'), 503);
  }
  c.set('db', db);
  c.set('secret', secret);
  c.header('Cache-Control', 'no-store');
  await next();
});
