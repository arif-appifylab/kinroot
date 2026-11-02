/**
 * Lists & segments on the server: dynamic segment rules → Prisma `where`, and
 * the helpers other modules use to read or change list membership.
 *
 *   segmentWhere(db, rules)              rules → Prisma.ContactWhereInput
 *   listContactWhere(db, listId)         members of any list (static or dynamic)
 *   isContactInList(db, listId, id)      one contact, any list
 *   addToList / removeFromList           static lists; emit list.member_* events
 *
 * Callers add `ownerScope(c)` themselves (these helpers know nothing about the
 * signed-in user), e.g. `{AND: [await listContactWhere(db, id)], ...scope}`.
 */
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {Prisma, type ContactList, type CustomFieldDef} from '../../../generated/prisma/client';
import {asRules, customSegmentFields, referencedLists, ruleComplete, SEGMENT_FIELDS, type SegmentField, type SegmentRule, type SegmentRules} from '@/lib/segments';
import type {Db} from '../kit/db';
import {automationStamp} from './automation-context';
import {emitMany} from './events';

type Where = Prisma.ContactWhereInput;

/** Matches no contact. */
export const NOBODY: Where = {id: {in: []}};

const MAX_DEPTH = 5;
const DAY = 86400_000;

// ─── Validation ─────────────────────────────────────────────────────────────

const ruleSchema = z.object({
  field: z.string().min(1).max(120),
  op: z.string().min(1).max(20),
  value: z.string().max(500).optional(),
  values: z.array(z.string().max(200)).max(100).optional(),
  days: z.number().int().min(0).max(36500).optional(),
  stageId: z.string().max(60).optional(),
});

export const segmentRulesSchema = z.object({
  match: z.enum(['all', 'any']),
  groups: z.array(z.object({match: z.enum(['all', 'any']), rules: z.array(ruleSchema).max(50)})).max(20),
}) as unknown as z.ZodType<SegmentRules>;

// ─── Translator ─────────────────────────────────────────────────────────────

export type CustomDefs = Pick<CustomFieldDef, 'key' | 'label' | 'type' | 'options'>[];

/** Contact custom field definitions; load once and pass as `defs` when evaluating many segments. */
export const loadSegmentDefs = (db: Db): Promise<CustomDefs> => db.customFieldDef.findMany({where: {entity: 'CONTACT'}, select: {key: true, label: true, type: true, options: true}});

export type SegmentOpts = {seen?: Set<string>; depth?: number; defs?: CustomDefs};

type Ctx = {db: Db; defs: CustomDefs; fields: Map<string, SegmentField>; customTypes: Map<string, string>; seen: Set<string>; depth: number; now: number};

async function context(db: Db, opts: SegmentOpts): Promise<Ctx> {
  const defs = opts.defs ?? (await loadSegmentDefs(db));
  const fields = new Map([...SEGMENT_FIELDS, ...customSegmentFields(defs)].map((f) => [f.key, f]));
  return {db, defs, fields, customTypes: new Map(defs.map((d) => [d.key, d.type])), seen: opts.seen ?? new Set(), depth: opts.depth ?? 0, now: Date.now()};
}

/**
 * Translates segment rules into a Prisma where for Contact. Rules on unknown
 * fields (e.g. a deleted custom field) match nobody, so a segment never widens
 * by accident. A segment without one complete rule matches nobody.
 */
export async function segmentWhere(db: Db, rules: SegmentRules | unknown, opts: SegmentOpts = {}): Promise<Where> {
  const ctx = await context(db, opts);
  return translate(ctx, asRules(rules));
}

async function translate(ctx: Ctx, rules: SegmentRules): Promise<Where> {
  const groups: Where[] = [];
  for (const group of rules.groups) {
    const parts: Where[] = [];
    for (const rule of group.rules) {
      const field = ctx.fields.get(rule.field);
      if (!field && rule.field.startsWith('custom.')) {
        parts.push(NOBODY); // custom field was deleted
        continue;
      }
      if (!ruleComplete(rule, field)) continue;
      parts.push(await ruleWhere(ctx, rule, field!));
    }
    if (parts.length) groups.push(group.match === 'any' ? {OR: parts} : {AND: parts});
  }
  if (!groups.length) return NOBODY;
  return rules.match === 'any' ? {OR: groups} : {AND: groups};
}

