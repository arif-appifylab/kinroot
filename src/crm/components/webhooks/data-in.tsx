import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {CheckCircle2, ChevronDown, Clock, Copy, ExternalLink, Eye, EyeOff, KeyRound, Plus, RefreshCw, ScrollText, Trash2, TriangleAlert} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {
  actionPath,
  curlFor,
  DATA_IN_ACTIONS,
  DATA_IN_MAX_BYTES,
  dataInAction,
  errorsFor,
  FIELD_TYPE_LABEL,
  IDEMPOTENCY_HOURS,
  signingSamples,
  SIGNATURE_TOLERANCE_SEC,
  type ApiKeyRow,
  type DataInAction,
  type DataInField,
  type DataInLogRow,
  type DataInOverview,
  type DataInRecord,
} from '@/lib/data-in';
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
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, NativeSelect} from '../ui/form';
import {is, useFormState} from '../ui/form-state';
import {EmptyState, Tabs, TabsContent, TabsList, TabsTrigger} from '../ui/misc';
import {CodeBlock, copy} from './shared';

/**
 * Settings → Webhooks → Incoming, the primary flow: other platforms push data
 * in through the Data in API (API key + signed requests). Everything about the
 * actions (fields, samples, errors, cURL) comes from the catalogue in
 * src/lib/data-in.ts, which the server validates against too.
 */
