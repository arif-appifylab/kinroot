import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../src/server/background'; // the job handlers: "Sync now" and "Scan now" run as jobs
import {encryptJson} from '../../src/server/crm/kit/crypto';
import {NOT_CONFIGURED} from '../../src/server/crm/calendar/errors';
import {owner, resetCrm, teammate, userId} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Routes without tests until now (AUDIT P3-11): calendar connections (list, settings, "Sync now"
 * queued as a job, someone else's connection is a 404), Settings → Website (admins, validation, the
 * cached public website follows a save), tags and search under owner-only visibility. Plus the
 * batch's other rows: "not yours" answers 404 (P2-7), "Scan now" as a job (P2-6), calendar errors in
 * words (P2-17), booking-link locations (P2-13) and strict page numbers (P2-18).
 */

const API = '/site-api/crm';
type Json = Record<string, any>;
type Res = {status: number; json: Json};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  return res.json as T;
};

let own: Browser;
let amy: Browser;
let ben: Browser;
let amyId: string;

const get = (b: Browser, path: string) => b.get(`${API}${path}`);
const post = (b: Browser, path: string, body: unknown = {}) => b.post(`${API}${path}`, body);
const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', `${API}${path}`, body);
const put = (b: Browser, path: string, body: unknown) => b.request('PUT', `${API}${path}`, body);
const del = (b: Browser, path: string) => b.delete(`${API}${path}`);

/** A connection whose token has expired: refreshing it needs the Google app, which these tests never configure. */
async function connection(memberId: string, email: string, syncMeetings = true) {
  const credentials = await encryptJson({accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: Date.now() - 60_000});
  return db.calendarConnection.create({data: {userId: memberId, provider: 'google', email, credentials, syncMeetings, calendars: [{id: 'primary', name: 'Work', primary: true, writable: true}]}});
}

