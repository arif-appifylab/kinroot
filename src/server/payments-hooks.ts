import {getDb} from '../platform/db';
import {type Checkout, definePaymentHooks, type PlatformMembership, type Refund} from '../platform/payments';

/**
 * What this site does when money moves (docs/agent/payments.md). YOURS to change.
 *
 * Called with the platform's signed payment events (the live site) and by the thanks page's
 * confirm (`GET /site-api/checkout/:id`, everywhere, the Preview too). So a hook can run MORE THAN
 * ONCE for one payment: the defaults below upsert and say whether the row is new (`created`). Do
 * one-time work (a welcome email, a stock change) only when it is: `if (created) { … }`.
 *
 * Throw to have the event tried again later (1 min, 2 min, 10 min, 1 h). Keep each hook short:
 * slow work goes in a background job (`sendJob`, docs/agent/background-jobs.md).
 */

const userIdOf = (ref: string | null | undefined): number | null => {
  const n = Number(ref);
  return ref && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const dateOf = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

function database() {
  const db = getDb();
  // No Site Database: throwing makes the platform try again once there is one.
  if (!db) throw new Error('No Site Database: the payment is kept by the platform and sent again.');
  return db;
}

/** Records a paid checkout once. `created` is true the first time. */
export async function recordOrder(checkout: Checkout, status: 'paid' | 'failed'): Promise<{created: boolean}> {
  const db = database();
  const data = {
    priceKey: checkout.price,
    mode: checkout.mode,
    email: checkout.email?.toLowerCase() ?? null,
    userId: userIdOf(checkout.customerRef),
    quantity: checkout.quantity,
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    metadata: checkout.metadata ?? {},
    paidAt: dateOf(checkout.paidAt),
  };
  const found = await db.order.findUnique({where: {checkoutId: checkout.id}, select: {id: true, status: true}});
  if (found) {
    // Never move a refunded order back to paid, or a paid one to failed.
    if (found.status === 'failed' && status === 'paid') await db.order.update({where: {id: found.id}, data: {...data, status}});
    return {created: false};
  }
  try {
    await db.order.create({data: {checkoutId: checkout.id, status, ...data}});
    return {created: true};
  } catch (error) {
    // P2002: the event and the confirm arrived together; the other one wrote it.
    if ((error as {code?: unknown} | null)?.code === 'P2002') return {created: false};
    throw error;
  }
}

/** Keeps the site's copy of one membership in step. `created` is true the first time. */
export async function recordMembership(membership: PlatformMembership, mode: string): Promise<{created: boolean}> {
  const db = database();
  const data = {
    priceKey: membership.price,
    mode,
    email: membership.email?.toLowerCase() ?? null,
    userId: userIdOf(membership.customerRef),
    status: membership.status,
    currentPeriodEnd: dateOf(membership.currentPeriodEnd),
    accessEndsAt: dateOf(membership.accessEndsAt),
  };
  const found = await db.membership.findUnique({where: {subscriptionId: membership.id}, select: {id: true}});
  if (found) {
    await db.membership.update({where: {id: found.id}, data});
    return {created: false};
  }
  try {
    await db.membership.create({data: {subscriptionId: membership.id, ...data}});
    return {created: true};
  } catch (error) {
    if ((error as {code?: unknown} | null)?.code === 'P2002') {
      await db.membership.update({where: {subscriptionId: membership.id}, data});
      return {created: false};
    }
    throw error;
  }
}

export const paymentHooks = definePaymentHooks({
  async onCheckoutPaid(checkout) {
    const {created} = await recordOrder(checkout, 'paid');
    if (created) {
      // One-time work for a new order goes here (or send a background job from here).
    }
  },

  async onCheckoutFailed(checkout) {
    await recordOrder(checkout, 'failed');
  },

  async onMembershipChanged(membership, event) {
    await recordMembership(membership, event.mode);
  },

  async onRefund(refund: Refund) {
    await database().order.updateMany({
      where: {checkoutId: refund.checkoutId},
      data: {status: refund.full ? 'refunded' : 'partially_refunded'},
    });
  },
});
