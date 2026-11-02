import type {Context} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem} from '../guards';
import type {Viewer} from '../types';
import {ACCESS_COOKIE, cookieName, readCookie, REFRESH_COOKIE, serializeCookie} from './cookies';
import {sendSiteEmail, type SiteEmail} from './email';
import {randomBytes, toBase64Url} from './encoding';
import {ACCESS_TOKEN_TTL_SECONDS, signAccessToken} from './jwt';
import {subjectHash} from './keys';
import {type AttemptKind, takeAttempt} from './rate-limit';
import {issueFamily, REFRESH_POLICY} from './refresh';
import {attemptStore, refreshStore, sweep} from './store';

/**
 * The building blocks every `/site-api/auth/*` route file shares (routes.ts,
 * owner.ts, security-routes.ts): input checks, rate-limit attempts, session
 * cookies, relayed emails. Managed by the template: never edit, never copy
 * into a feature route (use `requireAuth` / `requirePermission` there).
 */

export type Env = {Variables: {db: PrismaClient; secret: string; viewer: Viewer}};
export type Ctx = Context<Env>;

// ------------------------------------------------------------------ input --

export type FieldErrors = Record<string, string>;

export const invalid = (c: Context, fields: FieldErrors) =>
  c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);

export const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max + 1) : '');

export const raw = (v: unknown) => (typeof v === 'string' ? v : '');

export const body = <T>(check: (v: Record<string, unknown>, c: Context) => T | Response) =>
  validator('json', (value, c) => check((value ?? {}) as Record<string, unknown>, c));

// ---------------------------------------------------------------- helpers --

/** The client IP Cloudflare saw. Never `x-forwarded-for`: anyone can send that. */
export const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? 'local';

export async function keysFor(c: Ctx, email: string | null) {
  const secret = c.var.secret;
  const [emailHash, ipHash] = await Promise.all([
    email ? subjectHash(secret, 'email', email) : Promise.resolve(null),
    subjectHash(secret, 'ip', clientIp(c)),
  ]);
  return {emailHash, ipHash};
}

/** Runs `work` after the answer is sent when the runtime allows it (no timing difference). */
export function background(c: Context, work: Promise<unknown>) {
  const guarded = work.catch(err => console.error(`auth background: ${(err as Error).message}`));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (tests, in-process calls): it simply runs on.
  }
}

export function tooMany(c: Context, seconds: number) {
  c.header('Retry-After', String(seconds));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return c.json(
    problem('rate_limited', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`),
    429
  );
}

export type Keys = {emailHash: string | null; ipHash: string};

/**
 * Records this attempt and checks the limit (`takeAttempt`: record first, so
 * parallel requests count each other). `stop` is the 429 to answer; otherwise
 * `id` is the attempt's row, to `settle` when a `failures` kind succeeds.
 */
export async function attempt(c: Ctx, kind: AttemptKind, keys: Keys): Promise<{stop: Response; id: null} | {stop: null; id: bigint}> {
  const {wait, id} = await takeAttempt(attemptStore(c.var.db), kind, keys);
  return wait > 0 || id === null ? {stop: tooMany(c, wait), id: null} : {stop: null, id};
}

/** True when one more attempt of `kind` is allowed now (and records it). For sends nobody sees refused. */
export const allowed = async (c: Ctx, kind: AttemptKind, keys: Keys) =>
  (await takeAttempt(attemptStore(c.var.db), kind, keys)).wait === 0;

export const settle = (c: Ctx, id: bigint, succeeded: boolean) => attemptStore(c.var.db).settle(id, succeeded);

export function setSession(c: Context, access: string, refresh: string, refreshExpiresAt: Date) {
  const url = c.req.url;
  c.header('Set-Cookie', serializeCookie(ACCESS_COOKIE, access, url, {maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS, httpOnly: true}), {
    append: true,
  });
  const refreshAge = Math.min(REFRESH_POLICY.ttlSeconds, (refreshExpiresAt.getTime() - Date.now()) / 1000);
  c.header('Set-Cookie', serializeCookie(REFRESH_COOKIE, refresh, url, {maxAgeSeconds: refreshAge, httpOnly: true}), {
    append: true,
  });
}

export function clearSession(c: Context) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    c.header('Set-Cookie', serializeCookie(name, '', c.req.url, {maxAgeSeconds: 0, httpOnly: true}), {append: true});
  }
}

export const refreshCookieOf = (c: Context) => readCookie(c.req.header('cookie'), cookieName(REFRESH_COOKIE, c.req.url));

/** Signs a user in on this device: a new refresh family + an access token, as cookies. */
export async function startSession(c: Ctx, user: {id: number; sessionVersion: number}, ipHash: string) {
  const family = await issueFamily(refreshStore(c.var.db), user.id, {
    userAgent: c.req.header('user-agent') ?? null,
    ipHash,
  });
  const access = await signAccessToken(c.var.secret, {
    userId: user.id,
    familyId: family.familyId,
    sessionVersion: user.sessionVersion,
  });
  setSession(c, access, family.token, family.expiresAt);
}

export const newLinkToken = () => toBase64Url(randomBytes(32));

export function sendEmail(c: Context, email: SiteEmail) {
  background(c, sendSiteEmail(c.req.url, email));
}

/** Now and then (2% of calls), clear out dead rows. A Site has no cron. */
export function maybeSweep(c: Ctx) {
  if (Math.random() < 0.02) background(c, sweep(c.var.db));
}

/** A stored hash no password matches (`verifyPassword` answers no, at full cost). */
export const NO_PASSWORD = '!';

export const publicUser = (user: {id: number; name: string; email: string; emailVerifiedAt: Date | null}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerifiedAt !== null,
});