describe.skipIf(!DATABASE_URL)('Kinroot calendar, website, duplicates and 404s (integration, real Postgres)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    own = await owner();
    await own.get(`${API}/auth/state`);
    ok(await post(own, '/auth/setup', {brandName: 'Acme', demoData: false}));
    ({browser: amy} = await teammate(own, 'amy@example.com'));
    ({browser: ben} = await teammate(own, 'ben@example.com'));
    amyId = (await db.member.findUniqueOrThrow({where: {userId: await userId('amy@example.com')}})).id;
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  describe('calendar connections', () => {
    let connId: string;
    beforeAll(async () => {
      connId = (await connection(amyId, 'amy.cal@example.com', false)).id;
    });

    it('lists only your own connections, never their tokens', async () => {
      const mine = ok(await get(amy, '/calendar'));
      expect(mine.connections.map((c: Json) => c.id)).toEqual([connId]);
      expect(JSON.stringify(mine)).not.toContain('credentials');
      expect(ok(await get(ben, '/calendar')).connections).toEqual([]);
    });

    it('saves settings on your own connection; anyone else gets 404', async () => {
      const saved = ok(await patch(amy, `/calendar/connections/${connId}`, {busyCalendarIds: ['primary', 'not-mine']}));
      expect(saved.connection.busyCalendarIds).toEqual(['primary']);
      expect((await patch(ben, `/calendar/connections/${connId}`, {syncMeetings: true})).status).toBe(404);
      expect((await patch(own, `/calendar/connections/${connId}`, {syncMeetings: true})).status, 'admins too: a calendar is personal').toBe(404);
      expect((await post(ben, `/calendar/connections/${connId}/refresh`)).status).toBe(404);
      expect((await post(ben, `/calendar/connections/${connId}/sync`)).status).toBe(404);
      expect((await del(ben, `/calendar/connections/${connId}`)).status).toBe(404);
      expect(await db.calendarConnection.count({where: {id: connId}})).toBe(1);
    });

    it('"Sync now" queues the sync job and answers at once; its error is stored in words (P1-8, P2-17)', async () => {
      const r = ok(await post(amy, `/calendar/connections/${connId}/sync`));
      expect(r).toEqual({queued: true});
      // The job ran (locally, right after the answer), also with "log meetings" off: the expired token
      // can't be refreshed here, and the stored error is our sentence, not the provider's text.
      const row = await db.calendarConnection.findUniqueOrThrow({where: {id: connId}, select: {status: true, lastError: true}});
      expect(row).toEqual({status: 'ERROR', lastError: NOT_CONFIGURED});
      const listed = ok(await get(amy, '/calendar')).connections[0];
      expect(listed.lastError).toBe(NOT_CONFIGURED);
    });
  });

  describe('Settings → Website', () => {
    it('is for admins only', async () => {
      expect((await get(amy, '/website/settings')).status).toBe(403);
      expect((await put(amy, '/website/settings', {})).status).toBe(403);
    });

    it('checks what it saves, field by field', async () => {
      const {settings} = ok(await get(own, '/website/settings'));
      const empty = await put(own, '/website/settings', {...settings, headline: '  '});
      expect(empty.status).toBe(422);
      expect((empty.json as Json).fields.headline).toBe('Add a headline');
      const tooMany = await put(own, '/website/settings', {...settings, highlights: Array.from({length: 4}, () => ({title: 'x', text: ''}))});
      expect([tooMany.status, Object.keys(tooMany.json.fields ?? {})]).toEqual([422, ['highlights']]);
      const badForm = await put(own, '/website/settings', {...settings, contactFormId: 'no-such-form'});
      expect([badForm.status, (badForm.json as Json).fields?.contactFormId]).toEqual([400, 'Pick a published form for Contact us']);
    });

    it('shows a save on the public website at once (the cached copy is cleared)', async () => {
      const before = ok(await get(ben, '/public/website'));
      expect(typeof before.headline).toBe('string');
      const {settings} = ok(await get(own, '/website/settings'));
      ok(await put(own, '/website/settings', {...settings, headline: 'Grow with Acme', subheadline: 'Talk to us.'}));
      const after = ok(await get(ben, '/public/website'));
      expect([after.headline, after.subheadline]).toEqual(['Grow with Acme', 'Talk to us.']);
    });
  });

  describe('"Scan now" for duplicates (P2-6)', () => {
    it('queues the scan as a job for admins, one at a time', async () => {
      expect((await post(amy, '/duplicates/scan')).status, 'members cannot start a full scan').toBe(403);
      const r = await post(own, '/duplicates/scan');
      expect([r.status, r.json]).toEqual([202, {queued: true}]);
      // The job ran locally: the scan is recorded and "Scan now" is free again.
      const counts = ok(await get(own, '/duplicates/counts'));
      expect(counts.scanning).toBe(false);
      expect(typeof counts.lastScan.contact).toBe('string');
      expect(typeof counts.lastScan.company).toBe('string');

      // One still queued or running: a second click changes nothing.
      await db.setting.upsert({where: {key: 'duplicates.manualScan'}, create: {key: 'duplicates.manualScan', value: {contact: new Date().toISOString()}}, update: {value: {contact: new Date().toISOString()}}});
      const again = ok(await post(own, '/duplicates/scan'));
      expect(again).toMatchObject({queued: false, running: true});
      expect(ok(await get(own, '/duplicates/counts')).scanning).toBe(true);
      await db.setting.delete({where: {key: 'duplicates.manualScan'}});
    });
  });

  describe('"not yours" is a 404 (P2-7)', () => {
    it("another member's email account", async () => {
      const account = await db.emailAccount.create({data: {userId: amyId, provider: 'GMAIL', label: 'Amy', fromName: 'Amy', fromEmail: 'amy@example.com', credentials: await encryptJson({})}});
      expect((await patch(ben, `/email/accounts/${account.id}`, {label: 'Mine now'})).status).toBe(404);
      expect((await post(ben, `/email/accounts/${account.id}/sync`)).status).toBe(404);
      expect((await del(ben, `/email/accounts/${account.id}`)).status).toBe(404);
      expect((await del(own, `/email/accounts/${account.id}`)).status, "admins manage shared accounts, not a member's own").toBe(404);
      expect(await db.emailAccount.count({where: {id: account.id}})).toBe(1);
      await db.emailAccount.delete({where: {id: account.id}});
    });

    it("another member's private email template (a shared one says who may change it)", async () => {
      const priv = ok(await post(amy, '/email/templates', {name: 'Amy only', subject: 'Hi', body: 'Hello', layout: 'plain', shared: false}), 201).template;
      const shared = ok(await post(amy, '/email/templates', {name: 'For all', subject: 'Hi', body: 'Hello', layout: 'plain', shared: true}), 201).template;
      expect((await patch(ben, `/email/templates/${priv.id}`, {name: 'x'})).status).toBe(404);
      expect((await del(ben, `/email/templates/${priv.id}`)).status).toBe(404);
      expect((await patch(ben, `/email/templates/${shared.id}`, {name: 'x'})).status).toBe(403);
      expect((await patch(own, `/email/templates/${priv.id}`, {name: 'Renamed by an admin'})).status, 'admins keep their access').toBe(200);
      expect((await del(amy, `/email/templates/${priv.id}`)).status).toBe(200);
    });

    it("another member's booking link, and cancelling their booking", async () => {
      const link = ok(await post(amy, '/scheduling/links', {name: 'Amy intro'}), 201).link;
      expect((await get(ben, `/scheduling/links/${link.id}`)).status).toBe(404);
      expect((await patch(ben, `/scheduling/links/${link.id}`, {name: 'Taken'})).status).toBe(404);
      expect((await del(ben, `/scheduling/links/${link.id}`)).status).toBe(404);
      expect((await patch(own, `/scheduling/links/${link.id}`, {description: 'Checked by an admin'})).status, 'admins keep their access').toBe(200);

      const start = new Date(Date.now() + 3 * 86_400_000);
      const booking = await db.booking.create({data: {hostId: amyId, linkId: link.id, title: 'Intro', name: 'Guest', email: 'guest@example.com', startAt: start, endAt: new Date(start.getTime() + 30 * 60_000)}});
      expect((await post(ben, `/scheduling/bookings/${booking.id}/cancel`, {})).status).toBe(404);
      expect((await db.booking.findUniqueOrThrow({where: {id: booking.id}})).status).toBe('CONFIRMED');
    });
  });

  it('checks a booking link location written as a link (P2-13)', async () => {
    const link = ok(await post(amy, '/scheduling/links', {name: 'Amy call'}), 201).link;
    const bad = await patch(amy, `/scheduling/links/${link.id}`, {locationType: 'OTHER', location: 'javascript:alert(1)'});
    expect([bad.status, (bad.json as Json).fields?.location]).toEqual([422, 'links must start with http:// or https://']);
    expect(ok(await patch(amy, `/scheduling/links/${link.id}`, {locationType: 'VIDEO', location: 'https://zoom.example/j/1'})).link.location).toBe('https://zoom.example/j/1');
    expect(ok(await patch(amy, `/scheduling/links/${link.id}`, {locationType: 'IN_PERSON', location: 'Room 4, 2nd floor'})).link.location).toBe('Room 4, 2nd floor');
  });

  it('refuses loose or out-of-range page numbers in words, never a 500 (P2-18)', async () => {
    const paths = [
      '/audit?page=1.5',
      '/audit?page=1e3',
      '/audit?page=-1',
      '/audit?page=99999999',
      '/recycle-bin?page=1e3',
      '/tickets?page=1.5',
      '/tickets?pageSize=100000',
      '/inbox/conversations?page=0x10',
      '/automations/any/runs?page=-1',
      '/email/threads?take=1.5',
      '/broadcasts?take=1e3',
    ];
    for (const path of paths) {
      const r = await get(own, path);
      expect(r.status, path).toBe(422);
      expect(String(r.json.error), path).toMatch(/whole number|at least|at most/);
    }
    expect((await get(own, '/audit?page=2')).status).toBe(200);
    expect((await get(own, '/tickets?page=1000')).status).toBe(200);
  });

  describe('tags and search under owner-only visibility', () => {
    beforeAll(async () => {
      ok(await post(amy, '/contacts', {firstName: 'Zebulon', lastName: 'Quist', tags: ['amy-secret-tag']}), 201);
      ok(await post(ben, '/contacts', {firstName: 'Bo', tags: ['ben-tag']}), 201);
      ok(await patch(own, '/settings', {recordVisibility: 'owner'}));
    });
    afterAll(async () => {
      ok(await patch(own, '/settings', {recordVisibility: 'everyone'}));
    });

    it("never shows a record (or its tags) the member can't see", async () => {
      const found = ok(await get(ben, '/search?q=Zebulon'));
      expect(found.contacts).toEqual([]);
      expect(ok(await get(amy, '/search?q=Zebulon')).contacts.map((c: Json) => c.firstName)).toEqual(['Zebulon']);

      const benTags = ok(await get(ben, '/tags?entity=CONTACT')).rows.map((r: Json) => r.tag);
      expect(benTags).toContain('ben-tag');
      expect(benTags).not.toContain('amy-secret-tag');
      expect(ok(await get(own, '/tags')).rows.map((r: Json) => r.tag)).toEqual(expect.arrayContaining(['amy-secret-tag', 'ben-tag']));
    });
  });
});
