import {useState} from 'react';

import {Input} from '@/components/ui/form';
import type {Brand} from '@/lib/brand';

import {postJson} from '../../../lib/form';
import {AUTH_RULES} from '../../../lib/rules';
import {verifyOutcome} from '../../../lib/verify-outcome';
import {siteFetch} from '../../../platform/browser';
import {AuthField, DonePanel, PendingButton, StatusLine} from './parts';
import {AuthShell, pageToken} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/verify/ (src/pages/account/verify.astro): confirm an email address from an emailed link
 * (`?token=`, single use, 24 hours). The visitor presses a button to confirm: links in emails are
 * often opened by scanners, which must not use the token up. A missing or expired link offers to
 * send a new one.
 */
type Done = {message: string; link?: {href: string; text: string}};

export default function VerifyPage({brand}: {brand: Brand}) {
  const token = pageToken();
  const [verified, setVerified] = useState<Done | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  const [offerResend, setOfferResend] = useState(!token);

  const verify = useAuthForm({
    idPrefix: 'verify',
    initial: {},
    rules: () => ({}),
    async submit() {
      const {data, result} = await postJson(siteFetch, '/site-api/auth/verify-email', {token});
      if (result.ok) {
        // An owner address that must choose its password first gets no Sign in link.
        setVerified(verifyOutcome(data));
        return {ok: true};
      }
      setOfferResend(true);
      return result;
    },
  });

  const resend = useAuthForm({
    idPrefix: 'resend',
    initial: {email: ''},
    rules: () => ({email: AUTH_RULES.email}),
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/resend-verification', values);
      if (result.ok) setResent(result.message ?? 'Check your inbox.');
      return result.ok ? {ok: true} : result;
    },
  });

  return (
    <AuthShell brand={brand} title="Confirm your" highlight="email" subtitle={token && !verified ? 'One click and your account is ready.' : undefined}>
      <div className="grid gap-6">
        {verified ? (
          <DonePanel message={verified.message} link={verified.link} />
        ) : (
          token && (
            <form noValidate onSubmit={verify.onSubmit} className="grid gap-4">
              <StatusLine status={verify.status} />
              <PendingButton type="submit" size="lg" className="w-full" pending={verify.pending} pendingLabel="Confirming…">
                Confirm my email
              </PendingButton>
            </form>
          )
        )}

        {offerResend &&
          !verified &&
          (resent ? (
            <DonePanel message={resent} />
          ) : (
            <form noValidate onSubmit={resend.onSubmit} className="grid gap-4">
              <p className="text-sm text-muted-foreground">Need a new link? Enter your email and we will send one.</p>
              <AuthField id="resend-email" label="Email" error={resend.error('email')}>
                <Input {...resend.input('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
              </AuthField>
              <StatusLine status={resend.status} />
              <PendingButton type="submit" variant="secondary" size="lg" className="w-full" pending={resend.pending} pendingLabel="Sending…">
                Send a new link
              </PendingButton>
            </form>
          ))}
      </div>
    </AuthShell>
  );
}
