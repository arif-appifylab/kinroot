import {useNavigate} from '@tanstack/react-router';
import {Copy, Download, LayoutGrid, MoreHorizontal, Save, Trash2} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {LoadError} from '@/components/data-table';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, NativeSelect, Switch} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Skeleton} from '@/components/ui/misc';
import {api, qs} from '@/lib/api';
import {keys, useApiMutation, useMe, useSettings} from '@/lib/queries';
import type {ReportConfig} from '@/lib/reports';
import type {DashboardWidgetSize, SavedReport} from '@/lib/types';

import {BuilderPanel, defaultConfig} from './builder';
import {useDashboards} from './hooks';
import {useCatalogue} from './option-picker';
import {ReportView, runParams, useReportPreview} from './report-view';
import {ScheduleEmailButton} from './schedules';

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const exportUrl = (config: ReportConfig, name: string) => `/site-api/crm/reports/export.csv${qs({config: JSON.stringify(config), name, ...runParams()})}`;

/** Builder + live preview. Without `report` it creates a new one on save. */
export function ReportEditor({report}: {report?: SavedReport}) {
  const {me, isAdmin, canEdit} = useMe();
  const navigate = useNavigate();
  const catalogue = useCatalogue();
  const settings = useSettings();
  const currency = settings.data?.settings.currency ?? 'USD';
  const [config, setConfig] = useState<ReportConfig | null>(report?.config ?? null);
  const [name, setName] = useState(report?.name ?? '');
  const [shared, setShared] = useState(report?.shared ?? true);
  const [pinning, setPinning] = useState(false);

  // New reports start from the first object in the catalogue (deals).
  useEffect(() => {
    if (!config && catalogue.data?.[0]) setConfig(defaultConfig(catalogue.data[0]));
  }, [catalogue.data, config]);

  const debounced = useDebounced(config);
  const preview = useReportPreview(debounced);
  const owner = !report || report.ownerId === me.id || isAdmin;
  const dirty = useMemo(() => !report || JSON.stringify(report.config) !== JSON.stringify(config) || report.name !== name || report.shared !== shared, [report, config, name, shared]);
  const fallbackName = preview.data ? `${preview.data.measureLabel}${preview.data.groupLabel ? ` by ${preview.data.groupLabel.toLowerCase()}` : ''}` : 'Untitled report';

  const save = useApiMutation(
    (asNew: boolean) => {
      const body = {name: name.trim() || fallbackName, shared, config};
      return report && !asNew ? api.patch<{report: SavedReport}>(`/reports/${report.id}`, body) : api.post<{report: SavedReport}>('/reports', body);
    },
    {
      invalidate: [keys.reports, keys.dashboards],
      success: 'Report saved',
      onSuccess: (r) => {
        if (!report || r.report.id !== report.id) navigate({to: '/reports/$reportId', params: {reportId: r.report.id}});
      },
    },
  );
  const remove = useApiMutation(() => api.del(`/reports/${report!.id}`), {
    invalidate: [keys.reports, keys.dashboards],
    success: 'Report deleted',
    onSuccess: () => navigate({to: '/reports/saved'}),
  });

  if (catalogue.isError) {
    return (
      <Card>
        <h1 className="sr-only">{report?.name ?? 'New report'}</h1>
        <LoadError error={catalogue.error} onRetry={() => catalogue.refetch()} />
      </Card>
    );
  }
  if (!catalogue.data || !config) return <Skeleton className="h-[480px] rounded-xl" />;

  return (
    <div>
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* The screen's heading: the name field below is what people see and edit. */}
          <h1 className="sr-only">{name.trim() || report?.name || 'New report'}</h1>
          <label className="sr-only" htmlFor="report-name">Report name</label>
          <input
            id="report-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={fallbackName}
            maxLength={120}
            readOnly={!canEdit || !owner}
            className="w-full min-w-0 rounded-lg bg-transparent text-2xl font-extrabold leading-tight tracking-[-0.02em] text-slate-900 outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-primary/25 sm:text-[28px]"
          />
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {report ? <>Saved by {report.owner?.name ?? 'someone'}</> : 'New report'}
            {report && (report.shared ? <Badge tone="green">Shared with team</Badge> : <Badge>Private</Badge>)}
            {report && dirty && canEdit && owner && <Badge tone="amber">Unsaved changes</Badge>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" asChild>
            <a href={exportUrl(config, name.trim() || fallbackName)} download>
              <Download /> Export CSV
            </a>
          </Button>
          {canEdit && report && <ScheduleEmailButton target={{reportId: report.id, name: report.name}} />}
          {canEdit && report && (
            <Button variant="secondary" onClick={() => setPinning(true)} disabled={dirty}>
              <LayoutGrid /> Add to dashboard
            </Button>
          )}
          {canEdit && (owner || !report) && (
            <Button onClick={() => save.mutate(false)} disabled={!!report && !dirty} pending={save.isPending} pendingLabel="Saving…">
              <Save /> {report ? 'Save' : 'Save report'}
            </Button>
          )}
          {canEdit && report && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions" disabled={save.isPending} pending={remove.isPending}><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => save.mutate(true)}><Copy /> Save as a new report</DropdownMenuItem>
                {owner && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${report.name}"?`, description: `It is removed from every dashboard.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="self-start">
          <BuilderPanel objects={catalogue.data} config={config} onChange={setConfig} />
          {canEdit && owner && (
            <div className="border-t border-slate-100 px-5 py-4">
              <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                <span>
                  <span className="font-semibold">Share with the team</span>
                  <span className="block text-xs text-muted-foreground">Shared reports can go on shared dashboards.</span>
                </span>
                <Switch checked={shared} onCheckedChange={setShared} />
              </label>
            </div>
          )}
        </Card>
        <Card className="min-w-0 self-start">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>{preview.data?.measureLabel ?? 'Preview'}</CardTitle>
              <CardDescription>
                {preview.data ? (
                  <>
                    {preview.data.range.label}
                    {preview.data.groupLabel && ` · by ${preview.data.groupLabel.toLowerCase()}`}
                    {preview.data.breakdownLabel && ` and ${preview.data.breakdownLabel.toLowerCase()}`}
                    {` · ${preview.data.total.count} ${preview.data.noun[preview.data.total.count === 1 ? 0 : 1]}`}
                  </>
                ) : (
                  'Running…'
                )}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ReportView result={preview.data} chart={config.chart} currency={currency} height={340} loading={preview.isFetching} error={preview.error?.message} />
          </CardContent>
        </Card>
      </div>
      {report && <AddToDashboardDialog open={pinning} onOpenChange={setPinning} report={report} />}
    </div>
  );
}

function AddToDashboardDialog({open, onOpenChange, report}: {open: boolean; onOpenChange: (o: boolean) => void; report: SavedReport}) {
  const {me, isAdmin} = useMe();
  const navigate = useNavigate();
  const dashboards = useDashboards();
  const mine = (dashboards.data ?? []).filter((d) => d.ownerId === me.id || isAdmin);
  const [dashboardId, setDashboardId] = useState('');
  const [size, setSize] = useState<DashboardWidgetSize>('medium');
  const target = dashboardId || mine[0]?.id || '';
  const add = useApiMutation(() => api.post(`/dashboards/${target}/widgets`, {reportId: report.id, size}), {
    invalidate: [keys.dashboards, keys.reports],
    success: 'Added to dashboard',
    onSuccess: () => {
      onOpenChange(false);
      navigate({to: '/reports/dashboards/$dashboardId', params: {dashboardId: target}});
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add to dashboard</DialogTitle>
          <DialogDescription>The widget follows the dashboard's date range and owner filter.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {mine.length ? (
            <>
              <Field label="Dashboard">
                <NativeSelect value={target} onChange={(e) => setDashboardId(e.target.value)}>
                  {mine.map((d) => <option key={d.id} value={d.id}>{d.name}{d.shared ? ' (shared)' : ''}</option>)}
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
            <p className="text-sm text-muted-foreground">You have no dashboards yet. Create one under Reports → Dashboards first.</p>
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
