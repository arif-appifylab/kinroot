import {config} from '../config';
import {getDb} from '../db';
import {scoped} from '../request-scope';
import type {Access, Viewer} from '../types';
import {ACCESS_COOKIE, cookieName, readCookie, REFRESH_COOKIE} from './cookies';
import {reconcileOwnerSeat} from './owner-seat';
import {verifyAccessToken} from './jwt';

/**
 * WHO IS VISITING, from this site's own auth cookies. Once per request
 * (`request-scope.ts`): the layout, the page and every in-process Site API
 * call share the answer.
 *
 *   no auth cookie                → guest      (no crypto, no query)
 *   refresh cookie only           → returning  (the browser refreshes once)
 *   access JWT fails / expired    → returning when a refresh cookie is there, else guest
 *   JWT ok → a primary-key read of the user AND an indexed read of the
 *   token's sign-in (`sid`, its refresh family), in parallel:
 *     missing, suspended, or `session_version` ≠ the token's `sv` → guest
 *     that sign-in revoked (signed out on this device, reuse)  → returning
 *                                                    (the refresh then fails)
 *     otherwise                   → user
 *
 * Re-reading on every authenticated request is what makes a suspension, a
 * password change, "sign out everywhere" or signing out on ONE device take
 * effect at once instead of when the 10-minute token expires.
 *
 * Never keep a viewer in a module variable, never trust a user id, role or
 * permission sent by the browser.
 */

export const GUEST: Viewer = {state: 'guest', id: null, name: null, email: null, emailVerified: false};
const RETURNING: Viewer = {...GUEST, state: 'returning'};
const NO_ACCESS: Access = {roles: [], permissions: []};

export function getViewer(request: Request): Promise<Viewer> {
  return scoped('viewer', () => resolveViewer(request));
}

async function resolveViewer(request: Request): Promise<Viewer> {
  const header = request.headers.get('cookie');
  const access = readCookie(header, cookieName(ACCESS_COOKIE, request.url));
  const refresh = readCookie(header, cookieName(REFRESH_COOKIE, request.url));
  if (!access && !refresh) return GUEST;
  if (!access) return RETURNING;

  const secret = config.jwtSecret;
  const db = getDb();
  if (!secret || !db) return GUEST;

  const verified = await verifyAccessToken(secret, access);
  if (!verified.ok) return refresh ? RETURNING : GUEST;

  const userId = Number(verified.claims.sub);
  const [user, signIn] = await Promise.all([
    db.user.findUnique({
      where: {id: userId},
      select: {id: true, name: true, email: true, status: true, emailVerifiedAt: true, sessionVersion: true},
    }),
    // A sign-in is live while its family has a token nobody revoked (`@@index([familyId])`).
    db.refreshToken.findFirst({
      where: {familyId: verified.claims.sid, userId, revokedAt: null},
      select: {id: true},
    }),
  ]);
  if (!user || user.status !== 'active' || user.sessionVersion !== verified.claims.sv) return GUEST;
  if (!signIn) return refresh ? RETURNING : GUEST;

  return {
    state: 'user',
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/**
 * The viewer's roles and every codename they grant, once per request. One
 * bounded query over `user_roles → roles → role_permissions → permissions`.
 */
export function getAccess(request: Request): Promise<Access> {
  return scoped('access', async () => {
    const viewer = await getViewer(request);
    const db = getDb();
    if (viewer.state !== 'user' || !db) return NO_ACCESS;
    // After a deploy that changed the owner list, a previous owner loses `owner` before this read.
    await reconcileOwnerSeat(db);
    const rows = await db.userRole.findMany({
      where: {userId: viewer.id!},
      select: {
        role: {
          select: {
            slug: true,
            permissions: {select: {permission: {select: {codename: true}}}, take: 500},
          },
        },
      },
      take: 50,
    });
    const permissions = new Set<string>();
    for (const row of rows) for (const grant of row.role.permissions) permissions.add(grant.permission.codename);
    return {roles: rows.map(row => row.role.slug), permissions: [...permissions]};
  });
}
