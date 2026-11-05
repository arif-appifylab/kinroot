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
  const ids = [contact?.ownerId, company?.ownerId, deal?.ownerId, ...followers.map((f) => f.userId)].filter((id): id is string => !!id && !except.has(id));
  const title = input.title;
  if (typeof title !== 'function' || settings.recordVisibility !== 'owner') {
    await notify(db, ids, {...input, title: typeof title === 'function' ? title(name) : title, link: input.link ?? linkFor(link)});
    return;
  }
  // Owner-only visibility: each person reads the name (and opens the link) of a record they may
  // see. A note can be on their contact and on someone else's deal (AUDIT-2 L-2).
  const roles = new Map(followRows.map((f) => [f.userId, f.user.role]));
  const unknown = ids.filter((id) => !roles.has(id));
  if (unknown.length) for (const m of await db.member.findMany({where: {id: {in: unknown}}, select: {id: true, role: true}})) roles.set(m.id, m.role);
  const contactName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'a contact' : null;
  const groups = new Map<string, {name: string; link: string | null; ids: string[]}>();
  for (const id of new Set(ids)) {
    const role = roles.get(id);
    const seen =
      role && isAdmin({role}) ? {name, link: linkFor(link)}
      : deal && link.dealId && deal.ownerId === id ? {name: deal.title, link: recordLink.deal(link.dealId)}
      : contact && link.contactId && contact.ownerId === id ? {name: contactName!, link: recordLink.contact(link.contactId)}
      : company && link.companyId && company.ownerId === id ? {name: company.name, link: recordLink.company(link.companyId)}
      : null;
    if (!seen) continue;
    const key = `${seen.name}\n${seen.link}`;
    if (!groups.has(key)) groups.set(key, {...seen, ids: []});
    groups.get(key)!.ids.push(id);
  }
  await Promise.all([...groups.values()].map((g) => notify(db, g.ids, {...input, title: title(g.name), link: input.link ?? g.link})));
}

/**
 * Team members mentioned as "@Full Name" (what the mention picker inserts).
 * Longest names first, so "@Sam Lee" doesn't also match "@Sam".
 */
export async function mentionedUsers(db: Db, text: string) {
  return (await mentionedUsersIn(db, [text]))[0]!;
}

/** mentionedUsers() of several texts with ONE read of the team (an edit compares the old and new words). */
export async function mentionedUsersIn(db: Db, texts: string[]): Promise<string[][]> {
  if (!texts.some((t) => t.includes('@'))) return texts.map(() => []);
  const users = await db.member.findMany({where: {active: true}, select: {id: true, name: true}, take: 1000});
  return texts.map((t) => (t.includes('@') ? matchMentions(users, t) : []));
}

function matchMentions(users: {id: string; name: string}[], text: string) {
  let rest = text.toLowerCase();
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
