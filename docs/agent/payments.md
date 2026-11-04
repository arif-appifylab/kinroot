---
title: Payments: Buy and Subscribe buttons, checkout, memberships, paid pages
read-when: before anything sold: a Buy or Subscribe button, a price, checkout, a membership or member-only page, an order, a refund
---
Payments are BUILT IN. The platform holds the site's payment account and talks to the gateway
(Stripe, Razorpay, Xendit, PayPal); this site never sees a card, a gateway key or a webhook
secret. The buyer never leaves your site: the payment opens in a form on your page (Stripe), in
the provider's popup over it (Razorpay), or in a small payment window (Xendit, PayPal). Use this by default whenever the site sells anything: a one-time Buy button,
a subscription or membership, a paid page. Nothing to install, no key to ask for.

Not this: the platform's own plans for an owner who resells the studio (`plans-catalogue.md`:
sign-up links, no checkout here).

## Sandbox while you build (always)
- You, the Preview and every copy outside the live site use the editor's Site Key: payments are
  ALWAYS test payments there (sandbox). Gateway test cards work (Stripe `4242 4242 4242 4242`,
  any future date, any CVC).
- The live site switches to real payments BY ITSELF once the owner connects a live gateway in the
  dashboard (the site's Payments tab). Until then it takes test payments and shows
  `<TestModeBadge />`. Site code never chooses or checks the mode to decide anything.
- No events reach the Preview (they need a published site): the thanks page confirms the payment
  itself (below), so orders and memberships are recorded in the Preview too.

## Prices: a catalogue, referenced by key
Every price lives in the catalogue (one list per site): a `key` (slug), a name, an amount in minor
units, a currency, and `one_time`, `month` or `year`. Code names a price ONLY by its key
(`<BuyButton price="pro-monthly" />`); the platform charges the catalogue's amount whatever the
browser sends. Never type an amount into a button, a route or a hidden field.

Create the prices the site needs, in sandbox, from the editor:
```
npm run platform -- prices                                   # mode, readiness, every price
npm run platform -- prices currencies                        # the currencies a new price may use
npm run platform -- prices add --key pro-monthly --name "Pro" --amount-cents 1999 \
  --currency USD --interval month [--trial-days 14] [--description "…"]
```
(or `createPrice()` from `src/platform/payments.ts` in a script.) Same key + same amount again:
nothing changes. Amount, currency and interval never change: a new price is a NEW key
(`pro-monthly-2026`); the owner archives the old one in the dashboard. Prices reach the live
account by themselves. The live site cannot create prices (`E_PAYMENTS_EDITOR_ONLY`). Show prices
from the catalogue (`PriceList` / `listPrices()` in an on-demand page, below), or write the same
numbers into a prerendered page's copy from `npm run platform -- prices`, re-checked when they change.
Pick the currency from `prices currencies` (the site's connected payment providers; "one-time
only" ones can't be monthly or yearly). Another currency is refused (422
`E_SITE_PAYMENTS_CURRENCY_NOT_TAKEN`). With no provider connected yet any common one is accepted:
ask the owner which currency they sell in rather than guessing.
A paid price is at least the currency's minimum (1 USD/EUR/GBP, 10,000 IDR, 100 JPY…: 422
`E_PRICE_BELOW_MINIMUM`, its message says the lowest) and a whole amount where the currency has no
cents at checkout (IDR, ISK: `--amount-cents 15000000` for 150,000 IDR; 422 `E_PRICE_NOT_WHOLE`).

## The pieces
| Piece | File | Who edits |
| --- | --- | --- |
| Platform calls, event signature, CSP hosts | `src/platform/payments.ts` | MANAGED, never edit |
| Pricing section (cards + Buy buttons) | `src/components/payments/PriceList.astro` | you may restyle |
| Buy / Subscribe button | `src/components/payments/BuyButton.astro` | you may restyle |
| The checkout island (picker, form, popup, payment window) | `src/components/payments/EmbeddedCheckout.tsx` | rarely |
| The question form without JavaScript | `src/components/payments/CheckoutAskForm.astro` | you may restyle |
| Checkout session + its transport (browser) | `src/lib/checkout-session.ts`, `src/lib/checkout-transport.ts` | never |
| "Test mode" note | `src/components/payments/TestModeBadge.astro` | you may restyle |
| Start + confirm a checkout, memberships | `src/server/routes/checkout.ts` | you |
| What happens when money moves | `src/server/payments-hooks.ts` | you |
| Member-only routes and pages | `src/server/memberships.ts` | you |
| Pages | `src/pages/checkout/index.astro`, `src/pages/thanks/index.astro` | you |
| Tables | `prisma/schema.prisma` `// payments (MANAGED)`: `orders`, `memberships`, `payment_events` | add columns only by upgrade |

