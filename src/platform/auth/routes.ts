import {Hono} from 'hono';

import {requireAuth, withAuthCore, withViewer, problem} from '../guards';
import {audit} from './audit';
import {emailAccepted, EMAIL_NOT_REAL} from './email-check';
import {sha256Hex} from './encoding';
import {signAccessToken} from './jwt';
import {hashPassword, DUMMY_PASSWORD_HASH, PASSWORD_LIMITS, passwordProblem, verifyPassword} from './password';
import {rotate, revokeByToken} from './refresh';
import {normalizeEmail, safeNext} from './input';
import {
  allowed,
  attempt,
  background,
  body,
  clearSession,
  type Ctx,
  type Env,
  type FieldErrors,
  invalid,
  keysFor,
  maybeSweep,
  newLinkToken,
  NO_PASSWORD,
  publicUser,
  raw,
  refreshCookieOf,
  sendEmail,
  setSession,
  settle,
  startSession,
  text,
} from './kit';
import {codeRoutes} from './code-routes';
import {claimOwnerIfFirst, ownerAddressUnclaimed, ownerRoutes} from './owner';
import {securityRoutes} from './security-routes';
import {signChallenge} from './two-factor';
import {getAccess} from './session';
import {type AuthSettings} from './settings';
import {attemptStore, refreshStore, sweep} from './store';

/**
 * `/site-api/auth/*`: this site's own sign-in (docs/agent/auth.md).
 *
 *   GET   /csrf                 the CSRF token (also set as a cookie)
 *   POST  /register             {email, password, name}
 *   POST  /verify-email         {token}
 *   POST  /resend-verification  {email}                  always the same answer
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


const RESET_TTL_MINUTES = 30;
const VERIFY_TTL_HOURS = 24;

const GENERIC = {
  login: 'Email or password is incorrect.',
  forgot: `If an account exists for that email, we sent a link to reset its password. The link works for ${RESET_TTL_MINUTES} minutes.`,
  registered: 'Check your inbox: we sent a link to confirm your email address.',
  resend: 'If that email has an account waiting for confirmation, we sent a new link.',
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
 * Emails a single-use reset link (30 minutes); older unused links stop working.
 * Used by Forgot password and to let an owner address choose its own password.
 */
async function issuePasswordReset(c: Ctx, user: {id: number; email: string}, ipHash: string) {
  const db = c.var.db;
  const now = new Date();
  await db.passwordReset.updateMany({where: {userId: user.id, usedAt: null}, data: {usedAt: now}});
  const token = newLinkToken();
  await db.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(now.getTime() + RESET_TTL_MINUTES * 60 * 1000),
      ipHash,
    },
    select: {id: true},
  });
  await audit(db, {actorUserId: null, action: 'password_reset_requested', target: ['user', user.id], ipHash});
  sendEmail(c, {
    kind: 'password_reset',
    to: user.email,
    path: `/account/reset/?token=${token}`,
    expiresInMinutes: RESET_TTL_MINUTES,
  });
}


// ----------------------------------------------------------------- routes --

