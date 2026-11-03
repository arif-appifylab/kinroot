import {useState} from 'react';

import {Input} from '@/components/ui/form';
import type {Brand} from '@/lib/brand';

import {postJson} from '../../../lib/form';
import {AUTH_RULES} from '../../../lib/rules';
import {siteFetch} from '../../../platform/browser';
import {AuthField, DonePanel, LinksRow, PendingButton, StatusLine, TextLink} from './parts';
import {AuthShell, useNext, withNext} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/forgot/ (src/pages/account/forgot.astro): posts to `/site-api/auth/forgot-password`,
 * which always answers the same (it never says whether the email has an account). The email itself
 * is relayed by the platform.
 */
export default function ForgotPage({brand}: {brand: Brand}) {
  const next = useNext();
  const [done, setDone] = useState<string | null>(null);

  const form = useAuthForm({
    idPrefix: 'forgot',
    initial: {email: ''},
    rules: () => ({email: AUTH_RULES.email}),
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/forgot-password', values);
      if (result.ok) setDone(result.message ?? 'Check your inbox.');
      return result.ok ? {ok: true} : result;
    },
  });

  return (
    <AuthShell
      brand={brand}
      title="Reset your"
      highlight="password"
      subtitle={done ? undefined : 'Enter your email and we will send you a link to choose a new password.'}
      footer={
        <LinksRow>
          <TextLink href={withNext('/account/login/', next)}>Back to sign in</TextLink>
        </LinksRow>
      }
    >
      {done ? (
        <DonePanel message={done} />
      ) : (
        <form noValidate onSubmit={form.onSubmit} className="grid gap-4">
          <AuthField id="forgot-email" label="Email" error={form.error('email')}>
            <Input {...form.input('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
          </AuthField>
          <StatusLine status={form.status} />
          <PendingButton type="submit" size="lg" className="w-full" pending={form.pending} pendingLabel="Sending…">
            Send the link
          </PendingButton>
        </form>
      )}
    </AuthShell>
  );
}
