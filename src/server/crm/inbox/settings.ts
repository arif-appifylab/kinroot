import type {EmailAccount, Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {DEFAULT_INBOX_SETTINGS, domainOf, type InboxSettings} from '@/lib/inbox';
import type {Db} from '../kit/db';
import {isAdmin} from '../kit/guards';
import {cache} from '../../../platform/cache';

/** Inbox settings live in the `inbox` Setting row (Settings → Inbox, admins only). */
const KEY = 'inbox';

/** The Site Cache key of the inbox settings (docs/agent/cache.md); `saveInboxSettings` clears it. */
export const INBOX_SETTINGS_CACHE_KEY = 'crm:inbox-settings';

/**
 * Read by every inbox request, the badges and the website chat's availability; changed only in
 * Settings → Inbox: kept in the Site Cache for 10 minutes, cleared the moment they are saved.
 * (Blocked senders are here too: an owner's own list, never visitor data.)
 */
export async function getInboxSettings(db: Db): Promise<InboxSettings> {
  return cache.getOrSet(INBOX_SETTINGS_CACHE_KEY, 600, async () => {
    const row = await db.setting.findUnique({where: {key: KEY}});
    return {...DEFAULT_INBOX_SETTINGS, ...((row?.value ?? {}) as Partial<InboxSettings>)};
  });
}

export async function saveInboxSettings(db: Db, patch: Partial<InboxSettings>) {
  const row = await db.setting.findUnique({where: {key: KEY}}); // the stored row, never the cached copy, as the base
  const value = {...DEFAULT_INBOX_SETTINGS, ...((row?.value ?? {}) as Partial<InboxSettings>), ...patch};
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value: value as Prisma.InputJsonValue}, update: {value: value as Prisma.InputJsonValue}});
  await Promise.all([cache.del(INBOX_SETTINGS_CACHE_KEY), cache.del(CHAT_ONLINE_CACHE_KEY)]); // who counts as online depends on access / round robin
  return value;
}

/** The team inbox as one value: settings plus the shared accounts that feed it. */
export type InboxContext = {settings: InboxSettings; teamAccountIds: string[]};

export async function inboxContext(db: Db): Promise<InboxContext> {
  const [settings, shared] = await Promise.all([getInboxSettings(db), db.emailAccount.findMany({where: {userId: null}, select: {id: true}})]);
  const ids = shared.map((a) => a.id);
  return {settings, teamAccountIds: settings.teamAccounts === 'all' ? ids : ids.filter((id) => settings.teamAccounts.includes(id))};
}

/**
 * The Site Cache key of "is any agent online for website chat" (inbox/chat.ts `chatAvailability`),
 * here so the settings and the badges' "last seen" stamp can clear it without an import cycle.
 */
export const CHAT_ONLINE_CACHE_KEY = 'crm:chat-online';

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
