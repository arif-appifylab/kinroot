import {randomUUID} from 'node:crypto';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {owner, resetCrm} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Hand-written checks about one input name their field (AUDIT P2-32): the answer keeps its status
 * (400, or 409 for "already taken") and carries `fields: {name: message}` like `valid()`'s 422, so
 * the form shows the words under that field (`f.fail` in src/crm/components/ui/form-state.ts).
 */

const API = '/site-api/crm';
type Json = Record<string, unknown>;
type Res = {status: number; json: Json};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  return res.json as T;
};
/** The answer names exactly this field, with the same words as `error`. */
const onField = (res: Res, status: number, field: string) => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  const fields = res.json.fields as Record<string, string>;
  expect(Object.keys(fields)).toEqual([field]);
  expect(fields[field]).toBe(res.json.error);
};

let own: Browser;
const post = (path: string, body: unknown = {}) => own.post(`${API}${path}`, body);
const put = (path: string, body: unknown) => own.request('PUT', `${API}${path}`, body);
const patch = (path: string, body: unknown) => own.request('PATCH', `${API}${path}`, body);

describe.skipIf(!DATABASE_URL)('Kinroot field errors from hand-written checks (integration)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    own = await owner();
    await own.get(`${API}/auth/state`);
    ok(await post('/auth/setup', {brandName: 'Acme', demoData: false}));
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  it('"already taken" lands on its field and keeps 409: contact email, company domain, team invite', async () => {
    ok(await post('/contacts', {firstName: 'Dana', email: 'dana@example.com'}), 201);
    onField(await post('/contacts', {firstName: 'Dana again', email: 'dana@example.com'}), 409, 'email');

    ok(await post('/companies', {name: 'Acme', domain: 'acme.example'}), 201);
    onField(await post('/companies', {name: 'Acme two', domain: 'acme.example'}), 409, 'domain');

    ok(await post('/team/invite', {name: 'Ivy', email: 'ivy@example.com', role: 'MEMBER'}));
    onField(await post('/team/invite', {name: 'Ivy', email: 'IVY@example.com', role: 'MEMBER'}), 409, 'email');
  });

  it("a form's address: a bad one is a 400, a taken one a 409, both on `slug`", async () => {
    ok(await post('/forms', {name: 'Contact'}), 201);
    const b = ok<{form: {id: string}}>(await post('/forms', {name: 'Demo request'}), 201).form;
    const {slug: taken} = await db.form.findFirstOrThrow({where: {name: 'Contact'}, select: {slug: true}});
    onField(await patch(`/forms/${b.id}`, {slug: 'Not OK!'}), 400, 'slug');
    onField(await patch(`/forms/${b.id}`, {slug: taken}), 409, 'slug');
  });

  it('settings forms: custom field options, email template, website and inbox settings', async () => {
    onField(await post('/fields', {entity: 'CONTACT', label: 'Plan', type: 'SELECT', options: []}), 400, 'options');
    onField(await post('/email/templates', {name: 'Empty', subject: 'Hi', html: '<p></p>', layout: 'plain', shared: true}), 400, 'html');

    const site = ok<{settings: Json}>(await own.get(`${API}/website/settings`)).settings;
    onField(await put('/website/settings', {...site, contactFormId: 'not-a-form'}), 400, 'contactFormId');

    const inbox = ok<{settings: Json}>(await own.get(`${API}/inbox/settings`)).settings;
    onField(await put('/inbox/settings', {...inbox, assignment: 'round_robin', roundRobinIds: []}), 400, 'roundRobinIds');
  });

  it('backstops on one input name it too: schedule timing, custom values, empty replies (P2-32)', async () => {
    // A report email's timing (the drawer's "Next sends" and save use the same checks).
    onField(await post('/report-schedules/next', {frequency: 'weekly', time: '09:00', timezone: 'Europe/Berlin'}), 400, 'weekday');
    onField(await post('/report-schedules/next', {frequency: 'monthly', time: '09:00', timezone: 'Europe/Berlin'}), 400, 'monthDay');
    onField(await post('/report-schedules/next', {frequency: 'daily', time: '09:00', timezone: 'Mars/Olympus'}), 400, 'timezone');

    // A custom field's value lands on that field (`custom.<key>`).
    const def = ok<{field: {key: string}}>(await post('/fields', {entity: 'CONTACT', label: 'Seats', type: 'NUMBER'}), 201).field;
    onField(await post('/contacts', {firstName: 'Nina', custom: {[def.key]: 'many'}}), 400, `custom.${def.key}`);

    // Empty replies and messages: the editor's field.
    onField(await post('/tickets/1/messages', {kind: 'reply', html: '<p></p>'}), 400, 'html');
    onField(await post('/inbox/conversations/none/reply', {html: ''}), 400, 'html');
    onField(await post('/email/send', {to: ['someone@example.com'], subject: 'Hi'}), 400, 'html');
  });

  it('public pages: a refused form answer names its question, a booking its duration (P2-32)', async () => {
    const visitor = async () => {
      const v = new Browser(app, `198.51.100.${Math.floor(Math.random() * 200) + 20}`);
      await v.get('/site-api/auth/csrf');
      return v;
    };
    const form = ok<{form: {id: string}}>(await post('/forms', {name: 'Talk to us', templateId: 'contact'}), 201).form;
    const fd = ok<{form: {slug: string; fields: {id: string; type: string; required?: boolean}[]}}>(await own.get(`${API}/forms/${form.id}`)).form;
    ok(await post(`/forms/${form.id}/status`, {status: 'PUBLISHED'}));
    const emailId = fd.fields.find((f) => f.type === 'email')!.id;
    const answers: Record<string, unknown> = {[emailId]: 'not-an-address'};
    for (const f of fd.fields) if (f.required && !(f.id in answers)) answers[f.id] = f.type === 'name' ? {first: 'Ada', last: 'L'} : 'Please call';
    const sent = await (await visitor()).request('POST', `${API}/public/forms/${fd.slug}/submit`, {answers, startedAt: Date.now() - 10_000}, {'idempotency-key': randomUUID()});
    expect(sent.status, JSON.stringify(sent.json)).toBe(400);
    expect(Object.keys(sent.json.fields as Json), 'on the email question').toEqual([emailId]);
    expect(String(sent.json.error), 'the summary says which question').toMatch(/^Email: /);

    const me = await db.member.findFirstOrThrow({select: {id: true}});
    const allWeek = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{start: '00:00', end: '24:00'}]]));
    const link = await db.bookingLink.create({
      data: {kind: 'personal', userId: me.id, slug: `fe-${randomUUID().slice(0, 6)}`, name: 'Intro call', durations: [30], timezone: 'UTC', availability: {weekly: allWeek, overrides: []}, minNoticeMin: 0, questions: {phone: 'off', company: 'off', notes: 'off'}},
    });
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const booked = await (await visitor()).request('POST', `${API}/public/booking/book`, {linkId: link.id, start: start.toISOString(), duration: 45, timezone: 'UTC', name: 'Bo Oker', email: 'bo@example.com', source: 'page'}, {'idempotency-key': randomUUID()});
    onField(booked, 400, 'duration');
  }, 60_000);
});
