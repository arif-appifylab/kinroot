import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {ArrowRight, CircleAlert, CircleCheck, CircleX, TrendingUp} from 'lucide-react';
import {useState} from 'react';

import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {Avatar} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {money} from '@/lib/format';
import {keys, useApiMutation, useSettings, useTeam} from '@/lib/queries';
import {ACTIVITY_KINDS, GOAL_METRICS, type GoalMetric} from '@/lib/reports';
import type {GoalProgress} from '@/lib/types';

import {viewerTz} from './report-view';

export function useGoals(params: {offset?: number; mine?: boolean} = {}) {
  return useQuery({
    queryKey: [...keys.goals, params],
    queryFn: () => api.get<{rows: GoalProgress[]}>('/goals', {tz: viewerTz(), offset: params.offset ?? 0, mine: params.mine ? '1' : undefined}),
    select: (d) => d.rows,
  });
}

// Status colours are reserved for state and always come with an icon + label.
const STATUS = {
  achieved: {label: 'Achieved', icon: CircleCheck, color: 'var(--status-good)'},
  on_track: {label: 'On track', icon: TrendingUp, color: 'var(--status-good)'},
  behind: {label: 'Behind pace', icon: CircleAlert, color: 'var(--status-warning)'},
  missed: {label: 'Missed', icon: CircleX, color: 'var(--status-critical)'},
} as const;

export function goalValue(metric: string, v: number, currency: string, compact = false) {
  return GOAL_METRICS[metric as GoalMetric]?.unit === 'currency' ? money(v, currency, compact) : new Intl.NumberFormat('en-US', {maximumFractionDigits: 0}).format(v);
}

export function goalTitle(g: GoalProgress['goal']) {
  const m = GOAL_METRICS[g.metric as GoalMetric]?.label ?? g.metric;
  if (g.metric !== 'activities' || !g.kinds.length || g.kinds.length === 3) return m;
  return g.kinds.map((k) => ACTIVITY_KINDS[k as keyof typeof ACTIVITY_KINDS]).join(' + ');
}

