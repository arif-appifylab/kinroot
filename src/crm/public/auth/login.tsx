import {useEffect, useRef, useState} from 'react';

import {Input} from '@/components/ui/form';
import {PasswordInput} from '@/components/ui/password-input';
import {BRAND, type Brand} from '@/lib/brand';

import {signedIn} from '../../../lib/account';
import {postJson, type SubmitResult} from '../../../lib/form';
import {AUTH_RULES, rules} from '../../../lib/rules';
import {siteFetch} from '../../../platform/browser';
import {AuthField, Dot, LinkButton, LinksRow, Notice, PendingButton, StatusLine, TextLink} from './parts';
import {AuthShell, useNext, withNext} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/login/ (src/pages/account/login.astro). The usual way is a 6-digit code emailed to the
 * account (`/site-api/auth/code`, then `/code/verify`): no password needed, and the site's admin
 * signs in this way. "Use a password instead" posts to `/site-api/auth/login` for an account that
 * set one. With two-step sign-in on, either answers a challenge and the authenticator step
 * (`/site-api/auth/login/two-factor`) finishes it; `?mfa=<challenge>` opens that step directly (a
 * one-click sign-in from the dashboard). `?notice=` says why the visitor landed here.
 */
type Step = 'email' | 'emailCode' | 'password' | 'twoFactor';

const NOTICES: Record<string, string> = {
  'owner-link': 'That sign-in link has expired or was already used. Open the portal again from the dashboard, or sign in below.',
  suspended: 'This account is suspended. Contact the site owner.',
};

