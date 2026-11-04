import {createHash, createHmac} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {cache} from '../../src/platform/cache';
import {app} from '../../src/server/app';
import {sign} from '../../src/server/crm/kit/crypto';
import {csv} from '../../src/server/crm/lib/csv';
import {ipKey, rateLimit} from '../../src/server/crm/lib/rate-limit';
import {csatToken} from '../../src/server/crm/lib/tickets';
import {manageToken} from '../../src/server/crm/scheduling/bookings';
import {crmDb, inScope, outside} from './ported/support';
import {fakeStorage, owner, ownerMemberId, resetCrm, teammate} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's public and team edges after the audit (AUDIT.md P1-5, P2-3, P2-6, P2-8 … P3-2): request
 * size limits, who may change whom on the team, form permissions, link expiry, the public booking
 * slots, the Data in API's unauthenticated requests, rate-limit bursts, CSV headers, the Microsoft
 * tenant, the tinted favicon, the logo in storage and the cached settings.
 */

const DAY = 86_400_000;

/** Refused by the input validator (lib/http.ts `valid`: 400, or 422 with the field's words). */
const invalid = (status: number) => expect([400, 422]).toContain(status);

async function memberId(email: string) {
  return (await db.member.findFirstOrThrow({where: {user: {email}}, select: {id: true}})).id;
}

