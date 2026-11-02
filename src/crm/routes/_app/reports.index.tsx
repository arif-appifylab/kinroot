import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {LayoutDashboard, LayoutGrid, Plus, Users} from 'lucide-react';
import {useState} from 'react';

import {useDashboards} from '@/components/reports/hooks';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, Switch} from '@/components/ui/form';
import {IconBadge, PageHeader, Skeleton} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {DashboardDetail} from '@/lib/types';

export const Route = createFileRoute('/_app/reports/')({
  head: () => ({meta: [{title: pageTitle('Dashboards')}]}),
  component: DashboardsPage,
});

function DashboardsPage() {
  const {canEdit} = useMe();
  const list = useDashboards();
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader
        title="Dashboards"
        description="Saved reports side by side, with one date range and owner filter for all of them."
        actions={canEdit && <Button onClick={() => setCreating(true)}><Plus /> New dashboard</Button>}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {/* The main dashboard (/crm/) stays the default one. */}
        <Link to="/" className="block">
          <Card interactive className="h-full p-5">
            <div className="flex items-start gap-3">
              <IconBadge tone="blue"><LayoutDashboard /></IconBadge>
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">Overview</p>
                <p className="mt-0.5 text-sm text-muted-foreground">Pipeline, won revenue, win rate and what's due today</p>
                <Badge tone="blue" className="mt-3">Default</Badge>
              </div>
            </div>
          </Card>
        </Link>
        {list.isLoading && Array.from({length: 2}).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        {list.data?.map((d) => (
          <Link key={d.id} to="/reports/dashboards/$dashboardId" params={{dashboardId: d.id}} className="block">
            <Card interactive className="h-full p-5">
              <div className="flex items-start gap-3">
                <IconBadge tone="teal"><LayoutGrid /></IconBadge>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">{d.name}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {d._count.widgets} report{d._count.widgets === 1 ? '' : 's'} · {d.owner?.name ?? 'Unknown'} · updated {ago(d.updatedAt)}
                  </p>
                  <div className="mt-3">{d.shared ? <Badge tone="green"><Users /> Shared with team</Badge> : <Badge>Private</Badge>}</div>
                </div>
              </div>
            </Card>
          </Link>
        ))}
        {canEdit && list.data && (
          <button
            onClick={() => setCreating(true)}
            className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-sm font-semibold text-slate-500 transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Plus className="size-5" /> New dashboard
          </button>
        )}
      </div>
      <NewDashboardDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewDashboardDialog({open, onOpenChange}: {open: boolean; onOpenChange: (o: boolean) => void}) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const create = useApiMutation(() => api.post<{dashboard: DashboardDetail}>('/dashboards', {name, shared}), {
    invalidate: [keys.dashboards],
    onSuccess: (r) => {
      onOpenChange(false);
      setName('');
      navigate({to: '/reports/dashboards/$dashboardId', params: {dashboardId: r.dashboard.id}});
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>Add saved reports to it next.</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <DialogBody>
            <Field label="Name">
              <Input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales weekly" />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
              <span>
                <span className="font-semibold">Share with the team</span>
                <span className="block text-xs text-muted-foreground">Everyone can open it; only you and admins can change it.</span>
              </span>
              <Switch checked={shared} onCheckedChange={setShared} />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>Create dashboard</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
