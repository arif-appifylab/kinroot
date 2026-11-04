import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {FlaskConical, Play, Workflow} from 'lucide-react';
import {useState} from 'react';

import {OBJECTS, TEST_MODES, type AutoObject, type Target, type TestMode} from '@/lib/automations';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {Paged, TicketRow} from '@/lib/types';

import {useLists} from '../lists/list-picker';
import {DealPicker, SingleCompanyPicker, SingleContactPicker} from '../pickers';
import {PropertyCard} from '../properties';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, NativeSelect} from '../ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '../ui/menu';
import type {RunRow} from './hooks';
import {RunStatusBadge} from './meta';
import {RunDialog} from './runs';

function TicketPicker({onChange}: {onChange: (id: string | null) => void}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState('');
  const list = useQuery({queryKey: [...keys.tickets, 'picker', q], queryFn: () => api.get<Paged<TicketRow>>('/tickets', {q, status: 'all', pageSize: 20})});
  return (
    <div className="grid gap-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tickets by subject or number…" aria-label="Search tickets" />
      <NativeSelect value={picked} onChange={(e) => (setPicked(e.target.value), onChange(e.target.value || null))} aria-label="Ticket">
        <option value="">Pick a ticket…</option>
        {list.data?.rows.map((t) => <option key={t.id} value={t.id}>#{t.number} {t.subject}</option>)}
      </NativeSelect>
    </div>
  );
}

/** One record of a type, by id. */
export function RecordPicker({object, onChange}: {object: AutoObject; onChange: (id: string | null) => void}) {
  const [deal, setDeal] = useState<{id: string; title: string} | null>(null);
  if (object === 'contact') return <SingleContactPicker onChange={onChange} />;
  if (object === 'company') return <SingleCompanyPicker onChange={onChange} />;
  if (object === 'deal') return <DealPicker value={deal} onChange={(d) => (setDeal(d), onChange(d?.id ?? null))} />;
  if (object === 'ticket') return <TicketPicker onChange={onChange} />;
  return null;
}

/**
 * Picks the record a test runs on: a simulation (nothing happens) or, for
 * `record`, a test for real (the caller confirms before it starts).
 */
export function TestRecordDialog({object, mode, onPick, onClose}: {object: AutoObject; mode: TestMode; onPick: (recordId: string) => void; onClose: () => void}) {
  const [recordId, setRecordId] = useState<string | null>(null);
  const noun = OBJECTS[object as Exclude<AutoObject, 'none'>]?.label ?? 'Record';
  const real = mode === 'record';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{real ? `Test on a ${noun.toLowerCase()}` : `Pick a ${noun.toLowerCase()} to test on`}</DialogTitle>
          <DialogDescription>
            {real ? `The automation as it is in the editor runs on the ${noun.toLowerCase()} you pick, and every step really happens to them.` : `${TEST_MODES[mode].label}: the automation as it is in the editor is simulated on this ${noun.toLowerCase()}. Nothing is changed, created or sent.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label={noun}>
            <RecordPicker object={object} onChange={setRecordId} />
          </Field>
          {real && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Fields change, tasks, deals and tickets are created, emails and notifications go out and webhooks are called. Waits last their real time.</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant={real ? 'destructive' : 'default'} onClick={() => recordId && onPick(recordId)} disabled={!recordId}>
            <FlaskConical /> {real ? 'Run for real' : 'Run test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Start a manual automation on one record or on every contact of a list. */
export function ManualRunDialog({automation, mode, onClose}: {automation: {id: string; name: string; object: AutoObject}; mode: 'record' | 'list'; onClose: () => void}) {
  const [recordId, setRecordId] = useState<string | null>(null);
  const [listId, setListId] = useState('');
  const lists = useLists();
  const run = useApiMutation(() => (mode === 'record' ? api.post(`/automations/${automation.id}/run`, {recordId}) : api.post(`/automations/${automation.id}/run-list`, {listId})), {
    invalidate: [keys.automations],
    success: mode === 'record' ? 'Automation started' : 'Starting a run for every contact in the list',
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !run.isPending && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{mode === 'record' ? 'Run on a record' : 'Run on a list or segment'}</DialogTitle>
          <DialogDescription>{automation.name}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {mode === 'record' ? (
            <Field label={OBJECTS[automation.object as Exclude<AutoObject, 'none'>]?.label ?? 'Record'}><RecordPicker object={automation.object} onChange={setRecordId} /></Field>
          ) : (
            <Field label="List or segment" hint="One run per contact you can see in it, started in batches. Re-enrollment settings apply.">
              <NativeSelect value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Pick…</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}{l.kind === 'DYNAMIC' ? ' (segment)' : ''} · {l.count}</option>)}
              </NativeSelect>
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>Cancel</Button>
          <Button onClick={() => run.mutate(undefined)} disabled={mode === 'record' ? !recordId : !listId} pending={run.isPending} pendingLabel="Starting…"><Play /> Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Automations" card on record pages: recent runs for this record, and manual automations to start on it. */
export function AutomationsCard({object, recordId}: {object: Target; recordId: string}) {
  const {canEdit} = useMe();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...keys.automations, 'record', object, recordId],
    queryFn: () => api.get<{runs: RunRow[]; manual: {id: string; name: string; description: string | null}[]}>('/automations/for-record', {object, recordId}),
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'running') ? 4_000 : false),
  });
  const start = useApiMutation((automationId: string) => api.post(`/automations/${automationId}/run`, {recordId}), {invalidate: [keys.automations, keys.timeline], success: 'Automation started'});
  const runs = q.data?.runs ?? [];
  const manual = q.data?.manual ?? [];
  if (q.data && !runs.length && !manual.length) return null;
  return (
    <>
      <PropertyCard
        title="Automations"
        action={canEdit && manual.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" pending={start.isPending} pendingLabel="Starting…"><Play /> Run</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
              <DropdownMenuLabel>Run on this {object}</DropdownMenuLabel>
              {manual.map((a) => (
                <DropdownMenuItem key={a.id} onSelect={() => start.mutate(a.id)}>
                  <Workflow />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{a.name}</span>
                    {a.description && <span className="block truncate text-xs font-normal text-muted-foreground">{a.description}</span>}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      >
        {q.isError && !q.data && (
          <p role="alert" className="px-3 py-3 text-sm text-destructive">
            Automations could not be loaded.{' '}
            <button type="button" onClick={() => q.refetch()} className="cursor-pointer rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/30">Retry</button>
          </p>
        )}
        {q.data && !runs.length && <p className="px-3 py-3 text-sm text-muted-foreground">No automation has run on this {object} yet.</p>}
        {runs.map((r) => (
          <button key={r.id} type="button" onClick={() => setOpen(r.id)} className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary/30">
            <Workflow className="mt-0.5 size-4 shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-800">{r.automation?.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <RunStatusBadge status={r.status} />
                {r.test && <Badge tone="outline">Test</Badge>}
                <span>{ago(r.startedAt)}</span>
              </div>
            </div>
          </button>
        ))}
        {runs.length > 0 && <Link to="/automations" className="block px-3 py-2 text-xs font-semibold text-primary hover:underline">All automations</Link>}
      </PropertyCard>
      {open && <RunDialog runId={open} onClose={() => setOpen(null)} />}
    </>
  );
}


