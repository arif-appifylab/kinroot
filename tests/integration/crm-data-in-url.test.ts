import {createHmac} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {owner, ownerAccountId, resetCrm, teammate, userId} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db, ORIGIN} from './support/harness';

/**
 * The Data in URL (Settings → Webhooks → Incoming): Pabbly / Zapier / Make POST JSON to
 * /site-api/crm/public/data-in/<action>/<access token> with X-Signature-Token. Both tokens are
 * needed; regenerate replaces both; off → 404; rate limit, idempotency and the log as with a key;
 * the signed (API key + HMAC) mode keeps working beside it.
 */

const BASE = '/site-api/crm/public/data-in';
type Res = {status: number; data: any};

async function hook(method: string, path: string, headers: Record<string, string>, body?: string, ip = '198.51.100.44'): Promise<Res> {
  return inRequestScope(async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
    const res = await app.request(`${ORIGIN}${path}`, {method, headers: {'cf-connecting-ip': ip, ...headers}, body}, {}, ctx as never);
    while (pending.length) await pending.shift();
    const text = await res.text();
    await getDb()?.$disconnect();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return {status: res.status, data};
  });
}

const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};
const code = (r: Res) => r.data?.error?.code;

let own: Browser;
let ACCESS = '';
let SIGNATURE = '';

type Opt = {token?: string; signature?: string | null; idem?: string; raw?: string; ip?: string; method?: string};
const send = (path: string, body: unknown, opt: Opt = {}) => {
  const headers: Record<string, string> = {'content-type': 'application/json'};
  const sig = opt.signature === undefined ? SIGNATURE : opt.signature;
  if (sig !== null) headers['x-signature-token'] = sig;
  if (opt.idem) headers['idempotency-key'] = opt.idem;
  const method = opt.method ?? 'POST';
  return hook(method, `${BASE}${path}/${opt.token ?? ACCESS}`, headers, method === 'GET' ? undefined : (opt.raw ?? JSON.stringify(body)), opt.ip);
};

