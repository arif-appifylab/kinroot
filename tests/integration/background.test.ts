import {createHmac} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';
import {env} from './support/cloudflare-workers';

const SECRET = 'jobs-secret-for-integration-0123456789abcdef';

function delivery(body: unknown) {
  const text = JSON.stringify(body);
  const at = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', SECRET).update(`${at}.${text}`).digest('hex');
  return new Request('https://shop.example.test/site-api/_platform/jobs', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-site-signature': `t=${at},v1=${mac}`},
    body: text,
  });
}

/** A fresh copy of the module: what another Worker instance (isolate) would load. */
async function freshIsolate() {
  const vars = {...env};
  vi.resetModules();
  // The new isolate gets the same platform env (its own copy of `cloudflare:workers`).
  Object.assign((await import('cloudflare:workers')).env as Record<string, unknown>, vars);
  return import('../../src/platform/background');
}

/** Background job deliveries against a real Site Database (PIPE-13 replay guard). */
describe.skipIf(!DATABASE_URL)('background job delivery (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
    env.SITE_JOBS_SECRET = SECRET;
  });
  afterAll(async () => {
    delete env.SITE_JOBS_SECRET;
    await db.$disconnect();
  });
  beforeEach(resetDatabase);

  it('a replayed delivery runs nothing on another Worker instance either', async () => {
    let runs = 0;
    const job = {id: 'job_cross_isolate', list: 'reminders', attempt: 1, maxAttempts: 5, scheduledFor: new Date().toISOString(), data: {}};

    const first = await freshIsolate();
    const bgA = first.defineBackground({reminders: async () => void runs++});
    expect((await first.handleJobDelivery(delivery(job), bgA)).status).toBe(200);

    // A second isolate has none of the first one's memory: only the database knows.
    const second = await freshIsolate();
    const bgB = second.defineBackground({reminders: async () => void runs++});
    const replay = await second.handleJobDelivery(delivery(job), bgB);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({duplicate: true});
    expect(runs).toBe(1);

    // The next try is a new delivery.
    expect((await second.handleJobDelivery(delivery({...job, attempt: 2}), bgB)).status).toBe(200);
    expect(runs).toBe(2);
    const rows = await db.jobDelivery.findMany({orderBy: {attempt: 'asc'}});
    expect(rows.map(row => [row.jobId, row.attempt])).toEqual([
      ['job_cross_isolate', 1],
      ['job_cross_isolate', 2],
    ]);
  });

  it('a database from before the job_deliveries migration falls back to this instance, never a 500', async () => {
    await db.$executeRawUnsafe('ALTER TABLE "job_deliveries" RENAME TO "job_deliveries_away"');
    try {
      let runs = 0;
      const bg = await freshIsolate();
      const handlers = bg.defineBackground({reminders: async () => void runs++});
      const job = {id: 'job_no_table', list: 'reminders', attempt: 1, maxAttempts: 5, scheduledFor: new Date().toISOString(), data: {}};
      expect((await bg.handleJobDelivery(delivery(job), handlers)).status).toBe(200);
      const replay = await bg.handleJobDelivery(delivery(job), handlers);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({duplicate: true});
      expect(runs).toBe(1);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "job_deliveries_away" RENAME TO "job_deliveries"');
    }
  });

  it('sweeps delivery rows older than a day on the way', async () => {
    await db.$executeRawUnsafe(`INSERT INTO "job_deliveries" ("job_id", "attempt", "seen_at") VALUES ('job_old', 1, NOW() - INTERVAL '2 days'), ('job_recent', 1, NOW() - INTERVAL '1 hour')`);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const bg = await freshIsolate();
      const handlers = bg.defineBackground({reminders: async () => {}});
      const job = {id: 'job_sweeper', list: 'reminders', attempt: 1, maxAttempts: 5, scheduledFor: new Date().toISOString(), data: {}};
      expect((await bg.handleJobDelivery(delivery(job), handlers)).status).toBe(200);
    } finally {
      random.mockRestore();
    }
    const rows = await db.jobDelivery.findMany({orderBy: {jobId: 'asc'}});
    expect(rows.map(row => row.jobId)).toEqual(['job_recent', 'job_sweeper']);
  });
});
