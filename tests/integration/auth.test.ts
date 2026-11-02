import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {authRoutes, DEFAULT_AUTH_SETTINGS} from '../../src/platform/auth';
import {csrf, sameOrigin} from '../../src/platform/guards';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {
  Browser,
  configureEnv,
  DATABASE_URL,
  db,
  emails,
  ownerSignedIn,
  resetDatabase,
  signedIn,
  tokenFrom,
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
    const mail = emails.find(e => e.kind === 'verify_email')!;
    expect(mail).toMatchObject({to: 'ann@example.test', expiresInMinutes: 24 * 60});
    expect(mail.path).toMatch(/^\/account\/verify\/\?token=[A-Za-z0-9_-]{43}$/);

    // Not confirmed yet: the right password is not enough.
    const early = await browser.post('/site-api/auth/login', {email: 'ann@example.test', password: PASSWORD});
    expect(early.status).toBe(403);
    expect(early.json.error).toBe('email_unverified');

    const token = tokenFrom('verify_email', 'ann@example.test');
    expect((await browser.post('/site-api/auth/verify-email', {token})).status).toBe(200);
    expect((await browser.post('/site-api/auth/verify-email', {token})).status).toBe(400); // single use

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
    expect(user.passwordHash).toMatch(/^pbkdf2-sha256\$v1\$600000\$/);
  });

  it('the first confirmed account becomes owner, the next ones members', async () => {
    const first = await signedIn(app, 'first@example.test');
    const second = await signedIn(app, 'second@example.test');
    expect((await first.get('/site-api/auth/me')).json.roles).toEqual(expect.arrayContaining(['owner', 'member']));
    expect((await second.get('/site-api/auth/me')).json.roles).toEqual(['member']);
    expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(await userId('first@example.test'));
    expect(await db.auditEvent.count({where: {action: 'owner_claimed'}})).toBe(1);
  });

  const listedApp = (settings: Partial<typeof DEFAULT_AUTH_SETTINGS> = {}) =>
    new Hono()
      .basePath('/site-api')
      .use(sameOrigin)
      .use(csrf)
      .route('/auth', authRoutes({...DEFAULT_AUTH_SETTINGS, ownerEmails: ['boss@example.test'], ...settings}));
  const ownerId = async () => (await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId;

  it('with ownerEmails set, only a listed address can claim owner', async () => {
    const restricted = listedApp();
    await signedIn(restricted, 'stranger@example.test');
    expect(await ownerId()).toBeNull();
    const boss = await ownerSignedIn(restricted, 'boss@example.test');
    expect(await ownerId()).toBe(await userId('boss@example.test'));
    expect((await boss.get('/site-api/auth/me')).status).toBe(200);
  });

  it('PIPE-10: a squatter who registers the owner address first never gets owner, nor keeps the password', async () => {
    const restricted = listedApp();
    const squatter = new Browser(restricted, '192.0.2.200');
    const squatPassword = 'the squatters own passphrase';
    expect(
      (await squatter.post('/site-api/auth/register', {email: 'boss@example.test', name: 'Boss', password: squatPassword})).status
    ).toBe(202);

    // The real owner gets the confirmation mail and clicks it.
    const owner = new Browser(restricted, '203.0.113.60');
    const verify = await owner.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', 'boss@example.test')});
    expect(verify.status).toBe(200);
    expect(verify.json.setPassword).toBe(true);
    // Not owner yet, and the squatter's password no longer opens the account.
    expect(await ownerId()).toBeNull();
    const squatLogin = await squatter.post('/site-api/auth/login', {email: 'boss@example.test', password: squatPassword});
    expect(squatLogin.status).toBe(401);

    // The inbox gets a link to choose a password; following it claims owner.
    const reset = await owner.post('/site-api/auth/reset-password', {
      token: tokenFrom('password_reset', 'boss@example.test'),
      password: 'the real owners passphrase',
    });
    expect(reset.status).toBe(200);
    expect(await ownerId()).toBe(await userId('boss@example.test'));
    expect((await owner.post('/site-api/auth/login', {email: 'boss@example.test', password: 'the real owners passphrase'})).status).toBe(200);
    expect((await owner.get('/site-api/auth/me')).json.roles).toEqual(expect.arrayContaining(['owner']));
    expect((await squatter.post('/site-api/auth/login', {email: 'boss@example.test', password: squatPassword})).status).toBe(401);
  });

  // Two sign-ups for one unconfirmed address, in both orders: whoever registered
  // first or last, neither chosen password survives; the inbox chooses it.
  for (const order of ['squatter first', 'real person first'] as const) {
    it(`PIPE-10: signing up again on an unconfirmed address (${order}) keeps neither password; the inbox chooses it`, async () => {
      const squatter = new Browser(app, '192.0.2.201');
      const pat = new Browser(app, '203.0.113.61');
      const squatPassword = 'the squatters own passphrase';
      const signUp = (who: Browser, name: string, password: string) =>
        who.post('/site-api/auth/register', {email: 'pat@example.test', name, password});
      if (order === 'squatter first') {
        expect((await signUp(squatter, 'Squat', squatPassword)).status).toBe(202);
      } else {
        expect((await signUp(pat, 'Pat', PASSWORD)).status).toBe(202);
      }
      const firstLink = tokenFrom('verify_email', 'pat@example.test');
      if (order === 'squatter first') {
        expect((await signUp(pat, 'Pat', PASSWORD)).status).toBe(202);
      } else {
        expect((await signUp(squatter, 'Squat', squatPassword)).status).toBe(202);
      }
      const secondLink = tokenFrom('verify_email', 'pat@example.test');
      expect(secondLink).not.toBe(firstLink);
      expect((await pat.post('/site-api/auth/verify-email', {token: firstLink})).status).toBe(400);

      // Only the inbox has the new link; confirming it asks for a password by email.
      const verify = await pat.post('/site-api/auth/verify-email', {token: secondLink});
      expect(verify.status).toBe(200);
      expect(verify.json.setPassword).toBe(true);
      for (const password of [PASSWORD, squatPassword]) {
        expect((await squatter.post('/site-api/auth/login', {email: 'pat@example.test', password})).status).toBe(401);
      }
      const reset = await pat.post('/site-api/auth/reset-password', {
        token: tokenFrom('password_reset', 'pat@example.test'),
        password: 'pats freshly chosen passphrase',
      });
      expect(reset.status).toBe(200);
      expect(
        (await pat.post('/site-api/auth/login', {email: 'pat@example.test', password: 'pats freshly chosen passphrase'})).status
      ).toBe(200);
      expect((await squatter.post('/site-api/auth/login', {email: 'pat@example.test', password: squatPassword})).status).toBe(401);
    });
  }

  it('PIPE-10: two sign-ups at the same moment keep neither password either (the unique-index loser too)', async () => {
    // Both hash, both find no account, both insert: the loser hits the unique index. It used to
    // answer 202 and stop, so the winner's password (maybe a squatter's) survived the real
    // person's confirmation. Several rounds, so the race actually happens.
    const squatPassword = 'the squatters own passphrase';
    for (let round = 0; round < 12; round++) {
      await resetDatabase();
      const squatter = new Browser(app, `192.0.2.${220 + round}`);
      const pat = new Browser(app, `203.0.113.${120 + round}`);
      const answers = await Promise.all([
        squatter.post('/site-api/auth/register', {email: 'race@example.test', name: 'Squat', password: squatPassword}),
        pat.post('/site-api/auth/register', {email: 'race@example.test', name: 'Pat', password: PASSWORD}),
      ]);
      expect(answers.map(a => a.status)).toEqual([202, 202]);
      const row = await db.user.findUnique({where: {email: 'race@example.test'}, select: {passwordHash: true}});
      expect(row!.passwordHash, `round ${round}`).toBe('!');
      expect((await pat.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', 'race@example.test')})).status).toBe(200);
      expect((await squatter.post('/site-api/auth/login', {email: 'race@example.test', password: squatPassword})).status).toBe(401);
    }
  });

  it('PIPE-10: a single sign-up keeps its password: confirming the link is enough to sign in', async () => {
    const pat = new Browser(app, '203.0.113.64');
    expect((await pat.post('/site-api/auth/register', {email: 'solo@example.test', name: 'Solo', password: PASSWORD})).status).toBe(202);
    const verify = await pat.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', 'solo@example.test')});
    expect(verify.status).toBe(200);
    expect(verify.json.setPassword).toBeUndefined();
    expect((await pat.post('/site-api/auth/login', {email: 'solo@example.test', password: PASSWORD})).status).toBe(200);
  });

  it('PIPE-11: the owner is never locked out: a reset link claims owner even after a squatter registered', async () => {
    const restricted = listedApp();
    await new Browser(restricted, '192.0.2.202').post('/site-api/auth/register', {
      email: 'boss@example.test',
      name: 'Boss',
      password: 'the squatters own passphrase',
    });
    const owner = new Browser(restricted, '203.0.113.62');
    expect((await owner.post('/site-api/auth/forgot-password', {email: 'boss@example.test'})).status).toBe(202);
    const reset = await owner.post('/site-api/auth/reset-password', {
      token: tokenFrom('password_reset', 'boss@example.test'),
      password: 'the real owners passphrase',
    });
    expect(reset.status).toBe(200);
    expect(await ownerId()).toBe(await userId('boss@example.test'));
  });

  it('PIPE-11: with verification off, registering the owner address proves nothing: owner comes with the reset link', async () => {
    const open = listedApp({requireEmailVerification: false});
    const first = new Browser(open, '192.0.2.203');
    const reg = await first.post('/site-api/auth/register', {email: 'boss@example.test', name: 'Boss', password: PASSWORD});
    expect(reg.status).toBe(201);
    expect((await first.get('/site-api/auth/me')).json.roles).toEqual(['member']);
    expect(await ownerId()).toBeNull();
    const reset = await new Browser(open, '203.0.113.63').post('/site-api/auth/reset-password', {
      token: tokenFrom('password_reset', 'boss@example.test'),
      password: 'the real owners passphrase',
    });
    expect(reset.status).toBe(200);
    expect(await ownerId()).toBe(await userId('boss@example.test'));
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
    await new Browser(app).post('/site-api/auth/register', {email: 'sus@example.test', name: 'S', password: PASSWORD});
    await db.user.update({where: {email: 'sus@example.test'}, data: {status: 'suspended'}});
    const res = await new Browser(app).post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', 'sus@example.test')});
    expect(res.status).toBe(400);
    expect((await db.user.findUniqueOrThrow({where: {email: 'sus@example.test'}})).emailVerifiedAt).toBeNull();
  });

  describe('on the live site (production build, not the Preview)', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      delete env.SITE_OWNER_EMAILS;
    });

    it('with no owner email, nobody becomes owner and health reports the missing setup', async () => {
      const first = await signedIn(app, 'first@example.test');
      expect((await first.get('/site-api/auth/me')).json.roles).toEqual(['member']);
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBeNull();
      expect(await db.auditEvent.count({where: {action: 'owner_claimed'}})).toBe(0);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no owner email'));
      expect((await first.get('/site-api/health')).json.ownerSetup).toBe(false);
    });

    it('the owner email (SITE_OWNER_EMAILS) is the only address that can claim owner', async () => {
      env.SITE_OWNER_EMAILS = ' Boss@Example.test ,not-an-email';
      const stranger = await signedIn(app, 'stranger@example.test');
      expect((await stranger.get('/site-api/health')).json.ownerSetup).toBe(true);
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBeNull();
      const boss = await ownerSignedIn(app, 'boss@example.test');
      expect((await boss.get('/site-api/auth/me')).json.roles).toEqual(expect.arrayContaining(['owner']));
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(await userId('boss@example.test'));
    });

    it('the editor Preview keeps the first-account claim', async () => {
      env.SITE_PREVIEW = '1';
      try {
        await signedIn(app, 'maker@example.test');
        expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(await userId('maker@example.test'));
      } finally {
        env.SITE_PREVIEW = '';
      }
    });
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
    // An account still waiting for its confirmation answers alike too (and gets a new link).
    const pending = await browser.post('/site-api/auth/register', {email: 'fresh@example.test', name: 'Y', password: PASSWORD});
    expect(again.status).toBe(202);
    expect(again.json).toEqual(fresh.json);
    expect(pending.json).toEqual(fresh.json);
    expect(emails.map(e => [e.kind, e.to]).sort()).toEqual([
      ['account_exists', 'known@example.test'],
      ['verify_email', 'fresh@example.test'],
      ['verify_email', 'fresh@example.test'],
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
    for (let i = 0; i < 3; i++) {
      expect((await resetter.post('/site-api/auth/forgot-password', {email: 'bulk0@example.test'})).status).toBe(202);
    }
    expect((await resetter.post('/site-api/auth/forgot-password', {email: 'bulk0@example.test'})).status).toBe(429);
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
