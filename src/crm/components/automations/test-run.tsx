/**
 * Test runs in the automation editor: the Test split button, the run bar under
 * the header, and playback on the canvas.
 *
 * A test runs the editor's draft (saved or not) as a flagged run through the
 * normal job (POST /automations/:id/tests); this file polls it while it is
 * shown and plays it back: steps light up one after another (each shows for at
 * least a moment, even when the server ran it in milliseconds), waits count
 * down, the path an if / else took is emphasised and the other one dimmed.
 * Replay re-animates the last test from its recorded step timings (waits
 * capped at a few seconds) without running anything again.
 *
 * Canvas hook-up: `useStepRunState(step.id)` in a step card, with
 * `stepRunClass(state)` and `<StepRunBadge state />`; `usePathRunState(ifId, branch)`
 * in a path header with `pathRunClass()`. All return null when no test is shown.
 */
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {ChevronDown, CircleCheck, CircleSlash, CircleX, FlaskConical, Hourglass, Loader2, RotateCcw, Square, Timer, X, Zap} from 'lucide-react';
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {flattenSteps, OBJECTS, QUICK_TEST_WAIT_MS, TEST_MODES, type AutoObject, type TestMode} from '@/lib/automations';
import {keys} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';
import {confirm} from '../ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '../ui/menu';
import type {RunDetail, RunStepRow} from './hooks';
import {TestRecordDialog} from './record-tools';
import {recordPath} from './runs';

// ─── Playback ───────────────────────────────────────────────────────────────

export type StepRunStatus = 'running' | 'done' | 'skipped' | 'failed' | 'waiting' | 'untaken' | 'unreached';
export type StepRunState = {status: StepRunStatus; summary?: string; error?: string | null; waitLeftMs?: number; branch?: 'then' | 'else'};

/** A step shows as running for at least this long, so fast steps can be followed. */
const MIN_RUN_MS = 650;
type Mode = 'live' | 'replay';
type Cursor = {revealed: number; phase: 'run' | 'wait'; since: number};

const active = (run: {status: string} | undefined) => run?.status === 'running' || run?.status === 'waiting';
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);
/** A wait step that really waited (not "that time has passed"). */
const waited = (row: RunStepRow) => row.type === 'wait' && row.status === 'done' && typeof row.output?.until === 'string';

/** How long a replay shows a wait: as recorded, at most a quick test's wait. */
function replayWaitMs(row: RunStepRow, next: RunStepRow | undefined, run: RunDetail) {
  const gap = (next ? ms(next.startedAt) : ms(run.finishedAt) || ms(row.finishedAt)) - ms(row.finishedAt);
  return Math.min(QUICK_TEST_WAIT_MS, Math.max(300, gap));
}

/** Moves the playback cursor as far as the data and the clock allow. */
function advance(prev: Cursor, run: RunDetail, mode: Mode, now: number): Cursor {
  let {revealed, phase, since} = prev;
  const rows = run.steps;
  for (let guard = 0; guard < 200; guard++) {
    const row = rows[revealed];
    if (!row) break;
    if (phase === 'run') {
      if (row.status === 'running' || now - since < MIN_RUN_MS) break;
      if (waited(row)) {
        phase = 'wait';
        since = now;
        continue;
      }
      revealed++;
      since = now;
      continue;
    }
    const next = rows[revealed + 1];
    const over = mode === 'replay' ? now - since >= replayWaitMs(row, next, run) : (!!next || !active(run)) && now - since >= 300;
    if (!over) break;
    revealed++;
    phase = 'run';
    since = now;
  }
  return {revealed, phase, since};
}

const finalState = (row: RunStepRow): StepRunState => ({
  status: row.status === 'running' ? 'running' : row.status,
  summary: row.output?.summary,
  error: row.error,
  branch: row.output?.branch,
});

type Playback = {states: Map<string, StepRunState>; paths: Map<string, 'then' | 'else'>; allShown: boolean; waitLeftMs: number | null};

