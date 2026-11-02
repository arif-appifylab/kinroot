/**
 * Lead scoring on the server.
 *
 *   scoreEvents(db, eventIds)       job: behaviour points for domain events, then rescore
 *   rescoreContacts(db, ids)        property rules → awards, totals, band crossings
 *   startRecalc(db) / recalcJob     "Recalculate all" (a chain of small jobs)
 *   scoringTick(db)                 periodic pass from /jobs/run (decay, time-based rules)
 *
 * A contact's score is the sum of its ScoreEvent points from enabled rules:
 * property awards count fully while they are active, behaviour awards age with
 * the decay setting. `Contact.score` stores that sum; crossing a band emits
 * `contact.score_changed`, writes a timeline entry and notifies the owner.
 * Lifecycle stages are never changed here (automations listen to the event).
 */
import {HTTPException} from 'hono/http-exception';

import {Prisma, type Event, type ScoreRule} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {
  bandFor,
  defaultScoringSettings,
  pathValue,
  scoreEventDef,
  type ScoreBand,
  type ScoreBreakdown,
  type ScoreDecay,
  type ScoreFilter,
  type ScoreHistoryItem,
  type ScoreTestResult,
  type ScoringSettings,
  type ScoringStatus,
} from '@/lib/scoring';
import {asRules, customSegmentFields, referencedLists, ruleComplete, SEGMENT_FIELDS, type SegmentRules} from '@/lib/segments';
import {emitMany} from './events';
import {enqueue, kickJobs} from './jobs';
import {notify, recordLink} from './notify';
import {loadSegmentDefs, segmentWhere, type CustomDefs} from './segments';

const DAY = 86_400_000;
const KEY = 'scoring';
const RECALC_KEY = 'scoring.recalc';
const CURSOR_KEY = 'scoring.cursor';
/** Contacts per recompute batch. */
const BATCH = 200;
/** A periodic pass starts again at most this often once it has gone through every contact. */
const PASS_GAP_MS = 60 * 60_000;
/** More band changes than this for one owner in one batch become a single summary notification. */
const SUMMARY_AFTER = 3;

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getScoringSettings(db: Db): Promise<ScoringSettings> {
  const row = await db.setting.findUnique({where: {key: KEY}});
  const stored = (row?.value ?? {}) as Partial<ScoringSettings>;
  const d = defaultScoringSettings();
  return {bands: stored.bands?.length ? stored.bands : d.bands, decay: {...d.decay, ...stored.decay}, notify: stored.notify ?? d.notify};
}

/** Sorts bands by minimum and checks them; the lowest band has no minimum. */
export function normaliseBands(bands: ScoreBand[]): ScoreBand[] {
  const sorted = [...bands].sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
  const out = sorted.map((b, i) => ({...b, min: i === 0 ? null : b.min}));
  if (new Set(out.map((b) => b.key)).size !== out.length) throw new HTTPException(400, {message: 'Each band needs its own name'});
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.min === null) throw new HTTPException(400, {message: `Give “${out[i]!.name}” a minimum score`});
    if (i > 1 && out[i]!.min! <= out[i - 1]!.min!) throw new HTTPException(400, {message: 'Band minimums must all be different'});
  }
  return out;
}

export async function saveScoringSettings(db: Db, next: ScoringSettings) {
  const value = {...next, bands: normaliseBands(next.bands)};
  const json = value as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value: json}, update: {value: json}});
  return value;
}

async function readSetting<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.setting.findUnique({where: {key}});
  return (row?.value as T | undefined) ?? null;
}

async function writeSetting(db: Db, key: string, value: unknown) {
  const json = value as Prisma.InputJsonValue;
  await db.setting.upsert({where: {key}, create: {key, value: json}, update: {value: json}});
}

// ─── Rule validation ────────────────────────────────────────────────────────

/**
 * Property rules can't depend on the score itself (directly, or through a
 * segment that does): a rule like "score > 50 → +10" would feed on itself.
 */
