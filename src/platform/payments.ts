import {PLATFORM_HEADERS, platformOrigin, SiteKeyMissing} from './api';
import {json, readCapped, signatureOk, tableMissing} from './background';
import {config} from './config';
import {getDb} from './db';

/**
 * PAYMENTS: take money for what this site sells. MANAGED: never edit.
 * Guide: docs/agent/payments.md.
 *
 * The platform runs the payment account, the checkout and the gateway; this site never sees a
 * card or a gateway key. Every call here carries the Site Key, so it is SERVER code only.
 *
 *   Prices          listPrices()      the site's catalogue (and which mode it is in)
 *                   createPrice()     add one (the editor key only: the Preview, your machine)
 *   Checkout        listGateways()    the ways to pay a price (the buyer chooses when > 1)
 *                   createCheckout()  start one for a price key → how the buyer pays (`embedded`)
 *                   getCheckout()     what happened (the thanks page confirms with it)
 *   Memberships     memberships()     a buyer's subscriptions
 *                   cancelMembership()
 *   Events          handlePaymentDelivery()  POST /site-api/_platform/payments (signed), calls
 *                                            the hooks in src/server/payments-hooks.ts
 *
 * MODES. The site code never chooses one. The editor's key (the Preview, a local copy) is always
 * `test` (sandbox). The live site is `live` once the owner connects a live gateway, `test` until
 * then (show `TestModeBadge`). Prices are referenced by their `key`, never by an amount: the
 * platform charges the catalogue's amount whatever the browser sends.
 *
 * Every function resolves to `{ok: true, data}` or `{ok: false, status, code, message}`; it never
 * throws into a page (except SiteKeyMissing: no Site Key on this machine). Show `message` to
 * people; branch on `code`.
 */

export type PaymentMode = 'test' | 'live';
export type PriceInterval = 'one_time' | 'month' | 'year';

export interface Price {
  /** The slug code uses (`pro-monthly`). Stable; a new amount is a new key. */
  key: string;
  name: string;
  description: string | null;
  /** Minor units (1999 = 19.99). */
  amountCents: number;
  /** ISO 4217, upper case. */
  currency: string;
  interval: PriceInterval;
  intervalCount: number;
  trialDays: number;
}

export interface Catalogue {
  mode: PaymentMode;
  /** False until the account for this mode can take a payment (checkouts answer E_PAYMENTS_NOT_READY). */
  ready: boolean;
  prices: Price[];
}

export interface PriceInput {
  key: string;
  name: string;
  description?: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval;
  intervalCount?: number;
  trialDays?: number;
}

export interface CheckoutInput {
  /** A price `key` from the catalogue. */
  price: string;
  /** 1 to 99 (default 1). Subscriptions are always 1. */
  quantity?: number;
  /** Fills the checkout's email field (a signed-in buyer: their own address). */
  email?: string;
  name?: string;
  /** Paths on this site (`/thanks/`), never a URL. The platform adds `checkout=<id>` to their query. */
  successPath: string;
  cancelPath: string;
  /** Up to 20 string pairs you get back on the checkout and in events (an order id, a plan note). */
  metadata?: Record<string, string>;
  /** Your own reference for the buyer (the signed-in user's id). Comes back on checkouts and memberships. */
  customerRef?: string;
  /** The way to pay the buyer chose (a `slug` from `listGateways`). Omitted: the platform picks. */
  gateway?: string;
  /** Charge now, without the price's free trial (after `E_SITE_PAYMENTS_TRIAL_USED`). */
  noTrial?: boolean;
  /**
   * This purchase attempt (16 to 64 letters, digits, - or _): the same key again is the same
   * checkout, or `paid: true` once it's paid. Never a second one. Omitted with a `customerRef`:
   * made from the buyer and the purchase, the same for 2 minutes.
   */
  idempotencyKey?: string;
}

/** What the payment provider's popup needs (`kind: 'popup'`): `src/lib/checkout-session.ts` opens it. */
export interface ClientCheckout {
  scriptUrl: string;
  clientGlobal: string;
  options: Record<string, unknown>;
  dismissCallback: string | null;
}

/**
 * How the buyer pays, without leaving this site: mount `EmbeddedCheckout` with it.
 *   element  the provider's form in the page (`clientSecret` + `publishableKey`)
 *   popup    the provider's popup over the page (`clientCheckout`)
 *   window   the provider's page in a small payment window (`checkoutUrl`)
 * `returnUrl` / `cancelUrl`: the success / cancel path, on this site, with `checkout=<id>`.
 */
