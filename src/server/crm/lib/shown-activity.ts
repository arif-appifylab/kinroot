import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {strings} from './json-list';

/**
 * Timeline entries as a person may see them (AUDIT-2 L-2). An entry's `title` was written when it
 * happened ("Deal created: Acme renewal", "Linked to Acme by email domain"), so under owner-only
 * visibility it can name a deal, company or contact this person may not open, on a record they can.
 * At read time such an entry gets a neutral title from its type, the hidden record's id is dropped,
 * and an entry that is ABOUT that record (created, won, a stage move…) loses its details too.
 * Admins and "everyone" visibility (an empty scope) see entries unchanged.
 */

const NEUTRAL: Record<string, string> = {
  note: 'Note added',
  email_out: 'Email sent',
  email_in: 'Email received',
  email_opened: 'Email opened',
  interaction_CALL: 'Call logged',
  interaction_MEETING: 'Meeting logged',
  interaction_EMAIL: 'Email logged',
  interaction_SMS: 'Text message logged',
  interaction_LINKEDIN: 'LinkedIn message logged',
  interaction_WHATSAPP: 'WhatsApp message logged',
  interaction_POSTAL: 'Postal mail logged',
  conversation_comment: 'Conversation comment',
  chat_conversation: 'Website chat',
  task_created: 'Task scheduled',
  task_done: 'Task completed',
  form_submitted: 'Form submitted',
  ticket_created: 'Ticket opened',
  ticket_status: 'Ticket status changed',
  ticket_reply: 'Ticket reply',
  file: 'File added',
  data_in_event: 'Event received',
  meeting_rescheduled: 'Meeting rescheduled',
  meeting_canceled: 'Meeting canceled',
  stage_changed: 'Deal stage changed',
  field_changed: 'Record updated',
  deal_created: 'Deal created',
  deal_won: 'Deal won',
  deal_lost: 'Deal lost',
  deal_reopened: 'Deal reopened',
  contact_created: 'Contact created',
  company_created: 'Company created',
  merged: 'Records merged',
  restored: 'Restored from the recycle bin',
  associated: 'Records linked',
  list_added: 'Added to a list',
  list_removed: 'Removed from a list',
  score_band: 'Lead score changed',
  import: 'Import',
};

/** Entries about a record itself: their details (value, stage names, changes, source) describe it. */
const ABOUT_A_RECORD = new Set([
  'stage_changed',
  'field_changed',
  'deal_created',
  'deal_won',
  'deal_lost',
  'deal_reopened',
  'contact_created',
  'company_created',
  'merged',
  'restored',
  'associated',
  'list_added',
  'list_removed',
  'score_band',
]);

export const neutralTitle = (type: string) => NEUTRAL[type] ?? 'Activity';

/** Select this with an entry so `shownEntry` knows who owns its records (one query per type, or joined). */
export const ENTRY_OWNERS = {
  contact: {select: {ownerId: true}},
  company: {select: {ownerId: true}},
  deal: {select: {ownerId: true}},
} as const satisfies Prisma.ActivitySelect;

type Owned = {ownerId: string | null} | null | undefined;
type EntryLinks = {contactId: string | null; companyId: string | null; dealId: string | null; contact?: Owned; company?: Owned; deal?: Owned};

/**
 * Which of an entry's records the scope hides. A linked record whose owner was not loaded counts
 * as hidden (fails closed).
 */
export function hiddenLinks(a: EntryLinks, scope: {ownerId?: string}) {
  const hid = (id: string | null, link: Owned) => !!scope.ownerId && !!id && link?.ownerId !== scope.ownerId;
  const hidden = {contact: hid(a.contactId, a.contact), company: hid(a.companyId, a.company), deal: hid(a.dealId, a.deal)};
  return {...hidden, any: hidden.contact || hidden.company || hidden.deal};
}

/**
 * Title search for a feed: under owner-only visibility only entries whose records are all visible
 * match on their title, so a search can't confirm a hidden record's name.
 */
