import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Download, ExternalLink, Handshake, Inbox, Paperclip, Trash2, User} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {ago, dateTime, fullName} from '@/lib/format';
import {answerText, isInput, type FormField} from '@/lib/forms';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {FormSubmissionRow} from '@/lib/types';

import {CountBarChart} from '../charts';
import {DataTable, LoadError, Pagination, SearchInput, type Column} from '../data-table';
import {FilterBar} from '../filter-bar';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {confirm} from '../ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {EmptyState} from '../ui/misc';

type Stats = {views: number; starts: number; submissions: number; daily: {day: string; submissions: number}[]};

// Capped: API or test submissions can outnumber counted views.
const pct = (a: number, b: number) => (b ? `${Math.min(100, Math.round((a / b) * 100))}%` : '—');

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function Stat({label, value, hint}: {label: string; value: string; hint?: string}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Results tab: funnel tiles, responses per day, the responses table, CSV export. */
export function ResultsPanel({formId, fields}: {formId: string; fields: FormField[]}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<FormSubmissionRow | null>(null);
  const stats = useQuery({queryKey: [...keys.forms, formId, 'stats'], queryFn: () => api.get<Stats>(`/forms/${formId}/stats`)});
  const list = useQuery({
    queryKey: [...keys.forms, formId, 'submissions', page, q],
    queryFn: () => api.get<{rows: FormSubmissionRow[]; total: number; page: number; pageSize: number}>(`/forms/${formId}/submissions`, {page, q: q || undefined}),
    placeholderData: keepPreviousData,
  });

  const s = stats.data;
  const daily = (s?.daily ?? []).map((d) => ({...d, label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'})}));
  // Two answer columns from the first questions, so the table stays readable.
  const preview = fields.filter((f) => isInput(f.type) && !['name', 'email', 'hidden', 'consent', 'file'].includes(f.type)).slice(0, 2);

  const columns: Column<FormSubmissionRow>[] = [
    {
      key: 'who',
      header: 'Respondent',
      cell: (r) => (
        <div className="min-w-0">
          {/* The row opens the response; this button is its keyboard / screen-reader way in. */}
          <button
            type="button"
            onClick={(e) => (e.stopPropagation(), setOpen(r))}
            className="block max-w-full cursor-pointer truncate rounded text-left font-semibold text-slate-900 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            {r.contact ? fullName(r.contact) : 'Anonymous'}
            <span className="sr-only">: open this response</span>
          </button>
          <p className="truncate text-xs text-muted-foreground">{r.email ?? '—'}</p>
        </div>
      ),
    },
    ...preview.map((f) => ({
      key: f.id,
      header: f.label,
      hideBelow: 'md' as const,
      cell: (r: FormSubmissionRow) => {
        const a = r.answers.find((x) => x.fieldId === f.id);
        return <span className="line-clamp-2 text-slate-700">{a ? answerText(a.type, a.value) : <span className="text-slate-300">—</span>}</span>;
      },
    })),
    {key: 'source', header: 'Source', hideBelow: 'lg', cell: (r) => <span className="text-xs text-muted-foreground">{r.meta.utm_source ?? (r.meta.referrer ? host(r.meta.referrer) : 'Direct')}</span>},
    {key: 'createdAt', header: 'Submitted', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{ago(r.createdAt)}</span>},
  ];

  return (
    <div className="grid gap-6">
      {stats.isError && (
        <Card>
          <LoadError title="The numbers could not be loaded" error={stats.error} onRetry={() => stats.refetch()} />
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Views" value={(s?.views ?? 0).toLocaleString()} hint="Unique per visit" />
        <Stat label="Started" value={(s?.starts ?? 0).toLocaleString()} hint={`${pct(s?.starts ?? 0, s?.views ?? 0)} of views`} />
        <Stat label="Responses" value={(s?.submissions ?? 0).toLocaleString()} hint={`${pct(s?.submissions ?? 0, s?.starts ?? 0)} of starts`} />
        <Stat label="Conversion" value={pct(s?.submissions ?? 0, s?.views ?? 0)} hint="Responses ÷ views" />
      </div>

      <Card className="p-5">
        <p className="text-sm font-bold text-slate-900">Responses, last 30 days</p>
        <div className="mt-3">{s && <CountBarChart data={daily} xKey="label" yKey="submissions" noun="response" />}</div>
      </Card>

      <Card className="overflow-hidden">
        <FilterBar className="border-b border-slate-100 p-3">
          <SearchInput size="sm" value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Search by name or email" />
          <Button variant="secondary" size="sm" className="ml-auto" asChild>
            <a href={`/site-api/crm/forms/${formId}/export`}><Download /> Export CSV</a>
          </Button>
        </FilterBar>
        <DataTable
          rows={list.data?.rows}
          loading={list.isLoading}
          error={list.isError && !list.data ? list.error : undefined}
          onRetry={() => list.refetch()}
          columns={columns}
          onRowClick={setOpen}
          empty={<EmptyState icon={<Inbox />} title={q ? 'No matching responses' : 'No responses yet'} description={q ? undefined : 'Share the form; responses show up here and on each contact.'} />}
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </Card>

      {open && <ResponseDialog response={open} formId={formId} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ResponseDialog({response: r, formId, onClose}: {response: FormSubmissionRow; formId: string; onClose: () => void}) {
  const {canEdit} = useMe();
  const remove = useApiMutation(() => api.del(`/forms/submissions/${r.id}`), {invalidate: [[...keys.forms, formId], keys.forms, keys.timeline], success: 'Response deleted', onSuccess: onClose});
  const meta = Object.entries(r.meta).filter(([k]) => k.startsWith('utm_') || k === 'referrer' || k === 'page');
  return (
    <Dialog open onOpenChange={(o) => !o && !remove.isPending && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{r.contact ? fullName(r.contact) : 'Anonymous response'}</DialogTitle>
          <DialogDescription>Submitted {dateTime(r.createdAt)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {(r.contact || r.deal) && (
            <div className="flex flex-wrap gap-2">
              {r.contact && (
                <Button variant="secondary" size="sm" asChild>
                  <Link to="/contacts/$contactId" params={{contactId: r.contact.id}}><User /> Open contact</Link>
                </Button>
              )}
              {r.deal && (
                <Button variant="secondary" size="sm" asChild>
                  <Link to="/deals/$dealId" params={{dealId: r.deal.id}}><Handshake /> {r.deal.title}</Link>
                </Button>
              )}
            </div>
          )}
          <dl className="grid gap-3">
            {r.answers.map((a) => (
              <div key={a.fieldId} className="rounded-xl bg-slate-50 px-3 py-2.5">
                <dt className="text-xs font-semibold text-muted-foreground">{a.label}</dt>
                <dd className="mt-0.5 text-sm whitespace-pre-wrap text-slate-900">
                  {a.type === 'file'
                    ? (a.value as {id: string; name: string}[]).map((f) => (
                        <a key={f.id} href={`/site-api/crm/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="mr-3 inline-flex items-center gap-1 font-medium text-primary hover:underline">
                          <Paperclip className="size-3.5" /> {f.name}
                        </a>
                      ))
                    : answerText(a.type, a.value)}
                </dd>
              </div>
            ))}
          </dl>
          {meta.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Attribution</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
                {meta.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="truncate text-slate-700">
                      {/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-primary">{v} <ExternalLink className="size-3" /></a> : v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {canEdit && (
            <Button variant="ghost" className="mr-auto text-destructive hover:bg-rose-50 hover:text-destructive" pending={remove.isPending} pendingLabel="Deleting…" onClick={async () => (await confirm({title: 'Delete this response?', description: 'The contact stays.', confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button onClick={onClose} disabled={remove.isPending}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
