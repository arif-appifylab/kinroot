import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {BarChart3, Copy, MoreHorizontal, Plus, Trash2, Users} from 'lucide-react';

import {CHART_ICONS} from '@/components/reports/builder';
import {useSavedReports} from '@/components/reports/hooks';
import {useCatalogue} from '@/components/reports/option-picker';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, PageHeader} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {CHARTS} from '@/lib/reports';
import type {SavedReport} from '@/lib/types';

export const Route = createFileRoute('/_app/reports/saved')({
  head: () => ({meta: [{title: pageTitle('Reports')}]}),
  component: SavedReportsPage,
});

function SavedReportsPage() {
  const {canEdit} = useMe();
  const list = useSavedReports();
  const catalogue = useCatalogue();
  const objectLabel = (key: string) => catalogue.data?.find((o) => o.key === key)?.label ?? key;
  const rows = list.data ?? [];
  return (
    <div>
      <PageHeader
        title="Reports"
        description="Build a chart from any records, save it, export it or pin it to a dashboard."
        actions={
          <Button asChild>
            <Link to="/reports/new"><Plus /> New report</Link>
          </Button>
        }
      />
      {list.isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>}
      {!list.isLoading && !rows.length && (
        <Card>
          <EmptyState
            icon={<BarChart3 />}
            title="No saved reports yet"
            description="Pick an object, what to measure and how to group it. Save it to reuse it on dashboards."
            action={<Button asChild><Link to="/reports/new"><Plus /> Build a report</Link></Button>}
          />
        </Card>
      )}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-4 py-3">Report</th>
                  <th className="px-4 py-3">Data</th>
                  <th className="px-4 py-3">Chart</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((r) => <ReportRow key={r.id} report={r} objectLabel={objectLabel(r.config.object)} canEdit={canEdit} />)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ReportRow({report, objectLabel, canEdit}: {report: SavedReport; objectLabel: string; canEdit: boolean}) {
  const {me, isAdmin} = useMe();
  const navigate = useNavigate();
  const Icon = CHART_ICONS[report.config.chart] ?? BarChart3;
  const duplicate = useApiMutation(() => api.post<{report: SavedReport}>(`/reports/${report.id}/duplicate`), {
    invalidate: [keys.reports],
    success: 'Report duplicated',
    onSuccess: (r) => navigate({to: '/reports/$reportId', params: {reportId: r.report.id}}),
  });
  const remove = useApiMutation(() => api.del(`/reports/${report.id}`), {invalidate: [keys.reports, keys.dashboards], success: 'Report deleted'});
  const mine = report.ownerId === me.id || isAdmin;
  return (
    <tr className="group hover:bg-slate-50/60">
      <td className="px-4 py-3">
        <Link to="/reports/$reportId" params={{reportId: report.id}} className="font-semibold text-slate-900 hover:text-primary">{report.name}</Link>
        <div className="mt-0.5 flex items-center gap-2">
          {report.shared ? <Badge tone="green"><Users /> Team</Badge> : <Badge>Private</Badge>}
          {report._count.widgets > 0 && <span className="text-xs text-muted-foreground">On {report._count.widgets} dashboard{report._count.widgets === 1 ? '' : 's'}</span>}
        </div>
      </td>
      <td className="px-4 py-3 text-slate-600">{objectLabel}</td>
      <td className="px-4 py-3 text-slate-600">
        <span className="inline-flex items-center gap-1.5"><Icon className="size-4 text-slate-400" /> {CHARTS[report.config.chart]}</span>
      </td>
      <td className="px-4 py-3">
        {report.owner && (
          <span className="inline-flex items-center gap-2 text-slate-600">
            <Avatar name={report.owner.name} color={report.owner.color} src={report.owner.avatarUrl} size="xs" /> {report.owner.name}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-slate-500">{ago(report.updatedAt)}</td>
      <td className="px-2 py-3">
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Report actions"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => duplicate.mutate(undefined)}><Copy /> Duplicate</DropdownMenuItem>
              {mine && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${report.name}"?`, description: `It is removed from every dashboard.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}
