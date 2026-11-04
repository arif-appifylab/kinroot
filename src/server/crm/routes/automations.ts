import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Automation, Prisma} from '../../../generated/prisma/client';
import {
  automationProblems,
  flattenSteps,
  INACTIVITY_RULES,
  mapSteps,
  OBJECTS as OBJECT_LABELS,
  STEP_TYPES,
  TEST_MODES,
  type AutoObject,
  type Problem,
  type Step,
  type Target,
  type TestMode,
  type Trigger,
} from '@/lib/automations';
import {isTimeZone} from '@/lib/scheduling';
import {webhookLabel} from '@/lib/webhook-targets';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import {currentUser, isAdmin, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {audit, fingerprint} from '../lib/audit';
import {invalidateAutomationInterest} from '../lib/automation-hook';
import {fieldsFor} from '../lib/automation-records';
import {automationSecret} from '../lib/automation-steps';
import {definitionOf, queueRun, runOnList, runOnRecord, sampleRecord, startTestRun, stepsOf, testAutomation} from '../lib/automations';
import {notFound, ownerScope, valid} from '../lib/http';
import {segmentRulesSchema} from '../lib/segments';
import {ticketScope} from '../lib/tickets';

/**
 * Automations API. Permissions: admins create, edit, switch on/off, test,
 * duplicate and delete automations and manage runs; everyone signed in can
 * see automations and their run history (with owner-only visibility, members
 * see runs about records they own or started); members run manual
 * automations on records and lists they can see. Viewers only read.
 */

const DAY = 86_400_000;
const OBJECTS = ['contact', 'company', 'deal', 'ticket', 'none'] as const;
const TARGET_KEYS = ['contact', 'company', 'deal', 'ticket'] as const;
const str = (max: number) => z.string().max(max);
const id = z.string().max(60);

const conditionsSchema = z.object({
  match: z.enum(['all', 'any']),
  blocks: z.array(z.object({target: z.enum(TARGET_KEYS), rules: segmentRulesSchema})).max(10),
});

const filterSchema = z.object({
  field: str(120).optional(),
  formId: id.optional(),
  listId: id.optional(),
  pipelineId: id.optional(),
  stageId: id.optional(),
  fromStageId: id.optional(),
  status: str(30).optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  band: str(30).optional(),
  bandDirection: z.enum(['up', 'down']).optional(),
  linkId: id.optional(),
  kind: str(30).optional(),
  webhookId: id.optional(),
  dataInEvent: str(100).optional(),
});

const unit = z.enum(['minutes', 'hours', 'days', 'weeks']);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM').nullish();

const triggerSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('event'), event: str(60), filter: filterSchema.optional(), conditions: conditionsSchema.optional()}),
  z.object({
    kind: z.literal('date'),
    source: z.enum(['record', 'booking']).optional(),
    field: str(120),
    amount: z.number().int().min(0).max(3650),
    unit,
    direction: z.enum(['before', 'after']),
    time,
    zone: z.enum(['automation', 'owner']).optional(),
    conditions: conditionsSchema.optional(),
  }),
  z.object({kind: z.literal('inactivity'), rule: z.enum(Object.keys(INACTIVITY_RULES) as [string, ...string[]]), amount: z.number().int().min(1).max(3650), unit: z.enum(['hours', 'days']), listId: id.optional(), conditions: conditionsSchema.optional()}),
  z.object({kind: z.literal('manual'), conditions: conditionsSchema.optional()}),
]);

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(40),
    type: z.enum(Object.keys(STEP_TYPES) as [string, ...string[]]),
    conditions: conditionsSchema.optional(),
    then: z.array(stepSchema).max(60).optional(),
    else: z.array(stepSchema).max(60).optional(),
    target: z.enum(TARGET_KEYS).optional(),
    field: str(120).optional(),
    value: z.union([str(5000), z.number(), z.boolean(), z.array(str(200)).max(100), z.null()]).optional(),
    mode: z.enum(['set', 'clear', 'relative']).optional(),
    days: z.number().int().min(-3650).max(3650).optional(),
    tag: str(60).optional(),
    assignMode: z.enum(['user', 'round_robin']).optional(),
    userIds: z.array(id).max(50).optional(),
    onlyIfEmpty: z.boolean().optional(),
    assignee: z.enum(['owner', 'user', 'assignee', 'creator', 'none']).optional(),
    userId: id.nullish(),
    title: str(300).optional(),
    description: str(5000).optional(),
    dueDays: z.number().int().min(0).max(3650).optional(),
    time,
    taskType: str(20).optional(),
    priority: str(20).optional(),
    pipelineId: id.optional(),
    stageId: id.optional(),
    subject: str(300).optional(),
    category: str(100).optional(),
    queue: str(100).optional(),
    listId: id.optional(),
    html: str(100_000).optional(),
    layout: z.enum(['branded', 'plain']).optional(),
    from: z.enum(['owner', 'shared']).optional(),
    accountId: id.optional(),
    templateId: id.optional(),
    body: str(5000).optional(),
    email: z.boolean().optional(),
    url: str(2000).optional(),
    waitMode: z.enum(['duration', 'until_date', 'until_weekday']).optional(),
    amount: z.number().int().min(0).max(3650).optional(),
    unit: unit.optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  }),
) as unknown as z.ZodType<Step>;

