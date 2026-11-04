import {Hono} from 'hono';

import {problem, withAuthCore} from '../guards';
import {audit} from './audit';
import {toHex, utf8} from './encoding';
import {normalizeEmail, safeNext} from './input';
import {hmacKey} from './keys';
import {claimUnconfirmed} from './end-access';
import {attempt, background, body, type Ctx, deviceTrusted, type Env, forgiveAddress, invalid, keysFor, mailDue, maybeSweep, newResetPath, publicUser, RESET_TTL_MINUTES, sendEmail, settle, startSession, text} from './kit';
import {type AuthSettings} from './settings';
import {signChallenge} from './two-factor';

/**
 * Sign in with a code: no password needed (docs/agent/auth.md). The site's admin signs in this
 * way by default; every account may.
 *
 *   POST /code         {email, next?}        emails a 6-digit code; always the same answer
 *   POST /code/verify  {email, code, next?}  the code → a session, or the two-step challenge
 *
 * A code works once, for 30 minutes; asking again doesn't end one someone may be typing (the newest 3
 * work, and using one ends them all), and wrong guesses don't end it either: the limits on guessing
 * are per address, so a stranger can't spend a person's code. Only
 * its keyed hash is stored (HMAC with a key of its own, bound to the account), and the answer never
 * says whether an email has an account. A code proves the inbox, so on an account never confirmed
 * it ends everything set before that (`claimUnconfirmed`): whoever registered may be a stranger.
 * With two-step sign-in on, the code is the first step only: `/login/two-factor` finishes it.
 */

export const CODE_TTL_MINUTES = RESET_TTL_MINUTES;
const LIVE_CODES = 3;

const RESET_HINT = 'Too many wrong codes for this email. Check your inbox for a link from us, or use Forgot password. It works from any browser.';

const GENERIC = {
  sent: `If that email has an account here, we sent it a 6-digit code. It works for ${CODE_TTL_MINUTES} minutes.`,
  wrong: 'That code is wrong or has expired. Check the email, or ask for a new code.',
};

