import {Hono} from 'hono';

import {requireAuth, withAuthCore, withViewer, problem} from '../guards';
import {audit} from './audit';
import {sha256Hex} from './encoding';
import {signAccessToken} from './jwt';
import {claimUnconfirmed, endAccess} from './end-access';
import {hashPassword, DUMMY_PASSWORD_HASH, PASSWORD_LIMITS, passwordProblem, verifyPassword} from './password';
import {rotate, revokeByToken} from './refresh';
import {pendingFromLogin, resendPending, SIGN_UP_CODE_PATH, signUpRoutes} from './sign-up';
import {normalizeEmail, safeNext} from './input';
import {
  attempt,
  background,
  body,
  clearSession,
  type Ctx,
  deviceTrusted,
  type Env,
  forgiveAddress,
  type FieldErrors,
  invalid,
  keysFor,
  mailDue,
  maybeSweep,
  newLinkToken,
  newResetPath,
  RESET_TTL_MINUTES,
  notForOwnerAccount,
  publicUser,
  raw,
  refreshCookieOf,
  rememberDevice,
  sendEmail,
  setSession,
  settledSessionVersion,
  settle,
  startSession,
  text,
} from './kit';
import {codeRoutes} from './code-routes';
import {ownerRoutes, stillOwner} from './owner';
import {securityRoutes} from './security-routes';
import {signChallenge} from './two-factor';
import {getAccess} from './session';
import {type AuthSettings} from './settings';
import {refreshStore} from './store';

/**
 * `/site-api/auth/*`: this site's own sign-in (docs/agent/auth.md).
 *
 *   GET   /csrf                 the CSRF token (also set as a cookie)
 *   POST  /register             {email, password, name}  a pending sign-up + an emailed code (sign-up.ts)
 *   POST  /register/verify      {email, code}            the code → the account, signed in
 *   POST  /resend-verification  {email}                  a new code or link; always the same answer
 *   POST  /verify-email         {token}                  a link emailed before sign-up took a code
 *   POST  /login                {email, password}
 *   POST  /refresh              rotates the refresh cookie, new access cookie
 *   POST  /logout               this device
 *   POST  /logout-all           every device (signed in)
 *   GET   /me                   the viewer + roles + permissions (signed in)
 *   PATCH /me                   {name} (signed in)
 *   POST  /forgot-password      {email}                  always the same answer
 *   POST  /reset-password       {token, password}        single use, 30 minutes
 *   POST  /change-password      {currentPassword, newPassword} (signed in)
 *   POST  /code                 {email}                  emails a 6-digit sign-in code (code-routes.ts)
 *   POST  /code/verify          {email, code}            signs in with it (two-step sign-in still asks)
 *   GET   /owner?ticket=…       one click from the dashboard into the admin (owner.ts); POST in the Preview
 *   …and two-step sign-in, new email, devices, delete account (security-routes.ts)
 *
 * With two-step sign-in on, `/login` answers 202 {twoFactor: true, challenge} instead of a
 * session; `/login/two-factor` {challenge, code} finishes it.
 *
 * Errors never say whether an email has an account (login, forgot, resend,
 * register with verification on): the same words, the same status, and the
 * same password-hashing work either way.
 */


const VERIFY_TTL_HOURS = 24;

const GENERIC = {
  login: 'Email or password is incorrect.',
  forgot: `If an account exists for that email, we sent a link to reset its password. The link works for ${RESET_TTL_MINUTES} minutes.`,
  resend: 'If that email is waiting for confirmation, we sent a new code.',
  badLink: 'This link has expired or was already used. Ask for a new one.',
};


async function createVerification(c: Ctx, user: {id: number; email: string}) {
  const token = newLinkToken();
  await c.var.db.emailVerification.create({
    data: {
      userId: user.id,
      email: user.email,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 3600 * 1000),
    },
    select: {id: true},
  });
  sendEmail(c, {
    kind: 'verify_email',
    to: user.email,
    path: `/account/verify/?token=${token}`,
    expiresInMinutes: VERIFY_TTL_HOURS * 60,
  });
}

