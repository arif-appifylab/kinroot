import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {CheckCircle2, ChevronDown, Clock, Copy, ExternalLink, Eye, EyeOff, Power, PowerOff, RefreshCw, ScrollText, TriangleAlert, Webhook} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {api, shownInPlace} from '@/lib/api';
import {DATA_IN_ACTIONS, dataInAction, type DataInAction, type DataInLogRow, type DataInRecord} from '@/lib/data-in';
import {DATA_IN_URL_HEADERS, DATA_IN_URL_LIMITS, dataInUrlFor, dataInUrlParams, SIGNATURE_TOKEN_HEADER, type DataInUrlOverview, type DataInUrlTokens} from '@/lib/data-in-url';
import {ago, dateTime} from '@/lib/format';
import {keys, useApiMutation} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {LoadError, SearchInput} from '../data-table';
import {FilterBar, FilterDateRange} from '../filter-bar';
import {SettingsSection} from '../settings-section';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {confirm, prompt} from '../ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '../ui/dialog';
import {NativeSelect} from '../ui/form';
import {EmptyState} from '../ui/misc';
import {CodeBlock, copy} from './shared';

/**
 * Settings → Webhooks → Incoming: the Data in webhook, the one way other tools push data in. An
 * automation tool POSTs JSON to an action's URL (access token in the path) with the
 * X-Signature-Token header (src/crm/lib/data-in-url.ts). Everything about the actions (parameters,
 * samples) comes from the catalogue in src/crm/lib/data-in.ts, which the server validates against too.
 */
export function DataInSettings() {
  const [logs, setLogs] = useState<{action: string} | null>(null);
  return (
    <>
      <DataInUrlCard onLogs={(action) => setLogs({action})} />
      {logs && <DataInLogDialog initialAction={logs.action} onClose={() => setLogs(null)} />}
    </>
  );
}

// ─── Data in URL ────────────────────────────────────────────────────────────

const urlKey = [...keys.dataIn, 'url'] as const;

function TokenRow({label, value, shown}: {label: string; value: string; shown: boolean}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-800" aria-label={label}>{value}</code>
        <Button size="sm" variant="secondary" className="h-7 shrink-0" disabled={!shown} title={shown ? undefined : 'Show tokens first'} onClick={() => copy(value, `${label} copied`)}><Copy /> Copy</Button>
      </div>
    </div>
  );
}

