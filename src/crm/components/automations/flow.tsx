import {ArrowDown, ArrowUp, CircleAlert, Copy, CornerDownRight, GitBranch, Maximize, Minus, MoreHorizontal, Plus, Trash2} from 'lucide-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';

import {
  blankStep,
  cloneSteps,
  insertStep,
  moveStep,
  removeStep,
  STEP_GROUPS,
  STEP_TYPES,
  stepSummary,
  triggerSummary,
  type AutoObject,
  type Problem,
  type Step,
  type StepType,
  type Trigger,
} from '@/lib/automations';
import {OPS, type SegmentRule} from '@/lib/segments';
import {cn} from '@/lib/utils';

import {confirm} from '../ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '../ui/menu';
import {IconBadge} from '../ui/misc';
import {useNames} from './hooks';
import {STEP_ICONS, TRIGGER_ICONS} from './meta';
import {pathRunClass, stepRunClass, StepRunBadge, usePathRunState, useStepRunState} from './test-run';

type FlowProps = {
  object: AutoObject;
  trigger: Trigger;
  steps: Step[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onSteps: (steps: Step[]) => void;
  problems: Problem[];
  readOnly?: boolean;
  /** Field label lookup for the trigger summary. */
  fieldLabel: (key: string) => string;
};

type AddFn = (parentId: string | null, branch: 'then' | 'else', index: number) => (type: StepType) => void;

/** Every card has the same width: branches spread sideways instead of squeezing their cards. */
const CARD = 'w-[300px] shrink-0';
const LINE = 'border-slate-300 dark:border-slate-600';

const Connector = ({className}: {className?: string}) => <div className={cn('mx-auto h-5 w-0 border-l', LINE, className)} aria-hidden />;

/** The step types, grouped, for the "+" menus. */
function StepMenu({onPick}: {onPick: (type: StepType) => void}) {
  return (
    <DropdownMenuContent align="center" className="max-h-[70vh] w-72 overflow-y-auto scrollbar-thin">
      {STEP_GROUPS.map((g, i) => (
        <div key={g}>
          {i > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel>{g}</DropdownMenuLabel>
          {(Object.keys(STEP_TYPES) as StepType[])
            .filter((t) => STEP_TYPES[t].group === g)
            .map((t) => {
              const {icon: Icon} = STEP_ICONS[t];
              return (
                <DropdownMenuItem key={t} onSelect={() => onPick(t)}>
                  <Icon />
                  <span className="min-w-0 flex-1">
                    <span className="block">{STEP_TYPES[t].label}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{STEP_TYPES[t].description}</span>
                  </span>
                </DropdownMenuItem>
              );
            })}
        </div>
      ))}
    </DropdownMenuContent>
  );
}

function AddStep({onPick, disabled}: {onPick: (type: StepType) => void; disabled?: boolean}) {
  if (disabled) return <Connector className="h-8" />;
  return (
    <div className="flex flex-col items-center">
      <Connector />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex size-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-slate-300 bg-card text-muted-foreground transition-all hover:scale-110 hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none" aria-label="Add a step here">
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <StepMenu onPick={onPick} />
      </DropdownMenu>
      <Connector />
    </div>
  );
}

/** An empty path: one dashed card to add its first step. */
function AddToPath({onPick, disabled}: {onPick: (type: StepType) => void; disabled?: boolean}) {
  if (disabled) return <p className={cn(CARD, 'rounded-xl border border-dashed border-slate-200 py-4 text-center text-xs text-muted-foreground')}>No steps on this path</p>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(CARD, 'flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-card/60 py-4 text-sm font-medium text-slate-500 transition-colors hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none')}>
          <Plus className="size-4" /> Add a step to this path
        </button>
      </DropdownMenuTrigger>
      <StepMenu onPick={onPick} />
    </DropdownMenu>
  );
}

// ─── Canvas: pan and zoom ───

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.5;
const clamp = (n: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));