/**
 * Emails a single-use reset link (30 minutes). Older ones stay good: a stranger asking must not end
 * the link a person is about to open. A security event ends them all (`endAccess`).
 * Used by Forgot password and to let an inbox choose a password after one was dropped.
 */
async function issuePasswordReset(c: Ctx, user: {id: number; email: string}, ipHash: string) {
  const path = await newResetPath(c, user.id, ipHash);
  await audit(c.var.db, {actorUserId: null, action: 'password_reset_requested', target: ['user', user.id], ipHash});
  sendEmail(c, {kind: 'password_reset', to: user.email, path, expiresInMinutes: RESET_TTL_MINUTES});
}


// ----------------------------------------------------------------- routes --

export function authRoutes(settings: AuthSettings) {
  return (
    new Hono<Env>()
      .route('/', ownerRoutes(settings))
      .route('/', codeRoutes(settings))
      .route('/', signUpRoutes(settings))
      .route('/', securityRoutes(settings))
      .get('/csrf', c => {
        // `csrf` (app-wide) has already set the cookie when it was missing;
        // the page script reads it from `document.cookie`.
        c.header('Cache-Control', 'no-store');
        return c.json({ok: true});
      })

      .post(
        '/verify-email',
        body((v, c) => {
          const token = text(v.token, 64);
          return /^[A-Za-z0-9_-]{43}$/.test(token) ? {token} : c.json(problem('invalid_token', GENERIC.badLink), 400);
        }),
        withAuthCore,
        async c => {
          const db = c.var.db;
          const row = await db.emailVerification.findUnique({
            where: {tokenHash: await sha256Hex(c.req.valid('json').token)},
            select: {
              id: true,
              userId: true,
              email: true,
              expiresAt: true,
              usedAt: true,
              user: {select: {email: true, status: true, emailVerifiedAt: true}},
            },
          });
          const now = new Date();
          if (
            !row ||
            row.usedAt ||
            row.expiresAt <= now ||
            row.user.email !== row.email ||
            row.user.status !== 'active'
          ) {
            return c.json(problem('invalid_token', GENERIC.badLink), 400);
          }
          const {count} = await db.emailVerification.updateMany({where: {id: row.id, usedAt: null}, data: {usedAt: now}});
          if (count !== 1) return c.json(problem('invalid_token', GENERIC.badLink), 400);
          const {ipHash} = await keysFor(c, null);
          await audit(db, {actorUserId: row.userId, action: 'email_verified', target: ['user', row.userId], ipHash});
          // A link proves the inbox and nothing else: whoever registered chose the password, and that
          // may not be this person. It goes, and the inbox gets a link to choose one.
          if (!row.user.emailVerifiedAt && (await claimUnconfirmed(db, row.userId, {now}))) {
            await issuePasswordReset(c, {id: row.userId, email: row.email}, ipHash);
            return c.json({
              ok: true,
              setPassword: true,
              message: `Your email is confirmed. We sent you a link to choose your password. Open it within ${RESET_TTL_MINUTES} minutes to finish.`,
            });
          }
          return c.json({ok: true, message: 'Your email is confirmed. You can sign in now.'});
        }
      )

      .post(
        '/resend-verification',
        body((v, c) => {
          const email = normalizeEmail(v.email);
          return email ? {email} : invalid(c, {email: 'Enter a valid email address, like name@example.com.'});
        }),
        withAuthCore,
        async c => {
          const {email} = c.req.valid('json');
          const keys = await keysFor(c, email);
          const {stop} = await attempt(c, 'verify', keys);
          if (stop) return stop;
          // After the answer, so an address with an account answers as fast as one without.
          const db = c.var.db;
          background(
            c,
            (async () => {
              if (await resendPending(c, email, keys)) return;
              const user = await db.user.findUnique({
                where: {email},
                select: {id: true, email: true, status: true, emailVerifiedAt: true},
              });
              if (user && user.status === 'active' && !user.emailVerifiedAt && (await mailDue(c, keys))) await createVerification(c, user);
            })()
          );
          return c.json({ok: true, message: GENERIC.resend}, 202);
        }
      )

      .post(
        '/login',
        body((v, c) => {
          const email = normalizeEmail(v.email);
          const password = raw(v.password);
          const fields: FieldErrors = {};
          if (!email) fields.email = 'Enter a valid email address, like name@example.com.';
          if (!password) fields.password = 'Enter your password.';
          return Object.keys(fields).length
            ? invalid(c, fields)
            : {email: email!, password: password.slice(0, PASSWORD_LIMITS.max * 2), next: v.next};
        }),
        withAuthCore,
        async c => {
          const {email, password, next} = c.req.valid('json');
          const db = c.var.db;
          const keys = await keysFor(c, email);
          const {stop, id: attemptId} = await attempt(c, 'login', keys, {
            trusted: await deviceTrusted(c, email),
            subjectHint: 'Too many wrong passwords for this email from different places. Check your inbox for a link from us, or use Forgot password. It works from any browser.',
          });
          if (stop) return stop;

          const user = await db.user.findUnique({
            where: {email},
            select: {
              id: true,
              name: true,
              email: true,
              passwordHash: true,
              status: true,
              emailVerifiedAt: true,
              sessionVersion: true,
              totpEnabledAt: true,
            },
          });
          // Unknown email: verify against a dummy hash, so it takes as long as a wrong password.
          const check = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
          if (!user || !check.ok) {
            // The attempt's row already counts as a failure. Worth a record only when it names an account.
            if (user) background(c, audit(db, {actorUserId: null, action: 'sign_in_failed', target: ['user', user.id], ipHash: keys.ipHash}));
            maybeSweep(c);
            return c.json(problem('invalid_credentials', GENERIC.login), 401);
          }
          await settle(c, attemptId, true);

          // The password is right: from here on it is safe to say what is wrong.
          if (user.status !== 'active') {
            return c.json(problem('account_suspended', 'This account is suspended. Contact the site owner.'), 403);
          }
          if (!user.emailVerifiedAt) {
            // This browser knows the password; a code from the inbox makes the second half of the proof.
            await pendingFromLogin(c, user, keys);
            return c.json(
              {
                ...problem('email_unverified', 'Confirm your email address first. We sent you a 6-digit code.'),
                needsCode: true,
                next: SIGN_UP_CODE_PATH,
              },
              403
            );
          }

          await db.user.update({
            where: {id: user.id},
            data: {
              lastLoginAt: new Date(),
              ...(check.needsRehash ? {passwordHash: await hashPassword(password)} : {}),
            },
            select: {id: true},
          });
          await audit(db, {actorUserId: user.id, action: 'signed_in_with_password', target: ['user', user.id], ipHash: keys.ipHash});
          if (user.totpEnabledAt) {
            // Two-step sign-in: no session until the code (POST /login/two-factor).
            maybeSweep(c);
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
      )

      .post('/refresh', withAuthCore, async c => {
        const token = refreshCookieOf(c);
        if (!token) return c.json(problem('signed_out', 'Sign in again.'), 401);
        const db = c.var.db;
        const {ipHash} = await keysFor(c, null);
        const result = await rotate(refreshStore(db), token, {userAgent: c.req.header('user-agent') ?? null, ipHash});

        if (result.kind === 'race') {
          // Another tab refreshed a moment ago: the browser already holds its cookies.
          return c.json(problem('refresh_race', 'Already refreshed. Retry the request.'), 409);
        }
        if (result.kind === 'reuse') {
          await audit(db, {
            actorUserId: null,
            action: 'refresh_reuse_detected',
            target: ['user', result.userId],
            ipHash,
            meta: {family: result.familyId},
          });
        }
        if (result.kind !== 'ok') {
          clearSession(c);
          return c.json(problem('signed_out', 'Sign in again.'), 401);
        }
        // An `endAccess` may have been running while the new token went in: wait for it, then look again.
        await settledSessionVersion(db, result.userId);
        if (await refreshStore(db).familyRevoked(result.familyId)) {
          await refreshStore(db).revokeFamily(result.familyId, new Date(), 'password');
          clearSession(c);
          return c.json(problem('signed_out', 'Sign in again.'), 401);
        }
        const user = await db.user.findUnique({
          where: {id: result.userId},
          select: {id: true, status: true, sessionVersion: true, platformOwnerId: true},
        });
        if (!user || user.status !== 'active' || (user.platformOwnerId && !(await stillOwner(c, user.id, user.platformOwnerId)))) {
          await refreshStore(db).revokeFamily(result.familyId, new Date(), 'suspended');
          clearSession(c);
          return c.json(problem('signed_out', 'Sign in again.'), 401);
        }
        const access = await signAccessToken(c.var.secret, {
          userId: user.id,
          familyId: result.familyId,
          sessionVersion: user.sessionVersion,
        });
        setSession(c, access, result.token, result.expiresAt);
        return c.json({ok: true});
      })

      .post('/logout', withAuthCore, async c => {
        const token = refreshCookieOf(c);
        if (token) await revokeByToken(refreshStore(c.var.db), token);
        clearSession(c);
        return c.json({ok: true});
      })

      .post('/logout-all', withViewer, requireAuth, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const db = c.var.db;
        await endAccess(db, id, 'logout_all');
        const {ipHash} = await keysFor(c, null);
        await audit(db, {actorUserId: id, action: 'logout_all', target: ['user', id], ipHash});
        clearSession(c);
        return c.json({ok: true});
      })

      .get('/me', withViewer, requireAuth, withAuthCore, async c => {
        const access = await getAccess(c.req.raw);
        return c.json({user: c.var.viewer, roles: access.roles, permissions: access.permissions});
      })

      .patch(
        '/me',
        body((v, c) => {
          const name = text(v.name, 80);
          if (!name) return invalid(c, {name: 'Enter your name.'});
          if (name.length > 80) return invalid(c, {name: 'Use at most 80 characters.'});
          return {name};
        }),
        withViewer,
        requireAuth,
        withAuthCore,
        async c => {
          const user = await c.var.db.user.update({
            where: {id: c.var.viewer.id!},
            data: {name: c.req.valid('json').name},
            select: {id: true, name: true, email: true, emailVerifiedAt: true},
          });
          return c.json({user: publicUser(user)});
        }
      )

      .post(
        '/forgot-password',
        body((v, c) => {
          const email = normalizeEmail(v.email);
          return email ? {email} : invalid(c, {email: 'Enter a valid email address, like name@example.com.'});
        }),
        withAuthCore,
        async c => {
          const {email} = c.req.valid('json');
          const db = c.var.db;
          const keys = await keysFor(c, email);
          const {stop} = await attempt(c, 'reset', keys);
          if (stop) return stop;

          // After the answer, so an address with an account answers as fast as one without.
          background(
            c,
            (async () => {
              const user = await db.user.findUnique({where: {email}, select: {id: true, email: true, status: true, emailVerifiedAt: true}});
              if (!user || user.status !== 'active') {
                await mailDue(c, keys);
                return;
              }
              // Never confirmed: the last email may be a sign-up code that only works in a stranger's browser.
              if (await mailDue(c, user.emailVerifiedAt ? keys : await keysFor(c, `unconfirmed:${email}`))) {
                await issuePasswordReset(c, user, keys.ipHash);
              }
            })()
          );
          return c.json({ok: true, message: GENERIC.forgot}, 202);
        }
      )

      .post(
        '/reset-password',
        body((v, c) => {
          const token = text(v.token, 64);
          const password = raw(v.password);
          if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return c.json(problem('invalid_token', GENERIC.badLink), 400);
          const weak = passwordProblem(password);
          return weak ? invalid(c, {password: weak}) : {token, password};
        }),
        withAuthCore,
        async c => {
          const {token, password} = c.req.valid('json');
          const db = c.var.db;
          const row = await db.passwordReset.findUnique({
            where: {tokenHash: await sha256Hex(token)},
            select: {id: true, userId: true, expiresAt: true, usedAt: true, user: {select: {email: true, status: true, emailVerifiedAt: true}}},
          });
          const now = new Date();
          if (!row || row.usedAt || row.expiresAt <= now || row.user.status !== 'active') {
            return c.json(problem('invalid_token', GENERIC.badLink), 400);
          }
          const weak = passwordProblem(password, row.user.email);
          if (weak) return invalid(c, {password: weak});
          // Single use: the conditional update is the lock.
          const {count} = await db.passwordReset.updateMany({where: {id: row.id, usedAt: null}, data: {usedAt: now}});
          if (count !== 1) return c.json(problem('invalid_token', GENERIC.badLink), 400);

          const passwordHash = await hashPassword(password);
          // Following the link proves the inbox: on an account never confirmed, nothing set before this stays.
          if (!row.user.emailVerifiedAt) await claimUnconfirmed(db, row.userId, {now, set: {passwordHash}});
          else await endAccess(db, row.userId, 'password', {now, set: {passwordHash}});
          const {ipHash, emailHash} = await keysFor(c, row.user.email);
          // The link proved the inbox: strangers' failed attempts no longer stand in this person's way.
          await forgiveAddress(db, emailHash);
          await audit(db, {actorUserId: row.userId, action: 'password_reset', target: ['user', row.userId], ipHash});
          sendEmail(c, {kind: 'password_changed', to: row.user.email});
          clearSession(c);
          // This browser just proved the inbox, so strangers still guessing can't lock it out of the new password.
          const version = await settledSessionVersion(db, row.userId);
          if (version !== null) await rememberDevice(c, row.user.email, version);
          return c.json({ok: true, message: 'Your password is changed. Sign in with the new one.'});
        }
      )

      .post(
        '/change-password',
        body((v, c) => {
          const currentPassword = raw(v.currentPassword);
          const newPassword = raw(v.newPassword);
          const fields: FieldErrors = {};
          if (!currentPassword) fields.currentPassword = 'Enter your current password.';
          const weak = passwordProblem(newPassword);
          if (weak) fields.newPassword = weak;
          else if (newPassword === currentPassword) fields.newPassword = 'Choose a password you have not used here.';
          return Object.keys(fields).length
            ? invalid(c, fields)
            : {currentPassword: currentPassword.slice(0, PASSWORD_LIMITS.max * 2), newPassword};
        }),
        withViewer,
        requireAuth,
        notForOwnerAccount,
        withAuthCore,
        async c => {
          const {currentPassword, newPassword} = c.req.valid('json');
          const db = c.var.db;
          const id = c.var.viewer.id!;
          const keys = await keysFor(c, `user:${id}`);
          const {stop, id: attemptId} = await attempt(c, 'password', keys);
          if (stop) return stop;

          const user = await db.user.findUnique({where: {id}, select: {email: true, passwordHash: true}});
          if (!user || !(await verifyPassword(currentPassword, user.passwordHash)).ok) {
            return invalid(c, {currentPassword: 'That is not your current password.'});
          }
          await settle(c, attemptId, true);
          const weak = passwordProblem(newPassword, user.email);
          if (weak) return invalid(c, {newPassword: weak});

          // Every other device signs in again, and open links and codes end; this one gets a fresh session.
          await endAccess(db, id, 'password', {set: {passwordHash: await hashPassword(newPassword)}});
          const updated = (await db.user.findUnique({where: {id}, select: {id: true, email: true, sessionVersion: true}}))!;
          await startSession(c, updated, keys.ipHash);
          await audit(db, {actorUserId: id, action: 'password_changed', target: ['user', id], ipHash: keys.ipHash});
          sendEmail(c, {kind: 'password_changed', to: user.email});
          return c.json({ok: true, message: 'Password changed. Other devices are signed out.'});
        }
      )
  );
}
