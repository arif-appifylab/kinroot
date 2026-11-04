import {randomUUID} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {contactIdByEmail, contactsByEmail, optedOutEmails} from '../../src/server/crm/lib/contact-email';
import {continueToken} from '../../src/server/crm/inbox/chat';
import {crmOwner} from './ported/support';
import {resetCrm} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Case-insensitive email lookups on the `lower(email)` index (AUDIT P2-24): a contact saved as
 * "Mia.Mixed@Example.COM" is found by "mia.mixed@example.com" (and the other way round) from every
 * public path that matches people by email (booking, support request, form, chat), never made twice;
 * owner scoping and opt-outs hold.
 */

const STORED = 'Mia.Mixed@Example.COM';
const typed = 'mia.MIXED@example.com';

let ip = 0;
async function visitor() {
  const v = new Browser(app, `198.51.100.${(++ip % 250) + 1}`);
  await v.get('/site-api/auth/csrf');
  return v;
}
const send = async (path: string, body: unknown) => (await visitor()).request('POST', path, body, {'idempotency-key': randomUUID()});
/** Contacts using the address, whatever its case. */
const sameAddress = () => db.$queryRaw<{id: string}[]>`SELECT id FROM "Contact" WHERE lower(email) = ${STORED.toLowerCase()}`;
// The test client is the Node build of the same Prisma client.
const asDb = db as unknown as Parameters<typeof contactsByEmail>[0];

describe.skipIf(!DATABASE_URL)('Kinroot: contacts found by email whatever its case (integration, real Postgres)', () => {
  let mia: string;
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    mia = (await db.contact.create({data: {firstName: 'Mia', lastName: 'Mixed', email: STORED}})).id;
  });

  it('the helpers match any case, keep the owner scope, and see opt-outs', async () => {
    expect(await contactIdByEmail(asDb, typed)).toBe(mia);
    expect(await contactIdByEmail(asDb, '  MIA.MIXED@EXAMPLE.COM ')).toBe(mia);
    expect(await contactIdByEmail(asDb, 'someone@example.com')).toBeNull();
    expect(await contactIdByEmail(asDb, '')).toBeNull();
    const {me} = await crmOwner();
    expect(await contactIdByEmail(asDb, typed, {ownerId: me.id}), "not the member's contact: not found").toBeNull();
    await db.contact.update({where: {id: mia}, data: {ownerId: me.id}});
    expect(await contactIdByEmail(asDb, typed, {ownerId: me.id})).toBe(mia);
    const older = await db.contact.create({data: {firstName: 'Mia', lastName: 'Twin', email: 'MIA.mixed@example.com', createdAt: new Date(Date.now() - 86_400_000)}});
    expect((await contactsByEmail(asDb, [typed, 'nobody@example.com'])).map((r) => r.id), 'oldest first').toEqual([older.id, mia]);
    expect((await optedOutEmails(asDb, [typed])).size).toBe(0);
    await db.contact.update({where: {id: older.id}, data: {emailOptOut: true}});
    expect([...(await optedOutEmails(asDb, [typed, 'x@example.com']))]).toEqual([STORED.toLowerCase()]);
  });

  it('a booking with the address in another case lands on the same contact', async () => {
    const {me} = await crmOwner();
    const allWeek = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{start: '00:00', end: '24:00'}]]));
    const link = await db.bookingLink.create({
      data: {kind: 'personal', userId: me.id, slug: `case-${randomUUID().slice(0, 6)}`, name: 'Intro call', durations: [30], timezone: 'UTC', availability: {weekly: allWeek, overrides: []}, minNoticeMin: 0, questions: {phone: 'off', company: 'off', notes: 'off'}},
    });
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const res = await send('/site-api/crm/public/booking/book', {linkId: link.id, start: start.toISOString(), duration: 30, timezone: 'UTC', name: 'Mia Mixed', email: typed, source: 'page'});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect((await db.booking.findFirstOrThrow({where: {linkId: link.id}})).contactId).toBe(mia);
    expect(await sameAddress()).toHaveLength(1);
  }, 60_000);

  it('a support request, a form response and a chat find the same contact', async () => {
    const {browser: own} = await crmOwner();

    const ticket = await send('/site-api/crm/public/support/tickets', {subject: 'Help', description: 'Please', email: typed, name: 'Mia', startedAt: Date.now() - 10_000});
    expect(ticket.status, JSON.stringify(ticket.json)).toBe(201);
    expect((await db.ticket.findFirstOrThrow()).contactId).toBe(mia);

    const form = (await own.post('/site-api/crm/forms', {name: 'Contact us', templateId: 'contact'})).json.form as {id: string};
    const fd = (await own.get(`/site-api/crm/forms/${form.id}`)).json.form as {slug: string; fields: {id: string; type: string; required?: boolean}[]};
    expect((await own.post(`/site-api/crm/forms/${form.id}/status`, {status: 'PUBLISHED'})).status).toBe(200);
    const answers: Record<string, unknown> = {[fd.fields.find((f) => f.type === 'email')!.id]: typed};
    for (const f of fd.fields) if (f.required && !(f.id in answers)) answers[f.id] = f.type === 'consent' ? true : f.type === 'name' ? {first: 'Mia', last: 'Mixed'} : 'Call me';
    const sent = await send(`/site-api/crm/public/forms/${fd.slug}/submit`, {answers, meta: {page: 'https://example.com/contact'}, startedAt: Date.now() - 10_000});
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect((await db.formSubmission.findFirstOrThrow({where: {formId: form.id}})).contactId).toBe(mia);

    const current = (await own.get('/site-api/crm/inbox/chat/settings')).json.settings as Record<string, any>;
    expect((await own.request('PUT', '/site-api/crm/inbox/chat/settings', {...current, enabled: true, preChat: 'off', allowedDomains: [], hours: {...current.hours, enabled: false}})).status).toBe(200);
    const chat = await send('/site-api/crm/public/chat/start', {text: 'Hello', email: typed, name: 'Mia', meta: {page: 'https://shop.example.com/'}, startedAt: Date.now() - 5000});
    expect(chat.status, JSON.stringify(chat.json)).toBe(201);
    // A chat's typed address joins that contact only once the visitor opens the link we mail to it
    // (AUDIT-2 L-4); it never makes a second contact for the address either.
    const row = await db.emailThread.findFirstOrThrow({where: {channel: 'chat'}});
    expect(row.contactId).toBeNull();
    const token = await continueToken(row.id, row.identityId!, 30, typed);
    expect((await send('/site-api/crm/public/chat/continue', {token})).status).toBe(200);
    expect((await db.emailThread.findFirstOrThrow({where: {channel: 'chat'}})).contactId).toBe(mia);

    expect(await sameAddress(), 'never a second contact for the same address').toHaveLength(1);
  }, 60_000);
});