/** Progress meter: the fill carries the state, the track is a lighter step of it, the tick marks where today's pace should be. */
export function GoalBar({p, currency}: {p: GoalProgress; currency: string}) {
  const s = STATUS[p.status];
  const pct = p.goal.target ? Math.min(1, p.actual / p.goal.target) : 0;
  const pace = Math.min(1, p.elapsed);
  return (
    <div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full"
        style={{background: `color-mix(in oklab, ${s.color} 16%, var(--card))`}}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={p.goal.target}
        aria-valuenow={p.actual}
        aria-label={`${goalTitle(p.goal)}: ${goalValue(p.goal.metric, p.actual, currency)} of ${goalValue(p.goal.metric, p.goal.target, currency)}`}
      >
        <div className="h-full rounded-full transition-all duration-500" style={{width: `${Math.max(pct * 100, pct ? 2 : 0)}%`, background: s.color}} />
        {p.status !== 'achieved' && pace > 0 && pace < 1 && <div className="absolute inset-y-0 w-0.5 bg-slate-700/70" style={{left: `calc(${pace * 100}% - 1px)`}} title="Where today's pace should be" />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
          <s.icon className="size-3.5" style={{color: s.color}} aria-hidden />
          {s.label}
        </span>
        <span className="text-muted-foreground">
          {Math.round((p.goal.target ? p.actual / p.goal.target : 0) * 100)}%
          {p.status !== 'achieved' && p.status !== 'missed' && p.projected !== null && ` · on pace for ${goalValue(p.goal.metric, p.projected, currency, true)}`}
        </span>
      </div>
    </div>
  );
}

/** One goal: who, what, actual vs target, meter. */
export function GoalItem({p, currency, actions}: {p: GoalProgress; currency: string; actions?: React.ReactNode}) {
  return (
    <div className="grid gap-2.5">
      <div className="flex items-start gap-3">
        {p.goal.user ? <Avatar name={p.goal.user.name} color={p.goal.user.color} src={p.goal.user.avatarUrl} size="sm" /> : <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">ALL</span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{p.goal.user?.name ?? 'Whole team'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {goalTitle(p.goal)} · {p.period.label}
          </p>
        </div>
        <p className="text-right text-sm">
          <span className="font-bold text-slate-900">{goalValue(p.goal.metric, p.actual, currency, true)}</span>
          <span className="text-muted-foreground"> / {goalValue(p.goal.metric, p.goal.target, currency, true)}</span>
        </p>
        {actions}
      </div>
      <GoalBar p={p} currency={currency} />
    </div>
  );
}

/** Small card on the home dashboard: the signed-in user's goals (and team goals) this period. */
export function GoalsWidget() {
  const goals = useGoals({mine: true});
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  if (!goals.data?.length) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Goals</CardTitle>
          <CardDescription>Progress this period against your targets</CardDescription>
        </div>
        <Link to="/reports/goals" className="group inline-flex items-center gap-1 text-sm font-semibold text-primary">
          All goals <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {goals.data.slice(0, 4).map((p) => <GoalItem key={p.goal.id} p={p} currency={currency} />)}
      </CardContent>
    </Card>
  );
}

type GoalDraft = {metric: GoalMetric; period: 'MONTH' | 'QUARTER'; target: string; userId: string; kinds: string[]};

export function GoalDialog({open, onOpenChange, goal}: {open: boolean; onOpenChange: (o: boolean) => void; goal?: GoalProgress['goal'] | null}) {
  const team = useTeam();
  const [draft, setDraft] = useState<GoalDraft>(() =>
    goal ? {metric: goal.metric as GoalMetric, period: goal.period as 'MONTH' | 'QUARTER', target: String(goal.target), userId: goal.userId ?? '', kinds: goal.kinds} : {metric: 'won_revenue', period: 'MONTH', target: '', userId: '', kinds: []},
  );
  const save = useApiMutation(
    () => {
      const body = {metric: draft.metric, period: draft.period, target: Number(draft.target), userId: draft.userId || null, kinds: draft.kinds};
      return goal ? api.patch(`/goals/${goal.id}`, body) : api.post('/goals', body);
    },
    {invalidate: [keys.goals], success: goal ? 'Goal updated' : 'Goal added', onSuccess: () => onOpenChange(false)},
  );
  const f = useFormState(draft, {
    target: [is.required('Enter a target, like 20.'), is.number({max: 1e12, message: 'Enter a target above 0, like 20.'}), (v) => Number(v) <= 0 && 'Enter a target above 0, like 20.'],
  });
  // No kinds stored = all three.
  const toggleKind = (k: string) => {
    const current = draft.kinds.length ? draft.kinds : Object.keys(ACTIVITY_KINDS);
    const next = current.includes(k) ? current.filter((x) => x !== k) : [...current, k];
    if (next.length) setDraft({...draft, kinds: next.length === 3 ? [] : next});
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{goal ? 'Edit goal' : 'New goal'}</DialogTitle>
        </DialogHeader>
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="contents">
          <DialogBody>
            <Field label="Who">
              <NativeSelect value={draft.userId} onChange={(e) => setDraft({...draft, userId: e.target.value})}>
                <option value="">Whole team</option>
                {team.data?.filter((u) => u.active && u.role !== 'VIEWER').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Goal">
                <NativeSelect value={draft.metric} onChange={(e) => setDraft({...draft, metric: e.target.value as GoalMetric})}>
                  {Object.entries(GOAL_METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Every">
                <NativeSelect value={draft.period} onChange={(e) => setDraft({...draft, period: e.target.value as 'MONTH' | 'QUARTER'})}>
                  <option value="MONTH">Month</option>
                  <option value="QUARTER">Quarter</option>
                </NativeSelect>
              </Field>
            </div>
            {draft.metric === 'activities' && (
              <Field label="Counts" group hint="Emails include emails sent from the CRM and emails logged by hand.">
                <div className="flex flex-wrap gap-4">
                  {Object.entries(ACTIVITY_KINDS).map(([k, l]) => (
                    <label key={k} className="inline-flex items-center gap-2 text-sm text-slate-700">
                      <Checkbox checked={!draft.kinds.length || draft.kinds.includes(k)} onCheckedChange={() => toggleKind(k)} /> {l}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <Field label={`Target per ${draft.period === 'MONTH' ? 'month' : 'quarter'}`} error={f.error('target')}>
              <Input type="number" inputMode="decimal" step="any" value={draft.target} onChange={(e) => setDraft({...draft, target: e.target.value})} onBlur={f.blur('target')} placeholder={draft.metric === 'won_revenue' ? '50000' : '20'} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel={goal ? 'Saving…' : 'Adding…'}>{goal ? 'Save goal' : 'Add goal'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
