import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {PREVIEW_COOKIE_HEADER, PREVIEW_SET_COOKIE_HEADER} from '../../src/platform/auth/preview-cookies';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, tokenFrom, userId} from './support/harness';

/**
 * Sign-in behind the editor Preview's gateway, which drops `Cookie` and
 * `Set-Cookie`: the auth cookies travel in the Preview's own headers, and
 * every rule (CSRF, rotation, sign-out) still holds. On the live site those
 * headers mean nothing.
 */
const PASSWORD = 'a long test passphrase';

describe.skipIf(!DATABASE_URL)('the editor Preview (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  describe('with SITE_PREVIEW=1', () => {
    beforeEach(() => {
      env.SITE_PREVIEW = '1';
    });
    afterEach(() => {
      env.SITE_PREVIEW = '';
    });

    it('register → verify → login → me → refresh → logout, with no cookie ever passing', async () => {
      const browser = new Browser(app, '203.0.113.30', 'preview');
      const reg = await browser.post('/site-api/auth/register', {email: 'maker@example.test', name: 'Maker', password: PASSWORD});
      expect(reg.status).toBe(202);
      expect(browser.cookie('site_csrf')).toBeTruthy();
      expect((await browser.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', 'maker@example.test')})).status).toBe(200);

      const login = await browser.post('/site-api/auth/login', {email: 'maker@example.test', password: PASSWORD});
      expect(login.status).toBe(200);
      // The real cookies are still set (a gateway that passes them loses nothing) and mirrored.
      expect(login.headers.getSetCookie().join('\n')).toMatch(/__Host-site_at=.*HttpOnly/);
      const mirrored = JSON.parse(login.headers.get(PREVIEW_SET_COOKIE_HEADER) ?? '[]') as [string, string, number][];
      expect(mirrored.map(([name]) => name).sort()).toEqual(['__Host-site_at', '__Host-site_rt']);

      const me = await browser.get('/site-api/auth/me');
      expect(me.status).toBe(200);
      // The Preview's first account becomes owner (no owner list there).
      expect(me.json.roles).toEqual(expect.arrayContaining(['owner']));
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(await userId('maker@example.test'));

      const before = browser.cookie('site_rt');
      expect((await browser.post('/site-api/auth/refresh')).status).toBe(200);
      expect(browser.cookie('site_rt')).not.toBe(before);
      expect((await browser.get('/site-api/auth/me')).status).toBe(200);

      expect((await browser.post('/site-api/auth/logout')).status).toBe(200);
      expect(browser.cookie('site_at')).toBeUndefined();
      expect(browser.cookie('site_rt')).toBeUndefined();
      expect((await browser.get('/site-api/auth/me')).status).toBe(401);
    });

    it('still refuses a write without the CSRF token', async () => {
      const browser = new Browser(app, '203.0.113.31', 'preview');
      await browser.get('/site-api/auth/csrf');
      const res = await browser.request('POST', '/site-api/auth/login', {email: 'a@example.test', password: PASSWORD}, {'x-csrf-token': ''});
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('csrf_failed');
    });

    it('a session carried next to other cookie names still works (they are dropped)', async () => {
      const browser = await signedIn(app, 'only@example.test');
      const preview = new Browser(app, '203.0.113.32', 'preview');
      preview.jar.set('__Host-site_at', browser.cookie('site_at')!);
      preview.jar.set('theme', 'dark; injected=1');
      const res = await preview.get('/site-api/auth/me');
      expect(res.status).toBe(200);
      expect(res.json.user).toMatchObject({email: 'only@example.test'});
    });
  });

  describe('on a site that is not the Preview', () => {
    it('ignores the Preview cookie header and never mirrors a cookie', async () => {
      const browser = await signedIn(app, 'live@example.test');
      const access = browser.cookie('site_at')!;

      const stranger = new Browser(app, '203.0.113.33');
      const res = await stranger.request('GET', '/site-api/auth/me', undefined, {[PREVIEW_COOKIE_HEADER]: `__Host-site_at=${access}`});
      expect(res.status).toBe(401);

      const login = await new Browser(app, '203.0.113.34').post('/site-api/auth/login', {email: 'live@example.test', password: PASSWORD});
      expect(login.status).toBe(200);
      expect(login.headers.get(PREVIEW_SET_COOKIE_HEADER)).toBeNull();
    });
  });
});
