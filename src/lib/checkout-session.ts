/**
 * BROWSER: one checkout, from "which way to pay" to "paid", without the buyer leaving this site
 * (docs/agent/payments.md). Framework-free; the same file in the app and the static template.
 *
 *   const session = new CheckoutSession(transport, {price: 'pro-monthly', successPath: '/thanks/', cancelPath: '/'});
 *   const stop = session.subscribe(render);   // fires now, then on every change
 *   await session.load();                     // → state.gateways (a lone one is selected)
 *   session.selectGateway('stripe');          // the buyer picks (only when there are several)
 *   await session.continue();                 // starts the checkout and opens it
 *
 * The platform answers a checkout with ONE step (`result.embedded.kind`):
 *   element  the payment provider's form on the page: `continue()` hands it back (state `ready`
 *            with `result`); mount the form from `result.embedded` (Stripe Payment Element)
 *   popup    the provider's popup over the page: loaded and opened here. Paid → the provider
 *            sends the browser to the thanks page; closed → state `ready`, and the next
 *            `continue()` reopens the SAME checkout
 *   window   the provider's page in a small payment window: this page waits (state
 *            `redirecting`, `checkoutUrl` set), checks the checkout's status and goes to the
 *            thanks page once it is paid; closed without paying → `ready`, nothing charged
 *
 * `transport` is how this site reaches the platform: the app's own `/site-api` routes, or the
 * static site's public endpoints. Nothing here decides an amount or settles a payment: the
 * platform confirms every payment with the payment provider.
 */

/* --------------------------------- types --------------------------------- */

/** What the provider's popup needs (`kind: 'popup'`), prepared by the platform. Never edit it. */
export interface ClientCheckout {
  /** The provider's script (https only). */
  scriptUrl: string;
  /** The constructor the script defines on `window`. */
  clientGlobal: string;
  options: Record<string, unknown>;
  /** Dotted path in `options` for "the buyer closed the popup", or null. */
  dismissCallback: string | null;
}

export type PaymentStep =
  | {kind: 'element'; gateway: string; clientSecret: string; publishableKey: string; gatewayAccountId?: string | null; returnUrl: string; cancelUrl?: string}
  | {kind: 'popup'; gateway: string; clientCheckout: ClientCheckout; returnUrl: string; cancelUrl?: string}
  | {kind: 'window'; gateway: string; checkoutUrl: string; returnUrl: string; cancelUrl?: string};

/** A started checkout: its id (`pcs_…`) and how the buyer pays. */
export interface CheckoutResult {
  id: string;
  mode?: 'test' | 'live';
  embedded: PaymentStep;
}

/** A way to pay the buyer may choose. */
export interface CheckoutGateway {
  slug: string;
  name: string;
}

export interface CheckoutRequest {
  price: string;
  quantity?: number;
  successPath: string;
  cancelPath: string;
  gateway?: string;
  /** The buyer's email. A price with a free trial needs it (`E_SITE_PAYMENTS_EMAIL_REQUIRED`). */
  email?: string;
  /** Charge now, without the price's free trial (after `trial_used`). */
  noTrial?: boolean;
}

/** A refusal from the platform, with its code (`E_SITE_PAYMENTS_TRIAL_USED`…) and a message for people. */
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: string = 'checkout_failed',
    readonly status: number = 0
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

/** How this site reaches the platform. Each call rejects with a `CheckoutError` when refused. */
export interface CheckoutTransport {
  /** The ways to pay the price (active, take its currency, and its trial when it has one). */
  listGateways(price: string): Promise<CheckoutGateway[]>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  /** The checkout's status: `open`, `paid`, `failed`, `expired` (null: unknown right now). */
  getStatus(id: string): Promise<string | null>;
}

export type CheckoutStatus = 'idle' | 'loading' | 'ready' | 'submitting' | 'redirecting' | 'error';

export interface CheckoutState {
  status: CheckoutStatus;
  gateways: CheckoutGateway[];
  selectedGateway: string | null;
  /** The provider's page while the payment window is open (`window`), else null. */
  checkoutUrl: string | null;
  /** The started checkout (kept: a closed popup or window reopens this same one). */
  result: CheckoutResult | null;
  error: CheckoutError | null;
  /** The buyer already had this price's free trial: the next `continue()` charges now. */
  trialUsed: boolean;
  /** Why the buyer is back at `ready` after opening one: they closed it (nothing charged). */
  closed: 'closed' | 'failed' | null;
}