/** Drag the background or scroll to pan; Cmd / Ctrl + scroll or the controls to zoom; Fit shows everything. */
function Canvas({children, fitKey}: {children: ReactNode; fitKey: number}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({x: 0, y: 0, zoom: 1});
  const drag = useRef<{x: number; y: number; vx: number; vy: number} | null>(null);
  const [panning, setPanning] = useState(false);

  /**
   * Fit to screen: everything in view. The first view (start) stays readable instead: at least
   * 75%, centred on the trigger, and the rest is a pan away.
   */
  const fit = useCallback((start = false) => {
    const b = box.current;
    const c = content.current;
    if (!b || !c) return;
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const all = Math.min(1, (b.clientWidth - 48) / w, (b.clientHeight - 48) / h);
    const zoom = clamp(start ? Math.max(0.75, Math.min(1, (b.clientWidth - 48) / w)) : all);
    setView({zoom, x: (b.clientWidth - w * zoom) / 2, y: 24});
  }, []);

  // First layout, and whenever the flow's shape changes a lot (a branch added or removed).
  useLayoutEffect(() => fit(true), [fit, fitKey]);

  const zoomAt = (next: number, cx?: number, cy?: number) => {
    const b = box.current;
    if (!b) return;
    setView((v) => {
      const zoom = clamp(next);
      const px = cx ?? b.clientWidth / 2;
      const py = cy ?? b.clientHeight / 2;
      // Keep the point under the cursor (or the centre) where it is.
      return {zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom};
    });
  };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = b.getBoundingClientRect();
        setView((v) => {
          const zoom = clamp(v.zoom * Math.exp(-e.deltaY * 0.0025));
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          return {zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom};
        });
      } else {
        setView((v) => ({...v, x: v.x - e.deltaX, y: v.y - e.deltaY}));
      }
    };
    b.addEventListener('wheel', onWheel, {passive: false});
    return () => b.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the background pans: cards, buttons and menus keep their clicks.
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, [role="button"], [role="menu"]')) return;
    drag.current = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y};
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y}));
  };
  const onPointerUp = () => ((drag.current = null), setPanning(false));

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={box}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn('relative h-full touch-none overflow-hidden select-none', panning ? 'cursor-grabbing' : 'cursor-grab')}
      >
        <div ref={content} className="absolute top-0 left-0 w-max origin-top-left" style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`}}>
          {children}
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-xl border border-slate-100 bg-card p-1 shadow-soft">
        <ZoomButton label="Zoom out" onClick={() => zoomAt(view.zoom / 1.2)}><Minus /></ZoomButton>
        <button type="button" onClick={() => zoomAt(1)} className="min-w-12 cursor-pointer rounded-md px-1.5 py-1 text-xs font-semibold text-slate-700 tabular-nums outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary/30" title="Zoom to 100%">
          {Math.round(view.zoom * 100)}%
        </button>
        <ZoomButton label="Zoom in" onClick={() => zoomAt(view.zoom * 1.2)}><Plus /></ZoomButton>
        <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden />
        <ZoomButton label="Fit to screen" onClick={() => fit()}><Maximize /></ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({label, onClick, children}: {label: string; onClick: () => void; children: ReactNode}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-8 cursor-pointer items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-primary/30 [&_svg]:size-4">
      {children}
    </button>
  );
}

/** How many if / else steps there are: the canvas re-fits when it changes. */
const branchCount = (list: Step[]): number => list.reduce((n, s) => n + (s.type === 'if' ? 1 + branchCount(s.then ?? []) + branchCount(s.else ?? []) : 0), 0);

// ─── Flow ───

/** Every step inside an If's branches, nested ones included. */
const innerSteps = (step: Step): number => [...(step.then ?? []), ...(step.else ?? [])].reduce((n, s) => n + 1 + innerSteps(s), 0);

/**
 * Asks before a step is deleted (AUDIT-2 M-18): the change autosaves, and a live automation uses it
 * at once. An If step says how many steps its branches take with it.
 */
export function askDeleteStep(step: Step): Promise<boolean> {
  const inner = step.type === 'if' ? innerSteps(step) : 0;
  return confirm({
    title: step.type === 'if' ? 'Delete this If step and both its paths?' : 'Delete this step?',
    description:
      (inner ? `The ${inner} step${inner === 1 ? '' : 's'} inside its Yes and No paths ${inner === 1 ? 'is' : 'are'} deleted with it. ` : '') +
      'The automation saves the change, and a live automation runs without it from then on.',
    confirmLabel: 'Delete step',
    destructive: true,
  });
}

/**
 * The automation on a pan / zoom canvas: trigger card, then steps; an if / else spreads its
 * Yes and No paths into side-by-side columns (each as wide as it needs), which join again
 * and continue with the next step. "+" between cards adds a step there.
 */
export function Flow(props: FlowProps) {
  const {object, trigger, steps, selected, onSelect, onSteps, problems, readOnly, fieldLabel} = props;
  const TriggerIcon = TRIGGER_ICONS[trigger.kind];
  const triggerProblems = problems.filter((p) => !p.stepId);
  const add: AddFn = (parentId, branch, index) => (type) => {
    const step = blankStep(type, object);
    onSteps(insertStep(steps, parentId, branch, index, step));
    onSelect(step.id);
  };
  return (
    <Canvas fitKey={branchCount(steps)}>
      <div className="flex flex-col items-center px-6 pb-24">
        <button
          type="button"
          onClick={() => onSelect('trigger')}
          className={cn(
            CARD,
            'flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-soft transition-all outline-none hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30',
            selected === 'trigger' ? 'border-primary ring-2 ring-primary/25' : 'border-slate-100',
          )}
        >
          <IconBadge tone="blue" className="bg-brand text-white"><TriggerIcon /></IconBadge>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold tracking-wider text-primary uppercase">Trigger</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900">{triggerSummary(object, trigger, fieldLabel)}</p>
            {trigger.conditions?.blocks.length ? <p className="mt-0.5 text-xs text-muted-foreground">Only records matching {trigger.conditions.blocks.length} condition block{trigger.conditions.blocks.length === 1 ? '' : 's'}</p> : null}
          </div>
          {triggerProblems.length > 0 && <CircleAlert className="size-4 shrink-0 text-amber-500" aria-label="Needs attention" />}
        </button>
        <StepList {...props} list={steps} parentId={null} branch="then" onAdd={add} />
        <span className="rounded-full bg-slate-900 px-3.5 py-1 text-[11px] font-bold tracking-wide text-white dark:bg-slate-700">End</span>
        {readOnly && <p className="mt-4 text-center text-xs text-muted-foreground">Only admins can change automations.</p>}
      </div>
    </Canvas>
  );
}

function StepList(props: FlowProps & {list: Step[]; parentId: string | null; branch: 'then' | 'else'; onAdd: AddFn; inPath?: boolean}) {
  const {list, parentId, branch, onAdd, readOnly, inPath} = props;
  if (inPath && !list.length) {
    return (
      <>
        <Connector />
        <AddToPath onPick={onAdd(parentId, branch, 0)} disabled={readOnly} />
      </>
    );
  }
  return (
    <>
      <AddStep onPick={onAdd(parentId, branch, 0)} disabled={readOnly} />
      {list.map((step, i) => (
        <div key={step.id} className="flex flex-col items-center">
          <StepNode {...props} step={step} index={i} count={list.length} />
          <AddStep onPick={onAdd(parentId, branch, i + 1)} disabled={readOnly} />
        </div>
      ))}
    </>
  );
}

/** First condition of an if / else in words ("Email contains "a@b.com""), plus how many more. */
function useConditionText(step: Step) {
  const names = useNames();
  const rules = (step.conditions?.blocks ?? []).flatMap((b) => b.rules.groups.flatMap((g) => g.rules.map((r) => ({target: b.target, rule: r}))));
  if (!rules.length) return 'No conditions yet: pick them in the panel';
  const {target, rule} = rules[0]!;
  const text = `${names.field(target, rule.field)} ${opLabel(rule)}${ruleValue(rule)}`;
  return rules.length > 1 ? `${text} +${rules.length - 1} more` : text;
}

const OP_LABELS = new Map(Object.values(OPS).flatMap((ops) => ops.map((o) => [o.op, o.label] as const)));
const opLabel = (r: SegmentRule) => OP_LABELS.get(r.op) ?? r.op.replace(/_/g, ' ');
const ruleValue = (r: SegmentRule) => (r.value ? ` "${r.value}"` : r.values?.length ? ` ${r.values.join(', ')}` : r.days ? ` ${r.days} days` : '');

/** The card at the top of a path: Yes with the condition, No for everything else. Clicking edits the if / else. */
function PathHeader({step, branch, selected, onSelect}: {step: Step; branch: 'then' | 'else'; selected: boolean; onSelect: () => void}) {
  const condition = useConditionText(step);
  const run = usePathRunState(step.id, branch);
  const yes = branch === 'then';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(CARD, 'cursor-pointer overflow-hidden rounded-xl border bg-card text-left shadow-soft transition-all outline-none hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30', selected ? 'border-primary ring-2 ring-primary/20' : 'border-slate-100', pathRunClass(run))}
    >
      <span className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold', yes ? 'bg-violet-50 text-violet-700' : 'bg-slate-50 text-slate-600')}>
        {yes ? <GitBranch className="size-3.5" /> : <CornerDownRight className="size-3.5" />} {yes ? 'Yes' : 'No'}
      </span>
      <span className="block truncate px-3 py-2.5 text-sm text-slate-700">{yes ? condition : 'When the condition isn’t met'}</span>
    </button>
  );
}

function StepNode(props: FlowProps & {step: Step; index: number; count: number; onAdd: AddFn}) {
  const {step, selected, onSelect, steps, onSteps, problems, readOnly, index, count} = props;
  const names = useNames();
  const {icon: Icon, tone} = STEP_ICONS[step.type];
  const issues = problems.filter((p) => p.stepId === step.id);
  const run = useStepRunState(step.id);
  const duplicate = () => {
    const [copy] = cloneSteps([step]);
    // Insert the copy right after the original, in the same list.
    const insertAfter = (list: Step[]): Step[] => list.flatMap((s) => (s.id === step.id ? [s, copy!] : s.type === 'if' ? [{...s, then: insertAfter(s.then ?? []), else: insertAfter(s.else ?? [])}] : [s]));
    onSteps(insertAfter(steps));
    onSelect(copy!.id);
  };
  return (
    <div className="flex flex-col items-center">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(step.id)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(step.id))}
        className={cn(
          CARD,
          'group flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 text-left shadow-soft transition-all outline-none hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-primary/30',
          selected === step.id ? 'border-primary ring-2 ring-primary/25' : 'border-slate-100',
          stepRunClass(run),
        )}
      >
        <IconBadge tone={tone} className="size-9 [&_svg]:size-4"><Icon /></IconBadge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{STEP_TYPES[step.type].label}</p>
          <p className="truncate text-xs text-muted-foreground">{step.type === 'if' ? 'Two paths · Yes when the condition is met' : stepSummary(step, names)}</p>
          <StepRunBadge state={run} />
        </div>
        {issues.length > 0 && <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-label={issues[0]!.message} />}
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" onClick={(e) => e.stopPropagation()} className="-mr-1 cursor-pointer rounded-md p-1 text-muted-foreground opacity-60 outline-none hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30" aria-label="Step actions">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem disabled={index === 0} onSelect={() => onSteps(moveStep(steps, step.id, -1))}><ArrowUp /> Move up</DropdownMenuItem>
              <DropdownMenuItem disabled={index === count - 1} onSelect={() => onSteps(moveStep(steps, step.id, 1))}><ArrowDown /> Move down</DropdownMenuItem>
              <DropdownMenuItem onSelect={duplicate}><Copy /> Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={async () => (await askDeleteStep(step)) && (onSteps(removeStep(steps, step.id)), selected === step.id && onSelect(null))}><Trash2 /> Delete…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {step.type === 'if' && <Paths {...props} step={step} />}
    </div>
  );
}

/**
 * Yes / No side by side. Each column draws its half of the line that fans out from the
 * if / else and of the line that joins the paths again below, so the lines meet whatever
 * width each column ends up (nested branches make a column wider).
 */
function Paths(props: FlowProps & {step: Step; onAdd: AddFn}) {
  const {step, selected, onSelect} = props;
  const branches = ['then', 'else'] as const;
  return (
    <div className="flex flex-col items-center">
      <Connector />
      <div className="flex items-stretch">
        {branches.map((b, i) => {
          const first = i === 0;
          const last = i === branches.length - 1;
          return (
            <div key={b} className="relative flex flex-col items-center px-6 pt-5">
              <span aria-hidden className={cn('absolute top-0 border-t border-dashed', LINE)} style={{left: first ? '50%' : 0, right: last ? '50%' : 0}} />
              <span aria-hidden className={cn('absolute top-0 left-1/2 h-5 border-l border-dashed', LINE)} />
              <PathHeader step={step} branch={b} selected={selected === step.id} onSelect={() => onSelect(step.id)} />
              <StepList {...props} list={(b === 'then' ? step.then : step.else) ?? []} parentId={step.id} branch={b} inPath />
              <span aria-hidden className={cn('min-h-5 w-0 flex-1 border-l border-dashed', LINE)} />
              <span aria-hidden className={cn('absolute bottom-0 border-t border-dashed', LINE)} style={{left: first ? '50%' : 0, right: last ? '50%' : 0}} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
