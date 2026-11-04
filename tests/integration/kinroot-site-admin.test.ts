import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {resetOwnerSeatForTests} from '../../src/platform/auth/owner-seat';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, DATABASE_URL, db, OWNER_ID, ownerAccountId, ownerSignedIn, ownerTickets, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Kinroot's Settings → Accounts, Roles and the Audit log's "Sign-in & security" tab
 * (`src/crm/lib/site-admin.ts`) call the site's own admin API. These are the exact calls those
 * screens make, by who may and may not make them, plus the one-click owner sign-in Kinroot's app
 * now redeems (`src/crm/CrmApp.tsx`: `POST /site-api/auth/owner {ticket, next}`).
 */
const PASSWORD = 'a long test passphrase';

describe.skipIf(!DATABASE_URL)('Kinroot site admin screens (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());

  describe('who may use the admin calls', () => {
    let owner: Browser;
    let admin: Browser;
    let customer: Browser;
    let ids: {owner: number; admin: number; customer: number};

    beforeEach(async () => {
      await resetDatabase();
      // The owner comes only from "View as admin" (a ticket); signing up never makes one.
      owner = await ownerSignedIn(app, undefined, '203.0.113.41');
      admin = await signedIn(app, 'admin@example.test', undefined, '203.0.113.42');
      // A support-portal customer: an account with no site role beyond the default.
      customer = await signedIn(app, 'customer@example.test', undefined, '203.0.113.43');
      ids = {owner: await ownerAccountId(), admin: await userId('admin@example.test'), customer: await userId('customer@example.test')};
      expect((await owner.request('PUT', `/site-api/admin/users/${ids.admin}/roles`, {roles: ['member', 'admin']})).status).toBe(200);
    });

    /** Every call the three screens make, with a body that would pass validation. */
    const calls = () => [
      ['GET', '/site-api/admin/users?before=&email=&status=', undefined],
      ['PATCH', `/site-api/admin/users/${ids.owner}`, {status: 'suspended'}],
      ['PUT', `/site-api/admin/users/${ids.owner}/roles`, {roles: ['member']}],
      ['POST', `/site-api/admin/users/${ids.owner}/sessions/revoke`, {}],
      ['POST', `/site-api/admin/users/${ids.owner}/two-factor/disable`, {}],
      ['GET', '/site-api/admin/roles', undefined],
      ['GET', '/site-api/admin/permissions', undefined],
      ['POST', '/site-api/admin/roles', {slug: 'sneaky', name: 'Sneaky', description: '', permissions: []}],
      ['PATCH', '/site-api/admin/roles/member', {name: 'Renamed', description: '', permissions: []}],
      ['DELETE', '/site-api/admin/roles/member', undefined],
      ['GET', '/site-api/admin/audit?before=', undefined],
    ] as const;

    it('a customer (no site permissions) sees no admin screen and every admin call is refused', async () => {
      const me = await customer.get('/site-api/me');
      expect(me.status).toBe(200);
      expect(me.json.abilities).toMatchObject({manageUsers: false, updateUsers: false, manageRoles: false, editRoles: false, readAudit: false});
      for (const [method, path, body] of calls()) {
        const res = await customer.request(method, path, body);
        expect([403, 404], `${method} ${path}`).toContain(res.status);
        expect(JSON.stringify(res.json)).not.toContain('owner@example.test');
      }
      // Nothing changed.
      expect((await db.user.findUniqueOrThrow({where: {id: ids.owner}})).status).toBe('active');
      expect(await db.role.count({where: {slug: 'sneaky'}})).toBe(0);
      expect(await db.role.findUnique({where: {slug: 'member'}})).toMatchObject({name: expect.not.stringMatching('Renamed')});
    });

    it('a signed-out visitor gets 401 from every call, and /me shows no abilities', async () => {
      const guest = new Browser(app, '203.0.113.49');
      expect((await guest.get('/site-api/me')).json.abilities).toMatchObject({manageUsers: false, readAudit: false});
      for (const [method, path, body] of calls()) {
        expect((await guest.request(method, path, body)).status, `${method} ${path}`).toBe(401);
      }
    });

    it('an admin sees Accounts (other addresses masked), Roles read-only and the security log', async () => {
      const me = await admin.get('/site-api/me');
      expect(me.json.abilities).toMatchObject({manageUsers: true, updateUsers: true, manageRoles: true, editRoles: false, readAudit: true});

      const list = await admin.get('/site-api/admin/users?before=&email=&status=');
      expect(list.status).toBe(200);
      expect((list.json.users as {email: string}[]).map((u) => u.email)).toEqual(['c•••@example.test', 'admin@example.test', ''] /* the site owner has no address here */);
      // Finding someone by address is the owner's alone: the screen hides the box, the server refuses it.
      expect((await admin.get('/site-api/admin/users?before=&email=customer%40example.test&status=')).status).toBe(403);

      // Block / unblock a customer, end their sessions.
      expect((await admin.request('PATCH', `/site-api/admin/users/${ids.customer}`, {status: 'suspended'})).status).toBe(200);
      expect((await customer.get('/site-api/auth/me')).status).toBe(401);
      expect((await admin.get('/site-api/admin/users?before=&email=&status=suspended')).json.users).toHaveLength(1);
      expect((await admin.request('PATCH', `/site-api/admin/users/${ids.customer}`, {status: 'active'})).status).toBe(200);
      expect((await admin.post(`/site-api/admin/users/${ids.customer}/sessions/revoke`)).status).toBe(200);

      // Never the owner, never themselves, never a role they could not grant.
      expect((await admin.request('PATCH', `/site-api/admin/users/${ids.owner}`, {status: 'suspended'})).status).toBe(403);
      expect((await admin.request('PATCH', `/site-api/admin/users/${ids.admin}`, {status: 'suspended'})).status).toBe(403);
      expect((await admin.request('PUT', `/site-api/admin/users/${ids.customer}/roles`, {roles: ['member', 'owner']})).status).toBe(403);

      // Roles: read, not change.
      expect((await admin.get('/site-api/admin/roles')).status).toBe(200);
      expect((await admin.get('/site-api/admin/permissions')).status).toBe(200);
      expect((await admin.post('/site-api/admin/roles', {slug: 'helper', name: 'Helper', permissions: []})).status).toBe(403);
      expect((await admin.request('DELETE', '/site-api/admin/roles/member')).status).toBe(403);

      // The security log names people, never their addresses.
      const audit = await admin.get('/site-api/admin/audit?before=');
      expect(audit.status).toBe(200);
      const actions = (audit.json.events as {action: string}[]).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['user_suspended', 'user_reactivated', 'user_sessions_revoked', 'user_roles_changed']));
      expect(JSON.stringify(audit.json)).not.toMatch(/@example\.test/);
    });

    it('the owner sees every address and manages roles; a role can only hold what its maker holds', async () => {
      const me = await owner.get('/site-api/me');
      expect(me.json.abilities).toMatchObject({manageUsers: true, updateUsers: true, manageRoles: true, editRoles: true, readAudit: true});
      expect(me.json.roles).toContain('owner');
      const found = await owner.get('/site-api/admin/users?before=&email=CUSTOMER%40example.test&status=');
      expect((found.json.users as {email: string}[]).map((u) => u.email)).toEqual(['customer@example.test']);

      const made = await owner.post('/site-api/admin/roles', {slug: 'support', name: 'Support', description: 'Sees accounts', permissions: ['site:user:read']});
      expect(made.status).toBe(201);
      const bad = await owner.post('/site-api/admin/roles', {slug: 'Bad Slug', name: '', permissions: []});
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.json.fields as object)).toEqual(expect.arrayContaining(['slug', 'name']));

      // Give it to the customer: they now see Accounts (masked), and nothing else.
      expect((await owner.request('PUT', `/site-api/admin/users/${ids.customer}/roles`, {roles: ['member', 'support']})).status).toBe(200);
      const theirs = await customer.get('/site-api/me');
      expect(theirs.json.abilities).toMatchObject({manageUsers: true, updateUsers: false, manageRoles: false, readAudit: false});
      expect((await customer.get('/site-api/admin/users?before=&email=&status=')).status).toBe(200);
      expect((await customer.request('PATCH', `/site-api/admin/users/${ids.admin}`, {status: 'suspended'})).status).toBe(403);
      expect((await customer.get('/site-api/admin/audit?before=')).status).toBe(403);

      // A support holder cannot write a role with more than they hold (they cannot write roles at all).
      expect((await customer.post('/site-api/admin/roles', {slug: 'boss', name: 'Boss', permissions: ['*']})).status).toBe(403);

      expect((await owner.request('PATCH', '/site-api/admin/roles/support', {name: 'Support desk', description: '', permissions: ['site:user:read', 'site:audit:read']})).status).toBe(200);
      expect((await customer.get('/site-api/admin/audit?before=')).status).toBe(200);
      expect((await owner.request('DELETE', '/site-api/admin/roles/support')).status).toBe(200);
      expect((await customer.get('/site-api/admin/audit?before=')).status).toBe(403);
      // Built-in roles and the owner role stay.
      expect((await owner.request('DELETE', '/site-api/admin/roles/member')).status).toBe(403);
      expect((await owner.request('PATCH', '/site-api/admin/roles/owner', {name: 'Not owner'})).status).toBe(403);
    });
  });

  describe('one-click owner sign-in, redeemed by Kinroot (POST, as src/crm/CrmApp.tsx sends it)', () => {
    const TICKET = 'K'.repeat(43);
    const NEXT = '/crm/settings/accounts';

    beforeEach(async () => {
      await resetDatabase();
      resetOwnerSeatForTests();
      vi.stubEnv('PROD', true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      env.SITE_PREVIEW = '';
    });

    it('signs the owner in, keeps the next address, and opens the admin screens; the ticket works once', async () => {
      ownerTickets.set(TICKET, {ownerId: OWNER_ID});
      const browser = new Browser(app, '203.0.113.51');
      const res = await browser.post('/site-api/auth/owner', {ticket: TICKET, next: NEXT});
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ok: true, next: NEXT});
      const me = await browser.get('/site-api/me');
      expect(me.json.roles).toContain('owner');
      expect(me.json.abilities).toMatchObject({manageUsers: true, manageRoles: true, editRoles: true, readAudit: true});
      expect((await browser.get('/site-api/admin/users?before=&email=&status=')).status).toBe(200);
      expect((await browser.get('/site-api/crm/auth/state')).json).toMatchObject({signedIn: true});

      // Spent: the app sends the visitor to /account/login/?notice=owner-link.
      const again = await new Browser(app, '203.0.113.52').post('/site-api/auth/owner', {ticket: TICKET, next: NEXT});
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.json.error).toBe('owner_link');
      const junk = await new Browser(app, '203.0.113.53').post('/site-api/auth/owner', {ticket: 'nope', next: NEXT});
      expect(junk.json.error).toBe('owner_link');
    });

    it('a ticket without the CSRF header is refused (the app sends it through siteFetch)', async () => {
      ownerTickets.set(TICKET, {ownerId: OWNER_ID});
      const res = await new Browser(app, '203.0.113.54').request('POST', '/site-api/auth/owner', {ticket: TICKET, next: NEXT}, {'x-csrf-token': ''});
      expect(res.status).toBe(403);
      expect(ownerTickets.has(TICKET)).toBe(true);
    });

    it('in the editor Preview the session travels in headers and the owner is signed in', async () => {
      env.SITE_PREVIEW = '1';
      ownerTickets.set(TICKET, {ownerId: OWNER_ID});
      const browser = new Browser(app, '203.0.113.55', 'preview');
      const res = await browser.post('/site-api/auth/owner', {ticket: TICKET, next: NEXT});
      expect(res.status).toBe(200);
      expect((await browser.get('/site-api/me')).json.roles).toContain('owner');
    });

    it('the owner account has no password, email or two-step here, and the CRM shows no address for it', async () => {
      const browser = await ownerSignedIn(app, undefined, '203.0.113.56');
      for (const [path, body] of [
        ['/site-api/auth/change-password', {currentPassword: PASSWORD, newPassword: `${PASSWORD} 2`}],
        ['/site-api/auth/two-factor/setup', {password: PASSWORD}],
        ['/site-api/auth/email', {email: 'boss@example.test', password: PASSWORD}],
        ['/site-api/auth/delete-account', {password: PASSWORD, confirm: 'DELETE'}],
      ] as const) {
        const res = await browser.post(path, body);
        expect(res.status, path).toBe(403);
        expect(res.json.error, path).toBe('owner_account');
      }
      // Kinroot: the CRM's first Owner, shown as the account owner, never with the placeholder address.
      const state = await browser.get('/site-api/crm/auth/state');
      expect(state.json.user).toMatchObject({role: 'OWNER', email: '', accountOwner: true});
      const team = await browser.get('/site-api/crm/team');
      expect(JSON.stringify(team.json)).not.toContain('owner.invalid');
    });
  });
});
