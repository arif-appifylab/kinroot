import {Hono} from 'hono';

import type {PrismaClient} from '../../generated/prisma/client';
import {SiteKeyMissing, siteKeyPostData} from '../api';
import {problem, withAuthCore} from '../guards';
import {audit} from './audit';
import {SYSTEM_ROLES} from './codenames';
import {fromBase64Url} from './encoding';
import {safeNext} from './input';
import {endAccess} from './end-access';
import {attempt, type Ctx, type Env, keysFor, maybeSweep, NO_PASSWORD, settle, startSession} from './kit';
import {removeAdminRights} from './owner-seat';
import {config} from '../config';
import type {AuthSettings} from './settings';

/**
 * The OWNER of a site, and the ONE way to become it: the account's owner presses "View as admin" in
 * the dashboard or the editor. The platform mints a one-use, 2-minute ticket and sends the browser
 * to `GET /site-api/auth/owner?ticket=…`. This site spends the ticket with the platform, server to
 * server with its Site Key (`POST /api/site/v1/owner-sign-in`), and gets back an opaque owner id.
 * Live, staging, the Preview and a local copy holding a Site Key all use this same route.
 *
 * There is no other way: not a sign-up, a confirmation link, a password reset or an emailed code,
 * with any address. Someone signing up with the owner's email is a normal user.
 *
 * The owner account is tied to that id, never to an email: this site is never told the owner's
 * address. It has no password and no two-step of its own (the dashboard's sign-in protects it), it
 * can't sign in any other way, and nobody can suspend, change or demote it from inside the site.
 */

const TICKET = /^[A-Za-z0-9_-]{43}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{43}$/;

/** Where a failed sign-in lands: the sign-in page, with a line saying why. */
const toLogin = (notice: string) => `/account/login/?notice=${notice}`;

/** Addresses in this domain are never accepted from a person (`normalizeEmail`). */
export const OWNER_EMAIL_DOMAIN = 'owner.invalid';

const OWNER_USER = {id: true, sessionVersion: true, status: true} as const;

/** The owner's account, made the first time they arrive. Its address is a placeholder nothing can reach. */
async function ownerAccount(db: PrismaClient, ownerId: string, ipHash: string) {
  const found = await db.user.findUnique({where: {platformOwnerId: ownerId}, select: OWNER_USER});
  if (found) {
    if (found.status === 'active') return found;
    return db.user.update({where: {id: found.id}, data: {status: 'active'}, select: OWNER_USER});
  }
  const label = Buffer.from(fromBase64Url(ownerId) ?? []).toString('hex').slice(0, 32);
  const user = await db.user.create({
    data: {
      email: `owner-${label}@${OWNER_EMAIL_DOMAIN}`,
      name: 'Site owner',
      passwordHash: NO_PASSWORD,
      emailVerifiedAt: new Date(),
      platformOwnerId: ownerId,
    },
    select: OWNER_USER,
  });
  await audit(db, {actorUserId: user.id, action: 'registered', target: ['user', user.id], ipHash, meta: {via: 'platform'}});
  return user;
}

/** This account holds the seat and `owner`. A different owner on the seat means the site changed hands. */
async function takeSeat(db: PrismaClient, userId: number, ownerId: string, ipHash: string): Promise<boolean> {
  const state = await db.authState.findUnique({where: {id: 1}, select: {ownerUserId: true}});
  const holder = state?.ownerUserId ?? null;
  if (holder !== userId) {
    // One conditional update: two people at the same moment can't both win.
    const {count} = await db.authState.updateMany({where: {id: 1, ownerUserId: holder}, data: {ownerUserId: userId}});
    if (count !== 1) return false;
    const previous = holder === null ? null : await db.user.findUnique({where: {id: holder}, select: {platformOwnerId: true}});
    if (previous?.platformOwnerId && previous.platformOwnerId !== ownerId) {
      await removeAdminRights(db, userId);
      await audit(db, {actorUserId: userId, action: 'owner_transferred', target: ['user', holder!], ipHash});
    }
    await audit(db, {actorUserId: userId, action: 'owner_claimed', target: ['user', userId], ipHash});
  }
  const owner = await db.role.findUnique({where: {slug: SYSTEM_ROLES.OWNER}, select: {id: true}});
  if (!owner) return false;
  await db.userRole.upsert({
    where: {userId_roleId: {userId, roleId: owner.id}},
    create: {userId, roleId: owner.id},
    update: {},
    select: {userId: true},
  });
  return true;
}

