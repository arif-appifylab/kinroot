import {Hono} from 'hono';
import {z} from 'zod';

import type {Goal, Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {currentUser, requireRole, type AppEnv} from '../kit/guards';
import {ACTIVITY_KINDS, GOAL_METRICS, type GoalMetric} from '@/lib/reports';
import {intParam, isoDate, notFound, ownerScope, valid} from '../lib/http';
import {periodSpan, safeTz} from '../lib/periods';
import {userSelect} from '../lib/users';

const metric = z.enum(Object.keys(GOAL_METRICS) as [GoalMetric, ...GoalMetric[]]);
const kind = z.enum(Object.keys(ACTIVITY_KINDS) as ['CALL', 'MEETING', 'EMAIL']);

const goalBody = z.object({
  metric,
  period: z.enum(['MONTH', 'QUARTER']),
  target: z.coerce.number().positive('must be above 0').max(1e12),
  userId: z.string().nullable(),
  kinds: z.array(kind).max(3).default([]),
  startsAt: isoDate,
  endsAt: isoDate,
});

type Span = {from: Date; to: Date};

/** Actual value per user (and for the whole team under the key "team") in one period. */
async function actuals(db: Db, m: GoalMetric, kinds: string[], span: Span) {
  const out = new Map<string, number>();
  const add = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
  if (m === 'won_revenue' || m === 'deals_won') {
    const rows = await db.deal.groupBy({by: ['ownerId'], where: {status: 'WON', closedAt: {gte: span.from, lt: span.to}}, _sum: {value: true}, _count: {_all: true}});
    for (const r of rows) {
      const v = m === 'won_revenue' ? (r._sum.value ?? 0) : r._count._all;
      if (r.ownerId) add(r.ownerId, v);
      add('team', v);
    }
    return out;
  }
  // Activities that already happened: logged calls / meetings / emails, plus emails sent from the CRM.
  const want = kinds.length ? kinds : Object.keys(ACTIVITY_KINDS);
  const until = new Date(Math.min(span.to.getTime(), Date.now()));
  const [logged, sent] = await Promise.all([
    db.interaction.groupBy({by: ['authorId'], where: {kind: {in: want as never[]}, occurredAt: {gte: span.from, lt: until}}, _count: {_all: true}}),
    want.includes('EMAIL')
      ? db.emailMessage.groupBy({by: ['senderId'], where: {direction: 'OUTBOUND', status: 'SENT', sentAt: {gte: span.from, lt: until}}, _count: {_all: true}})
      : Promise.resolve([]),
  ]);
  for (const r of logged) {
    if (r.authorId) add(r.authorId, r._count._all);
    add('team', r._count._all);
  }
  for (const r of sent as {senderId: string | null; _count: {_all: number}}[]) {
    if (r.senderId) add(r.senderId, r._count._all);
    add('team', r._count._all);
  }
  return out;
}

export type GoalStatus = 'achieved' | 'on_track' | 'behind' | 'missed';

async function progress(db: Db, goals: (Goal & {user: unknown})[], tz: string, offset: number) {
  const now = Date.now();
  const cache = new Map<string, Promise<Map<string, number>>>();
  return Promise.all(
    goals.map(async (g) => {
      const p = periodSpan(g.period === 'QUARTER' ? 'QUARTER' : 'MONTH', tz, offset);
      const key = `${g.metric}|${[...g.kinds].sort().join(',')}|${p.key}|${g.period}`;
      if (!cache.has(key)) cache.set(key, actuals(db, g.metric as GoalMetric, g.kinds, p));
      const actual = (await cache.get(key)!).get(g.userId ?? 'team') ?? 0;
      const length = p.to.getTime() - p.from.getTime();
      const elapsed = Math.min(1, Math.max(0, (now - p.from.getTime()) / length));
      const expected = g.target * elapsed;
      const status: GoalStatus = actual >= g.target ? 'achieved' : elapsed >= 1 ? 'missed' : actual >= expected ? 'on_track' : 'behind';
      return {
        goal: g,
        period: {label: p.label, from: p.from, to: p.to},
        actual,
        expected,
        elapsed,
        // Straight-line projection to the end of the period.
        projected: elapsed > 0.05 ? actual / elapsed : null,
        status,
      };
    }),
  );
}

export const goals = new Hono<AppEnv>()
  /** Goals in effect for the period, with progress. Members with owner-only visibility see just their own. */
  .get('/', valid('query', z.object({tz: z.string().max(64).optional(), offset: intParam(-12, 1).default(0), userId: z.string().optional(), mine: z.string().optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const q = c.req.valid('query');
    const tz = safeTz(q.tz);
    const scope = await ownerScope(c);
    const month = periodSpan('MONTH', tz, q.offset);
    const and: Prisma.GoalWhereInput[] = [{startsAt: {lt: periodSpan('QUARTER', tz, q.offset).to}}, {OR: [{endsAt: null}, {endsAt: {gte: month.from}}]}];
    if (scope.ownerId) and.push({userId: me.id});
    else if (q.mine) and.push({OR: [{userId: me.id}, {userId: null}]});
    else if (q.userId) and.push({userId: q.userId === 'team' ? null : q.userId});
    const found = await db.goal.findMany({where: {AND: and}, include: {user: {select: userSelect}}, orderBy: [{metric: 'asc'}, {createdAt: 'asc'}]});
    // A goal starting later in the quarter is not in effect for this month yet.
    const rows = found.filter((g) => g.startsAt < periodSpan(g.period === 'QUARTER' ? 'QUARTER' : 'MONTH', tz, q.offset).to);
    // Team goals first, then people by name.
    rows.sort((a, b) => (a.userId === null ? -1 : 0) - (b.userId === null ? -1 : 0) || (a.user?.name ?? '').localeCompare(b.user?.name ?? ''));
    return c.json({rows: await progress(db, rows, tz, q.offset)});
  })

  .post('/', requireRole('ADMIN'), valid('json', goalBody), async (c) => {
    const {startsAt, endsAt, ...body} = c.req.valid('json');
    const goal = await c.var.db.goal.create({data: {...body, kinds: body.metric === 'activities' ? body.kinds : [], startsAt: startsAt ?? new Date(0), endsAt: endsAt ?? null}});
    return c.json({goal}, 201);
  })

  .patch('/:id', requireRole('ADMIN'), valid('json', goalBody.partial()), async (c) => {
    const found = await c.var.db.goal.findUnique({where: {id: c.req.param('id')}});
    if (!found) throw notFound('Goal');
    const {startsAt, endsAt, ...body} = c.req.valid('json');
    const goal = await c.var.db.goal.update({where: {id: found.id}, data: {...body, startsAt: startsAt ?? undefined, endsAt}});
    return c.json({goal});
  })

  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const found = await c.var.db.goal.findUnique({where: {id: c.req.param('id')}});
    if (!found) throw notFound('Goal');
    await c.var.db.goal.delete({where: {id: found.id}});
    return c.json({ok: true});
  });
