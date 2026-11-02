import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {LIFECYCLE, money} from '@/lib/format';
import {HISTORY_LABELS, humanizeField, type HistoryActor, type HistoryEntity, type HistoryEntry} from '@/lib/history';
import {PRIORITY, SOURCE_LABELS, STATUS} from '@/lib/tickets';
import {getSettings} from './settings';

/**
 * Property history of one record, merged from every place that records a
 * change (see AGENTS.md → "Property history"):
 *
 * - timeline `field_changed` activities (`data.changes`) plus the record events
 *   `*_created`, `merged`, `restored`, `stage_changed`, `deal_won/lost/reopened`;
 * - deal `StageChange` rows;
 * - `AuditLog` rows for the record (`meta.changes` of updates, bulk edits,
 *   imports and merges; stage / status moves; created / merged / restored);
 * - ticket thread events (status, priority, assignee).
 *
 * The same change is often written to several of these (an edit is a timeline
 * entry and an audit entry), so entries for the same property and new value
 * within a few seconds are merged, keeping the old value and the most specific
 * actor ("Automation: …" beats "System"). Values come back formatted for people.
 */

/** Record a source per change by putting `source: {kind, name}` in activity `data` or audit `meta`. */
export type ChangeSource = {kind: HistoryActor['kind']; name: string};

type Change = {field: string; from: unknown; to: unknown};

type Raw = {
  kind: HistoryEntry['kind'];
  field: string | null;
  from: unknown;
  to: unknown;
  /** False when the source only knows the new value (old stage moves, ticket assignment). */
  fromKnown: boolean;
  note: string | null;
  actor: HistoryActor;
  at: Date;
  key: string;
};

/** How specific an actor is: when two sources record the same change, the higher one wins. */
const RANK: Record<HistoryActor['kind'], number> = {automation: 5, form: 5, import: 5, webhook: 5, api: 5, customer: 4, merge: 4, user: 3, system: 1};
const SAME_CHANGE_MS = 15_000;
const SOURCE_LIMIT = 1000;

const ACTIVITY_TYPES: Record<Exclude<HistoryEntity, 'ticket'>, string[]> = {
  contact: ['field_changed', 'contact_created', 'merged', 'restored'],
  company: ['field_changed', 'company_created', 'merged', 'restored'],
  deal: ['field_changed', 'deal_created', 'stage_changed', 'deal_won', 'deal_lost', 'deal_reopened', 'restored'],
};
const AUDIT_VERBS = ['created', 'cloned', 'imported', 'updated', 'bulk_updated', 'merged', 'restored', 'stage_changed', 'status_changed'];

const DEAL_STATUS: Record<string, string> = {OPEN: 'Open', WON: 'Won', LOST: 'Lost'};
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const looksLikeId = (v: unknown) => typeof v === 'string' && /^c[a-z0-9]{20,}$/.test(v);
const changesOf = (v: unknown): Change[] => (Array.isArray(v) ? v.filter((ch): ch is Change => !!ch && typeof ch === 'object' && typeof (ch as Change).field === 'string') : []);
const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const utcDate = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'});
function formatDate(v: unknown) {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : utcDate.format(d);
}

/** Loads the record within the caller's scope; null when it doesn't exist or isn't visible. */
export async function historyRecord(db: Db, entity: HistoryEntity, id: string, scope: {ownerId?: string}, ticketScope: Prisma.TicketWhereInput) {
  if (entity === 'contact') return db.contact.findFirst({where: {id, ...scope}});
  if (entity === 'company') return db.company.findFirst({where: {id, ...scope}});
  if (entity === 'deal') return db.deal.findFirst({where: {id, ...scope}});
  return db.ticket.findFirst({where: {AND: [{id}, ticketScope]}, include: {contact: {select: {firstName: true, lastName: true}}}});
}

type RecordRow = NonNullable<Awaited<ReturnType<typeof historyRecord>>>;

