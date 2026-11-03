import {useState} from 'react';

import {PasswordInput} from '@/components/ui/password-input';
import type {Brand} from '@/lib/brand';

import {postJson} from '../../../lib/form';
import {passwordMeetsRules} from '../../../lib/rules';
import {siteFetch} from '../../../platform/browser';
import {AuthField, DonePanel, Notice, PasswordChecklist, PendingButton, StatusLine, TextLink} from './parts';
import {AuthShell, pageToken} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/reset/ (src/pages/account/reset.astro): choose a new password from an emailed link
 * (`?token=`, single use, 30 minutes). The token leaves the address bar as soon as the page opens
 * and is posted to `/site-api/auth/reset-password`.
 */
export default function ResetPage({brand}: {brand: Brand}) {
  const token = pageToken();
  const [done, setDone] = useState<string | null>(null);

  const form = useAuthForm({
    idPrefix: 'reset',
    initial: {password: '', confirm: ''},
    rules: (values) => ({
      password: [passwordMeetsRules()],
      confirm: [(value: string) => (value === values.password ? null : 'The two passwords are not the same.')],
    }),
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/reset-password', {token, password: values.password});
      if (result.ok) setDone(result.message ?? 'Your password is changed.');
      return result.ok ? {ok: true} : result;
    },
  });

  return (
    <AuthShell brand={brand} title="Choose a new" highlight="password" subtitle={token && !done ? 'Pick one you do not use anywhere else.' : undefined}>
      {!token ? (
        <Notice>
          This link is incomplete. Open the link from the email again, or <TextLink href="/account/forgot/">ask for a new one</TextLink>.
        </Notice>
      ) : done ? (
        <DonePanel message={done} link={{href: '/account/login/', text: 'Sign in'}} />
      ) : (
        <form noValidate onSubmit={form.onSubmit} className="grid gap-4">
          <AuthField id="reset-password" label="New password" error={form.error('password')}>
            <PasswordInput {...form.input('password', 'reset-password-checks')} autoComplete="new-password" />
            <PasswordChecklist id="reset-password-checks" password={form.values.password} tried={form.submitted} />
          </AuthField>
          <AuthField id="reset-confirm" label="Type it again" error={form.error('confirm')}>
            <PasswordInput {...form.input('confirm', 'reset-confirm-checks')} autoComplete="new-password" />
            <PasswordChecklist id="reset-confirm-checks" password={form.values.password} confirm={form.values.confirm} tried={form.submitted} />
          </AuthField>
          <StatusLine status={form.status} />
          <PendingButton type="submit" size="lg" className="w-full" pending={form.pending} pendingLabel="Saving…">
            Save the new password
          </PendingButton>
        </form>
      )}
    </AuthShell>
  );
}