const body = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  description: z.string().trim().max(1000).nullish(),
  object: z.enum(OBJECTS),
  trigger: triggerSchema,
  steps: z.array(stepSchema).max(60),
  reenroll: z.enum(['always', 'never', 'after']).optional(),
  reenrollDays: z.number().int().min(1).max(3650).nullish(),
  activeFrom: z.string().datetime({offset: true}).nullish(),
  activeUntil: z.string().datetime({offset: true}).nullish(),
  timezone: z.string().max(60).refine((tz) => isTimeZone(tz), 'unknown time zone').optional(),
});

type Body = z.infer<typeof body>;

const triggerEventOf = (t: Trigger) => (t.kind === 'event' ? t.event : null);

/** Shape problems plus references that must exist (lists, people, pipelines, fields, mailboxes). */
async function problemsOf(db: Db, a: {name: string; object: string; trigger: unknown; steps: unknown}): Promise<Problem[]> {
  const object = a.object as AutoObject;
  const trigger = a.trigger as Trigger;
  const steps = (Array.isArray(a.steps) ? a.steps : []) as Step[];
  const out = automationProblems({name: a.name, object, trigger, steps});
  const add = (stepId: string | null, message: string) => out.push({stepId, message});
  const listOk = async (listId: string | undefined, stepId: string | null) => {
    if (!listId) return;
    const list = await db.contactList.findUnique({where: {id: listId}, select: {kind: true, name: true}});
    if (!list) add(stepId, 'That list no longer exists');
    else if (list.kind !== 'STATIC') add(stepId, `${list.name} is a segment: pick a static list`);
  };
  const usersOk = async (ids: (string | null | undefined)[], stepId: string | null) => {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return;
    const found = await db.member.count({where: {id: {in: want}, active: true}});
    if (found < want.length) add(stepId, 'Someone picked here is no longer an active user');
  };
  const fieldOk = async (target: Target | undefined, key: string | undefined, stepId: string | null, test: (f: Awaited<ReturnType<typeof fieldsFor>>[number]) => boolean, message: string) => {
    if (!target || !key) return;
    const field = (await fieldsFor(db, target)).find((f) => f.key === key);
    if (!field || !test(field)) add(stepId, message);
  };

  if (trigger.kind === 'date' && trigger.source !== 'booking' && object !== 'none' && trigger.field) {
    await fieldOk(object, trigger.field, null, (f) => f.kind === 'date', 'That date field no longer exists');
  }
  if (trigger.kind === 'inactivity' && trigger.rule === 'in_list') await listOk(trigger.listId, null);
  if (trigger.kind === 'date' && trigger.source === 'booking' && object !== 'contact') add(null, 'Booked meetings belong to contacts: use a contact automation');
  for (const {step: s} of flattenSteps(steps)) {
    if (s.type === 'add_to_list' || s.type === 'remove_from_list') await listOk(s.listId, s.id);
    if (s.type === 'update_field') await fieldOk(s.target, s.field, s.id, (f) => !!f.writable, 'That field no longer exists or can\'t be set');
    if (s.type === 'wait' && s.waitMode === 'until_date') await fieldOk(s.target, s.field, s.id, (f) => f.kind === 'date', 'That date field no longer exists');
    if (s.type === 'assign_owner') await usersOk(s.assignMode === 'user' ? [s.userId] : s.userIds ?? [], s.id);
    if ((s.type === 'create_task' || s.type === 'create_deal' || s.type === 'create_ticket') && s.assignee === 'user') await usersOk([s.userId], s.id);
    if (s.type === 'notify' && s.assignee === 'user') await usersOk(s.userIds ?? [], s.id);
    if (s.type === 'create_deal' && s.stageId) {
      const stage = await db.stage.findUnique({where: {id: s.stageId}, select: {pipelineId: true}});
      if (!stage || stage.pipelineId !== s.pipelineId) add(s.id, 'That pipeline or stage no longer exists');
    }
    if (s.type === 'update_field' && s.field === 'stageId' && typeof s.value === 'string' && s.value && !(await db.stage.findUnique({where: {id: s.value}, select: {id: true}}))) add(s.id, 'That stage no longer exists');
    if (s.type === 'send_email' && s.from === 'shared' && s.accountId && !(await db.emailAccount.findFirst({where: {id: s.accountId, userId: null}, select: {id: true}}))) add(s.id, 'That shared mailbox no longer exists');
  }
  return out;
}

