import type {PrismaClient} from '../../generated/prisma/client';
import {config} from '../config';
import {audit} from './audit';
import {SYSTEM_ROLES} from './codenames';
import {type AuthSettings, ownerEmailsFor} from './settings';

/**
 * The owner list changed with a deploy (the site changed hands): the account that holds the owner
 * SEAT (`auth_state.owner_user_id`) but whose address is no longer on the list loses `owner` at
 * once, on the first signed-in request this worker sees, without waiting for the new owner to sign
 * in. Its account and other roles stay; the seat is freed for the next owner address to sign in
 * (owner.ts). Owners an owner added by hand in Users are not the seat and are left alone.
 *
 * Live site only, and only with an owner list (local dev and the Preview have none). Runs once per
 * worker for a given list, so it costs one lookup after a deploy, not one per request.
 */

let settings: AuthSettings | null = null;
let reconciledFor: string | null = null;

/** The site's auth settings, for the owner list the code adds (`ownerEmails`). Set by the auth routes. */
export function rememberOwnerSettings(value: AuthSettings): void {
  settings = value;
}

export async function reconcileOwnerSeat(db: PrismaClient): Promise<void> {
  if (!settings || !config.production) return;
  const owners = ownerEmailsFor(settings);
  const key = owners.join(',');
  if (!owners.length || reconciledFor === key) return;
  reconciledFor = key;
  try {
    const state = await db.authState.findUnique({where: {id: 1}, select: {ownerUserId: true}});
    const holder = state?.ownerUserId ?? null;
    if (holder === null) return;
    const user = await db.user.findUnique({where: {id: holder}, select: {email: true}});
    if (user && owners.includes(user.email)) return;
    // One conditional update: a new owner taking the seat at the same moment wins.
    const {count} = await db.authState.updateMany({where: {id: 1, ownerUserId: holder}, data: {ownerUserId: null}});
    if (count !== 1) return;
    const owner = await db.role.findUnique({where: {slug: SYSTEM_ROLES.OWNER}, select: {id: true}});
    if (owner) await db.userRole.deleteMany({where: {userId: holder, roleId: owner.id}});
    await audit(db, {actorUserId: null, action: 'owner_removed', target: ['user', holder], meta: {reason: 'owner_list'}});
  } catch (error) {
    // Try again on the next request.
    reconciledFor = null;
    console.warn('auth: the owner seat was not checked against the owner list', (error as Error)?.message);
  }
}

/** Tests only. */
export function resetOwnerSeatForTests(): void {
  reconciledFor = null;
}