function derive(run: RunDetail, cursor: Cursor, mode: Mode, clockNow: number): Playback {
  const now = Math.max(clockNow, cursor.since); // the clock shown moves once a second, the cursor more often
  const states = new Map<string, StepRunState>();
  const paths = new Map<string, 'then' | 'else'>();
  const rows = run.steps;
  rows.slice(0, cursor.revealed).forEach((r) => states.set(r.stepId, finalState(r)));
  const current = rows[cursor.revealed];
  let waitLeftMs: number | null = null;
  if (current) {
    if (cursor.phase === 'run') states.set(current.stepId, {status: 'running'});
    else {
      waitLeftMs = Math.max(0, mode === 'live' ? (run.status === 'waiting' ? ms(run.waitUntil) - now : 0) : replayWaitMs(current, rows[cursor.revealed + 1], run) - (now - cursor.since));
      states.set(current.stepId, {...finalState(current), status: 'waiting', waitLeftMs});
    }
  } else if (mode === 'live' && run.status === 'running' && run.cursor) {
    states.set(run.cursor, {status: 'running'});
  }
  for (const [id, s] of states) if (s.branch && s.status !== 'running') paths.set(id, s.branch);
  const allShown = !current && !active(run);
  const all = flattenSteps(run.automation.steps ?? []);
  for (const {step} of all) {
    const taken = paths.get(step.id);
    if (!taken || step.type !== 'if') continue;
    for (const {step: s} of flattenSteps((taken === 'then' ? step.else : step.then) ?? [])) if (!states.has(s.id)) states.set(s.id, {status: 'untaken'});
  }
  if (allShown) for (const {step} of all) if (!states.has(step.id)) states.set(step.id, {status: 'unreached'});
  return {states, paths, allShown, waitLeftMs};
}

// ─── Context ────────────────────────────────────────────────────────────────

type TestRunContext = {
  run: RunDetail | undefined;
  playback: Playback | null;
  mode: Mode;
  elapsedMs: number;
  starting: TestMode | null;
  object: AutoObject;
  start: (mode: TestMode, recordId?: string | null) => Promise<void>;
  choose: (mode: TestMode) => void;
  stop: () => void;
  replay: () => void;
  close: () => void;
};

const Ctx = createContext<TestRunContext | null>(null);

/**
 * Holds the test shown in the editor (and wraps the page in a plain div).
 * `draft` is what a test runs: the editor's current automation, unsaved
 * changes included.
 */
