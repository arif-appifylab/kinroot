import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../../src/server/app';
import {sendJob} from '../../../src/server/crm/lib/report-schedules';
import {crmTick} from '../../../src/server/crm/lib/ticks';
import {ownerAt, resetCrm, teammate, userId} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {fakeResend, inJob, mailbox, mails, type Mail, resend, restoreResend} from './support-inbox';

/**
 * Ported from Kinroot's scripts/test-report-schedules.mjs
 * Scheduled report emails: schedule maths (zones, DST, month ends), exactly-once sending across
 * overlapping ticks, catching up once, retries without double sends, previous-period ranges, the
 * email itself, the creator's visibility, pausing after failures, "no mailbox", permissions, audit
 * entries and the `report.sent` event.
 *
 * Changed by the migration: the SMTP sink is a Resend team mailbox whose sends are captured; the
 * original's `POST /jobs/run` is `crmTick` (the platform's `crm-tick` schedule), and the platform's
 * retry of a `report.send` job is the handler called again with the next attempt number.
 */

const OWNER_EMAIL = 'owner@kinroot-port.io';
const MEMBER_EMAIL = 'member@kinroot-port.io';
const TAG = 'schedtest';
const ext = (n: number) => `client${n}@kinroot-port.io`;
const tagged = {field: 'tags', op: 'is', value: [TAG]};
const REPORT_SEND_TRIES = 4; // background.json: crm-report-send retries 3

let own: Browser;
let member: Browser;
let viewer: Browser;
let me: {id: string; name: string};
let memberUser: {id: string; name: string};
let account: {id: string};
let report: {id: string; name: string};
let privateReport: {id: string};
let valueReport: {id: string; name: string};
let dash: {id: string; name: string};

const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};

async function seed() {
  // Addresses on reserved test domains (example.com) are never emailed, and the site owner has no
  // address at all: the schedules' creator is an Owner at a real-looking one.
  ({browser: own} = await ownerAt(OWNER_EMAIL));
  await own.get('/site-api/crm/auth/state');
  await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
  ({browser: member} = await teammate(own, MEMBER_EMAIL, 'MEMBER'));
  ({browser: viewer} = await teammate(own, 'viewer@kinroot-port.io', 'VIEWER'));
  me = await db.member.findUniqueOrThrow({where: {userId: await userId(OWNER_EMAIL)}, select: {id: true, name: true}});
  memberUser = await db.member.findUniqueOrThrow({where: {userId: await userId(MEMBER_EMAIL)}, select: {id: true, name: true}});
  account = await mailbox(own, {fromName: 'Reports', fromEmail: 'reports@kinroot-port.io', shared: true});

  // Deals tagged for this run: 4 by the owner (one created 40 days ago), 2 by the member.
  for (let i = 0; i < 4; i++) await ok(own.post('/site-api/crm/deals', {title: `${TAG} owner ${i}`, value: 1000 * (i + 1), tags: [TAG]}), 201);
  for (let i = 0; i < 2; i++) await ok(member.post('/site-api/crm/deals', {title: `${TAG} member ${i}`, value: 500, tags: [TAG]}), 201);
  await db.deal.updateMany({where: {title: `${TAG} owner 0`}, data: {createdAt: new Date(Date.now() - 40 * 86_400_000)}});

  report = (await ok(own.post('/site-api/crm/reports', {name: 'Tagged deals', shared: true, config: {object: 'deals', measure: {op: 'count'}, groupBy: {field: 'owner'}, chart: 'bar', filters: {range: {preset: 'last_30'}, conditions: [tagged]}}}), 201)).report;
  privateReport = (await ok(own.post('/site-api/crm/reports', {name: 'Private', shared: false, config: {object: 'deals', measure: {op: 'count'}, chart: 'kpi', filters: {conditions: [tagged]}}}), 201)).report;
  valueReport = (await ok(own.post('/site-api/crm/reports', {name: 'Tagged value', shared: true, config: {object: 'deals', measure: {op: 'sum', field: 'value'}, chart: 'kpi', compare: true, filters: {range: {preset: 'last_30'}, conditions: [tagged]}}}), 201)).report;
  dash = (await ok(own.post('/site-api/crm/dashboards', {name: 'Sched dash', shared: true}), 201)).dashboard;
  await ok(own.post(`/site-api/crm/dashboards/${dash.id}/widgets`, {reportId: report.id}), 201);
  await ok(own.post(`/site-api/crm/dashboards/${dash.id}/widgets`, {reportId: valueReport.id}), 201);
}

