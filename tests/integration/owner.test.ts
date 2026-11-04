import {Hono} from 'hono';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {authRoutes, DEFAULT_AUTH_SETTINGS} from '../../src/platform/auth';
import {resetOwnerSeatForTests} from '../../src/platform/auth/owner-seat';
import {csrf, sameOrigin} from '../../src/platform/guards';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {
  Browser,
  codeFrom,
  mailGateOpen,
  signUpCodeFrom,
  configureEnv,
  DATABASE_URL,
  db,
  emails,
  NEXT_OWNER_ID,
  OWNER_ID,
  ownerAccountId,
  ownerSignedIn,
  ownerTickets,
  resetDatabase,
  signedIn,
  tokenFrom,
  userId,
} from './support/harness';


/**
 * Who the owner is (src/platform/auth/owner.ts): the account's owner pressing "View as admin", and
 * nobody else, by any other road. Each of these was a real way in or a real hole.
 */
const PASSWORD = 'a long test passphrase';
const roles = async (browser: Browser) => (await browser.get('/site-api/auth/me')).json.roles as string[];
const seat = async () => (await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId;

/** A deploy happened: this worker notices a new `SITE_OWNER_ID`. */
const deployedWith = (ownerId: string) => {
  env.SITE_OWNER_ID = ownerId;
  resetOwnerSeatForTests();
};

describe.skipIf(!DATABASE_URL)('the site owner (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(async () => {
    env.SITE_OWNER_ID = OWNER_ID;
    await resetDatabase();
  });
  afterAll(() => db.$disconnect());

  describe('the one way in', () => {
    it('a ticket signs the owner in, once, with no email, name or password here', async () => {
      const ticket = 'A'.repeat(43);
      ownerTickets.set(ticket, {ownerId: OWNER_ID});
      const browser = new Browser(app);
      const res = await browser.get(`/site-api/auth/owner?ticket=${ticket}`);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/dashboard');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await roles(browser)).toEqual(['owner']);
      const me = (await browser.get('/site-api/auth/me')).json.user as {email: string; platformOwner: boolean};
      expect(me.email).toBe('');
      expect(me.platformOwner).toBe(true);

      const row = await db.user.findUniqueOrThrow({where: {platformOwnerId: OWNER_ID}});
      expect(row.email).toMatch(/^owner-[0-9a-f]+@owner\.invalid$/);
      expect(row.passwordHash).toBe('!');
      expect(await seat()).toBe(row.id);

      const again = await new Browser(app).get(`/site-api/auth/owner?ticket=${ticket}`);
      expect(again.headers.get('location')).toBe('/account/login/?notice=owner-link');
    });

    it('a junk, unknown or malformed answer never signs anyone in', async () => {
      expect((await new Browser(app).get('/site-api/auth/owner?ticket=nope')).headers.get('location')).toContain('owner-link');
      expect((await new Browser(app).get(`/site-api/auth/owner?ticket=${'U'.repeat(43)}`)).headers.get('location')).toContain('owner-link');
      ownerTickets.set('B'.repeat(43), {ownerId: 'not an id'});
      expect((await new Browser(app).get(`/site-api/auth/owner?ticket=${'B'.repeat(43)}`)).headers.get('location')).toContain('owner-link');
      expect(await db.user.count()).toBe(0);
    });

    it('the same owner clicking again is the same account', async () => {
      await ownerSignedIn(app);
      await ownerSignedIn(app);
      expect(await db.user.count({where: {platformOwnerId: {not: null}}})).toBe(1);
    });
  });

  describe('no way around it', () => {
    it('the first account to sign up is a normal user, live', async () => {
      const first = await signedIn(app, 'first@example.test');
      expect(await roles(first)).toEqual(['member']);
      expect(await seat()).toBeNull();
    });

    it('the first account to sign up is a normal user, with no owner id at all (a local copy)', async () => {
      delete env.SITE_OWNER_ID;
      const first = await signedIn(app, 'first@example.test');
      expect(await roles(first)).toEqual(['member']);
      expect(await seat()).toBeNull();
    });

    it('an address in old settings, or the old env var, makes nobody owner by sign-up, reset or code', async () => {
      const boss = 'boss@example.test';
      env.SITE_OWNER_EMAILS = boss;
      const old = new Hono()
        .basePath('/site-api')
        .use(sameOrigin)
        .use(csrf)
        .route('/auth', authRoutes({...DEFAULT_AUTH_SETTINGS, ownerEmails: [boss], firstUserBecomesOwner: true}));
      try {
        const browser = await signedIn(old, boss, PASSWORD);
        expect((await db.userRole.count({where: {role: {slug: 'owner'}}}))).toBe(0);
        await browser.post('/site-api/auth/forgot-password', {email: boss});
        await browser.post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', boss), password: 'a brand new long passphrase'});
        expect(await db.userRole.count({where: {role: {slug: 'owner'}}})).toBe(0);
        const code = new Browser(old);
        await mailGateOpen();
        await code.post('/site-api/auth/code', {email: boss});
        await code.post('/site-api/auth/code/verify', {email: boss, code: codeFrom(boss)});
        expect(await db.userRole.count({where: {role: {slug: 'owner'}}})).toBe(0);
      } finally {
        delete env.SITE_OWNER_EMAILS;
      }
    });

    it('the owner placeholder address is refused everywhere a person types an address', async () => {
      await ownerSignedIn(app);
      const {email} = await db.user.findUniqueOrThrow({where: {platformOwnerId: OWNER_ID}, select: {email: true}});
      const browser = new Browser(app, '203.0.113.90');
      expect((await browser.post('/site-api/auth/register', {email, name: 'X', password: PASSWORD})).status).toBe(422);
      expect((await browser.post('/site-api/auth/login', {email, password: PASSWORD})).status).toBe(422);
      expect((await browser.post('/site-api/auth/code', {email})).status).toBe(422);
      expect((await browser.post('/site-api/auth/forgot-password', {email})).status).toBe(422);
      expect(emails.some(mail => mail.to === email)).toBe(false);
    });
  });

  describe('a stranger who signs up with the owner email', () => {
    it("can't take the owner's account, whatever order things happen in", async () => {
      const email = 'boss@example.test';
      const stranger = new Browser(app, '192.0.2.50');
      await stranger.post('/site-api/auth/register', {email, name: 'Stranger', password: PASSWORD});
      // The real owner clicks: that account has its own id, and nothing about the sign-up touches it.
      const owner = await ownerSignedIn(app);
      expect(await roles(owner)).toEqual(['owner']);
      expect(await db.user.findUnique({where: {email}})).toBeNull();
      // Whoever holds the code gets a normal account, never the owner's.
      const code = signUpCodeFrom(email);
      const made = await stranger.post('/site-api/auth/register/verify', {email, code});
      expect(made.status).toBe(201);
      expect(await roles(stranger)).toEqual(['member']);
      expect((await stranger.get('/site-api/admin/users')).status).toBe(403);
    });
  });

  describe('the owner can only be changed from the dashboard', () => {
    it('nobody inside the site can suspend, demote or end the sessions of the owner', async () => {
      const owner = await ownerSignedIn(app);
      const id = await ownerAccountId();
      const adminEmail = 'admin@example.test';
      const admin = await signedIn(app, adminEmail);
      expect((await owner.request('PUT', `/site-api/admin/users/${await userId(adminEmail)}/roles`, {roles: ['member', 'admin']})).status).toBe(200);
      expect((await admin.request('PATCH', `/site-api/admin/users/${id}`, {status: 'suspended'})).status).toBe(403);
      expect((await admin.request('PUT', `/site-api/admin/users/${id}/roles`, {roles: ['member']})).status).toBe(403);
      expect((await admin.post(`/site-api/admin/users/${id}/sessions/revoke`)).status).toBe(403);
      expect((await admin.post(`/site-api/admin/users/${id}/two-factor/disable`)).status).toBe(403);
      expect((await db.user.findUniqueOrThrow({where: {id}})).status).toBe('active');
    });

    it('no one can make another owner, not even the owner', async () => {
      const owner = await ownerSignedIn(app);
      await signedIn(app, 'friend@example.test');
      const res = await owner.request('PUT', `/site-api/admin/users/${await userId('friend@example.test')}/roles`, {roles: ['member', 'owner']});
      expect(res.status).toBe(403);
      expect(await db.userRole.count({where: {role: {slug: 'owner'}}})).toBe(1);
    });

    it('a click brings back an owner suspended behind the scenes', async () => {
      await ownerSignedIn(app);
      await db.user.update({where: {platformOwnerId: OWNER_ID}, data: {status: 'suspended'}});
      expect(await roles(await ownerSignedIn(app))).toEqual(['owner']);
    });

    it('the owner has no password, email, two-step or delete to set here', async () => {
      const owner = await ownerSignedIn(app);
      for (const [path, body] of [
        ['change-password', {currentPassword: 'x', newPassword: 'a brand new long passphrase'}],
        ['email', {email: 'new@example.test', password: 'x'}],
        ['two-factor/setup', {password: 'x'}],
        ['two-factor/enable', {code: '123456'}],
        ['two-factor/disable', {password: 'x'}],
        ['two-factor/recovery-codes', {password: 'x'}],
        ['delete-account', {password: 'x', confirm: 'DELETE'}],
      ] as const) {
        const res = await owner.post(`/site-api/auth/${path}`, body);
        expect(res.status, path).toBe(403);
        expect(res.json.error, path).toBe('owner_account');
      }
    });

    it("other admins see the owner's row with no address", async () => {
      const owner = await ownerSignedIn(app);
      const adminEmail = 'admin@example.test';
      const admin = await signedIn(app, adminEmail);
      await owner.request('PUT', `/site-api/admin/users/${await userId(adminEmail)}/roles`, {roles: ['member', 'admin']});
      const rows = (await admin.get('/site-api/admin/users')).json.users as {email: string; platformOwner: boolean}[];
      expect(rows.find(row => row.platformOwner)?.email).toBe('');
      expect(JSON.stringify(rows)).not.toContain('owner.invalid');
    });
  });

  describe('when the site changes hands', () => {
    /** An owner, an admin they made, someone with a custom admin role, a shop role and a member. */
    async function setUp() {
      const owner = await ownerSignedIn(app);
      const admin = await signedIn(app, 'admin@example.test');
      const manager = await signedIn(app, 'manager@example.test');
      const member = await signedIn(app, 'member@example.test');
      await owner.request('PUT', `/site-api/admin/users/${await userId('admin@example.test')}/roles`, {roles: ['member', 'admin']});
      const permission = await db.permission.findFirstOrThrow({where: {codename: {startsWith: 'site:'}}, select: {id: true}});
      const custom = await db.role.create({data: {slug: 'manager', name: 'Manager', permissions: {create: {permissionId: permission.id}}}, select: {id: true}});
      await db.userRole.create({data: {userId: await userId('manager@example.test'), roleId: custom.id}});
      return {owner, admin, manager, member};
    }

    it('a deploy with a new owner takes every admin right, ends those sessions, and keeps normal users', async () => {
      const {owner, admin, manager, member} = await setUp();
      await member.get('/site-api/auth/me');
      await owner.get('/site-api/auth/me');
      const oldOwner = await ownerAccountId();

      deployedWith(NEXT_OWNER_ID);
      // Anyone's next request notices.
      expect((await member.get('/site-api/auth/me')).status).toBe(200);
      expect(await db.user.count({where: {id: oldOwner}})).toBe(0);
      expect(await seat()).toBeNull();
      expect((await owner.get('/site-api/auth/me')).status).toBe(401);
      expect((await admin.get('/site-api/auth/me')).status).toBe(401);
      expect((await manager.get('/site-api/auth/me')).status).toBe(401);
      expect(await db.userRole.count({where: {role: {slug: {in: ['owner', 'admin', 'manager']}}}})).toBe(0);
      expect(await roles(member)).toEqual(['member']);

      // They can still sign in, as normal users.
      const back = new Browser(app, '192.0.2.60');
      expect((await back.post('/site-api/auth/login', {email: 'admin@example.test', password: PASSWORD})).status).toBe(200);
      expect(await roles(back)).toEqual(['member']);
      expect((await back.get('/site-api/admin/users')).status).toBe(403);

      const heir = await ownerSignedIn(app, NEXT_OWNER_ID);
      expect(await roles(heir)).toEqual(['owner']);
      expect(await seat()).toBe(await ownerAccountId(NEXT_OWNER_ID));
    });

    it('the new owner clicking BEFORE the deploy does the same, and the deploy then changes nothing', async () => {
      await setUp();
      const heir = await ownerSignedIn(app, NEXT_OWNER_ID);
      expect(await roles(heir)).toEqual(['owner']);
      expect(await db.user.count({where: {platformOwnerId: OWNER_ID}})).toBe(0);
      expect(await db.userRole.count({where: {role: {slug: 'admin'}}})).toBe(0);
      expect(await db.auditEvent.count({where: {action: 'owner_transferred'}})).toBe(1);

      // The new owner gives someone admin; the deploy that follows must not take it away.
      await heir.request('PUT', `/site-api/admin/users/${await userId('member@example.test')}/roles`, {roles: ['member', 'admin']});
      deployedWith(NEXT_OWNER_ID);
      expect(await roles(heir)).toEqual(['owner']);
      expect(await db.userRole.count({where: {role: {slug: 'admin'}}})).toBe(1);
    });

    it("the old value left in the env doesn't strip a new owner who clicked in before the deploy", async () => {
      const first = await ownerSignedIn(app);
      await first.get('/site-api/auth/me'); // The env value is recorded.
      const heir = await ownerSignedIn(app, NEXT_OWNER_ID);
      resetOwnerSeatForTests(); // Another worker, same old env.
      expect(await roles(heir)).toEqual(['owner']);
    });
  });

  describe('a site upgrading from the old rules', () => {
    it('anyone holding owner without a platform id loses it; admins and accounts stay', async () => {
      const old = await signedIn(app, 'old-owner@example.test');
      const admin = await signedIn(app, 'staff@example.test');
      const ownerRole = await db.role.findUniqueOrThrow({where: {slug: 'owner'}, select: {id: true}});
      const adminRole = await db.role.findUniqueOrThrow({where: {slug: 'admin'}, select: {id: true}});
      const oldId = await userId('old-owner@example.test');
      await db.userRole.create({data: {userId: oldId, roleId: ownerRole.id}});
      await db.userRole.create({data: {userId: await userId('staff@example.test'), roleId: adminRole.id}});
      await db.authState.update({where: {id: 1}, data: {ownerUserId: oldId}});

      expect(await roles(old)).toEqual(['member']);
      expect(await seat()).toBeNull();
      expect(await roles(admin)).toEqual(expect.arrayContaining(['admin']));

      expect(await roles(await ownerSignedIn(app))).toEqual(['owner']);
      expect(await roles(admin)).toEqual(expect.arrayContaining(['admin']));
    });
  });
});