export async function assertPropertyRules(db: Db, rules: SegmentRules) {
  const defs = await loadSegmentDefs(db);
  const fields = new Map([...SEGMENT_FIELDS, ...customSegmentFields(defs)].map((f) => [f.key, f]));
  const all = rules.groups.flatMap((g) => g.rules);
  if (!all.some((r) => ruleComplete(r, fields.get(r.field)))) throw new HTTPException(400, {message: 'Add at least one complete condition'});
  const usesScore = async (r: SegmentRules, seen: Set<string>): Promise<boolean> => {
    if (r.groups.some((g) => g.rules.some((x) => x.field === 'score'))) return true;
    for (const id of referencedLists(r)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const list = await db.contactList.findUnique({where: {id}, select: {kind: true, rules: true}});
      if (list?.kind === 'DYNAMIC' && (await usesScore(asRules(list.rules), seen))) return true;
    }
    return false;
  };
  if (await usesScore(rules, new Set())) throw new HTTPException(400, {message: "A scoring rule can't use the lead score itself (or a segment based on it)"});
}

// ─── Behaviour: events → awards ─────────────────────────────────────────────

type EventRow = Pick<Event, 'id' | 'type' | 'recordId' | 'data' | 'createdAt'>;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

async function dealContacts(db: Db, dealId: string | null) {
  if (!dealId) return [];
  const rows = await db.dealContact.findMany({where: {dealId}, select: {contactId: true}});
  return rows.map((r) => r.contactId);
}

async function companyContacts(db: Db, companyId: string | null) {
  if (!companyId) return [];
  // Very large companies are left to the periodic pass.
  const rows = await db.contactCompany.findMany({where: {companyId}, select: {contactId: true}, take: 500});
  return rows.map((r) => r.contactId);
}

/**
 * Contacts an event is about. Default: `data.contactId`. Modules whose events
 * point at contacts differently add a resolver here (see AGENTS.md).
 */
const RESOLVERS: Record<string, (db: Db, e: EventRow) => Promise<(string | null)[]> | (string | null)[]> = {
  'contact.created': (_db, e) => [e.recordId],
  'contact.updated': (_db, e) => [e.recordId],
  'contact.merged': (_db, e) => [str(pathValue(e.data, 'keptId')) ?? e.recordId],
  'company.updated': (db, e) => companyContacts(db, e.recordId),
  'company.merged': (db, e) => companyContacts(db, e.recordId),
  'deal.created': (db, e) => dealContacts(db, e.recordId),
  'deal.updated': (db, e) => dealContacts(db, e.recordId),
  'deal.stage_changed': (db, e) => dealContacts(db, e.recordId),
  'deal.won': (db, e) => dealContacts(db, e.recordId),
  'deal.lost': (db, e) => dealContacts(db, e.recordId),
  'interaction.logged': (_db, e) => {
    const ids = pathValue(e.data, 'attendeeIds');
    return [str(pathValue(e.data, 'contactId')), ...(Array.isArray(ids) ? ids.map(str) : [])];
  },
};

