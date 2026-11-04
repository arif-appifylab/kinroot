import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma, ReportSchedule} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {SCHEDULE_STATUS, describeSchedule, scheduleBodySchema, scheduleIssue, schedulePatchSchema, scheduleTimingSchema, type ScheduleBody} from '@/lib/report-schedules';
import {isTimeZone} from '@/lib/scheduling';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {fieldError, notFound, valid} from '../lib/http';
import {nextSlot, readUnsubscribeToken, recipientsOf, unsubscribeRecipient, renderScheduleEmail, scheduleInclude, ScheduleError, sendNow, targetName, upcomingSlots, type ScheduleWithTarget} from '../lib/report-schedules';
import {userSelect} from '../lib/users';
import {strings} from '../lib/json-list';

/**
 * Scheduled report emails (src/server/lib/report-schedules.ts). Anyone who
 * can write may schedule a report or dashboard they can see; members see and
 * manage their own schedules, admins all of them.
 */

const listInclude = {
  owner: {select: userSelect},
  report: {select: {id: true, name: true}},
  dashboard: {select: {id: true, name: true}},
} satisfies Prisma.ReportScheduleInclude;

const mine = (me: User): Prisma.ReportScheduleWhereInput => (isAdmin(me) ? {} : {ownerId: me.id});

async function findSchedule(db: Db, me: User, id: string) {
  const s = await db.reportSchedule.findFirst({where: {id, ...mine(me)}, include: scheduleInclude});
  if (!s) throw notFound('Scheduled email');
  return s;
}

/** Checks the draft, the target (visible to the creator) and the team recipients. */
async function checkBody(db: Db, creator: Pick<User, 'id'>, b: ScheduleBody) {
  const issue = scheduleIssue(b);
  if (issue) throw issue.field ? fieldError(issue.field, issue.message) : new HTTPException(400, {message: issue.message});
  if (!isTimeZone(b.timezone)) throw fieldError('timezone', 'Pick a valid time zone');
  const visible = {OR: [{shared: true}, {ownerId: creator.id}]};
  if (b.reportId && !(await db.report.findFirst({where: {id: b.reportId, ...visible}, select: {id: true}}))) throw notFound('Report');
  if (b.dashboardId && !(await db.dashboard.findFirst({where: {id: b.dashboardId, ...visible}, select: {id: true}}))) throw notFound('Dashboard');
  const userIds = [...new Set(b.userIds)];
  if (userIds.length && (await db.member.count({where: {id: {in: userIds}, active: true}})) !== userIds.length) throw fieldError('userIds', 'Pick active team members');
  return {...b, userIds, emails: [...new Set(b.emails.map((e) => e.trim().toLowerCase()))]};
}

const timingKeys = ['frequency', 'weekday', 'monthDay', 'time', 'timezone'] as const;

/** Rows for the list: plain-words frequency, recipient count, readable status. */
const present = <T extends ReportSchedule & {report: {name: string} | null; dashboard: {name: string} | null}>(s: T) => ({
  ...s,
  userIds: strings(s.userIds),
  emails: strings(s.emails),
  name: s.report?.name ?? s.dashboard?.name ?? 'Deleted report',
  kind: s.reportId ? ('report' as const) : ('dashboard' as const),
  frequencyLabel: describeSchedule(s),
  recipients: new Set([...strings(s.userIds), ...strings(s.emails)]).size,
  statusLabel: s.lastStatus ? (SCHEDULE_STATUS[s.lastStatus as keyof typeof SCHEDULE_STATUS] ?? s.lastStatus) : null,
});

