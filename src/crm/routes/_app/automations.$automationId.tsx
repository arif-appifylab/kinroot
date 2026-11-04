import {useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {ArrowLeft, Check, CircleAlert, CloudOff, Copy, ListChecks, Loader2, MoreHorizontal, MousePointerClick, Play, Trash2} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {Flow} from '@/components/automations/flow';
import {LoadError} from '@/components/data-table';
import {automationKey, useAutomation, useNames, type Automation, type Problem} from '@/components/automations/hooks';
import {ManualRunDialog} from '@/components/automations/record-tools';
import {RunsPanel} from '@/components/automations/runs';
import {StepPanel} from '@/components/automations/step-panel';
import {TestButton, TestRunBar, TestRunProvider} from '@/components/automations/test-run';
import {TriggerPanel} from '@/components/automations/trigger-panel';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Field, Input, NativeSelect, Switch, Textarea} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {automationProblems, findStep, replaceStep, removeStep, type AutoObject, type Step, type Trigger} from '@/lib/automations';
import {pageTitle} from '@/lib/brand';
import {toLocalInput} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {cn} from '@/lib/utils';

const TABS = ['flow', 'runs', 'settings'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/automations/$automationId')({
  validateSearch: z.object({tab: z.enum(TABS).optional()}),
  head: () => ({meta: [{title: pageTitle('Automation')}]}),
  component: AutomationRoute,
});

/** A fresh builder per automation (the route component is reused when only the id changes). */
function AutomationRoute() {
  const {automationId} = Route.useParams();
  return <AutomationPage key={automationId} automationId={automationId} />;
}

type Draft = Pick<Automation, 'name' | 'description' | 'object' | 'trigger' | 'steps' | 'reenroll' | 'reenrollDays' | 'activeFrom' | 'activeUntil' | 'timezone'>;

const draftOf = (a: Automation): Draft => ({name: a.name, description: a.description, object: a.object, trigger: a.trigger, steps: a.steps, reenroll: a.reenroll, reenrollDays: a.reenrollDays, activeFrom: a.activeFrom, activeUntil: a.activeUntil, timezone: a.timezone});