export type EmbeddedCheckout =
  | {kind: 'element'; gateway: string; clientSecret: string; publishableKey: string; gatewayAccountId?: string | null; returnUrl: string; cancelUrl?: string}
  | {kind: 'popup'; gateway: string; clientCheckout: ClientCheckout; returnUrl: string; cancelUrl?: string}
  | {kind: 'window'; gateway: string; checkoutUrl: string; returnUrl: string; cancelUrl?: string};

export interface CreatedCheckout {
  id: string;
  mode: PaymentMode;
  /** How the buyer pays: mount `EmbeddedCheckout` with it. Null only with `paid`. */
  embedded: EmbeddedCheckout;
  /** This `idempotencyKey` has already been paid: send the buyer to the thanks page, nothing was started. */
  paid?: true;
}

/** A way to pay the buyer may choose (`listGateways`). */
export interface PaymentGateway {
  slug: string;
  name: string;
}

export interface CheckoutSubscription {
  id: string;
  status: MembershipStatus;
  currentPeriodEnd: string | null;
  accessEndsAt: string | null;
}

export interface Checkout {
  id: string;
  mode: PaymentMode;
  status: 'open' | 'paid' | 'failed' | 'expired';
  /** The price key. */
  price: string;
  quantity: number;
  email: string | null;
  amountCents: number;
  currency: string;
  paidAt: string | null;
  subscription: CheckoutSubscription | null;
  metadata: Record<string, string>;
  customerRef: string | null;
  /** While `open`: how the buyer pays (mount `EmbeddedCheckout` with it again). */
  embedded?: EmbeddedCheckout | null;
}

export type MembershipStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export interface PlatformMembership {
  /** The subscription id. */
  id: string;
  /** The price key. */
  price: string;
  email: string | null;
  status: MembershipStatus;
  currentPeriodEnd: string | null;
  /** Set once it is cancelled: access lasts until then. */
  accessEndsAt: string | null;
  customerRef: string | null;
  /** The checkout that started it. */
  checkoutId: string | null;
}

export interface Refund {
  checkoutId: string;
  amountCents: number;
  currency: string;
  /** The whole payment was refunded. */
  full: boolean;
  refundedAt: string;
}

export type PaymentResult<T> = {ok: true; data: T} | {ok: false; status: number; code: string; message: string};

const TIMEOUT_MS = 8000;
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const CHECKOUT_ID = /^pcs_[A-Za-z0-9]{8,64}$/;
const SUB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

const refused = (code: string, message: string, status = 422): PaymentResult<never> => ({ok: false, status, code, message});

