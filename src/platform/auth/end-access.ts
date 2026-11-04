import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {NO_PASSWORD} from './kit';
import type {RevokeReason} from './refresh';
import {AUTH_TX} from './store';

/**
 * Ends every way back into an account, all together or not at all: sessions and two-step
 * challenges (`sessionVersion`), refresh tokens, and every open link and code. Every security
 * event calls this one helper (password reset and change, new email, sign out everywhere,
 * suspension, an inbox proven for the first time), so none of them can miss one.
 * `sessionVersion` changes: read the user again before starting a session.
 */
async function endAll(tx: Prisma.TransactionClient, userId: number, now: Date, reason: RevokeReason) {
  await tx.user.update({where: {id: userId}, data: {sessionVersion: {increment: 1}}, select: {id: true}});
  await tx.refreshToken.updateMany({where: {userId, revokedAt: null}, data: {revokedAt: now, revokedReason: reason}});
  await tx.passwordReset.updateMany({where: {userId, usedAt: null}, data: {usedAt: now}});
  await tx.emailVerification.updateMany({where: {userId, usedAt: null}, data: {usedAt: now}});
  await tx.emailChange.updateMany({where: {userId, usedAt: null}, data: {usedAt: now}});
  await tx.signInCode.updateMany({where: {userId, usedAt: null}, data: {usedAt: now}});
}

export async function endAccess(
  db: PrismaClient,
  userId: number,
  reason: RevokeReason,
  {now = new Date(), set}: {now?: Date; set?: Prisma.UserUpdateManyMutationInput} = {}
): Promise<void> {
  await db.$transaction(async tx => {
    if (set) await tx.user.update({where: {id: userId}, data: set, select: {id: true}});
    await endAll(tx, userId, now, reason);
  }, AUTH_TX);
}

/**
 * An account from before sign-up needed a code, whose address was never confirmed, may be a
 * stranger's. When someone proves the inbox, nothing set before that is theirs to inherit: the
 * password, every session, two-step sign-in, recovery codes and every open link all go, and the
 * address is confirmed. Only once: the update that confirms it decides, so `true` means this call
 * did. A confirmed account is never touched. `set` is what the person who proved it chose.
 */
export async function claimUnconfirmed(
  db: PrismaClient,
  userId: number,
  {now = new Date(), set = {}}: {now?: Date; set?: {passwordHash?: string; name?: string}} = {}
): Promise<boolean> {
  return db.$transaction(async tx => {
    const {count} = await tx.user.updateMany({
      where: {id: userId, emailVerifiedAt: null},
      data: {
        passwordHash: NO_PASSWORD,
        ...set,
        emailVerifiedAt: now,
        totpSecretSealed: null,
        totpPendingSealed: null,
        totpEnabledAt: null,
        totpLastStep: null,
      },
    });
    if (count !== 1) return false;
    await tx.recoveryCode.deleteMany({where: {userId}});
    await endAll(tx, userId, now, 'password');
    // The address is proven now: anyone else's waiting sign-up for it is over.
    const {email} = await tx.user.findUniqueOrThrow({where: {id: userId}, select: {email: true}});
    await tx.pendingSignUp.updateMany({where: {email, usedAt: null}, data: {usedAt: now}});
    return true;
  }, AUTH_TX);
}
