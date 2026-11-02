import {createFileRoute, Link} from '@tanstack/react-router';
import {BarChart3, CalendarClock, LayoutGrid} from 'lucide-react';
import {useState} from 'react';

import {ScheduleDrawer, ScheduleMenu, ScheduleStatusBadge, useSchedules, whenLocal, type ScheduleRow} from '@/components/reports/schedules';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Avatar, EmptyState, PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {useMe} from '@/lib/queries';

export const Route = createFileRoute('/_app/reports/schedules')({
  head: () => ({meta: [{title: pageTitle('Scheduled emails')}]}),
  component: SchedulesPage,
});

/** Every scheduled report email: admins see all, members their own. */
function SchedulesPage() {
  const {isAdmin, canEdit} = useMe();
  const list = useSchedules();
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const rows = list.data ?? [];
  return (
    <div>
      <PageHeader
        title="Scheduled emails"
        description={`Reports and dashboards emailed on a schedule. ${isAdmin ? 'You see everyone’s.' : 'You see the ones you set up.'} Next sends show in your time zone.`}
      />
      {list.isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>}
      {!list.isLoading && !rows.length && (
        <Card>
          <EmptyState
            icon={<CalendarClock />}
            title="No scheduled emails yet"
            description="Open a report or a dashboard and choose “Schedule email” to send it daily, weekly or monthly."
            action={<Button asChild><Link to="/reports/saved">Pick a report</Link></Button>}
          />
        </Card>
      )}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-4 py-3">Report or dashboard</th>
                  <th className="px-4 py-3">Frequency</th>
                  <th className="px-4 py-3">Next send</th>
                  <th className="px-4 py-3">Last status</th>
                  <th className="px-4 py-3 text-right">Recipients</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        {row.kind === 'report' ? <BarChart3 className="size-4 shrink-0 text-slate-400" /> : <LayoutGrid className="size-4 shrink-0 text-slate-400" />}
                        {row.reportId ? (
                          <Link to="/reports/$reportId" params={{reportId: row.reportId}} className="font-semibold text-slate-900 hover:text-primary">{row.name}</Link>
                        ) : (
                          <Link to="/reports/dashboards/$dashboardId" params={{dashboardId: row.dashboardId!}} className="font-semibold text-slate-900 hover:text-primary">{row.name}</Link>
                        )}
                      </span>
                      <div className="mt-0.5 text-xs text-muted-foreground">{row.kind === 'report' ? 'Report' : 'Dashboard'}{row.range === 'previous' && ' · previous period'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.frequencyLabel}</td>
                    <td className="px-4 py-3 text-slate-600">{row.active ? whenLocal(row.nextRunAt) : <Badge>Paused</Badge>}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <ScheduleStatusBadge row={row} />
                        {row.lastSentAt && <span className="text-xs text-muted-foreground">Last sent {ago(row.lastSentAt)}</span>}
                        {row.lastError && row.lastStatus !== 'sent' && <span className="max-w-64 truncate text-xs text-destructive" title={row.lastError}>{row.lastError}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{row.recipients}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2 text-slate-600"><Avatar name={row.owner.name} color={row.owner.color} src={row.owner.avatarUrl} size="xs" /> {row.owner.name}</span>
                    </td>
                    <td className="px-2 py-3">{canEdit && <ScheduleMenu row={row} onEdit={() => setEditing(row)} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {editing && (
        <ScheduleDrawer
          open
          onOpenChange={(o) => !o && setEditing(null)}
          editing={editing}
          target={{reportId: editing.reportId ?? undefined, dashboardId: editing.dashboardId ?? undefined, name: editing.name}}
        />
      )}
    </div>
  );
}
