import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {CircleCheck, CircleDashed, CircleSlash, CircleX, FlaskConical, History, Hourglass, Loader2, RotateCcw, Square} from 'lucide-react';
import {useState} from 'react';

import {eventLabel, findStep, RUN_SOURCES, RUN_STATUS, STEP_TYPES, TEST_MODES, type AutoObject, type RunStatus, type TestMode} from '@/lib/automations';
import {api} from '@/lib/api';
import {ago, dateTime} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {Paged} from '@/lib/types';
import {cn} from '@/lib/utils';

import {SearchInput} from '../data-table';
import {FilterBar} from '../filter-bar';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '../ui/dialog';
import {NativeSelect} from '../ui/form';
import {EmptyState} from '../ui/misc';
import type {RunDetail, RunRow, RunStepRow} from './hooks';
import {RunStatusBadge, STEP_ICONS} from './meta';

export const recordPath = (object: AutoObject, id: string | null, label?: string | null): {to: string; params: Record<string, string>} | null => {
  if (!id || object === 'none') return null;
  if (object === 'contact') return {to: '/contacts/$contactId', params: {contactId: id}};
  if (object === 'company') return {to: '/companies/$companyId', params: {companyId: id}};
  if (object === 'deal') return {to: '/deals/$dealId', params: {dealId: id}};
  const number = label?.match(/^#(\d+)/)?.[1];
  return {to: '/tickets/$ticketId', params: {ticketId: number ?? id}};
};

export const duration = (from: string, to: string | null) => {
  if (!to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};

/** Run history of one automation, with filters; a row opens the run's step-by-step detail. */
export function RunsPanel({automationId}: {automationId: string}) {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: [...keys.automations, automationId, 'runs', {status, source, q, page}],
    queryFn: () => api.get<Paged<RunRow>>(`/automations/${automationId}/runs`, {status, source, q, page, pageSize: 25}),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const pages = Math.max(1, Math.ceil((runs.data?.total ?? 0) / 25));
  return (
    <Card className="overflow-hidden">
      <FilterBar className="border-b border-slate-100 p-3" active={!!(q || status || source)} onClear={() => (setQ(''), setStatus(''), setSource(''), setPage(1))}>
        <SearchInput size="sm" value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Search by record…" />
        <NativeSelect size="sm" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(RUN_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </NativeSelect>
        <NativeSelect size="sm" value={source} onChange={(e) => (setSource(e.target.value), setPage(1))} aria-label="Started by">
          <option value="">Any start</option>
          {Object.entries(RUN_SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </NativeSelect>
      </FilterBar>
      {runs.isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
      {runs.data && runs.data.rows.length === 0 && <EmptyState icon={<History />} title="No runs yet" description="Runs show up here with every step they took, as soon as the trigger fires." />}
      {!!runs.data?.rows.length && (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-bold tracking-wide text-slate-500 uppercase">
                <th className="px-4 py-3">Record</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Started by</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3 text-right">Steps</th>
                <th className="px-4 py-3 text-right">Took</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {runs.data.rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50/70" onClick={() => setOpen(r.id)}>
                  <td className="max-w-64 px-4 py-3">
                    <p className="truncate font-semibold text-slate-800">{r.recordLabel ?? (r.object === 'none' ? 'Team-wide' : 'Deleted record')}</p>
                    {r.error && <p className="truncate text-xs text-muted-foreground">{r.error}</p>}
                  </td>
                  <td className="px-4 py-3"><span className="inline-flex flex-wrap items-center gap-1"><RunStatusBadge status={r.status} />{r.test && <TestBadge test={r.test} />}</span></td>
                  <td className="px-4 py-3 text-slate-600">{r.eventType ? eventLabel(r.eventType) : RUN_SOURCES[r.source] ?? r.source}{r.depth > 0 && <span className="ml-1 text-xs text-muted-foreground">(chain {r.depth})</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600" title={dateTime(r.startedAt)}>{ago(r.startedAt)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">{r._count?.steps ?? 0}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap text-slate-600">{r.status === 'waiting' && r.waitUntil ? `waits until ${dateTime(r.waitUntil)}` : duration(r.startedAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-muted-foreground">
          <span>{runs.data?.total.toLocaleString()} runs</span>
          <div className="flex gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}
      {open && <RunDialog runId={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/** Marks a test run from the editor (simulations change nothing; "record" tests ran for real). */
export function TestBadge({test}: {test: TestMode}) {
  return (
    <Badge tone="outline" title={test === 'record' ? 'Test run for real on a record' : `${TEST_MODES[test].label}: nothing really happened`}>
      <FlaskConical className="size-3" /> Test{test === 'record' ? '' : ' · simulated'}
    </Badge>
  );
}

const STEP_STATUS: Record<RunStepRow['status'], {icon: typeof CircleCheck; cls: string; label: string}> = {
  done: {icon: CircleCheck, cls: 'text-green-600', label: 'Done'},
  skipped: {icon: CircleSlash, cls: 'text-amber-600', label: 'Skipped'},
  failed: {icon: CircleX, cls: 'text-rose-600', label: 'Failed'},
  running: {icon: CircleDashed, cls: 'text-blue-600', label: 'Running / retrying'},
};

function Json({value}: {value: unknown}) {
  const text = JSON.stringify(value, null, 2);
  if (!value || text === '{}') return null;
  return <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 p-2.5 text-[11px] leading-relaxed text-slate-100 scrollbar-thin">{text}</pre>;
}

/** One run: trigger, every step it took (status, summary, data, error, timing) and admin actions. */
export function RunDialog({runId, onClose}: {runId: string; onClose: () => void}) {
  const {isAdmin} = useMe();
  const q = useQuery({queryKey: [...keys.automations, 'run', runId], queryFn: () => api.get<{run: RunDetail}>(`/automations/runs/${runId}`), select: (d) => d.run, refetchInterval: (query) => (['running', 'waiting'].includes(query.state.data?.run.status ?? '') ? 5_000 : false)});
  const cancel = useApiMutation(() => api.post(`/automations/runs/${runId}/cancel`), {invalidate: [keys.automations], success: 'Run canceled'});
  const retry = useApiMutation(() => api.post(`/automations/runs/${runId}/retry`), {invalidate: [keys.automations], success: 'Retrying the failed step'});
  const run = q.data;
  const link = run ? recordPath(run.object, run.recordId, run.recordLabel) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{run?.automation.name ?? 'Run'}</DialogTitle>
          <DialogDescription>
            {run ? (
              <>
                {link ? <Link to={link.to as never} params={link.params as never} className="font-semibold text-primary hover:underline">{run.recordLabel}</Link> : run.recordLabel ?? 'No record'} · started {dateTime(run.startedAt)}
              </>
            ) : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!run && <Loader2 className="mx-auto size-5 animate-spin text-primary" />}
          {run && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <RunStatusBadge status={run.status as RunStatus} />
                {run.test && <TestBadge test={run.test} />}
                <span className="text-xs text-muted-foreground">{run.eventType ? eventLabel(run.eventType) : RUN_SOURCES[run.source]}{run.depth > 0 ? ` · caused by another automation (chain depth ${run.depth})` : ''}</span>
                {run.status === 'waiting' && run.waitUntil && <span className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700"><Hourglass className="size-3.5" /> until {dateTime(run.waitUntil)}</span>}
                <span className="ml-auto flex gap-1.5">
                  {isAdmin && (run.status === 'running' || run.status === 'waiting') && <Button variant="secondary" size="sm" onClick={() => cancel.mutate(undefined)} disabled={cancel.isPending}><Square /> Cancel</Button>}
                  {isAdmin && run.status === 'failed' && run.steps.some((s) => s.status === 'failed') && <Button variant="secondary" size="sm" onClick={() => retry.mutate(undefined)} disabled={retry.isPending}><RotateCcw /> Retry</Button>}
                </span>
              </div>
              {run.error && <p className={cn('rounded-xl p-3 text-sm', run.status === 'failed' ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800')}>{run.error}</p>}
              <ol className="grid gap-2">
                {run.steps.map((s, i) => {
                  const def = findStep(run.automation.steps, s.stepId);
                  const st = STEP_STATUS[s.status];
                  const {icon: Icon} = STEP_ICONS[s.type] ?? STEP_ICONS.stop;
                  const memory = Object.keys(s.input ?? {}).length ? s.input : null;
                  const {summary, ...output} = s.output ?? {};
                  return (
                    <li key={s.id} className="rounded-xl border border-slate-100 bg-card p-3">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 text-xs font-bold text-slate-400 tabular-nums">{i + 1}</span>
                        <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-800">{STEP_TYPES[s.type]?.label ?? s.type}{!def && <span className="ml-1 text-xs font-normal text-muted-foreground">(no longer in the automation)</span>}</p>
                          {summary && <p className="text-sm text-slate-600">{String(summary)}</p>}
                          {s.error && <p className="mt-1 text-xs font-medium text-rose-700">{s.error}</p>}
                          <p className="mt-1 text-[11px] text-muted-foreground">{dateTime(s.startedAt)} · {duration(s.startedAt, s.finishedAt)}{s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}</p>
                        </div>
                        <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', st.cls)}><st.icon className="size-3.5" /> {st.label}</span>
                      </div>
                      {(Object.keys(output).length > 0 || memory) && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-semibold text-primary">Data</summary>
                          <div className="mt-1.5 grid gap-1.5">
                            <Json value={output} />
                            {memory && <><p className="text-[11px] text-muted-foreground">Kept for retries</p><Json value={memory} /></>}
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
                {run.steps.length === 0 && <p className="text-sm text-muted-foreground">{run.status === 'skipped' ? 'This run was stopped before its first step.' : 'No steps yet.'}</p>}
              </ol>
              <details>
                <summary className="cursor-pointer text-xs font-semibold text-primary">Trigger data</summary>
                <div className="mt-1.5"><Json value={run.context} /></div>
              </details>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