describe.skipIf(!DATABASE_URL)('Kinroot public hardening (integration, real Postgres)', () => {
  let own: Browser;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    own = await owner();
    await own.get('/site-api/crm/auth/state');
    expect((await own.post('/site-api/crm/auth/setup', {brandName: 'Acme', demoData: false})).status).toBe(200);
  });

  it('takes a 300 KB email template and refuses 600 KB with the site’s words (P1-5)', async () => {
    // Two bytes a character: 150,000 characters are 300 KB on the wire (under the template's 200,000-character cap).
    const big = await own.post('/site-api/crm/email/templates', {name: 'Big', subject: 'Hello', html: `<p>${'é'.repeat(150_000)}</p>`});
    expect(big.status, JSON.stringify(big.json).slice(0, 200)).toBeLessThan(300);
    const huge = await own.post('/site-api/crm/email/templates', {name: 'Huge', subject: 'Hello', html: `<p>${'é'.repeat(300_000)}</p>`});
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({error: 'too_large', message: 'That request is too large.'});
    // Elsewhere in the CRM the limit stays 64 KB, and the site's own routes keep theirs.
    const note = await own.post('/site-api/crm/tags', {name: 'x'.repeat(70 * 1024)});
    expect(note.status).toBe(413);
    expect(note.json.message).toBe('That request is too large.');
    const site = await own.post('/site-api/auth/login', {email: 'a@b.co', password: 'x'.repeat(70 * 1024)});
    expect(site.status).toBe(413);
  });

  it('lets only an Owner change an Admin, an Owner change another Owner, and never an Admin above themself (P2-3)', async () => {
    const {browser: adminA} = await teammate(own, 'admin.a@example.com', 'ADMIN');
    await teammate(own, 'admin.b@example.com', 'ADMIN');
    await teammate(own, 'member.m@example.com', 'MEMBER');
    const [ownerId, adminB, memberM] = await Promise.all([ownerMemberId(), memberId('admin.b@example.com'), memberId('member.m@example.com')]);

    expect((await adminA.request('PATCH', `/site-api/crm/team/${adminB}`, {active: false})).status).toBe(404);
    expect((await adminA.request('PATCH', `/site-api/crm/team/${adminB}`, {role: 'MEMBER'})).status).toBe(404);
    expect((await adminA.request('PATCH', `/site-api/crm/team/${ownerId}`, {role: 'MEMBER'})).status).toBe(404);
    expect((await db.member.findUniqueOrThrow({where: {id: adminB}})).active).toBe(true);
    // Below them: an Admin manages Members (and may make one an Admin, as inviting allows).
    expect((await adminA.request('PATCH', `/site-api/crm/team/${memberM}`, {role: 'VIEWER'})).status).toBe(200);
    expect((await adminA.request('PATCH', `/site-api/crm/team/${memberM}`, {role: 'ADMIN'})).status).toBe(200);
    // The Owner changes Admins…
    expect((await own.request('PATCH', `/site-api/crm/team/${adminB}`, {active: false})).status).toBe(200);
    // …and another Owner; never themself.
    await db.member.update({where: {id: adminB}, data: {role: 'OWNER', active: true}});
    expect((await own.request('PATCH', `/site-api/crm/team/${adminB}`, {role: 'ADMIN'})).status).toBe(200);
    expect((await db.member.findUniqueOrThrow({where: {id: adminB}})).role).toBe('ADMIN');
    expect((await own.request('PATCH', `/site-api/crm/team/${ownerId}`, {active: false})).status).toBe(400);
  });

  it('lets only the form’s creator or an admin publish, close and delete responses; redirects are web links (P2-6, P2-13, P2-18)', async () => {
    const {browser: member} = await teammate(own, 'member.m@example.com', 'MEMBER');
    const form = (await own.post('/site-api/crm/forms', {name: 'Leads'})).json.form as {id: string};
    expect((await member.post(`/site-api/crm/forms/${form.id}/status`, {status: 'PUBLISHED'})).status).toBe(403);
    expect((await member.post(`/site-api/crm/forms/${form.id}/status`, {status: 'CLOSED'})).status).toBe(403);
    expect((await own.post(`/site-api/crm/forms/${form.id}/status`, {status: 'PUBLISHED'})).status).toBe(200);
    const mine = (await member.post('/site-api/crm/forms', {name: 'Mine'})).json.form as {id: string};
    expect((await member.post(`/site-api/crm/forms/${mine.id}/status`, {status: 'PUBLISHED'})).status).toBe(200);

    const sub = await db.formSubmission.create({data: {formId: form.id}, select: {id: true}});
    await db.form.update({where: {id: form.id}, data: {submissionCount: 1}});
    expect((await member.delete(`/site-api/crm/forms/submissions/${sub.id}`)).status).toBe(403);
    expect(await db.formSubmission.count({where: {id: sub.id}})).toBe(1);
    expect((await own.delete(`/site-api/crm/forms/submissions/${sub.id}`)).status).toBe(200);
    expect(await db.formSubmission.count({where: {id: sub.id}})).toBe(0);

    const settings = (await own.get(`/site-api/crm/forms/${form.id}`)).json.form as {settings: Record<string, unknown> & {endings: Record<string, unknown>[]}};
    const ending = (redirectUrl: string) => ({settings: {...settings.settings, endings: [{...settings.settings.endings[0], redirectUrl}]}});
    const bad = await own.request('PATCH', `/site-api/crm/forms/${form.id}`, ending('javascript:alert(1)'));
    invalid(bad.status);
    expect(JSON.stringify(bad.json)).toMatch(/web address/);
    expect((await own.request('PATCH', `/site-api/crm/forms/${form.id}`, ending('https://acme.example/thanks'))).status).toBe(200);

    for (const page of ['1.5', '1e3', '-1', '100000']) invalid((await own.get(`/site-api/crm/forms/${form.id}/submissions?page=${page}`)).status);
    expect((await own.get(`/site-api/crm/forms/${form.id}/submissions?page=2`)).status).toBe(200);
  });

  it('ends CSAT links 30 days after they were sent and manage links a week after the meeting (P2-8)', async () => {
    const ticket = await db.ticket.create({data: {subject: 'Printer', status: 'RESOLVED', csatSentAt: new Date()}, select: {id: true}});
    const fresh = await inScope(() => csatToken(ticket.id));
    const old = await inScope(() => csatToken(ticket.id, Date.now() - 31 * DAY));
    const guest = new Browser(app);
    expect((await guest.get(`/site-api/crm/public/csat/${fresh}`)).status).toBe(200);
    expect((await guest.get(`/site-api/crm/public/csat/${old}`)).status).toBe(404);
    expect((await guest.post(`/site-api/crm/public/csat/${old}`, {rating: 5})).status).toBe(404);
    // A moved issue time breaks the signature.
    const [id, , sig] = old.split('.');
    expect((await guest.get(`/site-api/crm/public/csat/${id}.${Math.floor(Date.now() / 1000).toString(36)}.${sig}`)).status).toBe(404);
    // Links sent before the time was in them: 30 days from the email.
    const legacy = `${ticket.id}.${await inScope(() => sign(`csat:${ticket.id}`))}`;
    expect((await guest.get(`/site-api/crm/public/csat/${legacy}`)).status).toBe(200);
    await db.ticket.update({where: {id: ticket.id}, data: {csatSentAt: new Date(Date.now() - 31 * DAY)}});
    expect((await guest.get(`/site-api/crm/public/csat/${legacy}`)).status).toBe(404);

    const meeting = (endAt: number) => db.booking.create({data: {title: 'Intro', startAt: new Date(endAt - 1_800_000), endAt: new Date(endAt), name: 'Ana', email: 'ana@example.com'}, select: {id: true}});
    const recent = await meeting(Date.now() - 6 * DAY);
    const past = await meeting(Date.now() - 8 * DAY);
    expect((await guest.get(`/site-api/crm/public/booking/manage/${await inScope(() => manageToken(recent.id))}`)).status).toBe(200);
    expect((await guest.get(`/site-api/crm/public/booking/manage/${await inScope(() => manageToken(past.id))}`)).status).toBe(404);
    expect((await guest.post(`/site-api/crm/public/booking/manage/${await inScope(() => manageToken(past.id))}/cancel`, {})).status).toBe(404);
  });

  it('checks the booking slots query and limits it per connection (P2-9)', async () => {
    const visitor = new Browser(app, '198.51.100.77');
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * DAY).toISOString();
    const q = (params: Record<string, string>) => `/site-api/crm/public/booking/slots?${new URLSearchParams({linkId: 'nolink', duration: '30', from, to, ...params})}`;
    invalid((await visitor.get(q({from: 'tomorrow'}))).status);
    invalid((await visitor.get(q({to: '2026-13-45'}))).status);
    invalid((await visitor.get(q({duration: '1e3'}))).status);
    invalid((await visitor.get(q({linkId: 'x'.repeat(41)}))).status);
    for (let i = 0; i < 60; i++) expect((await visitor.get(q({}))).status).toBe(404);
    const limited = await visitor.get(q({}));
    expect(limited.status).toBe(429);
    // Another connection is not held back.
    expect((await new Browser(app, '198.51.100.78').get(q({}))).status).toBe(404);
  });

  it('answers the Data in API without a valid key but logs nothing, counting it against the connection (P2-10)', async () => {
    const path = '/site-api/crm/public/data-in/v1/contacts';
    const noKey = await outside(path, {headers: {'content-type': 'application/json'}, body: '{}'});
    expect(noKey.status).toBe(401);
    const badKey = await outside(path, {headers: {'content-type': 'application/json', authorization: `Bearer crm_live_${'z'.repeat(32)}`}, body: '{}'});
    expect(badKey.status).toBe(401);
    const wrongMethod = await outside(path, {method: 'GET'});
    expect(wrongMethod.status).toBe(404);
    expect(await db.dataInRequest.count()).toBe(0);
    expect(await db.rateHit.count({where: {key: {startsWith: 'datain:bad:'}}})).toBe(3);
    // Over the limit: still answered, still not logged.
    const {key: bad} = await db.rateHit.findFirstOrThrow({where: {key: {startsWith: 'datain:bad:'}}, select: {key: true}});
    await db.rateHit.createMany({data: Array.from({length: 30}, () => ({key: bad}))});
    const blocked = await outside(path, {headers: {'content-type': 'application/json'}, body: '{}'});
    expect(blocked.status).toBe(429);
    expect(await db.dataInRequest.count()).toBe(0);
  });

  it('gives a Data in record to an invited teammate who has not joined yet (P3-3)', async () => {
    const key = (await own.post('/site-api/crm/data-in/keys', {name: 'Site'})).json as {plain: string};
    const secret = (await own.post('/site-api/crm/data-in/secret/reveal', {})).json.secret as string;
    const invite = await own.post('/site-api/crm/team/invite', {name: 'Ivy', email: 'ivy@example.com', role: 'MEMBER'});
    const ivy = (invite.json.user as {id: string}).id;
    const body = JSON.stringify({email: 'lead@client.io', owner: 'IVY@example.com'});
    const t = Math.floor(Date.now() / 1000);
    const res = await outside('/site-api/crm/public/data-in/v1/contacts', {
      headers: {'content-type': 'application/json', authorization: `Bearer ${key.plain}`, 'x-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`},
      body,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect((await db.contact.findFirstOrThrow({where: {email: 'lead@client.io'}})).ownerId).toBe(ivy);
  });

  it('never lets a burst through the rate limit, and keys hold a keyed hash (P2-11)', async () => {
    const limits = [{key: 'test:burst', limit: 3, windowSec: 60}];
    const results = await Promise.all(Array.from({length: 10}, () => inScope(() => rateLimit(crmDb, limits).then(() => 'ok', () => 'refused'))));
    expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(3);
    expect(await db.rateHit.count({where: {key: 'test:burst'}})).toBeLessThanOrEqual(3);
    // Keyed (the site's secret), so it can't be recomputed from the address alone as a plain hash could.
    const key = await inScope(() => ipKey('203.0.113.10'));
    expect(key).not.toContain('203.0.113.10');
    expect(key).not.toBe(createHash('sha256').update('ip:203.0.113.10').digest('hex').slice(0, 20));
    expect(key).toBe(await inScope(() => sign('ip:203.0.113.10')));
  });

  it('escapes CSV headers like cells (P2-15)', () => {
    const text = csv([{'=HYPERLINK("x")': '=1+1'}], ['=HYPERLINK("x")']);
    const [head, row] = text.split('\r\n');
    expect(head).toBe(`"'=HYPERLINK(""x"")"`);
    expect(row).toBe(`'=1+1`);
  });

  it('accepts only a Microsoft tenant name or id (P2-14)', async () => {
    for (const tenant of ['evil.com/oauth2?x=', 'a b', '../common', 'x'.repeat(101)]) {
      invalid((await own.request('PATCH', '/site-api/crm/settings', {microsoftTenant: tenant})).status);
    }
    const ok = await own.request('PATCH', '/site-api/crm/settings', {microsoftTenant: 'contoso.onmicrosoft.com'});
    expect(ok.status).toBe(200);
    expect((ok.json.settings as {microsoftTenant: string}).microsoftTenant).toBe('contoso.onmicrosoft.com');
  });

  it('serves the sprout favicon in the brand’s colours (P3-2)', async () => {
    const guest = new Browser(app);
    const first = await guest.get('/site-api/crm/public/favicon.svg');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('image/svg+xml');
    expect(first.headers.get('cache-control')).toContain('public');
    expect(String(first.json.text)).toContain('#2563eb');
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandPrimary: '#ff0000', brandSecondary: '#00ff00'})).status).toBe(200);
    const tinted = String((await guest.get('/site-api/crm/public/favicon.svg')).json.text);
    expect(tinted).toContain('stop-color="#ff0000"');
    expect(tinted).toContain('stop-color="#00ff00"');
  });

  it('shows a saved setting on the next read: settings, brand and ticket settings are cleared on save (P2-26)', async () => {
    expect(((await own.get('/site-api/crm/settings')).json.settings as {brandName: string}).brandName).toBe('Acme');
    expect((await own.get('/site-api/crm/public/brand')).json.name).toBe('Acme');
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandName: 'Globex', currency: 'EUR'})).status).toBe(200);
    expect((await own.get('/site-api/crm/public/brand')).json.name).toBe('Globex');
    const after = (await own.get('/site-api/crm/settings')).json.settings as {brandName: string; currency: string; inboundToken: string};
    expect([after.brandName, after.currency]).toEqual(['Globex', 'EUR']);
    expect(after.inboundToken.length).toBeGreaterThan(10);

    await own.get('/site-api/crm/public/support/config');
    const tickets = await own.request('PATCH', '/site-api/crm/tickets/settings', {portalEnabled: true, portalIntro: 'We answer within a day.'});
    expect(tickets.status, JSON.stringify(tickets.json)).toBe(200);
    expect((await own.get('/site-api/crm/public/support/config')).json).toMatchObject({enabled: true, intro: 'We answer within a day.'});
  });

  it('keeps the logo small: raster logos are public storage links, SVGs up to 60 KB, old data URLs keep working (P2-27)', async () => {
    fakeStorage();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const start = await own.post('/site-api/crm/files/public', {name: 'logo.png', contentType: 'image/png', size: png.length});
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    const upload = start.json.upload as {url: string};
    await fetch(new URL(upload.url, 'https://platform.example.test'), {method: 'PUT', body: png});
    const done = await own.post(`/site-api/crm/files/public/${start.json.fileId as string}/complete`);
    const url = done.json.url as string;
    expect(url).toMatch(/\/__platform\/files\/file_[0-9a-z]{26}\//);
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: url})).status).toBe(200);
    expect((await own.get('/site-api/crm/public/brand')).json.logo).toBe(url);

    // Never a link to somewhere else, a raster data URL, or a big SVG.
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: 'https://evil.example/__platform/files/file_aaaaaaaaaaaaaaaaaaaaaaaaaa/x.png'})).status).toBe(400);
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: `data:image/png;base64,${btoa('x'.repeat(300))}`})).status).toBe(400);
    const svg = (size: number) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(size)}</svg>`).toString('base64')}`;
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: svg(70 * 1024)})).status).toBe(400);
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: svg(1000)})).status).toBe(200);

    // An older install's 150 KB PNG data URL: the cached brand holds a short URL that serves it.
    const legacy = `data:image/png;base64,${Buffer.from(new Uint8Array(150_000).fill(7)).toString('base64')}`;
    const row = await db.setting.findUniqueOrThrow({where: {key: 'workspace'}});
    await db.setting.update({where: {key: 'workspace'}, data: {value: {...(row.value as object), brandLogo: legacy}}});
    await cache.delPrefix('crm:'); // written straight to the table: clear what the app cached
    const brand = (await own.get('/site-api/crm/public/brand')).json as {logo: string};
    expect(brand.logo).toMatch(/^\/site-api\/crm\/public\/logo\?v=[0-9a-f]{12}$/);
    const served = await new Browser(app).get(brand.logo);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    // Saving the other settings sends the old logo back unchanged: still accepted.
    expect((await own.request('PATCH', '/site-api/crm/settings', {brandLogo: legacy, brandName: 'Acme 2'})).status).toBe(200);
  });
});