export default function LoginPage({brand}: {brand: Brand}) {
  const next = useNext();
  const [step, setStep] = useState<Step>('email');
  const [notice, setNotice] = useState<string | null>(() => NOTICES[new URLSearchParams(window.location.search).get('notice') ?? ''] ?? null);
  // The two-step challenge and the address the code went to live in memory only.
  const challenge = useRef('');
  const [sentTo, setSentTo] = useState('');
  const [resending, setResending] = useState(false);
  // Where focus goes once a step is on screen.
  const focusNext = useRef<string | null>(null);

  const go = (to: Step, focus: string) => {
    focusNext.current = focus;
    setStep(to);
  };

  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  }, [step]);

  /** Two-step sign-in: keep the challenge, ask for the authenticator code. */
  const askTwoFactor = (value: string) => {
    challenge.current = value;
    setNotice(null);
    go('twoFactor', 'login-2fa-code');
  };

  /** Where the server says to go (its own checked `next`), else ours. */
  const done = (data: Record<string, unknown> | null): SubmitResult => ({ok: true, redirect: typeof data?.next === 'string' ? data.next : next});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mfa = params.get('mfa');
    if (mfa) {
      // After a one-click sign-in from the dashboard with two-step sign-in on (5 minutes): the
      // challenge leaves the address bar at once.
      history.replaceState(history.state, '', window.location.pathname + (params.get('next') ? `?next=${encodeURIComponent(next)}` : ''));
      askTwoFactor(mfa);
    } else {
      void signedIn().then((yes) => yes && window.location.replace(next));
    }
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendCode(address: string): Promise<SubmitResult> {
    const {result} = await postJson(siteFetch, '/site-api/auth/code', {email: address, next});
    if (result.ok) setSentTo(address);
    return result;
  }

  const emailForm = useAuthForm({
    idPrefix: 'login',
    initial: {email: ''},
    rules: () => ({email: AUTH_RULES.email}),
    async submit(values) {
      const result = await sendCode(values.email.trim());
      if (!result.ok) return result;
      emailCodeForm.reset();
      go('emailCode', 'login-code-code');
      return {ok: true};
    },
  });

  const emailCodeForm = useAuthForm({
    idPrefix: 'login-code',
    initial: {code: ''},
    rules: () => ({code: [rules.required('Enter the 6-digit code from the email.')]}),
    async submit(values) {
      const {result, data} = await postJson(siteFetch, '/site-api/auth/code/verify', {email: sentTo, code: values.code, next});
      if (result.ok && data?.twoFactor === true && typeof data.challenge === 'string') {
        askTwoFactor(data.challenge);
        return {ok: true};
      }
      return result.ok ? done(data) : result;
    },
  });

  const passwordForm = useAuthForm({
    idPrefix: 'login-password',
    initial: {email: '', password: ''},
    rules: () => ({email: AUTH_RULES.email, password: AUTH_RULES.password}),
    async submit(values) {
      const {result, data} = await postJson(siteFetch, '/site-api/auth/login', {...values, next});
      if (result.ok && data?.twoFactor === true && typeof data.challenge === 'string') {
        askTwoFactor(data.challenge);
        return {ok: true};
      }
      // A wrong email or password is ONE generic line (the server never says which).
      return result.ok ? done(data) : result;
    },
  });

  const twoFactorForm = useAuthForm({
    idPrefix: 'login-2fa',
    initial: {code: ''},
    rules: () => ({code: [rules.required('Enter the 6-digit code from your app, or a recovery code.')]}),
    async submit(values) {
      const {result, data, res} = await postJson(siteFetch, '/site-api/auth/login/two-factor', {...values, challenge: challenge.current, next});
      if (res?.status === 401) {
        // The challenge expired (5 minutes) or the password changed: start again.
        window.location.replace(withNext('/account/login/', next));
        return result;
      }
      return result.ok ? done(data) : result;
    },
  });

  async function resend() {
    setResending(true);
    const result = await sendCode(sentTo);
    setResending(false);
    emailCodeForm.setStatus(
      result.ok ? {kind: 'ok', message: 'We sent a new code. Only the newest one works.'} : {kind: 'error', message: result.message ?? 'That did not work. Try again in a moment.'},
    );
  }

  const usePassword = () => {
    passwordForm.set('email', emailForm.values.email);
    go('password', 'login-password-email');
  };
  const useCode = () => {
    emailForm.set('email', passwordForm.values.email);
    go('email', 'login-email');
  };

  const name = brand.name.trim() || BRAND.name;
  const heads: Record<Step, {title: string; highlight: string; subtitle?: string}> = {
    email: {title: 'Sign in to', highlight: name, subtitle: "Enter your email and we'll send you a 6-digit code. No password needed."},
    emailCode: {title: 'Check your', highlight: 'email'},
    password: {title: 'Sign in with your', highlight: 'password', subtitle: `Use the email and password of your ${name} account.`},
    twoFactor: {title: 'Enter your', highlight: 'code', subtitle: 'Open your authenticator app and enter the 6-digit code for this site. Lost your phone? Enter one of your recovery codes instead.'},
  };
  const head = heads[step];

  const links =
    step === 'email' || step === 'password' ? (
      <LinksRow>
        {step === 'email' ? <LinkButton onClick={usePassword}>Use a password instead</LinkButton> : <LinkButton onClick={useCode}>Email me a code instead</LinkButton>}
        <Dot />
        <TextLink href={withNext('/account/forgot/', next)}>Forgot your password?</TextLink>
        <Dot />
        <TextLink href={withNext('/account/register/', next)}>Create an account</TextLink>
      </LinksRow>
    ) : null;

  return (
    <AuthShell brand={brand} title={head.title} highlight={head.highlight} subtitle={head.subtitle} footer={links}>
      <div className="grid gap-5">
        {notice && <Notice>{notice}</Notice>}

        {step === 'email' && (
          <form noValidate onSubmit={emailForm.onSubmit} className="grid gap-4">
            <AuthField id="login-email" label="Email" error={emailForm.error('email')}>
              <Input {...emailForm.input('email')} type="email" autoComplete="username" inputMode="email" placeholder="name@example.com" />
            </AuthField>
            <StatusLine status={emailForm.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={emailForm.pending} pendingLabel="Sending…">
              Email me a code
            </PendingButton>
          </form>
        )}

        {step === 'emailCode' && (
          <form noValidate onSubmit={emailCodeForm.onSubmit} className="grid gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground" aria-live="polite">
              If <span className="font-semibold text-slate-700">{sentTo}</span> has an account here, we sent it a 6-digit code. It works for 10 minutes. Check your spam folder if it isn't there.
            </p>
            <AuthField id="login-code-code" label="Code from the email" error={emailCodeForm.error('code')}>
              <Input {...emailCodeForm.input('code')} type="text" autoComplete="one-time-code" inputMode="numeric" maxLength={7} spellCheck={false} className="tracking-[0.3em]" />
            </AuthField>
            <StatusLine status={emailCodeForm.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={emailCodeForm.pending} pendingLabel="Checking…" disabled={resending}>
              Sign in
            </PendingButton>
            <LinksRow>
              <PendingButtonLink pending={resending} disabled={emailCodeForm.pending} onClick={() => void resend()}>
                Send a new code
              </PendingButtonLink>
              <Dot />
              <LinkButton disabled={emailCodeForm.pending || resending} onClick={() => go('email', 'login-email')}>
                Use another email
              </LinkButton>
            </LinksRow>
          </form>
        )}

        {step === 'password' && (
          <form noValidate onSubmit={passwordForm.onSubmit} className="grid gap-4">
            <AuthField id="login-password-email" label="Email" error={passwordForm.error('email')}>
              <Input {...passwordForm.input('email')} type="email" autoComplete="username" inputMode="email" placeholder="name@example.com" />
            </AuthField>
            <AuthField id="login-password-password" label="Password" error={passwordForm.error('password')}>
              <PasswordInput {...passwordForm.input('password')} autoComplete="current-password" />
            </AuthField>
            <StatusLine status={passwordForm.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={passwordForm.pending} pendingLabel="Signing in…">
              Sign in
            </PendingButton>
          </form>
        )}

        {step === 'twoFactor' && (
          <form noValidate onSubmit={twoFactorForm.onSubmit} className="grid gap-4">
            <AuthField id="login-2fa-code" label="Code" error={twoFactorForm.error('code')}>
              <Input {...twoFactorForm.input('code')} type="text" autoComplete="one-time-code" inputMode="numeric" maxLength={20} spellCheck={false} />
            </AuthField>
            <StatusLine status={twoFactorForm.status} />
            <PendingButton type="submit" size="lg" className="w-full" pending={twoFactorForm.pending} pendingLabel="Checking…">
              Continue
            </PendingButton>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

/** The resend link: pending while the new code is on its way. */
function PendingButtonLink({pending, disabled, onClick, children}: {pending: boolean; disabled?: boolean; onClick: () => void; children: string}) {
  return (
    <LinkButton onClick={onClick} disabled={pending || disabled} aria-busy={pending || undefined}>
      {pending ? 'Sending…' : children}
    </LinkButton>
  );
}