function DataInUrlCard({onLogs}: {onLogs: (action: string) => void}) {
  const q = useQuery({queryKey: urlKey, queryFn: () => api.get<DataInUrlOverview>('/data-in/url')});
  const [tokens, setTokens] = useState<DataInUrlTokens | null>(null);
  const reveal = useApiMutation(() => api.post<DataInUrlTokens>('/data-in/url/reveal'), {onSuccess: (r) => setTokens(r)});
  const regenerate = useApiMutation(() => api.post('/data-in/url/regenerate'), {invalidate: [urlKey], success: 'New URL and signature token ready: update them in every tool that sends data', onSuccess: () => setTokens(null)});
  const toggle = useApiMutation((enabled: boolean) => api.patch('/data-in/url', {enabled}), {invalidate: [urlKey], success: (r) => ((r as DataInUrlOverview).enabled ? 'Webhook turned on' : 'Webhook turned off'), onSuccess: () => setTokens(null)});
  const busy = regenerate.isPending || toggle.isPending;
  const d = q.data;

  const title = 'Data in webhook';
  const description = 'Send contacts, companies, deals, tickets, notes, activities and events into the CRM from any automation tool that can call a webhook. No code: paste a URL and add one header.';
  const logsButton = <Button size="sm" variant="secondary" onClick={() => onLogs('')}><ScrollText /> View logs</Button>;
  if (!d) {
    return (
      <SettingsSection title={title} description={description}>
        {q.isError ? <LoadError error={q.error} onRetry={() => q.refetch()} title="The Data in webhook could not be loaded" /> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </SettingsSection>
    );
  }

  const onEnable = async () =>
    (await confirm({title: 'Turn on the Data in webhook?', description: 'Anyone with an action URL and the signature token can then add data to the CRM. Records it creates belong to you, and it can change what you can change.', confirmLabel: 'Turn on webhook'})) && toggle.mutate(true);
  const onDisable = async () =>
    (await confirm({title: 'Turn off the Data in webhook?', description: 'Every Data in URL answers "not found" until you turn it on again. Tools sending to it will see errors.', confirmLabel: 'Disable webhook', destructive: true})) && toggle.mutate(false);
  const onRegenerate = async () =>
    (await confirm({title: 'Regenerate the URL?', description: 'New access and signature tokens are made. The current URLs and signature token stop working at once: paste the new ones into every tool that sends data.', confirmLabel: 'Regenerate URL', destructive: true})) && regenerate.mutate(undefined);

  if (!d.ready) {
    return (
      <SettingsSection title={title} description={description} actions={logsButton}>
        <EmptyState
          icon={<Webhook />}
          title="The webhook is off"
          description="Turn it on to get a URL for each action and a signature token. Requests will act as you."
          action={<Button size="sm" onClick={onEnable} pending={toggle.isPending} pendingLabel="Turning on…">Enable webhook</Button>}
        />
      </SettingsSection>
    );
  }

  const access = tokens?.accessToken ?? d.accessMasked ?? '';
  const signature = tokens?.signatureToken ?? d.signatureMasked ?? '';
  return (
    <SettingsSection
      title={title}
      description={description}
      actions={
        <>
          {logsButton}
          {d.enabled ? (
            <Button size="sm" variant="destructive" onClick={onDisable} disabled={busy} pending={toggle.isPending} pendingLabel="Turning off…"><PowerOff /> Disable webhook</Button>
          ) : (
            <Button size="sm" onClick={onEnable} disabled={busy} pending={toggle.isPending} pendingLabel="Turning on…"><Power /> Enable webhook</Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge tone={d.enabled ? 'green' : 'rose'}>{d.enabled ? 'On' : 'Off'}</Badge>
        <span className="text-muted-foreground">
          {d.enabled ? 'Requests act as ' : 'When on, requests act as '}
          <span className="font-semibold text-slate-700">{d.createdBy?.name ?? 'a removed teammate'}</span>
          {d.createdBy && !d.createdBy.active && <span className="font-semibold text-rose-600"> (deactivated: regenerate the URL)</span>}
          {d.rotatedAt && <span title={dateTime(d.rotatedAt)}> · URL made {ago(d.rotatedAt)}</span>}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <TokenRow label="Access token" value={access} shown={!!tokens} />
        <TokenRow label="Signature token" value={signature} shown={!!tokens} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {tokens ? (
          <Button size="sm" variant="secondary" onClick={() => setTokens(null)}><EyeOff /> Hide tokens</Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => reveal.mutate(undefined)} disabled={busy} pending={reveal.isPending} pendingLabel="Showing…"><Eye /> Show tokens</Button>
        )}
        <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={onRegenerate} disabled={busy || reveal.isPending} pending={regenerate.isPending} pendingLabel="Regenerating…"><RefreshCw /> Regenerate URL</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Showing the tokens is recorded in the audit log. Treat both like a password: anyone with them can add data to your CRM.</p>

      {!d.enabled && (
        <p className="mt-4 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          The webhook is off: every URL below answers "not found" until you enable it.
        </p>
      )}

      <h3 className="mt-6 mb-3 text-sm font-bold text-slate-900">How to connect your automation tool</h3>
      <ol className="grid gap-4">
        <Step n={1} title="Add a step that sends a webhook">
          <p>In your automation tool, add the step that sends data to a URL (often called a webhook, HTTP or API request).</p>
        </Step>
        <Step n={2} title="Paste the URL of the action you want">
          <p>Press <b>Show tokens</b>, open an action below and copy its URL into the step. Method <Mono>POST</Mono>, payload type <Mono>JSON</Mono>.</p>
        </Step>
        <Step n={3} title="Add one header">
          <p><Mono>{SIGNATURE_TOKEN_HEADER}</Mono> with the signature token as its value. Requests without it are refused.</p>
        </Step>
        <Step n={4} title="Map your fields">
          <p>Use the parameter names in the action's table as the keys of the body. Empty values are skipped (send <Mono>null</Mono> to clear a field); numbers and true / false may be sent as text, and lists as <Mono>a, b</Mono>.</p>
        </Step>
      </ol>
      <div className="mt-4 overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <th className="py-1.5 pr-3 font-semibold">Header</th>
              <th className="py-1.5 pr-3 font-semibold">Value</th>
              <th className="py-1.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {DATA_IN_URL_HEADERS.map((h) => (
              <tr key={h.name} className="align-top">
                <td className="py-2 pr-3 whitespace-nowrap"><code className="font-mono text-[12px] font-semibold text-slate-800">{h.name}</code>{h.required ? <span className="ml-0.5 font-bold text-rose-600" title="Required">*</span> : <span className="ml-1.5 text-[11px] text-muted-foreground">optional</span>}</td>
                <td className="py-2 pr-3 text-xs text-slate-600">{h.name === SIGNATURE_TOKEN_HEADER && tokens ? <code className="font-mono break-all">{tokens.signatureToken}</code> : h.value}</td>
                <td className="py-2 text-xs text-slate-600">{h.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground"><RateLimit value={d.rateLimit} /> · {DATA_IN_URL_LIMITS} · answers are JSON: <Mono>{'{"ok": true, "result"}'}</Mono> or <Mono>{'{"error": {"code", "message", "field"}}'}</Mono>.</p>

      <h3 className="mt-6 mb-3 text-sm font-bold text-slate-900">Actions</h3>
      <div className="grid gap-2">
        {DATA_IN_ACTIONS.map((a) => <UrlActionCard key={a.key} action={a} origin={d.origin} token={access} shown={!!tokens} onLogs={() => onLogs(a.key)} />)}
      </div>
    </SettingsSection>
  );
}

function UrlActionCard({action, origin, token, shown, onLogs}: {action: DataInAction; origin: string; token: string; shown: boolean; onLogs: () => void}) {
  const [open, setOpen] = useState(false);
  const url = dataInUrlFor(origin, action, token);
  const id = `data-in-url-${action.key.replace('.', '-')}`;
  return (
    <Card className="overflow-hidden">
      <button type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-slate-900">{action.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{action.description}</span>
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={id} className="grid gap-4 border-t border-slate-100 px-4 py-4">
          <div className="grid gap-1.5">
            <p className="text-xs font-semibold text-slate-600">URL: <span className="font-mono text-primary">{action.method}</span></p>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 rounded-lg bg-slate-50 px-3 py-1.5 font-mono text-xs break-all text-slate-700">{url}</code>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" className="h-8" disabled={!shown} title={shown ? undefined : 'Show tokens first'} onClick={() => copy(url, 'URL copied')}><Copy /> Copy</Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={onLogs}><ScrollText /> Logs</Button>
              </div>
            </div>
            {!shown && <p className="text-xs text-muted-foreground">Press Show tokens above to see and copy the full URL.</p>}
            {action.params?.length ? <p className="text-xs text-muted-foreground">Replace {action.params.map((p) => <Mono key={p.name}>{`{${p.name}}`}</Mono>)} in the URL: {action.params.map((p) => p.description).join(' ')}</p> : null}
          </div>
          <UrlParamsTable action={action} />
          <div className="grid gap-2">
            <p className="text-xs font-semibold text-slate-600">Sample body (JSON) · header <Mono>{SIGNATURE_TOKEN_HEADER}: your signature token</Mono></p>
            <CodeBlock code={JSON.stringify(action.sample, null, 2)} label="sample body" />
            <p className="text-xs text-muted-foreground"><Badge tone="green" className="mr-1.5">{action.success.status}</Badge>{action.success.note ?? 'The answer on success.'}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function UrlParamsTable({action}: {action: DataInAction}) {
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <th className="py-1.5 pr-3 font-semibold">Parameter</th>
              <th className="py-1.5 pr-3 font-semibold">Type</th>
              <th className="py-1.5 pr-3 font-semibold">Required</th>
              <th className="py-1.5 pr-3 font-semibold">Max</th>
              <th className="py-1.5 pr-3 font-semibold">Example</th>
              <th className="py-1.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dataInUrlParams(action).map((p) => (
              <tr key={`${p.inPath}:${p.name}`} className="align-top">
                <td className="py-2 pr-3"><code className="font-mono text-[12px] font-semibold text-slate-800">{p.name}</code>{p.inPath && <span className="ml-1.5 text-[11px] text-muted-foreground">(in the URL)</span>}</td>
                <td className="py-2 pr-3 text-xs whitespace-nowrap text-slate-500">{p.type}</td>
                <td className="py-2 pr-3 text-xs whitespace-nowrap">{p.required ? <span className="font-semibold text-rose-600">Required</span> : <span className="text-slate-500">Optional</span>}</td>
                <td className="py-2 pr-3 text-xs whitespace-nowrap text-slate-500">{p.max ?? '–'}</td>
                <td className="max-w-48 py-2 pr-3 text-xs break-all text-slate-600">{p.example ? <code className="font-mono text-[11px]">{p.example}</code> : '–'}</td>
                <td className="py-2 text-xs text-slate-600">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {action.oneOf && <p className="text-xs text-muted-foreground">Send at least one of {action.oneOf.map((k, i) => <span key={k}>{i ? ', ' : ''}<Mono>{k}</Mono></span>)}.</p>}
    </div>
  );
}

// ─── How to connect ─────────────────────────────────────────────────────────

function Step({n, title, children}: {n: number; title: string; children: ReactNode}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white shadow-soft" aria-hidden>{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="font-semibold text-slate-900">{title}</p>
        <div className="mt-1 grid gap-1.5 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

const Mono = ({children}: {children: ReactNode}) => <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] break-all text-slate-700">{children}</code>;

/** "N requests per minute · change": the Data in URL's rate limit (1 to 1000), saved in place. */
function RateLimit({value}: {value: number}) {
  const setLimit = useApiMutation((rateLimit: number) => api.patch('/data-in/settings', {rateLimit}), {invalidate: [keys.dataIn], success: 'Rate limit saved'});
  const change = () =>
    prompt({
      title: 'Requests per minute',
      description: 'How many requests the Data in URL takes each minute; more are refused with E_RATE_LIMITED.',
      label: 'Between 1 and 1000',
      defaultValue: String(value),
      confirmLabel: 'Save',
      inputMode: 'numeric',
      maxLength: 4,
      required: 'Enter a whole number between 1 and 1000.',
      rules: [(v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000 ? null : 'Use a whole number between 1 and 1000.')],
      // Stays open while saving; a refusal shows under the field (not as a toast too).
      action: (v) =>
        setLimit.mutateAsync(Number(v)).catch((e: unknown) => {
          if (e && typeof e === 'object') shownInPlace.set(e, 'shown');
          throw e;
        }),
    });
  return (
    <>
      {value} requests per minute (
      <button type="button" className="cursor-pointer font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50" onClick={change} disabled={setLimit.isPending} aria-busy={setLimit.isPending || undefined}>
        {setLimit.isPending ? 'saving…' : 'change'}
      </button>
      )
    </>
  );
}

// ─── Logs ───────────────────────────────────────────────────────────────────

function RecordLink({r}: {r: DataInRecord}) {
  const cls = 'inline-flex min-w-0 items-center gap-1 font-semibold text-primary hover:underline';
  const text = <><span className="truncate">{r.label || r.entity}</span><ExternalLink className="size-3 shrink-0" /></>;
  if (r.entity === 'contact') return <Link to="/contacts/$contactId" params={{contactId: r.id}} className={cls}>{text}</Link>;
  if (r.entity === 'company') return <Link to="/companies/$companyId" params={{companyId: r.id}} className={cls}>{text}</Link>;
  if (r.entity === 'deal') return <Link to="/deals/$dealId" params={{dealId: r.id}} className={cls}>{text}</Link>;
  if (r.entity === 'ticket') return <Link to="/tickets/$ticketId" params={{ticketId: r.id}} className={cls}>{text}</Link>;
  if (r.entity === 'list') return <Link to="/lists/$listId" params={{listId: r.id}} className={cls}>{text}</Link>;
  return <span className="truncate text-slate-600">{r.label}</span>;
}

const ENTITY_NOUN: Record<DataInRecord['entity'], string> = {contact: 'Contact', company: 'Company', deal: 'Deal', ticket: 'Ticket', list: 'List', note: 'Note', interaction: 'Activity', event: 'Event'};

type LogFilters = {action: string; status: '' | 'ok' | 'failed'; q: string; from?: string; to?: string};

function DataInLogDialog({initialAction, onClose}: {initialAction: string; onClose: () => void}) {
  const [f, setF] = useState<LogFilters>({action: initialAction, status: '', q: ''});
  const [open, setOpen] = useState<string | null>(null);
  const query = {action: f.action || undefined, status: f.status || undefined, q: f.q.trim() || undefined, from: f.from, to: f.to};
  const list = useInfiniteQuery({
    queryKey: [...keys.dataIn, 'logs', query],
    queryFn: ({pageParam}) => api.get<{rows: DataInLogRow[]; nextCursor: string | null}>('/data-in/logs', {...query, cursor: pageParam || undefined}),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  const active = !!(f.action || f.status || f.q || f.from || f.to);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Data in logs</DialogTitle>
          <DialogDescription>Every request, accepted or refused, kept 30 days. Headers are never stored and secret-looking body values are hidden.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FilterBar active={active} onClear={() => setF({action: '', status: '', q: ''})} className="mb-3">
            <SearchInput size="sm" value={f.q} onChange={(q) => setF({...f, q})} placeholder="Search errors and bodies" />
            <NativeSelect size="sm" value={f.action} onChange={(e) => setF({...f, action: e.target.value})} aria-label="Action">
              <option value="">All actions</option>
              {DATA_IN_ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.title}</option>)}
            </NativeSelect>
            <NativeSelect size="sm" value={f.status} onChange={(e) => setF({...f, status: e.target.value as LogFilters['status']})} aria-label="Status">
              <option value="">Any status</option>
              <option value="ok">Succeeded</option>
              <option value="failed">Failed</option>
            </NativeSelect>
            <FilterDateRange from={f.from} to={f.to} onChange={(r) => setF({...f, ...r})} />
          </FilterBar>
          {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {list.isError && !list.data && <LoadError error={list.error} onRetry={() => list.refetch()} title="The logs could not be loaded" />}
          {!list.isLoading && !list.isError && rows.length === 0 && <EmptyState icon={<Clock />} title={active ? 'No requests match' : 'No requests yet'} description={active ? 'Try other filters.' : 'Requests show up here as soon as a tool sends one.'} />}
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const ok = r.status < 400;
              const isOpen = open === r.id;
              const main = r.records[0];
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left text-xs">
                    {ok ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <TriangleAlert className="size-4 shrink-0 text-rose-500" />}
                    <Badge tone={ok ? 'green' : 'rose'} className="shrink-0 font-mono">{r.status}</Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-700">{dataInAction(r.action)?.title ?? r.action}{r.replayed && <span className="ml-1.5 font-normal text-muted-foreground">(replayed)</span>}</span>
                      <span className={cn('block truncate', ok ? 'text-muted-foreground' : 'text-rose-600')}>
                        {ok ? (main ? `${ENTITY_NOUN[main.entity]}: ${main.label}` : 'Done') : `${r.errorCode}: ${r.error ?? ''}`}
                      </span>
                    </span>
                    <span className="w-16 shrink-0 text-right text-muted-foreground" title={dateTime(r.createdAt)}>{ago(r.createdAt)}</span>
                    <ChevronDown className={cn('size-4 shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && <LogDetail r={r} />}
                </li>
              );
            })}
          </ul>
          {list.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="secondary" onClick={() => list.fetchNextPage()} pending={list.isFetchingNextPage} pendingLabel="Loading…">Load more</Button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function LogDetail({r}: {r: DataInLogRow}) {
  return (
    <div className="mb-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
        <span>{dateTime(r.createdAt)}</span>
        <span className="font-mono">{r.method} {r.path}</span>
        <span>{r.durationMs} ms</span>
        {r.idempotencyKey && <span>Idempotency-Key: <code className="font-mono">{r.idempotencyKey}</code></span>}
      </div>
      {r.error && <p className="font-semibold text-rose-600">{r.errorCode}: {r.error}</p>}
      {r.records.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {r.records.map((x) => (
            <span key={`${x.entity}:${x.id}`} className="flex min-w-0 items-center gap-1 text-slate-600">
              <span className="shrink-0">{ENTITY_NOUN[x.entity]}:</span>
              <RecordLink r={x} />
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 font-semibold text-slate-600">Request body</p>
          <pre className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700 scrollbar-thin">{r.body ?? '(not stored)'}</pre>
        </div>
        <div className="min-w-0">
          <p className="mb-1 font-semibold text-slate-600">Response</p>
          <pre className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700 scrollbar-thin">{r.response === null ? '(none)' : JSON.stringify(r.response, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