async function call<T>(requestUrl: string | URL, method: 'GET' | 'POST', path: string, body?: unknown): Promise<PaymentResult<T>> {
  const key = config.siteKey;
  if (!key) throw new SiteKeyMissing();
  let res: Response;
  try {
    res = await fetch(`${platformOrigin(requestUrl)}/api/site/v1/payments${path}`, {
      method,
      headers: {
        ...PLATFORM_HEADERS,
        authorization: `Bearer ${key}`,
        ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
      },
      ...(method === 'POST' ? {body: JSON.stringify(body ?? {})} : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return refused('E_PLATFORM_UNREACHABLE', 'Payments did not answer. Try again.', 0);
  }
  const answer = (await res.json().catch(() => null)) as {data?: T; errors?: Array<{code?: string; message?: string}>} | null;
  if (res.ok && answer?.data !== undefined) return {ok: true, data: answer.data};
  const error = answer?.errors?.[0];
  return refused(error?.code ?? `HTTP_${res.status}`, error?.message ?? 'Payments could not do that. Try again.', res.status);
}

/** A same-site path (`/thanks/`), never a URL, `//host` or a backslash trick. */
export function isSitePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !/[\\\s]/.test(value)
  );
}

/* ------------------------------- catalogue ------------------------------ */

const CATALOGUE_CACHE = new Map<string, {at: number; value: Catalogue}>();

/**
 * The catalogue: `{mode, ready, prices}`. `ttlSeconds` > 0 serves a recent answer from this
 * isolate's memory (the catalogue is the same for every visitor); failures are never kept.
 */
export async function listPrices(requestUrl: string | URL, {ttlSeconds = 0}: {ttlSeconds?: number} = {}): Promise<PaymentResult<Catalogue>> {
  const cacheKey = platformOrigin(requestUrl);
  const hit = ttlSeconds > 0 ? CATALOGUE_CACHE.get(cacheKey) : undefined;
  if (hit && Date.now() - hit.at < ttlSeconds * 1000) return {ok: true, data: hit.value};
  const res = await call<Catalogue>(requestUrl, 'GET', '');
  if (res.ok) {
    if (CATALOGUE_CACHE.size >= 20) CATALOGUE_CACHE.clear();
    CATALOGUE_CACHE.set(cacheKey, {at: Date.now(), value: res.data});
  }
  return res;
}

/** One price by key, from the catalogue (null when there is no such active price). */
export async function findPrice(requestUrl: string | URL, key: string): Promise<PaymentResult<Price | null>> {
  const res = await listPrices(requestUrl, {ttlSeconds: 30});
  return res.ok ? {ok: true, data: res.data.prices.find(price => price.key === key) ?? null} : res;
}

/**
 * Add a price to the catalogue, in SANDBOX. Only the editor's key may (the Preview, a local
 * copy); the live site answers `E_PAYMENTS_EDITOR_ONLY`. Idempotent on `key`: the same key with
 * the same amount, currency and interval answers the existing price; a different amount is
 * `E_PRICE_KEY_TAKEN` (amounts never change: make a new key). Prices reach the live account by
 * themselves the first time it is used.
 */
export async function createPrice(requestUrl: string | URL, input: PriceInput): Promise<PaymentResult<Price>> {
  if (!KEY.test(input.key ?? '')) return refused('E_PRICE_KEY', 'A price key is lower-case letters, digits and dashes (`pro-monthly`).');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) return refused('E_PRICE_NAME', 'A price name needs 1 to 120 characters.');
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 99_999_999) {
    return refused('E_PRICE_AMOUNT', 'amountCents is a whole number of minor units (1999 = 19.99).');
  }
  const currency = String(input.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return refused('E_PRICE_CURRENCY', 'currency is a 3-letter ISO code (USD).');
  if (!['one_time', 'month', 'year'].includes(input.interval)) return refused('E_PRICE_INTERVAL', 'interval is one_time, month or year.');
  const res = await call<{price: Price}>(requestUrl, 'POST', '/prices', {...input, name, currency});
  if (res.ok) {
    CATALOGUE_CACHE.clear();
    return {ok: true, data: res.data.price};
  }
  if (res.status === 403) {
    return refused(
      'E_PAYMENTS_EDITOR_ONLY',
      'Prices are created from the editor (sandbox) or in the dashboard’s Payments tab, never by the live site.',
      403
    );
  }
  return res;
}

/* -------------------------------- checkout ------------------------------- */

const GATEWAY = /^[a-z0-9_-]{1,40}$/;

/**
 * The ways to pay one price: the active payment providers that take its currency (and its free
 * trial, when it has one). More than one → let the buyer choose, then pass its `slug` as
 * `gateway` to `createCheckout`.
 */
export async function listGateways(requestUrl: string | URL, price: string): Promise<PaymentResult<PaymentGateway[]>> {
  if (!KEY.test(price ?? '')) return refused('E_PRICE_KEY', 'Unknown price.');
  const res = await call<{gateways: PaymentGateway[]}>(requestUrl, 'GET', `/checkout/gateways?price=${encodeURIComponent(price)}`);
  if (!res.ok) return res;
  const list = Array.isArray(res.data.gateways) ? res.data.gateways : [];
  return {ok: true, data: list.filter(g => g && GATEWAY.test(g.slug) && typeof g.name === 'string')};
}

