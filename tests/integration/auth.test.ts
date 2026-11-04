import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {authRoutes, DEFAULT_AUTH_SETTINGS} from '../../src/platform/auth';
import {csrf, sameOrigin} from '../../src/platform/guards';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {
  Browser,
  signUpCodeFrom,
  configureEnv,
  DATABASE_URL,
  db,
  emails,
  ownerSignedIn,
  resetDatabase,
  signedIn,
  tokenFrom,
  unconfirmedAccount,
  userId,
} from './support/harness';

/**
 * The auth core end to end: the real Site API, a real Postgres
 * (`TEST_DATABASE_URL`), cookies and CSRF like a browser. Skipped without a
 * database.
 */
const PASSWORD = 'a long test passphrase';

describe.skipIf(!DATABASE_URL)('auth (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it('register → verify → login → me, with the right cookies', async () => {
    const browser = new Browser(app);
    const reg = await browser.post('/site-api/auth/register', {email: 'Ann@Example.test', name: 'Ann', password: PASSWORD});
    expect(reg.status).toBe(202);
    expect(emails.find(e => e.kind === 'sign_up_code')).toMatchObject({to: 'ann@example.test', expiresInMinutes: 30});

    // No account yet: the right password is not enough.
    expect(await db.user.count()).toBe(0);
    expect((await browser.post('/site-api/auth/login', {email: 'ann@example.test', password: PASSWORD})).status).toBe(401);

    const code = signUpCodeFrom('ann@example.test');
    const verified = await browser.post('/site-api/auth/register/verify', {email: 'ann@example.test', code});
    expect(verified.status).toBe(201);
    expect((await browser.post('/site-api/auth/register/verify', {email: 'ann@example.test', code})).status).toBe(401); // single use

    const login = await browser.post('/site-api/auth/login', {email: 'ann@example.test', password: PASSWORD});
    expect(login.status).toBe(200);
    const setCookies = login.headers.getSetCookie();
    for (const name of ['__Host-site_at', '__Host-site_rt']) {
      const line = setCookies.find(c => c.startsWith(`${name}=`))!;
      expect(line).toMatch(/; Path=\//);
      expect(line).toMatch(/; SameSite=Lax/);
      expect(line).toMatch(/; Secure/);
      expect(line).toMatch(/; HttpOnly/);
      expect(line).not.toMatch(/Domain=/);
    }
    const me = await browser.get('/site-api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({state: 'user', email: 'ann@example.test', emailVerified: true});
    // The DB keeps only hashes of tokens.
    const rows = await db.refreshToken.findMany({select: {tokenHash: true}});
    expect(rows[0]!.tokenHash).not.toBe(browser.cookie('site_rt'));
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // And never the password.
    const user = await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {passwordHash: true}});
    expect(user.passwordHash).toMatch(/^scrypt\$v1\$16384\$8\$5\$/);
  });

  // Two sign-ups for one unconfirmed address, in both orders: whoever registered
  // first or last, neither chosen password survives; the inbox chooses it.
  for (const order of ['squatter first', 'real person first'] as const) {
    it(`two sign-ups on one address (${order}): only the browser with the code gets an account, with its own password`, async () => {
      const squatter = new Browser(app, '192.0.2.201');
      const pat = new Browser(app, '203.0.113.61');
      const squatPassword = 'the squatters own passphrase';
      const signUp = (who: Browser, name: string, password: string) =>
        who.post('/site-api/auth/register', {email: 'pat@example.test', name, password});
      const squat = () => signUp(squatter, 'Squat', squatPassword);
      const real = () => signUp(pat, 'Pat', PASSWORD);
      for (const step of order === 'squatter first' ? [squat, real] : [real, squat]) expect((await step()).status).toBe(202);
      // One email, whoever asked first. It's in the inbox, so Pat can use it in Pat's own browser.
      expect(emails.filter(e => e.kind === 'sign_up_code')).toHaveLength(1);
      const code = signUpCodeFrom('pat@example.test');
      const verify = await pat.post('/site-api/auth/register/verify', {email: 'pat@example.test', code});
      expect(verify.status).toBe(201);
      expect(verify.json.user).toMatchObject({name: 'Pat'});
      const stranger = new Browser(app, '192.0.2.202');
      expect((await stranger.post('/site-api/auth/login', {email: 'pat@example.test', password: squatPassword})).status).toBe(401);
      expect((await stranger.post('/site-api/auth/login', {email: 'pat@example.test', password: PASSWORD})).status).toBe(200);
      // The squatter's browser, even handed the code, is too late.
      expect((await squatter.post('/site-api/auth/register/verify', {email: 'pat@example.test', code})).status).toBe(401);
    });
  }

  it('two sign-ups at the same moment make one account, and only with a code', async () => {
    for (let round = 0; round < 6; round++) {
      await resetDatabase();
      const a = new Browser(app, `192.0.2.${220 + round}`);
      const b = new Browser(app, `203.0.113.${120 + round}`);
      const answers = await Promise.all([
        a.post('/site-api/auth/register', {email: 'race@example.test', name: 'A', password: 'the first long passphrase'}),
        b.post('/site-api/auth/register', {email: 'race@example.test', name: 'B', password: PASSWORD}),
      ]);
      expect(answers.map(x => x.status)).toEqual([202, 202]);
      expect(await db.user.count()).toBe(0);
      expect(await db.pendingSignUp.count()).toBe(2);
    }
  });

  it('PIPE-12: a parallel burst of sign-ups from one IP gets only the free ones through', async () => {
    const results = await Promise.all(
      Array.from({length: 12}, (_, i) =>
        new Browser(app, '192.0.2.160').post('/site-api/auth/register', {email: `burst${i}@example.test`, name: 'B', password: PASSWORD})
      )
    );
    const statuses = results.map(r => r.status);
    expect(statuses.filter(s => s === 202)).toHaveLength(5);
    expect(statuses.filter(s => s === 429)).toHaveLength(7);
    expect(await db.loginAttempt.count({where: {kind: 'register'}})).toBe(5);
  });

  it('PIPE-13: a suspended account cannot confirm its email', async () => {
    const {user} = await unconfirmedAccount('sus@example.test');
    await db.user.update({where: {id: user.id}, data: {status: 'suspended'}});
    const res = await new Browser(app).post('/site-api/auth/verify-email', {token: user.token});
    expect(res.status).toBe(400);
    expect((await db.user.findUniqueOrThrow({where: {email: 'sus@example.test'}})).emailVerifiedAt).toBeNull();
  });

  it('never says whether an email has an account', async () => {
    await signedIn(app, 'known@example.test');
    const browser = new Browser(app, '198.51.100.7');
    const wrong = await browser.post('/site-api/auth/login', {email: 'known@example.test', password: 'not the password'});
    const unknown = await browser.post('/site-api/auth/login', {email: 'nobody@example.test', password: 'not the password'});
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.json).toEqual(unknown.json);

    const forgotKnown = await browser.post('/site-api/auth/forgot-password', {email: 'known@example.test'});
    const forgotUnknown = await browser.post('/site-api/auth/forgot-password', {email: 'nobody@example.test'});
    expect(forgotKnown.status).toBe(202);
    expect(forgotKnown.json).toEqual(forgotUnknown.json);
    expect(emails.filter(e => e.kind === 'password_reset').map(e => e.to)).toEqual(['known@example.test']);

    emails.length = 0;
    const again = await browser.post('/site-api/auth/register', {email: 'known@example.test', name: 'X', password: PASSWORD});
    const fresh = await browser.post('/site-api/auth/register', {email: 'fresh@example.test', name: 'Y', password: PASSWORD});
    // A sign-up still waiting for its code answers alike too (and gets a new code).
    const pending = await browser.post('/site-api/auth/register', {email: 'fresh@example.test', name: 'Y', password: PASSWORD});
    expect(again.status).toBe(202);
    expect(again.json).toEqual(fresh.json);
    expect(pending.json).toEqual(fresh.json);
    expect(emails.map(e => [e.kind, e.to]).sort()).toEqual([
      ['account_exists', 'known@example.test'],
      ['sign_up_code', 'fresh@example.test'],
    ]);
  });

  it('refresh rotates the token; a replayed old token after the grace window revokes the family', async () => {
    const browser = await signedIn(app, 'rot@example.test');
    const first = browser.cookie('site_rt')!;
    expect((await browser.post('/site-api/auth/refresh')).status).toBe(200);
    const second = browser.cookie('site_rt')!;
    expect(second).not.toBe(first);

    // Immediately replaying the old token = two tabs racing: refused, nothing revoked.
    const thief = new Browser(app, '192.0.2.66');
    thief.jar.set('__Host-site_rt', first);
    expect((await thief.post('/site-api/auth/refresh')).status).toBe(409);
    expect((await browser.post('/site-api/auth/refresh')).status).toBe(200);
    const third = browser.cookie('site_rt')!;

    // Later (past the 10 s grace): theft. The whole family dies, the owner's newest token too.
    await db.refreshToken.updateMany({where: {usedAt: {not: null}}, data: {usedAt: new Date(Date.now() - 60_000)}});
    const replay = await thief.post('/site-api/auth/refresh');
    expect(replay.status).toBe(401);
    const victim = new Browser(app);
    victim.jar.set('__Host-site_rt', third);
    expect((await victim.post('/site-api/auth/refresh')).status).toBe(401);
    const live = await db.refreshToken.count({where: {revokedAt: null}});
    expect(live).toBe(0);
    expect(await db.auditEvent.count({where: {action: 'refresh_reuse_detected'}})).toBe(1);
  });

  it('logout ends this device; logout-all ends every device at once', async () => {
    const laptop = await signedIn(app, 'multi@example.test');
    const phone = new Browser(app, '203.0.113.20');
    expect((await phone.post('/site-api/auth/login', {email: 'multi@example.test', password: PASSWORD})).status).toBe(200);

    // A copy of the laptop's access token (stolen, or a second tab that kept it).
    const copy = new Browser(app, '203.0.113.22');
    copy.jar.set('__Host-site_at', laptop.cookie('site_at')!);
    expect((await copy.get('/site-api/auth/me')).status).toBe(200);

    expect((await laptop.post('/site-api/auth/logout')).status).toBe(200);
    expect(laptop.cookie('site_at')).toBeUndefined();
    expect((await laptop.get('/site-api/auth/me')).status).toBe(401);
    // PIPE-13: the unexpired access token of the signed-out device stops working at once.
    expect((await copy.get('/site-api/auth/me')).status).toBe(401);
    expect((await phone.get('/site-api/auth/me')).status).toBe(200);

    const tablet = new Browser(app, '203.0.113.21');
    await tablet.post('/site-api/auth/login', {email: 'multi@example.test', password: PASSWORD});
    expect((await tablet.post('/site-api/auth/logout-all')).status).toBe(200);
    // The phone's access token is still unexpired, but session_version moved on.
    expect((await phone.get('/site-api/auth/me')).status).toBe(401);
    expect((await phone.post('/site-api/auth/refresh')).status).toBe(401);
  });

  it('forgot → reset is single use, expires, and ends every session', async () => {
    const old = await signedIn(app, 'reset@example.test');
    const browser = new Browser(app, '203.0.113.30');
    await browser.post('/site-api/auth/forgot-password', {email: 'reset@example.test'});
    const token = tokenFrom('password_reset', 'reset@example.test');

    expect((await browser.post('/site-api/auth/reset-password', {token, password: 'short'})).status).toBe(422);
    const ok = await browser.post('/site-api/auth/reset-password', {token, password: 'a brand new passphrase'});
    expect(ok.status).toBe(200);
    expect((await browser.post('/site-api/auth/reset-password', {token, password: 'yet another passphrase'})).status).toBe(400);
    expect(emails.some(e => e.kind === 'password_changed' && e.to === 'reset@example.test')).toBe(true);

    expect((await old.get('/site-api/auth/me')).status).toBe(401);
    expect((await browser.post('/site-api/auth/login', {email: 'reset@example.test', password: PASSWORD})).status).toBe(401);
    expect((await browser.post('/site-api/auth/login', {email: 'reset@example.test', password: 'a brand new passphrase'})).status).toBe(200);

    // A link past its 30 minutes is dead; asking again kills the previous link.
    await browser.post('/site-api/auth/forgot-password', {email: 'reset@example.test'});
    const late = tokenFrom('password_reset', 'reset@example.test');
    await db.passwordReset.updateMany({where: {usedAt: null}, data: {expiresAt: new Date(Date.now() - 1000)}});
    expect((await browser.post('/site-api/auth/reset-password', {token: late, password: 'one more passphrase!'})).status).toBe(400);
  });

  it('change-password needs the current one and signs out other devices', async () => {
    const here = await signedIn(app, 'change@example.test');
    const other = new Browser(app, '203.0.113.40');
    await other.post('/site-api/auth/login', {email: 'change@example.test', password: PASSWORD});

    const wrong = await here.post('/site-api/auth/change-password', {currentPassword: 'nope nope nope', newPassword: 'another long passphrase'});
    expect(wrong.status).toBe(422);
    expect(wrong.json.fields).toHaveProperty('currentPassword');

    const ok = await here.post('/site-api/auth/change-password', {currentPassword: PASSWORD, newPassword: 'another long passphrase'});
    expect(ok.status).toBe(200);
    expect((await here.get('/site-api/auth/me')).status).toBe(200); // this device got a fresh session
    expect((await other.get('/site-api/auth/me')).status).toBe(401);
  });

  it('rate-limits failed logins per email+IP with backoff, without locking other IPs out', async () => {
    await signedIn(app, 'target@example.test');
    const attacker = new Browser(app, '192.0.2.99');
    for (let i = 0; i < 5; i++) {
      expect((await attacker.post('/site-api/auth/login', {email: 'target@example.test', password: `guess ${i} guess`})).status).toBe(401);
    }
    const blocked = await attacker.post('/site-api/auth/login', {email: 'target@example.test', password: PASSWORD});
    expect(blocked.status).toBe(429); // even the right password waits
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.json.error).toBe('rate_limited');

    const owner = new Browser(app, '203.0.113.50');
    expect((await owner.post('/site-api/auth/login', {email: 'target@example.test', password: PASSWORD})).status).toBe(200);
    // Only keyed hashes are stored, never the email or the IP.
    const rows = await db.loginAttempt.findMany({select: {emailHash: true, ipHash: true}, take: 5});
    for (const row of rows) {
      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.emailHash ?? '').not.toContain('target');
    }
  });

  it('rate-limits sign-ups and reset emails', async () => {
    const browser = new Browser(app, '192.0.2.150');
    for (let i = 0; i < 5; i++) {
      expect((await browser.post('/site-api/auth/register', {email: `bulk${i}@example.test`, name: 'B', password: PASSWORD})).status).toBe(202);
    }
    expect((await browser.post('/site-api/auth/register', {email: 'bulk9@example.test', name: 'B', password: PASSWORD})).status).toBe(429);

    const resetter = new Browser(app, '192.0.2.151');
    // Asking again answers the same; the address gets one email per 15 minutes, whoever asks.
    for (let i = 0; i < 3; i++) {
      expect((await resetter.post('/site-api/auth/forgot-password', {email: 'bulk0@example.test'})).status).toBe(202);
    }
  });

  it('refuses writes without the CSRF token or from another site', async () => {
    const browser = new Browser(app);
    await browser.get('/site-api/auth/csrf');
    const noToken = await browser.request('POST', '/site-api/auth/login', {email: 'a@example.test', password: 'x'}, {'x-csrf-token': ''});
    expect(noToken.status).toBe(403);
    expect(noToken.json.error).toBe('csrf_failed');
    const crossSite = await browser.request('POST', '/site-api/auth/login', {}, {origin: 'https://evil.example'});
    expect(crossSite.status).toBe(403);
  });
});
