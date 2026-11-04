import type {Db} from '../kit/db';
import {isAdmin} from '../kit/guards';
import type {ActivityLink} from './activity';
import {getSettings} from './settings';

export type NotificationType = 'mention' | 'assigned' | 'reminder' | 'activity' | 'stage_changed' | 'deal_won' | 'deal_lost' | 'email_in' | 'chat' | 'comment' | 'form' | 'ticket' | 'sla' | 'meeting' | 'score' | 'automation' | 'report' | 'import' | 'export';

type NotifyInput = {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  actorId?: string | null;
};

export const recordLink = {
  contact: (id: string) => `/contacts/${id}`,
  company: (id: string) => `/companies/${id}`,
  deal: (id: string) => `/deals/${id}`,
};

const linkFor = (l: ActivityLink) =>
  l.dealId ? recordLink.deal(l.dealId) : l.contactId ? recordLink.contact(l.contactId) : l.companyId ? recordLink.company(l.companyId) : null;

/** In-app notifications for these users, minus the person who did it. */
export async function notify(db: Db, userIds: (string | null | undefined)[], input: NotifyInput) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== input.actorId))];
  if (!ids.length) return;
  const users = await db.member.findMany({where: {id: {in: ids}, active: true}, select: {id: true}});
  if (!users.length) return;
  await db.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      type: input.type,
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 300) ?? null,
      link: input.link ?? null,
      actorId: input.actorId ?? null,
    })),
  });
}

/**
 * Owners and followers of the linked records. `title` may be a function of the
 * main record's name ("Acme · Renewal"), so callers don't have to load it.
 */
export async function notifyWatchers(
  db: Db,
  link: ActivityLink,
  input: Omit<NotifyInput, 'title'> & {title: string | ((record: string) => string); except?: string[]},
) {
  const [contact, company, deal] = await Promise.all([
    link.contactId ? db.contact.findUnique({where: {id: link.contactId}, select: {ownerId: true, firstName: true, lastName: true}}) : null,
    link.companyId ? db.company.findUnique({where: {id: link.companyId}, select: {ownerId: true, name: true}}) : null,
    link.dealId ? db.deal.findUnique({where: {id: link.dealId}, select: {ownerId: true, title: true}}) : null,
  ]);
  const records = [
    link.contactId && {entity: 'CONTACT' as const, recordId: link.contactId},
    link.companyId && {entity: 'COMPANY' as const, recordId: link.companyId},
    link.dealId && {entity: 'DEAL' as const, recordId: link.dealId},
  ].filter((r) => !!r);
  const [followRows, settings] = await Promise.all([
    records.length ? db.follow.findMany({where: {OR: records}, select: {userId: true, user: {select: {role: true}}}, take: 500}) : [],
    getSettings(db),
  ]);
  // With owner-only visibility, a follower hears only about records they may still see
  // (an admin, or the owner of one of the records); the notification carries the note's words.
  const owners = new Set([contact?.ownerId, company?.ownerId, deal?.ownerId].filter((id): id is string => !!id));
  const followers = settings.recordVisibility === 'owner' ? followRows.filter((f) => isAdmin(f.user) || owners.has(f.userId)) : followRows;
  const name = deal?.title ?? (contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : null) ?? company?.name ?? 'a record';
  const except = new Set(input.except ?? []);
  const ids = [contact?.ownerId, company?.ownerId, deal?.ownerId, ...followers.map((f) => f.userId)].filter((id) => id && !except.has(id));
  await notify(db, ids, {
    ...input,
    title: typeof input.title === 'function' ? input.title(name) : input.title,
    link: input.link ?? linkFor(link),
  });
}

/**
 * Team members mentioned as "@Full Name" (what the mention picker inserts).
 * Longest names first, so "@Sam Lee" doesn't also match "@Sam".
 */
export async function mentionedUsers(db: Db, text: string) {
  if (!text.includes('@')) return [];
  let rest = text.toLowerCase();
  const users = await db.member.findMany({where: {active: true}, select: {id: true, name: true}});
  const ids: string[] = [];
  for (const u of users.filter((u) => u.name).sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`@${u.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    if (!re.test(rest)) continue;
    ids.push(u.id);
    rest = rest.replace(re, ' ');
  }
  return ids;
}

/** Notifies people mentioned in a note or comment. Returns who was mentioned. */
export async function notifyMentions(db: Db, text: string, input: {actorId: string; actorName: string; where: string; link: string | null; only?: string[]}) {
  const ids = input.only ?? (await mentionedUsers(db, text));
  await notify(db, ids, {type: 'mention', title: `${input.actorName} mentioned you ${input.where}`, body: text, link: input.link, actorId: input.actorId});
  return ids;
}

export {linkFor};
