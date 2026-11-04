import {Prisma, type DeletedRecord} from '../../../generated/prisma/client';
import {BIN_DAYS, type BinEntity} from '@/lib/hygiene';
import type {Db} from '../kit/db';
import {logActivity} from './activity';
import {emit} from './events';
import {purgeFileRows} from '../kit/storage';
import {strings} from './json-list';
import {clip, COMPANY_LIMITS, CONTACT_LIMITS, DEAL_LIMITS, FORM_LIMITS} from '@/lib/record-limits';

/**
 * Recycle bin. Deleting a contact, company, deal, ticket, form, list or inbox conversation goes
 * through `moveToBin()`: it snapshots the record and every row its delete
 * cascades (notes, tasks, timeline, comments, interactions, links, list
 * memberships, ticket messages, form responses…), remembers rows the delete
 * only unlinks (email threads, tickets, responses…), parks files as
 * purpose "trash", then deletes. `restoreFromBin()` re-creates everything with
 * the same ids, skipping links whose other side is gone since. Entries expire
 * after BIN_DAYS and are purged by the job runner (`purgeExpiredBin()`).
 *
 * To make a new table restorable: add it to TABLES (columns come from the
 * generated client, so later columns are kept automatically) and collect its
 * rows in the entity's collector below. See AGENTS.md.
 */

type Row = Record<string, unknown>;
/** Column lengths of the binned main records (src/crm/lib/record-limits.ts; Ticket.subject from crm_text_lengths_2). */
const RESTORE_LIMITS: Record<string, Readonly<Record<string, number>>> = {contact: CONTACT_LIMITS, company: COMPANY_LIMITS, deal: DEAL_LIMITS, form: FORM_LIMITS, ticket: {subject: 300}};

type Target = 'user' | 'contact' | 'company' | 'deal' | 'stage' | 'activity' | 'ticket' | 'form' | 'contactList' | 'scoreRule' | 'emailAccount' | 'emailThread' | 'emailMessage' | 'channelIdentity';
type Fk = Target | `${Target}!`;

/** Every table a snapshot can hold, in restore order. `!` = required link: without its other side the row is skipped; other links are cleared. */
const TABLES = {
  contact: {cols: Prisma.ContactScalarFieldEnum, fk: {ownerId: 'user'}},
  company: {cols: Prisma.CompanyScalarFieldEnum, fk: {ownerId: 'user'}},
  deal: {cols: Prisma.DealScalarFieldEnum, fk: {ownerId: 'user', companyId: 'company'}},
  ticket: {cols: Prisma.TicketScalarFieldEnum, fk: {assigneeId: 'user', contactId: 'contact', companyId: 'company', dealId: 'deal'}},
  form: {cols: Prisma.FormScalarFieldEnum, fk: {createdById: 'user'}},
  contactList: {cols: Prisma.ContactListScalarFieldEnum, fk: {ownerId: 'user'}},
  contactCompany: {cols: Prisma.ContactCompanyScalarFieldEnum, fk: {contactId: 'contact!', companyId: 'company!'}},
  dealContact: {cols: Prisma.DealContactScalarFieldEnum, fk: {dealId: 'deal!', contactId: 'contact!'}},
  dealCompany: {cols: Prisma.DealCompanyScalarFieldEnum, fk: {dealId: 'deal!', companyId: 'company!'}},
  stageChange: {cols: Prisma.StageChangeScalarFieldEnum, fk: {dealId: 'deal!', fromStageId: 'stage', toStageId: 'stage', userId: 'user'}},
  note: {cols: Prisma.NoteScalarFieldEnum, fk: {authorId: 'user', contactId: 'contact', companyId: 'company', dealId: 'deal'}},
  task: {cols: Prisma.TaskScalarFieldEnum, fk: {assigneeId: 'user', creatorId: 'user', contactId: 'contact', companyId: 'company', dealId: 'deal'}},
  activity: {cols: Prisma.ActivityScalarFieldEnum, fk: {actorId: 'user', contactId: 'contact', companyId: 'company', dealId: 'deal'}},
  activityComment: {cols: Prisma.ActivityCommentScalarFieldEnum, fk: {activityId: 'activity!', authorId: 'user'}},
  interaction: {cols: Prisma.InteractionScalarFieldEnum, fk: {authorId: 'user', contactId: 'contact', companyId: 'company', dealId: 'deal'}},
  contactListMember: {cols: Prisma.ContactListMemberScalarFieldEnum, fk: {listId: 'contactList!', contactId: 'contact!'}},
  // Lead-score history, so a restored contact keeps its score breakdown (a deleted rule just unlinks).
  scoreEvent: {cols: Prisma.ScoreEventScalarFieldEnum, fk: {contactId: 'contact!', ruleId: 'scoreRule'}},
  ticketMessage: {cols: Prisma.TicketMessageScalarFieldEnum, fk: {ticketId: 'ticket!', authorId: 'user'}},
  formSubmission: {cols: Prisma.FormSubmissionScalarFieldEnum, fk: {formId: 'form!', contactId: 'contact', dealId: 'deal'}},
  // Shared inbox conversations (module 10): the thread, its messages with their tracking, and comments.
  emailThread: {cols: Prisma.EmailThreadScalarFieldEnum, fk: {accountId: 'emailAccount', contactId: 'contact', companyId: 'company', dealId: 'deal', assigneeId: 'user', identityId: 'channelIdentity'}},
  emailMessage: {cols: Prisma.EmailMessageScalarFieldEnum, fk: {threadId: 'emailThread!', accountId: 'emailAccount', senderId: 'user', contactId: 'contact'}},
  trackingEvent: {cols: Prisma.TrackingEventScalarFieldEnum, fk: {messageId: 'emailMessage!'}},
  conversationComment: {cols: Prisma.ConversationCommentScalarFieldEnum, fk: {threadId: 'emailThread!', authorId: 'user'}},
  // Chat messages of a conversation (and any future channel's); their files are parked with the entry.
  channelMessage: {cols: Prisma.ChannelMessageScalarFieldEnum, fk: {threadId: 'emailThread!', identityId: 'channelIdentity', senderId: 'user', contactId: 'contact'}},
} satisfies Record<string, {cols: Record<string, string>; fk: Record<string, Fk>}>;

