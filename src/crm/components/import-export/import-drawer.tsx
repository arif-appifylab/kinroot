import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileUp, Loader2, Upload, XCircle} from 'lucide-react';
import Papa from 'papaparse';
import {useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';

import {LoadError} from '@/components/data-table';
import {useLists} from '@/components/lists/list-picker';
import {TagSelect} from '@/components/pickers';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, NativeSelect} from '@/components/ui/form';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {
  IO_ENTITIES,
  MATCH_RULES,
  MAX_IMPORT_BYTES,
  NEW_OPTION,
  SKIP_VALUE,
  cleanCell,
  defaultImportOptions,
  detectDateOrder,
  importTargets,
  isActive,
  resolveOption,
  splitList,
  valueKey,
  type ImportDetail,
  type ImportOptions,
  type ImportRun,
  type ImportTarget,
  type IoEntity,
  type ValueMap,
} from '@/lib/import-export';
import {keys, recordKeys, useFields, useMe, usePipelines, useTeam} from '@/lib/queries';
import {cn} from '@/lib/utils';
import {uploadFile} from '@/lib/upload';

type Step = 'upload' | 'map' | 'options' | 'review' | 'run';
const STEPS: {key: Step; label: string}[] = [
  {key: 'upload', label: 'Upload'},
  {key: 'map', label: 'Map columns'},
  {key: 'options', label: 'Options'},
  {key: 'review', label: 'Review'},
];

/** The whole file, parsed in the browser: previews, distinct values for option mapping, date format detection. */
type Parsed = {headers: string[]; rows: string[][]};

function parseFile(file: File): Promise<Parsed & {delimiter: string}> {
  return new Promise((resolve, reject) =>
    Papa.parse<string[]>(file, {
      skipEmptyLines: 'greedy',
      complete: (r) => {
        const [head = [], ...rows] = r.data;
        resolve({headers: head.map((h) => String(h ?? '').trim()), rows, delimiter: r.meta.delimiter});
      },
      error: reject,
    }),
  );
}

const stepOf = (imp: ImportRun): Step => (imp.status === 'draft' ? 'map' : imp.status === 'validating' || imp.status === 'ready' ? 'review' : 'run');

/**
 * "Import" on a list page: upload → map columns (custom fields and their
 * options included) → options → server dry run → run as a background job with
 * live progress. Closing the drawer never stops an import; the person is
 * notified (and emailed, if they asked) when it is done.
 */
