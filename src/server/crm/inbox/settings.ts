import type {EmailAccount, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {DEFAULT_INBOX_SETTINGS, domainOf, type InboxSettings} from '@/lib/inbox';
import type {Db} from '../kit/db';
import {isAdmin} from '../kit/guards';

/** Inbox settings live in the `inbox` Setting row (Settings → Inbox, admins only). */
const KEY = 'inbox';

export async function getInboxSettings(db: Db): Promise<InboxSettings> {
  const row = await db.setting.findUnique({where: {key: KEY}});
  return {...DEFAULT_INBOX_SETTINGS, ...((row?.value ?? {}) as Partial<InboxSettings>)};
}

export async function saveInboxSettings(db: Db, patch: Partial<InboxSettings>) {
  const value = {...(await getInboxSettings(db)), ...patch};
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value: value as Prisma.InputJsonValue}, update: {value: value as Prisma.InputJsonValue}});
  return value;
}

/** The team inbox as one value: settings plus the shared accounts that feed it. */
export type InboxContext = {settings: InboxSettings; teamAccountIds: string[]};

export async function inboxContext(db: Db): Promise<InboxContext> {
  const settings = await getInboxSettings(db);
  const shared = await db.emailAccount.findMany({where: {userId: null}, select: {id: true}});
  const ids = shared.map((a) => a.id);
  return {settings, teamAccountIds: settings.teamAccounts === 'all' ? ids : ids.filter((id) => settings.teamAccounts.includes(id))};
}

/** Admins always work the team inbox; members when access is "everyone" or they were picked. */
export function hasTeamAccess(user: Pick<User, 'id' | 'role'>, settings: InboxSettings) {
  return isAdmin(user as User) || settings.access === 'everyone' || settings.memberIds.includes(user.id);
}

/** Does this account's mail belong to the team inbox? */
export const feedsTeamInbox = (ctx: InboxContext, account: Pick<EmailAccount, 'id' | 'userId'> | null) => !!account && account.userId === null && ctx.teamAccountIds.includes(account.id);

/** Blocked sender: the exact address or its domain. */
export function isBlocked(settings: InboxSettings, email: string) {
  const e = email.toLowerCase();
  return settings.blockedAddresses.includes(e) || settings.blockedDomains.includes(domainOf(e));
}
