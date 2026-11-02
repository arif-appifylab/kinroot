import {Hono} from 'hono';

import {SiteKeyMissing, siteKeyPostData} from '../api';
import {config} from '../config';
import {problem, withAuthCore} from '../guards';
import {audit} from './audit';
import {SYSTEM_ROLES} from './codenames';
import {normalizeEmail, safeNext} from './input';
import {attempt, type Ctx, type Env, keysFor, maybeSweep, NO_PASSWORD, settle, startSession} from './kit';
import {rememberOwnerSettings} from './owner-seat';
import {signChallenge} from './two-factor';
import {type AuthSettings, ownerClaimMode, ownerEmailsFor} from './settings';

/**
 * The OWNER role: who holds it, and the two ways to get it.
 *
 *   1. One click from the dashboard (the usual way). The site's owners (the account owner and
 *      members whose role holds `account:*`) press "Open admin" in the dashboard. The
 *      platform mints a one-use, 2-minute ticket and sends the browser to
 *      `GET /site-api/auth/owner?ticket=…`. This site spends the ticket with the platform, server to
 *      server with its Site Key (`POST /api/site/v1/owner-sign-in`), which answers the address and
 *      the CURRENT owner list. The address is signed in (its account is made if it has none: no
 *      password, nothing to register) and holds `owner`. No email, no sign-up.
 *   2. An owner address that signs up here and sets its password through an emailed link (the
 *      reset link proves the inbox AND that this person chose the password). Owner never goes to
 *      a confirmation link alone: anyone can register an owner address first.
 *
 * The owner SEAT (`auth_state.owner_user_id`) is the account the platform's owner list points at.
 * When that account's address is no longer on the list (the account changed hands), the
 * next owner address to sign in takes the seat, and the previous holder loses `owner` (their account
 * and other roles stay). Owners the owner added by hand in Users keep it. Locally and in the
 * Preview, with no owner list, the first account becomes owner (`ownerClaimMode`).
 */

/** Logged (never shown to visitors) when a live site has no owner address. */
export const OWNER_SETUP_WARNING =
  'auth: the owner role was not granted: this live site has no owner email. Publish it again from the dashboard ' +
  '(which sets SITE_OWNER_EMAILS) or add the address to ownerEmails in src/server/auth-settings.ts.';

/**
 * How the person got here: `platform` is a ticket from the dashboard (the platform
 * checked the address); `reset` a password set through an emailed reset link (proves the inbox
 * AND that this person chose the password); `verify` proves only the inbox; `register` nothing.
 */
export type ClaimProof = 'register' | 'verify' | 'reset' | 'platform';

/** The seat as it stands: free, held by a listed address, or held by an address that left the list. */
async function seat(c: Ctx, owners: string[]): Promise<{holder: number | null; stale: boolean}> {
  const state = await c.var.db.authState.findUnique({where: {id: 1}, select: {ownerUserId: true}});
  const holder = state?.ownerUserId ?? null;
  // Without an owner list (local, the Preview) nobody's address can leave it: the seat never goes stale.
  if (holder === null || owners.length === 0) return {holder, stale: false};
  const user = await c.var.db.user.findUnique({where: {id: holder}, select: {email: true}});
  return {holder, stale: !user || !owners.includes(user.email)};
}

/** Can this address still claim `owner` with a reset link? (Only in `listed` mode.) */
export async function ownerAddressUnclaimed(c: Ctx, settings: AuthSettings, email: string): Promise<boolean> {
  const owners = ownerEmailsFor(settings);
  if (ownerClaimMode(settings) !== 'listed' || !owners.includes(email)) return false;
  const {holder, stale} = await seat(c, owners);
  return holder === null || stale;
}

/**
 * Gives `owner` to this user when the settings allow it (`ownerClaimMode`) and the proof is strong
 * enough: in `listed` mode a listed address with proof `reset` takes a FREE or STALE seat, and with
 * proof `platform` always holds `owner` (and takes the seat when it is free or stale). In `first`
 * mode (no list: local and the Preview) the first account does. Taking the seat is ONE conditional
 * update, so two people at the same moment cannot both win it.
 */