## Selling, in three steps (follow them exactly)
1. **Show the prices, each with a Buy button** (`PriceList`, or your own cards + `BuyButton`).
   Prices come from the catalogue (`listPrices()`: `{mode, ready, prices}`; `ready` false = not
   taking payments yet → "Coming soon", no button).
2. **Let the buyer choose how to pay** when more than one way takes the price (its currency, and
   its free trial when it has one): the checkout page does it (`/checkout/?price=<key>`, the ways
   from `GET /site-api/checkout/gateways?price=<key>` → `{gateways: [{slug, name}]}`). One way →
   no question. Never pick a provider in code.
3. **Open it without leaving the site**, then the thanks page confirms. The checkout answers ONE
   step (`embedded.kind`) and `EmbeddedCheckout` opens it:
   - `element`: the provider's form on the page (Stripe); Pay confirms it.
   - `popup` (`clientCheckout`): the provider's popup over the page (Razorpay). Paid → the
     provider sends the browser to the thanks page; closed → Pay opens the SAME checkout again.
   - `window` (`checkoutUrl`): the provider's page in a small payment window (Xendit, PayPal);
     the page says "Finish paying in the payment window" (Reopen, Cancel), checks the checkout
     until it is paid, then closes the window and goes to the thanks page. Closed without paying
     → back to Pay, nothing charged; a blocked window → the provider's page in this tab.
   A buyer who already had the price's free trial gets "You've already used the free trial for
   this. Continue to pay now without a trial." and the next Continue sends `noTrial`.

### The complete example
A pricing page (on demand: it reads the catalogue per request, cached 60 s):
```astro
---
// src/pages/pricing.astro
import PriceList from '../components/payments/PriceList.astro';
import TestModeBadge from '../components/payments/TestModeBadge.astro';
import Base from '../layouts/Base.astro';
import {pageContext} from '../server/page';

export const prerender = false;
const {site, viewer} = await pageContext(Astro.request, Astro.response);
---
<Base site={site} viewer={viewer} title="Pricing" description="Plans and prices.">
  <main id="main" tabindex="-1" class="wrap section">
    <TestModeBadge />
    <h1>Pricing</h1>
    <PriceList keys={['club-monthly', 'club-yearly', 'print-a3']} successPath="/thanks/" />
  </main>
</Base>
```
Or your own card around one price, on ANY page (prerendered too: the button is a form):
```astro
<BuyButton price="club-monthly" label="Join the club" successPath="/thanks/" />
```
The checkout (`src/pages/checkout/index.astro`, already there: keep it) and the thanks page
(`src/pages/thanks/index.astro`, already there) need no code from you. A different thanks page:
copy `thanks/index.astro` (keep the confirm) and pass its path as `successPath`.

### What happens on a click
- `BuyButton` is a real `<form method="post" action="/site-api/checkout">`: it works without
  JavaScript (the server answers 303), on prerendered and on-demand pages; with JavaScript it
  shows "Opening checkout…" and keeps an error next to the button. Props: `price` (key), `label`,
  `quantity` (1–99), `successPath` (default `/thanks/`), `cancelPath` (default this page),
  `variant`. Paths only, never a URL; the platform adds `checkout=<id>` to them.
- `/site-api/checkout` (`src/server/routes/checkout.ts`): several ways to pay and none chosen →
  `/checkout/?price=…` (step 2); else it starts the checkout → `/checkout/?id=…` (step 3); the
  trial already used (409 `E_SITE_PAYMENTS_TRIAL_USED`) → `/checkout/?price=…&trialUsed=1`.
- A signed-in buyer pays as themselves (their email, their id as `customerRef`); a guest types
  their email at the checkout.
- A double click, a retry or a reload can't start a second checkout: each attempt has an idempotency key
  (`src/lib/idempotency.ts`, `orders-and-stock.md`). Keep it in anything you build on top. A plain form post has no
  script, so the route makes a key from the visitor and the purchase, the same for 2 minutes.
