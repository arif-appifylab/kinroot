import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {AlarmClock, ArrowRight, CalendarClock, CheckCircle2, CircleDollarSign, Gauge, Hourglass, Target, Trophy} from 'lucide-react';
import {useState} from 'react';

import {ValueBarChart} from '@/components/charts';
import {GoalsWidget} from '@/components/reports/goals';
import {TaskRow} from '@/components/tasks';
import {Badge} from '@/components/ui/badge';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/form';
import {EmptyState, IconBadge, PageHeader, Skeleton} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {dueLabel, money, percent} from '@/lib/format';
import {keys, useMe, usePipelines, useSettings, useTeam} from '@/lib/queries';
import type {Stage, Task, UserLite} from '@/lib/types';

export const Route = createFileRoute('/_app/')({
  head: () => ({meta: [{title: pageTitle('Dashboard')}]}),
  component: Dashboard,
});

type DashboardData = {
  empty?: boolean;
  pipeline: {id: string; name: string; rottingDays: number};
  totals: {openCount: number; openValue: number; weighted: number; wonCount: number; wonValue: number; lostCount: number; lostValue: number; winRate: number | null; avgCycleDays: number | null; avgDealSize: number | null; rotting: number};
  byStage: {id: string; name: string; color: string; probability: number; count: number; value: number; weighted: number}[];
  funnel: {id: string; name: string; reached: number; rate: number}[];
  months: {month: string; won: number; lost: number}[];
  lostReasons: {reason: string; count: number; value: number}[];
  closingSoon: {id: string; title: string; value: number; currency: string; expectedCloseDate: string; stage: Stage; company: {id: string; name: string} | null; owner: UserLite | null}[];
  myTasks: Task[];
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function Stat({icon, tone, label, value, sub}: {icon: React.ReactNode; tone: 'blue' | 'teal' | 'green' | 'amber' | 'violet' | 'rose'; label: string; value: string; sub?: React.ReactNode}) {
  return (
    <Card interactive className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <IconBadge tone={tone} className="size-9 [&_svg]:size-[18px]">{icon}</IconBadge>
      </div>
      <p className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

function Dashboard() {
  const {me} = useMe();
  const pipelines = usePipelines();
  const team = useTeam();
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  const [filters, setFilters] = useState({pipelineId: '', ownerId: '', days: '90'});
  const data = useQuery({
    queryKey: [...keys.dashboard, filters],
    queryFn: () => api.get<DashboardData>('/dashboard', filters),
  });
  const d = data.data;

  return (
    <div>
      <PageHeader
        title={
          <>
            {greeting()}, <span className="text-brand">{me.name.split(' ')[0]}</span>
          </>
        }
        description="Here's how your pipeline is moving."
        actions={
          <>
            {(pipelines.data?.length ?? 0) > 1 && (
              <NativeSelect size="sm" aria-label="Pipeline" value={filters.pipelineId} onChange={(e) => setFilters({...filters, pipelineId: e.target.value})}>
                {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            )}
            <NativeSelect size="sm" aria-label="Owner" value={filters.ownerId} onChange={(e) => setFilters({...filters, ownerId: e.target.value})}>
              <option value="">Everyone</option>
              {team.data?.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Just me' : u.name}</option>)}
            </NativeSelect>
            <NativeSelect size="sm" aria-label="Date range" value={filters.days} onChange={(e) => setFilters({...filters, days: e.target.value})}>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option>
            </NativeSelect>
          </>
        }
      />

      {!d ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({length: 4}).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : d.empty ? (
        <Card><EmptyState icon={<Target />} title="No pipeline yet" description="Create a pipeline in Settings to start tracking deals." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={<CircleDollarSign />} tone="blue" label="Open pipeline" value={money(d.totals.openValue, currency)} sub={`${d.totals.openCount} open deals in ${d.pipeline.name}`} />
            <Stat icon={<Gauge />} tone="teal" label="Weighted forecast" value={money(d.totals.weighted, currency)} sub="Value × stage probability" />
            <Stat icon={<Trophy />} tone="green" label={`Won · last ${filters.days}d`} value={money(d.totals.wonValue, currency)} sub={`${d.totals.wonCount} won · ${d.totals.lostCount} lost`} />
            <Stat
              icon={<Target />}
              tone="violet"
              label="Win rate"
              value={percent(d.totals.winRate)}
              sub={d.totals.avgCycleDays !== null ? `Avg. ${Math.round(d.totals.avgCycleDays)} days to close · ${money(d.totals.avgDealSize ?? 0, currency, true)} avg.` : 'No closed deals in range'}
            />
          </div>

          <GoalsWidget />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <div>
                  <CardTitle>Open value by stage</CardTitle>
                  <CardDescription>Where the money sits right now</CardDescription>
                </div>
                {d.totals.rotting > 0 && (
                  <Link to="/deals" search={{rotting: '1'}}>
                    <Badge tone="amber" className="cursor-pointer"><Hourglass /> {d.totals.rotting} going stale</Badge>
                  </Link>
                )}
              </CardHeader>
              <CardContent>
                <ValueBarChart data={d.byStage} xKey="name" currency={currency} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Stage conversion</CardTitle>
                  <CardDescription>Deals created in range that reached each stage</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3.5">
                {d.funnel.map((s) => (
                  <div key={s.id}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-700">{s.name}</span>
                      <span className="font-semibold text-slate-900">{percent(s.rate)} <span className="font-normal text-slate-400">· {s.reached}</span></span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-brand transition-all duration-500" style={{width: `${Math.max(s.rate * 100, 2)}%`}} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Your next steps</CardTitle>
                  <CardDescription>Overdue and due today</CardDescription>
                </div>
                <Link to="/tasks" className="group inline-flex items-center gap-1 text-sm font-semibold text-primary">
                  All tasks <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </CardHeader>
              <CardContent className="px-2 pt-3">
                {d.myTasks.length ? (
                  d.myTasks.map((t) => <TaskRow key={t.id} task={t} compact />)
                ) : (
                  <EmptyState className="py-8" icon={<CheckCircle2 />} title="All clear" description="Nothing due today. Nice work." />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Closing soon</CardTitle>
                  <CardDescription>Open deals by expected close date</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="grid gap-1 px-2 pt-3">
                {d.closingSoon.length ? (
                  d.closingSoon.map((deal) => (
                    <Link key={deal.id} to="/deals/$dealId" params={{dealId: deal.id}} className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/60">
                      <span className="size-2 shrink-0 rounded-full" style={{background: deal.stage.color}} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-800">{deal.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{deal.company?.name ?? 'No company'} · {deal.stage.name}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-slate-900">{money(deal.value, deal.currency, true)}</p>
                        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CalendarClock className="size-3" /> {dueLabel(deal.expectedCloseDate)}</p>
                      </div>
                    </Link>
                  ))
                ) : (
                  <EmptyState className="py-8" icon={<AlarmClock />} title="No close dates set" description="Add expected close dates to deals to see them here." />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Won revenue</CardTitle>
                  <CardDescription>Last 6 months</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <ValueBarChart
                  height={170}
                  currency={currency}
                  xKey="label"
                  data={d.months.map((m) => ({label: new Date(`${m.month}-01T00:00:00`).toLocaleString('en-US', {month: 'short'}), value: m.won}))}
                />
                {d.lostReasons.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="mb-2 text-xs font-bold tracking-wider text-slate-400 uppercase">Why we lose</p>
                    <ul className="grid gap-1.5">
                      {d.lostReasons.map((r) => (
                        <li key={r.reason} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">{r.reason}</span>
                          <span className="font-semibold text-slate-900">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
