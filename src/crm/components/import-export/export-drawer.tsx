import {useQuery, useQueryClient} from '@tanstack/react-query';
import {CheckCircle2, Download, Loader2, Mail, XCircle} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';

import {LoadError} from '@/components/data-table';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/form';
import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {ACTIVE_EXPORT, DIRECT_EXPORT_ROWS, IO_ENTITIES, IO_FILE_DAYS, exportColumns, type ExportRun, type IoEntity} from '@/lib/import-export';
import {keys, useFields} from '@/lib/queries';

const STORE = 'kr-export-columns';

/** Remembered column picks per object (this browser only). */
function savedColumns(entity: IoEntity): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(`${STORE}:${entity}`) ?? 'null');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * "Export" on a list page: the rows the page shows (its filters / saved view,
 * or a list's members), the columns to include, and "Email me the file".
 * Small exports download at once; big ones run in the background and arrive
 * by email (signed link, 7 days) and as a notification.
 */
export function ExportDrawer({entity, open, onOpenChange, filters, listId, scopeLabel}: {entity: IoEntity; open: boolean; onOpenChange: (open: boolean) => void; filters: Record<string, string | undefined>; listId?: string; scopeLabel: string}) {
  const noun = IO_ENTITIES[entity];
  const defs = useFields(noun.fieldEntity);
  const columns = useMemo(() => exportColumns(entity, defs.data ?? []), [entity, defs.data]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [emailMe, setEmailMe] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;

  useEffect(() => {
    if (!open || !defs.data || picked) return;
    const saved = savedColumns(entity);
    setPicked(new Set(saved?.length ? saved.filter((k) => columns.some((c) => c.key === k)) : columns.filter((c) => c.key !== 'updatedAt').map((c) => c.key)));
  }, [open, defs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = useQuery({
    queryKey: [...keys.exports, 'count', entity, clean, listId],
    queryFn: () => api.post<{count: number}>('/exports/count', {entity, filters: clean, listId}),
    enabled: open,
    select: (d) => d.count,
  });
  const history = useQuery({queryKey: [...keys.exports, 'list', entity], queryFn: () => api.get<{rows: ExportRun[]}>('/exports', {entity}), enabled: open, select: (d) => d.rows});
  const job = useQuery({
    queryKey: [...keys.exports, running],
    queryFn: () => api.get<{export: ExportRun}>(`/exports/${running}`),
    enabled: open && !!running,
    select: (d) => d.export,
    refetchInterval: (q) => (q.state.data && ACTIVE_EXPORT.has(q.state.data.export.status) ? 1500 : false),
  });

  const big = (count.data ?? 0) > DIRECT_EXPORT_ROWS;
  const order = columns.filter((c) => picked?.has(c.key)).map((c) => c.key);

  async function run() {
    setBusy(true);
    try {
      try {
        localStorage.setItem(`${STORE}:${entity}`, JSON.stringify(order));
      } catch {
        /* private mode */
      }
      const {export: exp} = await api.post<{export: ExportRun}>('/exports', {entity, filters: clean, listId, columns: order, emailMe: emailMe || big});
      await qc.invalidateQueries({queryKey: [...keys.exports, 'list', entity]});
      if (exp.status === 'done' && exp.downloadUrl) {
        window.location.assign(exp.downloadUrl);
        toast.success(`Exported ${exp.processed.toLocaleString()} ${noun.many}${exp.emailed ? ' · also emailed to you' : ''}`);
      } else setRunning(exp.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const groups = ['Fields', 'Related records', 'Custom fields', 'System'] as const;
  const exp = job.data;
  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), !o && setRunning(null))}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Export {noun.many}</DialogTitle>
          <DialogDescription>
            {count.isLoading ? 'Counting…' : count.isError ? 'Could not count the rows' : `${(count.data ?? 0).toLocaleString()} ${noun.many}`} · {scopeLabel}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {running && job.isError && !exp ? (
            <LoadError error={job.error} onRetry={() => job.refetch()} title="The export's progress could not be loaded" />
          ) : exp ? (
            <div className="grid gap-2 rounded-xl bg-slate-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                {ACTIVE_EXPORT.has(exp.status) ? <Loader2 className="size-4 animate-spin text-primary" /> : exp.status === 'done' ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-rose-600" />}
                {ACTIVE_EXPORT.has(exp.status) ? 'Exporting in the background…' : exp.status === 'done' ? 'Your export is ready' : `Export failed: ${exp.error ?? ''}`}
              </p>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{width: `${exp.total ? Math.round((exp.processed / exp.total) * 100) : 0}%`}} /></div>
              <p className="text-xs text-muted-foreground">
                {exp.processed.toLocaleString()} of {exp.total.toLocaleString()} rows.{' '}
                {exp.status === 'done' ? (exp.emailed ? 'The download link was emailed to you as well.' : 'No team mailbox is connected, so it was not emailed; it is in your notifications.') : 'You can close this drawer: the link arrives by email and as a notification.'}
              </p>
              {exp.downloadUrl && <Button asChild className="justify-self-start"><a href={exp.downloadUrl}><Download /> Download {exp.fileName}</a></Button>}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-700">Columns <span className="font-normal text-muted-foreground">({order.length} of {columns.length})</span></p>
                <Button variant="link" size="sm" className="ml-auto h-auto" onClick={() => setPicked(new Set(columns.map((c) => c.key)))}>All</Button>
                <Button variant="link" size="sm" className="h-auto" onClick={() => setPicked(new Set())}>None</Button>
              </div>
              {groups.map((g) => {
                const list = columns.filter((c) => c.group === g);
                if (!list.length) return null;
                return (
                  <fieldset key={g}>
                    <legend className="mb-1.5 text-xs font-bold tracking-wide text-slate-500 uppercase">{g}</legend>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 @md:grid-cols-2">
                      {list.map((c) => (
                        <label key={c.key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                          <Checkbox checked={picked?.has(c.key) ?? false} onCheckedChange={(v) => setPicked((s) => {
                            const next = new Set(s);
                            if (v === true) next.add(c.key);
                            else next.delete(c.key);
                            return next;
                          })} />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
              <label className="flex items-start gap-2.5 rounded-xl border border-slate-100 p-3 text-sm">
                <Checkbox checked={emailMe || big} disabled={big} onCheckedChange={(v) => setEmailMe(v === true)} className="mt-0.5" />
                <span>
                  <span className="flex items-center gap-1.5 font-semibold text-slate-800"><Mail className="size-4 text-slate-400" /> Email me the file</span>
                  <span className="block text-xs text-muted-foreground">
                    {big ? `More than ${DIRECT_EXPORT_ROWS.toLocaleString()} rows: the export runs in the background and the link is emailed to you.` : `A download link that works for ${IO_FILE_DAYS} days.`}
                  </span>
                </span>
              </label>
            </>
          )}
          {!!history.data?.length && (
            <section>
              <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500 uppercase">Recent exports</h3>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
                {history.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{r.fileName}</span>
                    <Badge tone={r.status === 'done' ? 'green' : r.status === 'failed' ? 'rose' : 'blue'}>{r.status === 'done' ? `${r.processed.toLocaleString()} rows` : r.status === 'failed' ? 'Failed' : 'Running'}</Badge>
                    <span className="text-xs text-muted-foreground">{ago(r.createdAt)}</span>
                    {r.downloadUrl ? <a className="text-xs font-semibold text-primary hover:underline" href={r.downloadUrl}>Download</a> : r.status === 'done' && <span className="text-xs text-muted-foreground">expired</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </DialogBody>
        <DialogFooter>
          {exp ? (
            <>
              <Button variant="secondary" onClick={() => setRunning(null)}>New export</Button>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={run} disabled={!order.length || count.data === 0} pending={busy} pendingLabel="Exporting…">
                <Download /> {big ? 'Export in the background' : 'Export CSV'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