type Table = keyof typeof TABLES;
const MAIN: Record<BinEntity, Table> = {contact: 'contact', company: 'company', deal: 'deal', ticket: 'ticket', form: 'form', list: 'contactList', conversation: 'emailThread'};
const LINK_COLUMN: Partial<Record<BinEntity, 'contactId' | 'companyId' | 'dealId'>> = {contact: 'contactId', company: 'companyId', deal: 'dealId'};
const FILE_LINKS = ['contactId', 'companyId', 'dealId'] as const;

type FileRef = {id: string; purpose: string; contactId: string | null; companyId: string | null; dealId: string | null; trashed: boolean};

/** What one bin entry holds. Rows are plain JSON (dates as ISO strings, which Prisma accepts back). */
export type Snapshot = {
  v: 1;
  record: Row;
  rows: Partial<Record<Table, Row[]>>;
  /** Rows the delete only unlinked: "emailThread.contactId" → ids to point back at the record. */
  relink: Record<string, string[]>;
  files: FileRef[];
};

type Delegate = {
  findMany: (args: unknown) => Promise<Row[]>;
  createMany: (args: unknown) => Prisma.PrismaPromise<unknown>;
  updateMany: (args: unknown) => Prisma.PrismaPromise<unknown>;
  deleteMany: (args: unknown) => Prisma.PrismaPromise<unknown>;
};
const model = (db: Db, name: string) => (db as unknown as Record<string, Delegate>)[name]!;

/** JSON-safe copy (Dates → ISO strings). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const groupBy = (rows: Row[], key: string) => {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key] as string | null;
    if (k) map.set(k, [...(map.get(k) ?? []), r]);
  }
  return map;
};

// ─── Collect: what a delete takes with it ───

type Collected = {
  records: Row[];
  /** per record id: table → rows */
  rows: Map<string, Partial<Record<Table, Row[]>>>;
  relink: Map<string, Record<string, string[]>>;
  /** Extra rows to delete that are not cascaded by the database (ticket timeline entries). */
  alsoDelete: {table: Table; ids: string[]}[];
  files: Map<string, FileRef[]>;
};

/** Timeline entries + their comments, grouped by the given column. */
async function activitiesBy(db: Db, column: 'contactId' | 'companyId' | 'dealId', ids: string[]) {
  const activities = (await db.activity.findMany({where: {[column]: {in: ids}}})) as unknown as Row[];
  const comments = activities.length ? ((await db.activityComment.findMany({where: {activityId: {in: activities.map((a) => a.id as string)}}})) as unknown as Row[]) : [];
  return {activities, comments};
}

/**
 * Files linked by `column`. Attachments that hang off this record only are
 * parked as "trash"; everything else (files also on another record, form
 * uploads and ticket files, which their response / ticket still shows) is just unlinked.
 */
