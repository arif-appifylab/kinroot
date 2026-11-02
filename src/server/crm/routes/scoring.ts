import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma, ScoreRule} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {requireRole, type AppEnv} from '../kit/guards';
import {BAND_TONES, scoreEventDef} from '@/lib/scoring';
import {asRules, type SegmentRules} from '@/lib/segments';
import {audit} from '../lib/audit';
import {notFound, ownerScope, valid} from '../lib/http';
import {invalidateScoringInterest} from '../lib/scoring-hook';
import {assertPropertyRules, getScoringSettings, saveScoringSettings, scoreBreakdown, scoringStatus, startRecalc, testContact} from '../lib/scoring';
import {segmentRulesSchema} from '../lib/segments';

const DAY = 86_400_000;

const settingsSchema = z.object({
  bands: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_-]{1,30}$/, 'use lowercase letters, digits, - or _'),
        name: z.string().trim().min(1).max(30),
        min: z.number().int().min(-100_000).max(100_000).nullable(),
        tone: z.enum(BAND_TONES as [string, ...string[]]),
      }),
    )
    .min(1)
    .max(8),
  decay: z.object({mode: z.enum(['off', 'half', 'expire']), days: z.number().int().min(1).max(3650)}),
  notify: z.enum(['up', 'both', 'off']),
});

const filterSchema = z.object({
  formId: z.string().max(60).optional(),
  linkId: z.string().max(60).optional(),
  pipelineId: z.string().max(60).optional(),
  listId: z.string().max(60).optional(),
  kind: z.string().max(30).optional(),
});

const ruleBody = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  kind: z.enum(['property', 'behavior']),
  enabled: z.boolean().optional(),
  points: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'cannot be 0'),
  rules: segmentRulesSchema.optional(),
  event: z.string().max(60).nullish(),
  filter: filterSchema.optional(),
  limitCount: z.number().int().min(1).max(1000).nullish(),
  limitDays: z.number().int().min(1).max(3650).nullish(),
});

type RuleInput = z.infer<typeof ruleBody>;

/** Checks a rule as it will be saved and returns the columns for its kind. */
async function ruleData(db: Db, input: RuleInput): Promise<Prisma.ScoreRuleUncheckedCreateInput> {
  const base = {name: input.name, kind: input.kind, points: input.points, enabled: input.enabled ?? true};
  if (input.kind === 'property') {
    const rules = asRules(input.rules) as SegmentRules;
    await assertPropertyRules(db, rules);
    return {...base, rules: rules as unknown as Prisma.InputJsonValue, event: null, filter: {}, limitCount: null, limitDays: null};
  }
  const def = scoreEventDef(input.event);
  if (!def) throw new HTTPException(400, {message: 'Pick what the contact does'});
  const value = def.filter ? input.filter?.[def.filter.key] : undefined;
  return {
    ...base,
    rules: {},
    event: def.type,
    filter: value ? {[def.filter!.key]: value} : {},
    limitCount: input.limitCount ?? null,
    limitDays: input.limitCount ? input.limitDays ?? null : null,
  };
}

/** Did this edit change what contacts score (so totals must be recalculated)? */
const affectsScores = (before: ScoreRule, after: ScoreRule) =>
  before.enabled !== after.enabled || before.points !== after.points || (after.kind === 'property' && JSON.stringify(before.rules) !== JSON.stringify(after.rules));

