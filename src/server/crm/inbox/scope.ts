import type {Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {CHANNEL_KEYS, MESSAGE_CHANNELS, type ChannelFilter, type InboxView} from '@/lib/inbox';
import type {Db} from '../kit/db';
import {isAdmin} from '../kit/guards';
import {hasTeamAccess, inboxContext, type InboxContext} from './settings';

/**
 * Who sees which conversation. One function, used by the list, the detail,
 * the counts, search and bulk actions, so they never disagree:
 *
 * - personal mailboxes (EmailAccount.userId set): only that account's owner;
 * - the team inbox (shared accounts it is fed by, the form and chat channels, and
 *   unassigned threads without a mailbox, e.g. BCC-logged mail): admins, plus
 *   members with team-inbox access, all of it or only theirs and unassigned
 *   ones (Settings → Inbox);
 * - a thread without a mailbox that is assigned to someone stays with them
 *   (a removed personal mailbox keeps its mail private).
 *
 * `listable` is what the inbox lists. `readable` adds threads that are not
 * inbox conversations but open from a contact's timeline as before: ticket
 * threads and shared accounts that don't feed the team inbox.
 */
export type InboxScope = {ctx: InboxContext; team: boolean; listable: Prisma.EmailThreadWhereInput; readable: Prisma.EmailThreadWhereInput};

export async function inboxScope(db: Db, user: Pick<User, 'id' | 'role'>, ctx?: InboxContext): Promise<InboxScope> {
  const c = ctx ?? (await inboxContext(db));
  const team = hasTeamAccess(user, c.settings);
  const narrow: Prisma.EmailThreadWhereInput = isAdmin(user) || c.settings.visibility === 'all' ? {} : {OR: [{assigneeId: user.id}, {assigneeId: null}]};
  const own: Prisma.EmailThreadWhereInput[] = [
    {channel: 'email', account: {userId: user.id}},
    {channel: 'email', accountId: null, assigneeId: user.id},
  ];
  const teamWhere: Prisma.EmailThreadWhereInput = {
    AND: [narrow, {OR: [{channel: 'email', accountId: {in: c.teamAccountIds}}, {channel: {in: ['form', ...MESSAGE_CHANNELS]}}, {channel: 'email', accountId: null, assigneeId: null}]}],
  };
  const listable: Prisma.EmailThreadWhereInput = {OR: [...own, ...(team ? [teamWhere] : [])]};
  const other: Prisma.EmailThreadWhereInput = {OR: [{channel: 'ticket'}, {channel: 'email', account: {userId: null}, accountId: {notIn: c.teamAccountIds}}]};
  return {ctx: c, team, listable, readable: {OR: [listable, other]}};
}

/** Legacy thread endpoints (contact pages): everything except other people's personal mailboxes. */
export const notOthersPersonal = (user: User): Prisma.EmailThreadWhereInput => ({OR: [{accountId: null}, {account: {userId: null}}, {account: {userId: user.id}}]});

const notSnoozed: Prisma.EmailThreadWhereInput = {snoozedUntil: null};
const live: Prisma.EmailThreadWhereInput = {spamAt: null, trashedAt: null};
const conversation: Prisma.EmailThreadWhereInput = {firstInboundAt: {not: null}, channel: {in: CHANNEL_KEYS}};

/** The where of one left-navigation view or folder, for this user. */
export function viewWhere(view: InboxView, user: User): Prisma.EmailThreadWhereInput {
  switch (view) {
    case 'unassigned':
      return {...conversation, ...live, ...notSnoozed, status: 'OPEN', assigneeId: null};
    case 'mine':
      return {...conversation, ...live, ...notSnoozed, status: 'OPEN', assigneeId: user.id};
    case 'open':
      return {...conversation, ...live, ...notSnoozed, status: 'OPEN'};
    case 'snoozed':
      return {...conversation, ...live, status: 'OPEN', snoozedUntil: {not: null}};
    case 'closed':
      return {...conversation, ...live, status: 'CLOSED'};
    case 'sent':
      return {...live, channel: {in: CHANNEL_KEYS}, OR: [{messages: {some: {direction: 'OUTBOUND'}}}, {channelMessages: {some: {direction: 'OUTBOUND', kind: 'text'}}}]};
    case 'spam':
      return {channel: {in: CHANNEL_KEYS}, spamAt: {not: null}, trashedAt: null};
    case 'trash':
      return {channel: {in: CHANNEL_KEYS}, trashedAt: {not: null}};
  }
}

/** Channel filter: the team inbox's email, the viewer's own mailboxes, form responses or website chats. */
export function channelWhere(channel: ChannelFilter, user: User, ctx: InboxContext): Prisma.EmailThreadWhereInput {
  if (channel === 'personal') return {channel: 'email', account: {userId: user.id}};
  if (channel === 'form') return {channel: 'form'};
  if (channel === 'chat') return {channel: 'chat'};
  return {channel: 'email', OR: [{accountId: {in: ctx.teamAccountIds}}, {accountId: null, assigneeId: null}]};
}