const ci = 'insensitive' as const;
const since = (ctx: Ctx, days: number) => new Date(ctx.now - days * DAY);
/** Start of the given UTC day; `after` means from the next day on. */
const dayStart = (ymd: string, plus = 0) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) + plus * DAY);

/** Positive condition on a nullable or required scalar text column. */
function textCond(op: SegmentRule['op'], v: string, required: boolean, col: string): Record<string, unknown> {
  const isNull = required ? [] : [{[col]: null}];
  switch (op) {
    case 'is':
      return {[col]: {equals: v, mode: ci}};
    case 'is_not':
      return {OR: [...isNull, {NOT: {[col]: {equals: v, mode: ci}}}]};
    case 'contains':
      return {[col]: {contains: v, mode: ci}};
    case 'not_contains':
      return {OR: [...isNull, {NOT: {[col]: {contains: v, mode: ci}}}]};
    case 'starts_with':
      return {[col]: {startsWith: v, mode: ci}};
    case 'empty':
      return {OR: [...isNull, {[col]: ''}]};
    case 'not_empty':
      return {AND: [{[col]: {not: null}}, {[col]: {not: ''}}]};
    default:
      return {};
  }
}

function numberCond(op: SegmentRule['op'], n: number, col: string): Record<string, unknown> {
  if (op === 'eq') return {[col]: n};
  if (op === 'gt') return {[col]: {gt: n}};
  if (op === 'lt') return {[col]: {lt: n}};
  if (op === 'empty') return {[col]: null};
  return {[col]: {not: null}};
}

function dateCond(ctx: Ctx, rule: SegmentRule, col: string, nullable: boolean): Where {
  switch (rule.op) {
    case 'in_last':
      return {[col]: {gte: since(ctx, rule.days!)}};
    case 'more_than':
      return {[col]: {lt: since(ctx, rule.days!)}};
    case 'before':
      return {[col]: {lt: dayStart(rule.value!)}};
    case 'after':
      return {[col]: {gte: dayStart(rule.value!, 1)}};
    case 'empty':
      return nullable ? {[col]: null} : NOBODY;
    default:
      return nullable ? {[col]: {not: null}} : {};
  }
}

/** Rules whose op is the negation of another: "none of" = NOT("any of"). */
const NEGATION: Partial<Record<SegmentRule['op'], SegmentRule['op']>> = {
  is_not: 'is',
  not_contains: 'contains',
  is_none: 'is_any',
  has_none: 'has_any',
  is_false: 'is_true',
  empty: 'not_empty',
  not_in_last: 'in_last',
  never: 'ever',
  not_in: 'in',
  has_not: 'has',
};