/**
 * Is this still the account's owner? Asked of the platform each time an owner's session refreshes, so
 * a site changing hands ends the old owner's access within one access token, not at the next Deploy.
 * Only a clear answer counts: if the platform can't be reached, nothing changes.
 *
 * This takes only THIS person's rights: anything wider could land on a new owner who just clicked in.
 * The seat stays, so the new owner's click, or the next Deploy, clears everyone else's (`takeSeat`,
 * `reconcileOwnerSeat`).
 */
export async function stillOwner(c: Ctx, userId: number, ownerId: string): Promise<boolean> {
  let answer: {status: number; data: {ownerId?: unknown} | null};
  try {
    answer = await siteKeyPostData<{ownerId?: unknown}>(c.req.url, '/owner-current', {});
  } catch {
    return true;
  }
  if (answer.status !== 200 || answer.data === null) return true;
  const current = answer.data.ownerId;
  // `null`: the account has no active owner now, so nobody holds this seat.
  if (current !== null && (typeof current !== 'string' || !OWNER_ID.test(current) || current === ownerId)) return true;
  const db = c.var.db;
  const owner = await db.role.findUnique({where: {slug: SYSTEM_ROLES.OWNER}, select: {id: true}});
  if (owner) await db.userRole.deleteMany({where: {userId, roleId: owner.id}});
  await endAccess(db, userId, 'admin');
  const {ipHash} = await keysFor(c, null);
  await audit(db, {actorUserId: null, action: 'owner_removed', target: ['user', userId], ipHash});
  return false;
}

type OwnerOutcome = {ok: true; next: string} | {ok: false; status: number};

async function redeemOwnerTicket(c: Ctx, settings: AuthSettings, ticket: string, next: unknown): Promise<OwnerOutcome> {
  if (!TICKET.test(ticket)) return {ok: false, status: 401};

  const keys = await keysFor(c, null);
  const {stop, id: attemptId} = await attempt(c, 'owner', keys);
  if (stop) return {ok: false, status: 429};

  let answer: {status: number; data: {ownerId?: unknown} | null};
  try {
    answer = await siteKeyPostData<{ownerId?: unknown}>(c.req.url, '/owner-sign-in', {ticket, version: 2});
  } catch (err) {
    if (err instanceof SiteKeyMissing) return {ok: false, status: 401};
    throw err;
  }
  const ownerId = answer.data?.ownerId;
  if (answer.status !== 200 || typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) return {ok: false, status: 401};
  await settle(c, attemptId, true);

  const db = c.var.db;
  const user = await ownerAccount(db, ownerId, keys.ipHash);
  if (!(await takeSeat(db, user.id, ownerId, keys.ipHash))) return {ok: false, status: 409};
  await db.user.update({where: {id: user.id}, data: {lastLoginAt: new Date()}, select: {id: true}});
  await startSession(c, user, keys.ipHash);
  await audit(db, {actorUserId: user.id, action: 'owner_signed_in', target: ['user', user.id], ipHash: keys.ipHash});
  maybeSweep(c);
  return {ok: true, next: safeNext(next, settings.afterSignInPath)};
}

/**
 *   GET  /site-api/auth/owner?ticket=…&next=   a page load from the dashboard
 *   POST /site-api/auth/owner {ticket, next}   the editor's Preview (`/portal/?owner_ticket=…`, redirected to
 *                                              `/dashboard/`): its cookies travel in headers, so only a fetch can sign in
 */
export function ownerRoutes(settings: AuthSettings) {
  return new Hono<Env>()
    .get('/owner', withAuthCore, async c => {
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      if (config.preview) return c.redirect(toLogin('owner-link'), 303);
      const out = await redeemOwnerTicket(c, settings, c.req.query('ticket') ?? '', c.req.query('next'));
      return c.redirect(out.ok ? out.next : toLogin('owner-link'), 303);
    })
    .post('/owner', withAuthCore, async c => {
      c.header('Cache-Control', 'no-store');
      const input = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const ticket = typeof input.ticket === 'string' ? input.ticket : '';
      const out = await redeemOwnerTicket(c, settings, ticket, input.next);
      if (out.ok) return c.json({ok: true, next: out.next});
      return c.json(
        problem('owner_link', 'That sign-in link has expired or was already used. Open it again from the dashboard.'),
        out.status as 401 | 409 | 429
      );
    });
}
