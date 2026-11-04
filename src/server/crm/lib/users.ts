import type {Context} from 'hono';

import type {Member, Prisma} from '../../../generated/prisma/client';
import {getAccess} from '../../../platform/auth';
import {maskEmail} from '../../../platform/auth/admin';
import {SYSTEM_ROLES} from '../../../platform/auth/codenames';
import type {User} from '../kit/guards';
import {isOwnerAddress} from './owner-account';

/**
 * Team members' email addresses follow the site's rule (AGENTS.md › Never): an address is seen
 * only by its own person and the site's owner; everyone else sees it masked (`m•••@gmail.com`).
 * Kinroot never copies an account's email: it joins `users` (`withEmail`) when the SERVER needs it
 * (to send that person mail) and never puts another person's address in a list or a picker.
 */

/** Join for the account's email, server side only (sending mail to that person). */
export const withEmail = {user: {select: {email: true}}} as const satisfies Prisma.MemberInclude;

type MemberWithEmail = Member & {user: {email: string} | null};

/** A member row with its account's email (a pending invite: the invited address). */
export function asUser(m: MemberWithEmail): User {
  const {user, ...rest} = m;
  return {...rest, email: user?.email ?? m.inviteEmail ?? ''};
}

/** Who may see full addresses in the team list: the site's owner (the template's own rule). */
export async function seesEmails(c: Context): Promise<boolean> {
  const {roles} = await getAccess(c.req.raw);
  return roles.includes(SYSTEM_ROLES.OWNER);
}

/** The only shape of a team member that leaves the server for the team list and the profile. */
export function publicUser(user: Member & {email?: string | null}, view: {meId: string | null; owner: boolean}) {
  const email = user.email ?? user.inviteEmail ?? '';
  // The site owner's account has no address on the site: shown as "Account owner".
  const accountOwner = isOwnerAddress(email);
  return {
    id: user.id,
    /** The member's site account (`users.id`), so Settings → Team can offer that account's sign-in actions; null for a pending invite. */
    accountId: user.userId,
    email: accountOwner ? '' : view.owner || user.id === view.meId ? email : maskEmail(email),
    accountOwner,
    name: user.name,
    role: user.role,
    color: user.color,
    avatarUrl: user.avatarUrl,
    active: user.active,
    invited: user.userId === null && !!user.inviteEmail,
    lastSeenAt: user.lastSeenAt,
  };
}

/** Team members as other people see them (owners, authors, assignees, pickers): never an email. */
export const userSelect = {id: true, name: true, color: true, avatarUrl: true} as const;

/** Every team member's account address, lower-cased (recognising mail from the team; server side only). */
export async function teamAddresses(db: import('../kit/db').Db): Promise<string[]> {
  const rows = await db.member.findMany({where: {userId: {not: null}}, select: {user: {select: {email: true}}}});
  return rows.flatMap((r) => (r.user ? [r.user.email.toLowerCase()] : []));
}

/** One member as Kinroot server code uses a `User` (with the account email, for sending), or null. */
export async function memberWithEmail(db: import('../kit/db').Db, where: Prisma.MemberWhereInput, orderBy?: Prisma.MemberOrderByWithRelationInput): Promise<User | null> {
  const m = await db.member.findFirst({where, include: withEmail, ...(orderBy ? {orderBy} : {})});
  return m ? asUser(m) : null;
}