async function filesBy(db: Db, column: 'contactId' | 'companyId' | 'dealId', ids: string[]) {
  const files = await db.file.findMany({where: {[column]: {in: ids}}, select: {id: true, purpose: true, contactId: true, companyId: true, dealId: true}});
  const byRecord = new Map<string, FileRef[]>();
  for (const f of files) {
    const owner = f[column]!;
    const others = FILE_LINKS.filter((k) => k !== column && f[k]);
    const ref: FileRef = {...f, trashed: f.purpose === 'attachment' && others.length === 0};
    byRecord.set(owner, [...(byRecord.get(owner) ?? []), ref]);
  }
  return byRecord;
}

function attach(target: Collected, column: string, table: Table, rows: Row[]) {
  for (const [id, list] of groupBy(rows, column)) {
    const entry = target.rows.get(id) ?? {};
    entry[table] = [...(entry[table] ?? []), ...list];
    target.rows.set(id, entry);
  }
}

function attachComments(target: Collected, activities: Row[], comments: Row[], column: string) {
  const ownerOf = new Map(activities.map((a) => [a.id as string, a[column] as string]));
  for (const c of comments) {
    const id = ownerOf.get(c.activityId as string);
    if (!id) continue;
    const entry = target.rows.get(id) ?? {};
    entry.activityComment = [...(entry.activityComment ?? []), c];
    target.rows.set(id, entry);
  }
}

async function relinkIds(db: Db, target: Collected, ids: string[], links: [string, string][]) {
  // The tables are read together (one round trip), then folded in in a fixed order.
  const found = await Promise.all(links.map(([table, column]) => model(db, table).findMany({where: {[column]: {in: ids}}, select: {id: true, [column]: true}})));
  for (const [i, [table, column]] of links.entries()) {
    const rows = found[i]!;
    for (const r of rows) {
      const entry = target.relink.get(r[column] as string) ?? {};
      const key = `${table}.${column}`;
      entry[key] = [...(entry[key] ?? []), r.id as string];
      target.relink.set(r[column] as string, entry);
    }
  }
}

/** Shared shape of contacts, companies and deals: everything hangs off one link column. */
async function collectRecord(db: Db, entity: 'contact' | 'company' | 'deal', ids: string[]): Promise<Collected> {
  const column = LINK_COLUMN[entity] as 'contactId' | 'companyId' | 'dealId';
  const where = {[column]: {in: ids}};
  // Independent reads together: the whole selection costs a few round trips, not a few per record.
  const [records, files, notes, tasks, interactions, {activities, comments}] = await Promise.all([
    model(db, entity).findMany({where: {id: {in: ids}}}),
    filesBy(db, column, ids),
    model(db, 'note').findMany({where}),
    model(db, 'task').findMany({where}),
    model(db, 'interaction').findMany({where}),
    activitiesBy(db, column, ids),
  ]);
  const out: Collected = {records, rows: new Map(), relink: new Map(), alsoDelete: [], files};
  attach(out, column, 'note', notes);
  attach(out, column, 'task', tasks);
  attach(out, column, 'interaction', interactions);
  attach(out, column, 'activity', activities);
  attachComments(out, activities, comments, column);

  if (entity === 'contact') {
    const [companies, deals, members, scores] = await Promise.all([
      model(db, 'contactCompany').findMany({where}),
      model(db, 'dealContact').findMany({where}),
      model(db, 'contactListMember').findMany({where}),
      model(db, 'scoreEvent').findMany({where}),
    ]);
    attach(out, column, 'contactCompany', companies);
    attach(out, column, 'dealContact', deals);
    attach(out, column, 'contactListMember', members);
    attach(out, column, 'scoreEvent', scores);
    await relinkIds(db, out, ids, [['emailThread', 'contactId'], ['emailMessage', 'contactId'], ['formSubmission', 'contactId'], ['ticket', 'contactId'], ['channelMessage', 'contactId'], ['channelIdentity', 'contactId']]);
  }
  if (entity === 'company') {
    const [contacts, deals] = await Promise.all([model(db, 'contactCompany').findMany({where}), model(db, 'dealCompany').findMany({where})]);
    attach(out, column, 'contactCompany', contacts);
    attach(out, column, 'dealCompany', deals);
    await relinkIds(db, out, ids, [['deal', 'companyId'], ['emailThread', 'companyId'], ['ticket', 'companyId']]);
  }
  if (entity === 'deal') {
    const [contacts, companies, stages] = await Promise.all([
      model(db, 'dealContact').findMany({where}),
      model(db, 'dealCompany').findMany({where}),
      model(db, 'stageChange').findMany({where}),
    ]);
    attach(out, column, 'dealContact', contacts);
    attach(out, column, 'dealCompany', companies);
    attach(out, column, 'stageChange', stages);
    await relinkIds(db, out, ids, [['emailThread', 'dealId'], ['formSubmission', 'dealId'], ['ticket', 'dealId']]);
  }
  return out;
}