/** Preview the email of a draft (or a saved schedule with changes) without sending. */
async function preview(c: AppContext, body: ScheduleBody, id?: string) {
  const me = currentUser(c);
  const db = c.var.db;
  const existing = id ? await findSchedule(db, me, id) : null;
  const creator = existing?.owner ?? me;
  const b = await checkBody(db, creator, {...body, userIds: body.userIds.length || body.emails.length ? body.userIds : [creator.id]});
  const [report, dashboard] = await Promise.all([
    b.reportId ? db.report.findUnique({where: {id: b.reportId}}) : null,
    b.dashboardId ? db.dashboard.findUnique({where: {id: b.dashboardId}, include: scheduleInclude.dashboard.include}) : null,
  ]);
  const draft = {
    ...(existing ?? {id: 'preview', origin: publicOrigin(c.req.raw), failures: 0, lastStatus: null}),
    ...b,
    weekday: b.weekday ?? null,
    monthDay: b.monthDay ?? null,
    subject: b.subject ?? null,
    note: b.note ?? null,
    reportId: b.reportId ?? null,
    dashboardId: b.dashboardId ?? null,
    owner: creator,
    report,
    dashboard,
  } as ScheduleWithTarget;
  try {
    const email = await renderScheduleEmail(db, draft, Date.now());
    return {
      subject: email.subject,
      html: email.layout('#unsubscribe'),
      rangeLabel: email.rangeLabel,
      attachments: email.attachments.map((a) => ({filename: a.filename, size: a.content.byteLength})),
      skipped: email.skipped,
      recipients: (await recipientsOf(db, b)).length,
    };
  } catch (e) {
    if (e instanceof ScheduleError) throw new HTTPException(400, {message: e.message});
    throw e;
  }
}

export const reportSchedules = new Hono<AppEnv>()
  .get('/', valid('query', z.object({reportId: z.string().max(40).optional(), dashboardId: z.string().max(40).optional()})), async (c) => {
    const me = currentUser(c);
    const q = c.req.valid('query');
    const rows = await c.var.db.reportSchedule.findMany({
      where: {...mine(me), ...(q.reportId ? {reportId: q.reportId} : {}), ...(q.dashboardId ? {dashboardId: q.dashboardId} : {})},
      include: listInclude,
      orderBy: [{active: 'desc'}, {nextRunAt: 'asc'}],
    });
    return c.json({rows: rows.map(present)});
  })

  /** The next sends of a timing (the drawer shows them; `after` defaults to now). */
  .post('/next', valid('json', scheduleTimingSchema.extend({after: z.iso.datetime().optional(), count: z.number().int().min(1).max(12).default(3)})), async (c) => {
    const b = c.req.valid('json');
    if (!isTimeZone(b.timezone)) throw fieldError('timezone', 'Pick a valid time zone');
    if (b.frequency === 'weekly' && (b.weekday === null || b.weekday === undefined)) throw fieldError('weekday', 'Pick a weekday');
    if (b.frequency === 'monthly' && !b.monthDay) throw fieldError('monthDay', 'Pick a day of the month');
    const timing = {...b, weekday: b.weekday ?? null, monthDay: b.monthDay ?? null};
    return c.json({slots: upcomingSlots(timing, b.after ? Date.parse(b.after) : Date.now(), b.count).map((t) => new Date(t).toISOString())});
  })

  .post('/preview', valid('json', scheduleBodySchema.extend({id: z.string().max(40).optional()})), async (c) => {
    const {id, ...body} = c.req.valid('json');
    return c.json(await preview(c, body, id));
  })

  .post('/', valid('json', scheduleBodySchema), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const b = await checkBody(db, me, c.req.valid('json'));
    const now = Date.now();
    const s = await db.reportSchedule.create({
      data: {...b, ownerId: me.id, origin: publicOrigin(c.req.raw), cursor: new Date(now), nextRunAt: new Date(nextSlot({...b, weekday: b.weekday ?? null, monthDay: b.monthDay ?? null}, now))},
      include: listInclude,
    });
    await audit(db, c, {
      action: 'report_schedule.created',
      entity: 'report_schedule',
      recordId: s.id,
      label: present(s).name,
      meta: {frequency: describeSchedule(s), users: b.userIds.length, external: b.emails, range: b.range, active: b.active},
    });
    return c.json({schedule: present(s)}, 201);
  })

  .get('/:id', async (c) => {
    const me = currentUser(c);
    const s = await c.var.db.reportSchedule.findFirst({where: {id: c.req.param('id'), ...mine(me)}, include: listInclude});
    if (!s) throw notFound('Scheduled email');
    return c.json({schedule: present(s)});
  })

  .patch('/:id', valid('json', schedulePatchSchema), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const before = await findSchedule(db, me, c.req.param('id'));
    const patch = c.req.valid('json');
    // The target never changes; everything else is checked as a whole.
    const merged = await checkBody(db, before.owner, {
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      reportId: before.reportId,
      dashboardId: before.dashboardId,
    } as ScheduleBody);
    const data: Prisma.ReportScheduleUpdateInput = {
      frequency: merged.frequency,
      weekday: merged.weekday ?? null,
      monthDay: merged.monthDay ?? null,
      time: merged.time,
      timezone: merged.timezone,
      userIds: merged.userIds,
      emails: merged.emails,
      subject: merged.subject ?? null,
      note: merged.note ?? null,
      range: merged.range,
      active: merged.active,
    };
    const retimed = timingKeys.some((k) => (merged[k] ?? null) !== (before[k] ?? null));
    const resumed = merged.active && !before.active;
    // New timing or switched back on: only slots from now on count (no burst of missed emails).
    if (retimed || resumed) {
      const now = Date.now();
      Object.assign(data, {cursor: new Date(now), nextRunAt: new Date(nextSlot({...merged, weekday: merged.weekday ?? null, monthDay: merged.monthDay ?? null}, now))});
    }
    if (resumed) Object.assign(data, {failures: 0});
    const s = await db.reportSchedule.update({where: {id: before.id}, data, include: listInclude});
    const changes = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>).filter((ch) => !['cursor', 'nextRunAt', 'failures'].includes(ch.field));
    if (changes.length) {
      await audit(db, c, {
        action: resumed ? 'report_schedule.resumed' : 'report_schedule.updated',
        entity: 'report_schedule',
        recordId: s.id,
        label: present(s).name,
        meta: {changes},
      });
    }
    return c.json({schedule: present(s)});
  })

  .delete('/:id', async (c) => {
    const db = c.var.db;
    const s = await findSchedule(db, currentUser(c), c.req.param('id'));
    await db.reportSchedule.delete({where: {id: s.id}});
    await audit(db, c, {action: 'report_schedule.deleted', entity: 'report_schedule', recordId: s.id, label: targetName(s), meta: {frequency: describeSchedule(s), external: s.emails}});
    return c.json({ok: true});
  })

  /** Sends the latest edition now, whatever the schedule's timing (also when paused). */
  .post('/:id/send', async (c) => {
    const me = currentUser(c);
    const s = await findSchedule(c.var.db, me, c.req.param('id'));
    const outcome = await sendNow(c.var.db, s.id, me);
    if (!outcome || outcome.status !== 'sent') throw new HTTPException(outcome?.status === 'no_mailbox' ? 400 : 502, {message: outcome?.error ?? 'Not sent'});
    return c.json({ok: true, recipients: outcome.recipients});
  });

