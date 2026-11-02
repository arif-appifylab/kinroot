import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {currentUser, type AppEnv} from '../kit/guards';
import {customDiff, diff, logActivity} from '../lib/activity';
import {audit, auditMany} from '../lib/audit';
import {cleanCustom} from '../lib/custom-fields';
import {emit} from '../lib/events';
import {custom, isoDate, notFound, optStr, ownerScope, sortBy, tags, valid} from '../lib/http';
import {notify, notifyWatchers, recordLink} from '../lib/notify';
import {moveToBin} from '../lib/recycle-bin';
import {rememberOption} from '../lib/settings';
import {userSelect} from '../lib/users';

export const dealBody = z.object({
  title: z.string().trim().min(1, 'is required').max(200),
  value: z.coerce.number().min(0).max(1e12).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  companyId: z.string().nullish(),
  /** All companies on the deal; the first one (or companyId) is primary. */
  companyIds: z.array(z.string()).max(20).optional(),
  type: optStr,
  priority: optStr,
  ownerId: z.string().nullish(),
  expectedCloseDate: isoDate,
  tags: tags.optional(),
  custom: custom.optional(),
  contactIds: z.array(z.string()).max(50).optional(),
});

export const dealInclude = {
  stage: true,
  pipeline: {select: {id: true, name: true, rottingDays: true}},
  owner: {select: userSelect},
  company: {select: {id: true, name: true, domain: true}},
  companies: {include: {company: {select: {id: true, name: true, domain: true, phone: true, industry: true}}}, orderBy: {isPrimary: 'desc'}},
  contacts: {include: {contact: {select: {id: true, firstName: true, lastName: true, email: true, title: true, phone: true, score: true}}}},
  _count: {select: {tasks: {where: {done: false}}}},
} satisfies Prisma.DealInclude;

/** Next open task per deal, for the "no next step" warning on board cards. */
async function withNextTask<T extends {id: string}>(db: Db, deals: T[]) {
  if (!deals.length) return [];
  const tasks = await db.task.findMany({
    where: {dealId: {in: deals.map((d) => d.id)}, done: false},
    orderBy: [{dueAt: {sort: 'asc', nulls: 'last'}}],
    select: {id: true, title: true, dueAt: true, type: true, dealId: true},
  });
  const next = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) if (t.dealId && !next.has(t.dealId)) next.set(t.dealId, t);
  return deals.map((d) => ({...d, nextTask: next.get(d.id) ?? null}));
}

/** Replace a deal's company links; keeps Deal.companyId pointing at the primary. */
/** History row, timeline entry, event and notification for a stage move. */
async function stageMoved(db: Db, me: {id: string; name: string}, deal: {id: string; title: string}, from: {id: string; name: string}, to: {id: string; name: string}) {
  await db.stageChange.create({data: {dealId: deal.id, fromStageId: from.id, toStageId: to.id, userId: me.id}});
  await logActivity(db, {type: 'stage_changed', title: `Moved from ${from.name} to ${to.name}`, actorId: me.id, dealId: deal.id, data: {from: from.name, to: to.name}});
  await emit(db, 'deal.stage_changed', {recordId: deal.id, actorId: me.id, data: {deal, from, to}});
  await notifyWatchers(db, {dealId: deal.id}, {type: 'stage_changed', title: `${me.name} moved ${deal.title} to ${to.name}`, actorId: me.id});
}

async function setDealCompanies(db: Db, dealId: string, ids: string[], primaryId?: string | null) {
  const unique = [...new Set(ids)];
  const primary = primaryId && unique.includes(primaryId) ? primaryId : unique[0] ?? null;
  await db.dealCompany.deleteMany({where: {dealId}});
  if (unique.length) await db.dealCompany.createMany({data: unique.map((companyId) => ({dealId, companyId, isPrimary: companyId === primary}))});
  await db.deal.update({where: {id: dealId}, data: {companyId: primary}});
}

export async function defaultPipeline(db: Db, pipelineId?: string) {
  const pipeline = await db.pipeline.findFirst({
    where: pipelineId ? {id: pipelineId} : {},
    orderBy: [{isDefault: 'desc'}, {position: 'asc'}],
    include: {stages: {orderBy: {position: 'asc'}}},
  });
  if (!pipeline || !pipeline.stages.length) throw new HTTPException(400, {message: 'Create a pipeline with at least one stage first'});
  return pipeline;
}