async function collectTickets(db: Db, ids: string[]): Promise<Collected> {
  const records = await model(db, 'ticket').findMany({where: {id: {in: ids}}});
  const out: Collected = {records, rows: new Map(), relink: new Map(), alsoDelete: [], files: new Map()};
  const messages = await model(db, 'ticketMessage').findMany({where: {ticketId: {in: ids}}});
  attach(out, 'ticketId', 'ticketMessage', messages);
  // Ticket timeline entries point at the ticket through data.ticketId (not a foreign key).
  const activityIds = ids.length ? await db.$queryRaw<{id: string}[]>`SELECT id FROM "Activity" WHERE type LIKE 'ticket\\_%' AND data->>'ticketId' IN (${Prisma.join(ids)})` : [];
  if (activityIds.length) {
    const activities = (await db.activity.findMany({where: {id: {in: activityIds.map((a) => a.id)}}})) as unknown as Row[];
    const comments = (await db.activityComment.findMany({where: {activityId: {in: activities.map((a) => a.id as string)}}})) as unknown as Row[];
    const withTicket = activities.map((a) => ({...a, __ticketId: (a.data as {ticketId?: string}).ticketId}));
    attach(out, '__ticketId', 'activity', withTicket);
    attachComments(out, withTicket, comments, '__ticketId');
    out.alsoDelete.push({table: 'activity', ids: activities.map((a) => a.id as string)});
  }
  const fileIds = messages.flatMap((m) => strings(m.fileIds as Prisma.JsonValue));
  if (fileIds.length) {
    const files = await db.file.findMany({where: {id: {in: fileIds}, purpose: 'ticket'}, select: {id: true, purpose: true, contactId: true, companyId: true, dealId: true}});
    for (const m of messages) {
      const mine = files.filter((f) => strings(m.fileIds as Prisma.JsonValue).includes(f.id)).map((f) => ({...f, trashed: true}));
      if (mine.length) out.files.set(m.ticketId as string, [...(out.files.get(m.ticketId as string) ?? []), ...mine]);
    }
  }
  return out;
}

async function collectForms(db: Db, ids: string[]): Promise<Collected> {
  const records = await model(db, 'form').findMany({where: {id: {in: ids}}});
  const out: Collected = {records, rows: new Map(), relink: new Map(), alsoDelete: [], files: new Map()};
  attach(out, 'formId', 'formSubmission', await model(db, 'formSubmission').findMany({where: {formId: {in: ids}}}));
  return out;
}

async function collectLists(db: Db, ids: string[]): Promise<Collected> {
  const records = await model(db, 'contactList').findMany({where: {id: {in: ids}}});
  const out: Collected = {records, rows: new Map(), relink: new Map(), alsoDelete: [], files: new Map()};
  attach(out, 'listId', 'contactListMember', await model(db, 'contactListMember').findMany({where: {listId: {in: ids}}}));
  return out;
}

/** A conversation (EmailThread): its messages (email and chat), their open / click events, the internal comments and chat files. */
async function collectConversations(db: Db, ids: string[]): Promise<Collected> {
  const records = await model(db, 'emailThread').findMany({where: {id: {in: ids}}});
  const out: Collected = {records, rows: new Map(), relink: new Map(), alsoDelete: [], files: new Map()};
  const messages = await model(db, 'emailMessage').findMany({where: {threadId: {in: ids}}});
  attach(out, 'threadId', 'emailMessage', messages);
  const threadOf = new Map(messages.map((m) => [m.id as string, m.threadId as string]));
  const events = messages.length ? await model(db, 'trackingEvent').findMany({where: {messageId: {in: [...threadOf.keys()]}}}) : [];
  attach(out, '__threadId', 'trackingEvent', events.map((e) => ({...e, __threadId: threadOf.get(e.messageId as string)})));
  attach(out, 'threadId', 'conversationComment', await model(db, 'conversationComment').findMany({where: {threadId: {in: ids}}}));
  const chat = await model(db, 'channelMessage').findMany({where: {threadId: {in: ids}}});
  attach(out, 'threadId', 'channelMessage', chat);
  // Chat files belong to their message only: parked as "trash" with the entry, back to "chat" on restore.
  const fileIds = chat.flatMap((m) => strings(m.fileIds as Prisma.JsonValue));
  if (fileIds.length) {
    const files = await db.file.findMany({where: {id: {in: fileIds}, purpose: 'chat'}, select: {id: true, purpose: true, contactId: true, companyId: true, dealId: true}});
    for (const m of chat) {
      const mine = files.filter((f) => strings(m.fileIds as Prisma.JsonValue).includes(f.id)).map((f) => ({...f, trashed: true}));
      if (mine.length) out.files.set(m.threadId as string, [...(out.files.get(m.threadId as string) ?? []), ...mine]);
    }
  }
  // The conversation's one timeline entry (chat) points at it by refId.
  const activities = (await db.activity.findMany({where: {refId: {in: ids}, type: {endsWith: '_conversation'}}})) as unknown as Row[];
  if (activities.length) {
    const comments = (await db.activityComment.findMany({where: {activityId: {in: activities.map((a) => a.id as string)}}})) as unknown as Row[];
    const withThread = activities.map((a) => ({...a, __threadId: a.refId}));
    attach(out, '__threadId', 'activity', withThread);
    attachComments(out, withThread, comments, '__threadId');
    out.alsoDelete.push({table: 'activity', ids: activities.map((a) => a.id as string)});
  }
  return out;
}