export function TestRunProvider({automationId, object, draft, enabled, children}: {automationId: string; object: AutoObject; draft: unknown; enabled: boolean; children: ReactNode}) {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('live');
  const [cursor, setCursor] = useState<Cursor>({revealed: 0, phase: 'run', since: 0});
  const [now, setNow] = useState(() => Date.now());
  const [replayStart, setReplayStart] = useState(0);
  const [starting, setStarting] = useState<TestMode | null>(null);
  const [picking, setPicking] = useState<TestMode | null>(null);
  const instant = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const runKey = [...keys.automations, 'test-run', runId] as const;
  const q = useQuery({
    queryKey: runKey,
    queryFn: () => api.get<{run: RunDetail}>(`/automations/runs/${runId}`).then((d) => d.run),
    enabled: !!runId,
    // Poll while it runs: every second, or every 5 s while a long wait has a while to go.
    refetchInterval: (query) => {
      const r = query.state.data;
      if (!active(r)) return false;
      return r!.status === 'waiting' && ms(r!.waitUntil) - Date.now() > 15_000 ? 5_000 : 1_000;
    },
  });
  const run = runId ? q.data : undefined;

  // Pick up the latest test again when the editor opens while it still goes on.
  const latest = useQuery({
    queryKey: [...keys.automations, automationId, 'tests', 'latest'],
    queryFn: () => api.get<{run: {id: string; status: string} | null}>(`/automations/${automationId}/tests/latest`),
    enabled,
    staleTime: Infinity,
  });
  useEffect(() => {
    const r = latest.data?.run;
    if (r && active(r) && !runId) {
      instant.current = true;
      setRunId(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest.data]);

  // A test picked up again starts where it is instead of replaying from the top.
  useEffect(() => {
    if (run && instant.current) {
      instant.current = false;
      const c = advance({revealed: 0, phase: 'run', since: 0}, run, 'live', Number.MAX_SAFE_INTEGER);
      setCursor({...c, since: Date.now()});
    }
  }, [run]);

  const playing = !!run && (active(run) || !derive(run, cursor, mode, now).allShown);
  useEffect(() => {
    if (!playing || !run) return;
    // The cursor is checked often (steps light up on time); the clock shown moves once a second.
    const tick = () => {
      const t = Date.now();
      setNow((n) => (Math.floor(n / 1000) === Math.floor(t / 1000) ? n : t));
      setCursor((c) => {
        const n = advance(c, run, mode, t);
        return n.revealed === c.revealed && n.phase === c.phase ? c : n;
      });
    };
    tick();
    const t = setInterval(tick, 150);
    return () => clearInterval(t);
  }, [playing, run, mode]);

  const playback = useMemo(() => (run ? derive(run, cursor, mode, now) : null), [run, cursor, mode, now]);
  const elapsedMs = !run ? 0 : mode === 'replay' ? (playback?.allShown ? ms(run.finishedAt) - ms(run.startedAt) : now - replayStart) : (playback?.allShown ? ms(run.finishedAt) : now) - ms(run.startedAt);

  const start = useCallback(
    async (m: TestMode, recordId?: string | null) => {
      setStarting(m);
      try {
        const r = await api.post<{run: {id: string}}>(`/automations/${automationId}/tests`, {mode: m, recordId: recordId ?? null, draft: draftRef.current});
        instant.current = false;
        setMode('live');
        setCursor({revealed: 0, phase: 'run', since: Date.now()});
        setRunId(r.run.id);
        qc.invalidateQueries({queryKey: [...keys.automations, automationId, 'runs']});
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setStarting(null);
      }
    },
    [automationId, qc],
  );

  const choose = useCallback(
    async (m: TestMode) => {
      if (object !== 'none') return setPicking(m);
      // Team-wide automations have no record to pick.
      if (m === 'record' && !(await confirmReal())) return;
      void start(m);
    },
    [object, start],
  );

  const value: TestRunContext = {
    run,
    playback,
    mode,
    elapsedMs: Math.max(0, elapsedMs),
    starting,
    object,
    start,
    choose,
    stop: () => {
      if (!runId) return;
      api.post(`/automations/runs/${runId}/cancel`).then(
        () => qc.invalidateQueries({queryKey: runKey}),
        (e: Error) => toast.error(e.message),
      );
    },
    replay: () => {
      const t = Date.now();
      setMode('replay');
      setReplayStart(t);
      setNow(t);
      setCursor({revealed: 0, phase: 'run', since: t});
    },
    close: () => {
      setRunId(null);
      setMode('live');
    },
  };

  return (
    <Ctx.Provider value={value}>
      <div>{children}</div>
      {picking && (
        <TestRecordDialog
          object={object}
          mode={picking}
          onClose={() => setPicking(null)}
          onPick={async (recordId) => {
            if (picking === 'record' && !(await confirmReal(OBJECTS[object as Exclude<AutoObject, 'none'>]?.label.toLowerCase()))) return;
            setPicking(null);
            void start(picking, recordId);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/** Says plainly what a test for real does before it starts. */
async function confirmReal(noun?: string) {
  const yes = await confirm({
    title: 'Run this automation for real?',
    description: `Every step really happens${noun ? ` to the ${noun} you picked` : ''}: fields change, tasks, deals and tickets are created, emails and notifications go out and webhooks are called. Waits last their real time. This can't be undone.`,
    confirmLabel: 'Run for real',
    destructive: true,
  });
  return yes;
}

const useTestRun = () => useContext(Ctx);

/** Playback state of one step card (null when no test is shown). */
export function useStepRunState(stepId: string): StepRunState | null {
  const t = useTestRun();
  return t?.run ? (t.playback?.states.get(stepId) ?? null) : null;
}

/** Whether an if / else path was taken in the test shown (null while unknown or no test is shown). */
export function usePathRunState(ifStepId: string, branch: 'then' | 'else'): 'taken' | 'untaken' | null {
  const t = useTestRun();
  const taken = t?.run ? t.playback?.paths.get(ifStepId) : undefined;
  if (taken) return taken === branch ? 'taken' : 'untaken';
  // A path inside a path that wasn't taken is not taken either.
  return t?.run && t.playback?.states.get(ifStepId)?.status === 'untaken' ? 'untaken' : null;
}

// ─── Canvas pieces ──────────────────────────────────────────────────────────

const RING: Record<StepRunStatus, string> = {
  running: 'border-blue-400 ring-4 ring-blue-400/25 shadow-lift',
  done: 'border-green-300 ring-2 ring-green-400/25',
  skipped: 'border-amber-300 ring-2 ring-amber-400/25',
  failed: 'border-rose-400 ring-2 ring-rose-400/30',
  waiting: 'border-violet-400 ring-4 ring-violet-400/25',
  untaken: 'opacity-40 saturate-50',
  unreached: 'opacity-60',
};

/** Ring / dimming for a step card in a test (put it last in the card's classes). */
export const stepRunClass = (state: StepRunState | null) => (state ? RING[state.status] : undefined);

/** Emphasis for a path header: the path the test took, or dimmed when it didn't. */
export const pathRunClass = (state: 'taken' | 'untaken' | null) => (state === 'taken' ? 'border-violet-400 ring-2 ring-violet-400/30' : state === 'untaken' ? 'opacity-40 saturate-50' : undefined);

export function formatLeft(msLeft: number) {
  const s = Math.ceil(msLeft / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60}s` : ''}`.trim();
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.round((s % 86_400) / 3600)} h`;
}

/** What a step did in the test shown, under its card's text. */
export function StepRunBadge({state}: {state: StepRunState | null}) {
  if (!state || state.status === 'untaken' || state.status === 'unreached') return null;
  const {status} = state;
  const Icon = status === 'running' ? Loader2 : status === 'done' ? CircleCheck : status === 'skipped' ? CircleSlash : status === 'failed' ? CircleX : Hourglass;
  const text =
    status === 'running' ? 'Running…' : status === 'waiting' ? `Waiting${state.waitLeftMs ? ` · ${formatLeft(state.waitLeftMs)} left` : '…'}` : status === 'failed' ? state.error || 'Failed' : state.summary || (status === 'skipped' ? 'Skipped' : 'Done');
  return (
    <p
      className={cn(
        'mt-1.5 flex items-start gap-1 rounded-md px-1.5 py-1 text-[11px] leading-snug font-medium',
        status === 'running' && 'bg-blue-50 text-blue-700',
        status === 'done' && 'bg-green-50 text-green-800',
        status === 'skipped' && 'bg-amber-50 text-amber-800',
        status === 'failed' && 'bg-rose-50 text-rose-700',
        status === 'waiting' && 'bg-violet-50 text-violet-700',
      )}
      title={text}
    >
      <Icon className={cn('mt-px size-3 shrink-0', status === 'running' && 'animate-spin')} />
      <span className="line-clamp-2 min-w-0">{text}</span>
    </p>
  );
}

// ─── Header button and run bar ──────────────────────────────────────────────

const MODE_ICONS: Record<TestMode, typeof Zap> = {quick: Zap, timed: Timer, record: FlaskConical};

/** "Test" split button: a quick test, or the dropdown's three kinds of test. */
export function TestButton() {
  const t = useTestRun();
  if (!t) return null;
  const noun = t.object === 'none' ? null : OBJECTS[t.object].label.toLowerCase();
  const label = (m: TestMode) => (m === 'record' ? (noun ? `Test on a ${noun}…` : 'Test for real…') : TEST_MODES[m].label);
  const description = (m: TestMode) => (m === 'record' && !noun ? 'Every step really happens.' : TEST_MODES[m].description);
  return (
    <div className="inline-flex">
      <Button variant="secondary" className="rounded-r-none" onClick={() => void t.start('quick')} pending={!!t.starting} pendingLabel="Starting…">
        <FlaskConical /> Test
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="icon" className="h-10 w-9 rounded-l-none border-l-0" aria-label="More ways to test" disabled={!!t.starting}>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {(Object.keys(TEST_MODES) as TestMode[]).map((m) => {
            const Icon = MODE_ICONS[m];
            return (
              <DropdownMenuItem key={m} onSelect={() => (m === 'record' ? void t.choose(m) : void t.start(m))}>
                <Icon />
                <span className="min-w-0 flex-1">
                  <span className="block">{label(m)}</span>
                  <span className="block text-xs font-normal whitespace-normal text-muted-foreground">{description(m)}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const clock = (msTotal: number) => {
  const s = Math.floor(msTotal / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** The bar under the header while a test is shown: status, record, elapsed time, Replay, Stop, close. */
export function TestRunBar() {
  const t = useTestRun();
  const run = t?.run;
  if (!t || !run || !t.playback) return null;
  const {playback} = t;
  const test = (run.test ?? 'quick') as TestMode;
  const live = active(run);
  const shownDone = playback.allShown;
  const stopped = run.status === 'canceled';
  const status = !shownDone
    ? playback.waitLeftMs !== null
      ? {icon: Hourglass, cls: 'text-violet-700', label: `Waiting · ${formatLeft(playback.waitLeftMs)} left`}
      : {icon: Loader2, cls: 'text-blue-700', label: t.mode === 'replay' ? 'Replaying…' : 'Running…'}
    : run.status === 'done'
      ? {icon: CircleCheck, cls: 'text-green-700', label: 'Completed'}
      : run.status === 'failed'
        ? {icon: CircleX, cls: 'text-rose-700', label: 'Failed'}
        : {icon: Square, cls: 'text-slate-600', label: stopped ? 'Stopped' : 'Ended'};
  const link = recordPath(run.object, run.recordId, run.recordLabel);
  const conditions = (run.context as {conditions?: {ok?: boolean}}).conditions;
  return (
    <div className="mb-4 rounded-xl border border-slate-100 bg-card px-3 py-2 shadow-soft">
      <span className="sr-only" role="status">{shownDone ? `Test ${status.label.toLowerCase()}` : 'Test running'}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', status.cls)}>
          <status.icon className={cn('size-4', status.icon === Loader2 && 'animate-spin')} /> {status.label}
        </span>
        <span className="min-w-0 text-sm text-slate-600">
          {test === 'record' ? 'Test for real' : TEST_MODES[test].label}
          {run.object !== 'none' && (
            <>
              {' on '}
              {link ? <Link to={link.to as never} params={link.params as never} className="font-semibold text-primary hover:underline">{run.recordLabel ?? 'a deleted record'}</Link> : <b>{run.recordLabel ?? 'a deleted record'}</b>}
              {test !== 'record' && (
                <button type="button" onClick={() => t.choose(test)} className="ml-1.5 cursor-pointer text-xs font-semibold text-primary hover:underline">
                  Change
                </button>
              )}
            </>
          )}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums" title="Elapsed">{clock(t.elapsedMs)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {live && (
            <Button variant="secondary" size="sm" onClick={t.stop}>
              <Square /> Stop
            </Button>
          )}
          {!live && (
            <Button variant="secondary" size="sm" onClick={t.replay} disabled={!shownDone && t.mode !== 'replay'}>
              <RotateCcw /> Replay
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={t.close} aria-label="Close the test">
            <X />
          </Button>
        </span>
      </div>
      {conditions?.ok === false && (
        <p className="mt-1.5 text-xs text-amber-700">{run.recordLabel ?? 'This record'} doesn’t match the trigger conditions, so a real trigger wouldn’t start a run for it. The steps run anyway.</p>
      )}
      {test !== 'record' && <p className="mt-1 text-xs text-muted-foreground">Simulation: nothing is changed, created or sent.{test === 'quick' ? ' Every wait takes 5 seconds.' : ''}</p>}
      {shownDone && run.status === 'failed' && run.error && <p className="mt-1.5 text-xs font-medium text-rose-700">{run.error}</p>}
    </div>
  );
}
