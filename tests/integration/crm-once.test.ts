import {randomUUID} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {crmOwner} from './ported/support';
import {resetCrm} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Once, and never twice (docs/agent/orders-and-stock.md), on real Postgres: many requests at the
 * same moment. Bookings: the database lets one visitor have a host's time (a lock per host), and
 * the same attempt sent again books nothing more. Support requests, form responses and a website
 * chat's first message: the same `idempotency-key` sent many times makes one row and one answer.
 */

let ip = 0;
/** A visitor on their own connection (the public routes limit each one), its CSRF cookie ready. */
async function visitor() {
  const v = new Browser(app, `192.0.2.${(++ip % 250) + 1}`);
  await v.get('/site-api/auth/csrf');
  return v;
}
const send = (v: Browser, path: string, body: unknown, key?: string) => v.request('POST', path, body, key ? {'idempotency-key': key} : {});
const many = <T>(n: number, make: (i: number) => Promise<T>) => Promise.all(Array.from({length: n}, (_, i) => make(i)));
const visitors = (n: number) => many(n, () => visitor());

const allWeek = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map(d => [d, [{start: '00:00', end: '24:00'}]]));
/** Tomorrow at `hour`:00 UTC: an open half hour on the link below. */
const at = (hour: number) => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe.skipIf(!DATABASE_URL)('Kinroot: public writes happen once (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);

  async function bookingLink() {
    const {me} = await crmOwner();
    return db.bookingLink.create({
      data: {kind: 'personal', userId: me.id, slug: `once-${randomUUID().slice(0, 6)}`, name: 'Intro call', durations: [30], timezone: 'UTC', availability: {weekly: allWeek, overrides: []}, minNoticeMin: 0, questions: {phone: 'off', company: 'off', notes: 'off'}},
    });
  }
  const book = (v: Browser, linkId: string, start: string, key: string | undefined, who = 'ana') =>
    send(v, '/site-api/crm/public/booking/book', {linkId, start, duration: 30, timezone: 'UTC', name: who, email: `${who}@example.com`, source: 'page'}, key);

  it('books a time once when many visitors take it at the same moment', async () => {
    const link = await bookingLink();
    const start = at(10);
    const people = await visitors(14);
    const answers = await Promise.all(people.map((v, i) => book(v, link.id, start, randomUUID(), `p${i}`)));
    const statuses = answers.map(a => a.status).sort();
    expect(statuses.filter(s => s === 201), JSON.stringify(answers.map(a => a.json))).toHaveLength(1);
    expect(statuses.filter(s => s === 409)).toHaveLength(13);
    expect(answers.find(a => a.status === 409)!.json.error).toMatch(/no longer available/);
    expect(await db.booking.count({where: {linkId: link.id}})).toBe(1);
    expect(await db.interaction.count({where: {kind: 'MEETING'}})).toBe(1);
  }, 120_000);

  it('answers the same attempt sent many times with one booking, and asks for a key', async () => {
    const link = await bookingLink();
    const key = randomUUID();
    const people = await visitors(10);
    const answers = await Promise.all(people.map(v => book(v, link.id, at(11), key)));
    expect(answers.map(a => a.status)).toEqual(Array(10).fill(201));
    const ids = new Set(answers.map(a => (a.json.booking as {id: string}).id));
    expect(ids.size).toBe(1);
    expect(new Set(answers.map(a => a.json.token)).size).toBe(1);
    expect(await db.booking.count({where: {linkId: link.id}})).toBe(1);
    expect(await db.interaction.count({where: {kind: 'MEETING'}})).toBe(1);
    expect(await db.contact.count({where: {email: 'ana@example.com'}})).toBe(1);

    // Later, the same attempt again (the first answer was lost): the same booking, nothing new.
    const again = await book(await visitor(), link.id, at(11), key);
    expect(again.status).toBe(201);
    expect((again.json.booking as {id: string}).id).toBe([...ids][0]);
    expect(await db.booking.count({where: {linkId: link.id}})).toBe(1);
    // The same key for another time: refused in words, nothing booked.
    const other = await book(await visitor(), link.id, at(12), key);
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/different details/);
    // No key: refused in words.
    const keyless = await book(await visitor(), link.id, at(13), undefined, 'bo');
    expect(keyless.status).toBe(400);
    expect(keyless.json.error).toMatch(/reload the page/);
    expect(await db.booking.count({where: {linkId: link.id}})).toBe(1);
  }, 120_000);

  it('moves only one of two meetings onto the same free time', async () => {
    const link = await bookingLink();
    const a = await book(await visitor(), link.id, at(9), randomUUID(), 'amy');
    const b = await book(await visitor(), link.id, at(14), randomUUID(), 'ben');
    expect([a.status, b.status]).toEqual([201, 201]);
    const target = at(16);
    const moved = await Promise.all(
      [a, b].map(async r => send(await visitor(), `/site-api/crm/public/booking/manage/${r.json.token}/reschedule`, {start: target}))
    );
    expect(moved.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db.booking.count({where: {linkId: link.id, startAt: new Date(target), status: 'CONFIRMED'}})).toBe(1);
  }, 120_000);

  it('opens one support request for the same attempt sent many times', async () => {
    const key = randomUUID();
    const body = {subject: 'Login broken', description: 'It does not work', email: 'cat@example.com', name: 'Cat', startedAt: Date.now() - 10_000};
    const answers = await Promise.all((await visitors(6)).map(v => send(v, '/site-api/crm/public/support/tickets', body, key)));
    expect(answers.map(a => a.status)).toEqual(Array(6).fill(201));
    for (const a of answers) expect(a.json).toEqual({ok: true, signedIn: false});
    expect(await db.ticket.count()).toBe(1);
    expect(await db.contact.count({where: {email: 'cat@example.com'}})).toBe(1);
    expect((await db.ticket.findFirstOrThrow()).contactId).toBeTruthy();
    // Without a key (an older page) it still works, unprotected.
    expect((await send(await visitor(), '/site-api/crm/public/support/tickets', {...body, subject: 'Second'})).status).toBe(201);
    expect(await db.ticket.count()).toBe(2);
  }, 120_000);

  it('saves one form response for the same attempt sent many times', async () => {
    const {browser: own} = await crmOwner();
    const form = (await own.post('/site-api/crm/forms', {name: 'Contact us', templateId: 'contact'})).json.form as {id: string};
    const fd = (await own.get(`/site-api/crm/forms/${form.id}`)).json.form as {slug: string; fields: {id: string; type: string; required?: boolean}[]};
    expect((await own.post(`/site-api/crm/forms/${form.id}/status`, {status: 'PUBLISHED'})).status).toBe(200);
    const answers: Record<string, unknown> = {[fd.fields.find(f => f.type === 'email')!.id]: 'fran@example.com'};
    const nameField = fd.fields.find(f => f.type === 'name');
    if (nameField) answers[nameField.id] = {first: 'Fran', last: 'Form'};
    for (const f of fd.fields) if (f.required && !(f.id in answers)) answers[f.id] = f.type === 'consent' ? true : 'Please call me back';

    const key = randomUUID();
    const body = {answers, meta: {page: 'https://example.com/contact'}, startedAt: Date.now() - 10_000};
    const sent = await Promise.all((await visitors(6)).map(v => send(v, `/site-api/crm/public/forms/${fd.slug}/submit`, body, key)));
    expect(sent.map(a => a.status), JSON.stringify(sent.map(a => a.json))).toEqual(Array(6).fill(200));
    for (const a of sent) expect(a.json).toEqual(sent[0]!.json);
    expect(await db.formSubmission.count({where: {formId: form.id}})).toBe(1);
    expect(await db.contact.count({where: {email: 'fran@example.com'}})).toBe(1);
    const sub = await db.formSubmission.findFirstOrThrow({where: {formId: form.id}});
    expect(sub.contactId).toBeTruthy();
    expect((await db.form.findUniqueOrThrow({where: {id: form.id}})).submissionCount).toBe(1);
  }, 120_000);

  it('starts one chat for the same first message sent many times, new visitor or returning', async () => {
    const {browser: own} = await crmOwner();
    const current = (await own.get('/site-api/crm/inbox/chat/settings')).json.settings as Record<string, any>;
    const saved = await own.request('PUT', '/site-api/crm/inbox/chat/settings', {...current, enabled: true, preChat: 'off', allowedDomains: [], spamCheck: false, hours: {...current.hours, enabled: false}});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const meta = {page: 'https://shop.example.com/pricing', title: 'Pricing'};
    type Session = {token: string; conversation: {id: string; messages: unknown[]}};

    // A new visitor (no token yet): one visitor, one conversation, one message, the same token for all.
    const key = randomUUID();
    const body = {text: 'Hi! Do you ship to Norway?', email: 'nora@example.com', name: 'Nora', meta, startedAt: Date.now() - 5000};
    const answers = await Promise.all((await visitors(6)).map(v => send(v, '/site-api/crm/public/chat/start', body, key)));
    expect(answers.map(a => a.status), JSON.stringify(answers.map(a => a.json))).toEqual(Array(6).fill(201));
    const sessions = answers.map(a => a.json.session as Session);
    expect(new Set(sessions.map(s => s.token)).size).toBe(1);
    expect(new Set(sessions.map(s => s.conversation.id)).size).toBe(1);
    expect(await db.channelIdentity.count({where: {channel: 'chat'}})).toBe(1);
    expect(await db.emailThread.count({where: {channel: 'chat'}})).toBe(1);
    expect(await db.channelMessage.count({where: {direction: 'INBOUND'}})).toBe(1);
    expect(await db.contact.count({where: {email: 'nora@example.com'}})).toBe(1);
    const thread = await db.emailThread.findFirstOrThrow({where: {channel: 'chat'}});
    expect(thread.contactId).toBeTruthy();
    expect(await db.event.count({where: {type: 'chat.started'}})).toBe(1);

    // The same visitor, back later with their token, starting another chat: once too.
    const token = sessions[0]!.token;
    const again = randomUUID();
    const next = {token, text: 'One more question', meta, startedAt: Date.now() - 5000};
    const second = await Promise.all((await visitors(5)).map(v => send(v, '/site-api/crm/public/chat/start', next, again)));
    expect(second.map(a => a.status)).toEqual(Array(5).fill(201));
    expect(new Set(second.map(a => (a.json.session as Session).conversation.id)).size).toBe(1);
    expect(await db.emailThread.count({where: {channel: 'chat'}})).toBe(2);
    expect(await db.channelIdentity.count({where: {channel: 'chat'}})).toBe(1);
  }, 120_000);
});
