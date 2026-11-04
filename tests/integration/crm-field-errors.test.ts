import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {owner, resetCrm} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

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
});
