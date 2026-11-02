import {Hono} from 'hono';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {currentUser, type AppEnv} from '../kit/guards';
import {ownerScope, valid} from '../lib/http';
import {userSelect} from '../lib/users';

export const dashboard = new Hono<AppEnv>().get(
  '/',
  valid('query', z.object({
    pipelineId: z.string().optional(),
    ownerId: z.string().optional(),
    days: z.coerce.number().int().min(7).max(730).default(90),
  })),
  async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const q = c.req.valid('query');
    const since = new Date(Date.now() - q.days * 86400_000);

    const pipeline = await db.pipeline.findFirst({
      where: q.pipelineId ? {id: q.pipelineId} : {},
      orderBy: [{isDefault: 'desc'}, {position: 'asc'}],
      include: {stages: {orderBy: {position: 'asc'}}},
    });
    if (!pipeline) return c.json({empty: true});

    const visible = await ownerScope(c);
    const scope: Prisma.DealWhereInput = {pipelineId: pipeline.id, ...visible};
    // The owner filter may narrow what someone sees, never widen it.
    if (q.ownerId && !visible.ownerId) scope.ownerId = q.ownerId;

    const [open, closed, created, lostReasons, closingSoon, myTasks] = await Promise.all([
      db.deal.findMany({where: {...scope, status: 'OPEN'}, select: {id: true, value: true, stageId: true, lastActivityAt: true}}),
      db.deal.findMany({where: {...scope, status: {in: ['WON', 'LOST']}, closedAt: {gte: since}}, select: {value: true, status: true, createdAt: true, closedAt: true}}),
      db.deal.findMany({
        where: {...scope, createdAt: {gte: since}},
        select: {id: true, status: true, stageChanges: {select: {toStage: {select: {position: true}}}}},
      }),
      db.deal.groupBy({by: ['lostReason'], where: {...scope, status: 'LOST', closedAt: {gte: since}}, _count: {_all: true}, _sum: {value: true}}),
      db.deal.findMany({
        where: {...scope, status: 'OPEN', expectedCloseDate: {not: null}},
        orderBy: {expectedCloseDate: 'asc'},
        take: 6,
        include: {stage: true, company: {select: {id: true, name: true}}, owner: {select: userSelect}},
      }),
      db.task.findMany({
        where: {assigneeId: me.id, done: false, dueAt: {lt: new Date(Date.now() + 86400_000)}},
        orderBy: {dueAt: 'asc'},
        take: 8,
        include: {contact: {select: {id: true, firstName: true, lastName: true}}, deal: {select: {id: true, title: true}}},
      }),
    ]);

    const byStage = pipeline.stages.map((s) => {
      const deals = open.filter((d) => d.stageId === s.id);
      const value = deals.reduce((sum, d) => sum + d.value, 0);
      return {id: s.id, name: s.name, color: s.color, probability: s.probability, count: deals.length, value, weighted: (value * s.probability) / 100};
    });

    const won = closed.filter((d) => d.status === 'WON');
    const lost = closed.filter((d) => d.status === 'LOST');
    const cycle = won.length
      ? won.reduce((sum, d) => sum + (d.closedAt!.getTime() - d.createdAt.getTime()), 0) / won.length / 86400_000
      : null;

    // Funnel: share of deals created in range that reached each stage (won deals count as reaching all).
    const funnel = pipeline.stages.map((s, i) => {
      const reached = created.filter((d) => i === 0 || d.status === 'WON' || d.stageChanges.some((ch) => (ch.toStage?.position ?? -1) >= s.position)).length;
      return {id: s.id, name: s.name, reached, rate: created.length ? reached / created.length : 0};
    });

    // Won value per month for the last 6 months.
    const months: {month: string; won: number; lost: number}[] = [];
    const now = new Date();
    const history = await db.deal.findMany({
      where: {...scope, status: {in: ['WON', 'LOST']}, closedAt: {gte: new Date(now.getFullYear(), now.getMonth() - 5, 1)}},
      select: {value: true, status: true, closedAt: true},
    });
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const inMonth = history.filter((d) => d.closedAt! >= start && d.closedAt! < end);
      months.push({
        month: start.toISOString().slice(0, 7),
        won: inMonth.filter((d) => d.status === 'WON').reduce((s, d) => s + d.value, 0),
        lost: inMonth.filter((d) => d.status === 'LOST').reduce((s, d) => s + d.value, 0),
      });
    }

    const rottingCutoff = Date.now() - pipeline.rottingDays * 86400_000;

    return c.json({
      pipeline: {id: pipeline.id, name: pipeline.name, rottingDays: pipeline.rottingDays},
      totals: {
        openCount: open.length,
        openValue: open.reduce((s, d) => s + d.value, 0),
        weighted: byStage.reduce((s, st) => s + st.weighted, 0),
        wonCount: won.length,
        wonValue: won.reduce((s, d) => s + d.value, 0),
        lostCount: lost.length,
        lostValue: lost.reduce((s, d) => s + d.value, 0),
        winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
        avgCycleDays: cycle,
        avgDealSize: won.length ? won.reduce((s, d) => s + d.value, 0) / won.length : null,
        rotting: open.filter((d) => d.lastActivityAt.getTime() < rottingCutoff).length,
      },
      byStage,
      funnel,
      months,
      lostReasons: lostReasons.map((r) => ({reason: r.lostReason ?? 'Unspecified', count: r._count._all, value: r._sum.value ?? 0})),
      closingSoon,
      myTasks,
    });
  },
);
