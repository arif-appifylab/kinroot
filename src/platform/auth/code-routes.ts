import {Hono} from 'hono';

import {problem, withAuthCore} from '../guards';
import {audit} from './audit';
import {toHex, utf8} from './encoding';
import {normalizeEmail, safeNext} from './input';
import {hmacKey} from './keys';
import {attempt, body, type Ctx, type Env, invalid, keysFor, maybeSweep, publicUser, sendEmail, settle, startSession, text} from './kit';
import {ensureOwnerAccounts} from './owner';
import {type AuthSettings} from './settings';
import {signChallenge} from './two-factor';

/**
 * Sign in with a code: no password needed (docs/agent/auth.md). The site's admin signs in this
 * way by default; every account may.
 *
 *   POST /code         {email, next?}        emails a 6-digit code; always the same answer
 *   POST /code/verify  {email, code, next?}  the code → a session, or the two-step challenge
 *
 * A code works once, for 10 minutes; 5 wrong tries spend it; a new code ends the older ones. Only
 * its keyed hash is stored (HMAC with a key of its own, bound to the account), and the answer never
 * says whether an email has an account. A code proves the inbox, so it also confirms the address.
 * With two-step sign-in on, the code is the first step only: `/login/two-factor` finishes it.
 */

export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_TRIES = 5;

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
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueCode(c: Ctx, user: {id: number; email: string}, ipHash: string) {
  const db = c.var.db;
  const now = new Date();
  // One live code per account: a new one ends the others.
  await db.signInCode.updateMany({where: {userId: user.id, usedAt: null}, data: {usedAt: now}});
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
  sendEmail(c, {kind: 'sign_in_code', to: user.email, code, expiresInMinutes: CODE_TTL_MINUTES});
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
        // The admin's account is made before its first code (owner.ts), so the owner can always sign in.
        await ensureOwnerAccounts(c, settings, keys.ipHash);
        const user = await c.var.db.user.findUnique({where: {email}, select: {id: true, email: true, status: true}});
        if (user && user.status === 'active') await issueCode(c, user, keys.ipHash);
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
        const keys = await keysFor(c, email);
        const {stop, id: attemptId} = await attempt(c, 'codecheck', keys);
        if (stop) return stop;
        const wrong = () => c.json(problem('invalid_code', GENERIC.wrong), 401);

        const user = await db.user.findUnique({
          where: {email},
          select: {id: true, name: true, email: true, status: true, emailVerifiedAt: true, sessionVersion: true, totpEnabledAt: true},
        });
        const now = new Date();
        const row = user
          ? await db.signInCode.findFirst({
              where: {userId: user.id, usedAt: null, expiresAt: {gt: now}},
              orderBy: {id: 'desc'},
              select: {id: true, codeHash: true, tries: true},
            })
          : null;
        // No account or no live code: the same work and answer as a wrong code.
        const hash = await codeHash(c.var.secret, user?.id ?? 0, code);
        if (!user || !row) return wrong();
        if (!sameHex(hash, row.codeHash)) {
          const tries = row.tries + 1;
          await db.signInCode.update({
            where: {id: row.id},
            data: {tries, ...(tries >= CODE_MAX_TRIES ? {usedAt: now} : {})},
            select: {id: true},
          });
          return wrong();
        }
        // One use: only the request that marks it used goes on.
        const {count} = await db.signInCode.updateMany({where: {id: row.id, usedAt: null}, data: {usedAt: now}});
        if (count !== 1) return wrong();
        await settle(c, attemptId, true);

        if (user.status !== 'active') {
          return c.json(problem('account_suspended', 'This account is suspended. Contact the site owner.'), 403);
        }
        await db.user.update({
          where: {id: user.id},
          // The code proved the inbox: the address is confirmed.
          data: {lastLoginAt: now, ...(user.emailVerifiedAt ? {} : {emailVerifiedAt: now})},
          select: {id: true},
        });
        await audit(db, {actorUserId: user.id, action: 'signed_in_with_code', target: ['user', user.id], ipHash: keys.ipHash});
        if (user.totpEnabledAt) {
          return c.json(
            {
              ok: false,
              twoFactor: true,
              challenge: await signChallenge(c.var.secret, user.id, user.sessionVersion),
              message: 'Enter the 6-digit code from your authenticator app.',
            },
            202
          );
        }
        await startSession(c, user, keys.ipHash);
        maybeSweep(c);
        return c.json({ok: true, user: publicUser(user), next: safeNext(next, settings.afterSignInPath)});
      }
    );
}
