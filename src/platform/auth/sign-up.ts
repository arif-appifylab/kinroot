import {Hono} from 'hono';

import {problem, withAuthCore} from '../guards';
import {audit} from './audit';
import {sameHex} from './code-routes';
import {cookieName, readCookie, serializeCookie, SIGN_UP_COOKIE} from './cookies';
import {emailAccepted, EMAIL_NOT_REAL} from './email-check';
import {sha256Hex, toBase64Url, toHex, utf8} from './encoding';
import {claimUnconfirmed} from './end-access';
import {normalizeEmail, safeNext} from './input';
import {hmacKey} from './keys';
import {
  attempt,
  background,
  body,
  type Ctx,
  type Env,
  type FieldErrors,
  invalid,
  keysFor,
  mailDue,
  maybeSweep,
  newLinkToken,
  noticeDue,
  publicUser,
  raw,
  sendEmail,
  settle,
  startSession,
  text,
} from './kit';
import {hashPassword, passwordProblem} from './password';
import {type AuthSettings} from './settings';

/**
 * Creating an account (docs/agent/auth.md). NO ACCOUNT EXISTS until the inbox is proven:
 *
 *   POST /register         {email, password, name}  keeps them as a pending sign-up, for this
 *                                                   browser only, and emails a code and a link
 *   POST /register/verify  {email, code, next?}     this browser + the 6-digit code → the account
 *                          or {token, next?}        this browser + the emailed link → the account
 *
 * The code and link go to the inbox and the password stays with the browser that chose it, so the
 * account needs both. A stranger signing up with someone's address gets a pending row they can never
 * finish, and each browser has its own row.
 *
 * NOTHING HERE IS A BUDGET A STRANGER CAN SPEND. The code and link belong to the ADDRESS, derived from
 * it, and last longer than the gap between emails (`mail` in rate-limit.ts). So a person signing up
 * right after a stranger gets no new email, but the stranger's email is in their inbox and works in
 * their own browser. The 6-digit code needs a limit per address, because it can be guessed, and a
 * stranger can use that up; the link can't be guessed, so it has no such limit. Whoever reads the
 * inbox can always finish, in this browser.
 *
 * An unconfirmed account from before this (a site that upgraded) is claimed the same way: its
 * password goes, unless the person who proves the inbox also knows it (`/login` starts a pending row
 * from it), and `claimUnconfirmed` ends everything set before that.
 */

const WINDOW_MINUTES = 15;
const WINDOWS_ACCEPTED = 3;
/** What the email can promise: a code sent at the very end of a window still has two more. */
export const SIGN_UP_CODE_TTL_MINUTES = WINDOW_MINUTES * (WINDOWS_ACCEPTED - 1);
const PENDING_SECONDS = 24 * 3600;
const PENDING_PER_BROWSER = 5;

const GENERIC = {
  registered: 'Check your inbox for a 6-digit code to confirm your email. It may have arrived a few minutes ago.',
  wrong: 'That code is wrong or has expired. Check the email, or ask for a new code.',
  badLink: 'This link has expired. Ask for a new code.',
};
const RESEND_HINT = 'Too many wrong codes for this email. Use the link in the email instead, in this same browser.';

/** Where this browser's sign-up continues. A site's own form can link here. */
export const SIGN_UP_CODE_PATH = '/account/verify/';

const windowOf = (ms: number) => Math.floor(ms / (WINDOW_MINUTES * 60 * 1000));

const mac = async (secret: string, text: string) =>
  new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign-up-code'), utf8(text)));

/** This address's 6-digit code for one window. */
async function codeFor(secret: string, email: string, window: number): Promise<string> {
  const bytes = await mac(secret, `code:${window}:${email}`);
  const value = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return String(value).padStart(6, '0');
}

/** This address's link token for one window: can't be guessed, so it needs no limit per address. */
const tokenFor = async (secret: string, email: string, window: number) => toBase64Url(await mac(secret, `link:${window}:${email}`));

/** Whether `check` matches this address in a window still accepted. */
async function accepted(make: (window: number) => Promise<string>, given: string): Promise<boolean> {
  const now = windowOf(Date.now());
  let ok = false;
  for (let back = 0; back < WINDOWS_ACCEPTED; back++) {
    if (sameHex(toHex(utf8(await make(now - back))), toHex(utf8(given)))) ok = true;
  }
  return ok;
}

async function sendSignUpMail(c: Ctx, email: string) {
  const window = windowOf(Date.now());
  sendEmail(c, {
    kind: 'sign_up_code',
    to: email,
    code: await codeFor(c.var.secret, email, window),
    path: `${SIGN_UP_CODE_PATH}?signup=${await tokenFor(c.var.secret, email, window)}`,
    expiresInMinutes: SIGN_UP_CODE_TTL_MINUTES,
  });
}

