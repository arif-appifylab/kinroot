// Ported from Kinroot's scripts/test-automation-tests.mjs
// Covers test runs in the automation editor: quick (dry, short waits), timed, for real on a record, drafts, stats, stop, permissions.
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {env} from '../support/cloudflare-workers';
import {resetCrm, teammate} from '../support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {crmOwner, fakeOutbound, type Member, must, outbound, wakeBacklog, wakeRun, ZAPIER} from './support';

/**
 * One scenario, in order, as the original script ran it. What changed: the mailbox is Resend (key from
 * the owner secret RESEND_API_KEY) and the webhook a Zapier URL, both faked at `fetch`; jobs run
 * in-process when sent, and a wait is a job kept in `JobBacklog` until due, so "time passes" by
 * making it due (`wakeRun`) instead of sleeping or polling for real seconds.
 */

type Run = {id: string; recordId: string; recordLabel: string; test: string | null; source: string; status: string; error: string | null};
type RunStep = {stepId: string; startedAt: string; finishedAt: string | null; output: {branch?: string; summary?: string; testWaitMs?: number} | null};
type RunDetail = Run & {steps: RunStep[]; automation: {steps: {id: string}[]}};
type Started = {run: Run; conditions: {ok: boolean}};

const TAG = 'autotest';
const DAY = 86_400_000;