function AutomationPage({automationId}: {automationId: string}) {
  const {tab = 'flow'} = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {isAdmin} = useMe();
  const q = useAutomation(automationId);
  const a = q.data?.automation;
  const names = useNames();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [selected, setSelected] = useState<string | null>('trigger');
  const [manual, setManual] = useState<'record' | 'list' | null>(null);
  const saved = useRef('');
  const lastError = useRef('');

  useEffect(() => {
    if (a && !draft) {
      const d = draftOf(a);
      saved.current = JSON.stringify(d);
      setDraft(d);
      setServerProblems(q.data?.problems ?? []);
    }
  }, [a, draft, q.data]);

  async function save(d: Draft) {
    const json = JSON.stringify(d);
    if (json === saved.current) return true;
    setSaveState('saving');
    try {
      const r = await api.patch<{automation: Automation; problems: Problem[]}>(`/automations/${automationId}`, {...d, description: d.description || null});
      saved.current = json;
      lastError.current = '';
      setServerProblems(r.problems);
      setSaveState('saved');
      qc.setQueryData(automationKey(automationId), {automation: r.automation, problems: r.problems});
      qc.invalidateQueries({queryKey: keys.automations, exact: true});
      return true;
    } catch (e) {
      setSaveState('error');
      // Autosave retries on every edit: say it once, the header keeps showing it.
      if ((e as Error).message !== lastError.current) toast.error((e as Error).message);
      lastError.current = (e as Error).message;
      return false;
    }
  }

  // Autosave 700 ms after the last change (admins only).
  useEffect(() => {
    if (!draft || !isAdmin || JSON.stringify(draft) === saved.current) return;
    const t = setTimeout(() => void save(draft), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, isAdmin]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (draft && JSON.stringify(draft) !== saved.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);

  const toggle = useApiMutation(async (enabled: boolean) => {
    if (draft && !(await save(draft))) throw new Error('Fix the last change first');
    return api.post<{automation: Automation}>(`/automations/${automationId}/enable`, {enabled});
  }, {invalidate: [keys.automations], success: (r) => (r.automation.enabled ? 'Automation is on' : 'Automation is off')});
  const duplicate = useApiMutation(() => api.post<{automation: {id: string}}>(`/automations/${automationId}/duplicate`), {
    invalidate: [keys.automations],
    success: 'Duplicated (switched off)',
    onSuccess: (r) => navigate({to: '/automations/$automationId', params: {automationId: r.automation.id}}),
  });
  const remove = useApiMutation(() => api.del(`/automations/${automationId}`), {invalidate: [keys.automations], success: 'Automation deleted', onSuccess: () => navigate({to: '/automations'})});

  const problems = useMemo(() => {
    if (!draft) return [];
    const local = automationProblems({name: draft.name, object: draft.object, trigger: draft.trigger, steps: draft.steps});
    const seen = new Set(local.map((p) => `${p.stepId}|${p.message}`));
    // Server checks (deleted lists, inactive users…) apply to the last saved version.
    return [...local, ...serverProblems.filter((p) => !seen.has(`${p.stepId}|${p.message}`) && (!p.stepId || findStep(draft.steps, p.stepId)))];
  }, [draft, serverProblems]);

  if (q.isError && !a) {
    return (
      <Card>
        <h1 className="sr-only">Automation</h1>
        <LoadError error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  if (q.isLoading || !a || !draft) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[480px]" />
      </div>
    );
  }

  const setTab = (t: Tab) => navigate({to: '/automations/$automationId', params: {automationId}, search: t === 'flow' ? {} : {tab: t}, replace: true});
  const set = (patch: Partial<Draft>) => setDraft({...draft, ...patch});
  const step = selected && selected !== 'trigger' ? findStep(draft.steps, selected) : null;
  const fieldLabel = (key: string) => (draft.object === 'none' ? key : names.field(draft.object, key));
  const enabled = a.enabled;

  return (
    <TestRunProvider automationId={automationId} object={draft.object} draft={{...draft, description: draft.description || null}} enabled={isAdmin}>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/automations" aria-label="Back to automations"><ArrowLeft /></Link>
          </Button>
          <div className="min-w-0 flex-1">
            {/* The screen's heading; the name field below is what people see and edit. */}
            <h1 className="sr-only">{draft.name.trim() || a.name}</h1>
            <div className="flex items-center gap-2">
              <input
                value={draft.name}
                onChange={(e) => set({name: e.target.value})}
                onBlur={() => !draft.name.trim() && set({name: a.name})}
                disabled={!isAdmin}
                aria-label="Automation name"
                className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 text-2xl font-extrabold tracking-tight text-slate-900 outline-none hover:bg-slate-100/70 focus:bg-card focus:ring-2 focus:ring-primary/30 disabled:hover:bg-transparent"
              />
              <Badge tone={enabled ? 'green' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
            </div>
            {isAdmin && (
              <p role="status" className="mt-0.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                {saveState === 'saving' && <><Loader2 className="size-3 animate-spin" /> Saving…</>}
                {saveState === 'saved' && <><Check className="size-3 text-emerald-500" /> All changes saved{enabled && ' · live'}</>}
                {saveState === 'error' && <><CloudOff className="size-3 text-destructive" /> {enabled ? 'Not saved: a live automation only saves without problems (or switch it off)' : 'Not saved, check the last change'}</>}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a.triggerKind === 'manual' && enabled && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary"><Play /> Run…</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setManual('record')}><MousePointerClick /> On a record</DropdownMenuItem>
                {a.object === 'contact' && <DropdownMenuItem onSelect={() => setManual('list')}><ListChecks /> On a list or segment</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isAdmin && <TestButton />}
          {isAdmin && (
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-card px-3 py-2 text-sm font-semibold text-slate-700">
              <Switch checked={enabled} disabled={toggle.isPending} aria-busy={toggle.isPending || undefined} onCheckedChange={(on) => toggle.mutate(on)} aria-label="Switch the automation on or off" />
              {enabled ? 'On' : 'Off'}
            </label>
          )}
          {isAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions" pending={duplicate.isPending || remove.isPending}><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => duplicate.mutate(undefined)}><Copy /> Duplicate</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${a.name}" and its run history?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <TestRunBar />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'flow' && (
        <>
          {problems.length > 0 && isAdmin && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0">
                <p className="font-semibold">{enabled ? 'This automation has problems:' : `${problems.length} thing${problems.length === 1 ? '' : 's'} to finish before switching on:`}</p>
                <ul className="mt-1 grid gap-0.5">
                  {problems.slice(0, 5).map((p, i) => (
                    <li key={i}>
                      <button type="button" className="cursor-pointer rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-amber-400" onClick={() => setSelected(p.stepId ?? 'trigger')}>{p.message}</button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
            <Card className="relative h-[calc(100dvh-15rem)] min-h-[520px] min-w-0 overflow-hidden bg-[radial-gradient(circle,rgb(148_163_184/0.25)_1px,transparent_1px)] bg-[length:18px_18px]">
              <Flow
                object={draft.object}
                trigger={draft.trigger}
                steps={draft.steps}
                selected={selected}
                onSelect={setSelected}
                onSteps={(steps) => set({steps})}
                problems={problems}
                readOnly={!isAdmin}
                fieldLabel={fieldLabel}
              />
            </Card>
            <Card className="min-w-0 self-start p-5 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:scrollbar-thin">
              {selected === 'trigger' && (
                <>
                  <h2 className="mb-4 text-base font-bold text-slate-900">Trigger</h2>
                  <TriggerPanel object={draft.object} trigger={draft.trigger} onChange={(object: AutoObject, trigger: Trigger) => set({object, trigger})} readOnly={!isAdmin} />
                </>
              )}
              {step && (
                <StepPanel
                  key={step.id}
                  step={step}
                  object={draft.object}
                  onChange={(s: Step) => set({steps: replaceStep(draft.steps, s)})}
                  onDelete={() => (set({steps: removeStep(draft.steps, step.id)}), setSelected(null))}
                  problems={problems.filter((p) => p.stepId === step.id)}
                  readOnly={!isAdmin}
                  automationId={automationId}
                  isAdmin={isAdmin}
                />
              )}
              {!step && selected !== 'trigger' && <p className="py-10 text-center text-sm text-muted-foreground">Select the trigger or a step to see its settings. Use <b>+</b> between cards to add steps.</p>}
            </Card>
          </div>
        </>
      )}

      {tab === 'runs' && <RunsPanel automationId={automationId} />}
      {tab === 'settings' && <SettingsPanel draft={draft} onChange={set} readOnly={!isAdmin} />}

      {manual && <ManualRunDialog automation={{id: a.id, name: a.name, object: a.object}} mode={manual} onClose={() => setManual(null)} />}
    </TestRunProvider>
  );
}

function timeZones(): string[] {
  try {
    return (Intl as unknown as {supportedValuesOf: (k: string) => string[]}).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

function SettingsPanel({draft, onChange, readOnly}: {draft: Draft; onChange: (p: Partial<Draft>) => void; readOnly: boolean}) {
  const zones = useMemo(timeZones, []);
  const toIso = (v: string) => (v ? new Date(v).toISOString() : null);
  return (
    <div className={cn('grid max-w-2xl grid-cols-1 gap-6', readOnly && 'pointer-events-none opacity-80')}>
      <Card className="grid gap-4 p-5">
        <h2 className="text-base font-bold text-slate-900">About</h2>
        <Field label="Description" hint="Shown in the automation list and on record pages for manual automations.">
          <Textarea value={draft.description ?? ''} onChange={(e) => onChange({description: e.target.value})} className="min-h-20" />
        </Field>
        <Field label="Time zone" hint="For times of day in date triggers, task due times and waits.">
          <NativeSelect value={draft.timezone} onChange={(e) => onChange({timezone: e.target.value})}>
            {!zones.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </NativeSelect>
        </Field>
      </Card>
      <Card className="grid gap-4 p-5">
        <h2 className="text-base font-bold text-slate-900">Re-enrollment</h2>
        <p className="-mt-2 text-sm text-muted-foreground">Can a record go through this automation more than once? Manual runs on one record always start.</p>
        <NativeSelect aria-label="Re-enrollment" value={draft.reenroll} onChange={(e) => onChange({reenroll: e.target.value as Draft['reenroll'], reenrollDays: e.target.value === 'after' ? draft.reenrollDays ?? 30 : null})}>
          <option value="always">Every time the trigger fires</option>
          <option value="never">Only once per record, ever</option>
          <option value="after">Again after a number of days</option>
        </NativeSelect>
        {draft.reenroll === 'after' && (
          <span className="flex items-center gap-2 text-sm text-slate-600">
            At most once every <Input type="number" inputMode="numeric" aria-label="Days between runs for the same record" className="w-24" value={draft.reenrollDays ?? 30} onChange={(e) => onChange({reenrollDays: Math.max(1, Math.round(Number(e.target.value) || 1))})} /> days per record
          </span>
        )}
        <p className="text-xs text-muted-foreground">Loop protection is always on: runs caused by other automations stop after 5 in a row, and an automation runs at most 10 times an hour for the same record.</p>
      </Card>
      <Card className="grid gap-4 p-5">
        <h2 className="text-base font-bold text-slate-900">Active dates</h2>
        <p className="-mt-2 text-sm text-muted-foreground">Optional. Outside these dates the trigger starts no runs (runs already waiting carry on).</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From"><Input type="datetime-local" value={toLocalInput(draft.activeFrom)} onChange={(e) => onChange({activeFrom: toIso(e.target.value)})} /></Field>
          <Field label="Until"><Input type="datetime-local" value={toLocalInput(draft.activeUntil)} onChange={(e) => onChange({activeUntil: toIso(e.target.value)})} /></Field>
        </div>
      </Card>
    </div>
  );
}
