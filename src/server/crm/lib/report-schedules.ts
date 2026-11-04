import {HTTPException} from 'hono/http-exception';

import type {Dashboard, Member, Prisma, Report, ReportSchedule, ReportScheduleSend} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import {accentOf, wrapEmail} from '@/lib/email-layout';
import {PAUSE_AFTER_FAILURES, describeSchedule} from '@/lib/report-schedules';
import {reportConfigSchema, type DateRange, type ReportOverrides} from '@/lib/reports';
import {addDays, isTimeZone, localDate, weekdayOf, zonedTime} from '@/lib/scheduling';
import type {DashboardFilters} from '@/lib/types';
import {config, CRM_APP} from '../kit/config';
import {fromB64, sign, toB64Url, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import {emailBrand, getEmailDesign} from '../email/design';
import type {Attachment} from '../email/mime';
import {htmlToText} from '../email/render';
import {sendSystemEmail, systemAccount} from '../email/service';
import {resultCsv} from '../routes/reports';
import {audit} from './audit';
import {isOwnerAddress} from './owner-account';
import {emit} from './events';
import {userScope} from './http';
import {deleteInChunks} from './chunked-delete';
import {enqueue} from './jobs';
import {notify} from './notify';
import {reportEmailContent, rangeText, type EmailSection} from './report-email';
import {runReport} from './reports';
import {getSettings} from './settings';
import {strings} from './json-list';

/**
 * Scheduled report emails. A schedule fires at wall-clock slots in its own
 * time zone (Intl maths from lib/scheduling, so DST moves the instant, not
 * the time of day). Each `crm-tick` run (`reportScheduleTick`)
 * takes the schedules whose `nextRunAt` has passed, claims the latest slot in
 * a `ReportScheduleSend` row (unique per schedule + slot, so overlapping
 * ticks fire once and missed slots are caught up once, not N times) and
 * queues a `report.send` job. The job renders the email with the creator's
 * visibility and sends one copy per recipient from the team mailbox,
 * remembering each address it reached, so a retried job never emails anyone
 * twice. Final failures notify the creator; after PAUSE_AFTER_FAILURES in a
 * row the schedule switches itself off.
 */

export type Timing = Pick<ReportSchedule, 'frequency' | 'weekday' | 'monthDay' | 'time' | 'timezone'>;

const DAY = 86_400_000;
const daysInMonth = (date: string) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
const zoneOf = (t: Timing) => (isTimeZone(t.timezone) ? t.timezone : 'UTC');

/** The send instant on a wall date (YYYY-MM-DD in the schedule's zone), or null when it doesn't send that day. */
function slotOn(t: Timing, date: string): number | null {
  if (t.frequency === 'weekly' && weekdayOf(date) !== (t.weekday ?? 1)) return null;
  if (t.frequency === 'monthly') {
    const last = daysInMonth(date);
    // Day 29–31 in a shorter month sends on its last day.
    const target = !t.monthDay || t.monthDay === -1 ? last : Math.min(t.monthDay, last);
    if (Number(date.slice(8, 10)) !== target) return null;
  }
  return zonedTime(date, t.time, zoneOf(t));
}

/** First slot strictly after `after`. */
export function nextSlot(t: Timing, after: number): number {
  let date = addDays(localDate(after, zoneOf(t)), -1);
  for (let i = 0; i < 400; i++, date = addDays(date, 1)) {
    const at = slotOn(t, date);
    if (at !== null && at > after) return at;
  }
  throw new Error('No upcoming slot'); // unreachable: every timing sends at least monthly
}

/** Latest slot at or before `upto` (null if none in the last 400 days). */
function latestSlot(t: Timing, upto: number): number | null {
  let date = addDays(localDate(upto, zoneOf(t)), 1);
  for (let i = 0; i < 400; i++, date = addDays(date, -1)) {
    const at = slotOn(t, date);
    if (at !== null && at <= upto) return at;
  }
  return null;
}

/** The next `count` slots after `after` (the drawer shows them; the test script checks the maths with them). */
export function upcomingSlots(t: Timing, after: number, count = 3) {
  const out: number[] = [];
  let at = after;
  for (let i = 0; i < count; i++) out.push((at = nextSlot(t, at)));
  return out;
}

/**
 * "Previous period" for a send at `slot`: the whole days from the slot before
 * it up to the day before this one (a Monday weekly gets last Monday–Sunday,
 * a daily yesterday, a monthly on the 1st last month), as a custom range in
 * the schedule's zone. Its own previous period is the stretch before that.
 */
function previousPeriod(t: Timing, slot: number): DateRange & {fromAt: number; toAt: number} {
  const tz = zoneOf(t);
  const before = latestSlot(t, slot - 1) ?? slot - DAY;
  const from = localDate(before, tz);
  let to = addDays(localDate(slot, tz), -1);
  if (to < from) to = from;
  return {preset: 'custom', from, to, fromAt: zonedTime(from, '00:00', tz), toAt: zonedTime(addDays(to, 1), '00:00', tz)};
}

// ─── Unsubscribe ───

/** `<base64url(scheduleId:email)>.<signature>`: one recipient leaves one schedule without signing in. */
async function scheduleUnsubscribeToken(scheduleId: string, email: string) {
  const payload = toB64Url(new TextEncoder().encode(`${scheduleId}:${email.toLowerCase()}`));
  return `${payload}.${await sign(`report-unsub:${payload}`)}`;
}

export async function readUnsubscribeToken(token: string) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !(await verifySignature(`report-unsub:${payload}`, signature))) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromB64(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  const [scheduleId, ...rest] = decoded.split(':');
  const email = rest.join(':');
  return scheduleId && email ? {scheduleId, email} : null;
}