/** A uniform 6-digit code (rejection sampling: no digit is likelier than another). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
}

/** The stored form: HMAC(key 'sign-in-code', `<userId>:<code>`), so a row only fits its own account. */
export async function codeHash(secret: string, userId: number, code: string): Promise<string> {
  const key = await hmacKey(secret, 'sign-in-code');
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${userId}:${code}`))));
}

/** Constant-time compare of two equal-length hex strings. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueCode(c: Ctx, user: {id: number; email: string}, ipHash: string) {
  const db = c.var.db;
  const now = new Date();
  const code = newCode();
  await db.signInCode.create({
    data: {
      userId: user.id,
      codeHash: await codeHash(c.var.secret, user.id, code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000),
      ipHash,
    },
    select: {id: true},
  });
  // A link too, in every code email. An address gets one email per gap, whoever asked for what, so a
  // stranger asking for codes must still leave a way in that no limit on guessing can block.
  sendEmail(c, {kind: 'sign_in_code', to: user.email, code, path: await newResetPath(c, user.id, ipHash), expiresInMinutes: CODE_TTL_MINUTES});
}

export function codeRoutes(settings: AuthSettings) {
  return new Hono<Env>()
    .post(
      '/code',
      body((v, c) => {
        const email = normalizeEmail(v.email);
        return email ? {email, next: v.next} : invalid(c, {email: 'Enter a valid email address, like name@example.com.'});
      }),
      withAuthCore,
      async c => {
        const {email} = c.req.valid('json');
        const keys = await keysFor(c, email);
        const {stop} = await attempt(c, 'code', keys);
        if (stop) return stop;
        // After the answer, so an address with an account answers as fast as one without.
        background(
          c,
          (async () => {
            const user = await c.var.db.user.findUnique({where: {email}, select: {id: true, email: true, status: true, emailVerifiedAt: true}});
            if (!user || user.status !== 'active') {
              await mailDue(c, keys);
              return;
            }
            // Never confirmed: the last email may be a sign-up code that only works in a stranger's
            // browser, so it can't stand in for this one. This address gets its own gap.
            const gate = user.emailVerifiedAt ? keys : await keysFor(c, `unconfirmed:${email}`);
            if (await mailDue(c, gate)) await issueCode(c, user, keys.ipHash);
          })()
        );
        maybeSweep(c);
        return c.json({ok: true, message: GENERIC.sent});
      }
    )

    .post(
      '/code/verify',
      body((v, c) => {
        const email = normalizeEmail(v.email);
        const code = text(v.code, 12).replace(/\s/g, '');
        const fields: Record<string, string> = {};
        if (!email) fields.email = 'Enter a valid email address, like name@example.com.';
        if (!/^\d{6}$/.test(code)) fields.code = 'Enter the 6-digit code from the email.';
        return Object.keys(fields).length ? invalid(c, fields) : {email: email!, code, next: v.next};
      }),
      withAuthCore,
      async c => {
        const {email, code, next} = c.req.valid('json');
        const db = c.var.db;
        // A browser that has signed in here has a budget of its own, so strangers can't use it up.
        const keys = await keysFor(c, (await deviceTrusted(c, email)) ? `${email}|device` : email);
        const {stop, id: attemptId} = await attempt(c, 'codecheck', keys, {subjectHint: RESET_HINT});
        if (stop) return stop;
        const wrong = () => c.json(problem('invalid_code', GENERIC.wrong), 401);

        const user = await db.user.findUnique({
          where: {email},
          select: {id: true, name: true, email: true, status: true, emailVerifiedAt: true, sessionVersion: true, totpEnabledAt: true},
        });
        const now = new Date();
        // The same work with or without an account, so timing doesn't say which.
        const rows = await db.signInCode.findMany({
          where: {userId: user?.id ?? 0, usedAt: null, expiresAt: {gt: now}},
          orderBy: {id: 'desc'},
          take: LIVE_CODES,
          select: {id: true, codeHash: true},
        });
        const hash = await codeHash(c.var.secret, user?.id ?? 0, code);
        const row = rows.find(one => sameHex(hash, one.codeHash));
        if (!user) return wrong();
        if (!row) return wrong();
        // One use: only the request that marks it used goes on, and the others end with it.
        const {count} = await db.signInCode.updateMany({where: {id: row.id, usedAt: null}, data: {usedAt: now}});
        if (count !== 1) return wrong();
        await db.signInCode.updateMany({where: {userId: user.id, usedAt: null}, data: {usedAt: now}});
        await settle(c, attemptId, true);
        await forgiveAddress(db, (await keysFor(c, email)).emailHash);

        if (user.status !== 'active') {
          return c.json(problem('account_suspended', 'This account is suspended. Contact the site owner.'), 403);
        }
        // First proof of this inbox: nothing set before it is this person's to inherit.
        const claimed = user.emailVerifiedAt ? false : await claimUnconfirmed(db, user.id, {now});
        await db.user.update({where: {id: user.id}, data: {lastLoginAt: now}, select: {id: true}});
        await audit(db, {actorUserId: user.id, action: 'signed_in_with_code', target: ['user', user.id], ipHash: keys.ipHash});
        // `claimUnconfirmed` changed the version and turned two-step sign-in off.
        const current = claimed ? {...user, sessionVersion: user.sessionVersion + 1, totpEnabledAt: null, emailVerifiedAt: now} : user;
        if (current.totpEnabledAt) {
          return c.json(
            {
              ok: false,
              twoFactor: true,
              challenge: await signChallenge(c.var.secret, current.id, current.sessionVersion),
              message: 'Enter the 6-digit code from your authenticator app.',
            },
            202
          );
        }
        await startSession(c, current, keys.ipHash);
        maybeSweep(c);
        return c.json({ok: true, user: publicUser(current), next: safeNext(next, settings.afterSignInPath)});
      }
    );
}