export function ImportDrawer({entity, open, onOpenChange, importId, listId}: {entity: IoEntity; open: boolean; onOpenChange: (open: boolean) => void; importId?: string; listId?: string}) {
  const [current, setCurrent] = useState<string | null>(importId ?? null);
  const [step, setStep] = useState<Step>('upload');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [options, setOptions] = useState<ImportOptions>(() => ({...defaultImportOptions(), listId: listId ?? null}));
  const [valueChoice, setValueChoice] = useState<ValueMap>({});
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const noun = IO_ENTITIES[entity];

  useEffect(() => {
    if (importId) setCurrent(importId);
  }, [importId]);

  const detail = useQuery({
    queryKey: [...keys.imports, current],
    queryFn: () => api.get<ImportDetail>(`/imports/${current}`),
    enabled: open && !!current,
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.import.status) ? 1500 : false),
  });
  const imp = detail.data?.import;

  // Opened on an existing import (history, notification): jump to where it is.
  useEffect(() => {
    if (!imp || imp.id !== current) return;
    if (step === 'upload' || (stepOf(imp) === 'run' && step !== 'run')) {
      setStep(stepOf(imp));
      setMapping(imp.mapping);
      setOptions(imp.options);
      setValueChoice(imp.options.valueMap ?? {});
    }
  }, [imp?.id, imp?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Records changed: refresh the lists behind the drawer once a run ends.
  const finished = imp && ['done', 'failed', 'canceled'].includes(imp.status);
  useEffect(() => {
    if (finished) for (const queryKey of [...recordKeys, keys.lists, keys.fields(noun.fieldEntity)]) void qc.invalidateQueries({queryKey});
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    setCurrent(null);
    setParsed(null);
    setStep('upload');
    setMapping([]);
    setValueChoice({});
    setOptions({...defaultImportOptions(), listId: listId ?? null});
  }

  async function upload(file: File) {
    if (file.size > MAX_IMPORT_BYTES) return toast.error('CSV files can be up to 10 MB. Split the file and import the parts.');
    setBusy(true);
    try {
      const local = await parseFile(file);
      const r = await uploadFile<{import: ImportRun; badEncoding: boolean}>('/imports', file, {entity, delimiter: local.delimiter, ...(listId ? {listId} : {})});
      if (r.badEncoding) toast.warning('Some characters could not be read. Save the file as “CSV UTF-8” and upload it again if names look wrong.');
      setParsed(local);
      setCurrent(r.import.id);
      setMapping(r.import.mapping);
      setOptions(r.import.options);
      qc.setQueryData([...keys.imports, r.import.id], {import: r.import, issues: [], issueCount: 0} satisfies ImportDetail);
      const dateCols = r.import.mapping.flatMap((m, i) => (m && /date|closedAt/i.test(m) ? [i] : []));
      const order = detectDateOrder(dateCols.flatMap((i) => local.rows.slice(0, 500).map((row) => row[i] ?? '')));
      if (order) setOptions((o) => ({...o, dateOrder: order}));
      setStep('map');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function validate(finalMap: ValueMap) {
    if (!current) return;
    setBusy(true);
    try {
      await api.post(`/imports/${current}/validate`, {mapping, options: {...options, valueMap: finalMap}});
      await qc.invalidateQueries({queryKey: [...keys.imports, current]});
      setStep('review');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    try {
      await api.post(`/imports/${current}/start`);
      await qc.invalidateQueries({queryKey: keys.imports});
      setStep('run');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import {noun.many}</DialogTitle>
          <DialogDescription>From a CSV file. Matches existing {noun.many} by {MATCH_RULES[entity].toLowerCase()}.</DialogDescription>
          {step !== 'run' && (
            <ol className="mt-2 flex flex-wrap gap-1.5" aria-label="Steps">
              {STEPS.map((s, i) => {
                const at = STEPS.findIndex((x) => x.key === step);
                return (
                  <li key={s.key} className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', i === at ? 'bg-accent text-primary' : i < at ? 'text-slate-600' : 'text-muted-foreground')} aria-current={i === at ? 'step' : undefined}>
                    <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px]', i <= at ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500')}>{i + 1}</span>
                    {s.label}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogHeader>
        {step === 'upload' && <UploadStep entity={entity} busy={busy} onFile={upload} onOpen={(id) => setCurrent(id)} />}
        {step === 'map' && imp && <MapStep entity={entity} imp={imp} parsed={parsed} mapping={mapping} setMapping={setMapping} options={options} setOptions={setOptions} valueChoice={valueChoice} setValueChoice={setValueChoice} onBack={reset} onNext={() => setStep('options')} />}
        {step === 'options' && <OptionsStep entity={entity} mapping={mapping} options={options} setOptions={setOptions} busy={busy} onBack={() => setStep('map')} onNext={() => validate(finalValueMap(mapping, valueChoice))} />}
        {step === 'review' && detail.data && <ReviewStep detail={detail.data} busy={busy} onBack={() => setStep('options')} onStart={start} />}
        {step === 'run' && detail.data && <RunStep entity={entity} detail={detail.data} onAnother={reset} onClose={() => onOpenChange(false)} />}
        {(step !== 'upload' && !detail.data) && (
          <DialogBody>
            {detail.isError ? <LoadError error={detail.error} onRetry={() => detail.refetch()} title="This import could not be loaded" /> : <Loader2 className="mx-auto size-6 animate-spin text-primary" />}
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Step 1: upload ─────────────────────────────────────────────────────────

function UploadStep({entity, busy, onFile, onOpen}: {entity: IoEntity; busy: boolean; onFile: (f: File) => void; onOpen: (id: string) => void}) {
  const history = useQuery({queryKey: [...keys.imports, 'list', entity], queryFn: () => api.get<{rows: ImportRun[]}>('/imports', {entity}), select: (d) => d.rows});
  const [drag, setDrag] = useState(false);
  return (
    <DialogBody>
      <label
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        aria-busy={busy || undefined}
        className={cn('flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/30', busy && 'cursor-wait', drag ? 'border-primary bg-accent/60' : 'border-slate-200 bg-slate-50/60 hover:border-primary hover:bg-accent/40')}
      >
        {busy ? <Loader2 className="size-8 animate-spin text-primary" /> : <FileUp className="size-8 text-primary" />}
        <p className="mt-3 text-sm font-semibold text-slate-800">{busy ? 'Reading the file…' : 'Choose or drop a CSV file'}</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">UTF-8, comma or semicolon separated, column names in the first row. Up to 10 MB / 100,000 rows. From Excel: Save as → “CSV UTF-8”.</p>
        <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </label>
      <RecentImports rows={history.data ?? []} onOpen={onOpen} />
    </DialogBody>
  );
}

const STATUS: Record<string, {label: string; tone: 'neutral' | 'blue' | 'green' | 'rose' | 'amber'}> = {
  validating: {label: 'Checking', tone: 'blue'},
  ready: {label: 'Checked', tone: 'neutral'},
  queued: {label: 'Queued', tone: 'blue'},
  running: {label: 'Running', tone: 'blue'},
  done: {label: 'Done', tone: 'green'},
  failed: {label: 'Failed', tone: 'rose'},
  canceled: {label: 'Canceled', tone: 'amber'},
};

function RecentImports({rows, onOpen}: {rows: ImportRun[]; onOpen: (id: string) => void}) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500 uppercase">Recent imports</h3>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left font-semibold text-slate-800 hover:text-primary" onClick={() => onOpen(r.id)}>{r.fileName}</button>
            <Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge>
            <span className="text-xs text-muted-foreground">{r.status === 'done' ? `${r.created} new · ${r.updated} updated${r.failed ? ` · ${r.failed} errors` : ''} · ` : ''}{ago(r.createdAt)}</span>
            {r.hasErrorFile && r.errorFileId && <a className="text-xs font-semibold text-primary hover:underline" href={`/site-api/crm/files/${r.errorFileId}?download=1`}>Errors CSV</a>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Step 2: map columns ────────────────────────────────────────────────────

/** Distinct values (first 100) in one column, multi-select cells split into parts. */
function distinct(parsed: Parsed | null, col: number, multi: boolean) {
  const counts = new Map<string, {raw: string; n: number}>();
  for (const row of parsed?.rows ?? []) {
    const v = cleanCell(row[col]);
    if (!v) continue;
    for (const part of multi ? splitList(v) : [v]) {
      const k = valueKey(part);
      const e = counts.get(k);
      if (e) e.n++;
      else if (counts.size < 100) counts.set(k, {raw: part, n: 1});
    }
  }
  return [...counts.entries()].map(([k, v]) => ({key: k, ...v}));
}

/** The default for a value nobody picked: a matching option, else "add as new" (admins, custom fields) or leave out. */
function defaultChoice(t: ImportTarget, raw: string, canAdd: boolean) {
  const r = resolveOption(t, raw, {});
  if ('value' in r) return r.value;
  return t.allowNew && canAdd ? `${NEW_OPTION}${raw.trim()}` : SKIP_VALUE;
}

/** The value choices for columns that are still mapped (every distinct value has one, so the server never guesses). */
const finalValueMap = (mapping: (string | null)[], choice: ValueMap): ValueMap => Object.fromEntries(Object.entries(choice).filter(([k]) => mapping.includes(k)));

function MapStep(props: {
  entity: IoEntity;
  imp: ImportRun;
  parsed: Parsed | null;
  mapping: (string | null)[];
  setMapping: (m: (string | null)[]) => void;
  options: ImportOptions;
  setOptions: (fn: (o: ImportOptions) => ImportOptions) => void;
  valueChoice: ValueMap;
  setValueChoice: (fn: (v: ValueMap) => ValueMap) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const {entity, imp, parsed, mapping, setMapping, valueChoice, setValueChoice} = props;
  const {isAdmin} = useMe();
  const defs = useFields(IO_ENTITIES[entity].fieldEntity);
  const targets = useMemo(() => importTargets(entity, defs.data ?? []), [entity, defs.data]);
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const headers = imp.headers;
  const sample = (col: number) => (parsed?.rows ?? []).map((r) => cleanCell(r[col])).filter(Boolean).slice(0, 3);
  const used = mapping.filter(Boolean) as string[];
  const twice = used.filter((k, i) => used.indexOf(k) !== i);
  const need = {contact: ['firstName', 'fullName', 'email'], company: ['name', 'domain', 'website'], deal: ['title']}[entity];
  const missing = !need.some((k) => used.includes(k)) && !(used.includes('id') && props.options.mode === 'update');
  const hasDate = used.some((k) => byKey.get(k)?.kind === 'date');

  // Fill in defaults for option values once the targets are known.
  useEffect(() => {
    if (!parsed || !defs.data) return;
    setValueChoice((prev) => {
      const next = {...prev};
      mapping.forEach((key, col) => {
        const t = key ? byKey.get(key) : undefined;
        if (!t || (t.kind !== 'enum' && t.kind !== 'multi')) return;
        const m = {...next[t.key]};
        for (const v of distinct(parsed, col, t.kind === 'multi')) m[v.key] ??= defaultChoice(t, v.raw, isAdmin);
        next[t.key] = m;
      });
      return next;
    });
  }, [mapping, parsed, defs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = ['Fields', 'Related records', 'Custom fields'] as const;
  return (
    <>
      <DialogBody>
        <p className="text-sm text-slate-700">
          <span className="font-semibold">{imp.fileName}</span> · {imp.total.toLocaleString()} rows · {headers.length} columns. {used.length} matched automatically or by you; pick a field for each column you want to bring in.
        </p>
        {parsed && <Preview parsed={parsed} />}
        <div className="grid gap-2">
          {headers.map((h, col) => {
            const key = mapping[col] ?? '';
            const t = key ? byKey.get(key) : undefined;
            return (
              <div key={col} className={cn('rounded-xl border p-2.5 pl-3', twice.includes(key) ? 'border-rose-200 bg-rose-50/40' : 'border-slate-100 bg-slate-50/60')}>
                <div className="grid grid-cols-1 items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_240px]">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">{h || `Column ${col + 1}`}</p>
                    <p className="truncate text-xs text-muted-foreground">{sample(col).join(' · ') || 'empty'}</p>
                  </div>
                  <NativeSelect className="h-9 bg-card" value={key} aria-label={`Field for ${h}`} onChange={(e) => setMapping(mapping.map((m, i) => (i === col ? e.target.value || null : m)))}>
                    <option value="">Don't import</option>
                    {groups.map((g) => {
                      const list = targets.filter((x) => x.group === g);
                      return list.length ? (
                        <optgroup key={g} label={g}>
                          {list.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                        </optgroup>
                      ) : null;
                    })}
                  </NativeSelect>
                </div>
                {t?.hint && <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>}
                {twice.includes(key) && <p className="mt-1 text-xs font-medium text-rose-600">Another column already goes to {t?.label}.</p>}
                {t && (t.kind === 'enum' || t.kind === 'multi') && parsed && (
                  <ValueMapping target={t} values={distinct(parsed, col, t.kind === 'multi')} choice={valueChoice[t.key] ?? {}} canAdd={isAdmin} onChange={(k, v) => setValueChoice((prev) => ({...prev, [t.key]: {...prev[t.key], [k]: v}}))} />
                )}
              </div>
            );
          })}
        </div>
        {hasDate && (
          <Field label="Dates like 03/04/2026 mean" hint="ISO dates (2026-04-03), month names and Excel date numbers are read either way.">
            <NativeSelect value={props.options.dateOrder} onChange={(e) => props.setOptions((o) => ({...o, dateOrder: e.target.value as ImportOptions['dateOrder']}))}>
              <option value="mdy">Month first: March 4, 2026 (US)</option>
              <option value="dmy">Day first: 3 April 2026</option>
            </NativeSelect>
          </Field>
        )}
        {!isAdmin && <p className="text-xs text-muted-foreground">Values that aren't an option of a custom field yet can be added by an admin; here they can be mapped to an existing option or left out.</p>}
      </DialogBody>
      <DialogFooter>
        {missing && <p className="mr-auto self-center text-xs font-medium text-amber-700">{entity === 'contact' ? 'Map a name or an email column.' : entity === 'company' ? 'Map a name or a domain column.' : 'Map the deal name column.'}</p>}
        <Button variant="secondary" onClick={props.onBack}><ArrowLeft /> Another file</Button>
        <Button onClick={props.onNext} disabled={missing || twice.length > 0}>Next <ArrowRight /></Button>
      </DialogFooter>
    </>
  );
}

function Preview({parsed}: {parsed: Parsed}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-100 scrollbar-thin">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>{parsed.headers.map((h, i) => <th key={i} className="px-2.5 py-1.5 font-semibold whitespace-nowrap">{h || `Column ${i + 1}`}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {parsed.rows.slice(0, 5).map((r, i) => (
            <tr key={i}>{parsed.headers.map((_, j) => <td key={j} className="max-w-48 truncate px-2.5 py-1.5 text-slate-700">{r[j]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueMapping({target, values, choice, canAdd, onChange}: {target: ImportTarget; values: {key: string; raw: string; n: number}[]; choice: Record<string, string>; canAdd: boolean; onChange: (key: string, value: string) => void}) {
  if (!values.length) return null;
  const unmatched = values.filter((v) => !target.options?.some((o) => o.value === choice[v.key])).length;
  return (
    <details className="mt-2 rounded-lg bg-card px-3 py-2" open={unmatched > 0}>
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">
        {values.length} value{values.length === 1 ? '' : 's'} in the file{unmatched ? ` · ${unmatched} not an option yet` : ' · all match an option'}
      </summary>
      <div className="mt-2 grid gap-1.5">
        {values.map((v) => (
          <div key={v.key} className="grid grid-cols-1 items-center gap-1.5 @xl:grid-cols-[minmax(0,1fr)_220px]">
            <span className="truncate text-xs text-slate-700">“{v.raw}” <span className="text-muted-foreground">× {v.n}</span></span>
            <NativeSelect className="h-8 text-xs" aria-label={`Value for ${v.raw}`} value={choice[v.key] ?? SKIP_VALUE} onChange={(e) => onChange(v.key, e.target.value)}>
              {target.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              {target.allowNew && canAdd && <option value={`${NEW_OPTION}${v.raw.trim()}`}>+ Add “{v.raw.trim()}” as a new option</option>}
              <option value={SKIP_VALUE}>Leave out</option>
            </NativeSelect>
          </div>
        ))}
      </div>
    </details>
  );
}

// ─── Step 3: options ────────────────────────────────────────────────────────

function OptionsStep({entity, mapping, options, setOptions, busy, onBack, onNext}: {entity: IoEntity; mapping: (string | null)[]; options: ImportOptions; setOptions: (fn: (o: ImportOptions) => ImportOptions) => void; busy: boolean; onBack: () => void; onNext: () => void}) {
  const {me} = useMe();
  const team = useTeam();
  const lists = useLists('STATIC');
  const pipelines = usePipelines();
  const set = (patch: Partial<ImportOptions>) => setOptions((o) => ({...o, ...patch}));
  const noun = IO_ENTITIES[entity];
  const [tagOn, setTagOn] = useState(!!options.tag);
  const suggestedTag = `import-${new Date().toISOString().slice(0, 10)}`;
  const hasCompany = mapping.includes('company') || mapping.includes('companyDomain');
  const modes = [
    {v: 'upsert', label: `Create new and update existing ${noun.many}`},
    {v: 'create', label: `Only create new ${noun.many}`, hint: 'Rows that match an existing record are skipped'},
    {v: 'update', label: `Only update existing ${noun.many}`, hint: 'Rows without a match are skipped'},
  ] as const;
  return (
    <>
      <DialogBody>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold text-slate-700">What to do</legend>
          {modes.map((m) => (
            <label key={m.v} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm', options.mode === m.v ? 'border-primary bg-accent/40' : 'border-slate-100')}>
              <input type="radio" name="imp-mode" className="mt-0.5 accent-[var(--primary)]" checked={options.mode === m.v} onChange={() => set({mode: m.v})} />
              <span>
                <span className="font-semibold text-slate-800">{m.label}</span>
                {'hint' in m && <span className="block text-xs text-muted-foreground">{m.hint}</span>}
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Matching: {MATCH_RULES[entity]}. Rows that repeat a match key from an earlier row are skipped.</p>
        </fieldset>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={options.skipBlanks} onCheckedChange={(v) => set({skipBlanks: v === true})} className="mt-0.5" />
          <span><span className="font-semibold text-slate-800">Don't overwrite existing values with blanks</span><span className="block text-xs text-muted-foreground">Off: an empty cell clears that field on records that are updated.</span></span>
        </label>
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
          <Field label="Owner for rows without one">
            <NativeSelect value={options.defaultOwner ?? ''} onChange={(e) => set({defaultOwner: e.target.value || null})}>
              <option value="me">Me ({me.name})</option>
              {team.data?.filter((u) => u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              <option value="">No owner</option>
            </NativeSelect>
          </Field>
          {entity === 'contact' && (
            <Field label="Add to a static list" hint="Contacts that already exist are added too.">
              <NativeSelect value={options.listId ?? ''} onChange={(e) => set({listId: e.target.value || null})}>
                <option value="">No list</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </NativeSelect>
            </Field>
          )}
          {entity === 'deal' && (
            <Field label={mapping.includes('pipeline') ? 'Pipeline for rows without one' : 'Pipeline'}>
              <NativeSelect value={options.pipelineId ?? ''} onChange={(e) => set({pipelineId: e.target.value || null})}>
                <option value="">Default pipeline</option>
                {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </Field>
          )}
        </div>
        {entity !== 'company' && hasCompany && (
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={options.createCompanies} onCheckedChange={(v) => set({createCompanies: v === true})} className="mt-0.5" />
            <span><span className="font-semibold text-slate-800">Create companies that don't exist yet</span><span className="block text-xs text-muted-foreground">Companies are matched by domain, then by name. Off: unknown companies are left unlinked.</span></span>
          </label>
        )}
        <div className="grid gap-2">
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox checked={tagOn} onCheckedChange={(v) => (setTagOn(v === true), set({tag: v === true ? options.tag || suggestedTag : null}))} />
            <span className="font-semibold text-slate-800">Tag every imported {noun.one}</span>
          </label>
          {tagOn && (
            <div className="@xl:max-w-xs">
              <TagSelect value={options.tag} onChange={(tag) => set({tag: tag.slice(0, 40) || null})} entity={entity === 'company' ? 'COMPANY' : entity === 'deal' ? 'DEAL' : 'CONTACT'} placeholder="Pick or create a tag" />
            </div>
          )}
        </div>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={options.emailMe} onCheckedChange={(v) => set({emailMe: v === true})} className="mt-0.5" />
          <span><span className="font-semibold text-slate-800">Email me when it's done</span><span className="block text-xs text-muted-foreground">You get an in-app notification either way.</span></span>
        </label>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onBack} disabled={busy}><ArrowLeft /> Back</Button>
        <Button onClick={onNext} pending={busy} pendingLabel="Checking…">Check the file <ArrowRight /></Button>
      </DialogFooter>
    </>
  );
}

// ─── Step 4: review (server dry run) ────────────────────────────────────────

function Counts({items}: {items: {label: string; n: number; tone?: string}[]}) {
  return (
    <div className="grid grid-cols-2 gap-2 @lg:grid-cols-5">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
          <p className={cn('text-xl font-extrabold tabular-nums', i.tone ?? 'text-slate-900')}>{i.n.toLocaleString()}</p>
          <p className="text-xs font-medium text-muted-foreground">{i.label}</p>
        </div>
      ))}
    </div>
  );
}

function Issues({detail, phase}: {detail: ImportDetail; phase: 'validate' | 'run'}) {
  const {issues, issueCount, import: imp} = detail;
  if (!issues.length) return null;
  const errors = phase === 'run' ? imp.failed : imp.preview?.errors ?? imp.failed;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold tracking-wide text-slate-500 uppercase">Rows to look at</h3>
        <span className="text-xs text-muted-foreground">{issueCount > issues.length ? `first ${issues.length} of ${issueCount}` : issueCount}</span>
        {errors > 0 && (
          <a className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" href={phase === 'run' && imp.errorFileId ? `/site-api/crm/files/${imp.errorFileId}?download=1` : `/site-api/crm/imports/${imp.id}/errors.csv?phase=${phase}`}>
            <Download className="size-3.5" /> Rows with errors (CSV)
          </a>
        )}
      </div>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100 scrollbar-thin">
        {issues.map((i) => (
          <li key={i.id} className="flex items-start gap-2 px-3 py-2 text-xs">
            {i.level === 'error' ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-600" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />}
            <span className="w-14 shrink-0 font-semibold text-slate-500 tabular-nums">Row {i.row}</span>
            <span className="min-w-0 text-slate-700">{i.column && <span className="font-semibold">{i.column}: </span>}{i.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewStep({detail, busy, onBack, onStart}: {detail: ImportDetail; busy: boolean; onBack: () => void; onStart: () => void}) {
  const imp = detail.import;
  const checking = imp.status === 'validating';
  const p = imp.preview;
  const n = p ? p.create + p.update : 0;
  return (
    <>
      <DialogBody>
        {checking || !p ? (
          <div className="grid gap-2 rounded-xl bg-slate-50 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Loader2 className="size-4 animate-spin text-primary" /> Checking every row…</p>
            <Progress value={imp.processed} max={imp.total} />
            <p className="text-xs text-muted-foreground">{imp.processed.toLocaleString()} of {imp.total.toLocaleString()} rows. Nothing is saved yet.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-700">The check ran every row the way the import will. Nothing is saved yet.</p>
            <Counts items={[{label: 'New', n: p.create, tone: 'text-emerald-700'}, {label: 'Updated', n: p.update, tone: 'text-blue-700'}, {label: 'Skipped', n: p.skip}, {label: 'Errors', n: p.errors, tone: p.errors ? 'text-rose-700' : undefined}, {label: 'Warnings', n: p.warnings, tone: p.warnings ? 'text-amber-700' : undefined}]} />
            {!!p.newCompanies && <p className="text-xs text-muted-foreground">About {p.newCompanies} new compan{p.newCompanies === 1 ? 'y' : 'ies'} will be created for rows whose company doesn't exist yet.</p>}
            {p.errors > 0 && <p className="text-xs text-muted-foreground">Rows with errors are left out; fix them in the CSV and import that file again.</p>}
          </>
        )}
        <Issues detail={detail} phase="validate" />
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onBack} disabled={checking || busy}><ArrowLeft /> Back</Button>
        <Button onClick={onStart} disabled={checking || !n} pending={busy} pendingLabel="Starting…"><Upload /> Import {n.toLocaleString()} row{n === 1 ? '' : 's'}</Button>
      </DialogFooter>
    </>
  );
}

function Progress({value, max}: {value: number; max: number}) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{width: `${pct}%`}} />
    </div>
  );
}

// ─── Running / finished ─────────────────────────────────────────────────────

function RunStep({entity, detail, onAnother, onClose}: {entity: IoEntity; detail: ImportDetail; onAnother: () => void; onClose: () => void}) {
  const imp = detail.import;
  const noun = IO_ENTITIES[entity];
  const running = imp.status === 'queued' || imp.status === 'running';
  const [stopping, setStopping] = useState(false);
  async function cancel() {
    if (!(await confirm({title: 'Stop this import?', description: 'Rows imported so far stay. The rest of the file is left out.', confirmLabel: 'Stop import', destructive: true}))) return;
    setStopping(true);
    await api.post(`/imports/${imp.id}/cancel`).catch((e: Error) => toast.error(e.message));
    setStopping(false);
  }
  return (
    <>
      <DialogBody>
        <div className="flex items-center gap-2">
          {running ? <Loader2 className="size-5 animate-spin text-primary" /> : imp.status === 'done' ? <CheckCircle2 className="size-5 text-emerald-600" /> : <XCircle className="size-5 text-rose-600" />}
          <p className="text-sm font-semibold text-slate-800">
            {running ? `Importing ${imp.fileName}…` : imp.status === 'done' ? `Import finished: ${imp.fileName}` : imp.status === 'canceled' ? 'Import stopped' : `Import failed: ${imp.error ?? ''}`}
          </p>
        </div>
        {running && (
          <div className="grid gap-1.5">
            <Progress value={imp.processed} max={imp.total} />
            <p className="text-xs text-muted-foreground">{imp.processed.toLocaleString()} of {imp.total.toLocaleString()} rows. You can close this drawer: the import keeps going and you'll get a notification{imp.options.emailMe ? ' and an email' : ''} when it's done.</p>
          </div>
        )}
        <Counts items={[{label: 'Created', n: imp.created, tone: 'text-emerald-700'}, {label: 'Updated', n: imp.updated, tone: 'text-blue-700'}, {label: 'Skipped', n: imp.skipped}, {label: 'Errors', n: imp.failed, tone: imp.failed ? 'text-rose-700' : undefined}, {label: 'Warnings', n: imp.warnings, tone: imp.warnings ? 'text-amber-700' : undefined}]} />
        {!running && (imp.stats.companiesCreated || imp.stats.listAdded || imp.stats.notes) ? (
          <p className="text-xs text-muted-foreground">
            {[imp.stats.companiesCreated && `${imp.stats.companiesCreated} compan${imp.stats.companiesCreated === 1 ? 'y' : 'ies'} created`, imp.stats.listAdded && `${imp.stats.listAdded} added to the list`, imp.stats.notes && `${imp.stats.notes} notes added`].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <Issues detail={detail} phase="run" />
      </DialogBody>
      <DialogFooter>
        {running ? (
          <>
            <Button variant="secondary" onClick={cancel} pending={stopping} pendingLabel="Stopping…">Stop import</Button>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onAnother}>Import another file</Button>
            {imp.options.tag && entity !== 'deal' ? (
              <Button asChild onClick={onClose}><Link to={noun.path} search={{tag: imp.options.tag}}>View imported {noun.many}</Link></Button>
            ) : (
              <Button onClick={onClose}>Done</Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}

