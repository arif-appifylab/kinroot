import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {requireRole, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {notFound, valid} from '../lib/http';

const stageInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  probability: z.coerce.number().int().min(0).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

const pipelineInput = z.object({
  name: z.string().trim().min(1).max(80),
  rottingDays: z.coerce.number().int().min(1).max(365).optional(),
  isDefault: z.boolean().optional(),
  stages: z.array(stageInput).min(1).max(20).optional(),
});

export const pipelines = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await c.var.db.pipeline.findMany({
      orderBy: [{position: 'asc'}, {createdAt: 'asc'}],
      include: {stages: {orderBy: {position: 'asc'}}, _count: {select: {deals: {where: {status: 'OPEN'}}}}},
    });
    return c.json({rows});
  })

  .post('/', requireRole('ADMIN'), valid('json', pipelineInput), async (c) => {
    const db = c.var.db;
    const {stages, ...body} = c.req.valid('json');
    if (body.isDefault) await db.pipeline.updateMany({data: {isDefault: false}});
    const count = await db.pipeline.count();
    const pipeline = await db.pipeline.create({
      data: {
        ...body,
        isDefault: body.isDefault ?? count === 0,
        position: count,
        stages: {
          create: (stages ?? [{name: 'New', probability: 10}, {name: 'In progress', probability: 50}, {name: 'Closing', probability: 80}]).map((s, i) => ({
            name: s.name,
            probability: s.probability,
            color: s.color,
            position: i,
          })),
        },
      },
      include: {stages: {orderBy: {position: 'asc'}}},
    });
    await audit(db, c, {action: 'pipeline.created', entity: 'pipeline', recordId: pipeline.id, label: pipeline.name, meta: {stages: pipeline.stages.map((s) => s.name)}});
    return c.json({pipeline}, 201);
  })

  // Update name/settings and replace the stage list (keeps ids that are passed back).
  .put('/:id', requireRole('ADMIN'), valid('json', pipelineInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const existing = await db.pipeline.findUnique({where: {id}, include: {stages: true}});
    if (!existing) throw notFound('Pipeline');
    const {stages, ...body} = c.req.valid('json');
    if (body.isDefault) await db.pipeline.updateMany({where: {id: {not: id}}, data: {isDefault: false}});
    await db.pipeline.update({where: {id}, data: body});

    if (stages) {
      const keep = new Set(stages.filter((s) => s.id).map((s) => s.id));
      const removed = existing.stages.filter((s) => !keep.has(s.id));
      if (removed.length) {
        const inUse = await db.deal.count({where: {stageId: {in: removed.map((s) => s.id)}}});
        if (inUse) throw new HTTPException(400, {message: `Move the ${inUse} deal(s) out of the removed stage(s) first`});
        await db.stage.deleteMany({where: {id: {in: removed.map((s) => s.id)}}});
      }
      for (const [position, s] of stages.entries()) {
        if (s.id && existing.stages.some((e) => e.id === s.id)) {
          await db.stage.update({where: {id: s.id}, data: {name: s.name, probability: s.probability, color: s.color, position}});
        } else {
          await db.stage.create({data: {pipelineId: id, name: s.name, probability: s.probability, color: s.color, position}});
        }
      }
    }
    const pipeline = await db.pipeline.findUnique({where: {id}, include: {stages: {orderBy: {position: 'asc'}}}});
    await audit(db, c, {action: 'pipeline.updated', entity: 'pipeline', recordId: id, label: pipeline?.name, meta: {...body, ...(stages ? {stages: pipeline?.stages.map((s) => s.name), removedStages: existing.stages.filter((s) => !stages.some((n) => n.id === s.id)).map((s) => s.name)} : {})}});
    return c.json({pipeline});
  })

  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    if ((await db.pipeline.count()) <= 1) throw new HTTPException(400, {message: 'You need at least one pipeline'});
    const deals = await db.deal.count({where: {pipelineId: id}});
    if (deals) throw new HTTPException(400, {message: `This pipeline still has ${deals} deal(s)`});
    const removed = await db.pipeline.delete({where: {id}});
    await audit(db, c, {action: 'pipeline.deleted', entity: 'pipeline', recordId: id, label: removed.name});
    if (removed.isDefault) {
      const next = await db.pipeline.findFirst({orderBy: {position: 'asc'}});
      if (next) await db.pipeline.update({where: {id: next.id}, data: {isDefault: true}});
    }
    return c.json({ok: true});
  });