async function ruleWhere(ctx: Ctx, rule: SegmentRule, field: SegmentField): Promise<Where> {
  const key = field.key;
  const v = rule.value?.trim() ?? '';

  // ── Custom fields (JSON) ──
  if (key.startsWith('custom.')) return customWhere(ctx, rule, key.slice(7));

  // ── Company properties: some linked company matches; negations = none does ──
  if (key.startsWith('company.')) {
    const col = key.slice(8);
    const neg = NEGATION[rule.op];
    // "is not X" means no linked company is X (people without a company included).
    if (neg) return {companies: {none: {company: companyCond(neg, v, col, field)}}};
    return {companies: {some: {company: companyCond(rule.op, v, col, field)}}};
  }

  // ── Deals ──
  if (key === 'deal.open' || key === 'deal.won') {
    const cond = {deals: {some: {deal: {status: key === 'deal.open' ? ('OPEN' as const) : ('WON' as const)}}}};
    return rule.op === 'is_true' ? cond : {NOT: cond};
  }
  if (key === 'deal.pipeline') {
    const deal = {pipelineId: v, ...(rule.stageId ? {stageId: rule.stageId} : {})};
    return rule.op === 'has' ? {deals: {some: {deal}}} : {deals: {none: {deal}}};
  }
  if (key === 'deal.wonValue') return wonValueWhere(ctx, rule.op, Number(v));

  // ── Activity ──
  if (field.kind === 'activity') {
    const positive = rule.op === 'in_last' || rule.op === 'ever';
    const from = rule.op === 'in_last' || rule.op === 'not_in_last' ? since(ctx, rule.days!) : null;
    return activityWhere(ctx, key, v, from, positive);
  }

  // ── List membership ──
  if (key === 'list') {
    const inner = await listContactWhere(ctx.db, v, {seen: ctx.seen, depth: ctx.depth + 1, defs: ctx.defs});
    return rule.op === 'in' ? inner : {NOT: inner};
  }

  // ── Contact properties ──
  switch (field.kind) {
    case 'text':
      return textCond(rule.op, v, !!field.required, key) as Where;
    case 'choice': {
      const values = rule.values ?? [];
      if (key === 'lifecycleStage') {
        const stages = values as Prisma.EnumLifecycleStageFilter['in'];
        return rule.op === 'is_any' ? {lifecycleStage: {in: stages}} : {lifecycleStage: {notIn: stages}};
      }
      if (rule.op === 'is_any') return {[key]: {in: values}};
      if (rule.op === 'is_none') return {OR: [{[key]: null}, {[key]: {notIn: values}}]};
      return rule.op === 'empty' ? {[key]: null} : {[key]: {not: null}};
    }
    case 'tags': {
      const values = rule.values ?? [];
      if (rule.op === 'has_any') return {tags: {hasSome: values}};
      if (rule.op === 'has_all') return {tags: {hasEvery: values}};
      if (rule.op === 'has_none') return {NOT: {tags: {hasSome: values}}};
      return {tags: {isEmpty: rule.op === 'empty'}};
    }
    case 'bool':
      return {[key]: rule.op === 'is_true'};
    case 'date':
      return dateCond(ctx, rule, key, !field.required);
    case 'number':
      return numberCond(rule.op, Number(v), key) as Where; // lead score
    default:
      return NOBODY;
  }
}

function companyCond(op: SegmentRule['op'], v: string, col: string, field: SegmentField): Prisma.CompanyWhereInput {
  if (field.kind === 'number') return numberCond(op, Number(v), col) as Prisma.CompanyWhereInput;
  return textCond(op, v, !!field.required, col) as Prisma.CompanyWhereInput;
}

function activityWhere(ctx: Ctx, key: string, formId: string, from: Date | null, positive: boolean): Where {
  const quant = positive ? 'some' : 'none';
  const at = from ? {gte: from} : undefined;
  switch (key) {
    case 'activity.form':
      return {formSubmissions: {[quant]: {...(formId ? {formId} : {}), ...(at ? {createdAt: at} : {})}}};
    case 'activity.emailOpened':
      return {emailMessages: {[quant]: {direction: 'OUTBOUND', events: {some: {type: 'open', ...(at ? {createdAt: at} : {})}}}}};
    case 'activity.emailReplied':
      return {emailMessages: {[quant]: {direction: 'INBOUND', ...(at ? {sentAt: at} : {})}}};
    case 'activity.meeting':
    case 'activity.call':
      // Scheduled (future) meetings don't count as "had a meeting" yet.
      return {interactions: {[quant]: {kind: key === 'activity.call' ? 'CALL' : 'MEETING', occurredAt: {lte: new Date(ctx.now), ...(at ?? {})}}}};
    default:
      return NOBODY;
  }
}

/** Total value of won deals per contact needs an aggregate, so it resolves to ids first. */
async function wonValueWhere(ctx: Ctx, op: SegmentRule['op'], n: number): Promise<Where> {
  const totals = (cmp: Prisma.Sql) =>
    ctx.db.$queryRaw<{id: string}[]>`
      SELECT dc."contactId" AS id FROM "DealContact" dc JOIN "Deal" d ON d.id = dc."dealId"
      WHERE d.status = 'WON' GROUP BY dc."contactId" HAVING ${cmp}`.then((rows) => rows.map((r) => r.id));
  const sum = Prisma.sql`COALESCE(SUM(d.value), 0)`;
  // People without won deals have a total of 0.
  if (op === 'gt') return n < 0 ? {} : {id: {in: await totals(Prisma.sql`${sum} > ${n}`)}};
  if (op === 'lt') return n <= 0 ? NOBODY : {id: {notIn: await totals(Prisma.sql`${sum} >= ${n}`)}};
  if (op === 'eq') return n === 0 ? {id: {notIn: await totals(Prisma.sql`${sum} <> 0`)}} : {id: {in: await totals(Prisma.sql`${sum} = ${n}`)}};
  return NOBODY;
}

