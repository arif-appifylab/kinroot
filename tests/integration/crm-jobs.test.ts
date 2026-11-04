import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {runsJobsLocally} from '../../src/platform/background';
import {encryptJson} from '../../src/server/crm/kit/crypto';
import type {Db} from '../../src/server/crm/kit/db';
import {advanceRun, automationTick, queueRun, runBatch, startRun} from '../../src/server/crm/lib/automations';
import {emit, emitMany} from '../../src/server/crm/lib/events';
import {drainBacklog, enqueue, FAILED_KEEP_DAYS, pruneJobs, RATE_WAIT, withOutbox} from '../../src/server/crm/lib/jobs';
import {crmSync} from '../../src/server/crm/lib/ticks';
import {deliverWebhooks} from '../../src/server/crm/lib/webhooks';
import {queueAccountSync} from '../../src/server/crm/email/sync';
import {resetCrm} from './support/crm';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's background jobs on the LIVE path (not the Preview's local runs): the platform's job API
 * is faked at `fetch` with its rules (10 new jobs a minute by default, a batch over the limit refused
 * whole with E_JOBS_RATE_LIMITED, a too-large job refused before anything is sent), and the site runs
 * as a production build with a Site Key, so `runsJobsLocally()` is false and nothing runs in-process.
 */

const PLATFORM = 'https://platform.example.test';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

type Job = {list: string; data: Record<string, unknown>; key?: string; label?: string; at?: string};

/** The platform's job API, as far as Kinroot uses it. */
const platform = {
  /** Every job it accepted, and the size of every accepted call. */
  jobs: [] as Job[],
  calls: [] as number[],
  limit: 10,
  used: 0,
  /** Refuse the next calls as over the rate, with this message. */
  rateLimited: null as string | null,
  reset() {
    this.jobs.length = 0;
    this.calls.length = 0;
    this.limit = 10;
    this.used = 0;
    this.rateLimited = null;
  },
  /** "The minute turns": the platform's count and Kinroot's shared counter start again. */
  async nextMinute() {
    this.used = 0;
    await db.setting.deleteMany({where: {key: 'jobs.rate'}});
  },
  sent: (list: string) => platform.jobs.filter((j) => j.list === list),
};

/** What one webhook service received, and how it answers (per path). */
const hooks = {hits: [] as string[], fail: new Set<string>()};

const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({errors: [{code, message}]}), {status, headers: {'content-type': 'application/json', ...headers}});

function fakePlatformJobs() {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === PLATFORM && url.pathname === '/api/site/v1/jobs' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as {jobs?: Job[]} & Job;
      const batch = body.jobs ?? [body];
      if (platform.rateLimited) return error(429, 'E_JOBS_RATE_LIMITED', platform.rateLimited, {'retry-after': '30'});
      // A batch over this minute's limit is refused whole (docs/agent/background-jobs.md).
      if (platform.used + batch.length > platform.limit) return error(429, 'E_JOBS_RATE_LIMITED', 'Too many new jobs this minute; try again in 30 s.', {'retry-after': '30'});
      platform.used += batch.length;
      platform.jobs.push(...batch);
      platform.calls.push(batch.length);
      const sent = batch.map((j, i) => ({id: `job_${platform.jobs.length}_${i}`, list: j.list, runAt: new Date().toISOString(), deduplicated: false}));
      return new Response(JSON.stringify({data: body.jobs ? {jobs: sent} : sent[0]}), {status: 201, headers: {'content-type': 'application/json'}});
    }
    if (url.hostname === 'hooks.zapier.com') {
      hooks.hits.push(url.pathname);
      return new Response('ok', {status: hooks.fail.has(url.pathname) ? 500 : 200});
    }
    return previous(input, init);
  };
}

/** Runs `work` as a platform job would: its own request scope and Site Database client, its jobs sent when it ends. */
function inJob<T>(work: (db: Db) => Promise<T>): Promise<T> {
  return inRequestScope(async () => {
    try {
      return await withOutbox(() => work(getDb() as unknown as Db));
    } finally {
      await getDb()?.$disconnect();
    }
  });
}

const backlog = () => db.jobBacklog.findMany({orderBy: [{runAt: 'asc'}, {createdAt: 'asc'}]});

