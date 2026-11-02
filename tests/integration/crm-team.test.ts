import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {owner, resetCrm, setRoles, teammate} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db, signedIn, userId} from './support/harness';

/**
 * Kinroot's team on top of the site's accounts (src/server/crm/kit/guards.ts): who gets into the
 * CRM, the Owner's first visit, invites bound to the signed-in account, and the email rule
 * (an address is seen only by its own person and the site's owner).
 */

describe.skipIf(!DATABASE_URL)('Kinroot team (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);

  it('answers signed-out visitors 401 and signed-in non-members 403, never data', async () => {
    const guest = new Browser(app);
    expect((await guest.get('/site-api/crm/contacts')).status).toBe(401);

    await owner();
    const stranger = await signedIn(app, 'stranger@example.com');
    await setRoles('stranger@example.com', 'member');
    const res = await stranger.get('/site-api/crm/contacts');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('not_a_member');
    // Signing up is open: an account alone never becomes a team member.
    expect(await db.member.count({where: {userId: await userId('stranger@example.com')}})).toBe(0);
  });

  it('asks the browser to refresh an expired session instead of answering signed out', async () => {
    const browser = await owner();
    // The 10-minute access cookie is gone, the refresh cookie is still there: a "returning" visitor.
    browser.jar.delete('__Host-site_at');
    const state = await browser.get('/site-api/crm/auth/state');
    expect(state.status).toBe(401);
    expect(state.json.error).toBe('token_expired');
    expect((await browser.post('/site-api/auth/refresh')).status).toBe(200);
    expect((await browser.get('/site-api/crm/auth/state')).json.signedIn).toBe(true);
  });

  it("makes the site's owner the CRM Owner on the first visit, asks for setup once", async () => {
    const browser = await owner();
    const state = await browser.get('/site-api/crm/auth/state');
    expect(state.status).toBe(200);
    expect(state.json.needsSetup).toBe(true);
    expect((state.json.user as {role: string}).role).toBe('OWNER');

    const setup = await browser.post('/site-api/crm/auth/setup', {brandName: 'Acme', demoData: false});
    expect(setup.status).toBe(200);
    expect((await browser.post('/site-api/crm/auth/setup', {brandName: 'Again', demoData: false})).status).toBe(409);
    expect((await browser.get('/site-api/crm/auth/state')).json.needsSetup).toBe(false);
    // The default pipeline was made by setup; the CRM answers.
    expect((await browser.get('/site-api/crm/pipelines')).status).toBe(200);
  });

  it('lets only the invited, verified account join, once', async () => {
    const ownerBrowser = await owner();
    await ownerBrowser.get('/site-api/crm/auth/state');
    const invite = await ownerBrowser.post('/site-api/crm/team/invite', {name: 'Maya', email: 'maya@example.com', role: 'MEMBER'});
    const token = String(invite.json.inviteUrl).split('/invite/')[1]!;

    // The token is stored hashed: the database never holds the link.
    expect(await db.member.count({where: {inviteTokenHash: token}})).toBe(0);
    // Looking at the invite shows the address masked (the link may have been forwarded).
    const look = await new Browser(app).get(`/site-api/crm/auth/invite/${token}`);
    expect(look.json.email).toBe('m•••@example.com');

    // Another account cannot take it.
    const other = await signedIn(app, 'other@example.com');
    await setRoles('other@example.com', 'member');
    expect((await other.post(`/site-api/crm/auth/invite/${token}`)).status).toBe(403);

    const maya = await signedIn(app, 'maya@example.com');
    await setRoles('maya@example.com', 'member');
    expect((await maya.post(`/site-api/crm/auth/invite/${token}`)).status).toBe(200);
    expect((await maya.post(`/site-api/crm/auth/invite/${token}`)).status).toBe(404);
    expect((await maya.get('/site-api/crm/contacts')).status).toBe(200);
  });

  it("shows teammates' addresses only to their owner and the site's owner", async () => {
    const ownerBrowser = await owner();
    await ownerBrowser.get('/site-api/crm/auth/state');
    const {browser: maya} = await teammate(ownerBrowser, 'maya@example.com', 'ADMIN');
    await teammate(ownerBrowser, 'sam@example.com');

    const seenByMaya = (await maya.get('/site-api/crm/team')).json.users as {name: string; email: string}[];
    expect(seenByMaya.find(u => u.name === 'maya')!.email).toBe('maya@example.com');
    expect(seenByMaya.find(u => u.name === 'sam')!.email).toBe('s•••@example.com');
    expect(seenByMaya.find(u => u.name === 'owner')!.email).toBe('o•••@example.com');

    const seenByOwner = (await ownerBrowser.get('/site-api/crm/team')).json.users as {name: string; email: string}[];
    expect(seenByOwner.find(u => u.name === 'sam')!.email).toBe('sam@example.com');
  });

  it('keeps viewers read-only and deactivated members out', async () => {
    const ownerBrowser = await owner();
    await ownerBrowser.get('/site-api/crm/auth/state');
    const {browser: viewer} = await teammate(ownerBrowser, 'vic@example.com', 'VIEWER');
    expect((await viewer.get('/site-api/crm/contacts')).status).toBe(200);
    expect((await viewer.post('/site-api/crm/contacts', {firstName: 'Ada'})).status).toBe(403);

    const member = await db.member.findFirstOrThrow({where: {userId: await userId('vic@example.com')}});
    expect((await ownerBrowser.request('PATCH', `/site-api/crm/team/${member.id}`, {active: false})).status).toBe(200);
    expect((await viewer.get('/site-api/crm/contacts')).json.error).toBe('not_a_member');
  });
});