export function DataInSettings() {
  const overview = useQuery({queryKey: keys.dataIn, queryFn: () => api.get<DataInOverview>('/data-in')});
  const [logs, setLogs] = useState<{action: string} | null>(null);
  const data = overview.data;

  if (overview.isLoading || !data) {
    return (
      <SettingsSection title="Data in API">
        {overview.isError ? (
          <LoadError error={overview.error} onRetry={() => overview.refetch()} title="The Data in settings could not be loaded" />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </SettingsSection>
    );
  }
  return (
    <>
      <ConnectCard overview={data} onLogs={() => setLogs({action: ''})} />
      <SigningSecretCard overview={data} />
      <ApiKeysCard rows={data.keys} />
      <ActionsCard baseUrl={data.baseUrl} onLogs={(action) => setLogs({action})} />
      {logs && <DataInLogDialog initialAction={logs.action} onClose={() => setLogs(null)} />}
    </>
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

function ConnectCard({overview, onLogs}: {overview: DataInOverview; onLogs: () => void}) {
  const setLimit = useApiMutation((rateLimit: number) => api.patch('/data-in/settings', {rateLimit}), {invalidate: [keys.dataIn], success: 'Rate limit saved'});
  const changeLimit = async () => {
    const value = await prompt({title: 'Requests per minute per key', label: 'Between 1 and 1000', defaultValue: String(overview.rateLimit), confirmLabel: 'Save'});
    if (value === null) return;
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) setLimit.mutate(n);
    else toast.error('Use a whole number between 1 and 1000');
  };
  return (
    <SettingsSection
      title="Data in API"
      description="Other platforms (your website, your own app, a billing or support tool) push contacts, companies, deals, tickets, notes, activities and events into the CRM through a small signed API."
      actions={<Button size="sm" variant="secondary" onClick={onLogs}><ScrollText /> View logs</Button>}
    >
      <h3 className="mb-3 text-sm font-bold text-slate-900">How to connect</h3>
      <ol className="grid gap-4">
        <Step n={1} title="Create an API key">
          <p>
            One key per platform, in <a href="#data-in-keys" className="font-semibold text-primary hover:underline">API keys</a> below. A key acts as the admin who created it: new records are theirs.
          </p>
        </Step>
        <Step n={2} title="Send the key as a Bearer token with a JSON body">
          <p><Mono>Authorization: Bearer YOUR_KEY</Mono> and <Mono>Content-Type: application/json</Mono>, as a POST to the base URL plus the action's path.</p>
        </Step>
        <Step n={3} title="Sign every request">
          <p>
            Add <Mono>X-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of "&lt;t&gt;.&lt;raw body&gt;"&gt;</Mono> made with the signing secret below. Unsigned or badly signed requests are refused.
          </p>
        </Step>
      </ol>

      <div className="mt-5 grid gap-1.5">
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Base URL</p>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-800">{overview.baseUrl}</code>
          <Button size="sm" variant="secondary" className="h-7 shrink-0" onClick={() => copy(overview.baseUrl, 'Base URL copied')}><Copy /> Copy</Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Last 24 h: {overview.stats.day} request{overview.stats.day === 1 ? '' : 's'}
          {overview.stats.failed ? <span className="font-semibold text-rose-600"> · {overview.stats.failed} refused</span> : null}
        </span>
        <span>
          {overview.rateLimit} requests per minute per key ·{' '}
          <button type="button" className="cursor-pointer font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50" onClick={changeLimit} disabled={setLimit.isPending} aria-busy={setLimit.isPending || undefined}>
            {setLimit.isPending ? 'saving…' : 'change'}
          </button>
        </span>
        <span>{DATA_IN_MAX_BYTES / 1024} KB per request · optional <Mono>Idempotency-Key</Mono> header ({IDEMPOTENCY_HOURS} h)</span>
      </div>
    </SettingsSection>
  );
}

// ─── Signing secret ─────────────────────────────────────────────────────────

function SigningSecretCard({overview}: {overview: DataInOverview}) {
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = useApiMutation(() => api.post<{secret: string}>('/data-in/secret/reveal'), {onSuccess: (r) => setSecret(r.secret)});
  const regenerate = useApiMutation(() => api.post('/data-in/secret/regenerate'), {invalidate: [keys.dataIn], success: 'New signing secret ready: update it in every platform that sends data', onSuccess: () => setSecret(null)});
  const onRegenerate = async () =>
    (await confirm({title: 'Regenerate the signing secret?', description: 'Requests signed with the current secret are refused at once. Put the new secret in every platform that sends data.', confirmLabel: 'Regenerate secret', destructive: true})) && regenerate.mutate(undefined);
  const samples = signingSamples(overview.baseUrl);

  return (
    <SettingsSection title="Signing secret" description="Proves a request comes from your platform and was not changed on the way.">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[13px] text-slate-800" aria-label="Signing secret">
          {secret ?? overview.secret.masked}
        </code>
        <div className="flex shrink-0 gap-2">
          {secret ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => copy(secret, 'Signing secret copied')}><Copy /> Copy</Button>
              <Button size="sm" variant="ghost" onClick={() => setSecret(null)}><EyeOff /> Hide</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => reveal.mutate(undefined)} pending={reveal.isPending} pendingLabel="Showing…"><Eye /> Show</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRegenerate} pending={regenerate.isPending} pendingLabel="Regenerating…"><RefreshCw /> Regenerate</Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {overview.secret.rotatedAt ? `Created ${dateTime(overview.secret.rotatedAt)}. ` : ''}Showing it is recorded in the audit log. Keep it on your server, never in a browser or app.
      </p>

      <div className="mt-4 grid gap-2 text-sm text-muted-foreground">
        <p>
          <span className="font-semibold text-slate-700">How signing works.</span> Take the current time in unix seconds (<Mono>t</Mono>), compute the HMAC-SHA256 of <Mono>t</Mono>, a dot and the raw body with the secret, and send its hex as <Mono>v1</Mono>. The body is signed byte for byte as sent, so sign the exact string you send (re-serialising JSON can change it).
        </p>
        <p>
          Each signature works once, and only within {SIGNATURE_TOLERANCE_SEC / 60} minutes of <Mono>t</Mono>: sign every request, retries too, just before sending. Two identical bodies signed in the same second have the same signature, so the second is refused as reused.
        </p>
      </div>

      <Tabs defaultValue="node" className="mt-4">
        <TabsList size="sm" aria-label="Code sample">
          {samples.map((s) => <TabsTrigger key={s.key} value={s.key}>{s.label}</TabsTrigger>)}
        </TabsList>
        {samples.map((s) => (
          <TabsContent key={s.key} value={s.key} className="mt-2">
            <CodeBlock code={s.code} label={`${s.label} sample`} />
          </TabsContent>
        ))}
      </Tabs>
      <p className="mt-2 text-xs text-muted-foreground">Every action below also has a ready cURL command.</p>
    </SettingsSection>
  );
}

// ─── API keys ───────────────────────────────────────────────────────────────

function keyState(k: ApiKeyRow): {label: string; tone: 'green' | 'rose' | 'amber'} {
  if (k.revokedAt) return {label: 'Revoked', tone: 'rose'};
  if (!k.createdBy?.active) return {label: 'Owner inactive', tone: 'amber'};
  return {label: 'Active', tone: 'green'};
}

function ApiKeysCard({rows}: {rows: ApiKeyRow[]}) {
  const [creating, setCreating] = useState(false);
  const revoke = useApiMutation((id: string) => api.del(`/data-in/keys/${id}`), {invalidate: [keys.dataIn], success: 'API key revoked'});
  const onRevoke = async (k: ApiKeyRow) =>
    (await confirm({title: `Revoke ${k.name}?`, description: 'Requests with this key are refused at once. This cannot be undone: create a new key to reconnect.', confirmLabel: 'Revoke key', destructive: true})) && revoke.mutate(k.id);

  return (
    <div id="data-in-keys" className="scroll-mt-4">
      <SettingsSection
        title="API keys"
        description="Each key is shown once when it's created; only a hash is kept. Revoke a key the moment it may have leaked."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus /> Create API key</Button>}
      >
        {rows.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No API keys yet" description="Create one for each platform that sends data in." action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> Create API key</Button>} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((k) => {
              const s = keyState(k);
              return (
                <li key={k.id} className={cn('flex flex-col gap-2 py-3 sm:flex-row sm:items-center', k.revokedAt && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-semibold text-slate-900">{k.name}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <code className="font-mono text-slate-600">{k.prefix}…</code>
                      <span>by {k.createdBy?.name ?? 'a removed user'}</span>
                      <span title={dateTime(k.createdAt)}>created {ago(k.createdAt)}</span>
                      <span title={k.lastUsedAt ? dateTime(k.lastUsedAt) : undefined}>{k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : 'never used'}</span>
                      {k.revokedAt && <span title={dateTime(k.revokedAt)}>revoked {ago(k.revokedAt)}</span>}
                    </p>
                  </div>
                  {!k.revokedAt && (
                    <Button size="sm" variant="ghost" className="self-start text-rose-600 hover:bg-rose-50 hover:text-rose-700 sm:self-auto" onClick={() => onRevoke(k)} disabled={revoke.isPending} pending={revoke.isPending && revoke.variables === k.id} pendingLabel="Revoking…"><Trash2 /> Revoke</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateKeyDialog({onClose}: {onClose: () => void}) {
  const [name, setName] = useState('');
  const [plain, setPlain] = useState<string | null>(null);
  const create = useApiMutation((n: string) => api.post<{key: ApiKeyRow; plain: string}>('/data-in/keys', {name: n}), {invalidate: [keys.dataIn], onSuccess: (r) => setPlain(r.plain)});
  const f = useFormState({name}, {name: [is.required('Name the key after the platform that uses it.'), is.maxLength(80)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent size="sm">
        <form className="flex min-h-0 flex-1 flex-col" {...f.form(() => (plain ? onClose() : create.mutate(name.trim(), {onError: f.fail})))}>
          <DialogHeader>
            <DialogTitle>{plain ? 'Copy your API key' : 'Create API key'}</DialogTitle>
            <DialogDescription>{plain ? 'This is the only time the full key is shown.' : 'Name it after the platform that will use it.'}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            {plain ? (
              <>
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-1.5 pl-3">
                  <code className="min-w-0 flex-1 font-mono text-[13px] break-all text-slate-800">{plain}</code>
                  <Button type="button" size="sm" variant="secondary" className="h-7 shrink-0" onClick={() => copy(plain, 'API key copied')}><Copy /> Copy</Button>
                </div>
                <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  Store it in the platform's secret settings now. Lost it? Revoke it and create a new one.
                </p>
              </>
            ) : (
              <Field label="Name" htmlFor="api-key-name" error={f.error('name')}>
                <Input id="api-key-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} maxLength={80} placeholder="e.g. Website, Billing app" autoFocus />
              </Field>
            )}
          </DialogBody>
          <DialogFooter>
            {plain ? (
              <Button type="submit">Done</Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
                <Button type="submit" pending={create.isPending} pendingLabel="Creating…">Create key</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Actions ────────────────────────────────────────────────────────────────

function ActionsCard({baseUrl, onLogs}: {baseUrl: string; onLogs: (action: string) => void}) {
  return (
    <SettingsSection title="Actions" description="Each action is a POST to the base URL plus its path. Requests are checked against exactly these fields; unknown fields are refused.">
      <div className="grid gap-2">
        {DATA_IN_ACTIONS.map((a) => <ActionCard key={a.key} action={a} baseUrl={baseUrl} onLogs={() => onLogs(a.key)} />)}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Every answer is JSON: <Mono>{'{"ok": true, "action", "result"}'}</Mono> on success (200 or 201), <Mono>{'{"error": {"code", "message", "field"}}'}</Mono> otherwise.
      </p>
    </SettingsSection>
  );
}

function ActionCard({action, baseUrl, onLogs}: {action: DataInAction; baseUrl: string; onLogs: () => void}) {
  const [open, setOpen] = useState(false);
  const url = baseUrl + actionPath(action);
  const id = `data-in-${action.key.replace('.', '-')}`;
  return (
    <Card className="overflow-hidden">
      <button type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Badge tone="blue" className="shrink-0 font-mono">{action.method}</Badge>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-slate-900">{action.title}</span>
          <code className="block truncate font-mono text-xs text-muted-foreground">{action.path}</code>
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={id} className="grid gap-4 border-t border-slate-100 px-4 py-4">
          <p className="text-sm text-muted-foreground">{action.description}</p>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-700">
              <span className="font-bold text-primary">{action.method}</span> {url}
            </code>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" className="h-8" onClick={() => copy(url, 'URL copied')}><Copy /> Copy URL</Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={onLogs}><ScrollText /> Logs</Button>
            </div>
          </div>
          <Tabs defaultValue="fields">
            <TabsList size="sm" aria-label={`${action.title}: documentation`} className="flex-wrap">
              <TabsTrigger value="fields">Fields</TabsTrigger>
              <TabsTrigger value="sample">Sample request</TabsTrigger>
              <TabsTrigger value="success">Success response</TabsTrigger>
              <TabsTrigger value="errors">Error responses</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>
            <TabsContent value="fields" className="mt-3">
              <FieldsTable action={action} />
            </TabsContent>
            <TabsContent value="sample" className="mt-3">
              {action.sampleParams && <p className="mb-2 text-xs text-muted-foreground">Path: <Mono>{actionPath(action)}</Mono></p>}
              <CodeBlock code={JSON.stringify(action.sample, null, 2)} label="sample request" />
            </TabsContent>
            <TabsContent value="success" className="mt-3 grid gap-2">
              <p className="text-xs text-muted-foreground"><Badge tone="green" className="mr-1.5">{action.success.status}</Badge>{action.success.note}</p>
              <CodeBlock code={JSON.stringify(action.success.body, null, 2)} label="success response" />
            </TabsContent>
            <TabsContent value="errors" className="mt-3">
              <ErrorsTable action={action} />
            </TabsContent>
            <TabsContent value="curl" className="mt-3 grid gap-2">
              <CodeBlock code={curlFor(action, baseUrl)} label="cURL command" />
              <p className="text-xs text-muted-foreground">Needs <Mono>openssl</Mono> and <Mono>uuidgen</Mono> (macOS and most Linux systems have both).</p>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </Card>
  );
}

function FieldRow({f, path}: {f: DataInField; path?: boolean}) {
  return (
    <tr className="align-top">
      <td className="py-2 pr-3">
        <code className="font-mono text-[12px] font-semibold text-slate-800">{f.name}</code>
        {f.required && <span className="ml-0.5 font-bold text-rose-600" title="Required">*</span>}
        {path && <span className="ml-1.5 text-[11px] text-muted-foreground">(in the path)</span>}
      </td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap text-slate-500">
        {FIELD_TYPE_LABEL[f.type]}
        {f.nullable && <span className="block text-[11px]">or null</span>}
      </td>
      <td className="py-2 text-xs text-slate-600">
        {f.description}
        {f.values && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-muted-foreground">Possible values:</span>
            {f.values.map((v) => <code key={v} className="rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-700">{v}</code>)}
          </span>
        )}
      </td>
    </tr>
  );
}

function FieldsTable({action}: {action: DataInAction}) {
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <th className="py-1.5 pr-3 font-semibold">Field</th>
              <th className="py-1.5 pr-3 font-semibold">Type</th>
              <th className="py-1.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {action.params?.map((f) => <FieldRow key={`p:${f.name}`} f={f} path />)}
            {action.fields.map((f) => <FieldRow key={f.name} f={f} />)}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-bold text-rose-600">*</span> required.
        {action.oneOf && <> Send at least one of {action.oneOf.map((k, i) => <span key={k}>{i ? ', ' : ''}<Mono>{k}</Mono></span>)}.</>}
      </p>
    </div>
  );
}

function ErrorsTable({action}: {action: DataInAction}) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            <th className="py-1.5 pr-3 font-semibold">Status</th>
            <th className="py-1.5 pr-3 font-semibold">Code</th>
            <th className="py-1.5 font-semibold">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {errorsFor(action).map((e) => (
            <tr key={`${e.code}:${e.common}`} className={cn('align-top', e.common && 'text-slate-500')}>
              <td className="py-2 pr-3 font-mono text-xs">{e.status}</td>
              <td className="py-2 pr-3"><code className="font-mono text-[12px] font-semibold whitespace-nowrap text-slate-800">{e.code}</code></td>
              <td className="py-2 text-xs">{e.when}{e.common && <span className="ml-1 text-[11px] text-slate-400">(every action)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
            <SearchInput size="sm" value={f.q} onChange={(q) => setF({...f, q})} placeholder="Search errors, bodies, keys" />
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
          {!list.isLoading && !list.isError && rows.length === 0 && <EmptyState icon={<Clock />} title={active ? 'No requests match' : 'No requests yet'} description={active ? 'Try other filters.' : 'Requests show up here as soon as a platform sends one.'} />}
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
                    <span className="hidden w-28 shrink-0 truncate text-muted-foreground sm:block">{r.key.name ?? 'no key'}</span>
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
        <span>Key: {r.key.name ? `${r.key.name} (${r.key.prefix}…)` : 'none or unknown'}</span>
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
