import {createHmac} from 'node:crypto';

import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  DontRetry,
  JobRejected,
  defineBackground,
  handleJobDelivery,
  isJobDelivery,
  runsJobsLocally,
  sendJob,
} from '../src/platform/background';

const SECRET = 'jobs-secret-for-tests-0123456789abcdef';

/** What the platform sends (api site_jobs.rules.ts signDelivery). */
function delivery(body: unknown, {secret = SECRET, at = Math.floor(Date.now() / 1000)} = {}) {
  const text = JSON.stringify(body);
  const mac = createHmac('sha256', secret).update(`${at}.${text}`).digest('hex');
  return new Request('https://shop.example/site-api/_platform/jobs', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-site-signature': `t=${at},v1=${mac}`},
    body: text,
  });
}

let jobSeq = 0;
/** A fresh job id each time (one delivery = one id + try; the same pair again is a replay). */
const job = (list: string, data: unknown = {}) => ({id: `job_x${jobSeq++}`, list, attempt: 1, maxAttempts: 5, scheduledFor: new Date().toISOString(), data});

describe('background jobs: delivery from the platform', () => {
  afterEach(() => {
    delete (env as Record<string, string | undefined>).SITE_JOBS_SECRET;
  });

  it('runs the handler for a signed delivery and answers 200', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const seen: unknown[] = [];
    const bg = defineBackground({reminders: async (data, info) => void seen.push([data, info.id, info.local])});
    const res = await handleJobDelivery(delivery(job('reminders', {bookingId: 7})), bg);
    expect(res.status).toBe(200);
    expect(seen).toEqual([[{bookingId: 7}, expect.stringMatching(/^job_x\d+$/), false]]);
  });

  it('refuses a wrong secret, a changed body and an old timestamp', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const bg = defineBackground({reminders: async () => {}});
    expect((await handleJobDelivery(delivery(job('reminders'), {secret: 'other'}), bg)).status).toBe(401);
    expect((await handleJobDelivery(delivery(job('reminders'), {at: Math.floor(Date.now() / 1000) - 3600}), bg)).status).toBe(401);
    const forged = delivery(job('reminders'));
    const tampered = new Request(forged.url, {method: 'POST', headers: forged.headers, body: JSON.stringify(job('reminders', {admin: true}))});
    expect((await handleJobDelivery(tampered, bg)).status).toBe(401);
  });

  it('says which answers mean what: no handler, do not retry, try again', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const bg = defineBackground({
      broken: async () => {
        throw new Error('Database busy');
      },
      bad: async () => {
        throw new DontRetry('Phone number is missing');
      },
    });
    const missing = await handleJobDelivery(delivery(job('ghost')), bg);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({code: 'no_handler'});
    const permanent = await handleJobDelivery(delivery(job('bad')), bg);
    expect(permanent.status).toBe(422);
    expect(await permanent.json()).toEqual({error: 'Phone number is missing'});
    expect((await handleJobDelivery(delivery(job('broken')), bg)).status).toBe(500);
  });

  it('accepts a delivery signed with either of two secrets (a replaced secret before the publish)', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const seen: unknown[] = [];
    const bg = defineBackground({reminders: async data => void seen.push(data)});
    const text = JSON.stringify({...job('reminders', {n: 1}), id: 'job_two'});
    const at = Math.floor(Date.now() / 1000);
    const mac = (secret: string) => createHmac('sha256', secret).update(`${at}.${text}`).digest('hex');
    const req = (header: string) =>
      new Request('https://shop.example/site-api/_platform/jobs', {method: 'POST', headers: {'x-site-signature': header}, body: text});
    expect((await handleJobDelivery(req(`t=${at},v1=${mac('the-new-one-0123456789abcdef0123')},v1=${mac(SECRET)}`), bg)).status).toBe(200);
    expect((await handleJobDelivery(req(`t=${at},v1=${mac('a')},v1=${mac('b')}`), bg)).status).toBe(401);
  });

  it('runs a replayed copy of a delivery only once', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    let runs = 0;
    const bg = defineBackground({reminders: async () => void runs++});
    const once = {...job('reminders'), id: 'job_replayed', attempt: 2};
    expect((await handleJobDelivery(delivery(once), bg)).status).toBe(200);
    const again = await handleJobDelivery(delivery(once), bg);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({duplicate: true});
    expect(runs).toBe(1);
    expect((await handleJobDelivery(delivery({...once, attempt: 3}), bg)).status).toBe(200);
    expect(runs).toBe(2);
  });

  it('a signed but malformed body (null, an array, no list) is a 400, never a 500 (PIPE-13)', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    let runs = 0;
    const bg = defineBackground({reminders: async () => void runs++});
    for (const body of [null, [], 'reminders', 7, {id: 'job_y', attempt: 1}, {list: 'reminders', attempt: 1}]) {
      const res = await handleJobDelivery(delivery(body), bg);
      expect(res.status).toBe(400);
    }
    expect(runs).toBe(0);
  });

  it('a list named like a built-in ("constructor", "toString") has no handler unless the site made one', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const bg = defineBackground({reminders: async () => {}});
    for (const list of ['constructor', 'tostring', 'hasownproperty']) {
      const res = await handleJobDelivery(delivery(job(list)), bg);
      expect(res.status).toBe(404);
    }
    const constructorJob = await handleJobDelivery(delivery(job('constructor')), bg);
    expect(await constructorJob.json()).toMatchObject({code: 'no_handler'});
  });

  it('refuses a body over 64 KB even when it does not say its length', async () => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
    const big = new Uint8Array(70 * 1024).fill(32);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const res = await handleJobDelivery(
      new Request('https://shop.example/site-api/_platform/jobs', {method: 'POST', body: stream, duplex: 'half'} as RequestInit),
      defineBackground({})
    );
    expect(res.status).toBe(413);
  });

  it('without its secret (never published with jobs) asks to be tried later', async () => {
    const res = await handleJobDelivery(delivery(job('reminders')), defineBackground({}));
    expect(res.status).toBe(503);
  });

  it('only owns its one path', () => {
    expect(isJobDelivery('https://a.example/site-api/_platform/jobs')).toBe(true);
    expect(isJobDelivery('https://a.example/site-api/jobs')).toBe(false);
  });
});

describe('background jobs: sending (locally, as in the Preview)', () => {
  it('runs the handler right away, once, and never calls the platform', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const seen: unknown[] = [];
    defineBackground({reminders: async (data, info) => void seen.push([data, info.local])});
    expect(runsJobsLocally()).toBe(true);
    const sent = await sendJob('https://shop.example/site-api/x', 'reminders', {bookingId: 1}, {delay: 3600, key: 'r-1'});
    expect(sent.local).toBe(true);
    expect(seen).toEqual([[{bookingId: 1}, true]]);
    const grouped: unknown[] = [];
    defineBackground({payments: async (_data, info) => void grouped.push(info.group)});
    await sendJob('https://shop.example/', 'payments', {}, {group: 'customer-9'});
    expect(grouped).toEqual(['customer-9']);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('checks names and sizes like the platform does', async () => {
    defineBackground({});
    await expect(sendJob('https://a.example/', 'Bad Name')).rejects.toBeInstanceOf(JobRejected);
    await expect(sendJob('https://a.example/', 'big', 'x'.repeat(40 * 1024))).rejects.toMatchObject({code: 'E_JOBS_PAYLOAD_TOO_LARGE'});
  });
});
