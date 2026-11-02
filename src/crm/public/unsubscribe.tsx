import {CheckCircle2, Loader2, MailCheck, MailX} from 'lucide-react';
import {useState} from 'react';

import {PublicCard} from '@/components/public-layout';
import {Button} from '@/components/ui/button';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import type {Brand} from '@/lib/brand';
import {PublicPage} from './public-page';
import {useBrand} from '@/lib/use-brand';

type State = {email: string | null; optedOut: boolean} | null;

function Unsubscribe({token, initial}: {token: string; initial: State}) {
  const brand = useBrand();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function set(optOut: boolean) {
    setBusy(true);
    setError(null);
    try {
      setState(await api.post<NonNullable<State>>(`/public/unsubscribe/${token}`, {optOut}));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="rose" className="mx-auto"><MailX /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">This link isn't valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">It may be incomplete. Use the unsubscribe link from the latest email you received, or reply to that email and ask to be removed.</p>
      </PublicCard>
    );
  }

  return (
    <PublicCard className="text-center">
      <IconBadge tone={state.optedOut ? 'green' : 'blue'} className="mx-auto">{state.optedOut ? <CheckCircle2 /> : <MailCheck />}</IconBadge>
      <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">{state.optedOut ? "You're unsubscribed" : 'Email preferences'}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {state.optedOut
          ? `${brand.name} won't email ${state.email ?? 'this address'} anymore.`
          : `Stop receiving emails from ${brand.name} at ${state.email ?? 'this address'}?`}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-destructive">{error}</p>}
      <div className="mt-6 flex justify-center">
        {state.optedOut ? (
          <Button variant="secondary" onClick={() => set(false)} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Subscribe again
          </Button>
        ) : (
          <Button onClick={() => set(true)} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Unsubscribe
          </Button>
        )}
      </div>
      {changed && !state.optedOut && <p className="mt-4 text-xs text-muted-foreground">Welcome back. You'll get emails again.</p>}
    </PublicCard>
  );
}

/** /unsubscribe/<token>: email preferences from the link in every marketing email (src/pages/unsubscribe/[token].astro). */
export default function UnsubscribePage({brand, token, initial}: {brand: Brand; token: string; initial: State}) {
  return (
    <PublicPage brand={brand}>
      <Unsubscribe token={token} initial={initial} />
    </PublicPage>
  );
}