/** j***@example.com, like the contact unsubscribe page. */
const mask = (email: string) => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
};

/** Public: the unsubscribe link in every scheduled report email (signed token, no sign-in). */
export const reportSchedulesPublic = new Hono<AppEnv>()
  .get('/report-unsubscribe/:token', async (c) => {
    const t = await readUnsubscribeToken(c.var.db, c.req.param('token').slice(0, 400));
    const s = t ? await c.var.db.reportSchedule.findUnique({where: {id: t.scheduleId}, include: {report: {select: {name: true}}, dashboard: {select: {name: true}}}}) : null;
    if (!t || !s) throw notFound('Link');
    // A link whose address is no longer on the schedule: already unsubscribed.
    const subscribed = !!t.email && (await recipientsOf(c.var.db, s)).includes(t.email);
    return c.json({email: t.email ? mask(t.email) : '', name: s.report?.name ?? s.dashboard?.name ?? 'Report', subscribed});
  })
  .post('/report-unsubscribe/:token', async (c) => {
    const t = await readUnsubscribeToken(c.var.db, c.req.param('token').slice(0, 400));
    const s = !t ? null : t.email ? await unsubscribeRecipient(c.var.db, t.scheduleId, t.email) : await c.var.db.reportSchedule.findUnique({where: {id: t.scheduleId}, select: {id: true}});
    if (!t || !s) throw notFound('Link');
    return c.json({ok: true, email: t.email ? mask(t.email) : '', subscribed: false});
  });
