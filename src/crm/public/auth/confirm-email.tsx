import {useState} from 'react';

import type {Brand} from '@/lib/brand';

import {postJson} from '../../../lib/form';
import {siteFetch} from '../../../platform/browser';
import {DonePanel, Notice, PendingButton, StatusLine} from './parts';
import {AuthShell, pageToken} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/confirm-email/ (src/pages/account/confirm-email.astro): confirm a NEW email address for an
 * existing account, from the link mailed to that address (`?token=`, single use, 24 hours). A button
 * press, not the page load, uses the token: email scanners open links too. Confirming signs every
 * device out; the person signs in again with the new address.
 */
export default function ConfirmEmailPage({brand}: {brand: Brand}) {
  const token = pageToken();
  const [done, setDone] = useState<string | null>(null);

  const form = useAuthForm({
    idPrefix: 'confirm',
    initial: {},
    rules: () => ({}),
    async submit() {
      const {result} = await postJson(siteFetch, '/site-api/auth/email/confirm', {token});
      if (result.ok) setDone(result.message ?? 'Your email address is changed.');
      return result.ok ? {ok: true} : result;
    },
  });

  return (
    <AuthShell
      brand={brand}
      title="Confirm your"
      highlight="new email"
      subtitle={token && !done ? 'Your account will sign in with this address from now on. Every device is signed out once you confirm.' : undefined}
    >
      {!token ? (
        <Notice>This link is not complete. Open it again from the email, or ask for a new one in your account.</Notice>
      ) : done ? (
        <DonePanel message={done} link={{href: '/account/login/', text: 'Sign in'}} />
      ) : (
        <form noValidate onSubmit={form.onSubmit} className="grid gap-4">
          <StatusLine status={form.status} />
          <PendingButton type="submit" size="lg" className="w-full" pending={form.pending} pendingLabel="Confirming…">
            Confirm my new email
          </PendingButton>
        </form>
      )}
    </AuthShell>
  );
}