function dataOf(input: Body, c: AppContext): Prisma.AutomationUncheckedCreateInput {
  return {
    name: input.name,
    description: input.description ?? null,
    object: input.object,
    triggerKind: input.trigger.kind,
    triggerEvent: triggerEventOf(input.trigger as Trigger),
    trigger: input.trigger as unknown as Prisma.InputJsonValue,
    steps: input.steps as unknown as Prisma.InputJsonValue,
    reenroll: input.reenroll ?? 'always',
    reenrollDays: input.reenroll === 'after' ? input.reenrollDays ?? 30 : null,
    activeFrom: input.activeFrom ? new Date(input.activeFrom) : null,
    activeUntil: input.activeUntil ? new Date(input.activeUntil) : null,
    timezone: input.timezone ?? 'UTC',
    origin: publicOrigin(c.req.raw),
  };
}

/** "Send a webhook" URLs work like passwords (Slack, Zapier…): only admins see them, others see the service. */
const maskSteps = (steps: unknown) => (Array.isArray(steps) ? mapSteps(steps as Step[], (s) => (s.type === 'webhook' && s.url ? {...s, url: webhookLabel(s.url)} : s)) : steps);

const publicAutomation = (a: Automation, admin = true) => {
  const {webhookSecret, state: _state, ...rest} = a;
  return {...rest, ...(admin ? {} : {steps: maskSteps(rest.steps) as Prisma.JsonValue}), hasSecret: !!webhookSecret};
};

/** A run for a non-admin: the draft a test run keeps has its webhook URLs masked too. */
function maskRun<R extends {definition: Prisma.JsonValue}>(run: R, admin: boolean): R {
  const d = run.definition;
  if (admin || !d || typeof d !== 'object' || Array.isArray(d)) return run;
  return {...run, definition: {...d, steps: maskSteps(d.steps) as Prisma.JsonValue}};
}

const adminOf = (c: AppContext) => isAdmin(currentUser(c));

/** Records the user may see: owner scope for contacts / companies / deals, ticket scope for tickets. */
async function visibleRecord(c: AppContext, object: AutoObject, recordId: string) {
  const db = c.var.db;
  if (object === 'contact') return db.contact.findFirst({where: {id: recordId, ...(await ownerScope(c))}, select: {id: true}});
  if (object === 'company') return db.company.findFirst({where: {id: recordId, ...(await ownerScope(c))}, select: {id: true}});
  if (object === 'deal') return db.deal.findFirst({where: {id: recordId, ...(await ownerScope(c))}, select: {id: true}});
  if (object === 'ticket') return db.ticket.findFirst({where: {id: recordId, ...(await ticketScope(c))}, select: {id: true}});
  return null;
}

