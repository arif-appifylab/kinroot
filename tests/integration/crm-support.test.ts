import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {resetCrm} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db, signedIn} from './support/harness';

/**
 * Kinroot's support portal on the site's own sign-in (src/server/crm/routes/support-public.ts): a
 * customer sees and answers only the requests sent from their confirmed address; a guest can still
 * send one, and sees nothing.
 */

const request = (subject: string) => ({subject, description: 'It does not work', startedAt: Date.now() - 10_000});

describe.skipIf(!DATABASE_URL)('Kinroot support portal (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);

  it('shows a signed-in customer their own requests and nobody else’s', async () => {
    const ann = await signedIn(app, 'ann@example.com');
    const ben = await signedIn(app, 'ben@example.com');

    const mine = await ann.post('/site-api/crm/public/support/tickets', request('Login broken'));
    expect(mine.status).toBe(201);
    expect(mine.json.signedIn).toBe(true);
    const theirs = await ben.post('/site-api/crm/public/support/tickets', request('Billing'));
    expect(theirs.status).toBe(201);

    const list = await ann.get('/site-api/crm/public/support/me');
    expect((list.json.tickets as {subject: string}[]).map(t => t.subject)).toEqual(['Login broken']);
    expect((await ann.get(`/site-api/crm/public/support/tickets/${mine.json.number}`)).json.ticket).toMatchObject({subject: 'Login broken'});

    // Ben's request: not shown, and a reply to it is refused as if it did not exist.
    expect((await ann.get(`/site-api/crm/public/support/tickets/${theirs.json.number}`)).json.ticket).toBeNull();
    expect((await ann.post(`/site-api/crm/public/support/tickets/${theirs.json.number}/reply`, {body: 'Hi'})).status).toBe(404);
    expect((await ann.post(`/site-api/crm/public/support/tickets/${mine.json.number}/reply`, {body: 'Any news?'})).status).toBe(200);
  });

  it('lets a guest send a request by email, and shows them nothing', async () => {
    const guest = new Browser(app);
    const sent = await guest.post('/site-api/crm/public/support/tickets', {...request('Question'), email: 'cat@example.com'});
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({signedIn: false});
    expect(sent.json.number).toBeUndefined();

    expect((await guest.get('/site-api/crm/public/support/me')).json).toEqual({session: null});
    const ticket = await db.ticket.findFirstOrThrow({select: {number: true}});
    expect((await guest.get(`/site-api/crm/public/support/tickets/${ticket.number}`)).json.ticket).toBeNull();
    expect((await guest.post(`/site-api/crm/public/support/tickets/${ticket.number}/reply`, {body: 'Hi'})).status).toBe(403);
  });

  it('refuses a burst of requests from one connection (each one emails the address typed in)', async () => {
    const guest = new Browser(app, '198.51.100.7');
    for (let i = 0; i < 5; i++) {
      expect((await guest.post('/site-api/crm/public/support/tickets', {...request(`Burst ${i}`), email: `x${i}@example.com`})).status).toBe(201);
    }
    expect((await guest.post('/site-api/crm/public/support/tickets', {...request('One more'), email: 'y@example.com'})).status).toBe(429);
    // Another connection is not affected.
    expect((await new Browser(app, '198.51.100.8').post('/site-api/crm/public/support/tickets', {...request('Other'), email: 'z@example.com'})).status).toBe(201);
  });
});