/** Takes one address off a schedule (external address, or the team member with that email). */
export async function unsubscribeRecipient(db: Db, scheduleId: string, email: string) {
  const s = await db.reportSchedule.findUnique({where: {id: scheduleId}});
  if (!s) return null;
  const user = await db.member.findFirst({where: {user: {email: email.trim().toLowerCase()}}, select: {id: true}});
  const [haveEmails, haveUserIds] = [strings(s.emails), strings(s.userIds)];
  const emails = haveEmails.filter((e) => e.toLowerCase() !== email);
  const userIds = user ? haveUserIds.filter((id) => id !== user.id) : haveUserIds;
  if (emails.length !== haveEmails.length || userIds.length !== haveUserIds.length) {
    await db.reportSchedule.update({where: {id: s.id}, data: {emails, userIds}});
    await audit(db, null, {action: 'report_schedule.unsubscribed', entity: 'report_schedule', recordId: s.id, actor: {email}, label: email});
  }
  return s;
}

// ─── Rendering ───

export type ScheduleWithTarget = ReportSchedule & {
  owner: Member;
  report: Report | null;
  dashboard: (Dashboard & {widgets: {report: Report}[]}) | null;
};

export const scheduleInclude = {
  owner: true,
  report: true,
  dashboard: {include: {widgets: {orderBy: {position: 'asc'}, include: {report: true}}}},
} satisfies Prisma.ReportScheduleInclude;

/** A permanent problem: retrying won't help (deleted / hidden report, deactivated creator…). */
export class ScheduleError extends Error {}

const visibleTo = (owner: Pick<Member, 'id'>, x: {shared: boolean; ownerId: string | null}) => x.shared || x.ownerId === owner.id;
export const targetName = (s: Pick<ScheduleWithTarget, 'report' | 'dashboard'>) => s.report?.name ?? s.dashboard?.name ?? 'Deleted report';
export const origin = (s: Pick<ReportSchedule, 'origin'>) => config.siteUrl() || s.origin;
const deepLink = (s: Pick<ReportSchedule, 'origin' | 'reportId' | 'dashboardId'>) =>
  `${origin(s)}${CRM_APP}${s.reportId ? `/reports/${s.reportId}` : `/reports/dashboards/${s.dashboardId}`}`;

const fileSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

export type RenderedEmail = {
  subject: string;
  content: string;
  rangeLabel: string;
  attachments: Attachment[];
  sections: number;
  skipped: string[];
  layout: (unsubscribeUrl: string) => string;
};

/**
 * Builds the email for a send at `at` (the slot, or now for "Send now" and
 * the preview). Every report runs with the creator's visibility, whoever
 * receives it.
 */
