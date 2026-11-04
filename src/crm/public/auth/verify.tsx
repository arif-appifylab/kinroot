import {useState} from 'react';

import {Input} from '@/components/ui/form';
import type {Brand} from '@/lib/brand';

import {nextPath, signUpEmail} from '../../../lib/account';
import {postJson, type SubmitResult} from '../../../lib/form';
import {AUTH_RULES, rules} from '../../../lib/rules';
import {verifyOutcome} from '../../../lib/verify-outcome';
import {siteFetch} from '../../../platform/browser';
import {AuthField, DonePanel, PendingButton, StatusLine} from './parts';
import {AuthShell, pageToken} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/verify/ (src/pages/account/verify.astro): where a new account is made. No account exists
 * until the emailed 6-digit code, or the emailed link, comes back in the browser that signed up
 * (`/site-api/auth/register/verify`; docs/agent/auth.md). Three ways in:
 *
 * - `?signup=<token>`: the sign-up email's link. A press, not the page load, uses it (email scanners
 *   open links too). If it can't be used here (another browser, expired), the code form shows.
 * - nothing: the code form, with the address the sign-up page remembered for this tab, and a way to
 *   get a new code.
 * - `?token=`: an older "confirm your email" link (`/verify-email`), still honoured.
 */
type Done = {message: string; link?: {href: string; text: string}};

let signUpLink: string | null | undefined;

/** The sign-up link's `?signup=`, taken out of the address bar at once and kept for later renders. */
function pageSignUpLink(): string | null {
  if (signUpLink !== undefined) return signUpLink;
  const url = new URL(window.location.href);
  signUpLink = url.searchParams.get('signup');
  if (signUpLink) {
    url.searchParams.delete('signup');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }
  return signUpLink;
}

/** Where to go once the account exists: the server's `next` when it gave one. */
const onwards = (data: unknown): SubmitResult => {
  const target = (data as {next?: unknown} | null)?.next;
  return {ok: true, redirect: typeof target === 'string' ? target : nextPath()};
};

export default function VerifyPage({brand}: {brand: Brand}) {
  const token = pageToken();
  const link = pageSignUpLink();
  const [verified, setVerified] = useState<Done | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  // The code form shows unless a link is waiting to be pressed.
  const [showCode, setShowCode] = useState(!token && !link);
  const [remembered] = useState(() => signUpEmail());

  const confirmLink = useAuthForm({
    idPrefix: 'signup-link',
    initial: {},
    rules: () => ({}),
    async submit() {
      const {data, result} = await postJson(siteFetch, '/site-api/auth/register/verify', {token: link, next: nextPath()});
      if (!result.ok) {
        setShowCode(true);
        return result;
      }
      return onwards(data);
    },
  });

  const code = useAuthForm({
    idPrefix: 'code',
    initial: {email: remembered, code: ''},
    rules: () => ({email: AUTH_RULES.email, code: [rules.required('Enter the 6-digit code from the email.')]}),
    async submit(values) {
      const {data, result} = await postJson(siteFetch, '/site-api/auth/register/verify', {email: values.email.trim(), code: values.code, next: nextPath()});
      return result.ok ? onwards(data) : result;
    },
  });

  const verify = useAuthForm({
    idPrefix: 'verify',
    initial: {},
    rules: () => ({}),
    async submit() {
      const {data, result} = await postJson(siteFetch, '/site-api/auth/verify-email', {token});
      if (result.ok) {
        setVerified(verifyOutcome(data));
        return {ok: true};
      }
      setShowCode(true);
      return result;
    },
  });

  const resend = useAuthForm({
    idPrefix: 'resend',
    initial: {email: remembered},
    rules: () => ({email: AUTH_RULES.email}),
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/resend-verification', values);
      if (result.ok) setResent(result.message ?? 'Check your inbox for a new code.');
      return result.ok ? {ok: true} : result;
    },
  });

  const subtitle = verified ? undefined : showCode ? 'Enter the 6-digit code we emailed you, in this same browser.' : 'One click and your account is ready.';

  return (
    <AuthShell brand={brand} title="Confirm your" highlight="email" subtitle={subtitle}>
      <div className="grid gap-6">
        {verified && <DonePanel message={verified.message} link={verified.link} />}

        {!verified && link && !showCode && (
          <form noValidate onSubmit={confirmLink.onSubmit} className="grid gap-4">
            <p className="text-sm text-muted-foreground">This works in the browser you signed up in.</p>
            <StatusLine status={confirmLink.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={confirmLink.pending} pendingLabel="Confirming…">
              Confirm my email
            </PendingButton>
          </form>
        )}

        {!verified && token && !showCode && (
          <form noValidate onSubmit={verify.onSubmit} className="grid gap-4">
            <StatusLine status={verify.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={verify.pending} pendingLabel="Confirming…">
              Confirm my email
            </PendingButton>
          </form>
        )}

        {!verified && showCode && (
          <form noValidate onSubmit={code.onSubmit} className="grid gap-4">
            <StatusLine status={confirmLink.status ?? verify.status} />
            <AuthField id="code-email" label="Email" error={code.error('email')}>
              <Input {...code.input('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
            </AuthField>
            <AuthField id="code-code" label="Code from the email" error={code.error('code')}>
              <Input {...code.input('code')} type="text" autoComplete="one-time-code" inputMode="numeric" maxLength={7} spellCheck={false} className="tracking-[0.3em]" />
            </AuthField>
            <StatusLine status={code.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={code.pending} pendingLabel="Confirming…">
              Confirm my email
            </PendingButton>
          </form>
        )}

        {!verified &&
          showCode &&
          (resent ? (
            <DonePanel message={resent} />
          ) : (
            <form noValidate onSubmit={resend.onSubmit} className="grid gap-4">
              <p className="text-sm text-muted-foreground">Need a new code? Enter your email and we will send one.</p>
              <AuthField id="resend-email" label="Email" error={resend.error('email')}>
                <Input {...resend.input('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
              </AuthField>
              <StatusLine status={resend.status} />
              <PendingButton type="submit" variant="secondary" size="lg" className="w-full" pending={resend.pending} pendingLabel="Sending…">
                Send a new code
              </PendingButton>
            </form>
          ))}
      </div>
    </AuthShell>
  );
}