export const dealListQuery = z.object({
  pipelineId: z.string().optional(),
  status: z.enum(['OPEN', 'WON', 'LOST', 'CLOSED', 'ALL']).default('OPEN'),
  closeDate: z.enum(['overdue', 'this_month', 'next_month', 'this_quarter', 'none']).optional(),
  createdDays: z.coerce.number().int().min(1).max(3650).optional(),
  closedDays: z.coerce.number().int().min(1).max(3650).optional(),
  ownerId: z.string().optional(),
  stageId: z.string().optional(),
  companyId: z.string().optional(),
  q: z.string().optional(),
  tag: z.string().optional(),
  rotting: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  take: z.coerce.number().int().min(1).max(1000).default(500),
});

/** The deals list's filters as a where (exports use it too). `rotting` is applied after loading. */
export function dealWhere(q: Partial<z.infer<typeof dealListQuery>>): Prisma.DealWhereInput {
  const where: Prisma.DealWhereInput = {};
  if (q.pipelineId) where.pipelineId = q.pipelineId;
  if (q.status === 'CLOSED') where.status = {in: ['WON', 'LOST']};
  else if (q.status && q.status !== 'ALL') where.status = q.status;
  const now = new Date();
  if (q.closeDate === 'overdue') where.expectedCloseDate = {lt: now};
  if (q.closeDate === 'none') where.expectedCloseDate = null;
  if (q.closeDate === 'this_month') where.expectedCloseDate = {gte: new Date(now.getFullYear(), now.getMonth(), 1), lt: new Date(now.getFullYear(), now.getMonth() + 1, 1)};
  if (q.closeDate === 'next_month') where.expectedCloseDate = {gte: new Date(now.getFullYear(), now.getMonth() + 1, 1), lt: new Date(now.getFullYear(), now.getMonth() + 2, 1)};
  if (q.closeDate === 'this_quarter') {
    const qs = Math.floor(now.getMonth() / 3) * 3;
    where.expectedCloseDate = {gte: new Date(now.getFullYear(), qs, 1), lt: new Date(now.getFullYear(), qs + 3, 1)};
  }
  if (q.createdDays) where.createdAt = {gte: new Date(Date.now() - q.createdDays * 86400_000)};
  if (q.closedDays) where.closedAt = {gte: new Date(Date.now() - q.closedDays * 86400_000)};
  if (q.ownerId) where.ownerId = q.ownerId === 'none' ? null : q.ownerId;
  if (q.stageId) where.stageId = q.stageId;
  if (q.companyId) where.companies = {some: {companyId: q.companyId}};
  if (q.tag) where.tags = {has: q.tag};
  if (q.q) where.OR = [{title: {contains: q.q, mode: 'insensitive'}}, {company: {name: {contains: q.q, mode: 'insensitive'}}}];
  return where;
}