const COLLECT: Record<BinEntity, (db: Db, ids: string[]) => Promise<Collected>> = {
  contact: (db, ids) => collectRecord(db, 'contact', ids),
  company: (db, ids) => collectRecord(db, 'company', ids),
  deal: (db, ids) => collectRecord(db, 'deal', ids),
  ticket: collectTickets,
  form: collectForms,
  list: collectLists,
  conversation: collectConversations,
};

const money = (value: unknown, currency: unknown) => {
  try {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: String(currency || 'USD'), maximumFractionDigits: 0}).format(Number(value) || 0);
  } catch {
    return String(value);
  }
};

/** Name and one line of detail for the bin list. */
function describe(entity: BinEntity, r: Row): {label: string; detail: string | null} {
  switch (entity) {
    case 'contact':
      return {label: [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Contact', detail: (r.email ?? r.phone ?? null) as string | null};
    case 'company':
      return {label: String(r.name ?? 'Company'), detail: (r.domain ?? null) as string | null};
    case 'deal':
      return {label: String(r.title ?? 'Deal'), detail: `${money(r.value, r.currency)} · ${String(r.status).toLowerCase()}`};
    case 'ticket':
      return {label: `#${r.number} ${r.subject}`, detail: String(r.status).replace(/_/g, ' ').toLowerCase()};
    case 'form':
      return {label: String(r.name ?? 'Form'), detail: `/${r.slug}`};
    case 'list':
      return {label: String(r.name ?? 'List'), detail: r.kind === 'DYNAMIC' ? 'Segment' : 'Static list'};
    case 'conversation':
      return {label: String(r.subject ?? 'Conversation'), detail: r.channel === 'form' ? 'Form conversation' : r.channel === 'chat' ? 'Website chat' : 'Email conversation'};
  }
}

// ─── Delete ───

export type BinActor = {id: string; name: string};

/** Records one bin transaction takes at most; bulk deletes are capped at this per request (AUDIT-2 M-14). */
export const BIN_BATCH = 100;

/** The main tables, for the row lock (fixed names, never input). */
const LOCK_TABLE: Record<BinEntity, string> = {contact: '"Contact"', company: '"Company"', deal: '"Deal"', ticket: '"Ticket"', form: '"Form"', list: '"ContactList"', conversation: '"EmailThread"'};

/**
 * Moves records to the recycle bin and deletes them, BIN_BATCH records per transaction (so one
 * snapshot never holds more than that in memory). Returns the bin entries (for "Undo"). Events,
 * audit and permission checks stay with the caller.
 */
export async function moveToBin(db: Db, entity: BinEntity, ids: string[], actor: BinActor | null) {
  const out: {id: string; recordId: string}[] = [];
  for (let k = 0; k < ids.length; k += BIN_BATCH) out.push(...(await binBatch(db, entity, ids.slice(k, k + BIN_BATCH), actor)));
  return out;
}

/**
 * One transaction: locks the records, collects everything their delete takes with it, writes the
 * bin entries and deletes. Collected inside the transaction, after the lock, so a note or a task
 * added to a record meanwhile waits (then fails on the deleted record) instead of being deleted
 * without being in the snapshot.
 */
async function binBatch(db: Db, entity: BinEntity, ids: string[], actor: BinActor | null) {
  if (!ids.length) return [];
  return db.$transaction(
    async (trx) => {
      const tx = trx as unknown as Db;
      await tx.$queryRaw`SELECT id FROM ${Prisma.raw(LOCK_TABLE[entity])} WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
      const got = await COLLECT[entity](tx, ids);
      const deletedAt = new Date();
      const expiresAt = new Date(deletedAt.getTime() + BIN_DAYS * 86_400_000);
      const entries = got.records.map((record) => {
        const id = record.id as string;
        const rows = got.rows.get(id) ?? {};
        for (const list of Object.values(rows)) {
          for (const r of list) {
            delete r.__ticketId;
            delete r.__threadId;
          }
        }
        const files = got.files.get(id) ?? [];
        const snapshot: Snapshot = {v: 1, record: plain(record), rows: plain(rows), relink: got.relink.get(id) ?? {}, files};
        const counts: Record<string, number> = Object.fromEntries(Object.entries(rows).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
        if (files.length) counts.file = files.length;
        return {entity, recordId: id, ...describe(entity, record), counts, snapshot: snapshot as unknown as Prisma.InputJsonValue, fileIds: files.filter((f) => f.trashed).map((f) => f.id), deletedById: actor?.id ?? null, deletedByName: actor?.name ?? null, deletedAt, expiresAt};
      });
      if (!entries.length) return [];
      const allFiles = [...got.files.values()].flat();
      const trash = allFiles.filter((f) => f.trashed).map((f) => f.id);
      const column = LINK_COLUMN[entity] as (typeof FILE_LINKS)[number] | undefined;
      const unlink = allFiles.filter((f) => !f.trashed).map((f) => f.id);
      const created = await tx.deletedRecord.createManyAndReturn({data: entries, select: {id: true, recordId: true}});
      if (trash.length) await tx.file.updateMany({where: {id: {in: trash}}, data: {purpose: 'trash', contactId: null, companyId: null, dealId: null}});
      if (unlink.length && column) await tx.file.updateMany({where: {id: {in: unlink}}, data: {[column]: null}});
      for (const d of got.alsoDelete) await model(tx, d.table).deleteMany({where: {id: {in: d.ids}}});
      await model(tx, MAIN[entity]).deleteMany({where: {id: {in: got.records.map((r) => r.id)}}});
      return created;
    },
    {maxWait: 5_000, timeout: 30_000},
  );
}

// ─── Restore ───

// `user` targets are team members (ownerId, actorId, …): the `Member` table here, not the site's `users`.
const TARGET_MODEL: Record<Target, string> = {user: 'member', contact: 'contact', company: 'company', deal: 'deal', stage: 'stage', activity: 'activity', ticket: 'ticket', form: 'form', contactList: 'contactList', scoreRule: 'scoreRule', emailAccount: 'emailAccount', emailThread: 'emailThread', emailMessage: 'emailMessage', channelIdentity: 'channelIdentity'};
const TABLE_TARGET: Partial<Record<Table, Target>> = {contact: 'contact', company: 'company', deal: 'deal', ticket: 'ticket', form: 'form', contactList: 'contactList', activity: 'activity', emailThread: 'emailThread', emailMessage: 'emailMessage'};

/** Keeps known columns only (a column dropped since the delete would fail the insert). */
const columnsOf = (table: Table, row: Row) => {
  const cols = TABLES[table].cols as Record<string, string>;
  return Object.fromEntries(Object.entries(row).filter(([k]) => k in cols));
};

export class RestoreConflict extends Error {}

/** Entity-specific fixes before re-inserting: a deal's stage may be gone, a form's link may be taken. */
async function prepare(db: Db, entity: BinEntity, record: Row) {
  if (entity === 'deal') {
    const stage = await db.stage.findUnique({where: {id: String(record.stageId)}, select: {id: true, pipelineId: true}});
    if (!stage) {
      const include = {stages: {orderBy: {position: 'asc' as const}, take: 1}};
      const own = await db.pipeline.findUnique({where: {id: String(record.pipelineId)}, include});
      const pipeline = own?.stages.length ? own : await db.pipeline.findFirst({where: {stages: {some: {}}}, orderBy: [{isDefault: 'desc'}, {position: 'asc'}], include});
      const first = pipeline?.stages[0];
      if (!pipeline || !first) throw new RestoreConflict('Create a pipeline with at least one stage first');
      Object.assign(record, {pipelineId: pipeline.id, stageId: first.id});
      return `Its stage was deleted, so it is back in ${pipeline.name} · ${first.name}.`;
    }
    record.pipelineId = stage.pipelineId;
  }
  if (entity === 'form') {
    // The slug, else slug-2 … slug-50: all checked in one query.
    const candidates = [String(record.slug), ...Array.from({length: 49}, (_, i) => `${record.slug}-${i + 2}`)];
    const taken = new Set((await db.form.findMany({where: {slug: {in: candidates}}, select: {slug: true}, take: 50})).map((f) => f.slug));
    const slug = candidates.find((s) => !taken.has(s)) ?? `${record.slug}-${Date.now().toString(36)}`;
    if (slug !== record.slug) {
      const warning = `Its link /f/${record.slug} is used by another form now, so it moved to /f/${slug}.`;
      record.slug = slug;
      return warning;
    }
  }
  if (entity === 'ticket' && record.emailThreadId) {
    const taken = await db.ticket.findUnique({where: {emailThreadId: String(record.emailThreadId)}, select: {id: true}});
    const thread = await db.emailThread.findUnique({where: {id: String(record.emailThreadId)}, select: {id: true}});
    if (taken || !thread) record.emailThreadId = null;
  }
  // A conversation comes back to the inbox, not to Trash (where the 30-day purge would take it again).
  if (entity === 'conversation') record.trashedAt = null;
  if (entity === 'contact' && record.email) {
    const other = await db.contact.findFirst({where: {email: String(record.email)}, select: {id: true}});
    if (other) return `Another contact now uses ${record.email}; it is in the duplicates queue.`;
  }
  if (entity === 'company' && record.domain) {
    const other = await db.company.findFirst({where: {domain: String(record.domain)}, select: {name: true}});
    if (other) return `${other.name} uses ${record.domain} now; both are in the duplicates queue.`;
  }
  return null;
}

/**
 * Re-creates a binned record and its rows with their original ids in one
 * transaction, then removes the bin entry. Links to records that no longer
 * exist are cleared (or the linking row skipped when the link is required).
 */
export async function restoreFromBin(db: Db, entry: DeletedRecord, actor: BinActor | null) {
  const entity = entry.entity as BinEntity;
  const snap = entry.snapshot as unknown as Snapshot;
  const mainTable = MAIN[entity];
  if ((await model(db, mainTable).findMany({where: {id: entry.recordId}, select: {id: true}})).length) {
    throw new RestoreConflict('This record already exists');
  }
  const record = {...snap.record};
  const warning = await prepare(db, entity, record);

  const tables: [Table, Row[]][] = [[mainTable, [record]], ...(Object.keys(TABLES) as Table[]).filter((t) => t !== mainTable && snap.rows[t]?.length).map((t) => [t, snap.rows[t]!] as [Table, Row[]])];

  // Ids this restore creates itself, then which referenced ids still exist.
  const setOf = (map: Map<Target, Set<string>>, target: Target) => map.get(target) ?? map.set(target, new Set()).get(target)!;
  const creating = new Map<Target, Set<string>>();
  for (const [table, rows] of tables) {
    const target = TABLE_TARGET[table];
    if (target) for (const r of rows) setOf(creating, target).add(r.id as string);
  }
  const wanted = new Map<Target, Set<string>>();
  const want = (target: Target, id: unknown) => {
    if (typeof id === 'string' && !creating.get(target)?.has(id)) setOf(wanted, target).add(id);
  };
  for (const [table, rows] of tables) for (const r of rows) for (const [col, fk] of Object.entries(TABLES[table].fk) as [string, Fk][]) want(fk.replace('!', '') as Target, r[col]);
  for (const f of snap.files) for (const col of FILE_LINKS) if (f[col] !== entry.recordId) want(col.replace('Id', '') as Target, f[col]);
  const exists = new Map<Target, Set<string>>();
  for (const [target, ids] of wanted) {
    const found = await model(db, TARGET_MODEL[target]).findMany({where: {id: {in: [...ids]}}, select: {id: true}});
    exists.set(target, new Set(found.map((r) => r.id as string)));
  }
  const alive = (target: Target, id: unknown) => typeof id === 'string' && (creating.get(target)?.has(id) || exists.get(target)?.has(id));

  const skipped: Record<string, number> = {};
  const inserts = tables.map(([table, rows]) => {
    const kept: Row[] = [];
    for (const r of rows) {
      // Binned before a column got its length (P3-14): cut to it, so the restore never fails on it.
      const row = RESTORE_LIMITS[table] ? clip(columnsOf(table, r), RESTORE_LIMITS[table]) : columnsOf(table, r);
      let ok = true;
      for (const [col, fk] of Object.entries(TABLES[table].fk) as [string, Fk][]) {
        if (row[col] == null || alive(fk.replace('!', '') as Target, row[col])) continue;
        if (fk.endsWith('!')) ok = false;
        else row[col] = null;
      }
      if (ok) kept.push(row);
      else skipped[table] = (skipped[table] ?? 0) + 1;
    }
    return model(db, table).createMany({data: kept, skipDuplicates: table !== mainTable});
  });

  const relinks = Object.entries(snap.relink).map(([key, ids]) => {
    const [table, column] = key.split('.') as [string, string];
    return model(db, table).updateMany({where: {id: {in: ids}, [column]: null}, data: {[column]: entry.recordId}});
  });

  const files = snap.files.map((f) => {
    const data: Row = {purpose: f.purpose};
    for (const col of FILE_LINKS) {
      if (f[col] === entry.recordId) data[col] = f[col];
      else if (f.trashed && f[col] && alive(col.replace('Id', '') as Target, f[col])) data[col] = f[col];
    }
    return db.file.updateMany({where: {id: f.id}, data});
  });

  await db.$transaction([...inserts, ...relinks, ...files, db.deletedRecord.delete({where: {id: entry.id}})]);
  await afterRestore(db, entity, record, actor);
  return {entity, recordId: entry.recordId, label: entry.label, warning, skipped};
}

/** Timeline entry and `<entity>.restored` event for the restored record. */
async function afterRestore(db: Db, entity: BinEntity, record: Row, actor: BinActor | null) {
  const id = record.id as string;
  const title = 'Restored from the recycle bin';
  if (entity === 'contact' || entity === 'company' || entity === 'deal') {
    await logActivity(db, {type: 'restored', title, actorId: actor?.id, contactId: entity === 'contact' ? id : null, companyId: entity === 'company' ? id : null, dealId: entity === 'deal' ? id : null});
    await emit(db, `${entity}.restored`, {recordId: id, actorId: actor?.id, data: record});
  }
  if (entity === 'ticket') {
    await logActivity(db, {type: 'restored', title: `Ticket #${record.number} restored from the recycle bin`, actorId: actor?.id, contactId: record.contactId as string | null, data: {ticketId: id, number: Number(record.number)}});
    await emit(db, 'ticket.restored', {recordId: id, actorId: actor?.id, data: record});
  }
}

// ─── Purge ───

/** Deletes bin entries for good: their parked files, follows and duplicate pairs go too. */
export async function purgeBinEntries(db: Db, all: Pick<DeletedRecord, 'id' | 'entity' | 'recordId' | 'fileIds'>[]) {
  if (!all.length) return 0;
  // Stored bytes first (storage is not part of the transaction), then the rows that pointed at them.
  // An entry whose files storage could not delete stays in the bin (its file rows too), for the next run.
  const fileIds = all.flatMap((e) => strings(e.fileIds));
  const failed = new Set(fileIds.length ? (await purgeFileRows(db, {id: {in: fileIds}, purpose: 'trash'})).failed : []);
  const entries = failed.size ? all.filter((e) => !strings(e.fileIds).some((id) => failed.has(id))) : all;
  if (!entries.length) return 0;
  const recordIds = entries.map((e) => e.recordId);
  const follows = entries.filter((e) => e.entity === 'contact' || e.entity === 'company' || e.entity === 'deal');
  await db.$transaction([
    db.follow.deleteMany({where: {OR: follows.map((e) => ({entity: e.entity.toUpperCase() as 'CONTACT', recordId: e.recordId}))}}),
    db.duplicatePair.deleteMany({where: {OR: [{aId: {in: recordIds}}, {bId: {in: recordIds}}]}}),
    db.deletedRecord.deleteMany({where: {id: {in: entries.map((e) => e.id)}}}),
  ]);
  return entries.length;
}

/** Job runner: empties entries older than BIN_DAYS, a batch at a time. */
export async function purgeExpiredBin(db: Db, until = Date.now() + 20_000) {
  let total = 0;
  let after: string | undefined;
  // Keyset by id: an entry kept back (its files could not be deleted) is not fetched again this run.
  for (let i = 0; i < 10 && Date.now() < until; i++) {
    const batch = await db.deletedRecord.findMany({
      where: {expiresAt: {lt: new Date()}, ...(after ? {id: {gt: after}} : {})},
      select: {id: true, entity: true, recordId: true, fileIds: true},
      orderBy: {id: 'asc'},
      take: 200,
    });
    total += await purgeBinEntries(db, batch);
    if (batch.length < 200) break;
    after = batch[batch.length - 1]!.id;
  }
  return total;
}
