import {Link} from '@tanstack/react-router';
import {Loader2, MailCheck} from 'lucide-react';
import {useCallback, useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {STATUS, type TicketStatus} from '@/lib/tickets';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';
import {Field, Input} from '../ui/form';

export type PortalSession = {firstName: string; email: string | null};

/**
 * Loads a portal page's data. A magic link arrives as ?t=<token>: it is traded
 * for an httpOnly cookie once, then dropped from the address bar.
 */
export function usePortal<T extends {session: PortalSession | null}>(path: string, token: string | undefined) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      if (token) {
        await api.post('/public/support/session', {token});
        const url = new URL(window.location.href);
        url.searchParams.delete('t');
        window.history.replaceState(window.history.state, '', url.pathname + url.search);
      }
      setData(await api.get<T>(path));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path, token]);
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

/** "Email me a link" form, used when there's no valid session. */
export function RequestLink({title = 'Find your requests', intro}: {title?: string; intro?: string}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/public/support/link', {email});
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex items-start gap-3 rounded-xl bg-green-50 p-4 text-sm text-green-800">
        <MailCheck className="mt-0.5 size-4 shrink-0" />
        <p>If we have requests for <span className="font-semibold">{email}</span>, a link to them is on its way. It works for 30 days.</p>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => (e.preventDefault(), email && submit())} className="grid gap-3">
      <div>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{intro ?? "Enter the email you contacted us from and we'll send you a link. No password needed."}</p>
      </div>
      <Field label="Email" htmlFor="pl-email">
        <div className="flex gap-2">
          <Input id="pl-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          <Button type="submit" variant="secondary" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Email me a link</Button>
        </div>
      </Field>
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
    </form>
  );
}

export function PortalNav({session}: {session: PortalSession | null}) {
  async function signOut() {
    await api.post('/public/support/logout').catch(() => {});
    window.location.href = '/support';
  }
  return (
    <div className="mx-auto mt-6 flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:mt-10">
      <Link to="/support" className="font-semibold text-primary hover:underline">New request</Link>
      {session && <Link to="/support/tickets" className="font-semibold text-primary hover:underline">My requests</Link>}
      {session && (
        <span className="ml-auto text-muted-foreground">
          {session.email} ·{' '}
          <button onClick={signOut} className="cursor-pointer font-semibold text-slate-600 hover:text-primary">Sign out</button>
        </span>
      )}
    </div>
  );
}
