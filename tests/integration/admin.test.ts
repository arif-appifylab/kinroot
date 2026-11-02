import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/** Users, roles and the anti-escalation rules, against a real Postgres. */
describe.skipIf(!DATABASE_URL)('admin (integration, real Postgres)', () => {
  let owner: Browser;
  let admin: Browser;
  let member: Browser;
  let ids: {owner: number; admin: number; member: number};

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    owner = await signedIn(app, 'owner@example.test', undefined, '203.0.113.1');
    admin = await signedIn(app, 'admin@example.test', undefined, '203.0.113.2');
    member = await signedIn(app, 'member@example.test', undefined, '203.0.113.3');
    ids = {
      owner: await userId('owner@example.test'),
      admin: await userId('admin@example.test'),
      member: await userId('member@example.test'),
    };
    const made = await owner.request('PUT', `/site-api/admin/users/${ids.admin}/roles`, {roles: ['member', 'admin']});
    expect(made.status).toBe(200);
  });

  it('members cannot reach the admin API; admins can list users', async () => {
    expect((await member.get('/site-api/admin/users')).status).toBe(403);
    expect((await new Browser(app).get('/site-api/admin/users')).status).toBe(401);
    const list = await admin.get('/site-api/admin/users');
    expect(list.status).toBe(200);
    // Owner's rule: an email is visible only to its own user and to the site's owner.
    expect((list.json.users as {email: string}[]).map(u => u.email)).toEqual([
      'm•••@example.test',
      'admin@example.test',
      'o•••@example.test',
    ]);
    expect((await admin.get('/site-api/admin/users?email=MEMBER@example.test')).status).toBe(403);
    expect((await admin.get(`/site-api/admin/users/${ids.member}`)).json.user.email).toBe('m•••@example.test');
  });

  it('the site owner sees every email and can look people up by email', async () => {
    const list = await owner.get('/site-api/admin/users');
    expect((list.json.users as {email: string}[]).map(u => u.email)).toEqual([
      'member@example.test',
      'admin@example.test',
      'owner@example.test',
    ]);
    const found = await owner.get('/site-api/admin/users?email=MEMBER@example.test');
    expect((found.json.users as unknown[]).length).toBe(1);
  });

  it('an admin cannot make anyone owner, nor touch an owner', async () => {
    const self = await admin.request('PUT', `/site-api/admin/users/${ids.admin}/roles`, {roles: ['member', 'admin', 'owner']});
    expect(self.status).toBe(403);
    const other = await admin.request('PUT', `/site-api/admin/users/${ids.member}/roles`, {roles: ['member', 'owner']});
    expect(other.status).toBe(403);
    expect((await admin.request('PATCH', `/site-api/admin/users/${ids.owner}`, {status: 'suspended'})).status).toBe(403);
    expect((await admin.request('PUT', `/site-api/admin/users/${ids.owner}/roles`, {roles: ['owner']})).status).toBe(403);
    expect((await admin.post(`/site-api/admin/users/${ids.owner}/sessions/revoke`)).status).toBe(403);
    // Admins hold role:read, not role:update.
    expect((await admin.get('/site-api/admin/roles')).status).toBe(200);
    expect((await admin.post('/site-api/admin/roles', {slug: 'sneaky', name: 'Sneaky', permissions: ['*']})).status).toBe(403);
  });

  it('an admin can suspend a member, which ends their sessions at once', async () => {
    expect((await member.get('/site-api/auth/me')).status).toBe(200);
    const res = await admin.request('PATCH', `/site-api/admin/users/${ids.member}`, {status: 'suspended'});
    expect(res.status).toBe(200);
    expect((await member.get('/site-api/auth/me')).status).toBe(401);
    expect((await member.post('/site-api/auth/refresh')).status).toBe(401);
    const login = await new Browser(app, '203.0.113.9').post('/site-api/auth/login', {
      email: 'member@example.test',
      password: 'a long test passphrase',
    });
    expect(login.status).toBe(403);
    expect(login.json.error).toBe('account_suspended');
    expect(await db.auditEvent.count({where: {action: 'user_suspended'}})).toBe(1);
  });

  it('nobody suspends themselves, and the last owner keeps the role', async () => {
    expect((await owner.request('PATCH', `/site-api/admin/users/${ids.owner}`, {status: 'suspended'})).status).toBe(403);
    expect((await owner.request('PUT', `/site-api/admin/users/${ids.owner}/roles`, {roles: ['member']})).status).toBe(403);
    // With a second owner, the first may step down.
    expect((await owner.request('PUT', `/site-api/admin/users/${ids.member}/roles`, {roles: ['member', 'owner']})).status).toBe(200);
    expect((await owner.request('PUT', `/site-api/admin/users/${ids.owner}/roles`, {roles: ['member']})).status).toBe(200);
  });

  it('two owners removing each other at the same moment never leave the site with no owner (PIPE-13)', async () => {
    expect((await owner.request('PUT', `/site-api/admin/users/${ids.member}/roles`, {roles: ['member', 'owner']})).status).toBe(200);
    for (let round = 0; round < 3; round++) {
      const [a, b] = await Promise.all([
        owner.request('PUT', `/site-api/admin/users/${ids.member}/roles`, {roles: ['member']}),
        member.request('PUT', `/site-api/admin/users/${ids.owner}/roles`, {roles: ['member']}),
      ]);
      const owners = await db.userRole.count({where: {role: {slug: 'owner'}}});
      expect(owners).toBe(1);
      expect([a.status, b.status].sort()).toEqual([200, 403]);
      // Put the second owner back (whoever is left does it) for the next round.
      const left = (await db.userRole.findFirstOrThrow({where: {role: {slug: 'owner'}}, select: {userId: true}})).userId;
      const [keeper, other] = left === ids.owner ? [owner, ids.member] : [member, ids.owner];
      expect((await keeper.request('PUT', `/site-api/admin/users/${other}/roles`, {roles: ['member', 'owner']})).status).toBe(200);
    }
  });

  it('roles: only permissions you hold can be granted; owner and built-ins are protected', async () => {
    const created = await owner.post('/site-api/admin/roles', {
      slug: 'editor',
      name: 'Editor',
      permissions: ['site:job:manage'],
    });
    expect(created.status).toBe(201);
    expect((await owner.request('PATCH', '/site-api/admin/roles/owner', {name: 'Boss'})).status).toBe(403);
    expect((await owner.request('DELETE', '/site-api/admin/roles/admin')).status).toBe(403);
    expect((await owner.post('/site-api/admin/roles', {slug: 'bad', name: 'Bad', permissions: ['site:nope:nope']})).status).toBe(422);

    // An admin who could edit roles still cannot grant what they lack: give them role:update via a role.
    await owner.post('/site-api/admin/roles', {slug: 'role-editor', name: 'Role editor', permissions: ['site:role:update']});
    await owner.request('PUT', `/site-api/admin/users/${ids.admin}/roles`, {roles: ['member', 'admin', 'role-editor']});
    expect((await admin.request('PATCH', '/site-api/admin/roles/editor', {permissions: ['site:job:manage', '*']})).status).toBe(403);
    expect((await admin.request('PATCH', '/site-api/admin/roles/editor', {permissions: ['site:user:read']})).status).toBe(200);
    expect((await owner.request('DELETE', '/site-api/admin/roles/editor')).status).toBe(200);
  });

  it('permissions apply on the next request, and the audit log records changes', async () => {
    expect((await member.get('/site-api/jobs/manage?before=')).status).toBe(403);
    await owner.request('PUT', `/site-api/admin/users/${ids.member}/roles`, {roles: ['member', 'admin']});
    expect((await member.get('/site-api/jobs/manage?before=')).status).toBe(200);
    const audit = await owner.get('/site-api/admin/audit');
    expect(audit.status).toBe(200);
    const actions = (audit.json.events as {action: string}[]).map(e => e.action);
    expect(actions).toContain('user_roles_changed');
    expect(JSON.stringify(audit.json)).not.toContain('@example.test');
    // The person acted on is named (their name, never their email).
    const changed = (audit.json.events as {action: string; target: string; targetName: string | null}[]).find(
      e => e.action === 'user_roles_changed' && e.target === `user:${ids.member}`
    );
    expect(changed?.targetName).toBeTruthy();
  });

  it('the roles list says how many people hold each role', async () => {
    const res = await owner.get('/site-api/admin/roles');
    expect(res.status).toBe(200);
    const members = Object.fromEntries(
      (res.json.roles as {slug: string; members: {count: number; more: boolean}}[]).map(r => [r.slug, r.members])
    );
    expect(members.admin).toEqual({count: 1, more: false});
    expect(members.owner?.count).toBeGreaterThanOrEqual(1);
    expect(members.member?.count).toBe(3);
  });

  it('an admin turns off a member\'s two-step sign-in, but never an owner\'s', async () => {
    await db.user.update({where: {id: ids.member}, data: {totpEnabledAt: new Date()}});
    const off = await admin.post(`/site-api/admin/users/${ids.member}/two-factor/disable`);
    expect(off.status).toBe(200);
    expect((off.json.user as {twoFactor: boolean}).twoFactor).toBe(false);
    expect((await admin.post(`/site-api/admin/users/${ids.owner}/two-factor/disable`)).status).toBe(403);
  });
});
