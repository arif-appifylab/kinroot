import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {Viewer} from '../../lib/types';
import {formCsrf, problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {
  cancelMembership,
  type Checkout,
  createCheckout,
  getCheckout,
  isSitePath,
  listGateways,
  membershipOf,
  type PaymentEventInfo,
} from '../../platform/payments';
import {paymentHooks, recordMembership} from '../payments-hooks';

/**
 * Payments, the site's side (docs/agent/payments.md).
 *
 *   POST /site-api/checkout          start a checkout for a price key. JSON (the Buy button's
 *                                    script, the dashboard) → {id, redirectUrl, embedded};
 *                                    a plain form post (no JavaScript) → 303 to the same place.
 *                                    Several ways to pay and none chosen → `redirectUrl` is the
 *                                    checkout page's chooser (`/checkout/?price=…`); the buyer
 *                                    already had the price's free trial (409) → the same page,
 *                                    asking to continue without it (`noTrial`).
 *   GET  /site-api/checkout/gateways?price=   the ways to pay that price ({gateways})
 *   GET  /site-api/checkout/:id      what happened, for the thanks page; records a paid checkout
 *                                    through the hooks (the Preview gets no events).
 *   GET  /site-api/memberships       the signed-in member's memberships
 *   POST /site-api/memberships/:id/cancel   {atPeriodEnd?} cancel one of them
 *
 * `checkoutRoutes` is mounted BEFORE `csrf` in app.ts (with `formCsrf`), so the Buy button works
 * without JavaScript; `membershipRoutes` after it, like every other route.
 */

/** Where an embedded checkout's payment form is shown (`src/pages/checkout/index.astro`). */
const CHECKOUT_PAGE = '/checkout/';
const PRICE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const GATEWAY = /^[a-z0-9_-]{1,40}$/;

type CheckoutForm = {
  price: string;
  quantity: number;
  successPath: string;
  cancelPath: string;
  email?: string;
  metadata?: Record<string, string>;
  gateway?: string;
  noTrial: boolean;
};

const isForm = (type: string | undefined) =>
  Boolean(type?.startsWith('application/x-www-form-urlencoded') || type?.startsWith('multipart/form-data'));

/** JSON or a form post, checked field by field. Never an amount: the catalogue decides it. */
const checkoutBody = createMiddleware<{Variables: {input: CheckoutForm; form: boolean}}>(async (c, next) => {
  const form = isForm(c.req.header('content-type'));
  let raw: Record<string, unknown>;
  try {
    raw = form ? ((await c.req.parseBody()) as Record<string, unknown>) : ((await c.req.json()) as Record<string, unknown>);
  } catch {
    return c.json(problem('invalid_input', 'That request could not be read.'), 400);
  }
  if (!raw || typeof raw !== 'object') return c.json(problem('invalid_input', 'That request could not be read.'), 400);
  const price = typeof raw.price === 'string' ? raw.price.trim() : '';
  const quantity = raw.quantity === undefined || raw.quantity === '' ? 1 : Number(raw.quantity);
  const successPath = typeof raw.successPath === 'string' && raw.successPath ? raw.successPath : '/thanks/';
  const cancelPath = typeof raw.cancelPath === 'string' && raw.cancelPath ? raw.cancelPath : '/';
  const email = typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim().toLowerCase() : undefined;
  const gateway = typeof raw.gateway === 'string' && raw.gateway.trim() ? raw.gateway.trim() : undefined;
  const noTrial = raw.noTrial === true || raw.noTrial === '1' || raw.noTrial === 'true';
  const fields: Record<string, string> = {};
  if (gateway !== undefined && !GATEWAY.test(gateway)) fields.gateway = 'Choose a way to pay.';
  if (!PRICE_KEY.test(price)) fields.price = 'Choose something to buy.';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) fields.quantity = 'Choose a quantity from 1 to 99.';
  if (!isSitePath(successPath) || !isSitePath(cancelPath)) fields.price = 'This button points outside the site.';
  if (email !== undefined && !EMAIL.test(email)) fields.email = 'Enter an email address like name@example.com.';
  let metadata: Record<string, string> | undefined;
  if (!form && raw.metadata !== undefined) {
    const pairs = raw.metadata && typeof raw.metadata === 'object' ? Object.entries(raw.metadata) : null;
    if (!pairs || pairs.length > 20 || pairs.some(([k, v]) => typeof v !== 'string' || k.length > 40 || v.length > 500)) {
      fields.metadata = 'Notes are up to 20 short text pairs.';
    } else metadata = Object.fromEntries(pairs) as Record<string, string>;
  }
  if (Object.keys(fields).length) {
    return c.json({...problem('invalid_input', Object.values(fields)[0]!), fields}, 422);
  }
  c.set('input', {price, quantity, successPath, cancelPath, email, metadata, gateway, noTrial});
  c.set('form', form);
  await next();
});

