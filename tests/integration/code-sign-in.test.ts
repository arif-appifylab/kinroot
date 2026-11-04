import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {} from '../../src/platform/auth/code-routes';
import {fromBase32, stepAt, totpCode} from '../../src/platform/auth/two-factor';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, codeFrom, configureEnv, DATABASE_URL, db, emails, OWNER_ID, ownerTickets, resetDatabase, signedIn} from './support/harness';

/**
 * Sign-in with an emailed 6-digit code, no password (docs/agent/auth.md). It never makes an owner
 * (owner.test.ts). The owner's ticket signs in with a fetch in the Preview.
 */
const PASSWORD = 'a long test passphrase';
const TICKET = 'T'.repeat(43);
// `offset` 1: the next 30-second code (the one that turned it on is never accepted again).
const totp = async (secret: string, offset = 0) => totpCode(fromBase32(secret)!, stepAt() + offset);

async function codeSignIn(browser: Browser, email: string) {
  expect((await browser.post('/site-api/auth/code', {email})).status).toBe(200);
  return browser.post('/site-api/auth/code/verify', {email, code: codeFrom(email)});
}

async function turnOnTwoFactor(browser: Browser) {
  const setup = await browser.post('/site-api/auth/two-factor/setup', {password: PASSWORD});
  const secret = setup.json.secret as string;
  const enabled = await browser.post('/site-api/auth/two-factor/enable', {code: await totp(secret)});
  expect(enabled.status, JSON.stringify([setup.status, enabled.json])).toBe(200);
  return secret;
}

describe.skipIf(!DATABASE_URL)('code sign-in and the admin (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it('never says whether an email has an account, and sends nothing to an unknown one', async () => {
    await signedIn(app, 'ann@example.test');
    emails.length = 0;
    const known = await new Browser(app).post('/site-api/auth/code', {email: 'ann@example.test'});
    const unknown = await new Browser(app).post('/site-api/auth/code', {email: 'nobody@example.test'});
    expect(known.status).toBe(unknown.status);
    expect(known.json.message).toBe(unknown.json.message);
    expect(emails.map(e => e.to)).toEqual(['ann@example.test']);
    expect(emails[0]!.kind).toBe('sign_in_code');
    expect(emails[0]!.code).toMatch(/^\d{6}$/);
    expect(emails[0]!.path).toMatch(/^\/account\/reset\/\?token=/);
  });

  it('a code works once, using one ends the others; only its hash is stored', async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const first = codeFrom('ann@example.test');
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const second = codeFrom('ann@example.test');
    const rows = await db.signInCode.findMany({select: {codeHash: true}});
    for (const row of rows) expect(row.codeHash).not.toContain(second);

    // Asking again keeps the first alive, in case someone else asked. Using one ends both.
    expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: first})).status).toBe(200);
    if (first !== second) {
      expect((await new Browser(app).post('/site-api/auth/code/verify', {email: 'ann@example.test', code: second})).status).toBe(401);
    }
    expect((await new Browser(app).post('/site-api/auth/code/verify', {email: 'ann@example.test', code: first})).status).toBe(401);
  });

  it("wrong guesses don't spend a code: the limit on guessing is per address", async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const good = codeFrom('ann@example.test');
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 6; i++) {
      expect((await new Browser(app, `192.0.2.${60 + i}`).post('/site-api/auth/code/verify', {email: 'ann@example.test', code: bad})).status).toBe(401);
    }
    expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: good})).status).toBe(200);
  });

  it('an expired code never works', async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    await db.signInCode.updateMany({data: {expiresAt: new Date(Date.now() - 1000)}});
    expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: codeFrom('ann@example.test')})).status).toBe(401);
  });

  it('with two-step sign-in on, the code is only the first step', async () => {
    const browser = await signedIn(app, 'ann@example.test');
    const secret = await turnOnTwoFactor(browser);
    const fresh = new Browser(app);
    const res = await codeSignIn(fresh, 'ann@example.test');
    expect(res.status).toBe(202);
    expect(res.json.twoFactor).toBe(true);
    expect((await fresh.get('/site-api/auth/me')).status).toBe(401);
    const done = await fresh.post('/site-api/auth/login/two-factor', {challenge: res.json.challenge, code: await totp(secret, 1)});
    expect(done.status).toBe(200);
  });

  it('a suspended account gets no session from a code', async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    await db.user.update({where: {email: 'ann@example.test'}, data: {status: 'suspended'}});
    const res = await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: codeFrom('ann@example.test')});
    expect(res.status).toBe(403);
  });

  it('an address gets one code email per 15 minutes, whoever asks, and every ask answers the same', async () => {
    await signedIn(app, 'ann@example.test');
    const stranger = new Browser(app, '192.0.2.77');
    emails.length = 0;
    const asked: number[] = [];
    for (let i = 0; i < 5; i++) asked.push((await stranger.post('/site-api/auth/code', {email: 'ann@example.test'})).status);
    expect(asked).toEqual([200, 200, 200, 200, 200]);
    expect(emails.filter(e => e.kind === 'sign_in_code')).toHaveLength(1);
  });

  describe('in the editor Preview (cookies travel in headers)', () => {
    beforeEach(() => {
      env.SITE_PREVIEW = '1';
    });
    afterEach(() => {
      env.SITE_PREVIEW = '';
    });

    it('the portal signs the owner in with a fetch of the ticket (POST /owner)', async () => {
      ownerTickets.set(TICKET, {ownerId: OWNER_ID});
      const browser = new Browser(app, '203.0.113.20', 'preview');
      const res = await browser.post('/site-api/auth/owner', {ticket: TICKET, next: '/dashboard/'});
      expect(res.status).toBe(200);
      expect(res.json.next).toBe('/dashboard/');
      expect((await browser.get('/site-api/auth/me')).json.roles).toContain('owner');
      // Once only.
      expect((await new Browser(app, '203.0.113.21', 'preview').post('/site-api/auth/owner', {ticket: TICKET})).status).toBe(401);
    });

    it('a page-load ticket is refused in the Preview (it could not keep the session there)', async () => {
      ownerTickets.set(TICKET, {ownerId: OWNER_ID});
      const res = await new Browser(app, '203.0.113.22', 'preview').get(`/site-api/auth/owner?ticket=${TICKET}`);
      expect(res.headers.get('location')).toBe('/account/login/?notice=owner-link');
      expect(ownerTickets.has(TICKET)).toBe(true);
    });
  });
});
