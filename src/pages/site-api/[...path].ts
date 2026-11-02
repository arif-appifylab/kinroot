import type {APIRoute} from 'astro';
import type {ExecutionContext} from 'hono';

import {handleJobDelivery, isJobDelivery} from '../../platform/background';
import {handlePaymentDelivery, isPaymentDelivery} from '../../platform/payments';
import {app} from '../../server/app';
import {background} from '../../server/background';
import {paymentHooks} from '../../server/payments-hooks';

/**
 * The ONE route that mounts the Site API: every method on `/site-api/*` goes
 * to the Hono app in `src/server/app.ts`. Rendered on request, never at build.
 * No `env` is passed: only `src/platform/config.ts` reads it. The Worker's
 * execution context is handed on, so a route can finish work
 * after answering (`c.executionCtx.waitUntil`, used for relayed emails).
 *
 * `POST /site-api/_platform/jobs` is the platform delivering a background job: it is answered BEFORE the
 * Site API (its own authentication is a signature, not a cookie), by the managed
 * `src/platform/background.ts`, with the handlers in `src/server/background.ts`.
 * `POST /site-api/_platform/payments` is the platform telling the site that money moved, signed the
 * same way: answered next, by `src/platform/payments.ts`, with the hooks in
 * `src/server/payments-hooks.ts`.
 */
export const prerender = false;

export const ALL: APIRoute = ({request, locals}) =>
  isJobDelivery(request.url)
    ? handleJobDelivery(request, background)
    : isPaymentDelivery(request.url)
      ? handlePaymentDelivery(request, paymentHooks)
      : app.fetch(request, {}, (locals as {cfContext?: ExecutionContext}).cfContext);