export async function claimOwnerIfFirst(
  c: Ctx,
  settings: AuthSettings,
  user: {id: number; email: string},
  ipHash: string,
  proof: ClaimProof,
  platformOwners: string[] = []
) {
  const mode = ownerClaimMode(settings);
  const owners = [...new Set([...ownerEmailsFor(settings), ...platformOwners])];
  if (proof === 'platform') {
    if (!owners.includes(user.email)) return;
  } else {
    if (mode === 'off') {
      if (settings.firstUserBecomesOwner) console.warn(OWNER_SETUP_WARNING);
      return;
    }
    if (mode === 'listed' && (proof !== 'reset' || !owners.includes(user.email))) return;
  }

  const db = c.var.db;
  const {holder, stale} = await seat(c, owners);
  let took = false;
  if (holder !== user.id && (holder === null || stale)) {
    const {count} = await db.authState.updateMany({where: {id: 1, ownerUserId: holder}, data: {ownerUserId: user.id}});
    took = count === 1;
    if (!took && proof !== 'platform') return;
  } else if (holder !== user.id && proof !== 'platform') {
    // The seat is held by a listed owner: a reset link alone does not make a second owner.
    return;
  }

  const owner = await db.role.findUnique({where: {slug: SYSTEM_ROLES.OWNER}, select: {id: true}});
  if (!owner) return;
  await db.userRole.upsert({
    where: {userId_roleId: {userId: user.id, roleId: owner.id}},
    create: {userId: user.id, roleId: owner.id},
    update: {},
    select: {userId: true},
  });
  if (took && holder !== null && stale) {
    // The previous holder's address left the owner list: they keep their account, not `owner`.
    await db.userRole.deleteMany({where: {userId: holder, roleId: owner.id}});
    await audit(db, {actorUserId: user.id, action: 'owner_transferred', target: ['user', holder], ipHash});
  }
  if (took) await audit(db, {actorUserId: user.id, action: 'owner_claimed', target: ['user', user.id], ipHash});
}

const TICKET = /^[A-Za-z0-9_-]{43}$/;

interface RedeemedOwner {
  email: string;
  name: string;
  ownerEmails: string[];
}

/** Where a failed one-click sign-in lands: the sign-in page, with a line saying why. */
const toLogin = (notice: string) => `/account/login/?notice=${notice}`;

const OWNER_USER = {
  id: true,
  email: true,
  status: true,
  emailVerifiedAt: true,
  sessionVersion: true,
  totpEnabledAt: true,
} as const;

/** The no-password account for an owner address, made when it has none (it signs in by code or one click). */
async function ownerAccount(c: Ctx, email: string, name: string, ipHash: string) {
  const db = c.var.db;
  const found = await db.user.findUnique({where: {email}, select: OWNER_USER});
  if (found) {
    // The platform vouched for the address.
    if (!found.emailVerifiedAt) await db.user.update({where: {id: found.id}, data: {emailVerifiedAt: new Date()}, select: {id: true}});
    return found;
  }
  const user = await db.user.create({
    data: {email, name: name.trim().slice(0, 80) || email.split('@')[0]!.slice(0, 80), passwordHash: NO_PASSWORD, emailVerifiedAt: new Date()},
    select: OWNER_USER,
  });
  await audit(db, {actorUserId: user.id, action: 'registered', target: ['user', user.id], ipHash, meta: {via: 'platform'}});
  return user;
}

/**
 * The admin is made by the platform, never by hand or by the AI (docs/agent/auth.md): every owner
 * address (`SITE_OWNER_EMAILS` + `ownerEmails`) has an account holding `owner`, with no password
 * (it signs in with an emailed code or one click from the dashboard). Runs before a sign-in code is
 * sent and before a one-click sign-in, in the live site and the Preview alike; once per worker
 * for a given list, so it costs one round of lookups, not one per request. Idempotent.
 */
let ownersEnsuredFor: string | null = null;
export async function ensureOwnerAccounts(c: Ctx, settings: AuthSettings, ipHash: string): Promise<void> {
  const owners = ownerEmailsFor(settings);
  const key = owners.join(',');
  if (!owners.length || ownersEnsuredFor === key) return;
  for (const email of owners) {
    const user = await ownerAccount(c, email, '', ipHash);
    if (user.status === 'active') await claimOwnerIfFirst(c, settings, user, ipHash, 'platform', owners);
  }
  ownersEnsuredFor = key;
}

/** Tests only: forget which owner list was already ensured. */
export function resetOwnerAccountsForTests() {
  ownersEnsuredFor = null;
}

type OwnerOutcome =
  | {ok: true; next: string}
  | {ok: false; twoFactor: string; next: string}
  | {ok: false; notice: 'owner-link' | 'suspended'; status: number};