describe.skipIf(!DATABASE_URL)('Ported: automation test runs (integration, real Postgres)', () => {
  let owner: Browser;
  let me: Member;
  let ann: {id: string};
  let bob: {id: string};
  let saved: {id: string};
  let draft: Record<string, unknown> & {steps: ({id: string} & Record<string, unknown>)[]};
  let before: Awaited<ReturnType<typeof snapshot>>;

  const runRow = (id: string) => db.automationRun.findUniqueOrThrow({where: {id}});
  const poll = async (id: string) => must<{run: RunDetail}>(await owner.get(`/site-api/crm/automations/runs/${id}`), 'poll run').run;
  const tagsOf = async (id: string) => (await db.contact.findUnique({where: {id}, select: {tags: true}}))?.tags ?? [];
  const startTest = async (body: Record<string, unknown>) => owner.post(`/site-api/crm/automations/${saved.id}/tests`, body);
  async function snapshot() {
    return {
      annTags: await tagsOf(ann.id),
      tasks: await db.task.count({where: {title: {contains: 'Call '}}}),
      mails: outbound.mails.length,
      hooks: outbound.hooks.length,
      annActivities: await db.activity.count({where: {contactId: ann.id}}),
    };
  }

  beforeAll(async () => {
    configureEnv();
    fakeOutbound();
    env.RESEND_API_KEY = 're_test_key';
    await resetCrm();
    outbound.reset();
    ({browser: owner, me} = await crmOwner());
    const box = must(await owner.post('/site-api/crm/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'Owner', fromEmail: 'owner@kinroot-mail.dev', isDefault: true}}), 'mailbox').account as {status: string; lastError: string | null};
    expect(box.status, String(box.lastError)).toBe('CONNECTED');

    // Ann matches the trigger conditions (tagged); Bob is newer but doesn't.
    ann = must(await owner.post('/site-api/crm/contacts', {firstName: 'Ann', lastName: 'Tester', email: 'ann@kinroot-mail.dev', tags: [TAG], ownerId: me.id}), 'ann').contact as {id: string};
    await new Promise((r) => setTimeout(r, 20));
    bob = must(await owner.post('/site-api/crm/contacts', {firstName: 'Bob', lastName: 'Tester', email: 'bob@kinroot-mail.dev', tags: [], ownerId: me.id}), 'bob').contact as {id: string};

    const conditions = {match: 'all', blocks: [{target: 'contact', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'tags', op: 'has_any', values: [TAG]}]}]}}]};
    const vip = {match: 'all', blocks: [{target: 'contact', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'firstName', op: 'is', value: 'Ann'}]}]}}]};
    // Saved: an empty, switched-off automation. The draft below is never saved.
    saved = must(await owner.post('/site-api/crm/automations', {name: 'Tests', object: 'contact', timezone: 'UTC', trigger: {kind: 'event', event: 'contact.updated', filter: {}, conditions}, steps: []}), 'create').automation as {id: string};
    draft = {
      name: 'Tests',
      object: 'contact',
      timezone: 'UTC',
      trigger: {kind: 'event', event: 'contact.updated', filter: {}, conditions},
      steps: [
        {id: 'if1', type: 'if', conditions: vip, then: [{id: 'tag', type: 'add_tag', target: 'contact', tag: 'tested'}], else: [{id: 'nope', type: 'notify', assignee: 'creator', title: 'Not Ann'}]},
        {id: 'wait', type: 'wait', waitMode: 'duration', amount: 2, unit: 'days'},
        {id: 'task', type: 'create_task', title: 'Call {{contact.first_name}}', dueDays: 1, assignee: 'owner'},
        {id: 'mail', type: 'send_email', subject: 'Hello {{contact.first_name}}', html: '<p>Hi</p>', from: 'owner', layout: 'plain'},
        {id: 'hook', type: 'webhook', url: `${ZAPIER}/test/`},
      ],
    };
  });
  afterAll(async () => {
    delete env.RESEND_API_KEY;
    await db.$disconnect();
  });
  afterEach(() => {
    outbound.answer = () => 200;
  });

  it('quick test: dry run on the sample record, the wait shortened to 5 seconds, nothing really happens', async () => {
    before = await snapshot();
    const quick = must<Started>(await startTest({mode: 'quick', draft}), 'quick test');
    // The sample record: the most recent one matching the trigger conditions (not newer Bob).
    expect(quick.run.recordId).toBe(ann.id);
    expect(quick.run).toMatchObject({test: 'quick', source: 'test'});
    expect(quick.conditions.ok).toBe(true);

    // Adapted: the original watched the wait pass in real time; here it is waiting about 5 seconds.
    const waiting = await runRow(quick.run.id);
    expect(waiting.status).toBe('waiting');
    const ms = waiting.waitUntil!.getTime() - Date.now();
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(5_000);
    await wakeRun(quick.run.id);
    const r = await poll(quick.run.id);
    expect(r.status, String(r.error)).toBe('done');

    const byStep = Object.fromEntries(r.steps.map((s) => [s.stepId, s]));
    expect(byStep.if1?.output?.branch).toBe('then');
    expect(byStep.nope).toBeUndefined();
    expect(byStep.tag?.output?.summary).toMatch(/^Would add/);
    expect(byStep.wait?.output?.testWaitMs).toBe(5000);
    expect(byStep.wait?.output?.summary).toMatch(/test: 5 seconds/);
    expect(byStep.task?.output?.summary).toMatch(/^Would create task/);
    expect(byStep.mail?.output?.summary).toMatch(/^Would email/);
    expect(byStep.hook?.output?.summary).toMatch(/^Would POST/);
    // Replay data: steps in order, each with its start and finish.
    expect(r.steps.every((s, i, a) => !i || new Date(s.startedAt) >= new Date(a[i - 1]!.startedAt))).toBe(true);
    expect(r.steps.every((s) => s.finishedAt)).toBe(true);
    // The run detail shows the draft it ran, not the saved (empty) automation.
    expect(r.automation.steps.map((s) => s.id)).toEqual(draft.steps.map((s) => s.id));

    expect(await snapshot()).toEqual(before);
    const savedNow = await db.automation.findUniqueOrThrow({where: {id: saved.id}, select: {steps: true, enabled: true}});
    expect(savedNow.steps).toEqual([]);
    expect(savedNow.enabled).toBe(false);
  });

  it("quick test on a picked record that doesn't match the conditions takes the no path", async () => {
    const onBob = must<Started>(await startTest({mode: 'quick', recordId: bob.id, draft}), 'quick on bob');
    expect(onBob.run.recordId).toBe(bob.id);
    expect(onBob.conditions.ok).toBe(false);
    const bobRun = await poll(onBob.run.id);
    expect(bobRun.steps.find((s) => s.stepId === 'if1')?.output?.branch).toBe('else');
    expect(bobRun.steps.some((s) => s.stepId === 'nope')).toBe(true);
    expect(bobRun.steps.some((s) => s.stepId === 'tag')).toBe(false);

    // A new simulation replaces the one still going; a timed test waits its real time.
    const timed = must<Started>(await startTest({mode: 'timed', draft}), 'timed test');
    const replaced = await runRow(onBob.run.id);
    expect(replaced).toMatchObject({status: 'canceled', error: 'Replaced by a newer test'});
    let tr = await runRow(timed.run.id);
    const days = (tr.waitUntil!.getTime() - Date.now()) / DAY;
    expect(tr.status).toBe('waiting');
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
    // A job is queued for when the wait ends.
    const job = await db.jobBacklog.findFirst({where: {list: 'crm-automation-run', data: {path: ['runId'], equals: timed.run.id}}});
    expect(job).toBeTruthy();
    expect(Math.abs(job!.runAt.getTime() - tr.waitUntil!.getTime())).toBeLessThan(2000);
    // Polling does not cut a real wait short.
    await poll(timed.run.id);
    await poll(timed.run.id);
    expect((await runRow(timed.run.id)).status).toBe('waiting');
    await wakeRun(timed.run.id);
    const done = await poll(timed.run.id);
    expect(done.status, String(done.error)).toBe('done');
    expect(done.steps).toHaveLength(6);
    expect(done.steps.find((s) => s.stepId === 'wait')?.output?.testWaitMs).toBeUndefined();
    tr = await runRow(timed.run.id);
    expect(await snapshot()).toEqual(before);
  });

  it('test on a record: every step really happens, and is audited', async () => {
    expect((await startTest({mode: 'record', draft})).status).toBe(400);
    const real = must<Started>(await startTest({mode: 'record', recordId: ann.id, draft}), 'record test');
    expect(real.run.test).toBe('record');
    expect(await tagsOf(ann.id)).toContain('tested');
    const realRow = await runRow(real.run.id);
    expect(realRow.status).toBe('waiting');
    expect((realRow.waitUntil!.getTime() - Date.now()) / DAY).toBeGreaterThan(1.9);
    await wakeRun(real.run.id);
    const realRun = await poll(real.run.id);
    expect(realRun.status, String(realRun.error)).toBe('done');
    expect(await db.task.count({where: {title: {contains: 'Call '}}})).toBe(before.tasks + 1);
    expect(outbound.mails.some((m) => m.to.includes('ann@kinroot-mail.dev')), 'email really sent').toBe(true);
    expect(outbound.hooks.some((h) => h.path === '/hooks/catch/123456/test/' && h.headers['x-webhook-signature']), 'webhook really called, signed').toBe(true);
    expect(await db.activity.count({where: {contactId: ann.id}})).toBeGreaterThan(before.annActivities);
    const auditRow = await db.auditLog.findFirst({where: {action: 'automation.test_started', recordId: saved.id}, orderBy: {createdAt: 'desc'}, select: {meta: true}});
    expect((auditRow?.meta as {recordId?: string})?.recordId).toBe(ann.id);
  });

  it('tests stay out of stats, failure streaks, reports and re-enrollment', async () => {
    const broken = {...draft, steps: [{id: 'bad', type: 'update_field', target: 'contact', field: 'custom.nope_field', mode: 'set', value: 'x'}]};
    const failing = must<Started>(await startTest({mode: 'quick', recordId: ann.id, draft: broken}), 'failing test');
    const failRow = await runRow(failing.run.id);
    expect(failRow.status, String(failRow.error)).toBe('failed');
    const autoRow = await db.automation.findUniqueOrThrow({where: {id: saved.id}, select: {failureStreak: true, lastRunAt: true}});
    expect(autoRow).toEqual({failureStreak: 0, lastRunAt: null});
    expect(await db.event.count({where: {type: 'automation.run_failed', recordId: saved.id}})).toBe(0);
    const listed = must<{rows: {id: string; stats: {runs7d: number; failed7d: number}}[]}>(await owner.get('/site-api/crm/automations'), 'list').rows.find((x) => x.id === saved.id);
    expect(listed?.stats).toMatchObject({runs7d: 0, failed7d: 0});
    const testRuns = must<{rows: Run[]}>(await owner.get(`/site-api/crm/automations/${saved.id}/runs?source=test`), 'runs').rows;
    expect(testRuns.length).toBeGreaterThanOrEqual(5);
    expect(testRuns.every((x) => x.test)).toBe(true);
    const report = await owner.get(`/site-api/crm/reports/run?config=${encodeURIComponent(JSON.stringify({object: 'automation_runs', measure: {op: 'count'}, groupBy: {field: 'automation'}, chart: 'bar'}))}`);
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.json)).not.toContain(saved.id);

    // Switched on for real with "only once per record": the tests were not enrollments.
    must(await owner.request('PATCH', `/site-api/crm/automations/${saved.id}`, {...draft, reenroll: 'never', steps: [{id: 'real', type: 'add_tag', target: 'contact', tag: 'real'}]}), 'save');
    must(await owner.post(`/site-api/crm/automations/${saved.id}/enable`, {enabled: true}), 'enable');
    must(await owner.request('PATCH', `/site-api/crm/contacts/${ann.id}`, {city: 'Testville'}), 'update ann');
    const realRuns = await db.automationRun.findMany({where: {automationId: saved.id, recordId: ann.id, test: null}, select: {status: true}});
    expect(realRuns).toHaveLength(1);
    expect(await tagsOf(ann.id)).toContain('real');
    expect(await db.automationRun.count({where: {automationId: saved.id, test: {not: null}, source: {not: 'test'}}})).toBe(0);
  });

  it('stops a running test, which goes no further when its job wakes', async () => {
    const toStop = must<Started>(await startTest({mode: 'timed', recordId: ann.id, draft}), 'timed to stop');
    expect((await runRow(toStop.run.id)).status).toBe('waiting');
    must(await owner.post(`/site-api/crm/automations/runs/${toStop.run.id}/cancel`), 'stop');
    const stopped = await runRow(toStop.run.id);
    expect(stopped.status).toBe('canceled');
    expect(stopped.error).toMatch(/^Stopped by/);
    await wakeBacklog({runId: toStop.run.id});
    expect((await runRow(toStop.run.id)).status).toBe('canceled');
    expect(await db.automationRunStep.count({where: {runId: toStop.run.id}})).toBe(3);
    const latest = must<{run: {id: string} | null}>(await owner.get(`/site-api/crm/automations/${saved.id}/tests/latest`), 'latest').run;
    expect(latest?.id).toBe(toStop.run.id);

    const {browser: member} = await teammate(owner, 'member@example.com', 'MEMBER');
    expect((await member.post(`/site-api/crm/automations/${saved.id}/tests`, {mode: 'quick', draft})).status).toBe(403);
    expect((await member.post(`/site-api/crm/automations/runs/${toStop.run.id}/cancel`)).status).toBe(403);
  });
});
