import {siteFetch} from '../platform/browser';

import {CheckoutError, type CheckoutGateway, type CheckoutResult, type CheckoutTransport, TRIAL_USED_CODE} from './checkout-session';

/**
 * BROWSER: how a `CheckoutSession` reaches the platform from this app: through the site's own
 * routes (`src/server/routes/checkout.ts`), never the platform directly (the Site Key stays on
 * the server).
 *
 *   GET  /site-api/checkout/gateways?price=   the ways to pay
 *   POST /site-api/checkout                   start one → {id, mode, embedded}
 *   GET  /site-api/checkout/:id               its status (`checkout.status`)
 */
type Body = {error?: string; code?: string; message?: string} & Record<string, unknown>;

async function json(res: Response): Promise<Body> {
  return ((await res.json().catch(() => null)) as Body | null) ?? {};
}

const refused = (res: Response, body: Body) =>
  new CheckoutError(body.message ?? 'Checkout did not open. Try again.', String(body.code ?? body.error ?? `http_${res.status}`), res.status);

export const siteCheckoutTransport: CheckoutTransport = {
  async listGateways(price) {
    const res = await siteFetch(`/site-api/checkout/gateways?price=${encodeURIComponent(price)}`, {headers: {accept: 'application/json'}});
    const body = await json(res);
    if (!res.ok) throw refused(res, body);
    return (Array.isArray(body.gateways) ? body.gateways : []) as CheckoutGateway[];
  },

  async createCheckout(request) {
    const res = await siteFetch('/site-api/checkout', {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify(request),
    });
    const body = await json(res);
    if (res.status === 409 && body.code === TRIAL_USED_CODE) throw refused(res, body);
    if (!res.ok || typeof body.id !== 'string' || !body.embedded) throw refused(res, body);
    return {id: body.id, mode: body.mode as CheckoutResult['mode'], embedded: body.embedded as CheckoutResult['embedded']};
  },

  async getStatus(id) {
    const res = await siteFetch(`/site-api/checkout/${encodeURIComponent(id)}`, {headers: {accept: 'application/json'}});
    if (!res.ok) return null;
    const body = await json(res);
    return ((body.checkout as {status?: string} | undefined)?.status ?? null) as string | null;
  },
};