export async function renderScheduleEmail(db: Db, s: ScheduleWithTarget, at: number, opts: {slot?: number} = {}): Promise<RenderedEmail> {
  const owner = s.owner;
  if (!owner.active) throw new ScheduleError("The creator's account is deactivated");
  const target = s.report ?? s.dashboard;
  if (!target) throw new ScheduleError('The report or dashboard was deleted');
  if (!visibleTo(owner, target)) throw new ScheduleError(`${target.name} is private to someone else now`);

  const tz = zoneOf(s);
  const scope = await userScope(db, owner);
  const previous = s.range === 'previous' ? previousPeriod(s, opts.slot ?? latestSlot(s, at) ?? at) : null;
  const filters = (s.dashboard?.filters ?? {}) as DashboardFilters;
  const overrides: ReportOverrides = {
    range: previous ? {preset: 'custom', from: previous.from, to: previous.to} : s.dashboard ? filters.range : undefined,
    ownerId: s.dashboard ? filters.ownerId : undefined,
  };
  const reports = s.report ? [s.report] : (s.dashboard?.widgets ?? []).map((w) => w.report);
  const settings = await getSettings(db);

  const sections: EmailSection[] = [];
  const skipped: string[] = [];
  const attachments: Attachment[] = [];
  const used = new Set<string>();
  for (const report of reports) {
    if (!visibleTo(owner, report)) {
      skipped.push(`${report.name} (private)`);
      continue;
    }
    const parsed = reportConfigSchema.safeParse(report.config);
    if (!parsed.success) {
      skipped.push(`${report.name} (invalid definition)`);
      continue;
    }
    const ctx = {tz, scopeOwnerId: scope.ownerId, overrides, now: at};
    try {
      const result = await runReport(db, parsed.data, ctx);
      // The stat tile always compares with the period before, whatever the chart.
      const kpi = parsed.data.chart === 'kpi' && parsed.data.compare ? result : await runReport(db, {...parsed.data, groupBy: null, breakdown: null, chart: 'kpi', compare: true}, ctx);
      sections.push({name: report.name, result, kpi});
      let file = `${fileSlug(report.name)}-${localDate(at, tz)}.csv`;
      for (let i = 2; used.has(file); i++) file = `${fileSlug(report.name)}-${i}-${localDate(at, tz)}.csv`;
      used.add(file);
      attachments.push({filename: file, contentType: 'text/csv; charset=utf-8', content: new TextEncoder().encode(resultCsv(result))});
    } catch (e) {
      // A report the engine refuses (a field was removed…) is skipped; database trouble is retried.
      if (!(e instanceof HTTPException)) throw e;
      skipped.push(`${report.name} (${e.message})`);
    }
  }
  if (!sections.length) throw new ScheduleError(skipped.length ? `Nothing to send: ${skipped.join(', ')}` : 'The dashboard has no reports');

  const first = sections[0]!.result;
  const rangeLabel = previous ? rangeText(new Date(previous.fromAt), new Date(previous.toAt), tz) : rangeText(first.range.from, first.range.to, tz, first.range.label);
  const name = target.name;
  const subject = (s.subject?.trim() || `${name}: ${rangeLabel}`).slice(0, 200);
  const base = origin(s);
  const [design, brand] = await Promise.all([getEmailDesign(db), emailBrand(db, base)]);
  const content = reportEmailContent({
    title: name,
    rangeLabel: `${rangeLabel} · ${describeSchedule(s, {zone: false})}`,
    note: s.note,
    sections,
    dashboard: !!s.dashboard,
    skipped,
    link: deepLink(s),
    brandName: brand.name,
    accent: accentOf(design, brand.primary),
    currency: settings.currency,
    tz,
    attached: true,
  });
  return {
    subject,
    content,
    rangeLabel,
    attachments,
    sections: sections.length,
    skipped,
    layout: (unsubscribeUrl) => wrapEmail({content, layout: 'branded', preheader: `${name} · ${rangeLabel}`, design, brand, unsubscribeUrl}),
  };
}

/** Everyone the schedule emails: active team members picked + external addresses (lower-cased, once each). */
export async function recipientsOf(db: Db, s: Pick<ReportSchedule, 'userIds' | 'emails'>) {
  const userIds = strings(s.userIds);
  const users = userIds.length ? await db.member.findMany({where: {id: {in: userIds}, active: true}, select: {user: {select: {email: true}}}}) : [];
  return [...new Set([...users.flatMap((u) => (u.user ? [u.user.email.toLowerCase()] : [])), ...strings(s.emails).map((e) => e.toLowerCase())])];
}

// ─── Sending ───

type Outcome = {status: 'sent' | 'failed' | 'no_mailbox'; error?: string | null; delivered: number; recipients: number};

