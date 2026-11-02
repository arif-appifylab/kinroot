import {createHmac} from 'node:crypto';

import {env} from 'cloudflare:workers';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  allowEmbeddedCheckout,
  definePaymentHooks,
  grantsAccess,
  handlePaymentDelivery,
  isPaymentDelivery,
  isSitePath,
  type PaymentEventInfo,
} from '../src/platform/payments';

const SECRET = 'jobs-secret-for-tests-0123456789abcdef';
const URL_ = 'https://shop.example/site-api/_platform/payments';

/** What the platform sends: the same signature as a job delivery. */
function delivery(body: unknown, {secret = SECRET, at = Math.floor(Date.now() / 1000)} = {}) {
  const text = JSON.stringify(body);
  const mac = createHmac('sha256', secret).update(`${at}.${text}`).digest('hex');
  return new Request(URL_, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-site-signature': `t=${at},v1=${mac}`},
    body: text,
  });
}

let seq = 0;
const checkout = (over: Record<string, unknown> = {}) => ({
  id: `pcs_test${String(seq).padStart(8, '0')}`,
  mode: 'test',
  status: 'paid',
  price: 'pro-monthly',
  quantity: 1,
  email: 'ana@example.com',
  amountCents: 1999,
  currency: 'USD',
  paidAt: new Date().toISOString(),
  subscription: null,
  metadata: {},
  customerRef: '7',
  ...over,
});
const event = (type: string, data: unknown) => ({id: `pev_x${seq++}`, type, mode: 'test', createdAt: new Date().toISOString(), data});

