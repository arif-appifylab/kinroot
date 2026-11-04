import {Hono} from 'hono';
import {z} from 'zod';

import {Prisma} from '../../../generated/prisma/client';
import {currentUser, type AppEnv} from '../kit/guards';
import {intParam, ownerScope, shownLink, valid} from '../lib/http';
import {userSelect} from '../lib/users';
import {scopedDeal} from './deals';

export const dashboard = new Hono<AppEnv>().get(
  '/',
  valid('query', z.object({
    pipelineId: z.string().optional(),
    ownerId: z.string().optional(),
    days: intParam(7, 730).default(90),
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

    // Every number below is aggregated in Postgres (one statement), never whole deal sets in memory.
    const now = new Date();
    const at = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const inScope = Prisma.sql`d."pipelineId" = ${pipeline.id} ${scope.ownerId ? Prisma.sql`AND d."ownerId" = ${scope.ownerId as string}` : Prisma.empty}`;
    // Won / lost value per month for the last 6 months (month starts as the server reckons them, as before).
    const starts = Array.from({length: 7}, (_, i) => new Date(now.getFullYear(), now.getMonth() - 5 + i, 1));
    const monthRanges = Prisma.join(starts.slice(0, 6).map((s, i) => Prisma.sql`(${i}::int, ${at(s)}, ${at(starts[i + 1]!)})`));
    const rottingCutoff = new Date(Date.now() - pipeline.rottingDays * 86400_000);
    type Agg = {kind: 'stage' | 'closed' | 'month' | 'reach'; key: string; n: number; v: number; x: number | null};
    const stats = db.$queryRaw<Agg[]>`
      SELECT 'stage' AS kind, d."stageId" AS key, count(*)::int AS n, COALESCE(sum(d."value"), 0)::float8 AS v,
             (count(*) FILTER (WHERE d."lastActivityAt" < ${at(rottingCutoff)}))::float8 AS x
        FROM "Deal" d WHERE ${inScope} AND d."status" = 'OPEN' GROUP BY d."stageId"
      UNION ALL
      SELECT 'closed', d."status"::text, count(*)::int, COALESCE(sum(d."value"), 0)::float8,
             avg(EXTRACT(EPOCH FROM (d."closedAt" - d."createdAt")) / 86400)::float8
        FROM "Deal" d WHERE ${inScope} AND d."status" IN ('WON', 'LOST') AND d."closedAt" >= ${at(since)} GROUP BY d."status"
      UNION ALL
      SELECT 'month', m.i::text || ':' || d."status"::text, count(*)::int, COALESCE(sum(d."value"), 0)::float8, NULL::float8
        FROM (VALUES ${monthRanges}) AS m(i, s, e) JOIN "Deal" d ON d."closedAt" >= m.s AND d."closedAt" < m.e
        WHERE ${inScope} AND d."status" IN ('WON', 'LOST') GROUP BY m.i, d."status"
      UNION ALL
      SELECT 'reach', r.reach::text, count(*)::int, 0::float8, NULL::float8 FROM (
        SELECT CASE WHEN d."status" = 'WON' THEN 2147483647 ELSE COALESCE(max(st."position"), -1) END AS reach
          FROM "Deal" d
          LEFT JOIN "StageChange" sc ON sc."dealId" = d."id"
          LEFT JOIN "Stage" st ON st."id" = sc."toStageId"
         WHERE ${inScope} AND d."createdAt" >= ${at(since)}
         GROUP BY d."id", d."status"
      ) r GROUP BY r.reach`;

    const [aggs, lostReasons, closingSoon, myTasks] = await Promise.all([
      stats,
      db.deal.groupBy({by: ['lostReason'], where: {...scope, status: 'LOST', closedAt: {gte: since}}, _count: {_all: true}, _sum: {value: true}}),
      db.deal.findMany({
        where: {...scope, status: 'OPEN', expectedCloseDate: {not: null}},
        orderBy: {expectedCloseDate: 'asc'},
        take: 6,
        // The company's owner, so scopedDeal() hides another owner's company under owner-only visibility.
        include: {stage: true, company: {select: {id: true, name: true, ownerId: true}}, owner: {select: userSelect}},
      }),
      db.task.findMany({
        where: {assigneeId: me.id, done: false, dueAt: {lt: new Date(Date.now() + 86400_000)}},
        orderBy: {dueAt: 'asc'},
        take: 8,
        include: {contact: {select: {id: true, firstName: true, lastName: true, ownerId: true}}, deal: {select: {id: true, title: true, ownerId: true}}},
      }),
    ]);

    const of = (kind: Agg['kind']) => aggs.filter((a) => a.kind === kind);
    const stageRows = new Map(of('stage').map((a) => [a.key, a]));
    const byStage = pipeline.stages.map((s) => {
      const row = stageRows.get(s.id);
      const value = row?.v ?? 0;
      return {id: s.id, name: s.name, color: s.color, probability: s.probability, count: row?.n ?? 0, value, weighted: (value * s.probability) / 100};
    });
    const openRows = of('stage');

    const won = of('closed').find((a) => a.key === 'WON');
    const lost = of('closed').find((a) => a.key === 'LOST');
    const wonCount = won?.n ?? 0;
    const lostCount = lost?.n ?? 0;

    // Funnel: share of deals created in range that reached each stage (won deals count as reaching all).
    const reach = of('reach').map((a) => ({position: Number(a.key), n: a.n}));
    const created = reach.reduce((s, r) => s + r.n, 0);
    const funnel = pipeline.stages.map((s, i) => {
      const reached = i === 0 ? created : reach.filter((r) => r.position >= s.position).reduce((sum, r) => sum + r.n, 0);
      return {id: s.id, name: s.name, reached, rate: created ? reached / created : 0};
    });

    const monthValue = new Map(of('month').map((a) => [a.key, a.v]));
    const months = starts.slice(0, 6).map((start, i) => ({
      month: start.toISOString().slice(0, 7),
      won: monthValue.get(`${i}:WON`) ?? 0,
      lost: monthValue.get(`${i}:LOST`) ?? 0,
    }));

    return c.json({
      pipeline: {id: pipeline.id, name: pipeline.name, rottingDays: pipeline.rottingDays},
      totals: {
        openCount: openRows.reduce((s, a) => s + a.n, 0),
        openValue: openRows.reduce((s, a) => s + a.v, 0),
        weighted: byStage.reduce((s, st) => s + st.weighted, 0),
        wonCount,
        wonValue: won?.v ?? 0,
        lostCount,
        lostValue: lost?.v ?? 0,
        winRate: wonCount + lostCount ? wonCount / (wonCount + lostCount) : null,
        avgCycleDays: wonCount ? (won?.x ?? null) : null,
        avgDealSize: wonCount ? (won?.v ?? 0) / wonCount : null,
        rotting: openRows.reduce((s, a) => s + (a.x ?? 0), 0),
      },
      byStage,
      funnel,
      months,
      lostReasons: lostReasons.map((r) => ({reason: r.lostReason ?? 'Unspecified', count: r._count._all, value: r._sum.value ?? 0})),
      closingSoon: closingSoon.map((d) => scopedDeal(d, visible)),
      // A task of mine can sit on someone else's record: that record shows as none (AUDIT-2 L-2).
      myTasks: myTasks.map((t) => ({...t, contact: shownLink(t.contact, visible), deal: shownLink(t.deal, visible)})),
    });
  },
);