describe.skipIf(!DATABASE_URL)('Kinroot: Data in URL (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    own = await owner();
    await own.get('/site-api/crm/auth/state');
    await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
    // Off until an admin turns it on: no tokens yet.
    const before = await ok(own.get('/site-api/crm/data-in/url'));
    expect([before.enabled, before.ready, before.accessMasked]).toEqual([false, false, null]);
    const on = await ok(own.request('PATCH', '/site-api/crm/data-in/url', {enabled: true}));
    expect([on.enabled, on.ready]).toEqual([true, true]);
    const t = await ok(own.post('/site-api/crm/data-in/url/reveal', {}));
    ACCESS = t.accessToken;
    SIGNATURE = t.signatureToken;
  });

  it('creates a contact with the URL and the header, as the admin who turned it on; tokens stay out of the overview, the log and the database in clear', async () => {
    expect(ACCESS).toMatch(/^crm_url_[A-Za-z0-9_-]{40}$/);
    expect(SIGNATURE.startsWith('crm_st_') && SIGNATURE.length >= 40).toBe(true);
    // A no-code tool's body: an unmapped field as "", a number and a list as text.
    const r = await send('/contacts', {email: 'maya@pabbly-url.io', firstName: 'Maya', lastName: '', emailOptOut: 'false', tags: 'pabbly, trial'});
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.result.outcome).toBe('created');
    const contact = await db.contact.findUniqueOrThrow({where: {id: r.data.result.id}});
    const me = await db.member.findUniqueOrThrow({where: {userId: await ownerAccountId()}, select: {id: true}});
    expect(contact.ownerId).toBe(me.id);
    expect(contact.source).toBe('API: Data in URL');
    expect(contact.tags).toEqual(['pabbly', 'trial']);

    const overview = await ok(own.get('/site-api/crm/data-in/url'));
    expect(overview.createdBy.id).toBe(me.id);
    expect(overview.origin).toMatch(/^https:\/\/[^/]+$/);
    expect(JSON.stringify(overview)).not.toContain(ACCESS);
    expect(JSON.stringify(overview)).not.toContain(SIGNATURE);
    const setting = JSON.stringify((await db.setting.findUniqueOrThrow({where: {key: 'data-in'}})).value);
    expect(setting).not.toContain(ACCESS);
    expect(setting).not.toContain(SIGNATURE);
    const log = await db.dataInRequest.findFirstOrThrow({where: {action: 'contacts.upsert'}, orderBy: {createdAt: 'desc'}});
    expect([log.status, log.keyName, log.apiKeyId, log.path]).toEqual([201, 'Data in URL', null, '/contacts/{access_token}']);
    expect(JSON.stringify(log)).not.toContain(ACCESS);
    expect(JSON.stringify(log)).not.toContain(SIGNATURE);
    const revealed = await db.auditLog.findFirstOrThrow({where: {action: 'data_in.url_revealed'}});
    expect(revealed.category).toBe('security');
    expect(JSON.stringify(revealed.meta)).not.toContain(ACCESS);

    const bad = await send('/contacts', {email: 'not-an-email'});
    expect([bad.status, code(bad), bad.data.error.field]).toEqual([422, 'E_INVALID_FIELD', 'email']);
    const unknown = await send('/contacts', {email: 'x@pabbly-url.io', favouriteColour: 'blue'});
    expect([unknown.status, unknown.data.error.field]).toEqual([422, 'favouriteColour']);
    const notJson = await send('/contacts', null, {raw: 'email=x%40y.io'});
    expect([notJson.status, code(notJson)]).toEqual([400, 'E_INVALID_JSON']);
    expect(notJson.data.error.message).toMatch(/Pabbly/);
  });

  it('refuses a missing or wrong X-Signature-Token (401) and an unknown access token (404, not logged)', async () => {
    const missing = await send('/contacts', {email: 'a@pabbly-url.io'}, {signature: null});
    expect([missing.status, code(missing), missing.data.error.field]).toEqual([401, 'E_UNAUTHORIZED', 'X-Signature-Token']);
    const wrong = await send('/contacts', {email: 'a@pabbly-url.io'}, {signature: `crm_st_${'x'.repeat(40)}`});
    expect([wrong.status, code(wrong)]).toEqual([401, 'E_UNAUTHORIZED']);
    // The API's signing secret or an API key is not the signature token.
    const secret = (await ok(own.post('/site-api/crm/data-in/secret/reveal', {}))).secret;
    expect((await send('/contacts', {email: 'a@pabbly-url.io'}, {signature: secret})).status).toBe(401);
    expect(await db.contact.count({where: {email: 'a@pabbly-url.io'}})).toBe(0);
    expect(await db.dataInRequest.count({where: {status: 401, keyName: 'Data in URL'}})).toBe(3);

    const logged = await db.dataInRequest.count();
    const guess = await send('/contacts', {email: 'a@pabbly-url.io'}, {token: `crm_url_${'A'.repeat(40)}`});
    expect([guess.status, code(guess)]).toEqual([404, 'E_NOT_FOUND']);
    const junk = await send('/contacts', {email: 'a@pabbly-url.io'}, {token: 'nope'});
    expect(junk.status).toBe(404);
    expect(await db.dataInRequest.count()).toBe(logged);
    // A wrong method on a real URL is refused too.
    expect((await send('/contacts', undefined, {method: 'GET'})).status).toBe(404);
  });

  it('regenerate: the old URL and header stop working at once; the new pair works; only admins manage it', async () => {
    const oldAccess = ACCESS;
    const oldSig = SIGNATURE;
    const regen = await ok(own.post('/site-api/crm/data-in/url/regenerate', {}));
    expect(JSON.stringify(regen)).not.toContain(oldAccess);
    const t = await ok(own.post('/site-api/crm/data-in/url/reveal', {}));
    expect(t.accessToken).not.toBe(oldAccess);
    expect(t.signatureToken).not.toBe(oldSig);
    const old = await send('/events', {event: 'ping'}, {token: oldAccess, signature: oldSig});
    expect([old.status, code(old)]).toEqual([404, 'E_NOT_FOUND']);
    const mixed = await send('/events', {event: 'ping'}, {token: t.accessToken, signature: oldSig});
    expect(mixed.status).toBe(401);
    const fresh = await send('/events', {event: 'ping'}, {token: t.accessToken, signature: t.signatureToken});
    expect(fresh.status, JSON.stringify(fresh.data)).toBe(201);
    expect(await db.auditLog.count({where: {action: 'data_in.url_regenerated', category: 'security'}})).toBe(1);

    const {browser: member} = await teammate(own, 'member.url@example.com', 'MEMBER');
    expect((await member.post('/site-api/crm/data-in/url/reveal', {})).status).toBe(403);
    expect((await member.get('/site-api/crm/data-in/url')).status).toBe(403);
    expect((await member.post('/site-api/crm/data-in/url/regenerate', {})).status).toBe(403);
    expect((await member.request('PATCH', '/site-api/crm/data-in/url', {enabled: false})).status).toBe(403);
  });

  it('disabled: every URL answers 404 until it is enabled again (same tokens), acting as the admin who enabled it', async () => {
    await ok(own.request('PATCH', '/site-api/crm/data-in/url', {enabled: false}));
    const off = await send('/contacts', {email: 'off@pabbly-url.io'});
    expect([off.status, code(off)]).toEqual([404, 'E_NOT_FOUND']);
    expect(await db.auditLog.count({where: {action: 'data_in.url_disabled'}})).toBe(1);

    const {browser: admin2} = await teammate(own, 'admin.url@example.com', 'ADMIN');
    const adminId = (await db.member.findUniqueOrThrow({where: {userId: await userId('admin.url@example.com')}})).id;
    const on = await ok(admin2.request('PATCH', '/site-api/crm/data-in/url', {enabled: true}));
    expect(on.createdBy.id).toBe(adminId);
    const back = await send('/contacts', {email: 'on@pabbly-url.io'});
    expect(back.status).toBe(201);
    expect((await db.contact.findUniqueOrThrow({where: {id: back.data.result.id}})).ownerId).toBe(adminId);

    await ok(own.request('PATCH', `/site-api/crm/team/${adminId}`, {active: false}));
    const inactive = await send('/contacts', {email: 'later@pabbly-url.io'});
    expect([inactive.status, code(inactive)]).toEqual([403, 'E_KEY_OWNER_INACTIVE']);
  });

  it('applies the rate limit, the size limit and Idempotency-Key replays', async () => {
    await ok(own.request('PATCH', '/site-api/crm/data-in/settings', {rateLimit: 3}));
    const r: Res[] = [];
    for (let i = 0; i < 4; i++) r.push(await send('/events', {event: 'ping', properties: {i}}));
    expect(r.map((x) => x.status)).toEqual([201, 201, 201, 429]);
    expect(code(r[3]!)).toBe('E_RATE_LIMITED');
    await ok(own.request('PATCH', '/site-api/crm/data-in/settings', {rateLimit: 120}));
    await db.rateHit.deleteMany({});

    const big = await send('/contacts', {email: 'big@pabbly-url.io', note: 'x'.repeat(300 * 1024)});
    expect([big.status, code(big)]).toEqual([413, 'E_PAYLOAD_TOO_LARGE']);

    const first = await send('/contacts', {email: 'idem@pabbly-url.io'}, {idem: 'order-1001'});
    const again = await send('/contacts', {email: 'idem@pabbly-url.io'}, {idem: 'order-1001'});
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.data).toEqual(first.data);
    expect(await db.contact.count({where: {email: 'idem@pabbly-url.io'}})).toBe(1);
    expect(await db.dataInRequest.count({where: {idempotencyKey: 'order-1001', replayed: true}})).toBe(1);
  });

  it('keeps the signed mode (API key + HMAC) working beside it', async () => {
    const key = (await ok(own.post('/site-api/crm/data-in/keys', {name: 'Website'}), 201)).plain as string;
    const secret = (await ok(own.post('/site-api/crm/data-in/secret/reveal', {}))).secret as string;
    const body = JSON.stringify({email: 'signed@pabbly-url.io'});
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const signed = await hook('POST', `${BASE}/v1/contacts`, {'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-signature': `t=${t},v1=${v1}`}, body);
    expect(signed.status, JSON.stringify(signed.data)).toBe(201);
    // The URL's tokens are no API key, and the signed path takes no token.
    const asBearer = await hook('POST', `${BASE}/v1/contacts`, {'content-type': 'application/json', authorization: `Bearer ${ACCESS}`, 'x-signature': `t=${t},v1=${v1}`}, body);
    expect([asBearer.status, code(asBearer)]).toEqual([401, 'E_UNAUTHORIZED']);
    const tokenOnV1 = await hook('POST', `${BASE}/v1/contacts/${ACCESS}`, {'content-type': 'application/json', 'x-signature-token': SIGNATURE}, body);
    expect(tokenOnV1.status).toBe(404);
  });
});
