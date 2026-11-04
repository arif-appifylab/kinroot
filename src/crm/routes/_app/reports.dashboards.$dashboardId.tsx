import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, ArrowRight, Check, Copy, Download, LayoutGrid, MoreHorizontal, Pencil, Plus, Trash2, Users} from 'lucide-react';
import {useEffect, useState} from 'react';

import {LoadError} from '@/components/data-table';
import {FilterBar} from '@/components/filter-bar';
import {RangeFields} from '@/components/reports/builder';
import {useSavedReports} from '@/components/reports/hooks';
import {ReportView, runParams} from '@/components/reports/report-view';
import {ScheduleEmailButton} from '@/components/reports/schedules';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, PageHeader, Skeleton} from '@/components/ui/misc';
import {ApiError, api, qs} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys, useApiMutation, useMe, useSettings, useTeam} from '@/lib/queries';
import type {ReportResult} from '@/lib/reports';
import type {DashboardDetail, DashboardFilters, DashboardWidgetSize} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/reports/dashboards/$dashboardId')({
  head: () => ({meta: [{title: pageTitle('Dashboard')}]}),
  component: DashboardPage,
});

// Responsive grid: 1 column on phones, 2 on tablets, 4 on wide screens.
const SPAN: Record<DashboardWidgetSize, string> = {small: 'xl:col-span-1', medium: 'md:col-span-1 xl:col-span-2', large: 'md:col-span-2 xl:col-span-4'};
const HEIGHT: Record<DashboardWidgetSize, number> = {small: 180, medium: 240, large: 280};

type Widget = DashboardDetail['widgets'][number];

function DashboardPage() {
  const {dashboardId} = Route.useParams();
  // Fresh state (filters, edit mode) per dashboard.
  return <DashboardView key={dashboardId} dashboardId={dashboardId} />;
}