/** With owner-only visibility, members see runs about records they own or runs they started. */
async function runScope(c: AppContext): Promise<Prisma.AutomationRunWhereInput> {
  const scope = await ownerScope(c);
  return scope.ownerId ? {OR: [{ownerId: scope.ownerId}, {startedById: scope.ownerId}]} : {};
}

async function load(c: AppContext) {
  const a = await c.var.db.automation.findUnique({where: {id: c.req.param('id')}});
  if (!a) throw notFound('Automation');
  return a;
}

async function assertCanEnable(db: Db, a: {name: string; object: string; trigger: unknown; steps: unknown}) {
  const problems = await problemsOf(db, a);
  if (problems.length) throw new HTTPException(400, {message: `Can't switch on yet: ${problems[0]!.message}`});
}

/** Where the user may pick records of a type (the sample record of a test comes from here). */
async function recordScope(c: AppContext, object: AutoObject): Promise<Record<string, unknown>> {
  return object === 'ticket' ? ticketScope(c) : ownerScope(c);
}

/** The draft from the editor laid over the saved automation (what a test runs). */
const withDraft = (saved: Automation, draft: Body, c: AppContext) => ({...saved, ...dataOf(draft, c), id: saved.id}) as Automation;

/** A test run as the editor shows it: the steps it runs are the draft it was started with. */
function testView<R extends {test: string | null; definition: unknown; automation: {steps: unknown; object: string; trigger: unknown}}>(run: R) {
  if (!run.test) return run;
  const a = definitionOf(run.automation as unknown as Automation, run as never);
  return {...run, automation: {...run.automation, steps: a.steps, object: a.object, trigger: a.trigger}};
}