export const TRIAL_USED_CODE = 'E_SITE_PAYMENTS_TRIAL_USED';
export const TRIAL_USED_MESSAGE = "You've already used the free trial for this. Continue to pay now without a trial.";
export const NOT_LOADED = 'The payment window could not be loaded. Check your connection or turn off any content blocker, then try again.';

/* ------------------------------ openCheckout ------------------------------ */

/** The name the payment window gets, so the return page inside it knows where it is. */
export const PAYMENT_WINDOW = 'payment-window';
const MESSAGE = 'payment-window';

const scripts = new Map<string, Promise<void>>();
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function loadScript(src: string): Promise<void> {
  if (!/^https:\/\//.test(src)) return Promise.reject(new CheckoutError('Refusing to load a non-HTTPS checkout script.', 'checkout_unavailable'));
  let loading = scripts.get(src);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scripts.delete(src);
        script.remove();
        reject(new CheckoutError(NOT_LOADED, 'checkout_unavailable'));
      };
      document.head.appendChild(script);
    });
    scripts.set(src, loading);
  }
  return loading;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some(k => !k || UNSAFE_KEYS.has(k))) return;
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    node = (next && typeof next === 'object' ? next : (node[key] = {})) as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

/** The payment window, centred on this one. Null when the browser blocked it. */
export function openPaymentWindow(url: string): Window | null {
  if (!/^https:\/\//.test(url)) return null;
  const width = 480;
  const height = 720;
  const left = Math.max(0, Math.round((window.screenX ?? 0) + ((window.outerWidth ?? width) - width) / 2));
  const top = Math.max(0, Math.round((window.screenY ?? 0) + ((window.outerHeight ?? height) - height) / 2));
  const win = window.open(url, PAYMENT_WINDOW, `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!win) return null;
  try {
    win.focus();
  } catch {
    // Focus refused: the window is open anyway.
  }
  return win;
}

export interface OpenCheckoutOptions {
  /** The buyer closed the popup or the payment window without paying (they stay here). */
  onDismiss?: (reason: 'closed' | 'failed') => void;
  /** The window kind: the checkout's status (polled every 2.5 s, at most 30 minutes). */
  getStatus?: () => Promise<string | null>;
  /** Paid in the payment window. Default: go to `returnUrl`. */
  onPaid?: () => void;
  /** The window kind: called with the open window, so a page can focus or close it. */
  onWindow?: (win: Window, stop: () => void) => void;
}

/** What `openCheckout()` did. `element`: nothing; mount the provider's form from the result. */
export type OpenCheckoutOutcome = 'element' | 'popup' | 'window' | 'redirect';

/**
 * Open a started checkout for the buyer:
 * - popup: load the provider's script (https only, once), `new window[clientGlobal](options)`
 *   with a deep copy of the options and the dismiss callback at its dotted path, `.open()`. A
 *   payment that goes through takes the browser to the return page by itself. Rejects (code
 *   `checkout_unavailable`) when it can't load: show the message, let the buyer try again.
 * - window: the provider's page in a payment window, watched until paid or closed. Blocked by
 *   the browser → this tab goes to the provider's page instead (`redirect`).
 * - element: nothing to open; the caller mounts the provider's form.
 */
export async function openCheckout(result: CheckoutResult, options: OpenCheckoutOptions = {}): Promise<OpenCheckoutOutcome> {
  const step = result.embedded;
  if (typeof document === 'undefined' || typeof window === 'undefined') throw new CheckoutError('openCheckout() must run in a browser.');
  if (step.kind === 'element') return 'element';
  if (step.kind === 'popup') {
    const client = step.clientCheckout;
    await loadScript(client.scriptUrl);
    const Client = (globalThis as unknown as Record<string, unknown>)[client.clientGlobal];
    if (typeof Client !== 'function') throw new CheckoutError('The payment window could not be opened. Try again.', 'checkout_unavailable');
    const gatewayOptions = JSON.parse(JSON.stringify(client.options ?? {})) as Record<string, unknown>;
    if (client.dismissCallback) setPath(gatewayOptions, client.dismissCallback, () => options.onDismiss?.('closed'));
    const instance = new (Client as new (o: Record<string, unknown>) => {open(): void})(gatewayOptions);
    instance.open();
    return 'popup';
  }
  if (step.kind === 'window') {
    const win = openPaymentWindow(step.checkoutUrl);
    if (!win) {
      window.location.assign(step.checkoutUrl);
      return 'redirect';
    }
    const stop = watchPaymentWindow(win, {
      status: options.getStatus ?? (async () => null),
      onPaid: options.onPaid ?? (() => window.location.assign(step.returnUrl)),
      onClosed: reason => options.onDismiss?.(reason),
    });
    options.onWindow?.(win, stop);
    return 'window';
  }
  throw new CheckoutError('This checkout has nothing to open.');
}

/**
 * Wait for the payment window: its status every 2.5 s (at most 30 minutes) and right away when
 * the return page inside it reports back. Paid → closes it, `onPaid`. Failed / expired, or closed
 * without paying (one last look first) → `onClosed`. Returns a stop function.
 */
export function watchPaymentWindow(
  win: Window,
  {status, onPaid, onClosed}: {status: () => Promise<string | null>; onPaid: () => void; onClosed: (reason: 'closed' | 'failed') => void}
): () => void {
  let done = false;
  const started = Date.now();
  const timers: ReturnType<typeof setInterval>[] = [];
  const finish = () => {
    done = true;
    timers.forEach(t => clearInterval(t));
    window.removeEventListener('message', onMessage);
  };
  const check = async (final: boolean) => {
    if (done) return;
    const now = await status().catch(() => null);
    if (done) return;
    if (now === 'paid') {
      finish();
      try {
        win.close();
      } catch {
        // Already closed.
      }
      onPaid();
    } else if (now === 'failed' || now === 'expired') {
      finish();
      onClosed('failed');
    } else if (final) {
      finish();
      onClosed('closed');
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as {type?: string} | null;
    if (!data || data.type !== MESSAGE) return;
    // Back from the provider: check now, then a few more times (it may need a moment).
    void check(false);
    let tries = 0;
    const again = setInterval(() => {
      tries += 1;
      void check(tries >= 6);
      if (tries >= 6 || done) clearInterval(again);
    }, 2000);
    timers.push(again);
  };
  window.addEventListener('message', onMessage);
  timers.push(
    setInterval(() => {
      if (Date.now() - started > 30 * 60_000) {
        finish();
        onClosed('closed');
        return;
      }
      void check(false);
    }, 2500)
  );
  const closedCheck = setInterval(() => {
    let closed = false;
    try {
      closed = win.closed;
    } catch {
      closed = false;
    }
    if (closed) {
      clearInterval(closedCheck);
      setTimeout(() => void check(true), 600);
    }
  }, 1000);
  timers.push(closedCheck);
  return finish;
}

/**
 * On every page (`Base.astro`): a page loaded INSIDE the payment window (the provider sent the
 * buyer back to this site, paid or not) tells the page that opened it, then closes itself. That
 * page checks the checkout's status and goes on.
 */
export function notifyPaymentOpener(): void {
  if (window.name !== PAYMENT_WINDOW || !window.opener) return;
  if (!new URLSearchParams(window.location.search).has('checkout')) return;
  try {
    if ((window.opener as Window).location.origin !== window.location.origin) return;
  } catch {
    return; // Another site opened this window: say nothing.
  }
  try {
    (window.opener as Window).postMessage({type: MESSAGE, result: 'returned', href: window.location.href}, window.location.origin);
  } catch {
    return;
  }
  window.close();
}

/* ---------------------------- CheckoutSession ----------------------------- */

export interface CheckoutSessionInit extends Omit<CheckoutRequest, 'gateway' | 'noTrial'> {
  /** Pre-select a way to pay. */
  gateway?: string;
  /** A checkout the server already started (the app's `/checkout/?id=` page). */
  result?: CheckoutResult | null;
  /** Open the checkout on `continue()` (default true). */
  autoOpen?: boolean;
  /** Paid in the payment window. Default: go to the result's `returnUrl`. */
  onPaid?: (result: CheckoutResult) => void;
}

type Listener = (state: CheckoutState) => void;

const asError = (err: unknown): CheckoutError =>
  err instanceof CheckoutError ? err : new CheckoutError(err instanceof Error && err.message ? err.message : 'Checkout did not open. Try again.');

export class CheckoutSession {
  private state: CheckoutState;
  private readonly listeners = new Set<Listener>();
  private win: Window | null = null;
  private stopWatch: (() => void) | null = null;

  constructor(
    private readonly transport: CheckoutTransport,
    private readonly init: CheckoutSessionInit
  ) {
    this.state = {
      status: init.result ? 'ready' : 'idle',
      gateways: [],
      selectedGateway: init.result?.embedded.gateway ?? init.gateway ?? null,
      checkoutUrl: null,
      result: init.result ?? null,
      error: null,
      trialUsed: false,
      closed: null,
    };
  }

  getState(): Readonly<CheckoutState> {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The ways to pay this price. A lone one is selected. */
  async load(): Promise<CheckoutGateway[]> {
    this.patch({status: 'loading', error: null});
    try {
      const gateways = await this.transport.listGateways(this.init.price);
      const keep = gateways.some(g => g.slug === this.state.selectedGateway) ? this.state.selectedGateway : null;
      this.patch({status: 'ready', gateways, selectedGateway: keep ?? (gateways.length === 1 ? gateways[0]!.slug : null)});
      return gateways;
    } catch (err) {
      this.patch({status: 'error', error: asError(err)});
      throw err;
    }
  }

  /** The buyer's choice. A different one forgets a started checkout (a new one starts). */
  selectGateway(slug: string): void {
    if (slug === this.state.selectedGateway) return;
    this.patch({selectedGateway: slug, result: this.state.result?.embedded.gateway === slug ? this.state.result : null, error: null, closed: null});
  }

  /**
   * Start the checkout (once: a closed popup or window reopens the SAME one) and open it. Needs a
   * selected way to pay when there are several. After `trial_used`, the next call charges now.
   */
  async continue(): Promise<CheckoutResult> {
    const {gateways, selectedGateway} = this.state;
    if (!this.state.result && gateways.length > 1 && !selectedGateway) {
      const error = new CheckoutError('Choose how you want to pay.', 'gateway_required');
      this.patch({status: 'error', error});
      throw error;
    }
    let result = this.state.result;
    if (!result) {
      this.patch({status: 'submitting', error: null, closed: null});
      try {
        result = await this.transport.createCheckout({
          price: this.init.price,
          quantity: this.init.quantity,
          successPath: this.init.successPath,
          cancelPath: this.init.cancelPath,
          ...(selectedGateway ? {gateway: selectedGateway} : {}),
          ...(this.state.trialUsed ? {noTrial: true} : {}),
        });
      } catch (err) {
        const error = asError(err);
        if (error.code === TRIAL_USED_CODE) {
          this.patch({status: 'ready', trialUsed: true, error: new CheckoutError(TRIAL_USED_MESSAGE, TRIAL_USED_CODE, error.status)});
        } else this.patch({status: 'error', error});
        throw error;
      }
      this.patch({result, selectedGateway: result.embedded.gateway ?? selectedGateway});
    }
    if (this.init.autoOpen === false) {
      this.patch({status: 'ready'});
      return result;
    }
    await this.open(result);
    return result;
  }

  /** Open (or reopen) the started checkout. */
  async open(result = this.state.result): Promise<void> {
    if (!result) return;
    const step = result.embedded;
    if (step.kind === 'element') {
      this.patch({status: 'ready', error: null, closed: null});
      return;
    }
    if (step.kind === 'window' && this.win && !this.win.closed) {
      try {
        this.win.focus();
        return;
      } catch {
        // Open it again below.
      }
    }
    this.patch({status: 'redirecting', error: null, closed: null, checkoutUrl: step.kind === 'window' ? step.checkoutUrl : null});
    try {
      this.stopWatch?.();
      const outcome = await openCheckout(result, {
        getStatus: () => this.transport.getStatus(result.id),
        onPaid: () => (this.init.onPaid ? this.init.onPaid(result) : window.location.assign(step.returnUrl)),
        onDismiss: reason => {
          this.win = null;
          this.stopWatch = null;
          this.patch({status: 'ready', checkoutUrl: null, closed: reason});
        },
        onWindow: (win, stop) => {
          this.win = win;
          this.stopWatch = stop;
        },
      });
      if (outcome === 'redirect') this.patch({status: 'redirecting'});
    } catch (err) {
      this.patch({status: 'error', checkoutUrl: null, error: asError(err)});
      throw err;
    }
  }

  /** Close the payment window and stop waiting: back to `ready`, nothing charged. */
  cancel(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    try {
      this.win?.close();
    } catch {
      // Already closed.
    }
    this.win = null;
    if (this.state.status === 'redirecting') this.patch({status: 'ready', checkoutUrl: null, closed: 'closed'});
  }

  private patch(partial: Partial<CheckoutState>): void {
    this.state = {...this.state, ...partial};
    for (const listener of this.listeners) listener(this.state);
  }
}