/** What the browser may see of a checkout (no email, no metadata, no customer reference). */
const publicCheckout = (checkout: Checkout) => ({
  id: checkout.id,
  mode: checkout.mode,
  status: checkout.status,
  price: checkout.price,
  quantity: checkout.quantity,
  amountCents: checkout.amountCents,
  currency: checkout.currency,
  paidAt: checkout.paidAt,
  subscription: checkout.subscription
    ? {
        status: checkout.subscription.status,
        currentPeriodEnd: checkout.subscription.currentPeriodEnd,
        accessEndsAt: checkout.subscription.accessEndsAt,
      }
    : null,
  embedded: checkout.status === 'open' ? (checkout.embedded ?? null) : null,
});

const CHECKOUT_ID = /^pcs_[A-Za-z0-9]{8,64}$/;

/** The checkout page that asks the buyer something first: which way to pay, or "without the trial". */
function askPage(input: CheckoutForm, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    price: input.price,
    quantity: String(input.quantity),
    successPath: input.successPath,
    cancelPath: input.cancelPath,
    ...(input.email ? {email: input.email} : {}),
    ...extra,
  });
  return `${CHECKOUT_PAGE}?${q.toString()}`;
}

export const checkoutRoutes = new Hono()
  .use(bodyLimit({maxSize: 8 * 1024, onError: c => c.json(problem('too_large', 'That request is too large.'), 413)}))
  .use(formCsrf)

  .post('/', checkoutBody, withViewer, async c => {
    const input = c.var.input;
    const viewer: Viewer = c.var.viewer;
    const signedIn = viewer.state === 'user' && viewer.id !== null;
    const answer = (redirectUrl: string, status: 200 | 409 = 200, extra: Record<string, unknown> = {}) => {
      c.header('Cache-Control', 'private, no-store');
      if (c.var.form) return c.redirect(redirectUrl, 303);
      return c.json({redirectUrl, ...extra}, status);
    };
    // Several ways to pay this price and none chosen yet: the buyer chooses on the checkout page.
    let gateway = input.gateway;
    if (!gateway) {
      const ways = await listGateways(c.req.url, input.price);
      if (ways.ok && ways.data.length > 1) return answer(askPage(input), 200, {choose: true});
      if (ways.ok && ways.data.length === 1) gateway = ways.data[0]!.slug;
    }
    const started = await createCheckout(c.req.url, {
      price: input.price,
      quantity: input.quantity,
      successPath: input.successPath,
      cancelPath: input.cancelPath,
      metadata: input.metadata,
      ...(gateway ? {gateway} : {}),
      ...(input.noTrial ? {noTrial: true} : {}),
      // A signed-in buyer pays as themselves: their own address, their id as the reference.
      ...(signedIn
        ? {email: viewer.email ?? undefined, name: viewer.name ?? undefined, customerRef: String(viewer.id)}
        : {email: input.email}),
    });
    if (!started.ok && started.code === 'E_SITE_PAYMENTS_TRIAL_USED') {
      // The buyer decides whether to pay now without the trial.
      return answer(askPage(input, {...(gateway ? {gateway} : {}), trialUsed: '1'}), 409, {
        code: 'E_SITE_PAYMENTS_TRIAL_USED',
        message: "You've already used the free trial for this. Continue to pay now without a trial.",
      });
    }
    if (!started.ok) {
      const status = started.status === 404 ? 404 : started.status === 422 ? 422 : started.status === 0 ? 503 : 502;
      if (c.var.form) return c.redirect(`${CHECKOUT_PAGE}?error=${encodeURIComponent(started.code)}`, 303);
      return c.json(problem(started.code.toLowerCase(), started.message), status);
    }
    const {id, mode, embedded} = started.data;
    return answer(`${CHECKOUT_PAGE}?id=${encodeURIComponent(id)}`, 200, {id, mode, embedded: embedded ?? null});
  })

  .get('/gateways', validator('query', value => ({price: typeof value.price === 'string' ? value.price : ''})), async c => {
    const {price} = c.req.valid('query');
    if (!PRICE_KEY.test(price)) return c.json(problem('invalid_input', 'Choose something to buy.'), 422);
    const ways = await listGateways(c.req.url, price);
    if (!ways.ok) return c.json(problem('payments_unavailable', ways.message), ways.status === 404 ? 404 : 503);
    c.header('Cache-Control', 'private, no-store');
    return c.json({gateways: ways.data});
  })

  .get('/:id', async c => {
    const id = c.req.param('id');
    if (!CHECKOUT_ID.test(id)) return c.json(problem('not_found', 'No such checkout.'), 404);
    const found = await getCheckout(c.req.url, id);
    if (!found.ok) {
      if (found.status === 404) return c.json(problem('not_found', 'No such checkout.'), 404);
      return c.json(problem('payments_unavailable', found.message), 503);
    }
    const checkout = found.data;
    if (checkout.status === 'paid') {
      // The confirm: the Preview gets no events, and a live event may still be on its way.
      const event: PaymentEventInfo = {
        id: `confirm_${checkout.id}`,
        type: 'checkout.paid',
        mode: checkout.mode,
        createdAt: new Date().toISOString(),
        source: 'confirm',
      };
      try {
        await paymentHooks.onCheckoutPaid?.(checkout, event);
        const membership = membershipOf(checkout);
        if (membership) await paymentHooks.onMembershipChanged?.(membership, {...event, type: 'membership.started'});
      } catch (error) {
        // The payment stands; the event (live) records it again later.
        console.error(`[payments] confirm ${checkout.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
      }
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json({checkout: publicCheckout(checkout)});
  });

const memberSelect = {
  subscriptionId: true,
  priceKey: true,
  mode: true,
  status: true,
  currentPeriodEnd: true,
  accessEndsAt: true,
} as const;

/** The member's own rows: bought signed in, or with their VERIFIED address. */
const ownedBy = (viewer: Viewer) => ({
  OR: [{userId: viewer.id!}, ...(viewer.email && viewer.emailVerified ? [{email: viewer.email.toLowerCase()}] : [])],
});

const cancelBody = validator('json', value => ({atPeriodEnd: (value as {atPeriodEnd?: unknown})?.atPeriodEnd !== false}));

export const membershipRoutes = new Hono()
  .get('/', withViewer, requireAuth, withDb, async c => {
    const rows = await c.var.db.membership.findMany({where: ownedBy(c.var.viewer), select: memberSelect, orderBy: {id: 'desc'}, take: 20});
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      memberships: rows.map(row => ({
        ...row,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        accessEndsAt: row.accessEndsAt?.toISOString() ?? null,
      })),
    });
  })

  .post('/:id/cancel', cancelBody, withViewer, requireAuth, withDb, async c => {
    const subscriptionId = c.req.param('id');
    const mine = await c.var.db.membership.findFirst({
      where: {subscriptionId, ...ownedBy(c.var.viewer)},
      select: {subscriptionId: true, mode: true},
    });
    if (!mine) return c.json(problem('not_found', 'No such membership.'), 404);
    const done = await cancelMembership(c.req.url, mine.subscriptionId, c.req.valid('json').atPeriodEnd);
    if (!done.ok) return c.json(problem(done.code.toLowerCase(), done.message), done.status === 404 ? 404 : 502);
    await recordMembership(done.data, mine.mode);
    return c.json({ok: true, accessEndsAt: done.data.accessEndsAt});
  });
