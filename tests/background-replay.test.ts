import {createHmac} from 'node:crypto';

import {env} from 'cloudflare:workers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The replay guard's database side (`firstDelivery` in src/platform/background.ts) with a stand-in
 * Site Database. background.ts is MANAGED (replaced on upgrade) but prisma/schema.prisma is the
 * site's own, so the site's generated client may lack the `JobDelivery` model: the guard must work
 * through raw SQL only, and fall back to per-instance memory when the table is missing.
 */
const fake = vi.hoisted(() => ({db: null as unknown}));
vi.mock('../src/platform/db', () => ({getDb: () => fake.db}));

import {defineBackground, handleJobDelivery} from '../src/platform/background';

const SECRET = 'jobs-secret-for-tests-0123456789abcdef';

function delivery(body: unknown) {
  const text = JSON.stringify(body);
  const at = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', SECRET).update(`${at}.${text}`).digest('hex');
  return new Request('https://shop.example/site-api/_platform/jobs', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-site-signature': `t=${at},v1=${mac}`},
    body: text,
  });
}

let seq = 0;
const job = () => ({id: `job_r${seq++}`, list: 'reminders', attempt: 1, maxAttempts: 5, scheduledFor: new Date().toISOString(), data: {}});

/** A client generated from a schema.prisma WITHOUT the JobDelivery model: only the raw API. */
function clientWithoutModel(fail?: () => never) {
  const rows = new Set<string>();
  return {
    rows,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (fail) fail();
      const sql = strings.join('?');
      if (sql.startsWith('INSERT INTO "job_deliveries"')) {
        const key = `${values[0]}:${values[1]}`;
        if (rows.has(key)) return 0;
        rows.add(key);
        return 1;
      }
      return 0;
    },
  };
}

const knownError = (code: string, meta?: unknown, message = '') => Object.assign(new Error(message), {code, meta});

describe('background jobs: the replay guard with a Site Database', () => {
  beforeEach(() => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
  });
  afterEach(() => {
    delete (env as Record<string, string | undefined>).SITE_JOBS_SECRET;
    fake.db = null;
  });

  it('works when the site client has no JobDelivery model (schema.prisma not merged on upgrade)', async () => {
    const client = clientWithoutModel();
    fake.db = client;
    let runs = 0;
    const bg = defineBackground({reminders: async () => void runs++});
    const one = job();
    const first = await handleJobDelivery(delivery(one), bg);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ok: true});
    const replay = await handleJobDelivery(delivery(one), bg);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({duplicate: true});
    expect(runs).toBe(1);
    expect([...client.rows]).toEqual([`${one.id}:1`]);
  });

  it.each([
    ['P2021 (model query on a missing table)', () => knownError('P2021')],
    [
      'P2010 TableDoesNotExist (raw query on a missing table)',
      () =>
        knownError(
          'P2010',
          {driverAdapterError: {name: 'DriverAdapterError', cause: {originalCode: '42P01', kind: 'TableDoesNotExist', table: 'job_deliveries'}}},
          'Raw query failed. Code: `42P01`. Message: `relation "job_deliveries" does not exist`'
        ),
    ],
  ])('falls back to this instance when the table is missing: %s', async (_name, error) => {
    fake.db = clientWithoutModel(() => {
      throw error();
    });
    let runs = 0;
    const bg = defineBackground({reminders: async () => void runs++});
    const one = job();
    expect((await handleJobDelivery(delivery(one), bg)).status).toBe(200);
    const replay = await handleJobDelivery(delivery(one), bg);
    expect(await replay.json()).toMatchObject({duplicate: true});
    expect(runs).toBe(1);
  });

  it('answers 500 (try again) and runs nothing when the database does not answer', async () => {
    fake.db = clientWithoutModel(() => {
      throw knownError('P1001', undefined, "Can't reach database server");
    });
    let runs = 0;
    const bg = defineBackground({reminders: async () => void runs++});
    const res = await handleJobDelivery(delivery(job()), bg);
    expect(res.status).toBe(500);
    expect(runs).toBe(0);
  });
});