const base = (extra: Record<string, unknown> = {}) => ({reportId: report.id, frequency: 'daily', time: '00:00', timezone: 'UTC', userIds: [], emails: [ext(1)], range: 'report', ...extra});
async function schedule(c: Browser, body: Record<string, unknown>) {
  return (await ok(c.post('/site-api/crm/report-schedules', body), 201)).schedule as {id: string; frequencyLabel: string; recipients: number; nextRunAt: string};
}
/** Pretend the scheduler was away: slots since 3 days ago are due. */
const makeDue = (id: string) => db.reportSchedule.update({where: {id}, data: {cursor: new Date(Date.now() - 3 * 86_400_000), nextRunAt: new Date(Date.now() - 2 * 86_400_000), lastSlotAt: null}});
/** One run of the `crm-tick` schedule; the `report.send` jobs it queues run when it ends (first try). */
const tick = () => inJob(d => crmTick(d));
/** The platform trying a `report.send` job again (`attempt` of REPORT_SEND_TRIES). */
const retry = (sendId: string, attempt: number) => inJob(d => sendJob(d, sendId, {attempts: attempt, maxAttempts: REPORT_SEND_TRIES}));
const sends = (scheduleId: string) => db.reportScheduleSend.findMany({where: {scheduleId}, orderBy: {slotAt: 'asc'}});
const sched = (id: string) => db.reportSchedule.findUniqueOrThrow({where: {id}});
const mailsFor = (subjectPart: string) => mails.filter(m => m.subject.includes(subjectPart));
const csvOf = (m: Mail, i = 0) => Buffer.from(m.attachments![i]!.content, 'base64').toString('utf8');