export const deals = new Hono<AppEnv>()
  .get('/', valid('query', dealListQuery), async (c) => {
    const q = c.req.valid('query');
    const where: Prisma.DealWhereInput = {...dealWhere(q), ...(await ownerScope(c))};
    const rows = await c.var.db.deal.findMany({
      where,
      include: dealInclude,
      orderBy: q.sort ? sortBy(q.sort, q.dir, ['title', 'value', 'expectedCloseDate', 'createdAt', 'lastActivityAt'], 'createdAt') : [{position: 'asc'}, {createdAt: 'desc'}],
      take: q.take,
    });
    let result = await withNextTask(c.var.db, rows);
    if (q.rotting === '1') {
      result = result.filter((d) => Date.now() - new Date(d.lastActivityAt).getTime() > d.pipeline.rottingDays * 86400_000);
    }
    return c.json({rows: result});
  })

  .post('/', valid('json', dealBody), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {contactIds, companyIds, custom: customInput, ...body} = c.req.valid('json');
    const pipeline = await defaultPipeline(db, body.pipelineId);
    const stageId = body.stageId && pipeline.stages.some((s) => s.id === body.stageId) ? body.stageId : pipeline.stages[0]!.id;
    const first = await db.deal.findFirst({where: {stageId, status: 'OPEN'}, orderBy: {position: 'asc'}, select: {position: true}});
    const deal = await db.deal.create({
      data: {
        ...body,
        pipelineId: pipeline.id,
        stageId,
        position: (first?.position ?? 1) - 1, // new deals land on top of the column
        ownerId: body.ownerId === undefined ? me.id : body.ownerId,
        custom: ((await cleanCustom(db, 'DEAL', customInput)) ?? {}) as Prisma.InputJsonValue,
        companyId: body.companyId ?? companyIds?.[0] ?? null,
        contacts: contactIds?.length ? {create: contactIds.map((contactId) => ({contactId}))} : undefined,
      },
      include: dealInclude,
    });
    const allCompanies = [...(deal.companyId ? [deal.companyId] : []), ...(companyIds ?? [])];
    if (allCompanies.length) await setDealCompanies(db, deal.id, allCompanies, deal.companyId);
    await db.stageChange.create({data: {dealId: deal.id, toStageId: stageId, userId: me.id}});
    await logActivity(db, {
      type: 'deal_created',
      title: `Deal created: ${deal.title}`,
      actorId: me.id,
      dealId: deal.id,
      companyId: deal.companyId,
      contactId: contactIds?.[0],
    });
    await emit(db, 'deal.created', {recordId: deal.id, actorId: me.id, data: deal});
    await audit(db, c, {action: 'deal.created', entity: 'deal', recordId: deal.id, label: deal.title});
    await notify(db, [deal.ownerId], {type: 'assigned', title: `${me.name} assigned you a deal: ${deal.title}`, link: recordLink.deal(deal.id), actorId: me.id});
    return c.json({deal}, 201);
  })

  .get('/:id', async (c) => {
    const deal = await c.var.db.deal.findFirst({
      where: {id: c.req.param('id'), ...(await ownerScope(c))},
      include: {
        ...dealInclude,
        pipeline: {include: {stages: {orderBy: {position: 'asc'}}}},
        stageChanges: {orderBy: {createdAt: 'asc'}, include: {toStage: true, user: {select: userSelect}}},
      },
    });
    if (!deal) throw notFound('Deal');
    return c.json({deal});
  })

  .patch('/:id', valid('json', dealBody.partial()), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const before = await db.deal.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}, include: {stage: true}});
    if (!before) throw notFound('Deal');
    const {contactIds, companyIds, custom: customInput, stageId, pipelineId, ...body} = c.req.valid('json');

    const data: Prisma.DealUncheckedUpdateInput = {...body, custom: (await cleanCustom(db, 'DEAL', customInput, before.custom)) as Prisma.InputJsonValue | undefined};
    if (pipelineId && pipelineId !== before.pipelineId) {
      const pipeline = await defaultPipeline(db, pipelineId);
      data.pipelineId = pipeline.id;
      data.stageId = stageId && pipeline.stages.some((s) => s.id === stageId) ? stageId : pipeline.stages[0]!.id;
    } else if (stageId) {
      data.stageId = stageId;
    }
    if (data.stageId && data.stageId !== before.stageId) data.stageEnteredAt = new Date();
    if (contactIds) {
      await db.dealContact.deleteMany({where: {dealId: before.id}});
      if (contactIds.length) await db.dealContact.createMany({data: contactIds.map((contactId) => ({dealId: before.id, contactId}))});
    }
    await db.deal.update({where: {id: before.id}, data});
    if (companyIds) {
      await setDealCompanies(db, before.id, body.companyId ? [body.companyId, ...companyIds] : companyIds, body.companyId);
    } else if (body.companyId !== undefined) {
      // Changing the primary company keeps the other linked companies.
      const links = await db.dealCompany.findMany({where: {dealId: before.id}, select: {companyId: true}});
      const rest = links.map((l) => l.companyId).filter((id) => id !== before.companyId);
      await setDealCompanies(db, before.id, body.companyId ? [body.companyId, ...rest] : rest, body.companyId);
    }
    const deal = await db.deal.findUniqueOrThrow({where: {id: before.id}, include: dealInclude});

    if (data.stageId && data.stageId !== before.stageId) await stageMoved(db, me, deal, before.stage, deal.stage);
    // Custom field edits count as changes too ("field changed" automations, timeline, audit).
    const changes = [...diff(before, body), ...(customInput ? customDiff(before.custom, deal.custom) : []), ...diff(before, {pipelineId: deal.pipelineId})];
    if (changes.length) {
      await logActivity(db, {type: 'field_changed', title: 'Deal updated', actorId: me.id, dealId: deal.id, data: {changes} as Prisma.InputJsonValue});
      await emit(db, 'deal.updated', {recordId: deal.id, actorId: me.id, data: {...deal, changes}});
      await audit(db, c, {action: 'deal.updated', entity: 'deal', recordId: deal.id, label: deal.title, meta: {changes}});
    }
    if (data.stageId && data.stageId !== before.stageId) await audit(db, c, {action: 'deal.stage_changed', entity: 'deal', recordId: deal.id, label: deal.title, meta: {from: before.stage.name, to: deal.stage.name}});
    if (deal.ownerId !== before.ownerId) {
      await notify(db, [deal.ownerId], {type: 'assigned', title: `${me.name} assigned you a deal: ${deal.title}`, link: recordLink.deal(deal.id), actorId: me.id});
    }
    return c.json({deal});
  })

  // Kanban drop: new stage + position between neighbours (fractional ordering).
  .post('/:id/move', valid('json', z.object({stageId: z.string(), beforeId: z.string().nullish(), afterId: z.string().nullish()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {stageId, beforeId, afterId} = c.req.valid('json');
    const deal = await db.deal.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}, include: {stage: true}});
    if (!deal) throw notFound('Deal');
    const stage = await db.stage.findUnique({where: {id: stageId}});
    if (!stage || stage.pipelineId !== deal.pipelineId) throw new HTTPException(400, {message: 'Stage is not in this pipeline'});

    const [prev, next] = await Promise.all([
      afterId ? db.deal.findUnique({where: {id: afterId}, select: {position: true}}) : null,
      beforeId ? db.deal.findUnique({where: {id: beforeId}, select: {position: true}}) : null,
    ]);
    const position =
      prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1 : next ? next.position - 1 : 0;

    const moved = stageId !== deal.stageId;
    const updated = await db.deal.update({
      where: {id: deal.id},
      data: {stageId, position, ...(moved ? {stageEnteredAt: new Date(), lastActivityAt: new Date()} : {})},
      include: dealInclude,
    });
    if (moved) await stageMoved(db, me, updated, deal.stage, stage);
    if (moved) await audit(db, c, {action: 'deal.stage_changed', entity: 'deal', recordId: deal.id, label: deal.title, meta: {from: deal.stage.name, to: stage.name}});
    return c.json({deal: updated});
  })

  .post('/:id/status', valid('json', z.object({status: z.enum(['OPEN', 'WON', 'LOST']), lostReason: optStr})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {status, lostReason} = c.req.valid('json');
    const before = await db.deal.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!before) throw notFound('Deal');
    if (status === 'LOST' && !lostReason) throw new HTTPException(400, {message: 'Pick a reason for losing this deal'});
    if (status === 'LOST') await rememberOption(db, 'lostReasons', lostReason);
    const deal = await db.deal.update({
      where: {id: before.id},
      data: {status, lostReason: status === 'LOST' ? lostReason : null, closedAt: status === 'OPEN' ? null : new Date()},
      include: dealInclude,
    });
    await audit(db, c, {action: 'deal.status_changed', entity: 'deal', recordId: deal.id, label: deal.title, meta: {from: before.status, to: status, lostReason: status === 'LOST' ? lostReason : undefined}});
    const title = status === 'WON' ? `Deal won 🎉 ${deal.title}` : status === 'LOST' ? `Deal lost: ${lostReason}` : 'Deal reopened';
    await logActivity(db, {type: status === 'WON' ? 'deal_won' : status === 'LOST' ? 'deal_lost' : 'deal_reopened', title, actorId: me.id, dealId: deal.id, companyId: deal.companyId, data: {value: deal.value}});
    if (status !== 'OPEN') {
      await emit(db, status === 'WON' ? 'deal.won' : 'deal.lost', {recordId: deal.id, actorId: me.id, data: deal});
      await notifyWatchers(db, {dealId: deal.id}, {
        type: status === 'WON' ? 'deal_won' : 'deal_lost',
        title: status === 'WON' ? `${me.name} won ${deal.title} 🎉` : `${me.name} marked ${deal.title} as lost`,
        body: status === 'LOST' ? lostReason : null,
        actorId: me.id,
      });
    }
    if (status === 'WON') {
      const contactIds = deal.contacts.map((l) => l.contactId);
      const promoted = await db.contact.findMany({where: {id: {in: contactIds}, lifecycleStage: {not: 'CUSTOMER'}}, select: {id: true, firstName: true, lastName: true, lifecycleStage: true}});
      if (promoted.length) {
        await db.contact.updateMany({where: {id: {in: promoted.map((p) => p.id)}}, data: {lifecycleStage: 'CUSTOMER'}});
        await auditMany(db, c, promoted.map((p) => ({action: 'contact.updated', entity: 'contact', recordId: p.id, label: [p.firstName, p.lastName].filter(Boolean).join(' '), meta: {changes: [{field: 'lifecycleStage', from: p.lifecycleStage, to: 'CUSTOMER'}], reason: `Deal won: ${deal.title}`}})));
      }
    }
    return c.json({deal});
  })

  .delete('/:id', async (c) => {
    const found = await c.var.db.deal.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!found) throw notFound('Deal');
    const me = currentUser(c);
    const [bin] = await moveToBin(c.var.db, 'deal', [found.id], me);
    await emit(c.var.db, 'deal.deleted', {recordId: found.id, actorId: me.id, data: found});
    await audit(c.var.db, c, {action: 'deal.deleted', entity: 'deal', recordId: found.id, label: found.title});
    return c.json({ok: true, binId: bin?.id ?? null});
  });