/**
 * Sends one claimed slot. `final`: no retry follows (last job attempt, or a
 * manual send), so a transient error is recorded instead of thrown.
 */
async function deliverScheduleSend(db: Db, sendId: string, opts: {final: boolean; actor?: User | null} = {final: true}): Promise<Outcome | null> {
  const send = await db.reportScheduleSend.findUnique({where: {id: sendId}, include: {schedule: {include: scheduleInclude}}});
  if (!send || send.status !== 'pending') return null; // done already (or another runner finished it)
  const s = send.schedule;
  await db.reportScheduleSend.update({where: {id: send.id}, data: {attempts: {increment: 1}}});

  let recipients: string[] = [];
  try {
    recipients = await recipientsOf(db, s);
    if (!recipients.length) throw new ScheduleError('No recipients left');
    // The site owner is emailed by the platform; everyone else needs a mailbox to send from.
    if (recipients.some((r) => !isOwnerAddress(r)) && !(await systemAccount(db))) {
      return finish(db, send, s, {status: 'no_mailbox', error: 'No mailbox to send from: connect a shared team email account in Settings → Email', delivered: 0, recipients: 0}, opts.actor);
    }
    const email = await renderScheduleEmail(db, s, send.slotAt.getTime(), {slot: send.manual ? undefined : send.slotAt.getTime()});
    const done = new Set(strings(send.delivered));
    const base = origin(s);
    for (const to of recipients) {
      if (done.has(to)) continue; // reached on an earlier attempt
      const html = email.layout(`${base}/report-unsubscribe/${await scheduleUnsubscribeToken(s.id, to)}`);
      const sent = await sendSystemEmail(db, {to: [to], subject: email.subject, html, text: htmlToText(html), attachments: email.attachments});
      if (!sent) throw new Error('No mailbox to send from');
      done.add(to);
      // One atomic append (jsonb), so a concurrent retry can't drop an address another attempt recorded.
      await db.$executeRaw`UPDATE "ReportScheduleSend" SET "delivered" = "delivered" || to_jsonb(${to}::text) WHERE "id" = ${send.id}`;
    }
    return finish(db, send, s, {status: 'sent', delivered: done.size, recipients: recipients.length}, opts.actor, email);
  } catch (e) {
    const permanent = e instanceof ScheduleError;
    const message = (e as Error).message.slice(0, 500);
    if (!permanent && !opts.final) {
      await db.reportScheduleSend.update({where: {id: send.id}, data: {error: message}});
      throw e; // the job runner retries with backoff; `delivered` keeps it from re-sending
    }
    const delivered = strings((await db.reportScheduleSend.findUnique({where: {id: send.id}, select: {delivered: true}}))?.delivered).length;
    return finish(db, send, s, {status: 'failed', error: message, delivered, recipients: recipients.length}, opts.actor);
  }
}

