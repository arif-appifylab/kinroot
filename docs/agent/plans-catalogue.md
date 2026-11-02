---
title: Plans and prices: a pricing section that is always up to date
read-when: before building or changing a pricing page, plan cards, a "Buy" / "Start" button, or anything that shows the owner's plans, prices, trials or add-ons
---
Not for the site's own products, services or memberships: those are sold with the built-in
payments (`payments.md`: Buy / Subscribe buttons, checkout, orders). This doc is only for an owner
who resells the platform's studio plans (sign-up links to the owner's studio).

Some owners sell their own software plans (an agency selling its studio to clients). Their plans,
prices, trials and add-ons live in the platform, and change there. A pricing section on this site
reads them live from the platform, so a price changed in the dashboard shows here without a new
Publish. Never type plan prices into the code as the only source.

## The endpoint
```
GET {{API_PREFIX}}/public/site/v1/plans         (same origin: this site's own address, no key, no cookies)
```
- Call it on THIS site's address with a relative URL: `fetch('{{API_PREFIX}}/public/site/v1/plans')`. The
  platform answers `{{API_PREFIX}}/*` on every site address, so it is same-origin: the CSP's
  `connect-src 'self'` already allows it. Never call another host for it, never add a key.
- It answers only on the owner's own website. On any other site it is `404`: then there is no
  live catalogue, and the pricing section keeps its fallback (below).
- Public, read-only, rate-limited, revalidated with an ETag (`Cache-Control: no-cache`). Fetch it
  once per page view.

## The answer
```jsonc
{
  "status": 200,
  "data": {
    "audience": "account",
    "signupUrl": "https://app.example.com/start",   // where "Start" / "Buy" buttons go (below)
    "checkoutOpen": true,             // false: the owner can't take payments yet (below)
    "opensLaterReason": null,         // when false: "payments_not_connected" | "agency_trial"
    "plans": [
      {
        "id": 12,
        "code": "growth",                 // stable: use it in links, never the id or the name
        "name": "Growth",
        "description": "For a growing business",   // may be null
        "kind": "plan",
        "sortOrder": 2,                   // show plans in this order (the list is already sorted)
        "groupKey": null,
        "isDefaultFree": false,
        "prices": [
          {
            "id": 40,
            "currency": "USD",            // ISO 4217
            "amount": 49,                 // major units (49 = $49.00); a decimal for cents (49.5)
            "strikeAmount": 59,           // an old price to show struck through, or null
            "priceType": "recurring",     // "recurring" | "one_time" | "free" | "lifetime"
            "interval": "month",          // "month" | "year" | null (one_time, free, lifetime)
            "intervalCount": 1,
            "trialDays": 14,              // 0 = no trial
            "isDefault": true,            // the price to show first
            "availability": "open",       // only show prices that are "open"
            "remaining": null,            // a capped special price: how many are left, else null
            "availableUntil": null        // a time-boxed price: ISO date it ends, else null
          }
        ],
        "resources": [
          {"resource": "websites", "valueType": "limit", "unit": "sites", "limitValue": 3},
          {"resource": "custom_domain", "valueType": "boolean", "limitValue": 1}
        ]
      }
    ],
    "addons": [
      // the same shape as a plan, "kind": "addon": extras a customer adds on top of a plan
    ]
  }
}
```
- Show `name`, `description`, the default price (`isDefault`, else the first `open` one) and, when
  the owner sells both, a monthly / yearly switch built from the `interval` of each price.
- `limitValue`: a number, `null` for unlimited, `1` / `0` for a yes / no (`valueType: "boolean"`).
  Turn `resource` names into plain words in the page's own copy (`websites` → "3 websites",
  `custom_domain` → "Your own domain"); skip a resource you have no words for.
- Money: `new Intl.NumberFormat(locale, {style: 'currency', currency}).format(amount)`. Never
  divide by 100: `amount` is already in major units.
- A plan with no `open` price: leave it out. An empty `plans` list: keep the fallback.

## Buttons: Start / Buy
Every plan button links to the owner's sign-up page with the plan picked:
```
{signupUrl}?plan={code}&interval={month|year}
```
- `interval` from the price the visitor is looking at (`lifetime` for a lifetime price; leave it
  out for a free plan). The visitor creates an account there and pays for that plan.
- A plain link (`<a href>`), not a form or a script redirect. Build the link from the API's
  `signupUrl`, never a hard-coded host.

### Not open yet: "Coming soon", never a dead Start
The owner may publish plans before they can take payments. Then `checkoutOpen` is `false`:
- Still show every plan, its price and what it includes.
- In place of the Start button of a PAID price (`amount` above 0), show a "Coming soon" state:
  a disabled-looking label (not a link), e.g. "Coming soon", with a short line such as
  "Sign-ups open shortly." Never a Start link that leads to an error.
- A free price (`priceType: "free"` or `amount` 0) keeps its normal Start link while
  `opensLaterReason` is `"payments_not_connected"` (it needs no payment). When the reason is
  `"agency_trial"`, every plan shows "Coming soon".
- A trial of a paid plan needs payment details, so it is "Coming soon" too.
- The live script switches the buttons both ways: Start links appear by themselves once
  `checkoutOpen` turns `true`, with no new Publish. The fallback renders Start links (the
  usual case); the live answer turns them into "Coming soon" when it says so.

## Fallback first, live second (no layout jump, works without JavaScript)
1. Run `npm run platform -- plans --write`: it reads the owner's REAL plans (with the editor's
   key, in the Preview too) and writes them to `src/content/plans.json`, the same shape as the
   endpoint's `data`. Render the pricing section at build time from that file (or, in this app
   template, a server-side `fetch` of the same path in an endpoint). Real HTML, so search engines
   and visitors without JavaScript see real plans. Never invent plans, prices or links: when the
   command says there are no plans, keep a plain sign-up link. Run it again when the owner
   changes plans.
2. A small script (a module script in the pricing component; no inline script) fetches `{{API_PREFIX}}/public/site/v1/plans` and,
   when it answers `200` with plans, replaces the names, prices, trial line and button links in
   place. Keep the same markup and sizes so nothing jumps.
3. On a `404`, an error or a timeout (abort after 4 seconds), do nothing: the fallback stays.
- Write text with `textContent`, never `innerHTML` (`security.md`). Build elements with
  `document.createElement`.
- In the editor's Preview the public endpoint may answer `404`. That is expected: the fallback
  already holds the real plans (step 1), and the live script refreshes them on the published site.

## Never
- Never a payment form, card field or checkout for these PLANS: buying a plan happens on the
  sign-up page. (The site's own products use `payments.md`.)
- Never a secret or key in this site's code. The endpoint needs none.
- Never copy prices into the copy text ("only $49!") outside the pricing section: they go stale.