export async function recordHistory(db: Db, entity: HistoryEntity, record: RecordRow) {
  const id = record.id;
  const users = new Map((await db.member.findMany({select: {id: true, name: true, color: true, avatarUrl: true}})).map((u) => [u.id, u]));
  const userActor = (userId: string | null | undefined, fallbackName?: string | null): HistoryActor => {
    const u = userId ? users.get(userId) : undefined;
    if (u) return {kind: 'user', name: u.name, color: u.color, avatarUrl: u.avatarUrl};
    return fallbackName ? {kind: 'user', name: fallbackName} : {kind: 'system', name: 'System'};
  };
  /** An explicit source (automation, form, import…) overrides the person. */
  const actorFor = (bag: Record<string, unknown>, userId: string | null | undefined, userName?: string | null): HistoryActor => {
    const person = userId || userName ? userActor(userId, userName) : null;
    const automation = asObject(bag.automation);
    if (typeof automation.name === 'string') return {kind: 'automation', name: `Automation: ${automation.name}`};
    if (typeof bag.automationId === 'string') return {kind: 'automation', name: `Automation: ${typeof bag.automation === 'string' ? bag.automation : 'unnamed'}`};
    const source = asObject(bag.source);
    if (typeof source.kind === 'string' && typeof source.name === 'string' && source.kind in RANK) {
      const kind = source.kind as HistoryActor['kind'];
      const name = kind === 'form' ? `Form: ${source.name}` : kind === 'webhook' ? `Webhook: ${source.name}` : kind === 'api' ? `API: ${source.name}` : kind === 'automation' ? `Automation: ${source.name}` : source.name;
      return {kind, name, by: person?.kind === 'user' ? person.name : null};
    }
    if (bag.source === 'import') return {kind: 'import', name: 'Import', by: person?.kind === 'user' ? person.name : null};
    return person ?? {kind: 'system', name: 'System'};
  };

  const raws: Raw[] = [];
  const push = (r: Omit<Raw, 'key' | 'fromKnown'> & {fromKnown?: boolean}, key: string) => raws.push({fromKnown: true, ...r, key});

  // ─── Timeline activities ───
  if (entity !== 'ticket') {
    const where: Prisma.ActivityWhereInput =
      entity === 'contact' ? {contactId: id} : entity === 'company' ? {companyId: id, contactId: null, dealId: null} : {dealId: id};
    const rows = await db.activity.findMany({
      where: {...where, type: {in: ACTIVITY_TYPES[entity]}},
      select: {id: true, type: true, title: true, data: true, actorId: true, createdAt: true},
      orderBy: {createdAt: 'desc'},
      take: SOURCE_LIMIT,
    });
    for (const a of rows) {
      const data = asObject(a.data);
      // Moved here by a merge: the other record's own history, not this one's.
      if (data.mergedFrom || data.ticketId) continue;
      const actor = actorFor(data, a.actorId);
      const base = {actor, at: a.createdAt, note: null as string | null};
      if (a.type === 'field_changed') {
        for (const [i, ch] of changesOf(data.changes).entries()) push({...base, kind: 'change', field: ch.field, from: ch.from, to: ch.to}, `a:${a.id}:${i}`);
      } else if (a.type.endsWith('_created')) {
        push({...base, kind: 'created', field: null, from: null, to: null, note: /^(contact|company) created$/i.test(a.title) ? null : a.title.replace(/^Deal created: .*/, '') || null}, `a:${a.id}`);
      } else if (a.type === 'merged' || a.type === 'restored') {
        push({...base, kind: a.type, field: null, from: null, to: null, note: a.title}, `a:${a.id}`);
      } else if (a.type === 'stage_changed') {
        push({...base, kind: 'change', field: 'stageId', from: data.from, to: data.to}, `a:${a.id}`);
      } else {
        const to = a.type === 'deal_won' ? 'WON' : a.type === 'deal_lost' ? 'LOST' : 'OPEN';
        push({...base, kind: 'change', field: 'status', from: null, to, fromKnown: false, note: a.type === 'deal_lost' ? a.title.replace(/^Deal lost:\s*/, 'Reason: ') : null}, `a:${a.id}`);
      }
    }
  }

  // ─── Deal stage history ───
  let initialStage: string | null = null;
  if (entity === 'deal') {
    const moves = await db.stageChange.findMany({
      where: {dealId: id},
      include: {fromStage: {select: {name: true}}, toStage: {select: {name: true}}},
      orderBy: {createdAt: 'asc'},
      take: SOURCE_LIMIT,
    });
    for (const m of moves) {
      // The first row (no "from") is the stage the deal was created in.
      if (!m.fromStageId && m === moves[0]) {
        initialStage = m.toStage?.name ?? null;
        continue;
      }
      push({kind: 'change', field: 'stageId', from: m.fromStage?.name ?? null, to: m.toStage?.name ?? 'Removed stage', fromKnown: !!m.fromStageId, note: null, actor: userActor(m.userId), at: m.createdAt}, `s:${m.id}`);
    }
  }

  // ─── Ticket thread events ───
  if (entity === 'ticket') {
    const events = await db.ticketMessage.findMany({where: {ticketId: id, kind: 'event'}, select: {id: true, data: true, authorId: true, createdAt: true}, orderBy: {createdAt: 'desc'}, take: SOURCE_LIMIT});
    for (const e of events) {
      const d = asObject(e.data);
      const actor = actorFor(d, e.authorId);
      if (d.type === 'status' || d.type === 'priority') push({kind: 'change', field: d.type, from: d.from, to: d.to, note: null, actor, at: e.createdAt}, `t:${e.id}`);
      if (d.type === 'assigned') push({kind: 'change', field: 'assigneeId', from: null, to: d.to ?? null, fromKnown: false, note: null, actor, at: e.createdAt}, `t:${e.id}`);
    }
  }

  // ─── Audit log ───
  const audits = await db.auditLog.findMany({
    where: {entity, recordId: id, action: {in: AUDIT_VERBS.map((v) => `${entity}.${v}`)}},
    select: {id: true, action: true, actorId: true, actorName: true, meta: true, createdAt: true},
    orderBy: {createdAt: 'desc'},
    take: SOURCE_LIMIT,
  });
  for (const row of audits) {
    const meta = asObject(row.meta);
    const verb = row.action.split('.')[1]!;
    let actor = actorFor(meta, row.actorId, row.actorName);
    const base = {at: row.createdAt};
    const changes = changesOf(meta.changes);
    if (verb === 'merged') {
      const dropped = typeof meta.dropped === 'string' ? meta.dropped : null;
      push({...base, actor, kind: 'merged', field: null, from: null, to: null, note: dropped ? `Merged with ${dropped}` : 'Merged with a duplicate'}, `l:${row.id}`);
      actor = {kind: 'merge', name: 'Merge', by: actor.kind === 'user' ? actor.name : null};
    }
    if (verb === 'created' || verb === 'cloned' || verb === 'imported') {
      push({...base, actor: verb === 'imported' && actor.kind === 'user' ? {kind: 'import', name: 'Import', by: actor.name} : actor, kind: 'created', field: null, from: null, to: null, note: verb === 'cloned' ? 'Cloned' : verb === 'imported' ? 'Imported' : null}, `l:${row.id}`);
    }
    if (verb === 'restored') push({...base, actor, kind: 'restored', field: null, from: null, to: null, note: 'Restored from the recycle bin'}, `l:${row.id}`);
    if (verb === 'stage_changed') push({...base, actor, kind: 'change', field: 'stageId', from: meta.from, to: meta.to, note: null}, `l:${row.id}`);
    if (verb === 'status_changed') push({...base, actor, kind: 'change', field: 'status', from: meta.from, to: meta.to, note: typeof meta.lostReason === 'string' ? `Reason: ${meta.lostReason}` : null}, `l:${row.id}`);
    const note = verb === 'bulk_updated' ? 'Bulk edit' : typeof meta.reason === 'string' ? meta.reason : null;
    for (const [i, ch] of changes.entries()) push({...base, actor, kind: 'change', field: ch.field, from: ch.from, to: ch.to, note}, `l:${row.id}:${i}`);
    // Bulk edits written before they recorded a diff: only the new value is known.
    if (verb === 'bulk_updated' && !changes.length && typeof meta.action === 'string') {
      const field = meta.action === 'assign' ? 'ownerId' : meta.action === 'stage' ? 'lifecycleStage' : null;
      if (field) push({...base, actor, kind: 'change', field, from: null, to: meta.value || null, fromKnown: false, note}, `l:${row.id}`);
    }
  }

  // ─── Formatting ───
  const defs = entity === 'ticket' ? [] : await db.customFieldDef.findMany({where: {entity: entity.toUpperCase() as 'CONTACT' | 'COMPANY' | 'DEAL'}});
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  const settings = await getSettings(db);
  const currency = entity === 'deal' ? (record as {currency: string}).currency : settings.currency;
  const recordValues = record as unknown as Record<string, unknown>;

  const idsOf = (fields: string[]) => [...new Set(raws.flatMap((r) => (r.field && fields.includes(r.field) ? [r.from, r.to] : [])).concat(fields.map((f) => recordValues[f])).filter(looksLikeId) as string[])];
  const [stages, pipelines, contacts, companies, deals] = await Promise.all([
    entity === 'deal' ? db.stage.findMany({where: {id: {in: idsOf(['stageId'])}}, select: {id: true, name: true}}) : [],
    entity === 'deal' ? db.pipeline.findMany({where: {id: {in: idsOf(['pipelineId'])}}, select: {id: true, name: true}}) : [],
    db.contact.findMany({where: {id: {in: idsOf(['contactId'])}}, select: {id: true, firstName: true, lastName: true}}),
    db.company.findMany({where: {id: {in: idsOf(['companyId'])}}, select: {id: true, name: true}}),
    db.deal.findMany({where: {id: {in: idsOf(['dealId'])}}, select: {id: true, title: true}}),
  ]);
  const names = new Map<string, string>([
    ...stages.map((s) => [s.id, s.name] as const),
    ...pipelines.map((p) => [p.id, p.name] as const),
    ...contacts.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(' ')] as const),
    ...companies.map((p) => [p.id, p.name] as const),
    ...deals.map((p) => [p.id, p.title] as const),
  ]);

  const labelOf = (field: string) => {
    if (field.startsWith('custom.')) return defByKey.get(field.slice(7))?.label ?? humanizeField(field);
    return HISTORY_LABELS[entity][field] ?? humanizeField(field);
  };
  const format = (field: string, v: unknown): string | null => {
    if (isEmpty(v)) return null;
    if (field.startsWith('custom.')) {
      const def = defByKey.get(field.slice(7));
      switch (def?.type) {
        case 'CURRENCY':
          return Number.isFinite(Number(v)) ? money(Number(v), currency) : String(v);
        case 'NUMBER':
          return Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v);
        case 'DATE':
          return formatDate(v);
        case 'CHECKBOX':
          return v === true || v === 'true' ? 'Yes' : 'No';
      }
      return Array.isArray(v) ? v.map(String).join(', ') : String(v);
    }
    if (field === 'ownerId' || field === 'assigneeId') return typeof v === 'string' ? (users.get(v)?.name ?? (looksLikeId(v) ? 'Removed user' : v)) : String(v);
    if (field === 'stageId' || field === 'pipelineId' || field === 'contactId' || field === 'companyId' || field === 'dealId') {
      return typeof v === 'string' ? (names.get(v) ?? (looksLikeId(v) ? 'Deleted record' : v)) : String(v);
    }
    if (field === 'lifecycleStage') return LIFECYCLE[v as keyof typeof LIFECYCLE]?.label ?? String(v);
    if (field === 'status') return (entity === 'ticket' ? STATUS[v as keyof typeof STATUS]?.label : DEAL_STATUS[String(v)]) ?? String(v);
    if (entity === 'ticket' && field === 'priority') return PRIORITY[v as keyof typeof PRIORITY]?.label ?? String(v);
    if (field === 'expectedCloseDate') return formatDate(v);
    if (field === 'value' || field === 'annualRevenue') return Number.isFinite(Number(v)) ? money(Number(v), currency) : String(v);
    if (field === 'employees') return Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  };

  // ─── Merge duplicates (oldest first, so the first writer keeps its place) ───
  raws.sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: (HistoryEntry & {fromKnown: boolean; t: number})[] = [];
  let created: (typeof out)[number] | null = null;
  for (const r of raws) {
    const entry = {
      id: r.key,
      kind: r.kind,
      field: r.field,
      label: r.field ? labelOf(r.field) : r.kind === 'created' ? 'Created' : r.kind === 'merged' ? 'Merged' : 'Restored',
      from: r.field && r.fromKnown ? format(r.field, r.from) : null,
      to: r.field ? format(r.field, r.to) : null,
      note: r.note,
      actor: r.actor,
      at: r.at.toISOString(),
      fromKnown: r.fromKnown,
      t: r.at.getTime(),
    };
    if (r.kind === 'change' && entry.from === entry.to && entry.fromKnown) continue;
    const same =
      r.kind === 'created'
        ? created
        : out.find((o) =>
            o.kind === r.kind &&
            o.field === entry.field &&
            o.to === entry.to &&
            Math.abs(o.t - entry.t) <= (r.kind === 'change' ? SAME_CHANGE_MS : 60_000) &&
            (o.from === entry.from || !o.fromKnown || !entry.fromKnown),
          );
    if (!same) {
      out.push(entry);
      if (r.kind === 'created') created = entry;
      continue;
    }
    if (!same.fromKnown && entry.fromKnown) Object.assign(same, {from: entry.from, fromKnown: true});
    if (RANK[entry.actor.kind] > RANK[same.actor.kind]) same.actor = entry.actor;
    same.note ??= entry.note;
  }

  // Every record was created at some point, even when nothing logged it (demo data, old rows).
  const ticket = entity === 'ticket' ? (record as unknown as {source: keyof typeof SOURCE_LABELS; contact: {firstName: string; lastName: string | null} | null}) : null;
  if (!created) {
    const requester = ticket?.contact ? [ticket.contact.firstName, ticket.contact.lastName].filter(Boolean).join(' ') : null;
    const createdAt = (record as {createdAt: Date}).createdAt;
    created = {
      id: 'created',
      kind: 'created',
      field: null,
      label: 'Created',
      from: null,
      to: null,
      note: null,
      actor: ticket && ticket.source !== 'MANUAL' && requester ? {kind: 'customer', name: requester} : {kind: 'system', name: 'System'},
      at: createdAt.toISOString(),
      fromKnown: true,
      t: createdAt.getTime(),
    };
    out.push(created);
  }
  if (ticket && !created.note) created.note = `Opened via ${SOURCE_LABELS[ticket.source] ?? ticket.source}`;
  if (entity === 'contact' && !created.note && typeof recordValues.source === 'string') created.note = `Source: ${recordValues.source}`;

  /** The value a property had when the record was created: the oldest change's old value, else today's. */
  const initialValue = (field: string) => {
    if (field === 'stageId' && initialStage) return initialStage;
    const first = out.find((e) => e.kind === 'change' && e.field === field);
    if (first) return first.fromKnown ? first.from : null;
    return format(field, field.startsWith('custom.') ? asObject(recordValues.custom)[field.slice(7)] : recordValues[field]);
  };

  const entries: HistoryEntry[] = [...out].sort((a, b) => b.t - a.t).map(({fromKnown: _f, t: _t, ...e}) => e);
  return {entries, initialValue, labelOf};
}
