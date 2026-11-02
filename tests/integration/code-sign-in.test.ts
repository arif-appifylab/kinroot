import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {CODE_MAX_TRIES} from '../../src/platform/auth/code-routes';
import {fromBase32, stepAt, totpCode} from '../../src/platform/auth/two-factor';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, codeFrom, configureEnv, DATABASE_URL, db, emails, ownerTickets, resetDatabase, signedIn} from './support/harness';

/**
 * The admin's sign-in (docs/agent/auth.md): the platform's owner addresses get their accounts
 * made for them; anyone signs in with an emailed 6-digit code, no password; one click from
 * The dashboard still asks the site's own two-step code; the Preview signs in with a fetch.
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

  describe('on the live site, with the platform owner list', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      env.SITE_OWNER_EMAILS = 'boss@example.test, partner@example.test';
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      delete env.SITE_OWNER_EMAILS;
    });

    it('the owner addresses get no-password owner accounts before their first code, and sign in with it', async () => {
      const browser = new Browser(app);
      const res = await codeSignIn(browser, 'boss@example.test');
      expect(res.status).toBe(200);
      expect(res.json.next).toBe('/dashboard');
      expect((await browser.get('/site-api/auth/me')).json.roles).toContain('owner');

      // Both listed addresses exist and hold owner; neither has a password.
      for (const email of ['boss@example.test', 'partner@example.test']) {
        const user = await db.user.findUniqueOrThrow({
          where: {email},
          select: {passwordHash: true, emailVerifiedAt: true, roles: {select: {role: {select: {slug: true}}}}},
        });
        expect(user.passwordHash).toBe('!');
        expect(user.emailVerifiedAt).not.toBeNull();
        expect(user.roles.map(r => r.role.slug)).toContain('owner');
      }
      expect((await new Browser(app).post('/site-api/auth/login', {email: 'boss@example.test', password: 'anything at all'})).status).toBe(401);
    });

    it('one click from the dashboard still asks the site’s own two-step code when it is on', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      expect((await new Browser(app).get(`/site-api/auth/owner?ticket=${TICKET}`)).status).toBe(303);
      // In the portal the owner sets a password (Security), then two-step sign-in, which asks for it.
      const helper = await signedIn(app, 'helper@example.test');
      void helper;
      const {passwordHash} = await db.user.findUniqueOrThrow({where: {email: 'helper@example.test'}});
      await db.user.update({where: {email: 'boss@example.test'}, data: {passwordHash}});
      const owner = new Browser(app);
      expect((await owner.post('/site-api/auth/login', {email: 'boss@example.test', password: PASSWORD})).status).toBe(200);
      const secret = await turnOnTwoFactor(owner);

      const again = 'A'.repeat(43);
      ownerTickets.set(again, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      const fresh = new Browser(app);
      const res = await fresh.get(`/site-api/auth/owner?ticket=${again}`);
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location')!, 'https://x.test');
      expect(location.pathname).toBe('/account/login/');
      const challenge = location.searchParams.get('mfa')!;
      expect(challenge).toBeTruthy();
      // No session yet: only the authenticator code finishes it.
      expect((await fresh.get('/site-api/auth/me')).status).toBe(401);
      const done = await fresh.post('/site-api/auth/login/two-factor', {challenge, code: await totp(secret, 1)});
      expect(done.status).toBe(200);
      expect((await fresh.get('/site-api/auth/me')).json.roles).toContain('owner');
    });
  });

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
    expect(emails[0]!.path).toBeUndefined();
  });

  it('a code works once; a newer one ends the older one; only its hash is stored', async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const first = codeFrom('ann@example.test');
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const second = codeFrom('ann@example.test');
    const rows = await db.signInCode.findMany({select: {codeHash: true}});
    for (const row of rows) expect(row.codeHash).not.toContain(second);

    if (first !== second) {
      expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: first})).status).toBe(401);
    }
    expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: second})).status).toBe(200);
    expect((await new Browser(app).post('/site-api/auth/code/verify', {email: 'ann@example.test', code: second})).status).toBe(401);
  });

  it(`${CODE_MAX_TRIES} wrong tries spend the code`, async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    await browser.post('/site-api/auth/code', {email: 'ann@example.test'});
    const good = codeFrom('ann@example.test');
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < CODE_MAX_TRIES; i++) {
      expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: bad})).status).toBe(401);
    }
    expect((await browser.post('/site-api/auth/code/verify', {email: 'ann@example.test', code: good})).status).toBe(401);
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

  it('asking for codes is rate-limited per address', async () => {
    await signedIn(app, 'ann@example.test');
    const browser = new Browser(app);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await browser.post('/site-api/auth/code', {email: 'ann@example.test'})).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses).toContain(429);
  });

  describe('in the editor Preview (cookies travel in headers)', () => {
    beforeEach(() => {
      env.SITE_PREVIEW = '1';
    });
    afterEach(() => {
      env.SITE_PREVIEW = '';
    });

    it('the portal signs the owner in with a fetch of the ticket (POST /owner)', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      const browser = new Browser(app, '203.0.113.20', 'preview');
      const res = await browser.post('/site-api/auth/owner', {ticket: TICKET, next: '/dashboard/'});
      expect(res.status).toBe(200);
      expect(res.json.next).toBe('/dashboard/');
      expect((await browser.get('/site-api/auth/me')).json.roles).toContain('owner');
      // Once only.
      expect((await new Browser(app, '203.0.113.21', 'preview').post('/site-api/auth/owner', {ticket: TICKET})).status).toBe(401);
    });

    it('a page-load ticket is refused in the Preview (it could not keep the session there)', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      const res = await new Browser(app, '203.0.113.22', 'preview').get(`/site-api/auth/owner?ticket=${TICKET}`);
      expect(res.headers.get('location')).toBe('/account/login/?notice=owner-link');
      expect(ownerTickets.has(TICKET)).toBe(true);
    });
  });
});