function DashboardView({dashboardId}: {dashboardId: string}) {
  const {me, isAdmin, canEdit} = useMe();
  const team = useTeam();
  const navigate = useNavigate();
  const query = useQuery({queryKey: [...keys.dashboards, dashboardId], queryFn: () => api.get<{dashboard: DashboardDetail}>(`/dashboards/${dashboardId}`), select: (d) => d.dashboard, retry: false});
  const d = query.data;
  const editable = !!d && canEdit && (d.ownerId === me.id || isAdmin);
  // Starts from the dashboard's saved filters; local changes win from then on.
  const [local, setFilters] = useState<DashboardFilters | null>(null);
  const filters = local ?? d?.filters ?? {};
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const patch = useApiMutation((body: Record<string, unknown>) => api.patch(`/dashboards/${dashboardId}`, body), {invalidate: [keys.dashboards]});
  const duplicate = useApiMutation(() => api.post<{dashboard: DashboardDetail}>(`/dashboards/${dashboardId}/duplicate`), {
    invalidate: [keys.dashboards],
    success: 'Dashboard duplicated',
    onSuccess: (r) => navigate({to: '/reports/dashboards/$dashboardId', params: {dashboardId: r.dashboard.id}}),
  });
  const remove = useApiMutation(() => api.del(`/dashboards/${dashboardId}`), {invalidate: [keys.dashboards], success: 'Dashboard deleted', onSuccess: () => navigate({to: '/reports'})});
  // Filters don't invalidate: the widgets already refetch for the new range.
  const saveFilters = useApiMutation((next: DashboardFilters) => api.patch(`/dashboards/${dashboardId}`, {filters: next}));
  const reorder = useApiMutation((ids: string[]) => api.post(`/dashboards/${dashboardId}/reorder`, {ids}), {invalidate: [keys.dashboards]});

  // Editors save the filters as the dashboard's default; everyone else filters just for themselves.
  function changeFilters(next: DashboardFilters) {
    setFilters(next);
    if (editable && (next.range?.preset !== 'custom' || (next.range.from && next.range.to))) saveFilters.mutate(next);
  }

  function move(w: Widget, dir: -1 | 1) {
    const ids = d!.widgets.map((x) => x.id);
    const i = ids.indexOf(w.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  }

  if (query.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (query.isError && !(query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403))) {
    return (
      <Card>
        <h1 className="sr-only">Dashboard</h1>
        <LoadError error={query.error} onRetry={() => query.refetch()} />
      </Card>
    );
  }
  if (!d) {
    return (
      <Card>
        <h1 className="sr-only">Dashboard not found</h1>
        <EmptyState icon={<LayoutGrid />} title="Dashboard not found" description="It was deleted, or it is private to someone else." action={<Button asChild><Link to="/reports">All dashboards</Link></Button>} />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={d.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {d.shared ? <Badge tone="green"><Users /> Shared with team</Badge> : <Badge>Private</Badge>}
            <span>by {d.owner?.name ?? 'Unknown'}</span>
          </span>
        }
        actions={
          <>
            {editable && (
              <Button variant={editing ? 'default' : 'secondary'} onClick={() => setEditing(!editing)}>
                {editing ? <><Check /> Done</> : <><Pencil /> Edit layout</>}
              </Button>
            )}
            {editable && <Button variant="secondary" onClick={() => setAdding(true)}><Plus /> Add report</Button>}
            {canEdit && d.widgets.length > 0 && <ScheduleEmailButton target={{dashboardId: d.id, name: d.name}} />}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Dashboard actions" pending={duplicate.isPending || remove.isPending}><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {editable && <DropdownMenuItem onSelect={() => setRenaming(true)}><Pencil /> Rename</DropdownMenuItem>}
                  {editable && (
                    <DropdownMenuItem onSelect={() => patch.mutate({shared: !d.shared})}>
                      <Users /> {d.shared ? 'Make private' : 'Share with team'}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => duplicate.mutate(undefined)}><Copy /> Duplicate</DropdownMenuItem>
                  {editable && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete the dashboard "${d.name}"?`, description: `Its reports are kept.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {/* One filter row scopes every widget below it. */}
      <FilterBar className="mb-6">
        <RangeFields compact range={filters.range} onChange={(range) => changeFilters({...filters, range})} />
        <NativeSelect size="sm" aria-label="Owner" value={filters.ownerId ?? ''} onChange={(e) => changeFilters({...filters, ownerId: e.target.value || undefined})}>
          <option value="">Everyone</option>
          {team.data?.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Just me' : u.name}</option>)}
        </NativeSelect>
        <span className="text-xs text-muted-foreground">Applies to every report on this dashboard{editable ? ' and is saved as its default' : ''}.</span>
      </FilterBar>

      {d.widgets.length === 0 ? (
        <Card>
          <EmptyState
            icon={<LayoutGrid />}
            title="No reports on this dashboard"
            description="Add saved reports. Each one keeps its own chart and filters; the dashboard sets the date range and owner."
            action={editable && <Button onClick={() => setAdding(true)}><Plus /> Add report</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          {d.widgets.map((w, i) => (
            <WidgetCard key={w.id} dashboardId={d.id} widget={w} filters={filters} editing={editing} first={i === 0} last={i === d.widgets.length - 1} moving={reorder.isPending} onMove={(dir) => move(w, dir)} />
          ))}
        </div>
      )}

      {editable && <AddWidgetDialog open={adding} onOpenChange={setAdding} dashboard={d} />}
      {editable && <RenameDialog open={renaming} onOpenChange={setRenaming} name={d.name} pending={patch.isPending} onSave={(name, fail) => patch.mutate({name}, {onSuccess: () => setRenaming(false), onError: fail})} />}
    </div>
  );
}

function WidgetCard({dashboardId, widget, filters, editing, first, last, moving, onMove}: {dashboardId: string; widget: Widget; filters: DashboardFilters; editing: boolean; first: boolean; last: boolean; moving: boolean; onMove: (dir: -1 | 1) => void}) {
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  const params = runParams(filters);
  const run = useQuery({
    queryKey: [...keys.dashboards, dashboardId, 'widget', widget.id, widget.report.updatedAt, params],
    queryFn: () => api.get<ReportResult>(`/dashboards/${dashboardId}/widgets/${widget.id}/run`, params),
    placeholderData: (prev) => prev,
    retry: false,
  });
  const resize = useApiMutation((size: DashboardWidgetSize) => api.patch(`/dashboards/${dashboardId}/widgets/${widget.id}`, {size}), {invalidate: [keys.dashboards]});
  const remove = useApiMutation(() => api.del(`/dashboards/${dashboardId}/widgets/${widget.id}`), {invalidate: [keys.dashboards, keys.reports]});
  const r = run.data;
  return (
    <Card className={cn('flex min-w-0 flex-col', SPAN[widget.size], editing && 'ring-2 ring-primary/20')}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">
            <Link to="/reports/$reportId" params={{reportId: widget.report.id}} className="hover:text-primary">{widget.report.name}</Link>
          </CardTitle>
          <CardDescription className="truncate">{r ? `${r.range.label}${r.groupLabel ? ` · by ${r.groupLabel.toLowerCase()}` : ''}` : ' '}</CardDescription>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" disabled={first || moving} onClick={() => onMove(-1)} aria-label={`Move ${widget.report.name} earlier`}><ArrowLeft /></Button>
            <Button variant="ghost" size="icon-sm" disabled={last || moving} onClick={() => onMove(1)} aria-label={`Move ${widget.report.name} later`}><ArrowRight /></Button>
            <NativeSelect aria-label="Size" disabled={resize.isPending} className="h-8 w-auto pr-7 text-xs" value={widget.size} onChange={(e) => resize.mutate(e.target.value as DashboardWidgetSize)}>
              <option value="small">S</option>
              <option value="medium">M</option>
              <option value="large">L</option>
            </NativeSelect>
            <Button
              variant="ghost"
              size="icon-sm"
              pending={remove.isPending}
              onClick={async () => (await confirm({title: `Remove "${widget.report.name}" from this dashboard?`, description: 'The saved report is kept; only this widget goes.', confirmLabel: 'Remove', destructive: true})) && remove.mutate(undefined)}
              aria-label="Remove from dashboard"
            >
              <Trash2 />
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon-sm" asChild>
            <a href={`/site-api/crm/reports/${widget.report.id}/export.csv${qs(params)}`} download aria-label="Export CSV" title="Export CSV"><Download /></a>
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <ReportView result={r} chart={widget.report.config.chart} currency={currency} height={HEIGHT[widget.size]} loading={run.isFetching} error={run.error?.message} compact />
      </CardContent>
    </Card>
  );
}

function AddWidgetDialog({open, onOpenChange, dashboard}: {open: boolean; onOpenChange: (o: boolean) => void; dashboard: DashboardDetail}) {
  const reports = useSavedReports();
  // Shared dashboards only take shared reports, so every viewer can open them.
  const options = (reports.data ?? []).filter((r) => !dashboard.shared || r.shared);
  const [reportId, setReportId] = useState('');
  const [size, setSize] = useState<DashboardWidgetSize>('medium');
  const target = reportId || options[0]?.id || '';
  const add = useApiMutation(() => api.post(`/dashboards/${dashboard.id}/widgets`, {reportId: target, size}), {
    invalidate: [keys.dashboards, keys.reports],
    success: 'Report added',
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add a report</DialogTitle>
          <DialogDescription>{dashboard.shared ? 'This dashboard is shared, so only reports shared with the team are listed.' : 'Pick one of your saved reports.'}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {options.length ? (
            <>
              <Field label="Report">
                <NativeSelect value={target} onChange={(e) => setReportId(e.target.value)}>
                  {options.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Size">
                <NativeSelect value={size} onChange={(e) => setSize(e.target.value as DashboardWidgetSize)}>
                  <option value="small">Small (a quarter row)</option>
                  <option value="medium">Medium (half a row)</option>
                  <option value="large">Large (full row)</option>
                </NativeSelect>
              </Field>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No saved reports to add yet. <Link to="/reports/new" className="font-semibold text-primary">Build one</Link> and save it first.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>Cancel</Button>
          <Button onClick={() => add.mutate(undefined)} disabled={!target} pending={add.isPending} pendingLabel="Adding…">Add report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({open, onOpenChange, name, pending, onSave}: {open: boolean; onOpenChange: (o: boolean) => void; name: string; pending: boolean; onSave: (name: string, fail: (e: unknown) => void) => void}) {
  const [value, setValue] = useState(name);
  const f = useFormState({name: value}, {name: [is.required('Give the dashboard a name.'), is.maxLength(80)]});
  const {reset} = f;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (setValue(name), reset()), [name, open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Rename dashboard</DialogTitle>
        </DialogHeader>
        <form className="contents" {...f.form(() => onSave(value.trim(), f.fail))}>
          <DialogBody>
            <Field label="Name" error={f.error('name')}>
              <Input autoFocus maxLength={80} value={value} onChange={(e) => setValue(e.target.value)} onBlur={f.blur('name')} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" pending={pending} pendingLabel="Saving…">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