export const scoring = new Hono<AppEnv>()
  // Bands are needed wherever a score is shown, so every signed-in user can read the settings.
  .get('/settings', async (c) => c.json({settings: await getScoringSettings(c.var.db)}))

  .patch('/settings', requireRole('ADMIN'), valid('json', settingsSchema), async (c) => {
    const db = c.var.db;
    const before = await getScoringSettings(db);
    const settings = await saveScoringSettings(db, c.req.valid('json') as Parameters<typeof saveScoringSettings>[1]);
    // Decay changes every total; bands are score ranges, so they apply on read.
    const recalculating = JSON.stringify(before.decay) !== JSON.stringify(settings.decay);
    if (recalculating) await startRecalc(db);
    await audit(db, c, {action: 'settings.scoring', label: 'Lead scoring', meta: {before, after: settings}});
    return c.json({settings, recalculating});
  })

  .get('/rules', async (c) => {
    const db = c.var.db;
    const [rows, active, recent] = await Promise.all([
      db.scoreRule.findMany({orderBy: [{position: 'asc'}, {createdAt: 'asc'}]}),
      db.scoreEvent.groupBy({by: ['ruleId'], where: {kind: 'property', revokedAt: null}, _count: {_all: true}}),
      db.scoreEvent.groupBy({by: ['ruleId'], where: {kind: 'behavior', createdAt: {gte: new Date(Date.now() - 30 * DAY)}}, _count: {_all: true}}),
    ]);
    const count = (xs: typeof active, id: string) => xs.find((x) => x.ruleId === id)?._count._all ?? 0;
    return c.json({rows: rows.map((r) => ({...r, stats: {contacts: count(active, r.id), awards30d: count(recent, r.id)}}))});
  })

  .post('/rules', requireRole('ADMIN'), valid('json', ruleBody), async (c) => {
    const db = c.var.db;
    const data = await ruleData(db, c.req.valid('json'));
    const rule = await db.scoreRule.create({data: {...data, position: await db.scoreRule.count()}});
    invalidateScoringInterest();
    // Behaviour rules count from now on; property rules apply to everyone who matches today.
    if (rule.kind === 'property' && rule.enabled) await startRecalc(db);
    await audit(db, c, {action: 'score_rule.created', entity: 'score_rule', recordId: rule.id, label: rule.name, meta: {kind: rule.kind, points: rule.points, event: rule.event}});
    return c.json({rule}, 201);
  })

  .patch('/rules/:id', requireRole('ADMIN'), valid('json', ruleBody.partial()), async (c) => {
    const db = c.var.db;
    const before = await db.scoreRule.findUnique({where: {id: c.req.param('id')}});
    if (!before) throw notFound('Rule');
    const patch = c.req.valid('json');
    const merged = {
      name: before.name,
      kind: before.kind as RuleInput['kind'],
      enabled: before.enabled,
      points: before.points,
      rules: before.rules as unknown as SegmentRules,
      event: before.event,
      filter: before.filter as RuleInput['filter'],
      limitCount: before.limitCount,
      limitDays: before.limitDays,
      ...patch,
    };
    if (merged.kind !== before.kind) throw new HTTPException(400, {message: "A rule's type can't change; create a new rule instead"});
    const rule = await db.scoreRule.update({where: {id: before.id}, data: await ruleData(db, merged)});
    if (rule.name !== before.name) await db.scoreEvent.updateMany({where: {ruleId: rule.id}, data: {ruleName: rule.name}});
    // New points apply to past behaviour awards too, so "email opened" always means the same.
    if (rule.kind === 'behavior' && rule.points !== before.points) await db.scoreEvent.updateMany({where: {ruleId: rule.id, kind: 'behavior'}, data: {points: rule.points}});
    invalidateScoringInterest();
    if (affectsScores(before, rule)) await startRecalc(db);
    await audit(db, c, {action: 'score_rule.updated', entity: 'score_rule', recordId: rule.id, label: rule.name, meta: {changes: Object.keys(patch)}});
    return c.json({rule});
  })

  .delete('/rules/:id', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const rule = await db.scoreRule.findUnique({where: {id: c.req.param('id')}});
    if (!rule) throw notFound('Rule');
    // Its awards stay in each contact's history (by name) but stop counting.
    await db.scoreEvent.updateMany({where: {ruleId: rule.id, revokedAt: null}, data: {revokedAt: new Date()}});
    await db.scoreRule.delete({where: {id: rule.id}});
    invalidateScoringInterest();
    await startRecalc(db);
    await audit(db, c, {action: 'score_rule.deleted', entity: 'score_rule', recordId: rule.id, label: rule.name});
    return c.json({ok: true});
  })

  .post('/recalculate', requireRole('ADMIN'), async (c) => {
    const state = await startRecalc(c.var.db);
    return c.json({recalc: state});
  })

  .get('/status', requireRole('ADMIN'), async (c) => c.json(await scoringStatus(c.var.db)))

  // "Test on a contact": the score every rule (plus an unsaved property rule) gives this contact now.
  .post('/test', valid('json', z.object({contactId: z.string().min(1), draft: z.object({rules: segmentRulesSchema, points: z.number().int()}).optional()})), async (c) => {
    const {contactId, draft} = c.req.valid('json');
    const visible = await c.var.db.contact.findFirst({where: {id: contactId, ...(await ownerScope(c))}, select: {id: true}});
    if (!visible) throw notFound('Contact');
    return c.json(await testContact(c.var.db, contactId, draft));
  })

  // Score breakdown on the contact page.
  .get('/contacts/:id', async (c) => {
    const visible = await c.var.db.contact.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}, select: {id: true}});
    if (!visible) throw notFound('Contact');
    return c.json(await scoreBreakdown(c.var.db, visible.id));
  });