export function titleSearch(q: string, scope: {ownerId?: string}): Prisma.ActivityWhereInput {
  const title: Prisma.ActivityWhereInput = {title: {contains: q, mode: 'insensitive'}};
  if (!scope.ownerId) return title;
  const s = {ownerId: scope.ownerId};
  return {AND: [title, {OR: [{contactId: null}, {contact: s}]}, {OR: [{companyId: null}, {company: s}]}, {OR: [{dealId: null}, {deal: s}]}]};
}

/**
 * The entry as this person may see it: unchanged when nothing is hidden, else a neutral title, the
 * hidden ids null and (for entries about a record) no `data` / `text`. The owner objects selected
 * with ENTRY_OWNERS are removed either way.
 */
export function shownEntry<T extends EntryLinks & {type: string; title: string; data?: Prisma.JsonValue; text?: string | null}>(a: T, scope: {ownerId?: string}) {
  const h = hiddenLinks(a, scope);
  const {contact: _c, company: _co, deal: _d, ...rest} = a;
  if (!h.any) return rest;
  const about = ABOUT_A_RECORD.has(a.type);
  return {
    ...rest,
    title: neutralTitle(a.type),
    contactId: h.contact ? null : a.contactId,
    companyId: h.company ? null : a.companyId,
    dealId: h.deal ? null : a.dealId,
    ...('data' in a && about ? {data: {}} : {}),
    ...('text' in a && about ? {text: null} : {}),
  };
}

/** An entry in a record's JSON export: `shownEntry` in the export's shape (type, title, data, date). */
export function exportedEntry<T extends EntryLinks & {type: string; title: string; data: Prisma.JsonValue; createdAt: Date}>(a: T, scope: {ownerId?: string}) {
  const s = shownEntry(a, scope);
  return {type: s.type, title: s.title, data: s.data, createdAt: s.createdAt};
}

// ─── Meeting attendees ───────────────────────────────────────────────────────

/** Of these contact ids, the ones this person may see (null: all of them, no owner-only visibility). */
async function visibleContacts(db: Db, ids: string[], scope: {ownerId?: string}): Promise<Set<string> | null> {
  if (!scope.ownerId) return null;
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const rows = await db.contact.findMany({where: {id: {in: unique}, ownerId: scope.ownerId}, select: {id: true}});
  return new Set(rows.map((r) => r.id));
}

type Attendee = {id: string; name: string};
const attendeesOf = (data: Prisma.JsonValue | undefined): Attendee[] | null => {
  const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).attendees : null;
  return Array.isArray(list) ? list.filter((a): a is Attendee => !!a && typeof (a as Attendee).id === 'string') : null;
};

/**
 * Meeting entries keep a snapshot of their attendees' names (`data.attendees`). Under owner-only
 * visibility, attendees this person may not see are left out and only counted (`attendeesHidden`),
 * so a meeting on a visible record never names another member's contacts. One query for the page.
 */
export async function withShownAttendees<T extends {data?: Prisma.JsonValue}>(db: Db, entries: T[], scope: {ownerId?: string}): Promise<T[]> {
  if (!scope.ownerId) return entries;
  const visible = await visibleContacts(db, entries.flatMap((e) => attendeesOf(e.data)?.map((a) => a.id) ?? []), scope);
  if (!visible) return entries;
  return entries.map((e) => {
    const list = attendeesOf(e.data);
    if (!list) return e;
    const shown = list.filter((a) => visible.has(a.id));
    if (shown.length === list.length) return e;
    return {...e, data: {...(e.data as Record<string, unknown>), attendees: shown, attendeesHidden: list.length - shown.length} as Prisma.JsonValue};
  });
}

/** Interactions in an export: only the attendee ids this person may see. One query for all of them. */
export async function withShownAttendeeIds<T extends {attendeeIds: Prisma.JsonValue}>(db: Db, rows: T[], scope: {ownerId?: string}): Promise<T[]> {
  const visible = await visibleContacts(db, rows.flatMap((r) => strings(r.attendeeIds)), scope);
  if (!visible) return rows;
  return rows.map((r) => ({...r, attendeeIds: strings(r.attendeeIds).filter((id) => visible.has(id))}));
}
