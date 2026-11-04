import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {currentUser, type AppContext, type AppEnv} from '../kit/guards';
import {logActivities, logActivity, touch} from '../lib/activity';
import {emit, emitMany} from '../lib/events';
import {assertVisible, attachedWhere, intParam, isoDate, notFound, optStr, ownerScope, valid} from '../lib/http';
import {linkFor, notify} from '../lib/notify';
import {rememberOption} from '../lib/settings';
import {userSelect} from '../lib/users';

const PRIORITIES = z.enum(['NONE', 'LOW', 'NORMAL', 'HIGH']);
const repeatRule = z.enum(['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);

const taskBody = z.object({
  title: z.string().trim().min(1, 'is required').max(300),
  description: optStr,
  type: z.enum(['TODO', 'CALL', 'EMAIL', 'MEETING', 'DEADLINE']).optional(),
  priority: z.enum(['NONE', 'LOW', 'NORMAL', 'HIGH']).optional(),
  dueAt: isoDate,
  repeat: repeatRule.nullish(),
  queue: optStr,
  reminderAt: isoDate,
  assigneeId: z.string().nullish(),
  contactId: z.string().nullish(),
  companyId: z.string().nullish(),
  dealId: z.string().nullish(),
});

export const taskInclude = {
  assignee: {select: userSelect},
  contact: {select: {id: true, firstName: true, lastName: true}},
  company: {select: {id: true, name: true}},
  deal: {select: {id: true, title: true}},
} satisfies Prisma.TaskInclude;

const taskLink = (t: {contactId: string | null; companyId: string | null; dealId: string | null}) => linkFor(t) ?? '/tasks';

const PRIORITY_RANK = {HIGH: 0, NORMAL: 1, LOW: 2, NONE: 3} as const;

/** Next due date for a repeating task. */
function nextDue(from: Date, rule: z.infer<typeof repeatRule>) {
  const d = new Date(from);
  switch (rule) {
    case 'DAILY':
      d.setDate(d.getDate() + 1);
      break;
    case 'WEEKDAYS':
      do d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case 'WEEKLY':
      d.setDate(d.getDate() + 7);
      break;
    case 'MONTHLY':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'QUARTERLY':
      d.setMonth(d.getMonth() + 3);
      break;
    case 'YEARLY':
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d;
}

type TaskRow = Prisma.TaskGetPayload<{include: typeof taskInclude}>;

/**
 * What follows completing tasks: timeline entries, `task.completed` events, a note to each
 * creator, and the next one of a repeating task. Batched (bulk complete sends up to 500): a few
 * queries in all, never a few per task. Returns the next tasks by the completed task's id.
 */
async function completeTasks(db: Db, tasks: TaskRow[], actor: {id: string; name: string}) {
  if (!tasks.length) return new Map<string, {id: string}>();
  await logActivities(db, tasks.map((task) => ({
    type: 'task_done',
    title: `Completed: ${task.title}`,
    refId: task.id,
    actorId: actor.id,
    contactId: task.contactId,
    companyId: task.companyId,
    dealId: task.dealId,
    data: {taskType: task.type},
  })));
  await emitMany(db, 'task.completed', tasks.map((task) => ({recordId: task.id, actorId: actor.id, data: task})));
  // Creators who are still active hear about it (as notify() does), one insert for all.
  const creatorIds = [...new Set(tasks.map((t) => t.creatorId).filter((id): id is string => !!id && id !== actor.id))];
  const active = creatorIds.length ? new Set((await db.member.findMany({where: {id: {in: creatorIds}, active: true}, select: {id: true}})).map((m) => m.id)) : new Set<string>();
  const notes = tasks.filter((t) => t.creatorId && active.has(t.creatorId));
  if (notes.length) {
    await db.notification.createMany({
      data: notes.map((t) => ({userId: t.creatorId!, type: 'activity', title: `${actor.name} completed: ${t.title}`.slice(0, 200), link: taskLink(t), actorId: actor.id})),
    });
  }
  // Repeating tasks roll forward: the next one keeps everything but the dates.
  const repeating = tasks.filter((t) => t.repeat);
  if (!repeating.length) return new Map<string, {id: string}>();
  const created = await db.task.createManyAndReturn({
    data: repeating.map((task) => {
      const dueAt = nextDue(task.dueAt ?? new Date(), task.repeat as z.infer<typeof repeatRule>);
      const reminderAt = task.reminderAt && task.dueAt ? new Date(dueAt.getTime() - (task.dueAt.getTime() - task.reminderAt.getTime())) : null;
      return {
        title: task.title,
        description: task.description,
        type: task.type,
        priority: task.priority,
        repeat: task.repeat,
        queue: task.queue,
        dueAt,
        reminderAt,
        assigneeId: task.assigneeId,
        creatorId: task.creatorId,
        contactId: task.contactId,
        companyId: task.companyId,
        dealId: task.dealId,
      };
    }),
  });
  // createManyAndReturn keeps the input order.
  return new Map(repeating.map((t, i) => [t.id, created[i]!]));
}

/** Tasks the signed-in user may see: with owner-only visibility, theirs, or on records they may see. */
async function taskScope(c: AppContext): Promise<Prisma.TaskWhereInput> {
  const scope = await ownerScope(c);
  return scope.ownerId ? {OR: [{assigneeId: scope.ownerId}, attachedWhere(scope)]} : {};
}

export const tasks = new Hono<AppEnv>()
  .get('/', valid('query', z.object({
    scope: z.enum(['mine', 'all']).default('mine'),
    assigneeId: z.string().optional(),
    status: z.enum(['open', 'done', 'all']).default('open'),
    due: z.enum(['overdue', 'today', 'upcoming', 'this_week', 'nodate', 'any']).default('any'),
    type: z.enum(['TODO', 'CALL', 'EMAIL', 'MEETING', 'DEADLINE']).optional(),
    priority: z.enum(['NONE', 'LOW', 'NORMAL', 'HIGH']).optional(),
    queue: z.string().optional(),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(['due', 'priority', 'created', 'title']).default('due'),
    contactId: z.string().optional(),
    companyId: z.string().optional(),
    dealId: z.string().optional(),
    tzOffset: intParam(-840, 840).optional(), // minutes, from Date#getTimezoneOffset (UTC-14 … UTC+14)
  })), async (c) => {
    const me = currentUser(c);
    const q = c.req.valid('query');
    const recordScoped = q.contactId || q.companyId || q.dealId;
    // A record's tasks: the record must be one the user may see. Lists across records: only visible tasks.
    if (recordScoped) await assertVisible(c, {contactId: q.contactId, companyId: q.companyId, dealId: q.dealId});
    const where: Prisma.TaskWhereInput = recordScoped ? {} : {AND: [await taskScope(c)]};
    if (q.contactId) where.contactId = q.contactId;
    if (q.companyId) where.companyId = q.companyId;
    if (q.dealId) where.dealId = q.dealId;
    if (!recordScoped) {
      if (q.assigneeId) where.assigneeId = q.assigneeId === 'none' ? null : q.assigneeId;
      else if (q.scope === 'mine') where.assigneeId = me.id;
    }
    if (q.status !== 'all') where.done = q.status === 'done';
    if (q.type) where.type = q.type;
    if (q.priority) where.priority = q.priority;
    if (q.queue) where.queue = q.queue === 'none' ? null : q.queue;
    if (q.q) {
      where.OR = [
        {title: {contains: q.q, mode: 'insensitive'}},
        {description: {contains: q.q, mode: 'insensitive'}},
        {contact: {OR: [{firstName: {contains: q.q, mode: 'insensitive'}}, {lastName: {contains: q.q, mode: 'insensitive'}}]}},
        {company: {name: {contains: q.q, mode: 'insensitive'}}},
        {deal: {title: {contains: q.q, mode: 'insensitive'}}},
      ];
    }

    // "Today" is the viewer's local day, not the server's.
    const offsetMs = (q.tzOffset ?? 0) * 60_000;
    const localNow = new Date(Date.now() - offsetMs);
    const sod = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) + offsetMs);
    const eod = new Date(sod.getTime() + 86400_000);
    if (q.due === 'overdue') where.dueAt = {lt: new Date()};
    if (q.due === 'today') where.dueAt = {gte: sod, lt: eod};
    if (q.due === 'upcoming') where.dueAt = {gte: eod};
    if (q.due === 'this_week') where.dueAt = {gte: sod, lt: new Date(sod.getTime() + 7 * 86400_000)};
    if (q.due === 'nodate') where.dueAt = null;

    const orderBy: Prisma.TaskOrderByWithRelationInput[] =
      q.status === 'done'
        ? [{doneAt: 'desc'}]
        : q.sort === 'created'
          ? [{createdAt: 'desc'}]
          : q.sort === 'title'
            ? [{title: 'asc'}]
            : [{dueAt: {sort: 'asc', nulls: 'last'}}, {createdAt: 'asc'}];
    let rows = await c.var.db.task.findMany({where, include: taskInclude, orderBy, take: 500});
    // Enum order in Postgres isn't the importance order, so rank in code.
    if (q.sort === 'priority') rows = [...rows].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return c.json({rows});
  })

  .get('/counts', async (c) => {
    const me = currentUser(c);
    const base = {assigneeId: me.id, done: false};
    const [overdue, open] = await Promise.all([
      c.var.db.task.count({where: {...base, dueAt: {lt: new Date()}}}),
      c.var.db.task.count({where: base}),
    ]);
    return c.json({overdue, open});
  })

  /** Reminders that are due for the signed-in user and haven't been shown yet. */
  .get('/reminders', async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.task.findMany({
      where: {assigneeId: me.id, done: false, reminderAt: {lte: new Date()}, remindedAt: null},
      include: taskInclude,
      orderBy: {reminderAt: 'asc'},
      take: 10,
    });
    return c.json({rows});
  })

  .post('/:id/reminded', async (c) => {
    const me = currentUser(c);
    const task = await c.var.db.task.findFirst({where: {id: c.req.param('id'), assigneeId: me.id, remindedAt: null}});
    if (task) {
      await c.var.db.task.update({where: {id: task.id}, data: {remindedAt: new Date()}});
      // Keeps the reminder in the bell after the toast is gone.
      await notify(c.var.db, [me.id], {type: 'reminder', title: `Reminder: ${task.title}`, body: task.description, link: taskLink(task)});
    }
    return c.json({ok: true});
  })

  .post('/', valid('json', taskBody), async (c) => {
    const me = currentUser(c);
    const body = c.req.valid('json');
    await assertVisible(c, body);
    const task = await c.var.db.task.create({
      data: {...body, assigneeId: body.assigneeId === undefined ? me.id : body.assigneeId, creatorId: me.id},
      include: taskInclude,
    });
    await rememberOption(c.var.db, 'taskQueues', task.queue);
    await logActivity(c.var.db, {
      type: 'task_created',
      title: `Task scheduled: ${task.title}`,
      refId: task.id,
      actorId: me.id,
      contactId: task.contactId,
      companyId: task.companyId,
      dealId: task.dealId,
      data: {taskType: task.type, dueAt: task.dueAt?.toISOString() ?? null},
      text: [task.title, task.description].filter(Boolean).join('\n'),
    });
    await emit(c.var.db, 'task.created', {recordId: task.id, actorId: me.id, data: task});
    await notify(c.var.db, [task.assigneeId], {type: 'assigned', title: `${me.name} assigned you a task: ${task.title}`, link: taskLink(task), actorId: me.id});
    return c.json({task}, 201);
  })

  .post('/bulk', valid('json', z.object({
    ids: z.array(z.string().max(40)).min(1).max(500),
    action: z.enum(['complete', 'reopen', 'delete', 'assign', 'reschedule', 'priority', 'queue']),
    value: z.string().max(200).nullish(),
  })), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {ids, action, value} = c.req.valid('json');
    if (action === 'reschedule' && value && Number.isNaN(new Date(value).getTime())) throw new HTTPException(400, {message: 'Pick a valid date'});
    if (action === 'priority' && value && !PRIORITIES.safeParse(value).success) throw new HTTPException(400, {message: 'Pick a priority'});
    // Only tasks the user may see are touched; the others are skipped as if they did not exist.
    const where: Prisma.TaskWhereInput = {id: {in: ids}, AND: [await taskScope(c)]};
    if (action === 'complete') {
      const open = await db.task.findMany({where: {...where, done: false}, include: taskInclude});
      await db.task.updateMany({where: {id: {in: open.map((t) => t.id)}, done: false}, data: {done: true, doneAt: new Date()}});
      await completeTasks(db, open, me);
    }
    if (action === 'reopen') await db.task.updateMany({where, data: {done: false, doneAt: null}});
    if (action === 'delete') await db.task.deleteMany({where});
    if (action === 'assign') {
      const {count} = await db.task.updateMany({where, data: {assigneeId: value || null}});
      await notify(db, [value], {type: 'assigned', title: `${me.name} assigned you ${count} task${count === 1 ? '' : 's'}`, link: '/tasks', actorId: me.id});
    }
    if (action === 'reschedule' && value) await db.task.updateMany({where, data: {dueAt: new Date(value), remindedAt: null}});
    if (action === 'priority' && value) await db.task.updateMany({where, data: {priority: PRIORITIES.parse(value)}});
    if (action === 'queue') await db.task.updateMany({where, data: {queue: value || null}});
    return c.json({ok: true});
  })

  .patch('/:id', valid('json', taskBody.partial().extend({done: z.boolean().optional()})), async (c) => {
    const me = currentUser(c);
    const before = await c.var.db.task.findFirst({where: {id: c.req.param('id'), AND: [await taskScope(c)]}});
    if (!before) throw notFound('Task');
    const body = c.req.valid('json');
    // Moving it onto another record: that record must be visible too.
    await assertVisible(c, {contactId: body.contactId, companyId: body.companyId, dealId: body.dealId});
    const completing = body.done === true && !before.done;
    const task = await c.var.db.task.update({
      where: {id: before.id},
      data: {
        ...body,
        doneAt: body.done === undefined ? undefined : body.done ? new Date() : null,
        // A changed reminder should fire again.
        remindedAt: body.reminderAt !== undefined && String(body.reminderAt) !== String(before.reminderAt) ? null : undefined,
      },
      include: taskInclude,
    });
    if (body.queue) await rememberOption(c.var.db, 'taskQueues', body.queue);
    if (task.assigneeId !== before.assigneeId) {
      await notify(c.var.db, [task.assigneeId], {type: 'assigned', title: `${me.name} assigned you a task: ${task.title}`, link: taskLink(task), actorId: me.id});
    }
    let next = null;
    if (completing) next = (await completeTasks(c.var.db, [task], me)).get(task.id) ?? null;
    else await touch(c.var.db, task);
    return c.json({task, next});
  })

  .delete('/:id', async (c) => {
    const existing = await c.var.db.task.findFirst({where: {id: c.req.param('id'), AND: [await taskScope(c)]}, select: {id: true}});
    if (!existing) throw notFound('Task');
    await c.var.db.task.delete({where: {id: existing.id}});
    return c.json({ok: true});
  });