- The checkout page's island is `EmbeddedCheckout` driving a `CheckoutSession`
  (`src/lib/checkout-session.ts`, framework-free) through `src/lib/checkout-transport.ts` (the
  site's own routes). From the portal or your own script, use the same session:
  ```ts
  import {CheckoutSession} from '../lib/checkout-session';
  import {siteCheckoutTransport} from '../lib/checkout-transport';

  const session = new CheckoutSession(siteCheckoutTransport, {price: 'club-monthly', successPath: '/thanks/', cancelPath: '/'});
  session.subscribe(state => render(state)); // {status, gateways, selectedGateway, checkoutUrl, result, error, trialUsed, closed}
  await session.load();                     // the ways to pay; a lone one is selected
  session.selectGateway('stripe');          // the buyer's pick, when there are several
  await session.continue();                 // starts it and opens popup / window; `element` → mount `result.embedded`
  ```
  `status`: `idle → loading → ready → submitting → redirecting`, or `error` (call again).
  `openCheckout(result, {onDismiss})` opens a checkout you already have.
- When the provider sends the buyer back INSIDE the payment window, `Base.astro`
  (`notifyPaymentOpener()`) tells the checkout page and closes the window: keep that call.
- CSP: the checkout page adds the providers' hosts (their form or popup script) to THAT page only
  (`allowEmbeddedCheckout(Astro.csp, gateway)`); a payment window needs none. Never add payment
  hosts to the site-wide CSP in `astro.config.mjs`. Apple Pay and Google Pay stay off
  (`Permissions-Policy: payment=()`); cards and the provider's other methods work.

## After paying: the thanks page confirms
The buyer lands on `successPath?checkout=pcs_…`. `src/pages/thanks/index.astro` asks
`GET /site-api/checkout/:id`, which asks the platform (`getCheckout`) and, when `paid`, runs the
`onCheckoutPaid` hook (and `onMembershipChanged` for a subscription). Only `status: 'paid'` says
thank you; `open` means "confirming" (the page looks again); never trust the URL alone. Copy that
page for a different thank-you; keep the confirm.

## When money moves: hooks (`src/server/payments-hooks.ts`)
On the live site the platform POSTs signed events to `/site-api/_platform/payments` (the same
signature as job deliveries; answered before the Site API by `src/platform/payments.ts`; retried
1 min, 2 min, 10 min, 1 h; a handled event id is never run twice):

| Event | Hook | Default |
| --- | --- | --- |
| `checkout.paid` | `onCheckoutPaid(checkout, event)` | `recordOrder(checkout, 'paid')` → an `orders` row |
| `checkout.failed` | `onCheckoutFailed` | an `orders` row with `failed` |
| `membership.started` / `renewed` / `past_due` / `canceled` | `onMembershipChanged(membership, event)` | upserts `memberships` (status, period end, `accessEndsAt`) |
| `payment.refunded` | `onRefund(refund, event)` | the order becomes `refunded` / `partially_refunded` |

- A hook may run more than once for one payment (a retry, or the event AND the thanks page's
  confirm): keep it idempotent. The defaults upsert and return `{created}`; put one-time work
  (a welcome email, stock, a booking) under `if (created)`, or send a background job with a `key`.
- Throw to be tried again later. Keep hooks short; slow work goes in a background job.
- Stock, seats and bookings: hold them before the checkout starts (`orders-and-stock.md`).
- Your own data (what was bought, a booking) goes in your own table, pointing at `checkout_id`
  (pass your id in `metadata` when you create the checkout from your own route).
- `orders.mode` / `memberships.mode` say `test` or `live`: an owner's dashboard of sales filters on
  `live`.

## Members-only content
```ts
// a route
import {requireMembership} from '../memberships';
.get('/lessons/:id', withViewer, requireAuth, requireMembership(['club-monthly', 'club-yearly']), withDb, async c => …)
```
```astro
---
// a page (export const prerender = false)
import {pageMembership} from '../server/memberships';
const page = await pageMembership(Astro, ['club-monthly', 'club-yearly']);
---
{page.allowed ? <main>…</main> : <main>… <BuyButton price="club-monthly" label="Join" /></main>}
```
- Access: `active`, `trialing`, `past_due`, or `canceled` until `accessEndsAt`
  (`grantsAccess`). A membership is the member's when it was bought signed in, or with their
  email once that address is VERIFIED.
- Ask buyers to sign in (or sign up) before subscribing when the membership opens pages: it ties
  the membership to their account at once.
- A member's own list and Cancel: `GET /site-api/memberships`, `POST /site-api/memberships/:id/cancel`
  `{atPeriodEnd}` (default true: access lasts to the end of the paid period). Build the screen in
  the portal (`ui.md`), with `useConfirm` before cancelling.
- Prerendered pages cannot be gated (no visitor at build): member pages are on-demand pages or
  portal screens.

## Server helpers (`src/platform/payments.ts`)
`listPrices(url, {ttlSeconds})`, `findPrice(url, key)`, `createPrice(url, input)` (editor only),
`listGateways(url, priceKey)`, `createCheckout(url, input)`, `getCheckout(url, id)`, `memberships(url, email)`,
`cancelMembership(url, id, atPeriodEnd)`, `membershipOf(checkout)`, `grantsAccess(status, accessEndsAt)`.
Each answers `{ok: true, data}` or `{ok: false, status, code, message}` and never throws into a
page; show `message` to people. Codes: `E_PAYMENTS_NOT_READY` (the owner has not set up
payments: say so, don't hide the button), `E_PRICE_NOT_FOUND`, `E_PAYMENTS_EDITOR_ONLY`,
`E_PRICE_KEY_TAKEN`, `E_PLATFORM_UNREACHABLE`, `E_SITE_PAYMENTS_EMAIL_REQUIRED` (422: a price with a free
trial needs the buyer's `email`; a signed-in buyer's is sent for you, a guest types it), `E_SITE_PAYMENTS_TRIAL_USED` (409: ask, then
`noTrial: true`), `E_SITE_PAYMENTS_GATEWAY_UNAVAILABLE` (that way to pay can't take it now),
`E_SITE_PAYMENTS_IN_PROGRESS` and `E_SITE_PAYMENTS_IDEMPOTENCY_CONFLICT` (409, `orders-and-stock.md`).

Platform endpoints behind them (Site Key, server only):
```
GET  {{SITE_API_PREFIX}}/payments                       {mode, ready, prices}
POST {{SITE_API_PREFIX}}/payments/prices                {key, name, description?, amountCents, currency, interval, intervalCount?, trialDays?} (editor key only)
GET  {{SITE_API_PREFIX}}/payments/checkout/gateways?price=   {gateways: [{slug, name}]}
POST {{SITE_API_PREFIX}}/payments/checkout              {price, quantity?, email?, name?, successPath, cancelPath, metadata?, customerRef?, gateway?, noTrial?, idempotencyKey?} → {id, mode, embedded}
GET  {{SITE_API_PREFIX}}/payments/checkout/:id
GET  {{SITE_API_PREFIX}}/payments/memberships?email=
POST {{SITE_API_PREFIX}}/payments/memberships/:id/cancel  {atPeriodEnd}
```

## Your own provider instead
The built-in payments are recommended: nothing to secure, sandbox and live switch by themselves,
and orders reach your database. A site MAY instead integrate a provider itself: the owner adds
the provider's keys as site secrets in the dashboard (the TEST key in the `staging` environment,
the LIVE key in `production`, so the live site switches by itself), and the site's server code
calls the provider's API like any other public API (`security.md` › Calling other services).
Read a key only in server code with `config.ownerSecret('STRIPE_SECRET_KEY')` (`null` when the
owner has not added it: say which name to add, in which environment; never ask for the value).
Never put a provider key in code, a file or the browser, and verify the provider's webhook
signature yourself (its own route, mounted before `csrf`, like `checkoutRoutes`). Send the provider's idempotency key
on every charge, refund and subscription (`orders-and-stock.md`).

## Never
- An amount, a price id or a gateway key in code, HTML or the browser: a price KEY only.
- A card field of your own, or a checkout built on a third-party script outside `EmbeddedCheckout`.
- Payment hosts in the site-wide CSP; a gateway script on any page but `/checkout/`.
- "Thank you" (or access) from the URL alone, without `getCheckout` / an event saying `paid`.
- Access from an unverified email, or from `localStorage`.
- Editing `src/platform/payments.ts`, or answering `/site-api/_platform/payments` yourself.
- A hook that charges, emails or books on every call: only when `created`.
- A checkout, a charge or a booking with no idempotency key, or a new random key on each retry.
- Stock or a booking decided by a read in your code, or by the cache (`orders-and-stock.md`).
