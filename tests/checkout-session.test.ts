import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  CheckoutError,
  type CheckoutGateway,
  type CheckoutRequest,
  type CheckoutResult,
  CheckoutSession,
  type CheckoutTransport,
  openCheckout,
  TRIAL_USED_CODE,
} from '../src/lib/checkout-session';

/* A minimal browser: scripts "load" when appended, window.open returns a fake window. */
type FakeWin = {closed: boolean; focus: () => void; close: () => void; url: string};
let opened: FakeWin[] = [];
let assigned: string[] = [];
let scriptsAdded: string[] = [];
let openBlocked = false;
let listeners: Record<string, Array<(e: unknown) => void>> = {};

function installBrowser() {
  opened = [];
  assigned = [];
  scriptsAdded = [];
  openBlocked = false;
  listeners = {};
  const win = {
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 900,
    name: '',
    location: {origin: 'https://shop.example', assign: (u: string) => assigned.push(u)},
    open: (url: string) => {
      if (openBlocked) return null;
      const w: FakeWin = {closed: false, url, focus: () => undefined, close: () => (w.closed = true)};
      opened.push(w);
      return w;
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter(f => f !== fn);
    },
  };
  const doc = {
    createElement: () => {
      const el: {src: string; async: boolean; onload?: () => void; onerror?: () => void; remove: () => void} = {
        src: '',
        async: false,
        remove: () => undefined,
      };
      return el;
    },
    head: {
      appendChild: (el: {src: string; onload?: () => void}) => {
        scriptsAdded.push(el.src);
        queueMicrotask(() => el.onload?.());
      },
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
}

/* The payment provider's popup constructor, as its script would define it. */
const popups: Array<{options: Record<string, any>; opened: boolean}> = [];
class FakePopup {
  constructor(readonly options: Record<string, any>) {}
  open() {
    popups.push({options: this.options, opened: true});
  }
}

const step = {
  element: {kind: 'element', gateway: 'stripe', clientSecret: 'pi_1_secret_x', publishableKey: 'pk_test_1', returnUrl: 'https://shop.example/thanks/?checkout=pcs_1'},
  popup: {
    kind: 'popup',
    gateway: 'razorpay',
    clientCheckout: {
      scriptUrl: 'https://checkout.razorpay.com/v1/checkout.js',
      clientGlobal: 'FakePopup',
      options: {key: 'rzp_test_1', order_id: 'order_1', modal: {}},
      dismissCallback: 'modal.ondismiss',
    },
    returnUrl: 'https://shop.example/thanks/?checkout=pcs_1',
  },
  window: {kind: 'window', gateway: 'xendit', checkoutUrl: 'https://checkout.xendit.co/web/abc', returnUrl: 'https://shop.example/thanks/?checkout=pcs_1'},
} as const;

/** A fake platform: the ways to pay, one checkout per call, and a status we flip. */
function platform(gateways: CheckoutGateway[], answer: keyof typeof step, opts: {trialUsedOnce?: boolean} = {}) {
  const calls: CheckoutRequest[] = [];
  let status = 'open';
  let trialRefused = false;
  const transport: CheckoutTransport = {
    listGateways: async () => gateways,
    createCheckout: async req => {
      calls.push(req);
      if (opts.trialUsedOnce && !req.noTrial && !trialRefused) {
        trialRefused = true;
        throw new CheckoutError('trial used', TRIAL_USED_CODE, 409);
      }
      return {id: `pcs_${calls.length}`, mode: 'test', embedded: step[answer] as CheckoutResult['embedded']};
    },
    getStatus: async () => status,
  };
  return {transport, calls, pay: () => (status = 'paid')};
}

const init = {price: 'pro-monthly', successPath: '/thanks/', cancelPath: '/'};

beforeEach(() => {
  installBrowser();
  popups.length = 0;
  vi.stubGlobal('FakePopup', FakePopup);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checkout session', () => {
  it('auto-selects a lone way to pay and hands an element checkout back to the page', async () => {
    const p = platform([{slug: 'stripe', name: 'Stripe'}], 'element');
    const session = new CheckoutSession(p.transport, init);
    const seen: string[] = [];
    session.subscribe(s => seen.push(s.status));
    expect(seen).toEqual(['idle']); // fires at once
    await session.load();
    expect(session.getState().selectedGateway).toBe('stripe');
    const result = await session.continue();
    expect(p.calls[0]).toMatchObject({price: 'pro-monthly', gateway: 'stripe'});
    expect(result.embedded.kind).toBe('element');
    expect(session.getState().status).toBe('ready');
    expect(opened).toHaveLength(0);
    expect(scriptsAdded).toHaveLength(0);
  });

  it('asks the buyer to choose when there are several, and sends the choice', async () => {
    const p = platform(
      [
        {slug: 'stripe', name: 'Stripe'},
        {slug: 'xendit', name: 'Xendit'},
      ],
      'window'
    );
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    expect(session.getState().selectedGateway).toBeNull();
    await expect(session.continue()).rejects.toThrow(/Choose how/);
    expect(p.calls).toHaveLength(0);
    session.selectGateway('xendit');
    await session.continue();
    expect(p.calls[0]!.gateway).toBe('xendit');
  });

  it('opens a popup with the options copied and the dismiss callback wired; closed → the SAME checkout reopens', async () => {
    const p = platform([{slug: 'razorpay', name: 'Razorpay'}], 'popup');
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    await session.continue();
    expect(scriptsAdded).toEqual(['https://checkout.razorpay.com/v1/checkout.js']);
    expect(popups).toHaveLength(1);
    expect(popups[0]!.options.order_id).toBe('order_1');
    expect(typeof popups[0]!.options.modal.ondismiss).toBe('function');
    // the platform's own options are never changed (a deep copy is used)
    expect((step.popup.clientCheckout.options.modal as Record<string, unknown>).ondismiss).toBeUndefined();
    expect(session.getState().status).toBe('redirecting');

    popups[0]!.options.modal.ondismiss();
    expect(session.getState()).toMatchObject({status: 'ready', closed: 'closed'});

    await session.continue();
    expect(p.calls).toHaveLength(1); // no second checkout
    expect(popups).toHaveLength(2);
    expect(popups[1]!.options.order_id).toBe('order_1');
    expect(scriptsAdded).toHaveLength(1); // the script loads once
  });

  it('refuses a non-https popup script and a dismiss path through unsafe keys', async () => {
    await expect(
      openCheckout({id: 'pcs_1', embedded: {...step.popup, clientCheckout: {...step.popup.clientCheckout, scriptUrl: 'http://x.test/a.js'}}})
    ).rejects.toThrow(/non-HTTPS/);
    await openCheckout({id: 'pcs_1', embedded: {...step.popup, clientCheckout: {...step.popup.clientCheckout, dismissCallback: '__proto__.polluted'}}});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('opens the payment window, polls the status and goes to the thanks page once paid', async () => {
    vi.useFakeTimers();
    const p = platform([{slug: 'xendit', name: 'Xendit'}], 'window');
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    await session.continue();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.url).toBe('https://checkout.xendit.co/web/abc');
    expect(session.getState()).toMatchObject({status: 'redirecting', checkoutUrl: 'https://checkout.xendit.co/web/abc'});

    await vi.advanceTimersByTimeAsync(2600);
    expect(assigned).toHaveLength(0); // still open
    p.pay();
    await vi.advanceTimersByTimeAsync(2600);
    expect(opened[0]!.closed).toBe(true);
    expect(assigned).toEqual(['https://shop.example/thanks/?checkout=pcs_1']);
  });

  it('a payment window closed without paying → back to ready, and Pay reopens the same checkout', async () => {
    vi.useFakeTimers();
    const p = platform([{slug: 'paypal', name: 'PayPal'}], 'window');
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    await session.continue();
    opened[0]!.closed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.getState()).toMatchObject({status: 'ready', closed: 'closed', checkoutUrl: null});
    expect(assigned).toHaveLength(0);
    await session.continue();
    expect(p.calls).toHaveLength(1);
    expect(opened).toHaveLength(2);
  });

  it('a blocked payment window goes to the provider page in this tab', async () => {
    openBlocked = true;
    const p = platform([{slug: 'xendit', name: 'Xendit'}], 'window');
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    await session.continue();
    expect(assigned).toEqual(['https://checkout.xendit.co/web/abc']);
  });

  it('trial already used → asks, then the next continue charges now (noTrial)', async () => {
    const p = platform([{slug: 'stripe', name: 'Stripe'}], 'element', {trialUsedOnce: true});
    const session = new CheckoutSession(p.transport, init);
    await session.load();
    await expect(session.continue()).rejects.toThrow();
    expect(session.getState()).toMatchObject({status: 'ready', trialUsed: true});
    expect(session.getState().error?.code).toBe(TRIAL_USED_CODE);
    await session.continue();
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.noTrial).toBeUndefined();
    expect(p.calls[1]!.noTrial).toBe(true);
  });

  it('starts from a checkout the server already started', async () => {
    const p = platform([], 'window');
    const result: CheckoutResult = {id: 'pcs_srv', embedded: step.window};
    const session = new CheckoutSession(p.transport, {...init, result});
    expect(session.getState()).toMatchObject({status: 'ready', selectedGateway: 'xendit'});
    await session.continue();
    expect(p.calls).toHaveLength(0);
    expect(opened).toHaveLength(1);
    session.cancel();
    expect(opened[0]!.closed).toBe(true);
    expect(session.getState().status).toBe('ready');
  });
});