/** Custom field values live in Contact.custom (JSON); an unset value has no key. */
function customWhere(ctx: Ctx, rule: SegmentRule, key: string): Where | Promise<Where> {
  const type = ctx.customTypes.get(key);
  const path = [key];
  const j = (filter: Omit<Prisma.JsonFilter<'Contact'>, 'path'>): Where => ({custom: {path, ...filter}});
  const unset: Where = {OR: [j({equals: Prisma.AnyNull}), j({equals: ''}), j({equals: []})]};
  const set: Where = {NOT: unset};
  const not = (w: Where): Where => ({OR: [unset, {NOT: w}]});
  const v = rule.value?.trim() ?? '';
  const values = rule.values ?? [];

  if (rule.op === 'empty') return unset;
  if (rule.op === 'not_empty') return set;

  switch (type) {
    case 'NUMBER':
    case 'CURRENCY': {
      const n = Number(v);
      if (rule.op === 'eq') return j({equals: n});
      return rule.op === 'gt' ? j({gt: n}) : j({lt: n});
    }
    case 'DATE': {
      // Stored as YYYY-MM-DD strings, which compare correctly as JSON strings.
      const ymd = (d: Date) => d.toISOString().slice(0, 10);
      if (rule.op === 'in_last') return {AND: [j({gte: ymd(since(ctx, rule.days!))}), j({lte: ymd(new Date(ctx.now))})]};
      if (rule.op === 'more_than') return {AND: [set, j({lt: ymd(since(ctx, rule.days!))})]};
      if (rule.op === 'before') return {AND: [set, j({lt: v})]};
      return j({gt: v}); // after
    }
    case 'CHECKBOX':
      return rule.op === 'is_true' ? j({equals: true}) : not(j({equals: true}));
    case 'SELECT': {
      const any: Where = {OR: values.map((x) => j({equals: x}))};
      return rule.op === 'is_any' ? any : not(any);
    }
    case 'MULTISELECT': {
      if (rule.op === 'has_all') return j({array_contains: values});
      const any: Where = {OR: values.map((x) => j({array_contains: [x]}))};
      return rule.op === 'has_any' ? any : not(any);
    }
    default: {
      // TEXT, URL
      if (rule.op === 'is') return textEquals(ctx, key, v).then((ids) => ({id: {in: ids}}));
      if (rule.op === 'is_not') return textEquals(ctx, key, v).then((ids) => ({id: {notIn: ids}}));
      if (rule.op === 'contains') return j({string_contains: v, mode: ci});
      if (rule.op === 'not_contains') return not(j({string_contains: v, mode: ci}));
      return j({string_starts_with: v, mode: ci});
    }
  }
}

/** Case-insensitive exact match on a JSON string has no Prisma filter, so it resolves to ids. */
async function textEquals(ctx: Ctx, key: string, v: string) {
  const rows = await ctx.db.$queryRaw<{id: string}[]>`SELECT id FROM "Contact" WHERE lower("custom"->>${key}) = lower(${v})`;
  return rows.map((r) => r.id);
}

// ─── Lists ──────────────────────────────────────────────────────────────────

/**
 * Where for the members of a list: static lists by membership, dynamic ones by
 * their rules. A missing list (or a segment that includes itself) matches nobody.
 */
export async function listContactWhere(db: Db, list: string | Pick<ContactList, 'id' | 'kind' | 'rules'>, opts: SegmentOpts = {}): Promise<Where> {
  const row = typeof list === 'string' ? await db.contactList.findUnique({where: {id: list}, select: {id: true, kind: true, rules: true}}) : list;
  if (!row) return NOBODY;
  if (row.kind === 'STATIC') return {listMemberships: {some: {listId: row.id}}};
  const seen = opts.seen ?? new Set<string>();
  const depth = opts.depth ?? 0;
  if (seen.has(row.id) || depth > MAX_DEPTH) return NOBODY;
  return segmentWhere(db, row.rules, {seen: new Set([...seen, row.id]), depth, defs: opts.defs});
}

