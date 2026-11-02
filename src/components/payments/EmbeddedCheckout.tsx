import {loadStripe, type Stripe, type StripeElements} from '@stripe/stripe-js';
import {useEffect, useMemo, useRef, useState} from 'react';

import {type CheckoutResult, CheckoutSession, type CheckoutState, type PaymentStep} from '../../lib/checkout-session';
import {siteCheckoutTransport} from '../../lib/checkout-transport';

/**
 * BROWSER: the checkout ON this site (docs/agent/payments.md), mounted by
 * `src/pages/checkout/index.astro` as `client:only="react"`. Drives one `CheckoutSession`:
 *
 *   1. how to pay: the ways to pay this price (`load()`); a radio list when there are several
 *   2. Continue / Pay: the checkout starts (`continue()`) and opens:
 *        element  the provider's form right here (Stripe Payment Element), Pay confirms it
 *        popup    the provider's popup over the page; closed → Pay opens the same one again
 *        window   the provider's page in a payment window; this page waits, then goes on
 *   3. paid → the thanks page (`successPath?checkout=…`), which confirms with the platform
 *
 * `result` is a checkout the server already started (`/checkout/?id=…`): step 2 straight away.
 * The page adds the provider's hosts to its own CSP (`allowEmbeddedCheckout`). Card details go
 * from the provider's own frame or page to the provider: never through this site.
 */
export interface EmbeddedCheckoutProps {
  price: string;
  quantity?: number;
  successPath?: string;
  cancelPath?: string;
  /** A checkout the server already started. */
  result?: CheckoutResult | null;
  /** "Pay 19.99 USD" */
  payLabel?: string;
}

/** The site's accent colour, so the provider's form matches (falls back to the provider's own). */
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || undefined;

function useSession(props: EmbeddedCheckoutProps): [CheckoutSession, CheckoutState] {
  const session = useMemo(
    () =>
      new CheckoutSession(siteCheckoutTransport, {
        price: props.price,
        quantity: props.quantity ?? 1,
        successPath: props.successPath ?? '/thanks/',
        cancelPath: props.cancelPath ?? '/',
        result: props.result ?? null,
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [state, setState] = useState(session.getState());
  useEffect(() => {
    const stop = session.subscribe(setState);
    if (!props.result) void session.load().catch(() => undefined);
    return () => {
      stop();
      session.cancel();
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  return [session, state];
}

export default function EmbeddedCheckout(props: EmbeddedCheckoutProps) {
  const payLabel = props.payLabel ?? 'Pay now';
  const [session, state] = useSession(props);
  const step = state.result?.embedded ?? null;
  const go = () => void session.continue().catch(() => undefined);

  if (state.status === 'loading' || (state.status === 'idle' && !step)) {
    return (
      <p className="form-status" role="status">
        Loading the ways to pay…
      </p>
    );
  }
  if (step?.kind === 'element') return <ElementForm step={step} payLabel={payLabel} />;
  if (state.status === 'redirecting' && step?.kind === 'window') {
    return (
      <div className="embedded-checkout" aria-live="polite">
        <p className="lede">Finish paying in the payment window.</p>
        <p className="form-status" role="status">
          This page goes on by itself once your payment is through.
        </p>
        <p>
          <button type="button" className="button" onClick={() => void session.open()}>
            Reopen the payment window
          </button>{' '}
          <button type="button" className="button button-secondary" onClick={() => session.cancel()}>
            Cancel
          </button>
        </p>
      </div>
    );
  }

  const choosing = !step && state.gateways.length > 1;
  const pending = state.status === 'submitting' || state.status === 'redirecting';
  const message = state.error?.message ?? (state.closed === 'failed' ? 'The payment did not go through. Nothing was charged. Try again.' : state.closed ? 'You closed the payment window. Nothing was charged.' : null);
  const tone = state.error && !state.trialUsed ? 'error' : undefined;
  const label = state.trialUsed && !step ? 'Continue without the trial' : choosing || !step ? 'Continue' : payLabel;
  return (
    <div className="embedded-checkout">
      {choosing && (
        <fieldset className="checkout-ways">
          <legend>How do you want to pay?</legend>
          {state.gateways.map(g => (
            <label className="checkout-way" key={g.slug}>
              <input type="radio" name="gateway" value={g.slug} checked={state.selectedGateway === g.slug} onChange={() => session.selectGateway(g.slug)} />
              <span>{g.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        className="button"
        onClick={go}
        disabled={pending || (choosing && !state.selectedGateway)}
        aria-busy={pending || undefined}
      >
        {pending && <span className="spinner" aria-hidden="true" />}
        {pending ? (step?.kind === 'popup' ? 'Finishing in the payment window…' : 'Opening checkout…') : label}
      </button>
      <p className="form-status" data-tone={tone} role="status" aria-live="polite">
        {message ?? ''}
      </p>
    </div>
  );
}

function ElementForm({step, payLabel}: {step: Extract<PaymentStep, {kind: 'element'}>; payLabel: string}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{stripe: Stripe; elements: StripeElements} | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (step.gateway !== 'stripe') {
      setError('This payment method cannot be shown on this page. Go back and try again later.');
      return;
    }
    loadStripe(step.publishableKey, step.gatewayAccountId ? {stripeAccount: step.gatewayAccountId} : undefined)
      .then(stripe => {
        if (cancelled || !stripe || !mountRef.current) return;
        const color = accent();
        const elements = stripe.elements({clientSecret: step.clientSecret, appearance: color ? {variables: {colorPrimary: color}} : undefined});
        const payment = elements.create('payment');
        payment.on('ready', () => setReady(true));
        payment.mount(mountRef.current);
        stripeRef.current = {stripe, elements};
      })
      .catch(() => setError('The payment form did not load. Reload the page to try again.'));
    return () => {
      cancelled = true;
    };
  }, [step.gateway, step.clientSecret, step.publishableKey, step.gatewayAccountId]);

  async function pay() {
    if (pending || !ready || !stripeRef.current) return;
    setError(null);
    setPending(true);
    try {
      const {stripe, elements} = stripeRef.current;
      const confirm = step.clientSecret.startsWith('seti_') ? stripe.confirmSetup.bind(stripe) : stripe.confirmPayment.bind(stripe);
      // Success leaves the page for `returnUrl`; only a problem comes back here.
      const result = await confirm({elements, confirmParams: {return_url: step.returnUrl}});
      setError(result.error?.message ?? 'The payment did not go through. Try again.');
    } catch {
      setError('The payment did not go through. Try again.');
    }
    setPending(false);
  }

  return (
    <div className="embedded-checkout">
      <div ref={mountRef} className="embedded-checkout-form" />
      {!ready && !error && (
        <p className="form-status" role="status">
          Loading the payment form…
        </p>
      )}
      <button type="button" className="button" onClick={pay} disabled={!ready || pending} aria-busy={pending || undefined}>
        {pending && <span className="spinner" aria-hidden="true" />}
        {pending ? 'Paying…' : payLabel}
      </button>
      <p className="form-status" data-tone={error ? 'error' : undefined} role="status" aria-live="polite">
        {error ?? ''}
      </p>
    </div>
  );
}
