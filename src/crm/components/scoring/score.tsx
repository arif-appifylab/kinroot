import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Flame, Gauge, Settings2, TrendingDown, TrendingUp} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {ago, dateTime} from '@/lib/format';
import {keys, useMe} from '@/lib/queries';
import {bandFor, bandRangeLabel, decayLabel, defaultScoringSettings, type ScoreBreakdown, type ScoreHistoryItem, type ScoringSettings} from '@/lib/scoring';
import {cn} from '@/lib/utils';

import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '../ui/dialog';
import {Skeleton} from '../ui/misc';
import {LoadError} from '../data-table';

/** Bands, decay and notification settings (every signed-in user can read them). */
export function useScoringSettings() {
  return useQuery({queryKey: [...keys.scoring, 'settings'], queryFn: () => api.get<{settings: ScoringSettings}>('/scoring/settings'), select: (d) => d.settings, staleTime: 5 * 60_000});
}

/** The bands to use right now (defaults until the settings arrive). */
export function useBands() {
  return useScoringSettings().data?.bands ?? defaultScoringSettings().bands;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/** Score with its band, coloured by the band's tone: "52 · Hot". */
export function ScoreBadge({score, compact, className, onClick}: {score: number; compact?: boolean; className?: string; onClick?: () => void}) {
  const band = bandFor(score, useBands());
  const body = (
    <Badge tone={band.tone} className={cn('tabular-nums', onClick && 'cursor-pointer hover:brightness-95', className)}>
      <Flame /> {score}
      {!compact && <span className="font-medium opacity-80">· {band.name}</span>}
    </Badge>
  );
  if (!onClick) return <span title={`Lead score ${score} (${band.name})`}>{body}</span>;
  return (
    <button type="button" onClick={onClick} className="cursor-pointer rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`Lead score ${score}, ${band.name}. Show breakdown`}>
      {body}
    </button>
  );
}

/** Badge on the contact page; opens the score breakdown. */
export function ContactScore({contactId, score}: {contactId: string; score: number}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScoreBadge score={score} onClick={() => setOpen(true)} />
      {open && <ScoreBreakdownDialog contactId={contactId} onClose={() => setOpen(false)} />}
    </>
  );
}

const STATUS: Record<ScoreHistoryItem['status'], string | null> = {
  active: null,
  decayed: 'counts half (older points)',
  expired: 'expired',
  revoked: 'no longer applies',
  rule_off: 'rule switched off',
};

export function ScoreBreakdownDialog({contactId, onClose}: {contactId: string; onClose: () => void}) {
  const {isAdmin} = useMe();
  const settings = useScoringSettings();
  const q = useQuery({queryKey: [...keys.contacts, contactId, 'score'], queryFn: () => api.get<ScoreBreakdown>(`/scoring/contacts/${contactId}`)});
  const d = q.data;
  const bands = settings.data?.bands ?? defaultScoringSettings().bands;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Gauge className="size-5 text-primary" /> Score breakdown</DialogTitle>
          <DialogDescription>Why this contact has its lead score. {settings.data && decayLabel(settings.data.decay)}.</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5">
          {q.isLoading && <Skeleton className="h-40" />}
          {q.error && <LoadError error={q.error} onRetry={() => q.refetch()} title="The score could not be loaded" />}
          {d && (
            <>
              <div className="flex flex-wrap items-center gap-4 rounded-xl bg-accent/50 p-4">
                <div>
                  <p className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">Lead score</p>
                  <p className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">{d.score}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <Badge tone={d.band.tone}><Flame /> {d.band.name}</Badge>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {bandRangeLabel(d.band.key, bands)} · {d.scoreUpdatedAt ? `changed ${ago(d.scoreUpdatedAt)}` : 'no points yet'}
                  </p>
                </div>
                {isAdmin && (
                  <Button variant="secondary" size="sm" asChild>
                    <Link to="/settings/scoring"><Settings2 /> Rules</Link>
                  </Button>
                )}
              </div>

              <section>
                <h3 className="mb-2 text-sm font-bold text-slate-900">What adds up</h3>
                {d.rules.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No rule gives this contact points right now.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {d.rules.map((r) => (
                      <li key={r.ruleId ?? r.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{r.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{r.kind === 'property' ? 'property' : `${r.awards}×`}</span>
                        <span className={cn('w-14 shrink-0 text-right font-bold tabular-nums', r.points < 0 ? 'text-rose-700' : 'text-green-700')}>{signed(r.points)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-bold text-slate-900">History</h3>
                {d.history.length === 0 && <p className="text-sm text-muted-foreground">Nothing has scored yet.</p>}
                <ol className="grid gap-1.5">
                  {d.history.map((h) => {
                    const off = h.status !== 'active';
                    return (
                      <li key={h.id} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                        <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5', h.points < 0 ? 'bg-rose-50 text-rose-600' : 'bg-green-50 text-green-600', off && 'opacity-50')}>
                          {h.points < 0 ? <TrendingDown /> : <TrendingUp />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('text-sm text-slate-800', h.status === 'revoked' && 'line-through decoration-slate-400')}>{h.reason}</p>
                          <p className="text-xs text-muted-foreground">
                            {h.ruleName} · {dateTime(h.createdAt)}
                            {STATUS[h.status] && <> · <span className="font-medium text-amber-700">{STATUS[h.status]}</span></>}
                          </p>
                        </div>
                        <span className={cn('shrink-0 text-sm font-bold tabular-nums', off ? 'text-slate-400' : h.points < 0 ? 'text-rose-700' : 'text-green-700')}>
                          {h.status === 'decayed' ? `${signed(h.effective)} of ${signed(h.points)}` : signed(h.points)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
