import {ArrowDown, ArrowUp, Plus, Star, Trash2} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {colourName} from '@/lib/colours';
import {keys, useApiMutation, useMe, usePipelines} from '@/lib/queries';
import type {Pipeline} from '@/lib/types';

import {LoadError} from './data-table';
import {SettingsSection} from './settings-section';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {confirm} from './ui/confirm';
import {Field, Input} from './ui/form';
import {is, useFormState} from './ui/form-state';

type StageDraft = {id?: string; name: string; probability: number; color: string};
const PALETTE = ['#94a3b8', '#38bdf8', '#0ea5e9', '#2563eb', '#7c3aed', '#0d9488', '#16a34a', '#f59e0b'];

export function PipelineEditor({pipeline}: {pipeline: Pipeline}) {
  const {isAdmin} = useMe();
  const [name, setName] = useState(pipeline.name);
  const [rottingDays, setRottingDays] = useState(pipeline.rottingDays);
  const [stages, setStages] = useState<StageDraft[]>(pipeline.stages.map((s) => ({id: s.id, name: s.name, probability: s.probability, color: s.color})));
  const save = useApiMutation((extra: {isDefault?: boolean} = {}) => api.put(`/pipelines/${pipeline.id}`, {name, rottingDays, stages, ...extra}), {invalidate: [keys.pipelines, keys.deals], success: 'Pipeline saved'});
  const remove = useApiMutation(() => api.del(`/pipelines/${pipeline.id}`), {invalidate: [keys.pipelines], success: 'Pipeline deleted'});
  const f = useFormState({name, rottingDays, stages}, {
    name: [is.required('Give the pipeline a name.'), is.maxLength(80)],
    rottingDays: [is.number({min: 1, max: 365, integer: true, message: 'Use a whole number of days between 1 and 365.'})],
    stages: [
      (list) => (list.some((s) => !s.name.trim()) ? 'Give every stage a name.' : null),
      (list) => (list.some((s) => s.name.trim().length > 60) ? 'Keep stage names to 60 characters.' : null),
      (list) => (list.some((s) => !Number.isInteger(s.probability) || s.probability < 0 || s.probability > 100) ? 'Win % is a whole number from 0 to 100.' : null),
    ],
  });
  const stagesError = f.error('stages');
  const busy = save.isPending || remove.isPending;

  const move = (i: number, d: -1 | 1) => setStages((s) => {
    const next = [...s];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    return next;
  });
  const patch = (i: number, p: Partial<StageDraft>) => setStages((s) => s.map((x, j) => (j === i ? {...x, ...p} : x)));

  return (
    <SettingsSection
      title={pipeline.name}
      description={<>{pipeline._count?.deals ?? 0} open deals {pipeline.isDefault && <Badge tone="blue" className="ml-1"><Star /> Default</Badge>}</>}
      actions={isAdmin && (
        <>
          {!pipeline.isDefault && <Button variant="ghost" size="sm" disabled={busy} pending={save.isPending && save.variables?.isDefault === true} pendingLabel="Making default…" onClick={() => save.mutate({isDefault: true})}><Star /> Make default</Button>}
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-rose-50 hover:text-destructive" aria-label={`Delete ${pipeline.name}`} disabled={busy} pending={remove.isPending} onClick={async () => (await confirm({title: `Delete ${pipeline.name}?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /></Button>
        </>
      )}
    >
      <form {...f.form(() => save.mutate({}, {onError: f.fail}))}>
      <fieldset disabled={!isAdmin} className="grid gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
          <Field label="Name" error={f.error('name')}><Input value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} /></Field>
          <Field label="Stale after (days)" error={f.error('rottingDays')}><Input type="number" inputMode="numeric" value={rottingDays} onChange={(e) => setRottingDays(Number(e.target.value))} onBlur={f.blur('rottingDays')} /></Field>
        </div>
        <div className="grid gap-2">
          <div className="grid grid-cols-[28px_1fr_90px_76px] gap-2 px-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
            <span /> <span>Stage</span> <span>Win %</span> <span />
          </div>
          {stages.map((s, i) => (
            <div key={s.id ?? i} className="grid grid-cols-[28px_1fr_90px_76px] items-center gap-2 rounded-xl bg-slate-50 p-1.5">
              <label className="relative size-7 cursor-pointer overflow-hidden rounded-lg focus-within:ring-2 focus-within:ring-primary/40" style={{background: s.color}}>
                <select aria-label={`Colour for ${s.name || 'this stage'}`} className="absolute inset-0 cursor-pointer opacity-0" value={s.color} onChange={(e) => patch(i, {color: e.target.value})}>
                  {PALETTE.map((c) => <option key={c} value={c}>{colourName(c)}</option>)}
                </select>
              </label>
              <Input className="h-9 bg-card" value={s.name} onChange={(e) => patch(i, {name: e.target.value})} onBlur={f.blur('stages')} aria-label="Stage name" aria-invalid={stagesError && (!s.name.trim() || s.name.trim().length > 60) ? true : undefined} aria-describedby={stagesError ? `${pipeline.id}-stages-error` : undefined} />
              <Input className="h-9 bg-card" type="number" inputMode="numeric" value={s.probability} onChange={(e) => patch(i, {probability: Number(e.target.value)})} onBlur={f.blur('stages')} aria-label="Win probability" aria-invalid={stagesError && (!Number.isInteger(s.probability) || s.probability < 0 || s.probability > 100) ? true : undefined} aria-describedby={stagesError ? `${pipeline.id}-stages-error` : undefined} />
              <div className="flex">
                <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={stages.length <= 1} onClick={() => setStages(stages.filter((_, j) => j !== i))} aria-label="Remove stage"><Trash2 /></Button>
              </div>
            </div>
          ))}
          {stagesError && <p id={`${pipeline.id}-stages-error`} role="alert" className="px-1 text-xs font-medium text-destructive">{stagesError}</p>}
        </div>
        {isAdmin && (
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => setStages([...stages, {name: 'New stage', probability: 50, color: PALETTE[stages.length % PALETTE.length]!}])}><Plus /> Add stage</Button>
            <Button type="submit" disabled={busy} pending={save.isPending && !save.variables?.isDefault} pendingLabel="Saving…">Save pipeline</Button>
          </div>
        )}
      </fieldset>
      </form>
    </SettingsSection>
  );
}

/** Every pipeline with its stages, editable in place; used in Settings and on the Deals page. */
export function PipelineManager() {
  const {isAdmin} = useMe();
  const pipelines = usePipelines();
  const [name, setName] = useState('');
  const create = useApiMutation(() => api.post('/pipelines', {name: name.trim()}), {invalidate: [keys.pipelines], success: 'Pipeline created', onSuccess: () => setName('')});
  return (
    <div>
      {pipelines.isError && <LoadError error={pipelines.error} onRetry={() => pipelines.refetch()} />}
      {pipelines.data?.map((p) => <PipelineEditor key={`${p.id}-${p.stages.map((s) => s.id).join()}`} pipeline={p} />)}
      {isAdmin && (
        <form noValidate onSubmit={(e) => (e.preventDefault(), name.trim() && create.mutate(undefined))} className="flex gap-2">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="New pipeline name, e.g. Partnerships" aria-label="New pipeline name" />
          <Button type="submit" variant="secondary" disabled={!name.trim()} pending={create.isPending} pendingLabel="Creating…"><Plus /> Create pipeline</Button>
        </form>
      )}
    </div>
  );
}
