import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {passwordProblem} from '../../src/platform/auth/password';
import {rateLimitIp} from '../../src/platform/auth/kit';
import {app} from '../../src/server/app';
import {
  Browser,
  codeFrom,
  configureEnv,
  DATABASE_URL,
  db,
  emails,
  ORIGIN,
  OWNER_ID,
  NEXT_OWNER_ID,
  ownerSignedIn,
  mailGateOpen,
  platformOwner,
  resetDatabase,
  signedIn,
  signUpCodeFrom,
  signUpTokenFrom,
  tokenFrom,
  unconfirmedAccount,
} from './support/harness';

/** Each way into someone's account that was once open, kept shut. */
const PW = 'a long test passphrase';
const login = (email: string, password: string, ip: string) => new Browser(app, ip).post('/site-api/auth/login', {email, password});

describe.skipIf(!DATABASE_URL)('account security (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  describe('nobody gets an address before its owner', () => {
    it("a stranger's sign-up makes no account, and the real person's code sign-in finds nothing to inherit", async () => {
      const stranger = new Browser(app, '198.51.100.1');
      expect((await stranger.post('/site-api/auth/register', {email: 'ana@example.test', password: 'stranger password 1', name: 'S'})).status).toBe(202);
      expect(await db.user.count()).toBe(0);
      expect((await login('ana@example.test', 'stranger password 1', '198.51.100.2')).status).toBe(401);
      // Ana never asked: the mail reaches her, and the code only works in the stranger's browser.
      const code = signUpCodeFrom('ana@example.test');
      const ana = new Browser(app, '198.51.100.3');
      expect((await ana.post('/site-api/auth/register/verify', {email: 'ana@example.test', code})).status).toBe(401);
      expect((await ana.post('/site-api/auth/register/verify', {token: signUpTokenFrom('ana@example.test')})).status).toBe(400);
      expect((await login('ana@example.test', 'stranger password 1', '198.51.100.4')).status).toBe(401);
    });

    it('code sign-in on an old unconfirmed account drops the password, sessions and two-step', async () => {
      const {user} = await unconfirmedAccount('old@example.test', 'stranger password 1');
      await db.user.update({where: {id: user.id}, data: {totpEnabledAt: new Date(), sessionVersion: 3}});
      await db.recoveryCode.create({data: {userId: user.id, codeHash: 'x'.repeat(64)}});
      const ana = new Browser(app, '198.51.100.5');
      await ana.post('/site-api/auth/code', {email: 'old@example.test'});
      const verified = await ana.post('/site-api/auth/code/verify', {email: 'old@example.test', code: codeFrom('old@example.test')});
      expect(verified.status).toBe(200);
      expect((await ana.get('/site-api/auth/me')).status).toBe(200);
      const row = await db.user.findUniqueOrThrow({where: {id: user.id}});
      expect(row.passwordHash).toBe('!');
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(row.totpEnabledAt).toBeNull();
      expect(row.sessionVersion).toBe(4);
      expect(await db.recoveryCode.count({where: {userId: user.id}})).toBe(0);
      expect((await login('old@example.test', 'stranger password 1', '198.51.100.6')).status).toBe(401);
    });

    it('an old confirmation link does the same, then the inbox chooses a password', async () => {
      const {user} = await unconfirmedAccount('link@example.test', 'stranger password 1');
      const clicked = await new Browser(app, '198.51.100.7').post('/site-api/auth/verify-email', {token: user.token});
      expect(clicked.status).toBe(200);
      expect(clicked.json.setPassword).toBe(true);
      expect((await login('link@example.test', 'stranger password 1', '198.51.100.8')).status).toBe(401);
      const reset = await new Browser(app, '198.51.100.9').post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'link@example.test'), password: 'my own new passphrase'});
      expect(reset.status).toBe(200);
      expect((await login('link@example.test', 'my own new passphrase', '198.51.100.10')).status).toBe(200);
    });

    it("on an old account, a stranger's login can't take the email the real person's code needs", async () => {
      await unconfirmedAccount('old2@example.test', 'stranger password 1');
      expect((await login('old2@example.test', 'stranger password 1', '198.51.100.110')).status).toBe(403);
      const ana = new Browser(app, '198.51.100.111');
      await ana.post('/site-api/auth/code', {email: 'old2@example.test'});
      expect((await ana.post('/site-api/auth/code/verify', {email: 'old2@example.test', code: codeFrom('old2@example.test')})).status).toBe(200);
      expect((await login('old2@example.test', 'stranger password 1', '198.51.100.112')).status).toBe(401);
    });

    it('someone who knows an old account\'s password and reads its inbox keeps it', async () => {
      await unconfirmedAccount('mine@example.test', PW);
      const me = new Browser(app, '198.51.100.11');
      const first = await me.post('/site-api/auth/login', {email: 'mine@example.test', password: PW});
      expect(first.status).toBe(403);
      expect(first.json.needsCode).toBe(true);
      const done = await me.post('/site-api/auth/register/verify', {email: 'mine@example.test', code: signUpCodeFrom('mine@example.test')});
      expect(done.status).toBe(201);
      expect((await login('mine@example.test', PW, '198.51.100.12')).status).toBe(200);
    });

    it("3 sign-ups by a stranger don't stop the real person: the email they caused works in the person's own browser", async () => {
      for (let i = 0; i < 3; i++) await new Browser(app, `203.0.113.${10 + i}`).post('/site-api/auth/register', {email: 'real@example.test', password: 'stranger password 1', name: 'S'});
      expect(emails.filter(mail => mail.kind === 'sign_up_code')).toHaveLength(1);
      const person = new Browser(app, '198.51.100.14');
      expect((await person.post('/site-api/auth/register', {email: 'real@example.test', password: PW, name: 'Real'})).status).toBe(202);
      const done = await person.post('/site-api/auth/register/verify', {email: 'real@example.test', code: signUpCodeFrom('real@example.test')});
      expect(done.status).toBe(201);
      expect(done.json.user).toMatchObject({name: 'Real'});
      expect((await login('real@example.test', 'stranger password 1', '198.51.100.15')).status).toBe(401);
      expect((await login('real@example.test', PW, '198.51.100.16')).status).toBe(200);
    });

    it('guessing the 6-digit code has a total per address, and the link still works when strangers use it up', async () => {
      const person = new Browser(app, '198.51.100.17');
      await person.post('/site-api/auth/register', {email: 'burn@example.test', password: PW, name: 'B'});
      const code = signUpCodeFrom('burn@example.test');
      const wrong = code === '000000' ? '000001' : '000000';
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const stranger = new Browser(app, `203.0.113.${20 + i}`);
        await stranger.post('/site-api/auth/register', {email: 'burn@example.test', password: 'stranger password 1', name: 'S'});
        statuses.push((await stranger.post('/site-api/auth/register/verify', {email: 'burn@example.test', code: wrong})).status);
      }
      expect(statuses.slice(0, 10).every(status => status === 401)).toBe(true);
      expect(statuses.slice(10).every(status => status === 429)).toBe(true);
      // Used up, for anyone typing the code. The message says what to do, and the link goes through.
      const refused = await person.post('/site-api/auth/register/verify', {email: 'burn@example.test', code});
      expect(refused.status).toBe(429);
      expect(refused.json.message).toMatch(/link/);
      expect((await person.post('/site-api/auth/register/verify', {token: signUpTokenFrom('burn@example.test')})).status).toBe(201);
    }, 60_000);

    it("a link can't be guessed, works once, and is only good in a browser that signed up", async () => {
      const person = new Browser(app, '198.51.100.18');
      await person.post('/site-api/auth/register', {email: 'link2@example.test', password: PW, name: 'L'});
      const token = signUpTokenFrom('link2@example.test');
      expect((await person.post('/site-api/auth/register/verify', {token: 'A'.repeat(43)})).status).toBe(400);
      expect((await new Browser(app, '198.51.100.19').post('/site-api/auth/register/verify', {token})).status).toBe(400);
      expect((await person.post('/site-api/auth/register/verify', {token})).status).toBe(201);
      expect((await person.post('/site-api/auth/register/verify', {token})).status).toBe(400);
    });

    it('a code from another address, or one too old, is refused', async () => {
      const person = new Browser(app, '198.51.100.20');
      await person.post('/site-api/auth/register', {email: 'mine2@example.test', password: PW, name: 'M'});
      const other = new Browser(app, '198.51.100.21');
      await other.post('/site-api/auth/register', {email: 'other2@example.test', password: PW, name: 'O'});
      const token = signUpTokenFrom('other2@example.test');
      expect((await person.post('/site-api/auth/register/verify', {token})).status).toBe(400);
      const realNow = Date.now;
      Date.now = () => realNow() + 46 * 60 * 1000;
      try {
        expect((await person.post('/site-api/auth/register/verify', {email: 'mine2@example.test', code: signUpCodeFrom('mine2@example.test')})).status).toBe(401);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('a security event ends every way back in', () => {
    it('a password reset ends a waiting email change', async () => {
      const attacker = await signedIn(app, 'b@example.test', PW, '198.51.100.20');
      await attacker.post('/site-api/auth/email', {email: 'attacker@example.test', password: PW});
      const move = tokenFrom('confirm_email_change', 'attacker@example.test');
      await new Browser(app, '198.51.100.21').post('/site-api/auth/forgot-password', {email: 'b@example.test'});
      await new Browser(app, '198.51.100.21').post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'b@example.test'), password: 'the owner new password'});
      expect((await new Browser(app, '198.51.100.22').post('/site-api/auth/email/confirm', {token: move})).status).toBe(400);
      expect(await db.user.count({where: {email: 'attacker@example.test'}})).toBe(0);
    });

    it('an old reset link dies with a password change, and with an email change', async () => {
      const user = await signedIn(app, 'c@example.test', PW, '198.51.100.23');
      await new Browser(app, '198.51.100.24').post('/site-api/auth/forgot-password', {email: 'c@example.test'});
      const link = tokenFrom('password_reset', 'c@example.test');
      expect((await user.post('/site-api/auth/change-password', {currentPassword: PW, newPassword: 'changed password one'})).status).toBe(200);
      expect((await new Browser(app, '198.51.100.25').post('/site-api/auth/reset-password', {token: link, password: 'attacker chosen password'})).status).toBe(400);

      await new Browser(app, '198.51.100.26').post('/site-api/auth/forgot-password', {email: 'c@example.test'});
      const second = tokenFrom('password_reset', 'c@example.test');
      await user.post('/site-api/auth/email', {email: 'c2@example.test', password: 'changed password one'});
      await new Browser(app, '198.51.100.27').post('/site-api/auth/email/confirm', {token: tokenFrom('confirm_email_change', 'c2@example.test')});
      expect((await new Browser(app, '198.51.100.28').post('/site-api/auth/reset-password', {token: second, password: 'attacker chosen password'})).status).toBe(400);
    });

    it('sign out everywhere ends links and codes too', async () => {
      const user = await signedIn(app, 'd@example.test', PW, '198.51.100.29');
      await user.post('/site-api/auth/email', {email: 'd2@example.test', password: PW});
      const move = tokenFrom('confirm_email_change', 'd2@example.test');
      await user.post('/site-api/auth/logout-all');
      expect((await new Browser(app, '198.51.100.30').post('/site-api/auth/email/confirm', {token: move})).status).toBe(400);
    });

    it('one waiting email change at a time, and the old address hears and can cancel it', async () => {
      const user = await signedIn(app, 'e@example.test', PW, '198.51.100.31');
      emails.length = 0;
      await user.post('/site-api/auth/email', {email: 'e2@example.test', password: PW});
      const first = tokenFrom('confirm_email_change', 'e2@example.test');
      await user.post('/site-api/auth/email', {email: 'e3@example.test', password: PW});
      expect((await new Browser(app, '198.51.100.32').post('/site-api/auth/email/confirm', {token: first})).status).toBe(400);

      const notice = emails.filter(mail => mail.kind === 'email_change_requested' && mail.to === 'e@example.test').pop()!;
      const cancel = notice.path!.split('token=')[1]!;
      const live = tokenFrom('confirm_email_change', 'e3@example.test');
      expect((await new Browser(app, '198.51.100.33').post('/site-api/auth/email/cancel', {token: `${cancel.split('.')[0]}.${'0'.repeat(64)}`})).status).toBe(400);
      expect((await new Browser(app, '198.51.100.33').post('/site-api/auth/email/cancel', {token: cancel})).status).toBe(200);
      expect((await new Browser(app, '198.51.100.34').post('/site-api/auth/email/confirm', {token: live})).status).toBe(400);
    });
  });

  describe('a sign-in running while access ends', () => {
    it('no session made during a password reset, or an email change, outlives it', async () => {
      await signedIn(app, 'race@example.test', PW, '198.51.100.70');
      const live: Browser[] = [];
      const logins = Array.from({length: 8}, async (_, i) => {
        const browser = new Browser(app, `198.51.100.${71 + i}`);
        await new Promise(resolve => setTimeout(resolve, i * 20));
        const res = await browser.post('/site-api/auth/login', {email: 'race@example.test', password: PW});
        if (res.status === 200) live.push(browser);
      });
      await new Browser(app, '198.51.100.90').post('/site-api/auth/forgot-password', {email: 'race@example.test'});
      await new Promise(resolve => setTimeout(resolve, 30));
      const reset = await new Browser(app, '198.51.100.90').post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'race@example.test'), password: 'the owner new password'});
      expect(reset.status).toBe(200);
      await Promise.all(logins);
      for (const browser of live) {
        await browser.post('/site-api/auth/refresh');
        expect((await browser.get('/site-api/auth/me')).status).toBe(401);
      }
    }, 60_000);
  });

  describe('an email change says nothing about the address asked for', () => {
    it('the same notice goes out whether or not the address has an account', async () => {
      await signedIn(app, 'taken@example.test', PW, '198.51.100.91');
      const user = await signedIn(app, 'asker@example.test', PW, '198.51.100.92');
      emails.length = 0;
      await user.post('/site-api/auth/email', {email: 'taken@example.test', password: PW});
      expect(emails.map(mail => [mail.kind, mail.to])).toEqual([['email_change_requested', 'asker@example.test']]);
    });
  });

  describe("a stranger can't get in a person's way", () => {
    it('asking for another code keeps the one someone is typing', async () => {
      await signedIn(app, 'typing@example.test', PW, '198.51.100.94');
      const person = new Browser(app, '198.51.100.95');
      await person.post('/site-api/auth/code', {email: 'typing@example.test'});
      const mine = codeFrom('typing@example.test');
      await mailGateOpen();
      await new Browser(app, '203.0.113.80').post('/site-api/auth/code', {email: 'typing@example.test'});
      expect((await person.post('/site-api/auth/code/verify', {email: 'typing@example.test', code: mine})).status).toBe(200);
    });

    it('an old device cookie stops counting once sessions were ended', async () => {
      const me = await signedIn(app, 'dev@example.test', PW, '198.51.100.96');
      await new Browser(app, '198.51.100.97').post('/site-api/auth/forgot-password', {email: 'dev@example.test'});
      await new Browser(app, '198.51.100.97').post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'dev@example.test'), password: 'the owner new password'});
      for (let i = 0; i < 21; i++) await login('dev@example.test', 'wrong password guess', `203.0.113.${100 + i}`);
      expect((await me.post('/site-api/auth/login', {email: 'dev@example.test', password: 'the owner new password'})).status).toBe(429);
    }, 60_000);

    it('a closed site, or a suspended address, finishes no sign-up', async () => {
      const {user} = await unconfirmedAccount('sus2@example.test', PW);
      const me = new Browser(app, '198.51.100.98');
      await me.post('/site-api/auth/login', {email: 'sus2@example.test', password: PW});
      const code = signUpCodeFrom('sus2@example.test');
      await db.user.update({where: {id: user.id}, data: {status: 'suspended'}});
      expect((await me.post('/site-api/auth/register/verify', {email: 'sus2@example.test', code})).status).toBe(403);
      expect((await db.user.findUniqueOrThrow({where: {id: user.id}})).emailVerifiedAt).toBeNull();
    });
  });

  describe('an email change stands once confirmed', () => {
    const move = async (email: string, to: string) => {
      const user = await signedIn(app, email, PW, '198.51.100.99');
      emails.length = 0;
      await user.post('/site-api/auth/email', {email: to, password: PW});
      const notice = emails.find(mail => mail.kind === 'email_change_requested')!;
      const cancel = notice.path!.split('token=')[1]!;
      const confirmed = await new Browser(app, '198.51.100.100').post('/site-api/auth/email/confirm', {token: tokenFrom('confirm_email_change', to)});
      return {user, cancel, confirmed};
    };

    it('the old address gets a plain notice, and its cancel link stops working', async () => {
      const {cancel, confirmed} = await move('u1@example.test', 'new1@example.test');
      expect(confirmed.status).toBe(200);
      const plain = emails.find(mail => mail.kind === 'email_changed')!;
      expect(plain.to).toBe('u1@example.test');
      expect(plain.path).toBeUndefined();
      expect((await new Browser(app, '198.51.100.101').post('/site-api/auth/email/cancel', {token: cancel})).status).toBe(400);
      expect(await db.user.count({where: {email: 'new1@example.test'}})).toBe(1);
    });

    it('it needs the password and the new inbox, and ends sessions, links and codes', async () => {
      const user = await signedIn(app, 'u2@example.test', PW, '198.51.100.102');
      expect((await user.post('/site-api/auth/email', {email: 'new2@example.test', password: 'not the password'})).status).toBe(422);
      expect(await db.emailChange.count()).toBe(0);
      await new Browser(app, '198.51.100.103').post('/site-api/auth/forgot-password', {email: 'u2@example.test'});
      const link = tokenFrom('password_reset', 'u2@example.test');
      await user.post('/site-api/auth/email', {email: 'new2@example.test', password: PW});
      expect((await user.get('/site-api/auth/me')).status).toBe(200);
      await new Browser(app, '198.51.100.104').post('/site-api/auth/email/confirm', {token: tokenFrom('confirm_email_change', 'new2@example.test')});
      expect((await user.get('/site-api/auth/me')).status).toBe(401);
      expect((await new Browser(app, '198.51.100.105').post('/site-api/auth/reset-password', {token: link, password: 'attacker chosen password'})).status).toBe(400);
    });

    it('the recipe in auth.md for an admin changing an email works with what the platform exports', async () => {
      const {endAccess, sendSiteEmail, normalizeEmail, emailAccepted} = await import('../../src/platform/auth');
      const user = await signedIn(app, 'adm1@example.test', PW, '198.51.100.140');
      const stranger = new Browser(app, '198.51.100.141');
      await stranger.post('/site-api/auth/register', {email: 'adm2@example.test', password: 'stranger password 1', name: 'S'});
      await new Browser(app, '198.51.100.142').post('/site-api/auth/forgot-password', {email: 'adm1@example.test'});
      const link = tokenFrom('password_reset', 'adm1@example.test');
      const to = normalizeEmail('ADM2@example.test')!;
      expect(await emailAccepted(ORIGIN, to)).toBe(true);
      const {id} = await db.user.findUniqueOrThrow({where: {email: 'adm1@example.test'}, select: {id: true}});
      await endAccess(db, id, 'admin', {set: {email: to, emailVerifiedAt: new Date()}});
      await db.pendingSignUp.updateMany({where: {email: to, usedAt: null}, data: {usedAt: new Date()}});
      expect(await sendSiteEmail(ORIGIN, {kind: 'email_changed', to})).toBe(true);
      expect((await user.get('/site-api/auth/me')).status).toBe(401);
      expect((await new Browser(app, '198.51.100.143').post('/site-api/auth/reset-password', {token: link, password: 'attacker chosen password'})).status).toBe(400);
      expect((await login(to, PW, '198.51.100.144')).status).toBe(200);
      expect((await stranger.post('/site-api/auth/register/verify', {email: to, code: signUpCodeFrom(to)})).status).toBe(401);
    });

    it('a person can move again straight away', async () => {
      await move('u3@example.test', 'new3@example.test');
      const again = new Browser(app, '198.51.100.106');
      await again.post('/site-api/auth/login', {email: 'new3@example.test', password: PW});
      expect((await again.post('/site-api/auth/email', {email: 'new4@example.test', password: PW})).status).toBe(202);
    });
  });

  describe('rate limits', () => {
    it("logging in to your own account between guesses doesn't reset the per-IP limit", async () => {
      await signedIn(app, 'own@example.test', PW, '198.51.100.40');
      const ip = '198.51.100.41';
      let answered = 0;
      let limited = 0;
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 30; i++) {
          const res = await login(`target${round}-${i}@example.test`, 'wrong password guess', ip);
          if (res.status === 429) limited++;
          else answered++;
        }
        for (let i = 0; i < 15; i++) await login('own@example.test', PW, ip);
      }
      expect(answered).toBe(50);
      expect(limited).toBe(10);
    }, 120_000);

    it('a whole IPv6 /56 counts as one address', async () => {
      expect(rateLimitIp('2001:db8:1:2::1')).toBe(rateLimitIp('2001:DB8:1:2:ffff::9'));
      expect(rateLimitIp('2001:0db8:0001:0002:0:0:0:1')).toBe(rateLimitIp('2001:db8:1:2::2'));
      expect(rateLimitIp('2001:db8:1:ff::1')).toBe(rateLimitIp('2001:db8:1:2::1'));
      expect(rateLimitIp('2001:db8:1:100::1')).not.toBe(rateLimitIp('2001:db8:1:2::1'));
      expect(rateLimitIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
      expect(rateLimitIp('192.0.2.1')).toBe('192.0.2.1');
      const many: number[] = [];
      for (let i = 0; i < 7; i++) many.push((await new Browser(app, `2001:db8:1:${i + 1}::1`).post('/site-api/auth/register', {email: `many${i}@example.test`, password: PW, name: 'x'})).status);
      expect(many).toEqual([202, 202, 202, 202, 202, 429, 429]);
    }, 60_000);

    it("strangers can't lock a person out of a browser they've signed in on", async () => {
      const me = await signedIn(app, 'f@example.test', PW, '198.51.100.42');
      await me.post('/site-api/auth/logout');
      for (let i = 0; i < 21; i++) await login('f@example.test', 'wrong password guess', `203.0.113.${100 + i}`);
      // A browser that hasn't signed in here waits; this one doesn't.
      expect((await login('f@example.test', PW, '198.51.100.43')).status).toBe(429);
      expect((await me.post('/site-api/auth/login', {email: 'f@example.test', password: PW})).status).toBe(200);
    }, 60_000);

    it("strangers asking for resets and codes can't stop a person: one email per 15 minutes, and it works", async () => {
      await signedIn(app, 'g@example.test', PW, '198.51.100.44');
      emails.length = 0;
      await new Browser(app, '203.0.113.140').post('/site-api/auth/forgot-password', {email: 'g@example.test'});
      for (let i = 0; i < 5; i++) await new Browser(app, `203.0.113.${141 + i}`).post('/site-api/auth/forgot-password', {email: 'g@example.test'});
      for (let i = 0; i < 5; i++) await new Browser(app, `203.0.113.${150 + i}`).post('/site-api/auth/code', {email: 'g@example.test'});
      expect(emails).toHaveLength(1);
      // The person asks, gets nothing new, and the link already in the inbox works.
      const person = new Browser(app, '198.51.100.45');
      expect((await person.post('/site-api/auth/forgot-password', {email: 'g@example.test'})).status).toBe(202);
      expect(emails).toHaveLength(1);
      const reset = await person.post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'g@example.test'), password: 'a fresh long password'});
      expect(reset.status).toBe(200);
    });

    it("a stranger asking for codes every window can't leave a person without a reset link", async () => {
      await signedIn(app, 'g3@example.test', PW, '198.51.100.117');
      for (let window = 0; window < 4; window++) {
        emails.length = 0;
        await new Browser(app, `203.0.113.${200 + window}`).post('/site-api/auth/code', {email: 'g3@example.test'});
        expect(emails).toHaveLength(1);
        const person = new Browser(app, `198.51.100.${118 + window}`);
        await person.post('/site-api/auth/forgot-password', {email: 'g3@example.test'});
        expect(emails).toHaveLength(1);
        const path = emails[0]!.path!;
        expect(emails[0]!.kind).toBe('sign_in_code');
        expect(path).toMatch(/^\/account\/reset\/\?token=/);
        if (window === 3) {
          // With wrong passwords and codes used up too, the link in that email still works.
          for (let i = 0; i < 21; i++) await login('g3@example.test', 'wrong password guess', `203.0.113.${i + 1}`);
          for (let i = 0; i < 11; i++) await new Browser(app, `10.8.${i}.1`).post('/site-api/auth/code/verify', {email: 'g3@example.test', code: '000000'});
          const token = new URL(path, 'https://x.test').searchParams.get('token');
          expect((await person.post('/site-api/auth/reset-password', {token, password: 'a fresh long password'})).status).toBe(200);
          expect((await person.post('/site-api/auth/login', {email: 'g3@example.test', password: 'a fresh long password'})).status).toBe(200);
        }
        await mailGateOpen();
      }
    }, 120_000);

    it("on an old account, a stranger's login can't take the reset link either", async () => {
      await unconfirmedAccount('old3@example.test', 'stranger password 1');
      await login('old3@example.test', 'stranger password 1', '198.51.100.123');
      emails.length = 0;
      await new Browser(app, '198.51.100.124').post('/site-api/auth/forgot-password', {email: 'old3@example.test'});
      expect(emails.map(mail => mail.kind)).toEqual(['password_reset']);
    });

    it('the browser that just reset a password stays in, whatever strangers go on guessing', async () => {
      await signedIn(app, 'r1@example.test', PW, '198.51.100.130');
      const person = new Browser(app, '198.51.100.131');
      await person.post('/site-api/auth/forgot-password', {email: 'r1@example.test'});
      await person.post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'r1@example.test'), password: 'brand new password 88'});
      for (let i = 0; i < 21; i++) await login('r1@example.test', 'wrong password guess', `203.0.113.${100 + i}`);
      expect((await login('r1@example.test', 'brand new password 88', '198.51.100.132')).status).toBe(429);
      expect((await person.post('/site-api/auth/login', {email: 'r1@example.test', password: 'brand new password 88'})).status).toBe(200);
    }, 60_000);

    it("a browser with two sign-ups waiting can finish the older one by its link", async () => {
      const person = new Browser(app, '198.51.100.133');
      await person.post('/site-api/auth/register', {email: 'first3@example.test', password: PW, name: 'F'});
      const older = signUpTokenFrom('first3@example.test');
      await person.post('/site-api/auth/register', {email: 'second3@example.test', password: PW, name: 'S'});
      const done = await person.post('/site-api/auth/register/verify', {token: older});
      expect(done.status).toBe(201);
      expect(done.json.user).toMatchObject({email: 'first3@example.test'});
    });

    it("once an old account is claimed, a stranger's waiting sign-up for it is over", async () => {
      await unconfirmedAccount('old4@example.test', 'stranger password 1');
      const stranger = new Browser(app, '198.51.100.134');
      await stranger.post('/site-api/auth/login', {email: 'old4@example.test', password: 'stranger password 1'});
      const ana = new Browser(app, '198.51.100.135');
      await ana.post('/site-api/auth/code', {email: 'old4@example.test'});
      await ana.post('/site-api/auth/code/verify', {email: 'old4@example.test', code: codeFrom('old4@example.test')});
      expect(await db.pendingSignUp.count({where: {email: 'old4@example.test', usedAt: null}})).toBe(0);
    });

    it("the next email can go after the gap, and earlier links and codes stay good", async () => {
      await signedIn(app, 'g2@example.test', PW, '198.51.100.46');
      await new Browser(app, '203.0.113.160').post('/site-api/auth/forgot-password', {email: 'g2@example.test'});
      const first = tokenFrom('password_reset', 'g2@example.test');
      await mailGateOpen();
      await new Browser(app, '203.0.113.161').post('/site-api/auth/forgot-password', {email: 'g2@example.test'});
      expect((await new Browser(app, '198.51.100.47').post('/site-api/auth/reset-password', {token: first, password: 'a fresh long password'})).status).toBe(200);
    });

    it('21 wrong logins name a way in, and a reset clears them for every browser', async () => {
      await signedIn(app, 'f2@example.test', PW, '198.51.100.48');
      for (let i = 0; i < 21; i++) await login('f2@example.test', 'wrong password guess', `203.0.113.${170 + i}`);
      const refused = await login('f2@example.test', PW, '198.51.100.49');
      expect(refused.status).toBe(429);
      expect(refused.json.message).toMatch(/Forgot password/);
      const person = new Browser(app, '198.51.100.50');
      await person.post('/site-api/auth/forgot-password', {email: 'f2@example.test'});
      await person.post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', 'f2@example.test'), password: 'brand new password 77'});
      expect((await person.post('/site-api/auth/login', {email: 'f2@example.test', password: 'brand new password 77'})).status).toBe(200);
      expect((await login('f2@example.test', 'brand new password 77', '198.51.100.51')).status).toBe(200);
    }, 60_000);

    it("strangers' wrong sign-in codes use up neither a trusted browser's budget nor a code", async () => {
      const me = await signedIn(app, 'f3@example.test', PW, '198.51.100.52');
      await me.post('/site-api/auth/logout');
      await me.post('/site-api/auth/code', {email: 'f3@example.test'});
      const mine = codeFrom('f3@example.test');
      const wrong = mine === '000000' ? '000001' : '000000';
      const statuses: number[] = [];
      for (let i = 0; i < 55; i++) statuses.push((await new Browser(app, `10.9.${i}.1`).post('/site-api/auth/code/verify', {email: 'f3@example.test', code: wrong})).status);
      // A total holds for strangers, however many places they guess from.
      expect(statuses.filter(status => status === 401)).toHaveLength(10);
      expect((await me.post('/site-api/auth/code/verify', {email: 'f3@example.test', code: mine})).status).toBe(200);
    }, 120_000);

    it('a cookie for one address says nothing about another', async () => {
      const me = await signedIn(app, 'h@example.test', PW, '198.51.100.46');
      await signedIn(app, 'i@example.test', PW, '198.51.100.47');
      await me.post('/site-api/auth/logout');
      for (let i = 0; i < 21; i++) await login('i@example.test', 'wrong password guess', `203.0.113.${170 + i}`);
      expect((await me.post('/site-api/auth/login', {email: 'i@example.test', password: PW})).status).toBe(429);
    }, 60_000);
  });

  describe('notices and records', () => {
    it('turning two-step off, and an admin doing it, tells the person', async () => {
      const user = await signedIn(app, 'j@example.test', PW, '198.51.100.50');
      await user.post('/site-api/auth/two-factor/setup', {password: PW});
      emails.length = 0;
      expect((await user.post('/site-api/auth/two-factor/disable', {password: PW})).status).toBe(200);
      expect(emails.map(mail => [mail.kind, mail.to])).toEqual([['two_factor_off', 'j@example.test']]);
    });

    it('password sign-ins are recorded, and failures only when they name an account', async () => {
      await signedIn(app, 'k@example.test', PW, '198.51.100.51');
      await login('k@example.test', 'wrong password guess', '198.51.100.52');
      await login('nobody@example.test', 'wrong password guess', '198.51.100.52');
      await login('k@example.test', PW, '198.51.100.53');
      const rows = await db.auditEvent.findMany({where: {action: {in: ['sign_in_failed', 'signed_in_with_password']}}, select: {action: true}});
      expect(rows.map(row => row.action).sort()).toEqual(['sign_in_failed', 'signed_in_with_password']);
    });
  });

  describe('a site changing hands', () => {
    it('ends the former owner\'s admin at their next refresh', async () => {
      const owner = await ownerSignedIn(app);
      platformOwner.current = OWNER_ID;
      expect((await owner.post('/site-api/auth/refresh')).status).toBe(200);
      platformOwner.current = NEXT_OWNER_ID;
      expect((await owner.post('/site-api/auth/refresh')).status).toBe(401);
      expect((await owner.get('/site-api/admin/users')).status).toBe(401);
    });

    it("touches only the former owner, even if the new owner already clicked in", async () => {
      const former = await ownerSignedIn(app);
      const next = await ownerSignedIn(app, NEXT_OWNER_ID);
      platformOwner.current = NEXT_OWNER_ID;
      expect((await former.post('/site-api/auth/refresh')).status).toBe(401);
      expect((await next.get('/site-api/admin/users')).status).toBe(200);
      expect((await next.post('/site-api/auth/refresh')).status).toBe(200);
    });

    it('an account with no active owner ends the session too', async () => {
      const owner = await ownerSignedIn(app);
      platformOwner.current = undefined;
      expect((await owner.post('/site-api/auth/refresh')).status).toBe(401);
    });

    it("keeps working when the platform can't answer", async () => {
      const owner = await ownerSignedIn(app);
      platformOwner.current = null;
      expect((await owner.post('/site-api/auth/refresh')).status).toBe(200);
    });
  });

  describe('passwords', () => {
    it('refuses common words with only numbers or symbols around them', () => {
      for (const weak of ['password12345', '!!welcome2024', 'qwerty123456', 'letmein2024!', '123admin1234', 'P@ssw0rd12345', 'adminadmin12', 'aaaaaaaaaaaa', 'abababababab']) {
        expect(passwordProblem(weak), weak).toMatch(/too common/);
      }
      expect(passwordProblem('a long test passphrase')).toBeNull();
      expect(passwordProblem('correct-horse-battery')).toBeNull();
    });
  });
});