/** This browser's id for its sign-ups, set when it has none. Only its hash is stored. */
async function browserHashOf(c: Ctx, create: boolean): Promise<string | null> {
  let id = readCookie(c.req.header('cookie'), cookieName(SIGN_UP_COOKIE, c.req.url));
  if (!id && !create) return null;
  if (!id) {
    id = newLinkToken();
    c.header('Set-Cookie', serializeCookie(SIGN_UP_COOKIE, id, c.req.url, {maxAgeSeconds: PENDING_SECONDS, httpOnly: true}), {append: true});
  }
  return sha256Hex(id);
}

/** Keeps a sign-up for this browser, replacing its earlier one. */
async function keepPending(c: Ctx, pending: {email: string; name: string; passwordHash: string; ipHash: string}, browserHash: string) {
  const fields = {
    name: pending.name,
    passwordHash: pending.passwordHash,
    expiresAt: new Date(Date.now() + PENDING_SECONDS * 1000),
    usedAt: null,
    ipHash: pending.ipHash,
  };
  await c.var.db.pendingSignUp.upsert({
    where: {email_browserHash: {email: pending.email, browserHash}},
    create: {email: pending.email, browserHash, ...fields},
    update: fields,
    select: {id: true},
  });
}

/** A new email for this browser's waiting sign-up, when one is due. False when it has none. */
export async function resendPending(c: Ctx, email: string, keys: {emailHash: string | null; ipHash: string}): Promise<boolean> {
  const browserHash = await browserHashOf(c, false);
  if (!browserHash) return false;
  const row = await c.var.db.pendingSignUp.findFirst({
    where: {email, browserHash, usedAt: null, expiresAt: {gt: new Date()}},
    select: {id: true},
  });
  if (!row) return false;
  if (await mailDue(c, keys)) await sendSignUpMail(c, email);
  return true;
}

/** Starts a pending sign-up from a password just proven at `/login`: this browser knows it. */
export async function pendingFromLogin(
  c: Ctx,
  user: {email: string; name: string; passwordHash: string},
  keys: {emailHash: string | null; ipHash: string}
) {
  await keepPending(c, {email: user.email, name: user.name, passwordHash: user.passwordHash, ipHash: keys.ipHash}, (await browserHashOf(c, true))!);
  if (await mailDue(c, keys)) await sendSignUpMail(c, user.email);
}