async function member(role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'ADMIN') {
  return db.member.create({data: {name: `Ann ${role}`, role}});
}

describe.skipIf(!DATABASE_URL)('Kinroot background jobs on the platform (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
    fakePlatformJobs();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    platform.reset();
    hooks.hits.length = 0;
    hooks.fail.clear();
    // The live site: a production build with a Site Key sends jobs to the platform.
    vi.stubEnv('PROD', true);
    expect(runsJobsLocally()).toBe(false);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends at most the rate (10 a minute) from a burst of 50; the rest waits and goes out as the minutes turn', async () => {
    await inJob(async (d) => {
      for (let i = 0; i < 50; i++) await enqueue(d, 'inbox.wake', {threadId: `t${i}`});
    });
    expect(platform.jobs).toHaveLength(10);
    expect(Math.max(...platform.calls)).toBeLessThanOrEqual(10);
    expect(platform.jobs[0]!.label).toBe('Snoozed conversation');
    let rows = await backlog();
    expect(rows).toHaveLength(40);
    const nextMinute = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
    for (const r of rows) {
      expect(r.failedAt).toBeNull();
      expect(r.lastError).toBe(RATE_WAIT);
      expect(r.runAt.getTime()).toBeGreaterThanOrEqual(nextMinute - 60_000);
    }
    // The order is kept: the first ten went, the eleventh waits first.
    expect((rows[0]!.data as {threadId: string}).threadId).toBe('t10');

    // Minute after minute, ten at a time, until none waits.
    for (let minute = 1; minute <= 4; minute++) {
      await platform.nextMinute();
      await db.jobBacklog.updateMany({data: {runAt: ago(1000)}});
      expect(await inJob((d) => drainBacklog(d))).toBe(10);
      expect(Math.max(...platform.calls)).toBeLessThanOrEqual(10);
    }
    rows = await backlog();
    expect(rows).toHaveLength(0);
    expect(new Set(platform.jobs.map((j) => j.data.threadId)).size).toBe(50);
  });

  it('follows the rate the owner set (raised to 50 in the Jobs tab)', async () => {
    platform.limit = 50;
    await db.setting.create({data: {key: 'jobs.perMinute', value: 50}});
    await inJob(async (d) => {
      for (let i = 0; i < 50; i++) await enqueue(d, 'inbox.wake', {threadId: `t${i}`});
    });
    expect(platform.jobs).toHaveLength(50);
    expect(await backlog()).toHaveLength(0);
  });

  it('a refusal for the rate (429) pushes the rows past Retry-After without counting a try, and holds every send this minute', async () => {
    await db.jobBacklog.createMany({data: [1, 2, 3].map((n) => ({list: 'crm-inbox-wake', data: {threadId: `t${n}`}, runAt: ago(1000)}))});
    platform.rateLimited = 'Too many new jobs this minute; try again in 30 s.';
    const before = Date.now();
    expect(await inJob((d) => drainBacklog(d))).toBe(0);
    const rows = await backlog();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.runAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      expect(r.attempts).toBe(0);
      expect(r.failedAt).toBeNull();
      expect(r.lastError).toMatch(/^Waiting for the job rate limit/);
    }
    // The platform said the minute is full: a new job waits too, without asking again.
    platform.rateLimited = null;
    await inJob((d) => enqueue(d, 'inbox.wake', {threadId: 'later'}));
    expect(platform.jobs).toHaveLength(0);
    expect(await db.jobBacklog.count()).toBe(4);
  });

  it('a job the platform refuses for good is set aside alone; the others are sent and the drain skips it', async () => {
    const big = 'x'.repeat(33 * 1024);
    await db.jobBacklog.createMany({
      data: [
        {list: 'crm-inbox-wake', data: {threadId: 'a'}, runAt: ago(3000)},
        {list: 'crm-inbox-wake', data: {threadId: big}, runAt: ago(2000)},
        {list: 'crm-inbox-wake', data: {threadId: 'c'}, runAt: ago(1000)},
      ],
    });
    expect(await inJob((d) => drainBacklog(d))).toBe(2);
    expect(platform.jobs.map((j) => j.data.threadId)).toEqual(['a', 'c']);
    const rows = await backlog();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failedAt).not.toBeNull();
    expect(rows[0]!.lastError).toMatch(/^E_JOBS_PAYLOAD_TOO_LARGE/);
    // Set aside: never sent again.
    await platform.nextMinute();
    expect(await inJob((d) => drainBacklog(d))).toBe(0);
    expect(platform.jobs).toHaveLength(2);

    // The same from a request's outbox: only the bad job fails.
    await inJob(async (d) => {
      await enqueue(d, 'inbox.wake', {threadId: 'd'});
      await enqueue(d, 'inbox.wake', {threadId: big});
    });
    expect(platform.jobs.map((j) => j.data.threadId)).toEqual(['a', 'c', 'd']);
    expect(await db.jobBacklog.count({where: {failedAt: {not: null}}})).toBe(2);
  });

  it('never deletes a waiting job for its age; set-aside ones go after 30 days', async () => {
    const waiting = await db.jobBacklog.create({data: {list: 'crm-inbox-wake', data: {threadId: 'old'}, runAt: ago(1000), createdAt: ago(60 * DAY)}});
    const recentFail = await db.jobBacklog.create({data: {list: 'crm-inbox-wake', data: {}, failedAt: ago(10 * DAY), createdAt: ago(60 * DAY)}});
    await db.jobBacklog.create({data: {list: 'crm-inbox-wake', data: {}, failedAt: ago((FAILED_KEEP_DAYS + 1) * DAY), createdAt: ago(60 * DAY)}});
    await inJob((d) => pruneJobs(d));
    expect((await backlog()).map((r) => r.id).sort()).toEqual([waiting.id, recentFail.id].sort());
  });

  it('queues ONE webhook job per event for all its hooks, and retries only the deliveries that failed', async () => {
    const secret = await encryptJson('whsec_test');
    const urls = ['a', 'b', 'c'].map((p) => `https://hooks.zapier.com/hooks/catch/1/${p}/`);
    for (const url of urls) await db.webhook.create({data: {url, events: ['contact.created'], secret}});

    const event = await inJob((d) => emit(d, 'contact.created', {recordId: 'c1', data: {id: 'c1'}}));
    const jobs = platform.sent('crm-webhook-deliver');
    expect(jobs).toEqual([expect.objectContaining({data: {eventId: event!.id}, label: 'Webhook delivery'})]);
    expect(await db.webhookDelivery.count({where: {eventId: event!.id}})).toBe(3);

    // A bulk change: five events, three hooks each, still one job.
    await inJob((d) => emitMany(d, 'contact.created', [1, 2, 3, 4, 5].map((n) => ({recordId: `m${n}`, data: {id: `m${n}`}}))));
    expect(platform.sent('crm-webhook-deliver')).toHaveLength(2);
    expect((platform.sent('crm-webhook-deliver')[1]!.data.eventIds as string[]).length).toBe(5);

    // The job: every hook of the event; one answers 500 → the job is retried, the others are done.
    hooks.fail.add('/hooks/catch/1/b/');
    await expect(inJob((d) => deliverWebhooks(d, {eventId: event!.id}, false))).rejects.toThrow(/1 of 3/);
    const after = await db.webhookDelivery.findMany({where: {eventId: event!.id}, include: {webhook: {select: {url: true}}}});
    expect(after.filter((x) => x.status === 'SUCCESS')).toHaveLength(2);
    expect(after.find((x) => x.webhook.url.endsWith('/b/'))?.status).toBe('PENDING');
    // The last try sends only the failed one, and marks it failed for good.
    hooks.hits.length = 0;
    await expect(inJob((d) => deliverWebhooks(d, {eventId: event!.id}, true))).rejects.toThrow();
    expect(hooks.hits).toEqual(['/hooks/catch/1/b/']);
    expect((await db.webhookDelivery.findMany({where: {eventId: event!.id, status: 'FAILED'}})).length).toBe(1);
  });

  it('keys every run job by its run, rescues only stalled runs, and never runs one run twice at once', async () => {
    const a = await db.automation.create({data: {name: 'Manual', enabled: true, object: 'none', triggerKind: 'manual', trigger: {kind: 'manual', conditions: {match: 'all', blocks: []}}, steps: []}});
    const started = await inJob((d) => startRun(d, a, {recordId: null, source: 'manual', explicit: true}));
    expect(platform.sent('crm-automation-run').map((j) => j.key)).toEqual([`run-${started.run!.id}-start`]);
    // A retried job finding its run again queues the same key (the platform keeps one).
    await inJob((d) => queueRun(d, started.run!.id, 'start'));
    expect(new Set(platform.sent('crm-automation-run').map((j) => j.key)).size).toBe(1);
    await db.automationRun.deleteMany();
    platform.reset();

    const run = (data: Record<string, unknown>) => db.automationRun.create({data: {automationId: a.id, object: 'none', status: 'running', source: 'manual', chainId: 'c1', startedAt: ago(30 * 60_000), ...data}});
    // Started half an hour ago but its last step finished a minute ago: healthy.
    const moving = await run({});
    await db.automationRunStep.create({data: {runId: moving.id, stepId: 's1', type: 'notify', status: 'done', startedAt: ago(70_000), finishedAt: ago(60_000)}});
    // No progress for half an hour: stalled.
    const stalled = await run({});
    // Its job is retrying with the platform's backoff: left alone for now.
    const retrying = await run({error: 'Retrying: Webhook answered HTTP 503'});
    await db.automationRunStep.create({data: {runId: retrying.id, stepId: 's1', type: 'webhook', status: 'running', startedAt: ago(20 * 60_000)}});
    // Its job waits here for the job rate: not queued twice.
    const queued = await run({});
    await db.jobBacklog.create({data: {list: 'crm-automation-run', data: {runId: queued.id}, runAt: new Date(Date.now() + 60_000)}});

    const tick = await inJob((d) => automationTick(d));
    expect(tick.rescued).toBe(1);
    const rescue = platform.sent('crm-automation-run');
    expect(rescue).toHaveLength(1);
    expect(rescue[0]!.data).toEqual({runId: stalled.id});
    expect(rescue[0]!.key).toMatch(new RegExp(`^run-${stalled.id}-p\\d+-\\d+$`));

    // The run lease: while another job holds the run, this one does nothing.
    await db.setting.create({data: {key: `lock:run:${stalled.id}`, value: {}}});
    await inJob((d) => advanceRun(d, stalled.id, {attempts: 1, maxAttempts: 6}));
    expect((await db.automationRun.findUniqueOrThrow({where: {id: stalled.id}})).status).toBe('running');
    // A lease left by a job that died runs out; then the run goes on (no steps: done) and lets go of it.
    await db.$executeRaw`UPDATE "Setting" SET "updatedAt" = ${ago(5 * 60_000)} WHERE key = ${`lock:run:${stalled.id}`}`;
    await inJob((d) => advanceRun(d, stalled.id, {attempts: 1, maxAttempts: 6}));
    expect((await db.automationRun.findUniqueOrThrow({where: {id: stalled.id}})).status).toBe('done');
    expect(await db.setting.findUnique({where: {key: `lock:run:${stalled.id}`}})).toBeNull();
  });

  it('runs an automation on a list in steps of 10, advancing runs inline, and stops when the member who started it is gone', async () => {
    const me = await member('ADMIN');
    const a = await db.automation.create({data: {name: 'On a list', enabled: true, object: 'contact', triggerKind: 'manual', trigger: {kind: 'manual', conditions: {match: 'all', blocks: []}}, steps: []}});
    const list = await db.contactList.create({data: {name: 'Everyone'}});
    for (let i = 0; i < 25; i++) {
      const c = await db.contact.create({data: {firstName: `P${String(i).padStart(2, '0')}`}});
      await db.contactListMember.create({data: {listId: list.id, contactId: c.id}});
    }
    const p = {automationId: a.id, listId: list.id, userId: me.id, batchId: 'b1', after: null};
    await inJob((d) => runBatch(d, p));
    const runs = await db.automationRun.findMany();
    expect(runs).toHaveLength(10);
    expect(runs.every((r) => r.status === 'done')).toBe(true);
    // No job per run: they ran here. One job for the next step, with the cursor.
    expect(platform.sent('crm-automation-run')).toHaveLength(0);
    const next = platform.sent('crm-automation-batch');
    expect(next).toHaveLength(1);
    expect(next[0]!.data.after).toBeTruthy();

    await inJob((d) => runBatch(d, next[0]!.data));
    expect(await db.automationRun.count()).toBe(20);

    // Deactivated meanwhile: the rest never runs.
    await db.member.update({where: {id: me.id}, data: {active: false}});
    const last = platform.sent('crm-automation-batch')[1]!;
    await inJob((d) => runBatch(d, last.data));
    expect(await db.automationRun.count()).toBe(20);
    expect(platform.sent('crm-automation-batch')).toHaveLength(2);
  });

  it('date triggers start a capped number of runs per tick and go on from the last one handled', async () => {
    const pipeline = await db.pipeline.create({data: {name: 'Sales'}});
    const stage = await db.stage.create({data: {pipelineId: pipeline.id, name: 'New'}});
    for (let i = 0; i < 12; i++) await db.deal.create({data: {title: `D${i}`, pipelineId: pipeline.id, stageId: stage.id, expectedCloseDate: ago((3 + i) * 60_000 + 3_600_000)}});
    const a = await db.automation.create({
      data: {name: 'Closing', enabled: true, object: 'deal', triggerKind: 'date', trigger: {kind: 'date', source: 'record', field: 'expectedCloseDate', amount: 1, unit: 'hours', direction: 'after'}, steps: [], enabledAt: ago(DAY)},
    });
    const first = await inJob((d) => automationTick(d, {cap: 5}));
    expect(first.fired).toBe(5);
    expect(await db.automationFire.count()).toBe(5);
    const cursor = (await db.automation.findUniqueOrThrow({where: {id: a.id}})).cursorAt!;
    expect(cursor.getTime()).toBeLessThan(Date.now() - 60_000);
    // The run exists before its fire mark; every run of this tick went on inline (no steps: done).
    expect(await db.automationRun.count({where: {status: 'done'}})).toBe(5);

    await inJob((d) => automationTick(d, {cap: 5}));
    await inJob((d) => automationTick(d, {cap: 5}));
    expect(await db.automationFire.count()).toBe(12);
    expect(await db.automationRun.count()).toBe(12);
    expect(new Set((await db.automationRun.findMany({select: {recordId: true}})).map((r) => r.recordId)).size).toBe(12);
  });

  it('mailbox and calendar sync: one keyed job per Gmail / Outlook account and per calendar that logs meetings', async () => {
    const me = await member('ADMIN');
    const creds = await encryptJson({accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + DAY});
    const account = (provider: 'GMAIL' | 'OUTLOOK' | 'SMTP', n: number, lastSyncedAt: Date | null) =>
      db.emailAccount.create({data: {provider, label: `Box ${n}`, fromName: 'Ann', fromEmail: `box${n}@example.test`, credentials: creds, lastSyncedAt}});
    const newer = await account('GMAIL', 1, ago(60_000));
    const older = await account('OUTLOOK', 2, ago(DAY));
    await account('SMTP', 3, null);
    const cal = await db.calendarConnection.create({data: {userId: me.id, provider: 'google', email: 'ann@example.test', credentials: creds}});
    await db.calendarConnection.create({data: {userId: me.id, provider: 'microsoft', email: 'ann@example.test', credentials: creds, syncMeetings: false}});

    await inJob((d) => crmSync(d));
    const slot = Math.floor(Date.now() / 300_000);
    // Synced longest ago first; SMTP accounts only send.
    expect(platform.sent('crm-email-sync-account').map((j) => [j.data.accountId, j.key])).toEqual([
      [older.id, `sync-${older.id}-${slot}`],
      [newer.id, `sync-${newer.id}-${slot}`],
    ]);
    expect(platform.sent('crm-calendar-sync-connection').map((j) => [j.data.connectionId, j.key, j.label])).toEqual([[cal.id, `sync-${cal.id}-${slot}`, 'Calendar sync']]);

    // "Sync now": one job for that mailbox.
    await inJob((d) => queueAccountSync(d, newer.id));
    expect(platform.sent('crm-email-sync-account').at(-1)).toEqual(expect.objectContaining({data: {accountId: newer.id}, key: expect.stringMatching(new RegExp(`^sync-${newer.id}-m\\d+$`))}));
  });
});
