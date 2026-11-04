import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {Copy, Loader2, MoreHorizontal, Plus, Sparkles, Trash2, Workflow} from 'lucide-react';
import {useState} from 'react';

import {useAutomations, useNames, type AutomationRow} from '@/components/automations/hooks';
import {LoadError} from '@/components/data-table';
import {TRIGGER_ICONS} from '@/components/automations/meta';
import {useLists} from '@/components/lists/list-picker';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Switch} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip} from '@/components/ui/menu';
import {EmptyState, IconBadge, PageHeader} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {cloneSteps, mapSteps, OBJECTS, RECIPES, triggerSummary, type AutoObject, type Recipe, type Step} from '@/lib/automations';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime} from '@/lib/format';
import {keys, useApiMutation, useMe, usePipelines} from '@/lib/queries';

export const Route = createFileRoute('/_app/automations/')({
  head: () => ({meta: [{title: pageTitle('Automations')}]}),
  component: AutomationsPage,
});

const objectLabel = (o: AutoObject) => (o === 'none' ? 'Team-wide' : OBJECTS[o].label);

function AutomationsPage() {
  const {isAdmin} = useMe();
  const navigate = useNavigate();
  const list = useAutomations();
  const names = useNames();
  const [creating, setCreating] = useState(false);
  const toggle = useApiMutation(({id, enabled}: {id: string; enabled: boolean}) => api.post(`/automations/${id}/enable`, {enabled}), {invalidate: [keys.automations], success: (r) => ((r as {automation: {enabled: boolean}}).automation.enabled ? 'Automation is on' : 'Automation is off')});
  const duplicate = useApiMutation((id: string) => api.post<{automation: {id: string}}>(`/automations/${id}/duplicate`), {invalidate: [keys.automations], success: 'Duplicated (switched off)', onSuccess: (r) => navigate({to: '/automations/$automationId', params: {automationId: r.automation.id}})});
  const remove = useApiMutation((id: string) => api.del(`/automations/${id}`), {invalidate: [keys.automations], success: 'Automation deleted'});
  const rows = list.data ?? [];
  const fieldLabel = (object: AutoObject) => (key: string) => (object === 'none' ? key : names.field(object, key));

  return (
    <div>
      <PageHeader
        title="Automations"
        description="When something happens (or a date arrives), do the busywork: tasks, updates, emails, notifications."
        actions={isAdmin && <Button onClick={() => setCreating(true)}><Plus /> New automation</Button>}
      />
      <Card className="overflow-hidden">
        {list.isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
        {list.isError && <LoadError error={list.error} onRetry={() => list.refetch()} />}
        {!list.isLoading && !list.isError && rows.length === 0 && (
          <EmptyState
            icon={<Workflow />}
            title="No automations yet"
            description={isAdmin ? 'Start from a recipe, like “Deal won → onboarding ticket”, or build your own.' : 'Admins set up automations. Runs on your records show on their pages.'}
            action={isAdmin && <Button onClick={() => setCreating(true)}><Sparkles /> Browse recipes</Button>}
          />
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-bold tracking-wide text-slate-500 uppercase">
                  <th className="px-4 py-3">Automation</th>
                  <th className="px-4 py-3">Trigger</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Runs (7 d)</th>
                  <th className="px-4 py-3 text-right">Errors (7 d)</th>
                  <th className="px-4 py-3">Last run</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((a) => (
                  <Row key={a.id} a={a} isAdmin={isAdmin} toggling={toggle.isPending && toggle.variables?.id === a.id} busy={(duplicate.isPending && duplicate.variables === a.id) || (remove.isPending && remove.variables === a.id)} fieldLabel={fieldLabel(a.object)} onToggle={(enabled) => toggle.mutate({id: a.id, enabled})} onDuplicate={() => duplicate.mutate(a.id)} onDelete={async () => (await confirm({title: `Delete "${a.name}" and its run history?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(a.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewAutomationDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function Row({a, isAdmin, toggling, busy, fieldLabel, onToggle, onDuplicate, onDelete}: {a: AutomationRow; isAdmin: boolean; toggling: boolean; busy: boolean; fieldLabel: (k: string) => string; onToggle: (enabled: boolean) => void; onDuplicate: () => void; onDelete: () => void}) {
  const Icon = TRIGGER_ICONS[a.triggerKind];
  return (
    <tr className="hover:bg-slate-50/70">
      <td className="max-w-72 px-4 py-3">
        <Link to="/automations/$automationId" params={{automationId: a.id}} className="block truncate font-semibold text-slate-900 hover:text-primary">{a.name}</Link>
        <p className="truncate text-xs text-muted-foreground">{objectLabel(a.object)} · {a.stepCount} step{a.stepCount === 1 ? '' : 's'}{a.description ? ` · ${a.description}` : ''}</p>
      </td>
      <td className="max-w-72 px-4 py-3">
        <span className="flex items-center gap-2 text-slate-700"><Icon className="size-4 shrink-0 text-slate-400" /><span className="truncate">{triggerSummary(a.object, a.trigger, fieldLabel)}</span></span>
      </td>
      <td className="px-4 py-3">
        <span className="flex items-center gap-2">
          {isAdmin && <Switch checked={a.enabled} disabled={toggling} aria-busy={toggling || undefined} onCheckedChange={onToggle} aria-label={a.enabled ? `Switch off ${a.name}` : `Switch on ${a.name}`} />}
          <Badge tone={a.enabled ? 'green' : 'neutral'}>{a.enabled ? 'On' : 'Off'}</Badge>
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{a.stats.runs7d.toLocaleString()}{a.stats.waiting > 0 && <span className="block text-[11px] text-violet-600">{a.stats.waiting} waiting</span>}</td>
      <td className="px-4 py-3 text-right tabular-nums">{a.stats.failed7d > 0 ? <Link to="/automations/$automationId" params={{automationId: a.id}} search={{tab: 'runs'}} className="font-semibold text-rose-600 hover:underline">{a.stats.failed7d}</Link> : <span className="text-muted-foreground">0</span>}</td>
      <td className="px-4 py-3 whitespace-nowrap text-slate-600">{a.lastRunAt ? <Tooltip content={dateTime(a.lastRunAt)}><span>{ago(a.lastRunAt)}</span></Tooltip> : 'Never'}</td>
      <td className="px-2 py-3">
        {isAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.name}`} pending={busy}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onDuplicate}><Copy /> Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}><Trash2 /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}

/** Blank or a recipe. Recipe lists and stages are matched by name when they exist. */
function NewAutomationDialog({onClose}: {onClose: () => void}) {
  const navigate = useNavigate();
  const lists = useLists('STATIC');
  const pipelines = usePipelines();
  const create = useApiMutation((input: {name: string; description?: string; object: AutoObject; trigger: Recipe['trigger']; steps: Step[]}) => api.post<{automation: {id: string}}>('/automations', {...input, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}), {
    invalidate: [keys.automations],
    onSuccess: (r) => navigate({to: '/automations/$automationId', params: {automationId: r.automation.id}}),
  });
  const fromRecipe = (r: Recipe) => {
    const listId = r.hints?.listName ? lists.data?.find((l) => l.name.toLowerCase() === r.hints!.listName!.toLowerCase())?.id : undefined;
    const stageId = r.hints?.stageName ? pipelines.data?.flatMap((p) => p.stages).find((s) => s.name.toLowerCase() === r.hints!.stageName!.toLowerCase())?.id : undefined;
    const steps = mapSteps(cloneSteps(r.steps), (s) => {
      if ((s.type === 'add_to_list' || s.type === 'remove_from_list') && !s.listId && listId) return {...s, listId};
      if (s.type === 'update_field' && s.field === 'stageId' && !s.value && stageId) return {...s, value: stageId};
      return s;
    });
    create.mutate({name: r.name, description: r.description, object: r.object, trigger: r.trigger, steps});
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>Start blank or from a recipe; you can change everything before switching it on.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {create.isPending && (
            <p role="status" className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Creating the automation…
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-busy={create.isPending || undefined}>
            <button
              type="button"
              disabled={create.isPending}
              onClick={() => create.mutate({name: 'New automation', object: 'contact', trigger: {kind: 'event', event: 'contact.created', filter: {}}, steps: []})}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-dashed border-slate-300 p-4 text-left transition-all outline-none hover:-translate-y-0.5 hover:border-primary hover:shadow-soft focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              <IconBadge tone="slate"><Plus /></IconBadge>
              <span>
                <span className="block text-sm font-bold text-slate-900">Blank automation</span>
                <span className="block text-xs text-muted-foreground">Pick a trigger and add steps yourself.</span>
              </span>
            </button>
            {RECIPES.map((r) => {
              const Icon = TRIGGER_ICONS[r.trigger.kind];
              return (
                <button key={r.key} type="button" disabled={create.isPending} onClick={() => fromRecipe(r)} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-100 bg-card p-4 text-left shadow-soft transition-all outline-none hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0">
                  <IconBadge tone="blue"><Icon /></IconBadge>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-slate-900">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">{r.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
