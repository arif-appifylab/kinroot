import {CheckCircle2, Loader2, Smile, Star, XCircle} from 'lucide-react';
import {useState} from 'react';

import {PublicCard} from '@/components/public-layout';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/form';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import type {Brand} from '@/lib/brand';
import {PublicPage} from './public-page';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';
import type {CsatState} from '../../server/crm/routes/support-public';

const LABELS = ['', 'Very unhappy', 'Unhappy', 'Okay', 'Happy', 'Very happy'];

function Csat({token, initial, picked}: {token: string; initial: CsatState; picked?: number}) {
  const brand = useBrand();
  const [state, setState] = useState(initial);
  const [rating, setRating] = useState(picked ?? initial?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!state) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="rose" className="mx-auto"><XCircle /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">This link isn't valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">Use the link from the latest email about your request.</p>
      </PublicCard>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setState(await api.post<NonNullable<typeof state>>(`/public/csat/${token}`, {rating, comment}));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="green" className="mx-auto"><CheckCircle2 /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">Thanks for your feedback</h1>
        <p className="mt-2 text-sm text-muted-foreground">It helps {brand.name} get better. If something still isn't right, reply to our last email.</p>
      </PublicCard>
    );
  }

  const shown = hover || rating;
  return (
    <PublicCard className="text-center">
      <IconBadge className="mx-auto"><Smile /></IconBadge>
      <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">How did we do{state.firstName ? `, ${state.firstName}` : ''}?</h1>
      <p className="mt-2 text-sm text-muted-foreground">Your request <span className="font-semibold text-slate-700">#{state.number} {state.subject}</span> was resolved. How satisfied are you with the help from {brand.name}?</p>
      <form onSubmit={(e) => (e.preventDefault(), rating && submit())} className="mt-6 grid gap-4">
        <div className="flex justify-center gap-1" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} – ${LABELS[n]}`} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)} className="cursor-pointer rounded-lg p-1 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">
              <Star className={cn('size-9', n <= shown ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
            </button>
          ))}
        </div>
        <p className="h-5 text-sm font-semibold text-slate-700">{LABELS[shown]}</p>
        <Textarea aria-label="Comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything you'd like to add? (optional)" />
        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
        <div className="flex justify-center">
          <Button type="submit" disabled={!rating || busy}>{busy && <Loader2 className="animate-spin" />} {state.rating ? 'Update rating' : 'Send feedback'}</Button>
        </div>
      </form>
    </PublicCard>
  );
}

/** /csat/<token>: the satisfaction survey from the "How did we do?" email (src/pages/csat/[token].astro). */
export default function CsatPage({brand, token, initial, picked}: {brand: Brand; token: string; initial: CsatState; picked?: number}) {
  return (
    <PublicPage brand={brand}>
      <Csat token={token} initial={initial} picked={picked} />
    </PublicPage>
  );
}
