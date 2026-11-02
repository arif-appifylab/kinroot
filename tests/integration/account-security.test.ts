import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {resetOwnerSeatForTests} from '../../src/platform/auth/owner-seat';
import {fromBase32, stepAt, totpCode} from '../../src/platform/auth/two-factor';
import {app} from '../../src/server/app';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, DATABASE_URL, db, emails, ownerTickets, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Account security end to end: one-click owner sign-in from the dashboard, two-step sign-in,
 * moving an account to a new address, signed-in devices and deleting an account.
 */
const PASSWORD = 'a long test passphrase';
const TICKET = 'T'.repeat(43);
const code = async (secret: string, offset = 0) => totpCode(fromBase32(secret)!, stepAt() + offset);
const tokenOf = (path: string | undefined) => new URL(path!, 'https://x.test').searchParams.get('token')!;

describe.skipIf(!DATABASE_URL)('account security (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  describe('one click from the dashboard ("Open admin")', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      env.SITE_OWNER_EMAILS = 'boss@example.test';
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      delete env.SITE_OWNER_EMAILS;
    });

    it('signs an owner address in as owner, with no account yet, and the ticket works once', async () => {
      ownerTickets.set(TICKET, {email: 'Boss@Example.test', name: 'The Boss', ownerEmails: ['boss@example.test']});
      const browser = new Browser(app);
      const res = await browser.get(`/site-api/auth/owner?ticket=${TICKET}`);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/dashboard');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const me = await browser.get('/site-api/auth/me');
      expect(me.json.roles).toContain('owner');
      const user = await db.user.findUniqueOrThrow({where: {email: 'boss@example.test'}});
      expect(user.name).toBe('The Boss');
      expect(user.emailVerifiedAt).not.toBeNull();
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(user.id);
      // No password was set: the password form never signs this account in.
      expect((await new Browser(app).post('/site-api/auth/login', {email: 'boss@example.test', password: 'whatever it is'})).status).toBe(401);

      const again = await new Browser(app).get(`/site-api/auth/owner?ticket=${TICKET}`);
      expect(again.status).toBe(303);
      expect(again.headers.get('location')).toBe('/account/login/?notice=owner-link');
    });

    it('a junk or unknown ticket never signs anyone in', async () => {
      const junk = await new Browser(app).get('/site-api/auth/owner?ticket=nope');
      expect(junk.headers.get('location')).toBe('/account/login/?notice=owner-link');
      const unknown = await new Browser(app).get(`/site-api/auth/owner?ticket=${'U'.repeat(43)}`);
      expect(unknown.headers.get('location')).toBe('/account/login/?notice=owner-link');
      expect(await db.user.count()).toBe(0);
    });

    it('a new owner address takes the seat from an address that left the list; the old one loses owner', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      await new Browser(app).get(`/site-api/auth/owner?ticket=${TICKET}`);
      const oldId = await userId('boss@example.test');

      // The account changed hands: the platform's list is now the new owner only.
      env.SITE_OWNER_EMAILS = 'heir@example.test';
      const next = 'N'.repeat(43);
      ownerTickets.set(next, {email: 'heir@example.test', name: 'Heir', ownerEmails: ['heir@example.test']});
      const heir = new Browser(app);
      expect((await heir.get(`/site-api/auth/owner?ticket=${next}`)).status).toBe(303);
      expect((await heir.get('/site-api/auth/me')).json.roles).toContain('owner');
      const heirId = await userId('heir@example.test');
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(heirId);
      const oldRoles = await db.userRole.findMany({where: {userId: oldId}, select: {role: {select: {slug: true}}}});
      expect(oldRoles.map(r => r.role.slug)).not.toContain('owner');
      expect(await db.auditEvent.count({where: {action: 'owner_transferred'}})).toBe(1);
    });

    it('a deploy that drops the old owner from the list takes owner away at their next request, with nobody signing in', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      const boss = new Browser(app);
      await boss.get(`/site-api/auth/owner?ticket=${TICKET}`);
      expect((await boss.get('/site-api/auth/me')).json.roles).toContain('owner');
      const oldId = await userId('boss@example.test');

      // The site was handed to another account and deployed again: the list is the new owner only.
      env.SITE_OWNER_EMAILS = 'heir@example.test';
      resetOwnerSeatForTests();
      const me = await boss.get('/site-api/auth/me');
      expect(me.json.roles).not.toContain('owner');
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBeNull();
      const oldRoles = await db.userRole.findMany({where: {userId: oldId}, select: {role: {select: {slug: true}}}});
      expect(oldRoles.map(r => r.role.slug)).not.toContain('owner');
      expect(await db.auditEvent.count({where: {action: 'owner_removed'}})).toBe(1);

      // The new owner takes the free seat with one click.
      const next = 'N'.repeat(43);
      ownerTickets.set(next, {email: 'heir@example.test', name: 'Heir', ownerEmails: ['heir@example.test']});
      const heir = new Browser(app);
      expect((await heir.get(`/site-api/auth/owner?ticket=${next}`)).status).toBe(303);
      expect((await heir.get('/site-api/auth/me')).json.roles).toContain('owner');
    });

    it('a co-owner on the list gets owner too, without taking the seat', async () => {
      env.SITE_OWNER_EMAILS = 'boss@example.test,partner@example.test';
      const list = ['boss@example.test', 'partner@example.test'];
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: list});
      await new Browser(app).get(`/site-api/auth/owner?ticket=${TICKET}`);
      const other = 'P'.repeat(43);
      ownerTickets.set(other, {email: 'partner@example.test', name: 'Partner', ownerEmails: list});
      const partner = new Browser(app);
      await partner.get(`/site-api/auth/owner?ticket=${other}`);
      expect((await partner.get('/site-api/auth/me')).json.roles).toContain('owner');
      expect((await db.authState.findUniqueOrThrow({where: {id: 1}})).ownerUserId).toBe(await userId('boss@example.test'));
    });

    it('a suspended account is refused', async () => {
      ownerTickets.set(TICKET, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      await new Browser(app).get(`/site-api/auth/owner?ticket=${TICKET}`);
      await db.user.update({where: {email: 'boss@example.test'}, data: {status: 'suspended'}});
      const again = 'S'.repeat(43);
      ownerTickets.set(again, {email: 'boss@example.test', name: 'Boss', ownerEmails: ['boss@example.test']});
      const res = await new Browser(app).get(`/site-api/auth/owner?ticket=${again}`);
      expect(res.headers.get('location')).toBe('/account/login/?notice=suspended');
    });
  });

  describe('two-step sign-in', () => {
    async function withTwoFactor(email: string) {
      const browser = await signedIn(app, email);
      const setup = await browser.post('/site-api/auth/two-factor/setup', {password: PASSWORD});
      expect(setup.status).toBe(200);
      const secret = setup.json.secret as string;
      expect(setup.json.qr).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(String(setup.json.uri)).toContain(`secret=${secret}`);
      // Not on until a code confirms the app.
      expect((await browser.get('/site-api/auth/two-factor')).json.enabled).toBe(false);
      expect((await browser.post('/site-api/auth/two-factor/enable', {code: '000000'})).status).toBe(422);
      const enabled = await browser.post('/site-api/auth/two-factor/enable', {code: await code(secret)});
      expect(enabled.status).toBe(200);
      const recoveryCodes = enabled.json.recoveryCodes as string[];
      expect(recoveryCodes).toHaveLength(10);
      return {browser, secret, recoveryCodes};
    }

    it('setup needs the password, and then signing in needs a code', async () => {
      const browser = await signedIn(app, 'ann@example.test');
      expect((await browser.post('/site-api/auth/two-factor/setup', {password: 'wrong one entirely'})).status).toBe(422);
      const {secret} = await withTwoFactor('bea@example.test');
      const user = await db.user.findUniqueOrThrow({where: {email: 'bea@example.test'}});
      expect(user.totpSecretSealed).not.toContain(secret);

      const fresh = new Browser(app);
      const login = await fresh.post('/site-api/auth/login', {email: 'bea@example.test', password: PASSWORD});
      expect(login.status).toBe(202);
      expect(login.json.twoFactor).toBe(true);
      expect(fresh.cookie('site_at')).toBeUndefined();
      const challenge = login.json.challenge as string;

      expect((await fresh.post('/site-api/auth/login/two-factor', {challenge, code: '123456'})).status).toBe(422);
      // The code the setup used is spent; the next step's code works.
      const ok = await fresh.post('/site-api/auth/login/two-factor', {challenge, code: await code(secret, 1)});
      expect(ok.status).toBe(200);
      expect((await fresh.get('/site-api/auth/me')).json.user).toMatchObject({email: 'bea@example.test'});
      // The same code never works twice.
      const replay = await new Browser(app).post('/site-api/auth/login', {email: 'bea@example.test', password: PASSWORD});
      expect(
        (await new Browser(app).post('/site-api/auth/login/two-factor', {challenge: replay.json.challenge, code: await code(secret, 1)})).status
      ).toBe(422);
    });

    it('a recovery code works once; a forged or stale challenge never', async () => {
      const {recoveryCodes} = await withTwoFactor('cat@example.test');
      const login = await new Browser(app).post('/site-api/auth/login', {email: 'cat@example.test', password: PASSWORD});
      const challenge = login.json.challenge as string;
      expect((await new Browser(app).post('/site-api/auth/login/two-factor', {challenge: `${challenge}x`, code: recoveryCodes[0]})).status).toBe(401);
      const browser = new Browser(app);
      expect((await browser.post('/site-api/auth/login/two-factor', {challenge, code: recoveryCodes[0]!.toUpperCase()})).status).toBe(200);
      expect((await browser.get('/site-api/auth/two-factor')).json.recoveryCodesLeft).toBe(9);
      expect((await new Browser(app).post('/site-api/auth/login/two-factor', {challenge, code: recoveryCodes[0]})).status).toBe(422);

      // A password change since the password step voids the challenge.
      const second = await new Browser(app).post('/site-api/auth/login', {email: 'cat@example.test', password: PASSWORD});
      await db.user.update({where: {email: 'cat@example.test'}, data: {sessionVersion: {increment: 1}}});
      expect(
        (await new Browser(app).post('/site-api/auth/login/two-factor', {challenge: second.json.challenge, code: recoveryCodes[1]})).status
      ).toBe(401);
    });

    it('turning it off needs the password; an admin can turn it off for someone who lost their phone', async () => {
      const {browser} = await withTwoFactor('dan@example.test');
      expect((await browser.post('/site-api/auth/two-factor/disable', {password: 'not the password'})).status).toBe(422);
      expect((await browser.post('/site-api/auth/two-factor/disable', {password: PASSWORD})).status).toBe(200);
      expect((await new Browser(app).post('/site-api/auth/login', {email: 'dan@example.test', password: PASSWORD})).status).toBe(200);

      // The first account is owner here (local mode): it resets another user's two-step sign-in.
      await withTwoFactor('eve@example.test');
      const owner = browser;
      expect((await owner.get('/site-api/auth/me')).json.roles).toContain('owner');
      const eve = await userId('eve@example.test');
      const reset = await owner.post(`/site-api/admin/users/${eve}/two-factor/disable`);
      expect(reset.status).toBe(200);
      expect(reset.json.user).toMatchObject({twoFactor: false});
      expect(await db.recoveryCode.count({where: {userId: eve}})).toBe(0);
    });
  });

  describe('a new email address', () => {
    it('moves the account only after the link to the new address, and tells the old one', async () => {
      const browser = await signedIn(app, 'old@example.test');
      expect((await browser.post('/site-api/auth/email', {email: 'new@example.test', password: 'wrong password here'})).status).toBe(422);
      const ask = await browser.post('/site-api/auth/email', {email: 'New@Example.test', password: PASSWORD});
      expect(ask.status).toBe(202);
      const mail = emails.find(e => e.kind === 'confirm_email_change')!;
      expect(mail).toMatchObject({to: 'new@example.test'});
      expect(mail.path).toMatch(/^\/account\/confirm-email\/\?token=/);
      // Nothing changed yet.
      expect((await db.user.findUniqueOrThrow({where: {email: 'old@example.test'}})).email).toBe('old@example.test');

      const token = tokenOf(mail.path);
      const done = await new Browser(app).post('/site-api/auth/email/confirm', {token});
      expect(done.status).toBe(200);
      expect(emails.find(e => e.kind === 'email_changed')).toMatchObject({to: 'old@example.test'});
      expect(await db.user.count({where: {email: 'new@example.test'}})).toBe(1);
      expect((await new Browser(app).post('/site-api/auth/email/confirm', {token})).status).toBe(400);
      // Every device signs in again.
      expect((await browser.get('/site-api/auth/me')).status).toBe(401);
      expect((await new Browser(app).post('/site-api/auth/login', {email: 'new@example.test', password: PASSWORD})).status).toBe(200);
    });

    it('an address that already has an account gets no link (same answer, no enumeration)', async () => {
      await signedIn(app, 'taken@example.test');
      const browser = await signedIn(app, 'me@example.test');
      const ask = await browser.post('/site-api/auth/email', {email: 'taken@example.test', password: PASSWORD});
      expect(ask.status).toBe(202);
      expect(emails.some(e => e.kind === 'confirm_email_change')).toBe(false);
    });
  });

  describe('signed-in devices', () => {
    it('lists devices, marks this one, signs one out', async () => {
      const laptop = await signedIn(app, 'fay@example.test');
      const phone = new Browser(app, '203.0.113.77');
      expect((await phone.post('/site-api/auth/login', {email: 'fay@example.test', password: PASSWORD})).status).toBe(200);
      const list = await laptop.get('/site-api/auth/sessions');
      const sessions = list.json.sessions as {id: string; current: boolean}[];
      expect(sessions).toHaveLength(2);
      expect(sessions.filter(s => s.current)).toHaveLength(1);
      const other = sessions.find(s => !s.current)!;
      expect((await laptop.delete(`/site-api/auth/sessions/${other.id}`)).status).toBe(200);
      expect((await phone.get('/site-api/auth/me')).status).toBe(401);
      expect((await laptop.get('/site-api/auth/me')).status).toBe(200);
      expect((await laptop.delete(`/site-api/auth/sessions/${other.id}`)).status).toBe(404);
    });
  });

  describe('deleting an account', () => {
    it('needs the password and DELETE; the last owner cannot', async () => {
      const owner = await signedIn(app, 'gus@example.test'); // first account: owner (local mode)
      const member = await signedIn(app, 'hal@example.test');
      expect((await member.post('/site-api/auth/delete-account', {password: PASSWORD, confirm: 'nope'})).status).toBe(422);
      expect((await member.post('/site-api/auth/delete-account', {password: 'bad password value', confirm: 'DELETE'})).status).toBe(422);
      expect((await member.post('/site-api/auth/delete-account', {password: PASSWORD, confirm: 'DELETE'})).status).toBe(200);
      expect(await db.user.count({where: {email: 'hal@example.test'}})).toBe(0);

      const last = await owner.post('/site-api/auth/delete-account', {password: PASSWORD, confirm: 'DELETE'});
      expect(last.status).toBe(409);
      expect(last.json.error).toBe('last_owner');
    });
  });
});