export function signUpRoutes(settings: AuthSettings) {
  return new Hono<Env>()
    .post(
      '/register',
      body((v, c) => {
        const fields: FieldErrors = {};
        const email = normalizeEmail(v.email);
        const name = text(v.name, 80);
        const password = raw(v.password);
        if (!email) fields.email = 'Enter a valid email address, like name@example.com.';
        if (!name) fields.name = 'Enter your name.';
        else if (name.length > 80) fields.name = 'Use at most 80 characters.';
        const weak = passwordProblem(password, email ?? undefined);
        if (weak) fields.password = weak;
        return Object.keys(fields).length ? invalid(c, fields) : {email: email!, name, password};
      }),
      withAuthCore,
      async c => {
        if (settings.registration !== 'open') {
          return c.json(problem('registration_closed', 'Sign-up is closed on this site.'), 403);
        }
        const {email, name, password} = c.req.valid('json');
        const keys = await keysFor(c, email);
        const {stop} = await attempt(c, 'register', keys);
        if (stop) return stop;
        // After the rate limit, so the form can't be used to test addresses in bulk.
        if (!(await emailAccepted(c.req.url, email))) return invalid(c, {email: EMAIL_NOT_REAL});

        // Hashed and cookied either way, and the rest after the answer, so a taken address answers alike.
        const passwordHash = await hashPassword(password);
        const browserHash = (await browserHashOf(c, true))!;
        background(
          c,
          (async () => {
            const taken = await c.var.db.user.findUnique({where: {email}, select: {emailVerifiedAt: true}});
            if (taken?.emailVerifiedAt) {
              // Tell the address's owner, not the visitor.
              if (await noticeDue(c, keys)) sendEmail(c, {kind: 'account_exists', to: email, path: '/account/login/'});
              return;
            }
            // Always kept: this browser can finish with an email that's already in the inbox.
            await keepPending(c, {email, name, passwordHash, ipHash: keys.ipHash}, browserHash);
            if (await mailDue(c, keys)) await sendSignUpMail(c, email);
          })()
        );
        maybeSweep(c);
        return c.json({ok: true, needsCode: true, message: GENERIC.registered, next: SIGN_UP_CODE_PATH}, 202);
      }
    )

    .post(
      '/register/verify',
      body((v, c) => {
        const token = text(v.token, 64);
        if (token) {
          return /^[A-Za-z0-9_-]{43}$/.test(token) ? {token, next: v.next} : c.json(problem('invalid_token', GENERIC.badLink), 400);
        }
        const email = normalizeEmail(v.email);
        const code = text(v.code, 12).replace(/\s/g, '');
        const fields: FieldErrors = {};
        if (!email) fields.email = 'Enter a valid email address, like name@example.com.';
        if (!/^\d{6}$/.test(code)) fields.code = 'Enter the 6-digit code from the email.';
        return Object.keys(fields).length ? invalid(c, fields) : {email: email!, code, next: v.next};
      }),
      withAuthCore,
      async c => {
        const input = c.req.valid('json') as {token?: string; email?: string; code?: string; next?: unknown};
        const db = c.var.db;
        const browserHash = await browserHashOf(c, false);
        const now = new Date();
        const pendingSelect = {id: true, email: true, name: true, passwordHash: true} as const;

        let row: {id: number; email: string; name: string; passwordHash: string} | null;
        let attemptId: bigint;
        let ipHash: string;
        if (input.token) {
          // A link can't be guessed: limited per browser and IP only, so nobody else can use it up.
          const keys = await keysFor(c, `signup-link:${browserHash ?? ''}`);
          ipHash = keys.ipHash;
          const taken = await attempt(c, 'codecheck', keys);
          if (taken.stop) return taken.stop;
          attemptId = taken.id;
          // Whichever of this browser's sign-ups the link is for, not only its newest.
          const rows = browserHash
            ? await db.pendingSignUp.findMany({
                where: {browserHash, usedAt: null, expiresAt: {gt: now}},
                orderBy: {id: 'desc'},
                take: PENDING_PER_BROWSER,
                select: pendingSelect,
              })
            : [];
          row = null;
          for (const one of rows) {
            if (await accepted(window => tokenFor(c.var.secret, one.email, window), input.token)) row = one;
          }
          if (!row) return c.json(problem('invalid_token', GENERIC.badLink), 400);
        } else {
          // A code can be guessed: this total per address is what stops that (`RATE_LIMITS.codecheck`).
          const email = input.email!;
          const keys = await keysFor(c, `signup:${email}`);
          ipHash = keys.ipHash;
          const taken = await attempt(c, 'codecheck', keys, {subjectHint: RESEND_HINT});
          if (taken.stop) return taken.stop;
          attemptId = taken.id;
          row = browserHash
            ? await db.pendingSignUp.findFirst({where: {email, browserHash, usedAt: null, expiresAt: {gt: now}}, select: pendingSelect})
            : null;
          const right = await accepted(window => codeFor(c.var.secret, email, window), input.code!);
          if (!row || !right) return c.json(problem('invalid_code', GENERIC.wrong), 401);
        }
        const pending = row;
        const email = pending.email;

        const existing = await db.user.findUnique({where: {email}, select: {id: true, emailVerifiedAt: true, status: true}});
        if (existing && existing.status !== 'active') {
          return c.json(problem('account_suspended', 'This account is suspended. Contact the site owner.'), 403);
        }
        if (!existing && settings.registration !== 'open') {
          return c.json(problem('registration_closed', 'Sign-up is closed on this site.'), 403);
        }
        // One use: only the request that marks it used goes on.
        const {count} = await db.pendingSignUp.updateMany({where: {id: pending.id, usedAt: null}, data: {usedAt: now}});
        if (count !== 1) return c.json(problem('invalid_code', GENERIC.wrong), 401);
        await settle(c, attemptId, true);

        const taken = () => c.json(problem('email_taken', 'This email already has an account. Sign in instead.'), 409);
        // Someone finished first, or the address got an account since. Its password stays: sign in.
        if (existing?.emailVerifiedAt) return taken();
        if (existing) {
          await claimUnconfirmed(db, existing.id, {now, set: {passwordHash: pending.passwordHash, name: pending.name}});
        } else {
          try {
            await db.user.create({
              data: {
                email,
                name: pending.name,
                passwordHash: pending.passwordHash,
                emailVerifiedAt: now,
                lastLoginAt: now,
                roles: {create: {role: {connect: {slug: settings.defaultRole}}}},
              },
              select: {id: true},
            });
          } catch (err) {
            // A concurrent sign-up with the same address won the unique index.
            if ((err as {code?: string}).code === 'P2002') return taken();
            throw err;
          }
        }
        const user = await db.user.findUniqueOrThrow({
          where: {email},
          select: {id: true, name: true, email: true, status: true, emailVerifiedAt: true, sessionVersion: true},
        });
        // Everyone else's waiting sign-ups for this address are over.
        await db.pendingSignUp.updateMany({where: {email, usedAt: null}, data: {usedAt: now}});
        await audit(db, {actorUserId: user.id, action: 'user_registered', target: ['user', user.id], ipHash});
        await startSession(c, user, ipHash);
        maybeSweep(c);
        return c.json({ok: true, user: publicUser(user), next: safeNext(input.next, settings.afterSignInPath)}, 201);
      }
    );
}