/**
 * Spend a one-click ticket with the platform (`POST /api/site/v1/owner-sign-in`), make or find the
 * owner's account, give it `owner`, and sign it in, unless it turned two-step sign-in on: then
 * the answer is a challenge for its code, exactly as after a password (the site's own two-factor
 * still asks after one click).
 */
async function redeemOwnerTicket(c: Ctx, settings: AuthSettings, ticket: string, next: unknown): Promise<OwnerOutcome> {
  const fail = (notice: 'owner-link' | 'suspended', status = 401): OwnerOutcome => ({ok: false, notice, status});
  if (!TICKET.test(ticket)) return fail('owner-link');

  const keys = await keysFor(c, null);
  const {stop, id: attemptId} = await attempt(c, 'owner', keys);
  if (stop) return fail('owner-link', 429);

  let answer: {status: number; data: RedeemedOwner | null};
  try {
    answer = await siteKeyPostData<RedeemedOwner>(c.req.url, '/owner-sign-in', {ticket});
  } catch (err) {
    if (err instanceof SiteKeyMissing) return fail('owner-link');
    throw err;
  }
  const email = normalizeEmail(answer.data?.email);
  if (answer.status !== 200 || !email) return fail('owner-link');
  await settle(c, attemptId, true);

  const db = c.var.db;
  const platformOwners = (answer.data?.ownerEmails ?? []).map(e => normalizeEmail(e)).filter((e): e is string => !!e);
  const user = await ownerAccount(c, email, answer.data?.name ?? '', keys.ipHash);
  if (user.status !== 'active') return fail('suspended', 403);

  await claimOwnerIfFirst(c, settings, user, keys.ipHash, 'platform', platformOwners);
  const to = safeNext(next, settings.afterSignInPath);
  if (user.totpEnabledAt) {
    await audit(db, {actorUserId: user.id, action: 'owner_link_two_factor', target: ['user', user.id], ipHash: keys.ipHash});
    return {ok: false, twoFactor: await signChallenge(c.var.secret, user.id, user.sessionVersion), next: to};
  }
  await db.user.update({where: {id: user.id}, data: {lastLoginAt: new Date()}, select: {id: true}});
  await startSession(c, user, keys.ipHash);
  await audit(db, {actorUserId: user.id, action: 'owner_signed_in', target: ['user', user.id], ipHash: keys.ipHash});
  maybeSweep(c);
  return {ok: true, next: to};
}

/**
 * One click from the dashboard into this site's admin:
 *   GET  /site-api/auth/owner?ticket=…&next=   the live site (a page load from the dashboard)
 *   POST /site-api/auth/owner {ticket, next}     the editor's Preview (`/portal/?owner_ticket=…`, redirected to `/dashboard/`):
 *        the Preview's cookies travel in headers, so only a fetch can sign in there
 * Two-step sign-in on: GET goes to the sign-in page's code step (`?mfa=<challenge>`), POST answers
 * 202 {twoFactor, challenge} like `/login`; `/login/two-factor` finishes either.
 */
export function ownerRoutes(settings: AuthSettings) {
  rememberOwnerSettings(settings);
  return new Hono<Env>()
    .get('/owner', withAuthCore, async c => {
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      if (config.preview) return c.redirect(toLogin('owner-link'), 303);
      const out = await redeemOwnerTicket(c, settings, c.req.query('ticket') ?? '', c.req.query('next'));
      if (out.ok) return c.redirect(out.next, 303);
      if ('twoFactor' in out) {
        const q = new URLSearchParams({mfa: out.twoFactor, next: out.next});
        return c.redirect(`/account/login/?${q.toString()}`, 303);
      }
      return c.redirect(toLogin(out.notice), 303);
    })
    .post('/owner', withAuthCore, async c => {
      c.header('Cache-Control', 'no-store');
      const input = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const ticket = typeof input.ticket === 'string' ? input.ticket : '';
      const out = await redeemOwnerTicket(c, settings, ticket, input.next);
      if (out.ok) return c.json({ok: true, next: out.next});
      if ('twoFactor' in out) {
        return c.json(
          {ok: false, twoFactor: true, challenge: out.twoFactor, next: out.next, message: 'Enter the 6-digit code from your authenticator app.'},
          202
        );
      }
      return c.json(
        problem(
          out.notice === 'suspended' ? 'account_suspended' : 'owner_link',
          out.notice === 'suspended'
            ? 'This account is suspended. Contact the site owner.'
            : 'That sign-in link has expired or was already used. Open the portal again from the dashboard.'
        ),
        out.status as 401 | 403 | 429
      );
    });
}
