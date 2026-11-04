import type {PrismaClient} from '../../generated/prisma/client';
import {config} from '../config';
import {audit} from './audit';
import {SYSTEM_ROLES} from './codenames';

/**
 * Follows the owner when a site changes hands. `SITE_OWNER_ID` is the platform's opaque id for the
 * account's owner, set at each Deploy; `auth_state.owner_env_id` is the value this database last saw.
 *
 *   - First run with it (a site just upgraded): `owner` held by anyone without a platform id goes,
 *     because owner now comes only from the dashboard. Admins stay.
 *   - It changed and the seat's account isn't the new owner: the site changed hands. All admin rights
 *     go (`removeAdminRights`). The new owner gives them back to whoever should have them.
 *   - It changed and the new owner already clicked in: nothing to do.
 *
 * Not a check of who is owner: a ticket is, and it can arrive before the next Deploy. Runs once per
 * worker for a given value, so it costs one lookup after a deploy, not one per request.
 */

let reconciledFor: string | null = null;

/** A role grants admin power when it holds a wildcard or any of the core `site:` codenames. */
const isAdminPower = (codename: string) => codename === '*' || codename.startsWith('site:');

/**
 * Takes every admin right from everyone but `keepUserId`: `owner`, `admin` and any role holding core
 * permissions. They stay as normal users and sign in again; earlier owner accounts are deleted.
 */
export async function removeAdminRights(db: PrismaClient, keepUserId: number | null): Promise<void> {
  const roles = await db.role.findMany({
    select: {id: true, slug: true, permissions: {select: {permission: {select: {codename: true}}}, take: 500}},
    take: 500,
  });
  const adminRoles = roles
    .filter(
      role =>
        role.slug === SYSTEM_ROLES.OWNER ||
        role.slug === SYSTEM_ROLES.ADMIN ||
        role.permissions.some(p => isAdminPower(p.permission.codename))
    )
    .map(role => role.id);
  const member = roles.find(role => role.slug === SYSTEM_ROLES.MEMBER)?.id;
  const others = keepUserId === null ? {} : {not: keepUserId};
  const now = new Date();
  await db.$transaction(
    async tx => {
      const holders = await tx.userRole.findMany({
        where: {roleId: {in: adminRoles}, userId: others},
        select: {userId: true},
        distinct: ['userId'],
        take: 5000,
      });
      const ids = holders.map(row => row.userId);
      await tx.userRole.deleteMany({where: {roleId: {in: adminRoles}, userId: others}});
      if (member !== undefined && ids.length) {
        await tx.userRole.createMany({data: ids.map(userId => ({userId, roleId: member})), skipDuplicates: true});
      }
      await tx.user.updateMany({where: {id: {in: ids}}, data: {sessionVersion: {increment: 1}}});
      await tx.refreshToken.updateMany({where: {userId: {in: ids}, revokedAt: null}, data: {revokedAt: now}});
      await tx.user.deleteMany({where: {platformOwnerId: {not: null}, id: others}});
    },
    {timeout: 15_000}
  );
}

export async function reconcileOwnerSeat(db: PrismaClient): Promise<void> {
  const ownerId = config.ownerId;
  if (!ownerId || reconciledFor === ownerId) return;
  reconciledFor = ownerId;
  try {
    const state = await db.authState.findUnique({where: {id: 1}, select: {ownerUserId: true, ownerEnvId: true}});
    if (!state || state.ownerEnvId === ownerId) return;
    // One conditional update: of several workers starting at once, one does this.
    const {count} = await db.authState.updateMany({
      where: {id: 1, ownerEnvId: state.ownerEnvId},
      data: {ownerEnvId: ownerId},
    });
    if (count !== 1) return;

    if (state.ownerEnvId === null) {
      const owner = await db.role.findUnique({where: {slug: SYSTEM_ROLES.OWNER}, select: {id: true}});
      if (owner) await db.userRole.deleteMany({where: {roleId: owner.id, user: {platformOwnerId: null}}});
      const legacy = state.ownerUserId === null
        ? null
        : await db.user.findUnique({where: {id: state.ownerUserId}, select: {platformOwnerId: true}});
      if (legacy && legacy.platformOwnerId === null) {
        await db.authState.updateMany({where: {id: 1, ownerUserId: state.ownerUserId}, data: {ownerUserId: null}});
      }
      return;
    }
    const holder = state.ownerUserId === null
      ? null
      : await db.user.findUnique({where: {id: state.ownerUserId}, select: {platformOwnerId: true}});
    if (holder?.platformOwnerId === ownerId) return;
    await db.authState.updateMany({where: {id: 1, ownerUserId: state.ownerUserId}, data: {ownerUserId: null}});
    await removeAdminRights(db, null);
    await audit(db, {
      actorUserId: null,
      action: 'owner_removed',
      target: ['site', 0],
      meta: {reason: 'site_changed_hands'},
    });
  } catch (error) {
    // Try again on the next request.
    reconciledFor = null;
    console.warn('auth: the owner was not checked against the platform', (error as Error)?.message);
  }
}

/** Tests only. */
export function resetOwnerSeatForTests(): void {
  reconciledFor = null;
}
