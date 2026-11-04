import {Hono} from 'hono';
import {renderSVG} from 'uqr';

import {cache, userKey} from '../cache';
import {problem, requireAuth, withAuthCore, withViewer} from '../guards';
import {audit} from './audit';
import {ACCESS_COOKIE, cookieName, readCookie} from './cookies';
import {emailAccepted, EMAIL_NOT_REAL} from './email-check';
import {sha256Hex, toHex, utf8} from './encoding';
import {endAccess} from './end-access';
import {normalizeEmail, safeNext} from './input';
import {verifyAccessToken} from './jwt';
import {hmacKey} from './keys';
import {
  attempt,
  body,
  clearSession,
  type Ctx,
  type Env,
  type FieldErrors,
  invalid,
  keysFor,
  maybeSweep,
  NO_PASSWORD,
  newLinkToken,
  publicUser,
  raw,
  sendEmail,
  settle,
  startSession,
  text, notForOwnerAccount} from './kit';
import {PASSWORD_LIMITS, verifyPassword} from './password';
import {type AuthSettings} from './settings';
import {
  legacyRecoveryCodeHash,
  looksLikeRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  openSecret,
  otpauthUri,
  recoveryCodeHash,
  sealSecret,
  verifyChallenge,
} from './two-factor';

/**
 * `/site-api/auth/*`, account security (docs/agent/auth.md). Signed in unless noted.
 *
 *   POST   /login/two-factor        {challenge, code}   the second sign-in step (no session yet):
 *                                                      a 6-digit authenticator code or a recovery code
 *   GET    /two-factor              {enabled, recoveryCodesLeft}
 *   POST   /two-factor/setup        {password}          a new secret + QR code (not on until confirmed)
 *   POST   /two-factor/enable       {code}              confirms the app; answers 10 recovery codes ONCE
 *   POST   /two-factor/disable      {password}
 *   POST   /two-factor/recovery-codes {password}        10 new recovery codes (the old ones stop working)
 *   POST   /email                   {email, password}   mails a link to the NEW address
 *   POST   /email/confirm           {token}             (no session needed) moves the account, signs
 *                                                      every device out, tells the OLD address
 *   POST   /email/cancel            {token}             (no session needed) from the notice to the OLD
 *                                                      address: stops a change that is still waiting
 *   GET    /sessions                the devices signed in (this one marked)
 *   DELETE /sessions/:id            signs one device out
 *   POST   /delete-account          {password, confirm: "DELETE"}
 *
 * `password` is the account's current password. An account without one (it came in through
 * the dashboard's "Open admin" and never set one) confirms with `confirm: "DELETE"` (delete) or
 * needs no password (the rest): its sign-in already proved the person.
 */

const EMAIL_CHANGE_TTL_HOURS = 24;
const isPasswordless = (hash: string) => hash === NO_PASSWORD;

/** The cancel link's proof for one email change: keyed, so nobody can make one up. */
const cancelProof = async (secret: string, changeId: number) =>
  toHex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'email-change-cancel'), utf8(String(changeId)))));

/** Re-checks the current password (rate-limited per account). Null = fine; otherwise the answer. */
async function confirmPassword(c: Ctx, userId: number, password: string, kind: 'password' | 'delete') {
  const user = await c.var.db.user.findUnique({where: {id: userId}, select: {passwordHash: true}});
  if (!user) return c.json(problem('signed_out', 'Sign in again.'), 401);
  if (isPasswordless(user.passwordHash)) return null;
  const keys = await keysFor(c, `user:${userId}`);
  const {stop, id} = await attempt(c, kind, keys);
  if (stop) return stop;
  if (!password || !(await verifyPassword(password, user.passwordHash)).ok) {
    return invalid(c, {password: 'That is not your current password.'});
  }
  await settle(c, id, true);
  return null;
}

const passwordBody = body(v => ({password: raw(v.password).slice(0, PASSWORD_LIMITS.max * 2)}));

/** The access token's sign-in (refresh family), to mark "this device". */
async function currentFamily(c: Ctx): Promise<string | null> {
  const token = readCookie(c.req.header('cookie'), cookieName(ACCESS_COOKIE, c.req.url));
  if (!token) return null;
  const verified = await verifyAccessToken(c.var.secret, token);
  return verified.ok ? verified.claims.sid : null;
}

