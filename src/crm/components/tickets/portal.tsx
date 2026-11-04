import {Loader2, LogIn, UserPlus} from 'lucide-react';
import {useCallback, useEffect, useState} from 'react';

import {siteFetch} from '../../../platform/browser';
import {STATUS, type TicketStatus} from '@/lib/tickets';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';

export type PortalSession = {firstName: string; email: string | null};

/** Loads a portal page's data. The customer's session is the site's own sign-in (`/account/login/`). */
export function usePortal<T extends {session: PortalSession | null}>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await siteFetch(`/site-api/crm${path}`);
      const body = (await res.json().catch(() => ({}))) as T & {error?: string; message?: string};
      if (!res.ok) throw new Error(body.message ?? body.error ?? 'Something went wrong. Try again.');
      setData(body);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => void load(), [load]);
  return {data, setData, error, reload: load};
}

export function CustomerStatus({status, className}: {status: TicketStatus; className?: string}) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-slate-700', className)}>
      <span className="size-1.5 rounded-full" style={{background: s.color}} />
      {s.customer}
    </span>
  );
}

/** Signing in is the site's: with a 6-digit code emailed to the address, or a password. */
export function SignInPrompt({title = 'Find your requests', intro}: {title?: string; intro?: string}) {
  const back = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
  return (
    <div className="grid gap-3">
      <div>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{intro ?? 'Sign in with the email you contacted us from.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={`/account/login/?next=${back}`}>
            <LogIn /> Sign in
          </a>
        </Button>
        <Button asChild variant="secondary">
          <a href={`/account/register/?next=${back}`}>
            <UserPlus /> Create your account
          </a>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">No password needed: you can sign in with a code we email you.</p>
    </div>
  );
}

export function PortalNav({session}: {session: PortalSession | null}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    // The site's sign-out, then back to the portal's front page; a failure says so and stays here.
    try {
      const res = await siteFetch('/site-api/auth/logout', {method: 'POST'});
      if (!res.ok) throw new Error();
      window.location.href = '/support/';
    } catch {
      setSignOutError('You are still signed in: that did not go through. Check your connection and try again.');
      setSigningOut(false);
    }
  }
  return (
    <div className="mx-auto mt-6 flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:mt-10">
      <a href="/support/" className="font-semibold text-primary hover:underline">New request</a>
      {session && <a href="/support/tickets/" className="font-semibold text-primary hover:underline">My requests</a>}
      {session && (
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
          {session.email} ·{' '}
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            aria-busy={signingOut || undefined}
            className="inline-flex cursor-pointer items-center gap-1 rounded font-semibold text-slate-600 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-wait disabled:opacity-70"
          >
            {signingOut && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </span>
      )}
      {signOutError && (
        <p role="alert" className="w-full text-right text-xs font-medium text-destructive">
          {signOutError}
        </p>
      )}
    </div>
  );
}