async function contactsFor(db: Db, e: EventRow) {
  const raw = await (RESOLVERS[e.type]?.(db, e) ?? [str(pathValue(e.data, 'contactId'))]);
  const ids = [...new Set(raw.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = await db.contact.findMany({where: {id: {in: ids}}, select: {id: true}});
  return rows.map((r) => r.id);
}

function filterMatches(rule: Pick<ScoreRule, 'event' | 'filter'>, e: EventRow) {
  const def = scoreEventDef(rule.event);
  if (!def?.filter) return true;
  const want = (rule.filter as ScoreFilter | null)?.[def.filter.key];
  return !want || String(pathValue(e.data, def.filter.path) ?? '') === want;
}

function reasonFor(e: EventRow) {
  const def = scoreEventDef(e.type);
  const detail = def?.detail ? str(pathValue(e.data, def.detail)) : null;
  return `${def?.label ?? e.type}${detail ? `: ${detail}` : ''}`.slice(0, 300);
}

/** Behaviour awards for one event, honouring each rule's limit. Safe to run twice (unique per rule + event + contact). */
async function awardBehaviour(db: Db, e: EventRow, contactIds: string[], rules: ScoreRule[]) {
  const data: Prisma.ScoreEventCreateManyInput[] = [];
  for (const rule of rules) {
    if (rule.event !== e.type || !filterMatches(rule, e)) continue;
    for (const contactId of contactIds) {
      if (rule.limitCount) {
        const since = rule.limitDays ? new Date(e.createdAt.getTime() - rule.limitDays * DAY) : null;
        const n = await db.scoreEvent.count({where: {ruleId: rule.id, contactId, eventId: {not: e.id}, ...(since ? {createdAt: {gt: since}} : {})}});
        if (n >= rule.limitCount) continue;
      }
      data.push({contactId, ruleId: rule.id, ruleName: rule.name, kind: 'behavior', points: rule.points, reason: reasonFor(e), eventType: e.type, eventId: e.id, refId: e.recordId, createdAt: e.createdAt});
    }
  }
  if (data.length) await db.scoreEvent.createMany({data, skipDuplicates: true});
}

/** Job `scoring.events`: awards behaviour points for these events, then rescores the contacts they touch. */
export async function scoreEvents(db: Db, eventIds: string[]) {
  const events = await db.event.findMany({where: {id: {in: eventIds}}, select: {id: true, type: true, recordId: true, data: true, createdAt: true}, orderBy: {createdAt: 'asc'}});
  if (!events.length) return;
  const rules = await db.scoreRule.findMany({where: {enabled: true, kind: 'behavior', event: {in: [...new Set(events.map((e) => e.type))]}}});
  const touched: string[] = [];
  for (const e of events) {
    const contactIds = await contactsFor(db, e);
    if (!contactIds.length) continue;
    await awardBehaviour(db, e, contactIds, rules);
    touched.push(...contactIds);
  }
  await rescoreContacts(db, touched, {bulk: events.length > 1});
}

// ─── Totals ─────────────────────────────────────────────────────────────────

/** Sum of effective points per contact (contacts without awards are absent = 0). */
async function computeScores(db: Db, ids: string[], decay: ScoreDecay) {
  if (!ids.length) return new Map<string, number>();
  const cutoff = new Date(Date.now() - decay.days * DAY);
  const aged = decay.mode === 'off' ? Prisma.sql`e.points` : decay.mode === 'half' ? Prisma.sql`e.points * 0.5` : Prisma.sql`0`;
  const rows = await db.$queryRaw<{id: string; score: number}[]>`
    SELECT e."contactId" AS id,
      ROUND(SUM(CASE WHEN e.kind = 'property' OR e."createdAt" >= ${cutoff} THEN e.points ELSE ${aged} END))::int AS score
    FROM "ScoreEvent" e JOIN "ScoreRule" r ON r.id = e."ruleId" AND r.enabled
    WHERE e."contactId" IN (${Prisma.join(ids)}) AND e."revokedAt" IS NULL
    GROUP BY e."contactId"`;
  return new Map(rows.map((r) => [r.id, Number(r.score)]));
}

/** What one award counts for right now. */
function effective(e: {kind: string; points: number; createdAt: Date; revokedAt: Date | null}, ruleOn: boolean, decay: ScoreDecay, now = Date.now()): {value: number; status: ScoreHistoryItem['status']} {
  if (e.revokedAt) return {value: 0, status: 'revoked'};
  if (!ruleOn) return {value: 0, status: 'rule_off'};
  if (e.kind === 'property' || decay.mode === 'off' || e.createdAt.getTime() >= now - decay.days * DAY) return {value: e.points, status: 'active'};
  return decay.mode === 'half' ? {value: e.points / 2, status: 'decayed'} : {value: 0, status: 'expired'};
}

// ─── Rescore ────────────────────────────────────────────────────────────────

type RescoreOpts = {bulk?: boolean; settings?: ScoringSettings; rules?: ScoreRule[]; defs?: CustomDefs};

const enabledPropertyRules = (db: Db) => db.scoreRule.findMany({where: {enabled: true, kind: 'property'}, orderBy: {position: 'asc'}});

/**
 * Re-evaluates property rules for these contacts (award while matching, revoke
 * when not), recomputes their totals and handles band crossings.
 */
export async function rescoreContacts(db: Db, contactIds: string[], opts: RescoreOpts = {}) {
  const ids = [...new Set(contactIds)];
  if (!ids.length) return {changed: 0, crossed: 0};
  const [settings, rules, defs] = await Promise.all([opts.settings ?? getScoringSettings(db), opts.rules ?? enabledPropertyRules(db), opts.defs ?? loadSegmentDefs(db)]);

  // Property rules: which of these contacts match each one now.
  const matches = new Map<string, Set<string>>();
  for (const rule of rules) {
    const where = await segmentWhere(db, rule.rules, {defs});
    const rows = await db.contact.findMany({where: {AND: [{id: {in: ids}}, where]}, select: {id: true}});
    matches.set(rule.id, new Set(rows.map((r) => r.id)));
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  const active = await db.scoreEvent.findMany({where: {contactId: {in: ids}, kind: 'property', revokedAt: null}, select: {id: true, contactId: true, ruleId: true, points: true}});
  const keep = new Set<string>();
  const revoke: string[] = [];
  for (const a of active) {
    const rule = a.ruleId ? byId.get(a.ruleId) : undefined;
    const key = `${a.ruleId}:${a.contactId}`;
    // No longer matching, rule off / deleted, points changed, or a duplicate.
    if (!rule || !matches.get(rule.id)?.has(a.contactId) || a.points !== rule.points || keep.has(key)) revoke.push(a.id);
    else keep.add(key);
  }
  const create: Prisma.ScoreEventCreateManyInput[] = [];
  for (const rule of rules) {
    for (const contactId of matches.get(rule.id) ?? []) {
      if (!keep.has(`${rule.id}:${contactId}`)) create.push({contactId, ruleId: rule.id, ruleName: rule.name, kind: 'property', points: rule.points, reason: `Matches “${rule.name}”`.slice(0, 300)});
    }
  }
  if (revoke.length) await db.scoreEvent.updateMany({where: {id: {in: revoke}}, data: {revokedAt: new Date()}});
  if (create.length) await db.scoreEvent.createMany({data: create});

  // Totals. Written with SQL so a score change doesn't bump Contact.updatedAt.
  const [totals, before] = await Promise.all([
    computeScores(db, ids, settings.decay),
    db.contact.findMany({where: {id: {in: ids}}, select: {id: true, score: true, ownerId: true, firstName: true, lastName: true}}),
  ]);
  const changed = before.filter((c) => (totals.get(c.id) ?? 0) !== c.score).map((c) => ({...c, next: totals.get(c.id) ?? 0}));
  if (changed.length) {
    await db.$executeRaw`
      UPDATE "Contact" AS c SET score = v.score, "scoreUpdatedAt" = now()
      FROM (VALUES ${Prisma.join(changed.map((c) => Prisma.sql`(${c.id}, ${c.next}::int)`))}) AS v(id, score)
      WHERE c.id = v.id`;
  }
  const crossed = changed
    .map((c) => ({contact: c, from: bandFor(c.score, settings.bands), to: bandFor(c.next, settings.bands)}))
    .filter((x) => x.from.key !== x.to.key);
  if (crossed.length) await bandsCrossed(db, crossed, settings, !!opts.bulk);
  return {changed: changed.length, crossed: crossed.length};
}

type Crossing = {contact: {id: string; score: number; next: number; ownerId: string | null; firstName: string; lastName: string | null}; from: ScoreBand; to: ScoreBand};

async function bandsCrossed(db: Db, crossed: Crossing[], settings: ScoringSettings, bulk: boolean) {
  const rank = (b: ScoreBand) => settings.bands.findIndex((x) => x.key === b.key);
  const band = (b: ScoreBand) => ({key: b.key, name: b.name});
  // Timeline entry without bumping lastActivityAt: a score change isn't contact with the person.
  await db.activity.createMany({
    data: crossed.map((x) => ({
      type: 'score_band',
      title: `Lead score ${rank(x.to) > rank(x.from) ? 'rose' : 'fell'} to ${x.to.name} (${x.contact.next})`,
      contactId: x.contact.id,
      data: {from: band(x.from), to: band(x.to), oldScore: x.contact.score, newScore: x.contact.next, tone: x.to.tone},
    })),
  });
  await emitMany(
    db,
    'contact.score_changed',
    crossed.map((x) => ({
      entity: 'contact',
      recordId: x.contact.id,
      data: {contactId: x.contact.id, oldScore: x.contact.score, newScore: x.contact.next, oldBand: band(x.from), newBand: band(x.to), direction: rank(x.to) > rank(x.from) ? 'up' : 'down'},
    })),
  );

  if (settings.notify === 'off') return;
  const wanted = crossed.filter((x) => x.contact.ownerId && (settings.notify === 'both' || rank(x.to) > rank(x.from)));
  const byOwner = new Map<string, Crossing[]>();
  for (const x of wanted) byOwner.set(x.contact.ownerId!, [...(byOwner.get(x.contact.ownerId!) ?? []), x]);
  for (const [ownerId, list] of byOwner) {
    if (bulk && list.length > SUMMARY_AFTER) {
      await notify(db, [ownerId], {type: 'score', title: `${list.length} of your contacts changed lead score band`, body: list.slice(0, 5).map((x) => `${name(x.contact)}: ${x.to.name}`).join(' · '), link: '/contacts?sort=score&dir=desc'});
      continue;
    }
    for (const x of list) {
      await notify(db, [ownerId], {type: 'score', title: `${name(x.contact)} is now ${x.to.name}`, body: `Lead score ${x.contact.score} → ${x.contact.next} (was ${x.from.name})`, link: recordLink.contact(x.contact.id)});
    }
  }
}

const name = (c: {firstName: string; lastName: string | null}) => [c.firstName, c.lastName].filter(Boolean).join(' ');

// ─── Recalculate all / periodic pass ────────────────────────────────────────

type RecalcState = {runId: string; startedAt: string; processed: number; total: number; finishedAt: string | null};
type CursorState = {after: string | null; lastPassAt: string | null};

async function recomputeBatch(db: Db, after: string | null, shared: RescoreOpts) {
  const rows = await db.contact.findMany({where: after ? {id: {gt: after}} : {}, orderBy: {id: 'asc'}, take: BATCH, select: {id: true}});
  const res = rows.length ? await rescoreContacts(db, rows.map((r) => r.id), {...shared, bulk: true}) : {changed: 0};
  return {processed: rows.length, changed: res.changed, next: rows.length === BATCH ? rows.at(-1)!.id : null};
}

async function sharedOpts(db: Db): Promise<RescoreOpts> {
  const [settings, rules, defs] = await Promise.all([getScoringSettings(db), enabledPropertyRules(db), loadSegmentDefs(db)]);
  return {settings, rules, defs};
}

/** Starts (or restarts) a full recalculation in the background. */
export async function startRecalc(db: Db) {
  const state: RecalcState = {runId: crypto.randomUUID(), startedAt: new Date().toISOString(), processed: 0, total: await db.contact.count(), finishedAt: null};
  await writeSetting(db, RECALC_KEY, state);
  await enqueue(db, 'scoring.recalc', {runId: state.runId, after: null});
  kickJobs();
  return state;
}

/** Job `scoring.recalc`: a few batches, then queues itself for the rest. A newer run supersedes it. */
export async function recalcJob(db: Db, p: {runId: string; after: string | null}) {
  const state = await readSetting<RecalcState>(db, RECALC_KEY);
  if (!state || state.runId !== p.runId || state.finishedAt) return;
  const shared = await sharedOpts(db);
  const started = Date.now();
  let after = p.after;
  let processed = state.processed;
  do {
    const r = await recomputeBatch(db, after, shared);
    processed += r.processed;
    after = r.next;
  } while (after && Date.now() - started < 8_000);
  const latest = await readSetting<RecalcState>(db, RECALC_KEY);
  if (latest?.runId !== p.runId) return;
  if (after) {
    await writeSetting(db, RECALC_KEY, {...state, processed});
    await enqueue(db, 'scoring.recalc', {runId: p.runId, after});
  } else {
    const now = new Date().toISOString();
    await writeSetting(db, RECALC_KEY, {...state, processed, finishedAt: now});
    await writeSetting(db, CURSOR_KEY, {after: null, lastPassAt: now} satisfies CursorState);
  }
}

/**
 * From /jobs/run: walks all contacts in small batches so decay and time-based
 * property rules ("opened an email in the last 30 days") stay current, then
 * rests for an hour after each full pass.
 */
export async function scoringTick(db: Db, budgetMs = 8_000) {
  const recalc = await readSetting<RecalcState>(db, RECALC_KEY);
  if (recalc && !recalc.finishedAt && Date.now() - Date.parse(recalc.startedAt) < 6 * 60 * 60_000) return {skipped: 'recalculating'};
  const state = (await readSetting<CursorState>(db, CURSOR_KEY)) ?? {after: null, lastPassAt: null};
  if (!state.after) {
    if (state.lastPassAt && Date.now() - Date.parse(state.lastPassAt) < PASS_GAP_MS) return {skipped: 'resting'};
    const inUse = (await db.scoreRule.count({where: {enabled: true}})) > 0 || (await db.contact.count({where: {score: {not: 0}}})) > 0;
    if (!inUse) return {skipped: 'no rules'};
  }
  const shared = await sharedOpts(db);
  const started = Date.now();
  let after = state.after;
  let processed = 0;
  let changed = 0;
  do {
    const r = await recomputeBatch(db, after, shared);
    processed += r.processed;
    changed += r.changed;
    after = r.next;
  } while (after && Date.now() - started < budgetMs);
  await writeSetting(db, CURSOR_KEY, after ? {after, lastPassAt: state.lastPassAt} : {after: null, lastPassAt: new Date().toISOString()});
  return {processed, changed};
}

// ─── Read models ────────────────────────────────────────────────────────────

/** A contact's score with the reasons behind it. */
export async function scoreBreakdown(db: Db, contactId: string): Promise<ScoreBreakdown> {
  const [contact, settings, events, rules] = await Promise.all([
    db.contact.findUnique({where: {id: contactId}, select: {score: true, scoreUpdatedAt: true}}),
    getScoringSettings(db),
    db.scoreEvent.findMany({where: {contactId}, orderBy: {createdAt: 'desc'}, take: 1000}),
    db.scoreRule.findMany({select: {id: true, enabled: true}}),
  ]);
  if (!contact) throw new HTTPException(404, {message: 'Contact not found'});
  const on = new Map(rules.map((r) => [r.id, r.enabled]));
  const now = Date.now();
  const history: ScoreHistoryItem[] = events.map((e) => {
    const eff = effective(e, !!e.ruleId && !!on.get(e.ruleId), settings.decay, now);
    return {
      id: e.id,
      ruleId: e.ruleId,
      ruleName: e.ruleName,
      kind: e.kind as ScoreHistoryItem['kind'],
      points: e.points,
      effective: eff.value,
      status: eff.status,
      reason: e.reason,
      eventType: e.eventType,
      refId: e.refId,
      revokedAt: e.revokedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    };
  });
  const per = new Map<string, ScoreBreakdown['rules'][number]>();
  for (const h of history) {
    if (h.effective === 0) continue;
    const k = h.ruleId ?? h.ruleName;
    const row = per.get(k) ?? {ruleId: h.ruleId, name: h.ruleName, kind: h.kind, points: 0, awards: 0};
    row.points += h.effective;
    row.awards += 1;
    per.set(k, row);
  }
  return {
    score: contact.score,
    scoreUpdatedAt: contact.scoreUpdatedAt?.toISOString() ?? null,
    band: bandFor(contact.score, settings.bands),
    rules: [...per.values()].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    history: history.slice(0, 100),
  };
}

/** "Test on a contact": what every rule (and an unsaved property rule) gives this contact now. Writes nothing. */
export async function testContact(db: Db, contactId: string, draft?: {rules: SegmentRules; points: number}): Promise<ScoreTestResult> {
  const [contact, settings, rules, defs, events] = await Promise.all([
    db.contact.findUnique({where: {id: contactId}, select: {id: true, firstName: true, lastName: true, email: true, score: true}}),
    getScoringSettings(db),
    db.scoreRule.findMany({orderBy: [{kind: 'desc'}, {position: 'asc'}, {createdAt: 'asc'}]}),
    loadSegmentDefs(db),
    db.scoreEvent.findMany({where: {contactId, kind: 'behavior', revokedAt: null}, select: {ruleId: true, kind: true, points: true, createdAt: true, revokedAt: true}}),
  ]);
  if (!contact) throw new HTTPException(404, {message: 'Contact not found'});
  const matches = async (r: unknown) => (await db.contact.count({where: {AND: [{id: contactId}, await segmentWhere(db, r, {defs})]}})) > 0;
  const out: ScoreTestResult['rules'] = [];
  let computed = 0;
  for (const rule of rules) {
    if (rule.kind === 'property') {
      const m = await matches(rule.rules);
      out.push({ruleId: rule.id, name: rule.name, kind: 'property', enabled: rule.enabled, points: m ? rule.points : 0, matches: m});
      if (m && rule.enabled) computed += rule.points;
    } else {
      const mine = events.filter((e) => e.ruleId === rule.id);
      const pts = mine.reduce((s, e) => s + effective(e, true, settings.decay).value, 0);
      out.push({ruleId: rule.id, name: rule.name, kind: 'behavior', enabled: rule.enabled, points: pts, awards: mine.length});
      if (rule.enabled) computed += pts;
    }
  }
  computed = Math.round(computed);
  const draftResult = draft ? {matches: await matches(draft.rules), points: draft.points} : null;
  const {score: stored, ...who} = contact;
  return {contact: who, stored, computed, band: bandFor(computed, settings.bands), rules: out, draft: draftResult};
}

export async function scoringStatus(db: Db): Promise<ScoringStatus> {
  const [settings, ruleCount, enabledCount, recalc, cursor] = await Promise.all([
    getScoringSettings(db),
    db.scoreRule.count(),
    db.scoreRule.count({where: {enabled: true}}),
    readSetting<RecalcState>(db, RECALC_KEY),
    readSetting<CursorState>(db, CURSOR_KEY),
  ]);
  const bands = await Promise.all(settings.bands.map(async (b) => ({key: b.key, count: await db.contact.count({where: bandWhere(b.key, settings.bands)})})));
  return {ruleCount, enabledCount, bands, recalc, lastPassAt: cursor?.lastPassAt ?? null};
}

/** Contact where for one band (score range); an unknown band matches nobody. */
export function bandWhere(key: string, bands: ScoreBand[]): Prisma.ContactWhereInput {
  const i = bands.findIndex((b) => b.key === key);
  if (i < 0) return {id: {in: []}};
  const min = i === 0 ? null : bands[i]!.min;
  const max = bands[i + 1]?.min ?? null;
  return {score: {...(min !== null ? {gte: min} : {}), ...(max !== null ? {lt: max} : {})}};
}

export async function scoreBandWhere(db: Db, key: string) {
  return bandWhere(key, (await getScoringSettings(db)).bands);
}

/** Inside a merge transaction: moves the dropped contact's awards to the survivor (skipping ones it already has). */
export const moveScoreEvents = (db: Db, fromId: string, toId: string) =>
  db.$executeRaw`
    UPDATE "ScoreEvent" e SET "contactId" = ${toId}
    WHERE e."contactId" = ${fromId}
      AND NOT EXISTS (SELECT 1 FROM "ScoreEvent" k WHERE k."contactId" = ${toId} AND k."ruleId" IS NOT DISTINCT FROM e."ruleId" AND k."eventId" = e."eventId")`;