export function authRoutes(settings: AuthSettings) {
  return (
    new Hono<Env>()
      .route('/', ownerRoutes(settings))
      .route('/', codeRoutes(settings))
      .route('/', securityRoutes(settings))
      .get('/csrf', c => {
        // `csrf` (app-wide) has already set the cookie when it was missing;
        // the page script reads it from `document.cookie`.
        c.header('Cache-Control', 'no-store');
        return c.json({ok: true});
      })

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

          // Hash first, always: the taken-email path then costs the same.
          const passwordHash = await hashPassword(password);
          const db = c.var.db;
          const findTaken = () =>
            db.user.findUnique({
              where: {email},
              select: {id: true, email: true, status: true, emailVerifiedAt: true},
            });
          // The address already has an account (found first, or a concurrent sign-up won the
          // unique index: both take this path, so a race can't keep the first password).
          const answerTaken = async (taken: NonNullable<Awaited<ReturnType<typeof findTaken>>>) => {
            if (!settings.requireEmailVerification) {
              return c.json(
                problem('email_taken', 'An account with this email already exists. Sign in instead.'),
                409
              );
            }
            if (taken.status === 'active' && !taken.emailVerifiedAt) {
              // Two sign-ups for one unconfirmed address: nobody can tell which one owns
              // the inbox, so NEITHER password is kept (taking the second would let a
              // late attacker replace the real person's; keeping the first would let an
              // early squatter keep theirs). Older links stop working; whoever opens the
              // new one confirms the address and then chooses the password by email.
              const now = new Date();
              await db.user.updateMany({
                where: {id: taken.id, emailVerifiedAt: null},
                data: {passwordHash: NO_PASSWORD, sessionVersion: {increment: 1}},
              });
              await db.emailVerification.updateMany({where: {userId: taken.id, usedAt: null}, data: {usedAt: now}});
              if (await allowed(c, 'verify', keys)) background(c, createVerification(c, taken));
            } else if (await allowed(c, 'verify', keys)) {
              // Tell the address's owner, not the visitor (rate-limited like a resend).
              sendEmail(c, {kind: 'account_exists', to: email, path: '/account/login/'});
            }
            return c.json({ok: true, message: GENERIC.registered}, 202);
          };
          const taken = await findTaken();
          if (taken) return answerTaken(taken);

          let user: {id: number; email: string; name: string; emailVerifiedAt: Date | null; sessionVersion: number};
          try {
            user = await db.user.create({
              data: {
                email,
                name,
                passwordHash,
                roles: {create: {role: {connect: {slug: settings.defaultRole}}}},
              },
              select: {id: true, email: true, name: true, emailVerifiedAt: true, sessionVersion: true},
            });
          } catch (err) {
            // A concurrent sign-up with the same email won the unique index: answer as if it was
            // found first (second review: the loser used to return here, keeping the winner's password).
            if ((err as {code?: string}).code === 'P2002') {
              const winner = await findTaken();
              return winner ? answerTaken(winner) : c.json({ok: true, message: GENERIC.registered}, 202);
            }
            throw err;
          }
          const registered = audit(db, {
            actorUserId: user.id,
            action: 'user_registered',
            target: ['user', user.id],
            ipHash: keys.ipHash,
          });

          if (settings.requireEmailVerification) {
            // After the answer, so a new email and a taken one answer alike.
            background(c, registered.then(() => createVerification(c, user)));
            return c.json({ok: true, message: GENERIC.registered}, 202);
          }
          await registered;
          // Nothing is proven yet: only the no-list claim (`first`) can apply. An owner
          // address gets a link to choose its password, and claims owner through it.
          await claimOwnerIfFirst(c, settings, user, keys.ipHash, 'register');
          if (await ownerAddressUnclaimed(c, settings, user.email)) {
            background(c, issuePasswordReset(c, user, keys.ipHash));
          }
          await startSession(c, user, keys.ipHash);
          return c.json({ok: true, user: publicUser(user), next: settings.afterSignInPath}, 201);
        }
      )

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
              user: {select: {email: true, status: true, passwordHash: true}},
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
          await db.user.updateMany({where: {id: row.userId, emailVerifiedAt: null}, data: {emailVerifiedAt: now}});
          const {ipHash} = await keysFor(c, null);
          await audit(db, {actorUserId: row.userId, action: 'email_verified', target: ['user', row.userId], ipHash});
          const user = {id: row.userId, email: row.email};
          // Contested (signed up twice, see /register) or an owner address: whoever
          // registered chose the password, and that may not be the person who owns the
          // inbox. The password is dropped (every session ends) and the inbox gets a
          // link to choose one; for an owner address, owner goes with it.
          const contested = row.user.passwordHash === NO_PASSWORD;
          if (contested || (await ownerAddressUnclaimed(c, settings, user.email))) {
            await db.user.update({
              where: {id: user.id},
              data: {passwordHash: NO_PASSWORD, sessionVersion: {increment: 1}},
              select: {id: true},
            });
            await refreshStore(db).revokeAllForUser(user.id, now, 'password');
            await issuePasswordReset(c, user, ipHash);
            return c.json({
              ok: true,
              setPassword: true,
              message: `Your email is confirmed. We sent you a link to choose your password. Open it within ${RESET_TTL_MINUTES} minutes to finish.`,
            });
          }
          await claimOwnerIfFirst(c, settings, user, ipHash, 'verify');
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
              const user = await db.user.findUnique({
                where: {email},
                select: {id: true, email: true, status: true, emailVerifiedAt: true},
              });
              if (user && user.status === 'active' && !user.emailVerifiedAt) await createVerification(c, user);
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
          const {stop, id: attemptId} = await attempt(c, 'login', keys);
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
            // The attempt's row already counts as a failure.
            maybeSweep(c);
            return c.json(problem('invalid_credentials', GENERIC.login), 401);
          }
          await settle(c, attemptId, true);

          // The password is right: from here on it is safe to say what is wrong.
          if (user.status !== 'active') {
            return c.json(problem('account_suspended', 'This account is suspended. Contact the site owner.'), 403);
          }
          if (settings.requireEmailVerification && !user.emailVerifiedAt) {
            if (await allowed(c, 'verify', keys)) await createVerification(c, user);
            return c.json(
              problem('email_unverified', 'Confirm your email address first. We sent you a new link.'),
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
        const user = await db.user.findUnique({
          where: {id: result.userId},
          select: {id: true, status: true, sessionVersion: true},
        });
        if (!user || user.status !== 'active') {
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
        await db.user.update({where: {id}, data: {sessionVersion: {increment: 1}}, select: {id: true}});
        await refreshStore(db).revokeAllForUser(id, new Date(), 'logout_all');
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
              const user = await db.user.findUnique({where: {email}, select: {id: true, email: true, status: true}});
              if (user && user.status === 'active') await issuePasswordReset(c, user, keys.ipHash);
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
            select: {id: true, userId: true, expiresAt: true, usedAt: true, user: {select: {email: true, status: true}}},
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

          await db.user.update({
            where: {id: row.userId},
            data: {
              passwordHash: await hashPassword(password),
              sessionVersion: {increment: 1},
            },
            select: {id: true},
          });
          // Following the link proves the inbox: confirm the email if it was not yet.
          await db.user.updateMany({where: {id: row.userId, emailVerifiedAt: null}, data: {emailVerifiedAt: now}});
          await refreshStore(db).revokeAllForUser(row.userId, now, 'password');
          const {ipHash} = await keysFor(c, null);
          await audit(db, {actorUserId: row.userId, action: 'password_reset', target: ['user', row.userId], ipHash});
          // The inbox is proven AND this person chose the password: an owner address claims owner here.
          await claimOwnerIfFirst(c, settings, {id: row.userId, email: row.user.email}, ipHash, 'reset');
          sendEmail(c, {kind: 'password_changed', to: row.user.email});
          clearSession(c);
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

          const updated = await db.user.update({
            where: {id},
            data: {passwordHash: await hashPassword(newPassword), sessionVersion: {increment: 1}},
            select: {id: true, sessionVersion: true},
          });
          // Every other device signs in again; this one gets a fresh session.
          await refreshStore(db).revokeAllForUser(id, new Date(), 'password');
          await startSession(c, updated, keys.ipHash);
          await audit(db, {actorUserId: id, action: 'password_changed', target: ['user', id], ipHash: keys.ipHash});
          sendEmail(c, {kind: 'password_changed', to: user.email});
          return c.json({ok: true, message: 'Password changed. Other devices are signed out.'});
        }
      )
  );
}