async function freshRecoveryCodes(c: Ctx, userId: number): Promise<string[]> {
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map(code => recoveryCodeHash(c.var.secret, code)));
  await c.var.db.$transaction([
    c.var.db.recoveryCode.deleteMany({where: {userId}}),
    c.var.db.recoveryCode.createMany({data: hashes.map(codeHash => ({userId, codeHash}))}),
  ]);
  return codes;
}

/** A short device name from a User-Agent: "Chrome on macOS". Never shown to anyone but the user. */
export function deviceName(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'A browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export function securityRoutes(settings: AuthSettings) {
  return (
    new Hono<Env>()
      // ------------------------------------------------------- second step --
      .post(
        '/login/two-factor',
        body((v, c) => {
          const code = text(v.code, 40);
          if (!code) return invalid(c, {code: 'Enter the 6-digit code from your app, or a recovery code.'});
          return {challenge: v.challenge, code, next: v.next};
        }),
        withAuthCore,
        async c => {
          const {challenge, code, next} = c.req.valid('json');
          const db = c.var.db;
          const claim = await verifyChallenge(c.var.secret, challenge);
          if (!claim) return c.json(problem('challenge_expired', 'This sign-in took too long. Sign in again.'), 401);
          const keys = await keysFor(c, `user:${claim.userId}`);
          const {stop, id: attemptId} = await attempt(c, 'mfa', keys);
          if (stop) return stop;

          const user = await db.user.findUnique({
            where: {id: claim.userId},
            select: {
              id: true,
              name: true,
              email: true,
              status: true,
              emailVerifiedAt: true,
              sessionVersion: true,
              totpSecretSealed: true,
              totpEnabledAt: true,
              totpLastStep: true,
            },
          });
          // A password change or "sign out everywhere" since the password step voids the challenge.
          if (!user || user.status !== 'active' || user.sessionVersion !== claim.sessionVersion || !user.totpEnabledAt) {
            return c.json(problem('challenge_expired', 'This sign-in took too long. Sign in again.'), 401);
          }

          let ok = false;
          const digits = code.replace(/\s/g, '');
          if (/^\d{6}$/.test(digits)) {
            const secret = await openSecret(c.var.secret, user.id, user.totpSecretSealed);
            const step = secret ? await matchTotp(secret, digits, user.totpLastStep) : null;
            if (step !== null) {
              // One use per code: only the request that moves `totpLastStep` forward wins.
              const {count} = await db.user.updateMany({
                where: {id: user.id, OR: [{totpLastStep: null}, {totpLastStep: {lt: step}}]},
                data: {totpLastStep: step},
              });
              ok = count === 1;
            }
          } else if (looksLikeRecoveryCode(code)) {
            const {count} = await db.recoveryCode.updateMany({
              // Older codes were stored unkeyed, and keep working until they are used or replaced.
              where: {userId: user.id, codeHash: {in: [await recoveryCodeHash(c.var.secret, code), await legacyRecoveryCodeHash(code)]}, usedAt: null},
              data: {usedAt: new Date()},
            });
            ok = count === 1;
            if (ok) await audit(db, {actorUserId: user.id, action: 'recovery_code_used', target: ['user', user.id], ipHash: keys.ipHash});
          }
          if (!ok) {
            maybeSweep(c);
            return invalid(c, {code: 'That code is not right. Try the newest code in your app.'});
          }
          await settle(c, attemptId, true);
          await db.user.update({where: {id: user.id}, data: {lastLoginAt: new Date()}, select: {id: true}});
          await startSession(c, user, keys.ipHash);
          return c.json({ok: true, user: publicUser(user), next: safeNext(next, settings.afterSignInPath)});
        }
      )

      // -------------------------------------------------------- two-step --
      .get('/two-factor', withViewer, requireAuth, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const [user, left] = await Promise.all([
          c.var.db.user.findUnique({where: {id}, select: {totpEnabledAt: true, passwordHash: true}}),
          c.var.db.recoveryCode.count({where: {userId: id, usedAt: null}}),
        ]);
        c.header('Cache-Control', 'no-store');
        return c.json({
          enabled: Boolean(user?.totpEnabledAt),
          recoveryCodesLeft: user?.totpEnabledAt ? left : 0,
          hasPassword: user ? !isPasswordless(user.passwordHash) : false,
        });
      })

      .post('/two-factor/setup', passwordBody, withViewer, requireAuth, notForOwnerAccount, withAuthCore, async c => {
        const viewer = c.var.viewer;
        const refused = await confirmPassword(c, viewer.id!, c.req.valid('json').password, 'password');
        if (refused) return refused;
        const secret = newTotpSecret();
        await c.var.db.user.update({
          where: {id: viewer.id!},
          data: {totpPendingSealed: await sealSecret(c.var.secret, viewer.id!, secret)},
          select: {id: true},
        });
        const uri = otpauthUri(new URL(c.req.url).hostname, viewer.email ?? '', secret);
        const svg = renderSVG(uri, {border: 2});
        c.header('Cache-Control', 'no-store');
        return c.json({
          secret,
          uri,
          qr: `data:image/svg+xml;base64,${btoa(svg)}`,
        });
      })

      .post(
        '/two-factor/enable',
        body((v, c) => {
          const code = text(v.code, 12).replace(/\s/g, '');
          return /^\d{6}$/.test(code) ? {code} : invalid(c, {code: 'Enter the 6-digit code from your app.'});
        }),
        withViewer,
        requireAuth,
        notForOwnerAccount,
        withAuthCore,
        async c => {
          const id = c.var.viewer.id!;
          const db = c.var.db;
          const keys = await keysFor(c, `user:${id}`);
          const {stop, id: attemptId} = await attempt(c, 'mfa', keys);
          if (stop) return stop;
          const user = await db.user.findUnique({where: {id}, select: {totpPendingSealed: true}});
          const secret = await openSecret(c.var.secret, id, user?.totpPendingSealed ?? null);
          if (!secret) return c.json(problem('setup_expired', 'Start the setup again.'), 409);
          const step = await matchTotp(secret, c.req.valid('json').code, null);
          if (step === null) return invalid(c, {code: 'That code is not right. Check the time on your phone and try the newest code.'});
          await settle(c, attemptId, true);
          await db.user.update({
            where: {id},
            data: {totpSecretSealed: user!.totpPendingSealed, totpPendingSealed: null, totpEnabledAt: new Date(), totpLastStep: step},
            select: {id: true},
          });
          const recoveryCodes = await freshRecoveryCodes(c, id);
          await audit(db, {actorUserId: id, action: 'two_factor_enabled', target: ['user', id], ipHash: keys.ipHash});
          if (c.var.viewer.email) sendEmail(c, {kind: 'two_factor_on', to: c.var.viewer.email});
          return c.json({ok: true, recoveryCodes});
        }
      )

      .post('/two-factor/disable', passwordBody, withViewer, requireAuth, notForOwnerAccount, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const refused = await confirmPassword(c, id, c.req.valid('json').password, 'password');
        if (refused) return refused;
        const db = c.var.db;
        await db.user.update({
          where: {id},
          data: {totpSecretSealed: null, totpPendingSealed: null, totpEnabledAt: null, totpLastStep: null},
          select: {id: true},
        });
        await db.recoveryCode.deleteMany({where: {userId: id}});
        const {ipHash} = await keysFor(c, null);
        await audit(db, {actorUserId: id, action: 'two_factor_disabled', target: ['user', id], ipHash});
        if (c.var.viewer.email) sendEmail(c, {kind: 'two_factor_off', to: c.var.viewer.email});
        return c.json({ok: true});
      })

      .post('/two-factor/recovery-codes', passwordBody, withViewer, requireAuth, notForOwnerAccount, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const refused = await confirmPassword(c, id, c.req.valid('json').password, 'password');
        if (refused) return refused;
        const user = await c.var.db.user.findUnique({where: {id}, select: {totpEnabledAt: true}});
        if (!user?.totpEnabledAt) return c.json(problem('two_factor_off', 'Turn on two-step sign-in first.'), 409);
        const recoveryCodes = await freshRecoveryCodes(c, id);
        const {ipHash} = await keysFor(c, null);
        await audit(c.var.db, {actorUserId: id, action: 'recovery_codes_renewed', target: ['user', id], ipHash});
        if (c.var.viewer.email) sendEmail(c, {kind: 'recovery_codes_new', to: c.var.viewer.email});
        return c.json({ok: true, recoveryCodes});
      })

      // -------------------------------------------------------- new email --
      .post(
        '/email',
        body((v, c) => {
          const email = normalizeEmail(v.email);
          if (!email) return invalid(c, {email: 'Enter a valid email address, like name@example.com.'});
          return {email, password: raw(v.password).slice(0, PASSWORD_LIMITS.max * 2)};
        }),
        withViewer,
        requireAuth,
        notForOwnerAccount,
        withAuthCore,
        async c => {
          const id = c.var.viewer.id!;
          const {email, password} = c.req.valid('json');
          if (email === c.var.viewer.email) return invalid(c, {email: 'That is already your email address.'});
          const refused = await confirmPassword(c, id, password, 'password');
          if (refused) return refused;
          const db = c.var.db;
          const keys = await keysFor(c, `user:${id}`);
          const {stop} = await attempt(c, 'email', keys);
          if (stop) return stop;
          if (!(await emailAccepted(c.req.url, email))) return invalid(c, {email: EMAIL_NOT_REAL});

          // The same answer and the same notice whether or not the address has an account here (no
          // enumeration): a taken address simply never gets the link. One waiting change per account.
          const taken = await db.user.findUnique({where: {email}, select: {id: true}});
          await db.emailChange.updateMany({where: {userId: id, usedAt: null}, data: {usedAt: new Date()}});
          const token = newLinkToken();
          const change = await db.emailChange.create({
            data: {
              userId: id,
              newEmail: email,
              tokenHash: await sha256Hex(token),
              expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 3600 * 1000),
            },
            select: {id: true},
          });
          // The address it is moving away from hears now, while it can still say no.
          if (c.var.viewer.email) {
            sendEmail(c, {
              kind: 'email_change_requested',
              to: c.var.viewer.email,
              path: `/account/cancel-email/?token=${change.id}.${await cancelProof(c.var.secret, change.id)}`,
              expiresInMinutes: EMAIL_CHANGE_TTL_HOURS * 60,
            });
          }
          if (!taken) {
            sendEmail(c, {
              kind: 'confirm_email_change',
              to: email,
              path: `/account/confirm-email/?token=${token}`,
              expiresInMinutes: EMAIL_CHANGE_TTL_HOURS * 60,
            });
          }
          await audit(db, {actorUserId: id, action: 'email_change_requested', target: ['user', id], ipHash: keys.ipHash});
          return c.json(
            {ok: true, message: `Check ${email}: we sent a link to confirm it. Until then, you sign in with your current address.`},
            202
          );
        }
      )

      .post(
        '/email/confirm',
        body((v, c) => {
          const token = text(v.token, 64);
          return /^[A-Za-z0-9_-]{43}$/.test(token)
            ? {token}
            : c.json(problem('invalid_token', 'This link has expired or was already used.'), 400);
        }),
        withAuthCore,
        async c => {
          const db = c.var.db;
          const now = new Date();
          const row = await db.emailChange.findUnique({
            where: {tokenHash: await sha256Hex(c.req.valid('json').token)},
            select: {id: true, userId: true, newEmail: true, expiresAt: true, usedAt: true, user: {select: {email: true, status: true}}},
          });
          const bad = () => c.json(problem('invalid_token', 'This link has expired or was already used.'), 400);
          if (!row || row.usedAt || row.expiresAt <= now || row.user.status !== 'active') return bad();
          const {count} = await db.emailChange.updateMany({where: {id: row.id, usedAt: null}, data: {usedAt: now}});
          if (count !== 1) return bad();
          if (await db.user.findUnique({where: {email: row.newEmail}, select: {id: true}})) {
            return c.json(problem('email_taken', 'That address belongs to another account now. Ask for a new link.'), 409);
          }
          // Every device signs in again, with the new address, and links sent to the old one end.
          await endAccess(db, row.userId, 'email', {now, set: {email: row.newEmail, emailVerifiedAt: now}});
          const {ipHash} = await keysFor(c, null);
          await audit(db, {actorUserId: row.userId, action: 'email_changed', target: ['user', row.userId], ipHash});
          sendEmail(c, {kind: 'email_changed', to: row.user.email});
          clearSession(c);
          return c.json({ok: true, message: 'Your email address is changed. Sign in with the new one.'});
        }
      )

      .post(
        '/email/cancel',
        body((v, c) => {
          const token = text(v.token, 90);
          return /^\d{1,12}\.[0-9a-f]{64}$/.test(token) ? {token} : c.json(problem('invalid_token', 'This link has expired or was already used.'), 400);
        }),
        withAuthCore,
        async c => {
          const db = c.var.db;
          const [rawId = '', proof = ''] = c.req.valid('json').token.split('.');
          const changeId = Number(rawId);
          const expected = await cancelProof(c.var.secret, changeId);
          let diff = expected.length ^ proof.length;
          for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
          const bad = () => c.json(problem('invalid_token', 'This link has expired or was already used.'), 400);
          if (diff !== 0) return bad();
          const row = await db.emailChange.findUnique({where: {id: changeId}, select: {userId: true}});
          if (!row) return bad();
          // Only while it's waiting: once the new inbox confirms it, the change stands.
          const {count} = await db.emailChange.updateMany({where: {id: changeId, usedAt: null, expiresAt: {gt: new Date()}}, data: {usedAt: new Date()}});
          if (count !== 1) return bad();
          const {ipHash} = await keysFor(c, null);
          await audit(db, {actorUserId: null, action: 'email_change_cancelled', target: ['user', row.userId], ipHash});
          return c.json({ok: true, message: 'The change is cancelled, and your address stays the same. If you did not ask for it, someone may know your password: reset it now.'});
        }
      )

      // --------------------------------------------------------- devices --
      .get('/sessions', withViewer, requireAuth, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const now = new Date();
        const rows = await c.var.db.refreshToken.findMany({
          where: {userId: id, revokedAt: null, absoluteExpiresAt: {gt: now}},
          select: {familyId: true, userAgent: true, createdAt: true},
          orderBy: {createdAt: 'desc'},
          take: 500,
        });
        const current = await currentFamily(c);
        const families = new Map<string, {id: string; device: string; lastActiveAt: Date; current: boolean}>();
        for (const row of rows) {
          if (families.has(row.familyId)) continue;
          families.set(row.familyId, {
            id: row.familyId,
            device: deviceName(row.userAgent),
            lastActiveAt: row.createdAt,
            current: row.familyId === current,
          });
        }
        c.header('Cache-Control', 'no-store');
        return c.json({sessions: [...families.values()].slice(0, 50)});
      })

      .delete('/sessions/:id', withViewer, requireAuth, withAuthCore, async c => {
        const id = c.var.viewer.id!;
        const familyId = c.req.param('id');
        if (!/^[0-9a-f-]{36}$/i.test(familyId)) return c.json(problem('not_found', 'That device is already signed out.'), 404);
        const {count} = await c.var.db.refreshToken.updateMany({
          where: {familyId, userId: id, revokedAt: null},
          data: {revokedAt: new Date(), revokedReason: 'device'},
        });
        if (count === 0) return c.json(problem('not_found', 'That device is already signed out.'), 404);
        const {ipHash} = await keysFor(c, null);
        await audit(c.var.db, {actorUserId: id, action: 'device_signed_out', target: ['user', id], ipHash});
        if (familyId === (await currentFamily(c))) clearSession(c);
        return c.json({ok: true});
      })

      // ---------------------------------------------------------- delete --
      .post(
        '/delete-account',
        body(v => ({password: raw(v.password).slice(0, PASSWORD_LIMITS.max * 2), confirm: text(v.confirm, 16)})),
        withViewer,
        requireAuth,
        notForOwnerAccount,
        withAuthCore,
        async c => {
          const id = c.var.viewer.id!;
          const {password, confirm} = c.req.valid('json');
          const db = c.var.db;
          const fields: FieldErrors = {};
          if (confirm !== 'DELETE') fields.confirm = 'Type DELETE to confirm.';
          if (Object.keys(fields).length) return invalid(c, fields);
          const refused = await confirmPassword(c, id, password, 'delete');
          if (refused) return refused;

          const {ipHash} = await keysFor(c, null);
          await db.authState.updateMany({where: {id: 1, ownerUserId: id}, data: {ownerUserId: null}});
          // Cascades: roles, devices, links, codes. Content the user made (jobs…) stays.
          await db.user.delete({where: {id}, select: {id: true}});
          // Their own cached data goes with them (best effort; the cache never fails a request).
          await cache.delPrefix(userKey(id, ''));
          await audit(db, {actorUserId: null, action: 'account_deleted', target: ['user', id], ipHash});
          clearSession(c);
          return c.json({ok: true, message: 'Your account is deleted.'});
        }
      )
  );
}