describe('payments: events from the platform', () => {
  beforeEach(() => {
    (env as Record<string, string>).SITE_JOBS_SECRET = SECRET;
  });
  afterEach(() => {
    delete (env as Record<string, string | undefined>).SITE_JOBS_SECRET;
  });

  it('calls the hook for each event type with the data and the event', async () => {
    const seen: Array<[string, unknown, PaymentEventInfo]> = [];
    const hooks = definePaymentHooks({
      onCheckoutPaid: (data, info) => void seen.push(['paid', data, info]),
      onCheckoutFailed: (data, info) => void seen.push(['failed', data, info]),
      onMembershipChanged: (data, info) => void seen.push(['membership', data, info]),
      onRefund: (data, info) => void seen.push(['refund', data, info]),
    });
    const paid = checkout();
    expect((await handlePaymentDelivery(delivery(event('checkout.paid', paid)), hooks)).status).toBe(200);
    expect((await handlePaymentDelivery(delivery(event('checkout.failed', checkout({status: 'failed'}))), hooks)).status).toBe(200);
    const sub = {id: 'sub_1', price: 'club', email: null, status: 'canceled', currentPeriodEnd: null, accessEndsAt: '2030-01-01T00:00:00Z', customerRef: null, checkoutId: null};
    expect((await handlePaymentDelivery(delivery(event('membership.canceled', sub)), hooks)).status).toBe(200);
    const refund = {checkoutId: paid.id, amountCents: 1999, currency: 'USD', full: true, refundedAt: new Date().toISOString()};
    expect((await handlePaymentDelivery(delivery(event('payment.refunded', refund)), hooks)).status).toBe(200);
    expect(seen.map(([kind]) => kind)).toEqual(['paid', 'failed', 'membership', 'refund']);
    expect(seen[0]![1]).toEqual(paid);
    expect(seen[2]![2]).toMatchObject({type: 'membership.canceled', mode: 'test', source: 'event'});
  });

  it('refuses a wrong secret, a changed body and an old timestamp (401)', async () => {
    let runs = 0;
    const hooks = definePaymentHooks({onCheckoutPaid: () => void runs++});
    const body = event('checkout.paid', checkout());
    expect((await handlePaymentDelivery(delivery(body, {secret: 'other'}), hooks)).status).toBe(401);
    expect((await handlePaymentDelivery(delivery(body, {at: Math.floor(Date.now() / 1000) - 3600}), hooks)).status).toBe(401);
    const signed = delivery(body);
    const tampered = new Request(URL_, {method: 'POST', headers: signed.headers, body: JSON.stringify({...body, data: checkout({amountCents: 1})})});
    const res = await handlePaymentDelivery(tampered, hooks);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({code: 'bad_signature'});
    expect(runs).toBe(0);
  });

  it('runs an event once: a retry or a replayed copy of a handled event is a duplicate', async () => {
    let runs = 0;
    const hooks = definePaymentHooks({onCheckoutPaid: () => void runs++});
    const once = event('checkout.paid', checkout());
    expect((await handlePaymentDelivery(delivery(once), hooks)).status).toBe(200);
    const replay = await handlePaymentDelivery(delivery(once), hooks);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({duplicate: true});
    expect(runs).toBe(1);
  });

  it('a hook that throws answers 500 and runs again on the retry (not marked handled)', async () => {
    let runs = 0;
    const hooks = definePaymentHooks({
      onCheckoutPaid: () => {
        runs++;
        if (runs === 1) throw new Error('Database busy');
      },
    });
    const body = event('checkout.paid', checkout());
    const first = await handlePaymentDelivery(delivery(body), hooks);
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({error: 'Database busy'});
    expect((await handlePaymentDelivery(delivery(body), hooks)).status).toBe(200);
    expect(runs).toBe(2);
  });

  it('a type with no hook (or a newer type) is done, not retried', async () => {
    const res = await handlePaymentDelivery(delivery(event('payment.disputed', {id: 'x'})), definePaymentHooks({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ignored: true});
  });

  it('a signed but malformed body is a 400, never a 500', async () => {
    let runs = 0;
    const hooks = definePaymentHooks({onCheckoutPaid: () => void runs++, onMembershipChanged: () => void runs++});
    for (const body of [
      null,
      [],
      'checkout.paid',
      {type: 'checkout.paid', mode: 'test', data: checkout()},
      {...event('checkout.paid', checkout()), mode: 'prod'},
      event('checkout.paid', null),
      event('checkout.paid', {id: 'pcs_x'}),
      event('membership.started', {id: 'sub_1'}),
      {...event('checkout.paid', checkout()), id: 'bad id with spaces'},
    ]) {
      expect((await handlePaymentDelivery(delivery(body), hooks)).status).toBe(400);
    }
    expect(runs).toBe(0);
  });

  it('refuses GET, a body over 64 KB, and answers 503 without its secret', async () => {
    const hooks = definePaymentHooks({});
    expect((await handlePaymentDelivery(new Request(URL_), hooks)).status).toBe(405);
    const big = new Uint8Array(70 * 1024).fill(32);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    expect((await handlePaymentDelivery(new Request(URL_, {method: 'POST', body: stream, duplex: 'half'} as RequestInit), hooks)).status).toBe(413);
    delete (env as Record<string, string | undefined>).SITE_JOBS_SECRET;
    expect((await handlePaymentDelivery(delivery(event('checkout.paid', checkout())), hooks)).status).toBe(503);
  });

  it('only owns its one path', () => {
    expect(isPaymentDelivery(URL_)).toBe(true);
    expect(isPaymentDelivery('https://shop.example/site-api/_platform/jobs')).toBe(false);
    expect(isPaymentDelivery('https://shop.example/site-api/checkout')).toBe(false);
  });
});

describe('payments: helpers', () => {
  it('return paths stay on the site', () => {
    expect(isSitePath('/thanks/')).toBe(true);
    expect(isSitePath('/thanks/?x=1')).toBe(true);
    for (const bad of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'thanks', '/a b', '']) {
      expect(isSitePath(bad)).toBe(false);
    }
  });

  it('access: active, trialing and past due open; cancelled until access ends', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(grantsAccess('active', null, now)).toBe(true);
    expect(grantsAccess('trialing', null, now)).toBe(true);
    expect(grantsAccess('past_due', null, now)).toBe(true);
    expect(grantsAccess('canceled', '2030-02-01T00:00:00Z', now)).toBe(true);
    expect(grantsAccess('canceled', '2029-12-01T00:00:00Z', now)).toBe(false);
    expect(grantsAccess('canceled', null, now)).toBe(false);
  });

  it('adds a gateway’s hosts to one page’s CSP, keeping self', () => {
    const scripts: string[] = [];
    const directives: string[] = [];
    const csp = {insertScriptResource: (r: string) => void scripts.push(r), insertDirective: (d: string) => void directives.push(d)};
    allowEmbeddedCheckout(csp, 'stripe');
    expect(scripts).toEqual(["'self'", 'https://js.stripe.com', 'https://*.js.stripe.com']);
    expect(directives.find(d => d.startsWith('connect-src'))).toMatch(/^connect-src 'self' https:\/\/api\.stripe\.com/);
    expect(directives.find(d => d.startsWith('frame-src'))).toContain('https://js.stripe.com');
    scripts.length = 0;
    allowEmbeddedCheckout(csp, 'constructor');
    expect(scripts).toEqual([]);
  });
});