/** A key for an attempt with no key of its own: the same parts in the same 2 minutes are the same key. */
export async function checkoutAttemptKey(parts: unknown[], now: number = Date.now()): Promise<string> {
  const text = new TextEncoder().encode(JSON.stringify([...parts, Math.floor(now / 120_000)]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', text));
  return Array.from(hash.slice(0, 24), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Start a checkout for one price. Answers `embedded`: how the buyer pays without leaving this
 * site (mount `EmbeddedCheckout`). The amount is the catalogue's, never yours. 409
 * `E_SITE_PAYMENTS_TRIAL_USED`: this buyer already had the price's free trial; ask them, then
 * call again with `noTrial: true`.
 */
export async function createCheckout(requestUrl: string | URL, input: CheckoutInput): Promise<PaymentResult<CreatedCheckout>> {
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    return refused('E_IDEMPOTENCY_KEY', 'idempotencyKey is 16 to 64 letters, digits, - or _.');
  }
  if (!KEY.test(input.price ?? '')) return refused('E_PRICE_KEY', 'Unknown price.');
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return refused('E_QUANTITY', 'Quantity is 1 to 99.');
  if (!isSitePath(input.successPath) || !isSitePath(input.cancelPath)) {
    return refused('E_RETURN_PATH', 'successPath and cancelPath are paths on this site (`/thanks/`).');
  }
  if (input.email !== undefined && !EMAIL.test(input.email)) return refused('E_EMAIL', 'That email address does not look right.');
  if (input.name !== undefined && input.name.length > 120) return refused('E_NAME', 'A name has at most 120 characters.');
  if (input.customerRef !== undefined && (typeof input.customerRef !== 'string' || input.customerRef.length > 64)) {
    return refused('E_CUSTOMER_REF', 'customerRef is a string of at most 64 characters.');
  }
  const metadata = input.metadata ?? {};
  const pairs = Object.entries(metadata);
  if (pairs.length > 20 || pairs.some(([k, v]) => typeof v !== 'string' || k.length > 40 || v.length > 500)) {
    return refused('E_METADATA', 'metadata is up to 20 string pairs (keys ≤ 40, values ≤ 500 characters).');
  }
  if (input.gateway !== undefined && !GATEWAY.test(input.gateway)) return refused('E_GATEWAY', 'Unknown way to pay.');
  const {noTrial, ...rest} = input;
  const idempotencyKey =
    input.idempotencyKey ??
    (input.customerRef
      ? await checkoutAttemptKey([input.customerRef, input.price, quantity, input.gateway ?? null, !!noTrial, metadata])
      : undefined);
  return call<CreatedCheckout>(requestUrl, 'POST', '/checkout', {
    ...rest,
    quantity,
    metadata,
    ...(noTrial ? {noTrial: true} : {}),
    ...(idempotencyKey ? {idempotencyKey} : {}),
  });
}

/** One checkout by id (`pcs_…`): status, amount, subscription. Works in the Preview (no events there). */
export async function getCheckout(requestUrl: string | URL, id: string): Promise<PaymentResult<Checkout>> {
  if (!CHECKOUT_ID.test(id)) return refused('E_NOT_FOUND', 'No such checkout.', 404);
  return call<Checkout>(requestUrl, 'GET', `/checkout/${encodeURIComponent(id)}`);
}

/** A checkout's subscription as a membership (what the hooks get), or null for a one-time price. */
export function membershipOf(checkout: Checkout): PlatformMembership | null {
  const sub = checkout.subscription;
  if (!sub) return null;
  return {
    id: sub.id,
    price: checkout.price,
    email: checkout.email,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    accessEndsAt: sub.accessEndsAt,
    customerRef: checkout.customerRef,
    checkoutId: checkout.id,
  };
}

/* ------------------------------ memberships ------------------------------ */

/** A buyer's memberships (subscriptions), by the email they paid with. */
export async function memberships(requestUrl: string | URL, email: string): Promise<PaymentResult<PlatformMembership[]>> {
  if (!EMAIL.test(email)) return refused('E_EMAIL', 'That email address does not look right.');
  const res = await call<{memberships: PlatformMembership[]}>(requestUrl, 'GET', `/memberships?email=${encodeURIComponent(email.toLowerCase())}`);
  return res.ok ? {ok: true, data: res.data.memberships ?? []} : res;
}

/**
 * Cancel a membership. `atPeriodEnd` (the default) keeps access until the paid period ends;
 * false ends it now. Check FIRST that it belongs to the signed-in member (your own table).
 */
export async function cancelMembership(
  requestUrl: string | URL,
  id: string,
  atPeriodEnd = true
): Promise<PaymentResult<PlatformMembership>> {
  if (!SUB_ID.test(id)) return refused('E_NOT_FOUND', 'No such membership.', 404);
  const res = await call<{membership: PlatformMembership}>(requestUrl, 'POST', `/memberships/${encodeURIComponent(id)}/cancel`, {atPeriodEnd});
  return res.ok ? {ok: true, data: res.data.membership} : res;
}

/** A membership status that still opens member pages (a cancelled one until `accessEndsAt`). */
export function grantsAccess(status: string, accessEndsAt: Date | string | null, now = Date.now()): boolean {
  if (status === 'active' || status === 'trialing' || status === 'past_due') return true;
  if (!accessEndsAt) return false;
  return new Date(accessEndsAt).getTime() > now;
}

/* ------------------------------- embedding ------------------------------- */

/**
 * The hosts the embedded payment form needs, per gateway. `allowEmbeddedCheckout(Astro.csp,
 * gateway)` adds them to THIS page's Content-Security-Policy only (the rest of the site keeps
 * `connect-src 'self'`). Call it in the frontmatter of the page that mounts `EmbeddedCheckout`.
 */
export const CHECKOUT_HOSTS = {
  stripe: {
    script: ['https://js.stripe.com', 'https://*.js.stripe.com'],
    frame: ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com'],
    connect: ['https://api.stripe.com', 'https://merchant-ui-api.stripe.com'],
  },
  razorpay: {
    script: ['https://checkout.razorpay.com'],
    frame: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
    connect: ['https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
  },
} as const;

interface CspApi {
  insertDirective: (directive: string) => void;
  insertScriptResource: (resource: string) => void;
}

export function allowEmbeddedCheckout(csp: CspApi | undefined, gateway: string): void {
  if (!csp || !Object.hasOwn(CHECKOUT_HOSTS, gateway)) return;
  const hosts = CHECKOUT_HOSTS[gateway as keyof typeof CHECKOUT_HOSTS];
  // A script resource replaces Astro's default `'self'`: keep it.
  csp.insertScriptResource("'self'");
  for (const host of hosts.script) csp.insertScriptResource(host);
  csp.insertDirective(`frame-src ${hosts.frame.join(' ')}`);
  csp.insertDirective(`connect-src 'self' ${hosts.connect.join(' ')}`);
}

/* ------------------------------- delivery -------------------------------- */

export const PAYMENT_DELIVERY_PATH = '/site-api/_platform/payments';
const MAX_BODY_BYTES = 64 * 1024;
const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_ROWS_KEPT_MS = 90 * 24 * 60 * 60 * 1000;

export type PaymentEventType =
  | 'checkout.paid'
  | 'checkout.failed'
  | 'membership.started'
  | 'membership.renewed'
  | 'membership.past_due'
  | 'membership.canceled'
  | 'payment.refunded';

export interface PaymentEventInfo {
  /** The event id: the same on every retry of one event. */
  id: string;
  type: PaymentEventType;
  mode: PaymentMode;
  createdAt: string;
  /** `event` = pushed by the platform; `confirm` = the thanks page confirmed the checkout itself. */
  source: 'event' | 'confirm';
}

/**
 * Your code for what happens when money moves (`src/server/payments-hooks.ts`). Each may run
 * MORE THAN ONCE for one payment (a retried event, or the event and the thanks page's confirm):
 * make it safe to repeat. Throw to have the event tried again later.
 */
export interface PaymentHooks {
  onCheckoutPaid?: (checkout: Checkout, event: PaymentEventInfo) => unknown | Promise<unknown>;
  onCheckoutFailed?: (checkout: Checkout, event: PaymentEventInfo) => unknown | Promise<unknown>;
  /** `event.type` says which: started, renewed, past_due, canceled. */
  onMembershipChanged?: (membership: PlatformMembership, event: PaymentEventInfo) => unknown | Promise<unknown>;
  onRefund?: (refund: Refund, event: PaymentEventInfo) => unknown | Promise<unknown>;
}

export function definePaymentHooks(hooks: PaymentHooks): Readonly<PaymentHooks> {
  return Object.freeze({...hooks});
}

export function isPaymentDelivery(url: string | URL): boolean {
  return new URL(url).pathname === PAYMENT_DELIVERY_PATH;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Events already handled (by id), kept in the managed `payment_events` table. Raw SQL on purpose (background.ts says why). */
async function alreadyHandled(id: string): Promise<boolean> {
  const db = getDb();
  if (db) {
    try {
      const rows = await db.$queryRaw<Array<{id: string}>>`SELECT "id" FROM "payment_events" WHERE "id" = ${id} LIMIT 1`;
      return rows.length > 0;
    } catch (error) {
      if (!tableMissing(error)) throw error;
    }
  }
  return handledInMemory.has(id);
}

async function markHandled(id: string, type: string): Promise<void> {
  const db = getDb();
  if (db) {
    try {
      await db.$executeRaw`INSERT INTO "payment_events" ("id", "type") VALUES (${id}, ${type}) ON CONFLICT DO NOTHING`;
      if (Math.random() < 0.02) {
        await db.$executeRaw`DELETE FROM "payment_events" WHERE "received_at" < ${new Date(Date.now() - EVENT_ROWS_KEPT_MS)}`;
      }
      return;
    } catch (error) {
      if (!tableMissing(error)) throw error;
    }
  }
  if (handledInMemory.size >= 5000) handledInMemory.clear();
  handledInMemory.add(id);
}

const handledInMemory = new Set<string>();
/** Events running in this isolate now: a copy arriving meanwhile waits for the retry. */
const running = new Set<string>();

/** What a delivery's `data` must hold for its type (signed is not the same as well-formed). */
function wellFormed(type: string, data: unknown): boolean {
  if (!isObject(data)) return false;
  if (type.startsWith('checkout.')) return typeof data.id === 'string' && typeof data.price === 'string';
  if (type.startsWith('membership.')) return typeof data.id === 'string' && typeof data.status === 'string';
  if (type === 'payment.refunded') return typeof data.checkoutId === 'string';
  return true;
}

/**
 * `POST /site-api/_platform/payments`: the platform telling this site that money moved. Mounted by
 * `src/pages/site-api/[...path].ts` BEFORE the Site API (its authentication is the signature,
 * the same `SITE_JOBS_SECRET` as job deliveries). Answers: 200 done (or a duplicate, or a type
 * this site does not handle) · 400 malformed · 401 bad signature · 500 a hook threw (retried
 * 1 min, 2 min, 10 min, 1 h).
 */
export async function handlePaymentDelivery(request: Request, hooks: PaymentHooks): Promise<Response> {
  if (request.method !== 'POST') return json(405, {error: 'POST only.'});
  const secret = config.jobsSecret;
  if (!secret) return json(503, {error: 'This site has no delivery secret yet. Publish it again.', code: 'no_secret'});
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return json(413, {error: 'Too large.'});
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (body === null) return json(413, {error: 'Too large.'});
  if (!(await signatureOk(secret, body, request.headers.get('x-site-signature')))) {
    return json(401, {error: 'Bad signature.', code: 'bad_signature'});
  }
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return json(400, {error: 'Bad delivery.'});
  }
  if (
    !isObject(event) ||
    typeof event.id !== 'string' ||
    !EVENT_ID.test(event.id) ||
    typeof event.type !== 'string' ||
    (event.mode !== 'test' && event.mode !== 'live') ||
    !wellFormed(event.type, event.data)
  ) {
    return json(400, {error: 'Bad delivery.'});
  }
  const info: PaymentEventInfo = {
    id: event.id,
    type: event.type as PaymentEventType,
    mode: event.mode,
    createdAt: typeof event.createdAt === 'string' ? event.createdAt : new Date().toISOString(),
    source: 'event',
  };
  const data = event.data as never;
  const run = (() => {
    switch (info.type) {
      case 'checkout.paid':
        return hooks.onCheckoutPaid && (() => hooks.onCheckoutPaid!(data, info));
      case 'checkout.failed':
        return hooks.onCheckoutFailed && (() => hooks.onCheckoutFailed!(data, info));
      case 'membership.started':
      case 'membership.renewed':
      case 'membership.past_due':
      case 'membership.canceled':
        return hooks.onMembershipChanged && (() => hooks.onMembershipChanged!(data, info));
      case 'payment.refunded':
        return hooks.onRefund && (() => hooks.onRefund!(data, info));
      default:
        return undefined;
    }
  })();
  // A type this site has no hook for (or a newer one): done, nothing to retry.
  if (!run) return json(200, {ok: true, ignored: true});
  if (running.has(info.id)) return json(409, {error: 'This event is being handled.'});
  running.add(info.id);
  try {
    if (await alreadyHandled(info.id)) return json(200, {ok: true, duplicate: true});
    await run();
    await markHandled(info.id, info.type);
    return json(200, {ok: true});
  } catch (error) {
    // The message only (it reaches the owner's events list): never secrets or personal data.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    console.error(`[payments] ${info.type} ${info.id}: ${message}`);
    return json(500, {error: message});
  } finally {
    running.delete(info.id);
  }
}