const runQuery = z.object({
  status: z.enum(['running', 'waiting', 'done', 'failed', 'skipped', 'canceled']).optional(),
  source: z.enum(['event', 'date', 'inactivity', 'manual', 'list', 'test']).optional(),
  q: z.string().max(100).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const automations = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = c.var.db;
    const rows = await db.automation.findMany({orderBy: [{enabled: 'desc'}, {updatedAt: 'desc'}]});
    const since = new Date(Date.now() - 7 * DAY);
    const stats = await db.automationRun.groupBy({by: ['automationId', 'status'], where: {startedAt: {gte: since}, test: null}, _count: {_all: true}});
    const count = (automationId: string, statuses?: string[]) => stats.filter((s) => s.automationId === automationId && (!statuses || statuses.includes(s.status))).reduce((n, s) => n + s._count._all, 0);
    const admin = adminOf(c);
    return c.json({
      rows: rows.map((a) => ({
        ...publicAutomation(a, admin),
        stepCount: flattenSteps(stepsOf(a)).length,
        stats: {runs7d: count(a.id, ['running', 'waiting', 'done', 'failed', 'canceled']), failed7d: count(a.id, ['failed']), waiting: count(a.id, ['waiting'])},
      })),
    });
  })

  .post('/', requireRole('ADMIN'), valid('json', body), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const a = await db.automation.create({data: {...dataOf(c.req.valid('json'), c), createdById: me.id}});
    await audit(db, c, {action: 'automation.created', entity: 'automation', recordId: a.id, label: a.name});
    return c.json({automation: publicAutomation(a)}, 201);
  })

  /** Runs about one record, plus the manual automations that can run on it. */
  .get('/for-record', valid('query', z.object({object: z.enum(TARGET_KEYS), recordId: id})), async (c) => {
    const {object, recordId} = c.req.valid('query');
    if (!(await visibleRecord(c, object, recordId))) throw notFound('Record');
    const db = c.var.db;
    const [runs, manual] = await Promise.all([
      db.automationRun.findMany({where: {recordId, object}, orderBy: {startedAt: 'desc'}, take: 15, include: {automation: {select: {id: true, name: true}}}}),
      db.automation.findMany({where: {enabled: true, triggerKind: 'manual', object}, orderBy: {name: 'asc'}, select: {id: true, name: true, description: true}}),
    ]);
    const admin = adminOf(c);
    return c.json({runs: runs.map((r) => maskRun(r, admin)), manual});
  })

  .get('/runs/:runId', async (c) => {
    const db = c.var.db;
    const run = await db.automationRun.findFirst({
      where: {id: c.req.param('runId'), ...(await runScope(c))},
      include: {steps: {orderBy: {startedAt: 'asc'}}, automation: {select: {id: true, name: true, steps: true, object: true, trigger: true}}},
    });
    if (!run) throw notFound('Run');
    const view = testView(run);
    if (adminOf(c)) return c.json({run: view});
    return c.json({run: {...maskRun(view, false), automation: {...view.automation, steps: maskSteps(view.automation.steps)}}});
  })

  .post('/runs/:runId/cancel', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const run = await db.automationRun.findUnique({where: {id: c.req.param('runId')}, include: {automation: {select: {name: true}}}});
    if (!run) throw notFound('Run');
    if (run.status !== 'running' && run.status !== 'waiting') throw new HTTPException(400, {message: 'This run has already finished'});
    await db.automationRun.update({where: {id: run.id}, data: {status: 'canceled', error: `${run.test ? 'Stopped' : 'Canceled'} by ${currentUser(c).name}`, finishedAt: new Date(), cursor: null, waitUntil: null}});
    if (run.test === 'record') await audit(db, c, {action: 'automation.test_stopped', entity: 'automation', recordId: run.automationId, label: run.automation.name, meta: {runId: run.id, record: run.recordLabel}});
    return c.json({ok: true});
  })

  /** Picks a failed run up again at the step that failed (finished steps are not repeated). */
  .post('/runs/:runId/retry', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const run = await db.automationRun.findUnique({where: {id: c.req.param('runId')}});
    if (!run) throw notFound('Run');
    if (run.status !== 'failed') throw new HTTPException(400, {message: 'Only failed runs can be retried'});
    const failed = await db.automationRunStep.findFirst({where: {runId: run.id, status: 'failed'}, orderBy: {startedAt: 'desc'}});
    if (!failed) throw new HTTPException(400, {message: 'This run has no failed step to retry'});
    await db.automationRunStep.update({where: {id: failed.id}, data: {status: 'running'}});
    await db.automationRun.update({where: {id: run.id}, data: {status: 'running', cursor: failed.stepId, error: null, finishedAt: null}});
    // One retry job per failed step and minute (a double click queues it once).
    await queueRun(db, run.id, `retry-${failed.stepId}-${Math.floor(Date.now() / 60_000)}`);
    return c.json({ok: true});
  })

  .get('/:id', async (c) => {
    const a = await load(c);
    return c.json({automation: publicAutomation(a, adminOf(c)), problems: await problemsOf(c.var.db, a)});
  })

  .patch('/:id', requireRole('ADMIN'), valid('json', body), async (c) => {
    const db = c.var.db;
    const before = await load(c);
    const input = c.req.valid('json');
    const data = dataOf(input, c);
    if (before.enabled) await assertCanEnable(db, input);
    // A new date / inactivity rule starts counting from now, not from the old one's last check.
    const retimed = JSON.stringify(before.trigger) !== JSON.stringify(input.trigger);
    const a = await db.automation.update({where: {id: before.id}, data: {...data, ...(retimed && before.enabled ? {cursorAt: new Date()} : {})}});
    invalidateAutomationInterest();
    await audit(db, c, {action: 'automation.updated', entity: 'automation', recordId: a.id, label: a.name, meta: {trigger: retimed ? input.trigger : undefined, steps: flattenSteps(input.steps).length}});
    return c.json({automation: publicAutomation(a), problems: await problemsOf(db, a)});
  })

  .post('/:id/enable', requireRole('ADMIN'), valid('json', z.object({enabled: z.boolean()})), async (c) => {
    const db = c.var.db;
    const before = await load(c);
    const {enabled} = c.req.valid('json');
    if (enabled) await assertCanEnable(db, before);
    const now = new Date();
    const a = await db.automation.update({
      where: {id: before.id},
      // Switching on: date and inactivity triggers start from now (no backfill of the past).
      data: {enabled, ...(enabled && !before.enabled ? {enabledAt: now, cursorAt: now, failureStreak: 0} : {}), origin: publicOrigin(c.req.raw)},
    });
    invalidateAutomationInterest();
    await audit(db, c, {action: enabled ? 'automation.enabled' : 'automation.disabled', entity: 'automation', recordId: a.id, label: a.name});
    return c.json({automation: publicAutomation(a)});
  })

  .post('/:id/duplicate', requireRole('ADMIN'), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const src = await load(c);
    const copy = await db.automation.create({
      data: {
        name: `${src.name} (copy)`.slice(0, 120),
        description: src.description,
        object: src.object,
        triggerKind: src.triggerKind,
        triggerEvent: src.triggerEvent,
        trigger: src.trigger as Prisma.InputJsonValue,
        steps: src.steps as Prisma.InputJsonValue,
        reenroll: src.reenroll,
        reenrollDays: src.reenrollDays,
        activeFrom: src.activeFrom,
        activeUntil: src.activeUntil,
        timezone: src.timezone,
        origin: publicOrigin(c.req.raw),
        createdById: me.id,
      },
    });
    await audit(db, c, {action: 'automation.duplicated', entity: 'automation', recordId: copy.id, label: copy.name, meta: {from: src.id}});
    return c.json({automation: publicAutomation(copy)}, 201);
  })

  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const a = await load(c);
    await db.automation.delete({where: {id: a.id}});
    invalidateAutomationInterest();
    await audit(db, c, {action: 'automation.deleted', entity: 'automation', recordId: a.id, label: a.name});
    return c.json({ok: true});
  })

  /** Dry run on a record: the saved automation, or the builder's unsaved draft. Writes nothing. */
  .post('/:id/test', requireRole('ADMIN'), valid('json', z.object({recordId: id.nullish(), draft: body.optional()})), async (c) => {
    const db = c.var.db;
    const saved = await load(c);
    const {recordId, draft} = c.req.valid('json');
    const a = draft ? ({...saved, ...dataOf(draft, c), id: saved.id} as Automation) : saved;
    if (a.object !== 'none') {
      if (!recordId) throw new HTTPException(400, {message: 'Pick a record to test on'});
      if (!(await visibleRecord(c, a.object as AutoObject, recordId))) throw notFound('Record');
    }
    return c.json(await testAutomation(db, a, recordId ?? null));
  })

  /**
   * Test run of the editor's draft (saved or not, on or off). `quick` and
   * `timed` simulate (nothing happens; on a sample record unless one is
   * picked), `record` runs for real on the picked record. Progress: poll
   * GET /runs/:runId; stop: POST /runs/:runId/cancel.
   */
  .post('/:id/tests', requireRole('ADMIN'), valid('json', z.object({mode: z.enum(Object.keys(TEST_MODES) as [TestMode, ...TestMode[]]), recordId: id.nullish(), draft: body})), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const saved = await load(c);
    const {mode, recordId, draft} = c.req.valid('json');
    const a = withDraft(saved, draft, c);
    const object = a.object as AutoObject;
    let target: string | null = null;
    if (object !== 'none') {
      if (recordId) {
        if (!(await visibleRecord(c, object, recordId))) throw notFound('Record');
        target = recordId;
      } else if (mode === 'record') {
        throw new HTTPException(400, {message: `Pick the ${OBJECT_LABELS[object].label.toLowerCase()} to run it on`});
      } else {
        const sample = await sampleRecord(db, a, await recordScope(c, object));
        if (!sample) throw new HTTPException(400, {message: `There are no ${OBJECT_LABELS[object].plural} to test on yet`});
        target = sample.id;
      }
    }
    const {run, reason, conditions} = await startTestRun(db, a, {mode, recordId: target, userId: me.id});
    if (!run) throw new HTTPException(400, {message: reason ?? 'The test did not start'});
    // A test for real changes records, sends and calls: it goes in the audit log like a manual run.
    if (mode === 'record') await audit(db, c, {action: 'automation.test_started', entity: 'automation', recordId: a.id, label: a.name, meta: {mode, object, recordId: target, record: run.recordLabel, runId: run.id}});
    return c.json({run, conditions}, 201);
  })

  /** The latest test this person ran of this automation (the editor picks it up again while it goes on). */
  .get('/:id/tests/latest', requireRole('ADMIN'), async (c) => {
    const run = await c.var.db.automationRun.findFirst({where: {automationId: c.req.param('id'), startedById: currentUser(c).id, test: {not: null}}, orderBy: {startedAt: 'desc'}, select: {id: true, status: true, test: true, startedAt: true}});
    return c.json({run});
  })

  .post('/:id/run', valid('json', z.object({recordId: id})), async (c) => {
    const me = currentUser(c);
    const a = await load(c);
    const {recordId} = c.req.valid('json');
    if (a.triggerKind !== 'manual') throw new HTTPException(400, {message: 'Only manual automations can be started by hand'});
    if (!a.enabled) throw new HTTPException(400, {message: 'Switch the automation on first'});
    if (!(await visibleRecord(c, a.object as AutoObject, recordId))) throw notFound('Record');
    const {run, reason} = await runOnRecord(c.var.db, a, recordId, me.id);
    if (!run) throw new HTTPException(400, {message: reason ?? 'The automation did not start'});
    await audit(c.var.db, c, {action: 'automation.run_started', entity: 'automation', recordId: a.id, label: a.name, meta: {object: a.object, recordId}});
    return c.json({run}, 201);
  })

  .post('/:id/run-list', valid('json', z.object({listId: id})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const a = await load(c);
    const {listId} = c.req.valid('json');
    if (a.triggerKind !== 'manual') throw new HTTPException(400, {message: 'Only manual automations can be started by hand'});
    if (a.object !== 'contact') throw new HTTPException(400, {message: 'Lists hold contacts: this automation runs on another record type'});
    if (!a.enabled) throw new HTTPException(400, {message: 'Switch the automation on first'});
    const list = await db.contactList.findUnique({where: {id: listId}, select: {id: true, name: true}});
    if (!list) throw notFound('List');
    const batchId = await runOnList(db, a, list.id, me.id);
    await audit(db, c, {action: 'automation.run_started', entity: 'automation', recordId: a.id, label: a.name, meta: {listId: list.id, list: list.name}});
    return c.json({ok: true, batchId});
  })

  .get('/:id/runs', valid('query', runQuery), async (c) => {
    const db = c.var.db;
    const a = await load(c);
    const q = c.req.valid('query');
    const where: Prisma.AutomationRunWhereInput = {
      automationId: a.id,
      ...(q.status ? {status: q.status} : {}),
      ...(q.source ? {source: q.source} : {}),
      ...(q.days ? {startedAt: {gte: new Date(Date.now() - q.days * DAY)}} : {}),
      ...(q.q ? {recordLabel: {contains: q.q, mode: 'insensitive'}} : {}),
      AND: [await runScope(c)],
    };
    const [rows, total] = await Promise.all([
      db.automationRun.findMany({where, orderBy: {startedAt: 'desc'}, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: {_count: {select: {steps: true}}}}),
      db.automationRun.count({where}),
    ]);
    const admin = adminOf(c);
    return c.json({rows: rows.map((r) => maskRun(r, admin)), total, page: q.page, pageSize: q.pageSize});
  })

  /** The signing secret for webhook steps (created on first view). Admins only; audited. */
  .post('/:id/secret', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const a = await load(c);
    const secret = await automationSecret(db, a);
    await audit(db, c, {action: 'automation.secret_revealed', category: 'security', entity: 'automation', recordId: a.id, label: a.name, meta: {signingKey: await fingerprint(secret)}});
    return c.json({secret});
  });
