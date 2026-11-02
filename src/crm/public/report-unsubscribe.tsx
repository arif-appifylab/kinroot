import {CheckCircle2, Loader2, MailCheck, MailX} from 'lucide-react';
import {useState} from 'react';

import {PublicCard} from '@/components/public-layout';
import {Button} from '@/components/ui/button';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import type {Brand} from '@/lib/brand';
import {PublicPage} from './public-page';
import {useBrand} from '@/lib/use-brand';

type State = {email: string; name: string; subscribed: boolean} | null;

function ReportUnsubscribe({token, initial}: {token: string; initial: State}) {
  const brand = useBrand();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{email: string; subscribed: boolean}>(`/public/report-unsubscribe/${token}`);
      setState((s) => (s ? {...s, subscribed: r.subscribed} : s));
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
        <p className="mt-2 text-sm text-muted-foreground">The scheduled email may have been deleted. Reply to the latest email you received and ask to be removed.</p>
      </PublicCard>
    );
  }

  return (
    <PublicCard className="text-center">
      <IconBadge tone={state.subscribed ? 'blue' : 'green'} className="mx-auto">{state.subscribed ? <MailCheck /> : <CheckCircle2 />}</IconBadge>
      <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">{state.subscribed ? 'Report emails' : "You're unsubscribed"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {state.subscribed
          ? `Stop receiving "${state.name}" from ${brand.name} at ${state.email}?`
          : `${state.email} won't get "${state.name}" from ${brand.name} anymore.`}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-destructive">{error}</p>}
      {state.subscribed && (
        <div className="mt-6 flex justify-center">
          <Button onClick={leave} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Unsubscribe
          </Button>
        </div>
      )}
    </PublicCard>
  );
}

/** /report-unsubscribe/<token>: stop one scheduled report email (src/pages/report-unsubscribe/[token].astro). */
export default function ReportUnsubscribePage({brand, token, initial}: {brand: Brand; token: string; initial: State}) {
  return (
    <PublicPage brand={brand}>
      <ReportUnsubscribe token={token} initial={initial} />
    </PublicPage>
  );
}
