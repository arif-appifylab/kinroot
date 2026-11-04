import {useState} from 'react';

import type {Brand} from '@/lib/brand';

import {postJson} from '../../../lib/form';
import {siteFetch} from '../../../platform/browser';
import {DonePanel, Notice, PendingButton, StatusLine} from './parts';
import {AuthShell} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/cancel-email/ (src/pages/account/cancel-email.astro): the link mailed to the OLD address
 * when someone asks to change the account's email (`?token=`). While the change waits, this cancels
 * it, and the account keeps signing in with this address. A button press, not the page load, uses the
 * token: email scanners open links too.
 */
let token: string | null | undefined;

/**
 * The link's `?token=` (`<change id>.<proof>`, not the 43-character shape `takeToken` accepts), taken
 * out of the address bar at once and kept for later renders. The server checks it.
 */
function cancelToken(): string | null {
  if (token !== undefined) return token;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('token');
  if (raw) {
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  token = raw && raw.length <= 200 ? raw : null;
  return token;
}

export default function CancelEmailPage({brand}: {brand: Brand}) {
  const token = cancelToken();
  const [done, setDone] = useState<string | null>(null);

  const form = useAuthForm({
    idPrefix: 'cancel',
    initial: {},
    rules: () => ({}),
    async submit() {
      const {result} = await postJson(siteFetch, '/site-api/auth/email/cancel', {token});
      if (result.ok) setDone(result.message ?? 'The change is cancelled.');
      return result.ok ? {ok: true} : result;
    },
  });

  return (
    <AuthShell
      brand={brand}
      title="Cancel the"
      highlight="email change"
      subtitle={token && !done ? 'Your account keeps signing in with this address.' : undefined}
    >
      {!token ? (
        <Notice>This link is not complete. Open it again from the email.</Notice>
      ) : done ? (
        <DonePanel message={done} link={{href: '/account/login/', text: 'Sign in'}} />
      ) : (
        <form noValidate onSubmit={form.onSubmit} className="grid gap-4">
          <StatusLine status={form.status} />
          <PendingButton type="submit" size="lg" className="w-full" pending={form.pending} pendingLabel="Cancelling…">
            Cancel the change
          </PendingButton>
        </form>
      )}
    </AuthShell>
  );
}
