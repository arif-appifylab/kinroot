import type {Context} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem} from '../guards';
import type {Viewer} from '../types';
import {ACCESS_COOKIE, cookieName, DEVICE_COOKIE, readCookie, REFRESH_COOKIE, serializeCookie} from './cookies';
import {sendSiteEmail, type SiteEmail} from './email';
import {randomBytes, sha256Hex, toBase64Url, toHex, utf8} from './encoding';
import {ACCESS_TOKEN_TTL_SECONDS, signAccessToken} from './jwt';
import {hmacKey, subjectHash} from './keys';
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

/**
 * What rate limits count an address as. One person usually controls a whole IPv6 /56, so all of it
 * counts as one. IPv4 (and IPv4 written inside IPv6) stays as it is.
 */
export function rateLimitIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  // /56: a home or small network is usually handed at least this much, and all of it is one person's.
  const fourth = (groups[3] ?? '0').padStart(4, '0').slice(0, 2);
  return `${groups.slice(0, 3).map(group => group.replace(/^0+(?=.)/, '')).join(':')}:${fourth}00::/56`;
}

export async function keysFor(c: Ctx, email: string | null) {
  const secret = c.var.secret;
  const [emailHash, ipHash] = await Promise.all([
    email ? subjectHash(secret, 'email', email) : Promise.resolve(null),
    subjectHash(secret, 'ip', rateLimitIp(clientIp(c))),
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

export function tooMany(c: Context, seconds: number, hint?: string) {
  c.header('Retry-After', String(seconds));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return c.json(
    problem('rate_limited', hint ?? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`),
    429
  );
}

export type Keys = {emailHash: string | null; ipHash: string};

/**
 * Keyed on this address and its session version, so the cookie only speaks for the address it was
 * set for, and stops counting once a password reset or "sign out everywhere" ends the account's sessions.
 */
const deviceProof = async (secret: string, email: string, sessionVersion: number) =>
  toHex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'device'), utf8(`${sessionVersion}:${email}`))));

const DEVICE_COOKIE_SECONDS = 180 * 24 * 3600;

/** Whether this browser has signed in to this address before (see `takeAttempt`'s `trusted`). */
export async function deviceTrusted(c: Ctx, email: string): Promise<boolean> {
  const cookie = readCookie(c.req.header('cookie'), cookieName(DEVICE_COOKIE, c.req.url));
  if (!cookie) return false;
  const user = await c.var.db.user.findUnique({where: {email}, select: {sessionVersion: true}});
  return user !== null && cookie === (await deviceProof(c.var.secret, email, user.sessionVersion));
}

/**
 * Checks the limit and records this attempt (`takeAttempt`). `stop` is the 429 to answer; otherwise
 * `id` is the attempt's row, to `settle` when a `failures` kind succeeds. `subjectHint` is what to say
 * when the limit on the address alone refused it: how the real person gets in anyway.
 */
export async function attempt(
  c: Ctx,
  kind: AttemptKind,
  keys: Keys,
  options: {trusted?: boolean; subjectHint?: string} = {}
): Promise<{stop: Response; id: null} | {stop: null; id: bigint}> {
  const {wait, id, scope} = await takeAttempt(attemptStore(c.var.db), kind, keys, {trusted: options.trusted});
  if (wait > 0 || id === null) return {stop: tooMany(c, wait, scope === 'subject' ? options.subjectHint : undefined), id: null};
  return {stop: null, id};
}

/** Whether this address may get one more email with a way in now (and records it). Whoever asked. */
export const mailDue = async (c: Ctx, keys: Keys) => (await takeAttempt(attemptStore(c.var.db), 'mail', keys)).wait === 0;

/** The same for a notice with no way in. */
export const noticeDue = async (c: Ctx, keys: Keys) => (await takeAttempt(attemptStore(c.var.db), 'notice', keys)).wait === 0;

/**
 * Proving the inbox clears what strangers ran up against this address, so the person who just did
 * can sign in from anywhere at once.
 */
export async function forgiveAddress(db: PrismaClient, emailHash: string | null): Promise<void> {
  if (emailHash) await db.loginAttempt.deleteMany({where: {emailHash, kind: {in: ['login', 'codecheck']}}});
}

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

/** This browser has proven this address: a limit on the address won't block it. */
export async function rememberDevice(c: Ctx, email: string, sessionVersion: number) {
  c.header('Set-Cookie', serializeCookie(DEVICE_COOKIE, await deviceProof(c.var.secret, email, sessionVersion), c.req.url, {maxAgeSeconds: DEVICE_COOKIE_SECONDS, httpOnly: true}), {append: true});
}

/**
 * The account's current session version, after any `endAccess` still running has finished (the row
 * lock waits for it). A session or token made during one is checked against this, so it can't outlive it.
 */
export async function settledSessionVersion(db: PrismaClient, userId: number): Promise<number | null> {
  const [row] = await db.$queryRaw<{version: number}[]>`SELECT "session_version" AS "version" FROM "users" WHERE "id" = ${userId} FOR SHARE`;
  return row ? Number(row.version) : null;
}

/** Signs a user in on this device: a new refresh family + an access token, as cookies. */
export async function startSession(c: Ctx, user: {id: number; sessionVersion: number; email?: string}, ipHash: string) {
  const store = refreshStore(c.var.db);
  const family = await issueFamily(store, user.id, {
    userAgent: c.req.header('user-agent') ?? null,
    ipHash,
  });
  // The account's sessions ended while this sign-in was being checked (hashing a password takes a
  // moment): this one ends with them, and the person signs in again.
  if ((await settledSessionVersion(c.var.db, user.id)) !== user.sessionVersion) {
    await store.revokeFamily(family.familyId, new Date(), 'password');
    return;
  }
  if (user.email) await rememberDevice(c, user.email, user.sessionVersion);
  const access = await signAccessToken(c.var.secret, {
    userId: user.id,
    familyId: family.familyId,
    sessionVersion: user.sessionVersion,
  });
  setSession(c, access, family.token, family.expiresAt);
}

export const newLinkToken = () => toBase64Url(randomBytes(32));

export const RESET_TTL_MINUTES = 30;

/** A new single-use reset link (`/account/reset/`), as the path to put in an email. */
export async function newResetPath(c: Ctx, userId: number, ipHash: string): Promise<string> {
  const token = newLinkToken();
  await c.var.db.passwordReset.create({
    data: {
      userId,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
      ipHash,
    },
    select: {id: true},
  });
  return `/account/reset/?token=${token}`;
}

export function sendEmail(c: Context, email: SiteEmail) {
  background(c, sendSiteEmail(c.req.url, email));
}

/** Now and then (2% of calls), clear out dead rows. A Site has no cron. */
export function maybeSweep(c: Ctx) {
  if (Math.random() < 0.02) background(c, sweep(c.var.db));
}

/** A stored hash no password matches (`verifyPassword` answers no, at full cost). */
export const NO_PASSWORD = '!';

/** The site owner's sign-in lives in the dashboard: nothing about it is set from inside the site. */
export const notForOwnerAccount = async (c: Ctx, next: () => Promise<void>) => {
  if (c.var.viewer.platformOwner) {
    return c.json(problem('owner_account', 'Your access comes from the dashboard, so there is nothing to change here.'), 403);
  }
  return next();
};

export const publicUser = (user: {id: number; name: string; email: string; emailVerifiedAt: Date | null}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerifiedAt !== null,
});
