import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, DATABASE_URL, db, emails, resetDatabase, signedIn} from './support/harness';

/**
 * Sign-up and a new email address ask the platform whether the address is a real inbox
 * (`POST {SITE_URL}/api/site/v1/email-check`, src/platform/auth/email-check.ts)
 * after the rate limit and before anything is written. The platform's answer is faked
 * here on top of the harness: `@throwaway.test` is refused. Skipped without a database.
 */
const PASSWORD = 'a long test passphrase';
const CHECK = `${env.SITE_URL || 'https://platform.example.test'}/api/site/v1/email-check`;

describe.skipIf(!DATABASE_URL)('email check (integration, real Postgres)', () => {
  const harnessFetch = globalThis.fetch;
  const asked: {email: string; auth: string | null}[] = [];
  let answer: 'judge' | 'down' = 'judge';

  beforeAll(() => {
    configureEnv();
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/site/v1/email-check')) return harnessFetch(input, init);
      const {email} = JSON.parse(String(init?.body ?? '{}')) as {email: string};
      asked.push({email, auth: new Headers(init?.headers).get('authorization')});
      if (answer === 'down') return new Response('', {status: 503});
      return new Response(JSON.stringify({status: 200, data: {accept: !email.endsWith('@throwaway.test')}}), {
        status: 200,
      });
    };
  });
  beforeEach(async () => {
    await resetDatabase();
    asked.length = 0;
    answer = 'judge';
  });
  afterEach(() => {
    answer = 'judge';
  });
  afterAll(async () => {
    globalThis.fetch = harnessFetch;
    await db.$disconnect();
  });

  it('a refused address gets a field error, no user and no email', async () => {
    const res = await new Browser(app).post('/site-api/auth/register', {
      email: 'maya@throwaway.test',
      name: 'Maya',
      password: PASSWORD,
    });
    expect(res.status).toBe(422);
    expect((res.json.fields as Record<string, string>).email).toMatch(/email address you can get mail at/);
    expect(await db.user.count({where: {email: 'maya@throwaway.test'}})).toBe(0);
    expect(emails.filter(e => e.to === 'maya@throwaway.test')).toHaveLength(0);
    // Asked once, with the Site Key: the check runs on the platform, never from the browser.
    expect(asked).toEqual([{email: 'maya@throwaway.test', auth: `Bearer ${env.SITE_KEY}`}]);
    expect(CHECK).toContain('/api/site/v1/email-check');
  });

  it('an accepted address signs up as before', async () => {
    const res = await new Browser(app).post('/site-api/auth/register', {email: 'ann@example.test', name: 'Ann', password: PASSWORD});
    expect(res.status).toBe(202);
    expect(await db.user.count({where: {email: 'ann@example.test'}})).toBe(1);
    expect(asked.map(a => a.email)).toEqual(['ann@example.test']);
  });

  it('a platform outage never blocks a sign-up', async () => {
    answer = 'down';
    const res = await new Browser(app).post('/site-api/auth/register', {
      email: 'late@throwaway.test',
      name: 'Late',
      password: PASSWORD,
    });
    expect(res.status).toBe(202);
    expect(await db.user.count({where: {email: 'late@throwaway.test'}})).toBe(1);
  });

  it('a new email address is checked too: refused → nothing sent', async () => {
    const browser = await signedIn(app, 'old@example.test');
    emails.length = 0;
    const res = await browser.post('/site-api/auth/email', {email: 'new@throwaway.test', password: PASSWORD});
    expect(res.status).toBe(422);
    expect((res.json.fields as Record<string, string>).email).toMatch(/email address you can get mail at/);
    expect(emails.filter(e => e.kind === 'confirm_email_change')).toHaveLength(0);

    const ok = await browser.post('/site-api/auth/email', {email: 'new@example.test', password: PASSWORD});
    expect(ok.status).toBe(202);
    expect(emails.find(e => e.kind === 'confirm_email_change')).toMatchObject({to: 'new@example.test'});
  });
});
