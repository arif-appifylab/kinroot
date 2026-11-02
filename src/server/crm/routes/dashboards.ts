import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import type {Db} from '../kit/db';
import {currentUser, type AppEnv} from '../kit/guards';
import {rangeSchema} from '@/lib/reports';
import {notFound, valid} from '../lib/http';
import {userSelect} from '../lib/users';
import {assertCanEdit, findReport, parseConfig, reportSelect, runFor, runQuery} from './reports';

const filters = z.object({range: rangeSchema.optional(), ownerId: z.string().max(40).optional()});
const size = z.enum(['small', 'medium', 'large']);

const include = {
  owner: {select: userSelect},
  widgets: {orderBy: {position: 'asc'}, include: {report: {include: reportSelect}}},
} satisfies Prisma.DashboardInclude;

const visible = (me: User): Prisma.DashboardWhereInput => ({OR: [{shared: true}, {ownerId: me.id}]});

async function findDashboard(db: Db, me: User, id: string) {
  const dashboard = await db.dashboard.findFirst({where: {id, ...visible(me)}});
  if (!dashboard) throw notFound('Dashboard');
  return dashboard;
}

/** Owner or admin; everyone else sees a shared dashboard read-only. */
async function editable(db: Db, me: User, id: string) {
  const dashboard = await findDashboard(db, me, id);
  assertCanEdit(me, dashboard, 'dashboard');
  return dashboard;
}

const MAX_WIDGETS = 24;

export const dashboards = new Hono<AppEnv>()
  .get('/', async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.dashboard.findMany({
      where: visible(me),
      include: {owner: {select: userSelect}, _count: {select: {widgets: true}}},
      orderBy: [{createdAt: 'asc'}],
    });
    return c.json({rows});
  })

  .post('/', valid('json', z.object({name: z.string().trim().min(1, 'is required').max(80), shared: z.boolean().default(false)})), async (c) => {
    const me = currentUser(c);
    const dashboard = await c.var.db.dashboard.create({data: {...c.req.valid('json'), ownerId: me.id, filters: {range: {preset: 'last_90'}}}, include});
    return c.json({dashboard}, 201);
  })

  .get('/:id', async (c) => {
    const me = currentUser(c);
    const dashboard = await c.var.db.dashboard.findFirst({where: {id: c.req.param('id'), ...visible(me)}, include});
    if (!dashboard) throw notFound('Dashboard');
    return c.json({dashboard});
  })

  .patch('/:id', valid('json', z.object({name: z.string().trim().min(1).max(80).optional(), shared: z.boolean().optional(), filters: filters.optional()})), async (c) => {
    const me = currentUser(c);
    const found = await editable(c.var.db, me, c.req.param('id'));
    const body = c.req.valid('json');
    const dashboard = await c.var.db.dashboard.update({where: {id: found.id}, data: {...body, filters: body.filters as Prisma.InputJsonValue | undefined}, include});
    return c.json({dashboard});
  })

  /** Copies the layout; widgets keep pointing at the same saved reports. */
  .post('/:id/duplicate', async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const found = await db.dashboard.findFirst({where: {id: c.req.param('id'), ...visible(me)}, include: {widgets: {orderBy: {position: 'asc'}}}});
    if (!found) throw notFound('Dashboard');
    const dashboard = await db.dashboard.create({
      data: {
        name: `${found.name} (copy)`.slice(0, 80),
        ownerId: me.id,
        filters: found.filters as Prisma.InputJsonValue,
        widgets: {create: found.widgets.map((w) => ({reportId: w.reportId, size: w.size, position: w.position}))},
      },
      include,
    });
    return c.json({dashboard}, 201);
  })

  .delete('/:id', async (c) => {
    const found = await editable(c.var.db, currentUser(c), c.req.param('id'));
    await c.var.db.dashboard.delete({where: {id: found.id}});
    return c.json({ok: true});
  })

  .post('/:id/widgets', valid('json', z.object({reportId: z.string(), size: size.default('medium')})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const found = await editable(db, me, c.req.param('id'));
    const {reportId, size: s} = c.req.valid('json');
    const report = await findReport(db, me, reportId);
    const count = await db.dashboardWidget.count({where: {dashboardId: found.id}});
    if (count >= MAX_WIDGETS) throw new HTTPException(400, {message: `A dashboard holds up to ${MAX_WIDGETS} reports`});
    if (found.shared && !report.shared) throw new HTTPException(400, {message: 'Share the report with the team before adding it to a shared dashboard'});
    await db.dashboardWidget.create({data: {dashboardId: found.id, reportId: report.id, size: s, position: count}});
    return c.json({dashboard: await db.dashboard.findUniqueOrThrow({where: {id: found.id}, include})}, 201);
  })

  .patch('/:id/widgets/:widgetId', valid('json', z.object({size})), async (c) => {
    const found = await editable(c.var.db, currentUser(c), c.req.param('id'));
    await c.var.db.dashboardWidget.updateMany({where: {id: c.req.param('widgetId'), dashboardId: found.id}, data: c.req.valid('json')});
    return c.json({ok: true});
  })

  /** New order of every widget id. */
  .post('/:id/reorder', valid('json', z.object({ids: z.array(z.string()).max(MAX_WIDGETS)})), async (c) => {
    const found = await editable(c.var.db, currentUser(c), c.req.param('id'));
    const {ids} = c.req.valid('json');
    await Promise.all(ids.map((id, position) => c.var.db.dashboardWidget.updateMany({where: {id, dashboardId: found.id}, data: {position}})));
    return c.json({ok: true});
  })

  .delete('/:id/widgets/:widgetId', async (c) => {
    const found = await editable(c.var.db, currentUser(c), c.req.param('id'));
    await c.var.db.dashboardWidget.deleteMany({where: {id: c.req.param('widgetId'), dashboardId: found.id}});
    return c.json({ok: true});
  })

  /**
   * A widget's numbers. Anyone who can see the dashboard can run its widgets;
   * record visibility (ownerScope) still applies inside the report.
   */
  .get('/:id/widgets/:widgetId/run', valid('query', runQuery), async (c) => {
    const me = currentUser(c);
    const found = await findDashboard(c.var.db, me, c.req.param('id'));
    const widget = await c.var.db.dashboardWidget.findFirst({where: {id: c.req.param('widgetId'), dashboardId: found.id}, include: {report: true}});
    if (!widget) throw notFound('Widget');
    return c.json(await runFor(c, parseConfig(JSON.stringify(widget.report.config)), c.req.valid('query')));
  });