export async function isContactInList(db: Db, listId: string, contactId: string) {
  const where = await listContactWhere(db, listId);
  return (await db.contact.count({where: {AND: [{id: contactId}, where]}})) > 0;
}

/** Throws when saving `rules` on `listId` would make a segment include itself. */
export async function assertNoCycle(db: Db, listId: string | null, rules: SegmentRules) {
  const visit = async (ids: string[], path: string[]): Promise<void> => {
    for (const id of ids) {
      if (id === listId || path.includes(id)) throw new HTTPException(400, {message: "A segment can't include itself, directly or through another segment"});
      if (path.length > MAX_DEPTH) throw new HTTPException(400, {message: 'Segments are nested too deeply'});
      const row = await db.contactList.findUnique({where: {id}, select: {kind: true, rules: true}});
      if (row?.kind === 'DYNAMIC') await visit(referencedLists(asRules(row.rules)), [...path, id]);
    }
  };
  await visit(referencedLists(rules), []);
}

type MemberChange = {actorId?: string | null; source?: string};

/**
 * Adds contacts to a static list (already-members are skipped). Logs a
 * timeline entry and emits `list.member_added` per new member. Returns the
 * number added. Callers pass only contact ids the user may see.
 */
export async function addToList(db: Db, listId: string, contactIds: string[], opts: MemberChange = {}) {
  const list = await db.contactList.findUnique({where: {id: listId}, select: {id: true, name: true, kind: true}});
  if (!list || list.kind !== 'STATIC' || !contactIds.length) return 0;
  const existing = await db.contactListMember.findMany({where: {listId, contactId: {in: contactIds}}, select: {contactId: true}});
  const have = new Set(existing.map((m) => m.contactId));
  const fresh = [...new Set(contactIds)].filter((id) => !have.has(id));
  if (!fresh.length) return 0;
  const {count} = await db.contactListMember.createMany({
    data: fresh.map((contactId) => ({listId, contactId, source: opts.source ?? 'manual', addedById: opts.actorId ?? null})),
    skipDuplicates: true,
  });
  await afterChange(db, list, fresh, 'added', opts);
  return count;
}

/** Removes contacts from a static list; emits `list.member_removed` per removed member. */
export async function removeFromList(db: Db, listId: string, contactIds: string[], opts: MemberChange = {}) {
  const list = await db.contactList.findUnique({where: {id: listId}, select: {id: true, name: true, kind: true}});
  if (!list || list.kind !== 'STATIC' || !contactIds.length) return 0;
  const members = await db.contactListMember.findMany({where: {listId, contactId: {in: contactIds}}, select: {contactId: true}});
  if (!members.length) return 0;
  const ids = members.map((m) => m.contactId);
  const {count} = await db.contactListMember.deleteMany({where: {listId, contactId: {in: ids}}});
  await afterChange(db, list, ids, 'removed', opts);
  return count;
}

async function afterChange(db: Db, list: {id: string; name: string}, contactIds: string[], change: 'added' | 'removed', opts: MemberChange) {
  await db.contactList.update({where: {id: list.id}, data: {updatedAt: new Date()}});
  // Timeline entries without bumping lastActivityAt: being filed into a list isn't contact with the person.
  await db.activity.createMany({
    data: contactIds.map((contactId) => ({
      type: change === 'added' ? 'list_added' : 'list_removed',
      title: change === 'added' ? `Added to list ${list.name}` : `Removed from list ${list.name}`,
      actorId: opts.actorId ?? null,
      contactId,
      refId: list.id,
      data: {listId: list.id, listName: list.name, source: opts.source ?? 'manual', ...automationStamp(db)},
    })),
  });
  await emitMany(
    db,
    change === 'added' ? 'list.member_added' : 'list.member_removed',
    contactIds.map((contactId) => ({entity: 'list', recordId: list.id, actorId: opts.actorId, data: {list: {id: list.id, name: list.name}, contactId, source: opts.source ?? 'manual'}})),
  );
}