async function finish(db: Db, send: ReportScheduleSend, s: ScheduleWithTarget, o: Outcome, actor?: User | null, email?: RenderedEmail): Promise<Outcome> {
  const name = targetName(s);
  const now = new Date();
  // Claim the finish once: a concurrent runner that got here first wins.
  const claimed = await db.reportScheduleSend.updateMany({
    where: {id: send.id, status: 'pending'},
    data: {status: o.status, error: o.error ?? null, recipients: o.recipients, sentAt: o.status === 'sent' ? now : null},
  });
  if (!claimed.count) return o;

  const lastStatus = o.status === 'failed' && o.delivered > 0 ? 'partial' : o.status;
  const data: Prisma.ReportScheduleUpdateInput = {lastStatus, lastError: o.error ?? null};
  if (o.status === 'sent') Object.assign(data, {lastSentAt: now, failures: 0});
  // Manual sends report their error to the person who clicked; only scheduled failures count towards pausing.
  const failures = o.status === 'failed' && !send.manual ? s.failures + 1 : s.failures;
  const pause = o.status === 'failed' && !send.manual && failures >= PAUSE_AFTER_FAILURES;
  if (o.status === 'failed' && !send.manual) data.failures = failures;
  if (pause) data.active = false;
  await db.reportSchedule.update({where: {id: s.id}, data});

  const meta = {slotAt: send.slotAt.toISOString(), manual: send.manual, status: lastStatus, recipients: o.recipients, delivered: o.delivered, error: o.error ?? undefined};
  await audit(db, null, {action: 'report_schedule.sent', entity: 'report_schedule', recordId: s.id, label: name, meta, actor: actor ? {id: actor.id, name: actor.name, email: actor.email} : null});

  if (o.status === 'sent') {
    await emit(db, 'report.sent', {
      entity: 'report',
      recordId: s.reportId ?? s.dashboardId,
      actorId: actor?.id ?? null,
      data: {
        scheduleId: s.id,
        reportId: s.reportId,
        dashboardId: s.dashboardId,
        name,
        subject: email?.subject,
        range: email?.rangeLabel,
        recipients: o.recipients,
        externalRecipients: strings(s.emails).length,
        slotAt: send.slotAt.toISOString(),
        manual: send.manual,
        ownerId: s.ownerId,
      },
    });
    return o;
  }

  // Tell the creator (in-app). "No mailbox" is said once until it changes.
  if (send.manual && actor?.id === s.ownerId) return o; // they see the error in a toast
  if (o.status === 'no_mailbox' && s.lastStatus === 'no_mailbox') return o;
  await notify(db, [s.ownerId], {
    type: 'report',
    title: pause
      ? `Scheduled email "${name}" paused after ${failures} failed sends`
      : o.status === 'no_mailbox'
        ? `Scheduled email "${name}" not sent: no mailbox to send from`
        : `Scheduled email "${name}" failed`,
    body: o.error,
    link: '/reports/schedules',
  });
  if (pause) await audit(db, null, {action: 'report_schedule.paused', entity: 'report_schedule', recordId: s.id, label: name, meta: {failures, error: o.error}});
  return o;
}

/** Job handler for `report.send`. */
export async function sendJob(db: Db, sendId: string, job: {attempts: number; maxAttempts: number}) {
  await deliverScheduleSend(db, sendId, {final: job.attempts >= job.maxAttempts});
}

/** "Send now": a manual slot at the current instant, sent right away (no retries; the error goes back to the caller). */
export async function sendNow(db: Db, scheduleId: string, actor: User) {
  const send = await db.reportScheduleSend.create({data: {scheduleId, slotAt: new Date(), manual: true, delivered: []}});
  return deliverScheduleSend(db, send.id, {final: true, actor});
}

// ─── Tick ───

/**
 * Runs from the `crm-tick` schedule: claims the latest due slot of every schedule whose
 * `nextRunAt` has passed (only the latest: a scheduler that was down for a
 * week sends one email, not seven) and moves `nextRunAt` past now. Stops at
 * `until`; the schedules not reached are still due next minute.
 */
export async function reportScheduleTick(db: Db, now = Date.now(), until = Infinity) {
  const due = await db.reportSchedule.findMany({where: {active: true, OR: [{nextRunAt: {lte: new Date(now)}}, {nextRunAt: null}]}, take: 200, orderBy: {nextRunAt: 'asc'}});
  let queued = 0;
  for (const s of due) {
    if (Date.now() > until) break;
    const slot = latestSlot(s, now);
    const floor = Math.max(s.cursor.getTime(), s.lastSlotAt?.getTime() ?? 0);
    if (slot !== null && slot > floor && s.nextRunAt) {
      // The unique (schedule, slot) row is the exactly-once guard across overlapping ticks.
      const created = await db.reportScheduleSend.createManyAndReturn({data: [{scheduleId: s.id, slotAt: new Date(slot), delivered: []}], skipDuplicates: true, select: {id: true}});
      if (created[0]) {
        await enqueue(db, 'report.send', {sendId: created[0].id});
        queued++;
      }
    }
    await db.reportSchedule.update({
      where: {id: s.id},
      data: {nextRunAt: new Date(nextSlot(s, now)), ...(slot !== null && slot > floor && s.nextRunAt ? {lastSlotAt: new Date(slot)} : {})},
    });
  }
  return {due: due.length, queued};
}

/** Prunes the fire log after 90 days (pruneJobs), in chunks until `until`. */
export async function pruneScheduleSends(db: Db, until = Date.now() + 10_000) {
  const cut = new Date(Date.now() - 90 * DAY);
  return deleteInChunks(until, (n) => db.$executeRaw`DELETE FROM "ReportScheduleSend" WHERE id IN (SELECT id FROM "ReportScheduleSend" WHERE "createdAt" < ${cut} LIMIT ${n})`);
}