describe.skipIf(!DATABASE_URL)('Ported: scheduled report emails (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeAll(fakeResend);
  afterAll(async () => {
    restoreResend();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    await seed();
  });
  afterEach(() => {
    mails.length = 0;
    resend.fail = null;
  });

  it('works out the next sends: daily, weekly, monthly, time zones, DST and month ends', async () => {
    const next = async (timing: Record<string, unknown>, after: string, count = 3) => (await ok(own.post('/site-api/crm/report-schedules/next', {...timing, after, count}))).slots as string[];
    expect(await next({frequency: 'daily', time: '09:00', timezone: 'UTC'}, '2026-10-20T09:00:00.000Z')).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-22T09:00:00.000Z', '2026-10-23T09:00:00.000Z']);
    expect(await next({frequency: 'weekly', weekday: 1, time: '09:00', timezone: 'Asia/Kolkata'}, '2026-10-23T00:00:00.000Z', 2)).toEqual(['2026-10-26T03:30:00.000Z', '2026-11-02T03:30:00.000Z']);
    // Sunday 09:00 Berlin keeps 09:00 across the October DST change.
    expect(await next({frequency: 'weekly', weekday: 0, time: '09:00', timezone: 'Europe/Berlin'}, '2026-10-12T00:00:00.000Z', 3)).toEqual(['2026-10-18T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-11-01T08:00:00.000Z']);
    expect(await next({frequency: 'daily', time: '09:00', timezone: 'America/New_York'}, '2026-10-31T00:00:00.000Z', 2)).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
    // A time inside the spring-forward gap still sends once that day; one repeated in autumn sends once.
    expect(await next({frequency: 'daily', time: '02:30', timezone: 'Europe/Berlin'}, '2026-03-28T12:00:00.000Z', 2)).toEqual(['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z']);
    expect(await next({frequency: 'daily', time: '02:30', timezone: 'Europe/Berlin'}, '2026-10-24T12:00:00.000Z', 2)).toEqual(['2026-10-25T01:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    expect(await next({frequency: 'monthly', monthDay: 31, time: '09:00', timezone: 'UTC'}, '2027-01-31T12:00:00.000Z', 3)).toEqual(['2027-02-28T09:00:00.000Z', '2027-03-31T09:00:00.000Z', '2027-04-30T09:00:00.000Z']);
    expect((await next({frequency: 'monthly', monthDay: 29, time: '09:00', timezone: 'UTC'}, '2028-02-01T00:00:00.000Z', 1))[0]).toBe('2028-02-29T09:00:00.000Z');
    expect(await next({frequency: 'monthly', monthDay: -1, time: '18:00', timezone: 'UTC'}, '2026-01-15T00:00:00.000Z', 3)).toEqual(['2026-01-31T18:00:00.000Z', '2026-02-28T18:00:00.000Z', '2026-03-31T18:00:00.000Z']);
    // Sydney: the 1st falls on the UTC day before, and the offset changes in April.
    expect(await next({frequency: 'monthly', monthDay: 1, time: '00:30', timezone: 'Australia/Sydney'}, '2026-03-15T00:00:00.000Z', 2)).toEqual(['2026-03-31T13:30:00.000Z', '2026-04-30T14:30:00.000Z']);
    expect((await own.post('/site-api/crm/report-schedules/next', {frequency: 'daily', time: '09:00', timezone: 'Mars/Olympus'})).status).toBe(400);
    expect((await own.post('/site-api/crm/report-schedules/next', {frequency: 'weekly', time: '09:00', timezone: 'UTC'})).status).toBe(400);
  });

  it('validates schedules and keeps members to their own', async () => {
    expect((await own.post('/site-api/crm/report-schedules', base({emails: []}))).status).toBe(400);
    expect((await own.post('/site-api/crm/report-schedules', base({emails: ['not-an-email']}))).status).toBe(422);
    expect((await own.post('/site-api/crm/report-schedules', base({emails: Array.from({length: 21}, (_, i) => ext(i + 100))}))).status).toBe(422);
    expect((await own.post('/site-api/crm/report-schedules', base({dashboardId: dash.id}))).status).toBe(400);
    expect((await viewer.post('/site-api/crm/report-schedules', base())).status).toBe(403);
    expect((await member.post('/site-api/crm/report-schedules', base({reportId: privateReport.id}))).status).toBe(404);

    const ownerSched = await schedule(own, base({userIds: [me.id], emails: [ext(1)], note: 'Weekly numbers for the team.'}));
    expect(ownerSched.frequencyLabel).toBe('Every day at 00:00 (UTC)');
    expect(ownerSched.recipients).toBe(2);
    expect(new Date(ownerSched.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const memberSched = await schedule(member, base({emails: [ext(2)]}));
    const memberList = (await ok(member.get('/site-api/crm/report-schedules'))).rows as {id: string}[];
    expect(memberList.map(r => r.id)).toEqual([memberSched.id]);
    expect((await member.request('PATCH', `/site-api/crm/report-schedules/${ownerSched.id}`, {active: false})).status).toBe(404);
    expect((await member.post(`/site-api/crm/report-schedules/${ownerSched.id}/send`)).status).toBe(404);
    const adminList = ((await ok(own.get('/site-api/crm/report-schedules'))).rows as {id: string}[]).map(r => r.id);
    expect(adminList).toEqual(expect.arrayContaining([memberSched.id, ownerSched.id]));
    const byReport = (await ok(own.get(`/site-api/crm/report-schedules?reportId=${report.id}`))).rows as {reportId: string}[];
    expect(byReport.every(r => r.reportId === report.id)).toBe(true);
  });

  it('previews previous-period ranges, the subject, the branded email and one CSV per report', async () => {
    const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', ...o}).format(d);
    const full: Intl.DateTimeFormatOptions = {month: 'short', day: 'numeric', year: 'numeric'};
    const n = new Date();
    const today = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    const day = (k: number) => new Date(today.getTime() + k * 86_400_000);
    const span = (a: Date, b: Date) =>
      fmt(a, full) === fmt(b, full) ? fmt(a, full) : `${fmt(a, fmt(a, {year: 'numeric'}) === fmt(b, {year: 'numeric'}) ? {month: 'short', day: 'numeric'} : full)} – ${fmt(b, full)}`;
    const preview = (body: Record<string, unknown>) => ok(own.post('/site-api/crm/report-schedules/preview', body));

    expect((await preview(base({range: 'previous'}))).rangeLabel).toBe(fmt(day(-1), full));
    const lastMonday = day(-((today.getUTCDay() + 6) % 7));
    expect((await preview(base({range: 'previous', frequency: 'weekly', weekday: 1}))).rangeLabel).toBe(span(new Date(lastMonday.getTime() - 7 * 86_400_000), new Date(lastMonday.getTime() - 86_400_000)));
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    expect((await preview(base({range: 'previous', frequency: 'monthly', monthDay: 1}))).rangeLabel).toBe(span(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)), new Date(monthStart.getTime() - 86_400_000)));
    const own30 = await preview(base());
    expect(own30.rangeLabel).toBe(span(day(-29), day(0)));
    expect(own30.subject).toBe(`${report.name}: ${own30.rangeLabel}`);
    expect(own30.attachments).toHaveLength(1);
    expect(own30.html).toContain('<html');
    expect(own30.html).toContain('Open in');
    const dashboard = await preview({dashboardId: dash.id, frequency: 'daily', time: '00:00', timezone: 'UTC', emails: [ext(1)]});
    expect(dashboard.attachments).toHaveLength(2);
    expect(dashboard.html).toContain(report.name);
    expect(dashboard.html).toContain(valueReport.name);
  });

  it('sends once across overlapping ticks after missed days, with the numbers, bars, links and CSV', async () => {
    const ownerSched = await schedule(own, base({userIds: [me.id], emails: [ext(1)], note: 'Weekly numbers for the team.'}));
    await makeDue(ownerSched.id);
    await Promise.all([tick(), tick(), tick()]); // overlapping ticks
    let rows = await sends(ownerSched.id);
    expect(rows.map(r => r.status)).toEqual(['sent']);
    const n = new Date();
    expect(rows[0]!.slotAt.toISOString()).toBe(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString());
    expect(mails.map(m => m.to.join()).sort()).toEqual([ext(1), OWNER_EMAIL].sort());
    await Promise.all([tick(), tick()]);
    rows = await sends(ownerSched.id);
    expect(rows).toHaveLength(1);
    expect(mails).toHaveLength(2);
    const row = await sched(ownerSched.id);
    expect(row).toMatchObject({lastStatus: 'sent', failures: 0});
    expect(row.lastSentAt).toBeTruthy();
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    const mail = mailsFor(report.name).find(m => m.to.includes(ext(1)))!;
    expect(mail, 'external recipient got the email').toBeTruthy();
    const html = mail.html!;
    expect(html).toContain('Weekly numbers for the team.');
    expect(html).toMatch(/Total number of deals[\s\S]*?>5</);
    expect(html).toContain('▲ 400%'); // 1 → 5 against the previous period
    expect(html).toMatch(/vs [A-Z][a-z]{2} \d+/);
    expect(html).toContain(`>${me.name}</td>`);
    expect(html).toContain(`>${memberUser.name}</td>`);
    const widths = [...html.matchAll(/<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="([\d.]+)%"/g)].map(m => Number(m[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBe(100);
    expect(Math.abs(widths[1]! - 66.7)).toBeLessThan(0.1);
    expect(html).toContain('background:#2a78d6');
    expect(html).toContain(`/reports/${report.id}"`);
    expect(html).toContain('Open in ');
    const unsub = html.match(/href="([^"]*\/report-unsubscribe\/[^"]+)"/)?.[1];
    expect(unsub, 'unsubscribe link in the footer').toBeTruthy();
    const file = mail.attachments![0]!;
    expect(file.filename.startsWith('tagged-deals') && file.filename.endsWith('.csv')).toBe(true);
    const csv = csvOf(mail);
    expect(csv.split('\r\n')[0]).toBe('Owner,Number of deals');
    expect(csv).toContain(`${memberUser.name},2`);
    expect(mail.text).toContain('Total number of deals');

    // Unsubscribe: the link's state with a masked address, a tampered token refused, only that address leaves.
    const token = unsub!.split('/report-unsubscribe/')[1]!;
    // AUDIT-2 L-10: the link names the recipient by a keyed hash, never the address (not even encoded).
    expect(token).toMatch(/^r\.[a-z0-9]+\.[\w-]{22}$/i);
    expect(token).not.toContain(Buffer.from(ext(1)).toString('base64url').slice(0, 12));
    const guest = new Browser(app, '198.51.100.50');
    const state = await guest.get(`/site-api/crm/public/report-unsubscribe/${token}`);
    expect(state.status).toBe(200);
    expect(state.json.subscribed).toBe(true);
    expect(String(state.json.email)).not.toContain('client1');
    expect((await guest.get(`/site-api/crm/public/report-unsubscribe/${token}x`)).status).toBe(404);
    await ok(guest.post(`/site-api/crm/public/report-unsubscribe/${token}`));
    const after = await sched(ownerSched.id);
    expect(after.emails).not.toContain(ext(1));
    expect(after.userIds).toContain(me.id);
  });

  it('links the email to the report’s CRM screen (/crm/reports/<id>)', async () => {
    const s = await schedule(own, base());
    await ok(own.post(`/site-api/crm/report-schedules/${s.id}/send`));
    expect(mails[0]!.html).toContain(`/crm/reports/${report.id}"`);
  });

  it('sends a dashboard with every report, one CSV each, a dashboard link and currency KPIs', async () => {
    const dashSched = await schedule(own, {dashboardId: dash.id, frequency: 'weekly', weekday: 1, time: '08:00', timezone: 'UTC', emails: [ext(3)]});
    await ok(own.post(`/site-api/crm/report-schedules/${dashSched.id}/send`));
    const [dmail] = mailsFor(dash.name);
    expect(dmail!.attachments).toHaveLength(2);
    expect(dmail!.html).toContain(`/reports/dashboards/${dash.id}"`);
    expect(dmail!.html!.includes('$11,000') || dmail!.html!.includes('$10,000')).toBe(true);
  });

  it('shows external recipients only what the schedule’s creator can see', async () => {
    const memberSched = await schedule(member, base({emails: [ext(2)]}));
    await ok(own.request('PATCH', '/site-api/crm/settings', {recordVisibility: 'owner'}));
    await ok(member.post(`/site-api/crm/report-schedules/${memberSched.id}/send`));
    const mmail = mailsFor(report.name).find(m => m.to.includes(ext(2)))!;
    expect(mmail.html).toMatch(/Total number of deals[\s\S]*?>2</);
    expect(mmail.html).not.toContain(`>${me.name}</td>`);
    expect(csvOf(mmail).trim().split('\r\n')).toHaveLength(2);
  });

  it('leaves a send pending after a provider error and retries it without emailing anyone twice', async () => {
    const retrySched = await schedule(own, base({emails: [ext(4), ext(5)], subject: 'Retry'}));
    resend.fail = 503;
    await makeDue(retrySched.id);
    await tick();
    let [send] = await sends(retrySched.id);
    expect(send!.status).toBe('pending');
    expect(send!.error).toMatch(/503|try again/i);
    resend.fail = null;
    await retry(send!.id, 2);
    [send] = await sends(retrySched.id);
    expect(send!.status).toBe('sent');
    expect(mailsFor('Retry')).toHaveLength(2);

    // A retry after a partial send skips who already got it.
    const partial = await db.reportScheduleSend.create({data: {scheduleId: retrySched.id, slotAt: new Date(Date.now() - 3_600_000), status: 'pending', delivered: [ext(4)]}});
    await retry(partial.id, 2);
    const got = mailsFor('Retry');
    expect(got).toHaveLength(3);
    expect(got[2]!.to).toEqual([ext(5)]);
    expect((await db.reportScheduleSend.findUniqueOrThrow({where: {id: partial.id}})).delivered, 'each address appended once (jsonb), the earlier one kept').toEqual([ext(4), ext(5)]);
  });

  it('pauses after three failed sends in a row, tells the creator, and resumes from now', async () => {
    const failSched = await schedule(own, base({emails: [ext(6)], subject: 'Failing'}));
    resend.fail = 503;
    for (let i = 0; i < 3; i++) {
      await db.reportScheduleSend.deleteMany({where: {scheduleId: failSched.id}});
      await makeDue(failSched.id);
      await tick(); // first try fails, a retry would follow
      const [f] = await sends(failSched.id);
      await retry(f!.id, REPORT_SEND_TRIES); // the last try: no retry follows
    }
    resend.fail = null;
    let row = await sched(failSched.id);
    expect(row).toMatchObject({active: false, failures: 3, lastStatus: 'failed'});
    expect(row.lastError).toBeTruthy();
    const notes = await db.notification.findMany({where: {userId: me.id, type: 'report', title: {contains: report.name}}, select: {title: true}});
    expect(notes).toHaveLength(3);
    expect(notes.some(n => /paused/.test(n.title))).toBe(true);
    expect(mailsFor('Failing')).toHaveLength(0);
    await ok(own.request('PATCH', `/site-api/crm/report-schedules/${failSched.id}`, {active: true}));
    row = await sched(failSched.id);
    expect(row.active).toBe(true);
    expect(row.failures).toBe(0);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.cursor.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('records "No mailbox to send from" and tells the creator once', async () => {
    const ownerSched = await schedule(own, base({userIds: [me.id]}));
    const memberSched = await schedule(member, base({emails: [ext(2)]}));
    await db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR'}});
    const noBox = await member.post(`/site-api/crm/report-schedules/${memberSched.id}/send`);
    expect(noBox.status).toBe(400);
    expect(String(noBox.json.error)).toMatch(/No mailbox/i);
    await makeDue(ownerSched.id);
    await tick();
    const row = await sched(ownerSched.id);
    expect(row).toMatchObject({lastStatus: 'no_mailbox', active: true, failures: 0});
    expect(await db.notification.count({where: {userId: me.id, type: 'report', title: {contains: 'no mailbox'}}})).toBe(1);
    const list = (await ok(own.get('/site-api/crm/report-schedules'))).rows as {id: string; statusLabel: string}[];
    expect(list.find(r => r.id === ownerSched.id)!.statusLabel).toBe('No mailbox to send from');
  });

  it('audits every change and send (System for scheduled ones) and emits report.sent', async () => {
    const ownerSched = await schedule(own, base({userIds: [me.id], emails: [ext(1)], note: 'Weekly numbers for the team.'}));
    const memberSched = await schedule(member, base({emails: [ext(2)]}));
    const dashSched = await schedule(own, {dashboardId: dash.id, frequency: 'weekly', weekday: 1, time: '08:00', timezone: 'UTC', emails: [ext(3)]});
    const failSched = await schedule(own, base({emails: [ext(6)], subject: 'Failing'}));
    await makeDue(ownerSched.id);
    await tick();
    await ok(member.post(`/site-api/crm/report-schedules/${memberSched.id}/send`));
    // Unsubscribe the external address of the owner's schedule.
    const unsub = mails.find(m => m.to.includes(ext(1)))!.html!.match(/\/report-unsubscribe\/([^"]+)"/)![1]!;
    await ok(new Browser(app, '198.51.100.51').post(`/site-api/crm/public/report-unsubscribe/${unsub}`));
    // Three final failures pause the failing one; resuming is audited.
    resend.fail = 503;
    for (let i = 0; i < 3; i++) {
      await db.reportScheduleSend.deleteMany({where: {scheduleId: failSched.id}});
      await makeDue(failSched.id);
      await tick();
      const [f] = await sends(failSched.id);
      await retry(f!.id, REPORT_SEND_TRIES);
    }
    resend.fail = null;
    await ok(own.request('PATCH', `/site-api/crm/report-schedules/${failSched.id}`, {active: true}));
    await ok(own.request('PATCH', `/site-api/crm/report-schedules/${ownerSched.id}`, {time: '07:30'}));
    await ok(own.delete(`/site-api/crm/report-schedules/${dashSched.id}`));

    const ids = [ownerSched.id, memberSched.id, dashSched.id, failSched.id];
    const audits = await db.auditLog.findMany({where: {entity: 'report_schedule', recordId: {in: ids}}, select: {action: true, actorName: true}});
    for (const action of ['report_schedule.created', 'report_schedule.updated', 'report_schedule.deleted', 'report_schedule.sent', 'report_schedule.paused', 'report_schedule.resumed', 'report_schedule.unsubscribed']) {
      expect(audits.some(a => a.action === action), `audit: ${action}`).toBe(true);
    }
    expect(audits.some(a => a.action === 'report_schedule.sent' && a.actorName === null)).toBe(true);
    expect(audits.some(a => a.action === 'report_schedule.sent' && a.actorName === memberUser.name)).toBe(true);
    const events = await db.event.findMany({where: {type: 'report.sent'}, select: {data: true}});
    const data = events.map(e => e.data as {scheduleId: string; reportId: string; recipients: number; manual: boolean});
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.some(e => e.scheduleId === ownerSched.id && e.reportId === report.id && e.recipients === 2 && e.manual === false)).toBe(true);
    expect(data.some(e => e.scheduleId === failSched.id)).toBe(false);
    const upd = await sched(ownerSched.id);
    expect(upd.time).toBe('07:30');
    expect([upd.nextRunAt!.getUTCHours(), upd.nextRunAt!.getUTCMinutes()]).toEqual([7, 30]);
    expect(upd.userIds).toContain(me.id);
    expect(upd).toMatchObject({range: 'report', note: 'Weekly numbers for the team.'});
  });
});
