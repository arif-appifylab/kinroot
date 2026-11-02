import {createFileRoute} from '@tanstack/react-router';
import {MoreHorizontal, Pencil, Plus, Target, Trash2} from 'lucide-react';
import {useState} from 'react';

import {GoalDialog, GoalItem, useGoals} from '@/components/reports/goals';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, PageHeader, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys, useApiMutation, useMe, useSettings} from '@/lib/queries';
import {GOAL_METRICS, type GoalMetric} from '@/lib/reports';
import type {GoalProgress} from '@/lib/types';

export const Route = createFileRoute('/_app/reports/goals')({
  head: () => ({meta: [{title: pageTitle('Goals')}]}),
  component: GoalsPage,
});

function GoalsPage() {
  const {isAdmin} = useMe();
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  const [offset, setOffset] = useState(0);
  const goals = useGoals({offset});
  const [editing, setEditing] = useState<GoalProgress['goal'] | null | undefined>(undefined);
  const remove = useApiMutation((id: string) => api.del(`/goals/${id}`), {invalidate: [keys.goals], success: 'Goal removed'});
  const rows = goals.data ?? [];
  const byMetric = (Object.keys(GOAL_METRICS) as GoalMetric[]).map((m) => ({metric: m, rows: rows.filter((r) => r.goal.metric === m)})).filter((g) => g.rows.length);

  return (
    <div>
      <PageHeader
        title="Goals"
        description="Monthly and quarterly targets for won revenue, deals won and activities. The tick on each bar marks where today's pace should be."
        actions={
          <>
            <Tabs value={String(offset)} onValueChange={(v) => setOffset(Number(v))}>
              <TabsList>
                <TabsTrigger value="0">This period</TabsTrigger>
                <TabsTrigger value="-1">Last period</TabsTrigger>
              </TabsList>
            </Tabs>
            {isAdmin && <Button onClick={() => setEditing(null)}><Plus /> New goal</Button>}
          </>
        }
      />
      {goals.isLoading && <Skeleton className="h-48 rounded-xl" />}
      {!goals.isLoading && !rows.length && (
        <Card>
          <EmptyState
            icon={<Target />}
            title="No goals yet"
            description={isAdmin ? 'Set a target per person or for the whole team; it repeats every month or quarter.' : 'An admin can set targets for you and the team.'}
            action={isAdmin && <Button onClick={() => setEditing(null)}><Plus /> Set the first goal</Button>}
          />
        </Card>
      )}
      <div className="grid grid-cols-1 gap-6">
        {byMetric.map((g) => (
          <Card key={g.metric}>
            <CardHeader>
              <div>
                <CardTitle>{GOAL_METRICS[g.metric].label}</CardTitle>
                <CardDescription>{g.rows[0]!.period.label}{g.rows.some((r) => r.period.label !== g.rows[0]!.period.label) ? ' and this quarter' : ''}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {g.rows.map((p) => (
                <GoalItem
                  key={p.goal.id}
                  p={p}
                  currency={currency}
                  actions={
                    isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Goal actions"><MoreHorizontal /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setEditing(p.goal)}><Pencil /> Edit</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={async () => (await confirm({title: 'Remove this goal?', confirmLabel: 'Remove', destructive: true})) && remove.mutate(p.goal.id)}><Trash2 /> Remove</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  }
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      {editing !== undefined && <GoalDialog key={editing?.id ?? 'new'} open onOpenChange={(o) => !o && setEditing(undefined)} goal={editing} />}
    </div>
  );
}
