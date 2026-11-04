import {CheckCircle2, Smile, Star, XCircle} from 'lucide-react';
import {useState} from 'react';

import {PublicCard} from '@/components/public-layout';
import {Button} from '@/components/ui/button';
import {Field, Textarea} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
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
  const f = useFormState({rating, comment}, {rating: [(v) => (v ? null : 'Choose from 1 to 5 stars.')], comment: [is.maxLength(5000)]});

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
      if (!f.fail(e)) setError((e as Error).message);
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
      <form {...f.form(() => !busy && void submit())} className="mt-6 grid gap-4">
        <div
          className="flex justify-center gap-1 rounded-lg outline-none"
          role="radiogroup"
          aria-label="Rating"
          tabIndex={-1}
          aria-invalid={f.invalid('rating') || undefined}
          aria-describedby={f.invalid('rating') ? 'csat-rating-error' : undefined}
          onMouseLeave={() => setHover(0)}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} – ${LABELS[n]}`} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)} className="cursor-pointer rounded-lg p-1 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">
              <Star className={cn('size-9', n <= shown ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
            </button>
          ))}
        </div>
        {f.error('rating') ? (
          <p id="csat-rating-error" role="alert" className="h-5 text-sm font-medium text-destructive">{f.error('rating')}</p>
        ) : (
          <p className="h-5 text-sm font-semibold text-slate-700">{LABELS[shown]}</p>
        )}
        <Field label="Comment (optional)" className="text-left" error={f.error('comment')}>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} onBlur={f.blur('comment')} placeholder="Anything you'd like to add?" />
        </Field>
        {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
        <div className="flex justify-center">
          <Button type="submit" pending={busy} pendingLabel="Sending…">{state.rating ? 'Update rating' : 'Send feedback'}</Button>
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
