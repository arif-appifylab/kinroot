import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Ear,
  ExternalLink,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {useEffect, useId, useMemo, useRef, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {ago, dateTime} from '@/lib/format';
import {
  ENTITY_LABEL,
  exampleBody,
  IN_ACTIONS,
  IN_ACTION_KEYS,
  IN_MODES,
  IN_STATUSES,
  IN_VERIFY,
  INCOMING_SECRET_NAME,
  inTargets,
  LISTEN_MINUTES,
  MAX_BODY_BYTES,
  samplePaths,
  suggestIdempotencyPath,
  suggestMapping,
  suggestSecretName,
  type IncomingRequestRow,
  type IncomingWebhookRow,
  type InAction,
  type InConfig,
  type InEntity,
  type InMode,
  type InTarget,
  type InVerify,
} from '@/lib/incoming-webhooks';
import {keys, useApiMutation, useFields, usePipelines, useTeam} from '@/lib/queries';
import {TICKET_PRIORITIES, type TicketPriority} from '@/lib/tickets';
import {cn} from '@/lib/utils';

import {useLists} from '../lists/list-picker';
import {TagInput, type TagEntity} from '../pickers';
import {useTicketSettings} from '../tickets/ticket-badges';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {confirm} from '../ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Checkbox, Field, Input, NativeSelect, Switch} from '../ui/form';
import {is, useFormState, type FormState} from '../ui/form-state';
import {LoadError} from '../data-table';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '../ui/menu';
import {EmptyState, IconBadge, Tabs, TabsList, TabsTrigger} from '../ui/misc';
import {CodeBlock, copy, Disclosure} from './shared';

/**
 * Settings → Webhooks → Incoming, below the Data in API (data-in.tsx): custom
 * webhooks for tools that can't call that API. Each one has a secret URL and
 * a field mapping, and what it receives becomes contacts, companies, deals or
 * tickets (or only starts automations). Server: src/server/lib/incoming-webhooks.ts.
 */
export function IncomingWebhooks() {
  const list = useQuery({queryKey: keys.incomingWebhooks, queryFn: () => api.get<{rows: IncomingWebhookRow[]}>('/incoming-webhooks')});
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [logFor, setLogFor] = useState<IncomingWebhookRow | null>(null);
  // Just created: shown before the list has refetched.
  const [fresh, setFresh] = useState<IncomingWebhookRow | null>(null);
  const rows = list.data?.rows ?? [];
  const editingHook = editing && editing !== 'new' ? (rows.find((r) => r.id === editing) ?? (fresh?.id === editing ? fresh : null)) : null;

  return (
    <>
      {/* Secondary to the Data in API above: collapsed until opened. */}
      <Card className="mb-6 overflow-hidden">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-slate-900">Custom webhooks{rows.length ? ` (${rows.length})` : ''}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">For tools that can't send the format above (Zapier, Make, form tools, Stripe-style webhooks): a secret URL per tool, with its fields mapped onto CRM records.</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-slate-100 p-5">
            {rows.length > 0 && (
              <div className="mb-4 flex justify-end">
                <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add custom webhook</Button>
              </div>
            )}
            {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {list.isError && <LoadError error={list.error} onRetry={() => list.refetch()} title="The custom webhooks could not be loaded" />}
            {!list.isLoading && !list.isError && rows.length === 0 && (
              <EmptyState
                icon={<ArrowDownToLine />}
                title="No custom webhooks yet"
                description="Create one, copy its URL into the other tool, send a test request and map its fields onto contacts, companies, deals or tickets."
                action={<Button size="sm" onClick={() => setEditing('new')}><Plus /> Add custom webhook</Button>}
              />
            )}
            <div className="grid gap-3">
              {rows.map((h) => <HookRow key={h.id} hook={h} onEdit={() => setEditing(h.id)} onLog={() => setLogFor(h)} />)}
            </div>
            <Disclosure summary="How incoming webhooks work" icon={<ShieldCheck />} className="mt-4">
              <p>
                Send a <code className="text-slate-700">POST</code> with a JSON, form-encoded or query-string body (up to {MAX_BODY_BYTES / 1024} KB) to the webhook's URL. It answers <code className="text-slate-700">200 {'{"ok": true, "id": …}'}</code> right away and the data is processed in the background, retried if something fails.
              </p>
              <p>
                Keep the URL private and regenerate it if it leaks. Every request must also pass the webhook's check: a shared secret header or an HMAC-SHA256 signature of the body, with the secret kept in a site secret in your dashboard. Map an id from the payload as the idempotency path (or send an <code className="text-slate-700">Idempotency-Key</code> header) so repeats are ignored.
              </p>
              <p className="text-xs">Requests are kept in the log for 30 days. Automations can start on “Incoming webhook received”.</p>
            </Disclosure>
          </div>
        </details>
      </Card>

      {editing === 'new' && <NewHookDialog onClose={() => setEditing(null)} onCreated={(h) => (setFresh(h), setEditing(h.id))} />}
      {editingHook && <HookDialog key={editingHook.id} hook={editingHook} onClose={() => setEditing(null)} onLog={() => setLogFor(editingHook)} />}
      {logFor && <RequestLogDialog hook={logFor} onClose={() => setLogFor(null)} />}
    </>
  );
}

// ─── List ───────────────────────────────────────────────────────────────────

function useRegenerate(hook: IncomingWebhookRow) {
  const regenerate = useApiMutation(() => api.post(`/incoming-webhooks/${hook.id}/regenerate`), {invalidate: [keys.incomingWebhooks], success: 'New URL ready: update it in the sending tool'});
  const run = async () =>
    (await confirm({title: 'Regenerate the URL?', description: 'The current URL stops working at once. Paste the new one into every tool that sends to it.', confirmLabel: 'Regenerate URL', destructive: true})) && regenerate.mutate(undefined);
  return {run, pending: regenerate.isPending};
}

function HookRow({hook: h, onEdit, onLog}: {hook: IncomingWebhookRow; onEdit: () => void; onLog: () => void}) {
  const toggle = useApiMutation((active: boolean) => api.patch(`/incoming-webhooks/${h.id}`, {active}), {invalidate: [keys.incomingWebhooks]});
  const remove = useApiMutation(() => api.del(`/incoming-webhooks/${h.id}`), {invalidate: [keys.incomingWebhooks], success: 'Incoming webhook deleted'});
  const regenerate = useRegenerate(h);
  const last = h.lastStatus ? IN_STATUSES[h.lastStatus] : null;

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IconBadge tone={h.active ? 'teal' : 'slate'} className="mt-0.5 shrink-0"><ArrowDownToLine /></IconBadge>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onEdit} className="block max-w-full cursor-pointer truncate text-left text-sm font-semibold text-slate-900 hover:text-primary">{h.name}</button>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <code className="min-w-0 truncate font-mono text-[11px] text-slate-500" title={h.url}>{h.url}</code>
            <Button variant="ghost" size="icon-sm" className="size-6 shrink-0" onClick={() => copy(h.url, 'URL copied')} aria-label="Copy URL"><Copy className="size-3.5" /></Button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge tone={h.active ? 'green' : 'neutral'}>{h.active ? 'On' : 'Off'}</Badge>
            <span>{IN_ACTIONS[h.action]?.short ?? h.action}</span>
            {h.verify === 'none' || !h.secretAdded ? (
              <span className="inline-flex items-center gap-1 text-amber-700"><ShieldCheck className="size-3" /> Sender check not ready: requests are refused</span>
            ) : (
              <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3" /> {h.verify === 'hmac' ? 'Signed' : 'Secret header'}</span>
            )}
            {h.lastRequestAt ? <span>· last request {ago(h.lastRequestAt)}{last ? ` (${last.label.toLowerCase()})` : ''}</span> : <span>· no requests yet</span>}
            {h.stats.day > 0 && <span>· {h.stats.day} today{h.stats.failed ? `, ${h.stats.failed} failed or rejected` : ''}</span>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Switch checked={h.active} onCheckedChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} aria-busy={toggle.isPending || undefined} aria-label={h.active ? 'Turn off' : 'Turn on'} />
        <Button variant="secondary" size="sm" onClick={onEdit}><Pencil /> Set up</Button>
        <Button variant="secondary" size="sm" onClick={onLog}><Clock /> Log</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" pending={remove.isPending || regenerate.pending}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => copy(h.url, 'URL copied')}><Copy /> Copy URL</DropdownMenuItem>
            <DropdownMenuItem onSelect={regenerate.run}><KeyRound /> Regenerate URL</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete “${h.name}”?`, description: 'Its URL stops working and its request log is deleted.', confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

// ─── New ────────────────────────────────────────────────────────────────────

function ActionPicker({value, onChange}: {value: InAction; onChange: (a: InAction) => void}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="What it does" className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
      {IN_ACTION_KEYS.map((a) => (
        <label key={a} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors', value === a ? 'border-primary bg-primary/5' : 'border-slate-200 hover:border-slate-300')}>
          <input type="radio" name={name} className="mt-1 accent-[var(--primary)]" checked={value === a} onChange={() => onChange(a)} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800">{IN_ACTIONS[a].label}</span>
            <span className="block text-xs text-muted-foreground">{IN_ACTIONS[a].hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function NewHookDialog({onClose, onCreated}: {onClose: () => void; onCreated: (h: IncomingWebhookRow) => void}) {
  const ids = useId();
  const [name, setName] = useState('');
  const [action, setAction] = useState<InAction>('contact');
  const create = useApiMutation(() => api.post<{webhook: IncomingWebhookRow}>('/incoming-webhooks', {name: name.trim(), action}), {
    invalidate: [keys.incomingWebhooks],
    success: 'Created: copy the URL, then map the fields',
    onSuccess: (r) => onCreated(r.webhook),
  });
  const f = useFormState({name}, {name: [is.required('Give the webhook a name.'), is.maxLength(100)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent size="md">
        <form {...f.form(() => create.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Add custom webhook</DialogTitle>
            <DialogDescription>You get a secret URL to paste into the other tool. Map its fields in the next step.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-5">
              <Field label="Name" htmlFor={`${ids}-name`} hint="e.g. “Stripe checkouts” or “Website sign-ups (Zapier)”" error={f.error('name')}>
                <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} maxLength={100} autoFocus />
              </Field>
              <Field label="What it does">
                <ActionPicker value={action} onChange={setAction} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" pending={create.isPending} pendingLabel="Creating…">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Set up drawer ──────────────────────────────────────────────────────────

const TAG_ENTITY: Record<InAction, TagEntity | undefined> = {contact: 'CONTACT', company: 'COMPANY', deal: 'DEAL', ticket: 'TICKET', automations: undefined};

function useTargets(action: InAction) {
  const contact = useFields('CONTACT');
  const company = useFields('COMPANY');
  const deal = useFields('DEAL');
  return useMemo(() => inTargets(action, {CONTACT: contact.data ?? [], COMPANY: company.data ?? [], DEAL: deal.data ?? []}), [action, contact.data, company.data, deal.data]);
}

/** Section heading inside the drawer. */
function Section({title, hint, children, actions}: {title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode}) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function randomSecret() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type HookFields = {name: string; verifyHeader: string; secretName: string; idempotencyPath: string};

function HookDialog({hook, onClose, onLog}: {hook: IncomingWebhookRow; onClose: () => void; onLog: () => void}) {
  const ids = useId();
  const [name, setName] = useState(hook.name);
  const [action, setAction] = useState<InAction>(hook.action);
  const [config, setConfig] = useState<InConfig>(hook.config);
  const [verify, setVerify] = useState<InVerify>(hook.verify === 'none' ? 'header' : hook.verify);
  const [verifyHeader, setVerifyHeader] = useState(hook.verifyHeader ?? (hook.verify === 'hmac' ? 'X-Signature' : 'X-Webhook-Secret'));
  const [verifyEncoding, setVerifyEncoding] = useState<'hex' | 'base64'>(hook.verifyEncoding ?? 'hex');
  const [secretName, setSecretName] = useState(hook.secretName ?? suggestSecretName(hook.name));
  const set = (p: Partial<InConfig>) => setConfig((c) => ({...c, ...p}));
  const targets = useTargets(action);

  // Live state (listening, sample) polls every 2 s while listening; the draft above stays as typed.
  const live = useQuery({
    queryKey: [...keys.incomingWebhooks, hook.id],
    queryFn: () => api.get<{webhook: IncomingWebhookRow}>(`/incoming-webhooks/${hook.id}`),
    select: (d) => d.webhook,
    initialData: {webhook: hook},
    refetchInterval: (q) => (q.state.data?.webhook.listening ? 2000 : false),
  });
  const current = live.data ?? hook;
  const paths = useMemo(() => (current.sample ? samplePaths(current.sample.payload) : []), [current.sample]);

  // A sample just arrived: suggest a mapping when there is none yet.
  const seenSample = useRef(hook.sampleAt);
  useEffect(() => {
    if (!current.sampleAt || current.sampleAt === seenSample.current) return;
    seenSample.current = current.sampleAt;
    const fresh = current.sample ? samplePaths(current.sample.payload) : [];
    const matched = config.mapping.length ? [] : suggestMapping(fresh.map((p) => p.path), targets);
    setConfig((c) => ({...c, mapping: c.mapping.length ? c.mapping : matched, idempotencyPath: c.idempotencyPath || suggestIdempotencyPath(fresh)}));
    toast.success(matched.length ? `Sample received: ${matched.length} field${matched.length === 1 ? '' : 's'} matched` : 'Sample received');
  }, [current.sampleAt]);

  const save = useApiMutation(
    () =>
      api.patch(`/incoming-webhooks/${hook.id}`, {
        name: name.trim(),
        action,
        config: {...config, mapping: config.mapping.filter((m) => m.path.trim() && m.target), fixed: config.fixed.filter((f) => f.target)},
        verify,
        verifyHeader: verifyHeader.trim(),
        verifyEncoding: verify === 'hmac' ? verifyEncoding : null,
        secretName: secretName.trim(),
      }),
    {invalidate: [keys.incomingWebhooks], success: 'Incoming webhook saved', onSuccess: onClose},
  );

  const f = useFormState<HookFields>({name, verifyHeader, secretName, idempotencyPath: config.idempotencyPath}, {
    name: [is.required('Give the webhook a name.'), is.maxLength(100)],
    verifyHeader: [is.required('Enter the header the sending tool uses.'), is.maxLength(100), is.pattern(/^[A-Za-z0-9-]*$/, 'Use letters, digits and dashes only.')],
    secretName: [(v) => (INCOMING_SECRET_NAME.test(v.trim()) ? null : 'Use capital letters, digits and _ after INCOMING_, e.g. INCOMING_STRIPE_SECRET.')],
    idempotencyPath: [is.maxLength(200)],
  });

  const changeAction = (a: InAction) => {
    setAction(a);
    // Fields the new action can't write are dropped.
    const allowed = new Set(inTargets(a, {CONTACT: [], COMPANY: [], DEAL: []}).map((t) => t.entity));
    setConfig((c) => ({...c, mapping: c.mapping.filter((m) => allowed.has(m.target.split('.')[0] as InEntity)), fixed: c.fixed.filter((f) => allowed.has(f.target.split('.')[0] as InEntity))}));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="xl">
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Set up incoming webhook</DialogTitle>
            <DialogDescription>Map what the other tool sends onto CRM fields. Changes apply to requests received after you save.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="grid min-w-0 content-start gap-6">
                <Field label="Name" htmlFor={`${ids}-name`} error={f.error('name')}>
                  <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} maxLength={100} />
                </Field>
                <Section title="What it does">
                  <ActionPicker value={action} onChange={changeAction} />
                </Section>
                <MappingEditor action={action} targets={targets} config={config} onChange={set} paths={paths} />
                <FixedValues targets={targets} config={config} onChange={set} />
                <OptionsEditor action={action} config={config} onChange={set} />
                <SecurityEditor
                  ids={ids}
                  form={f}
                  verify={verify}
                  setVerify={setVerify}
                  header={verifyHeader}
                  setHeader={setVerifyHeader}
                  encoding={verifyEncoding}
                  setEncoding={setVerifyEncoding}
                  secretName={secretName}
                  setSecretName={setSecretName}
                  secretAdded={current.secretAdded && current.secretName === secretName.trim()}
                  config={config}
                  onChange={set}
                />
              </div>
              <EndpointPanel hook={current} action={action} paths={paths} verify={verify} header={verifyHeader} encoding={verifyEncoding} onLog={onLog} onMap={(path) => set({mapping: addPath(config.mapping, path, targets)})} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A mapping row for `path`, with the suggested field when one fits and isn't used yet. */
function addPath(mapping: InConfig['mapping'], path: string, targets: InTarget[]) {
  if (mapping.some((m) => m.path === path)) return mapping;
  const used = new Set(mapping.map((m) => m.target));
  const guess = suggestMapping([path], targets.filter((t) => !used.has(t.key)))[0];
  return [...mapping, {path, target: guess?.target ?? ''}];
}

/** Grouped field picker (Contact, Contact · custom fields, Deal…). */
function TargetSelect({targets, value, onChange, id, exclude = [], placeholder = 'Pick a CRM field'}: {targets: InTarget[]; value: string; onChange: (v: string) => void; id?: string; exclude?: string[]; placeholder?: string}) {
  const groups = useMemo(() => {
    const out = new Map<string, InTarget[]>();
    for (const t of targets) if (!exclude.includes(t.field)) out.set(t.groupLabel, [...(out.get(t.groupLabel) ?? []), t]);
    return [...out];
  }, [targets, exclude]);
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label="CRM field">
      <option value="">{placeholder}</option>
      {groups.map(([label, list]) => (
        <optgroup key={label} label={label}>
          {list.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

function MappingEditor({action, targets, config, onChange, paths}: {action: InAction; targets: InTarget[]; config: InConfig; onChange: (p: Partial<InConfig>) => void; paths: {path: string; value: string}[]}) {
  const listId = useId();
  const rows = config.mapping;
  const setRow = (i: number, p: Partial<InConfig['mapping'][number]>) => onChange({mapping: rows.map((r, k) => (k === i ? {...r, ...p} : r))});
  const sampleValue = (path: string) => paths.find((p) => p.path === path.trim())?.value;
  const suggest = () => {
    const have = new Set(rows.map((r) => r.path));
    const used = new Set(rows.map((r) => r.target));
    const extra = suggestMapping(paths.map((p) => p.path).filter((p) => !have.has(p)), targets.filter((t) => !used.has(t.key)));
    onChange({mapping: [...rows.filter((r) => r.path.trim() || r.target), ...extra]});
    toast.success(extra.length ? `${extra.length} more field${extra.length === 1 ? '' : 's'} matched` : 'No more fields to match');
  };
  return (
    <Section
      title="Field mapping"
      hint={action === 'automations' ? 'Optional: an email or phone finds the contact the automations run on. Nothing is written.' : 'Where each value goes. Use dot paths like customer.email or items[0].name.'}
      actions={paths.length > 0 && <Button type="button" size="sm" variant="secondary" onClick={suggest}><Sparkles /> Match from sample</Button>}
    >
      <datalist id={listId}>{paths.map((p) => <option key={p.path} value={p.path}>{p.value.slice(0, 60)}</option>)}</datalist>
      {rows.length === 0 && <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-muted-foreground">No fields mapped yet. Listen for a test request to pick fields from real data, or add them by hand.</p>}
      {rows.length > 0 && (
        <ul className="grid gap-2">
          {rows.map((r, i) => {
            const value = sampleValue(r.path);
            return (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 @xl:grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)_auto] @xl:items-center">
                <div className="min-w-0">
                  <Input value={r.path} onChange={(e) => setRow(i, {path: e.target.value})} placeholder="data.customer.email" list={listId} className="font-mono text-xs" aria-label="Incoming field path" />
                  {value !== undefined && <p className="mt-0.5 truncate px-1 text-[11px] text-muted-foreground" title={value}>Sample: {value || '(empty)'}</p>}
                </div>
                <ArrowRight className="hidden size-4 text-slate-300 @xl:block" />
                <div className="col-start-1 min-w-0 @xl:col-start-auto">
                  <TargetSelect targets={targets} value={r.target} onChange={(target) => setRow(i, {target})} />
                </div>
                <Button type="button" variant="ghost" size="icon-sm" className="row-start-1 col-start-2 @xl:col-start-auto @xl:row-start-auto" onClick={() => onChange({mapping: rows.filter((_, k) => k !== i)})} aria-label="Remove field"><X /></Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button type="button" size="sm" variant="secondary" className="justify-self-start" onClick={() => onChange({mapping: [...rows, {path: '', target: ''}]})} disabled={rows.length >= 100}><Plus /> Add field</Button>
    </Section>
  );
}

function FixedValueInput({target, value, onChange}: {target: InTarget | undefined; value: string; onChange: (v: string) => void}) {
  if (target?.kind === 'enum' && target.options?.length) {
    return (
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label="Value">
        <option value="">Pick a value</option>
        {target.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </NativeSelect>
    );
  }
  if (target?.kind === 'boolean') {
    return (
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label="Value">
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </NativeSelect>
    );
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={target?.kind === 'date' ? 'YYYY-MM-DD' : target?.kind === 'list' || target?.kind === 'multi' ? 'a, b, c' : 'Value'} aria-label="Value" />;
}

function FixedValues({targets, config, onChange}: {targets: InTarget[]; config: InConfig; onChange: (p: Partial<InConfig>) => void}) {
  const rows = config.fixed;
  if (targets.every((t) => t.field === 'email' || t.field === 'phone')) return null; // automations only
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const setRow = (i: number, p: Partial<InConfig['fixed'][number]>) => onChange({fixed: rows.map((r, k) => (k === i ? {...r, ...p} : r))});
  return (
    <Section title="Fixed values" hint="Set on every record this webhook writes, e.g. Source = Stripe or Lifecycle stage = Customer. They win over mapped values.">
      {rows.length > 0 && (
        <ul className="grid gap-2">
          {rows.map((r, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @xl:grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)_auto]">
              <TargetSelect targets={targets} value={r.target} onChange={(target) => setRow(i, {target, value: byKey.get(target)?.kind === 'boolean' ? 'yes' : ''})} exclude={['owner', 'note']} />
              <span className="hidden text-center text-slate-300 @xl:block">=</span>
              <div className="col-start-1 min-w-0 @xl:col-start-auto">
                <FixedValueInput target={byKey.get(r.target)} value={r.value} onChange={(value) => setRow(i, {value})} />
              </div>
              <Button type="button" variant="ghost" size="icon-sm" className="row-start-1 col-start-2 @xl:col-start-auto @xl:row-start-auto" onClick={() => onChange({fixed: rows.filter((_, k) => k !== i)})} aria-label="Remove value"><X /></Button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" size="sm" variant="secondary" className="justify-self-start" onClick={() => onChange({fixed: [...rows, {target: '', value: ''}]})} disabled={rows.length >= 50}><Plus /> Add fixed value</Button>
    </Section>
  );
}

function Chips<T extends string>({value, options, onChange, label}: {value: T; options: [T, string][]; onChange: (v: T) => void; label: string}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/30', value === v ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600 hover:border-primary/50')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function OptionsEditor({action, config, onChange}: {action: InAction; config: InConfig; onChange: (p: Partial<InConfig>) => void}) {
  const team = useTeam();
  const pipelines = usePipelines();
  const lists = useLists('STATIC');
  const ticketSettings = useTicketSettings();
  const users = team.data?.filter((u) => u.active) ?? [];
  const owner = config.owner;
  const pipeline = pipelines.data?.find((p) => p.id === config.deal.pipelineId) ?? pipelines.data?.[0];
  if (action === 'automations') return null;
  const recordNoun = action === 'company' ? 'companies' : 'contacts';
  const ownerLabel = action === 'deal' ? 'Owner of new deals' : action === 'ticket' ? 'Assign new tickets to' : `Owner of new ${recordNoun}`;
  const toggleUser = (id: string, on: boolean) => onChange({owner: {...owner, userIds: on ? [...new Set([...(owner.userIds ?? []), id])] : (owner.userIds ?? []).filter((x) => x !== id)}});

  return (
    <Section title="When data arrives" hint={action === 'deal' || action === 'ticket' ? `Each request creates a ${action}. The contact is matched by email, then phone.` : IN_ACTIONS[action].hint}>
      <div className="grid gap-4">
        <Field label={action === 'deal' || action === 'ticket' ? 'Contacts' : 'Records'}>
          <Chips label="Create or update" value={config.mode} onChange={(mode: InMode) => onChange({mode})} options={Object.entries(IN_MODES) as [InMode, string][]} />
        </Field>
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-semibold text-slate-800">Don't overwrite with blanks</span>
            <span className="block text-xs text-muted-foreground">An empty or missing value never clears what a record already has.</span>
          </span>
          <Switch checked={config.skipBlanks} onCheckedChange={(skipBlanks) => onChange({skipBlanks})} className="mt-0.5" />
        </label>

        {action === 'deal' && (
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="Pipeline" hint="Or map Deal · Pipeline by name.">
              <NativeSelect value={pipeline?.id ?? ''} onChange={(e) => onChange({deal: {...config.deal, pipelineId: e.target.value || null, stageId: null}})}>
                {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Stage">
              <NativeSelect value={config.deal.stageId ?? ''} onChange={(e) => onChange({deal: {...config.deal, pipelineId: pipeline?.id ?? null, stageId: e.target.value || null}})}>
                <option value="">First stage</option>
                {pipeline?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Deal name" hint="When Deal · Deal name isn't mapped. Merge fields: {{contact.full_name}}, {{company.name}}" className="@xl:col-span-2">
              <Input value={config.deal.title} onChange={(e) => onChange({deal: {...config.deal, title: e.target.value}})} placeholder="Webhook name: {{contact.full_name}}" maxLength={200} />
            </Field>
          </div>
        )}
        {action === 'ticket' && (
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="Subject" hint="When Ticket · Subject isn't mapped. Merge fields: {{contact.full_name}}" className="@xl:col-span-2">
              <Input value={config.ticket.subject} onChange={(e) => onChange({ticket: {...config.ticket, subject: e.target.value}})} placeholder="Webhook name: {{contact.full_name}}" maxLength={300} />
            </Field>
            <Field label="Priority">
              <NativeSelect value={config.ticket.priority} onChange={(e) => onChange({ticket: {...config.ticket, priority: e.target.value as TicketPriority}})}>
                {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Category">
              <NativeSelect value={config.ticket.category ?? ''} onChange={(e) => onChange({ticket: {...config.ticket, category: e.target.value || null}})}>
                <option value="">No category</option>
                {ticketSettings.data?.settings.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </NativeSelect>
            </Field>
          </div>
        )}

        <Field label={`Add tags to the ${action === 'company' ? 'company' : action}`}>
          <TagInput value={config.tags} onChange={(tags) => onChange({tags})} entity={TAG_ENTITY[action]} />
        </Field>
        {action !== 'company' && (
          <Field label="Add the contact to a list" hint="Static lists only.">
            <NativeSelect value={config.listId ?? ''} onChange={(e) => onChange({listId: e.target.value || null})}>
              <option value="">No list</option>
              {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </NativeSelect>
          </Field>
        )}
        <div className="grid gap-2">
          <p className="text-sm font-semibold text-slate-800">{ownerLabel}</p>
          <Chips
            label={ownerLabel}
            value={owner.mode}
            onChange={(mode) => onChange({owner: {...owner, mode}})}
            options={[
              ['none', action === 'deal' ? "The contact's owner" : 'Nobody'],
              ['user', 'One person'],
              ['round_robin', 'Rotate between people'],
            ]}
          />
          {owner.mode === 'user' && (
            <NativeSelect value={owner.userId ?? ''} onChange={(e) => onChange({owner: {...owner, userId: e.target.value || null}})} aria-label="Person">
              <option value="">Pick a teammate…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </NativeSelect>
          )}
          {owner.mode === 'round_robin' && (
            <div className="grid grid-cols-1 gap-1.5 @lg:grid-cols-2">
              {users.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <Checkbox checked={owner.userIds?.includes(u.id) ?? false} onCheckedChange={(v) => toggleUser(u.id, v === true)} />
                  {u.name}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">Existing records keep their owner; a mapped Owner (team member email or name) wins.</p>
        </div>
      </div>
    </Section>
  );
}

function SecurityEditor(p: {
  ids: string;
  form: FormState<HookFields>;
  verify: InVerify;
  setVerify: (v: InVerify) => void;
  header: string;
  setHeader: (v: string) => void;
  encoding: 'hex' | 'base64';
  setEncoding: (v: 'hex' | 'base64') => void;
  secretName: string;
  setSecretName: (v: string) => void;
  secretAdded: boolean;
  config: InConfig;
  onChange: (c: Partial<InConfig>) => void;
}) {
  const {ids, verify} = p;
  const [generated, setGenerated] = useState('');
  const f = p.form;
  const pickVerify = (v: InVerify) => {
    p.setVerify(v);
    if (!p.header.trim()) p.setHeader(v === 'hmac' ? 'X-Signature' : 'X-Webhook-Secret');
  };
  return (
    <Section title="Security and limits" hint="Every request needs the secret URL AND passes a check: a secret header or a signature.">
      <div className="grid gap-4">
        <div role="radiogroup" aria-label="Verification" className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {(Object.keys(IN_VERIFY) as (keyof typeof IN_VERIFY)[]).map((v) => (
            <label key={v} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors', verify === v ? 'border-primary bg-primary/5' : 'border-slate-200 hover:border-slate-300')}>
              <input type="radio" name={`${ids}-verify`} className="mt-1 accent-[var(--primary)]" checked={verify === v} onChange={() => pickVerify(v)} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800">{IN_VERIFY[v].label}</span>
                <span className="block text-xs text-muted-foreground">{IN_VERIFY[v].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label={verify === 'hmac' ? 'Signature header' : 'Header name'} htmlFor={`${ids}-header`} hint={verify === 'hmac' ? 'An optional sha256= prefix is accepted.' : undefined} error={f.error('verifyHeader')}>
              <Input id={`${ids}-header`} value={p.header} onChange={(e) => p.setHeader(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))} onBlur={f.blur('verifyHeader')} placeholder={verify === 'hmac' ? 'X-Signature' : 'X-Webhook-Secret'} className="font-mono text-xs" maxLength={100} />
            </Field>
            {verify === 'hmac' && (
              <Field label="Signature encoding">
                <NativeSelect value={p.encoding} onChange={(e) => p.setEncoding(e.target.value as 'hex' | 'base64')}>
                  <option value="hex">Hex</option>
                  <option value="base64">Base64</option>
                </NativeSelect>
              </Field>
            )}
            <Field
              label={verify === 'hmac' ? 'Site secret with the signing key' : 'Site secret with the secret'}
              htmlFor={`${ids}-secret`}
              className="@xl:col-span-2"
              error={f.error('secretName')}
              hint={p.secretAdded ? 'Added in your dashboard. Requests must match its value.' : 'Not added yet: until it is, every request is refused. In your dashboard, add a secret with this name and the value the sending tool uses.'}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input id={`${ids}-secret`} value={p.secretName} onChange={(e) => p.setSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} onBlur={f.blur('secretName')} className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" spellCheck={false} />
                <Badge tone={p.secretAdded ? 'green' : 'amber'}>{p.secretAdded ? 'Added' : 'Not added'}</Badge>
              </div>
            </Field>
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-muted-foreground @xl:col-span-2">
              <p>The sending tool gives you a secret, or make one here. Its value goes in two places: the site secret above (in your dashboard) and the sending tool. Kinroot never stores it.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setGenerated(randomSecret())}><KeyRound /> Make a secret</Button>
                {generated && (
                  <>
                    <code className="break-all rounded-md bg-card px-2 py-1 text-slate-800">{generated}</code>
                    <Button type="button" variant="secondary" size="icon" onClick={() => copy(generated, 'Secret copied')} aria-label="Copy secret"><Copy /></Button>
                  </>
                )}
              </div>
            </div>
        </div>
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
          <Field label="Idempotency path" hint="A unique id in the payload, e.g. id. Repeats with the same value are ignored. An Idempotency-Key header works too." error={f.error('idempotencyPath')}>
            <Input value={p.config.idempotencyPath} onChange={(e) => p.onChange({idempotencyPath: e.target.value})} onBlur={f.blur('idempotencyPath')} placeholder="id" className="font-mono text-xs" maxLength={200} />
          </Field>
          <Field label="Requests per minute" hint="More are refused with 429 so the sender retries later.">
            <Input type="number" inputMode="numeric" value={p.config.rateLimit} onChange={(e) => p.onChange({rateLimit: Math.max(1, Math.min(1000, Number(e.target.value) || 1))})} />
          </Field>
        </div>
      </div>
    </Section>
  );
}

function curlCommand(url: string, body: unknown, verify: InVerify, header: string, encoding: 'hex' | 'base64') {
  const json = JSON.stringify(body);
  const quoted = `'${json.replace(/'/g, `'\\''`)}'`;
  if (verify === 'hmac') {
    const sign = encoding === 'base64' ? `openssl dgst -sha256 -hmac "$SECRET" -binary | base64` : `openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //'`;
    return `SECRET='your-signing-key'\nBODY=${quoted}\nSIG=$(printf '%s' "$BODY" | ${sign})\ncurl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "${header || 'X-Signature'}: sha256=$SIG" \\\n  -d "$BODY"`;
  }
  const extra = verify === 'header' ? ` \\\n  -H '${header || 'X-Webhook-Secret'}: your-secret'` : '';
  return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json'${extra} \\\n  -d ${quoted}`;
}

function EndpointPanel({hook, action, paths, verify, header, encoding, onLog, onMap}: {hook: IncomingWebhookRow; action: InAction; paths: {path: string; value: string}[]; verify: InVerify; header: string; encoding: 'hex' | 'base64'; onLog: () => void; onMap: (path: string) => void}) {
  const ids = useId();
  const toggle = useApiMutation((active: boolean) => api.patch(`/incoming-webhooks/${hook.id}`, {active}), {invalidate: [keys.incomingWebhooks]});
  const listen = useApiMutation((on: boolean) => api.post(`/incoming-webhooks/${hook.id}/listen`, {on}), {invalidate: [keys.incomingWebhooks]});
  const clear = useApiMutation(() => api.del(`/incoming-webhooks/${hook.id}/sample`), {invalidate: [keys.incomingWebhooks], success: 'Sample cleared'});
  const regenerate = useRegenerate(hook);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!hook.listening) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hook.listening]);
  const left = hook.listenUntil ? Math.max(0, Math.round((new Date(hook.listenUntil).getTime() - now) / 1000)) : 0;
  const body = hook.sample?.payload ?? exampleBody(action);

  return (
    <aside aria-labelledby={`${ids}-title`} className="grid min-w-0 content-start gap-4 self-start rounded-xl border border-slate-200 bg-slate-50/60 p-4 @4xl:sticky @4xl:top-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${ids}-title`} className="text-sm font-semibold text-slate-800">Webhook URL</h3>
          <p className="text-xs text-muted-foreground">Paste it into the other tool. Anyone with it can send data.</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-600">
          {hook.active ? 'On' : 'Off'}
          <Switch checked={hook.active} onCheckedChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} aria-busy={toggle.isPending || undefined} aria-label={hook.active ? 'Turn off' : 'Turn on'} />
        </label>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={hook.url} className="font-mono text-[11px]" onFocus={(e) => e.target.select()} aria-label="Webhook URL" />
        <Button type="button" variant="secondary" size="icon" onClick={() => copy(hook.url, 'URL copied')} aria-label="Copy URL"><Copy /></Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50" onClick={regenerate.run} disabled={regenerate.pending} aria-busy={regenerate.pending || undefined}>
          {regenerate.pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RefreshCw className="size-3" />} {regenerate.pending ? 'Regenerating…' : 'Regenerate URL'}
        </button>
        <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary hover:underline" onClick={onLog}><Clock className="size-3" /> Request log</button>
      </div>

      <div className="grid gap-2 border-t border-slate-200 pt-4">
        <p className="text-xs font-semibold text-slate-600">Test request</p>
        {hook.listening ? (
          <div className="flex items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5" role="status" aria-live="polite">
            <Loader2 className="size-4 shrink-0 animate-spin text-violet-600" />
            <p className="min-w-0 flex-1 text-xs text-violet-800">Listening… send a request to the URL now ({Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left). Nothing is written.</p>
            <Button type="button" size="sm" variant="secondary" onClick={() => listen.mutate(false)} pending={listen.isPending} pendingLabel="Stopping…">Stop</Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => listen.mutate(true)} pending={listen.isPending} pendingLabel="Starting…">
            <Ear /> {hook.sample ? 'Listen again' : 'Listen for a test request'}
          </Button>
        )}
        {!hook.listening && <p className="text-xs text-muted-foreground">The next request (for {LISTEN_MINUTES} minutes) becomes the sample: its fields show below to map. It writes no record, even while the webhook is off.</p>}
      </div>

      {hook.sample && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-600">Sample fields <span className="font-normal text-muted-foreground">· {ago(hook.sample.at)}</span></p>
            <button
              type="button"
              className="cursor-pointer text-xs font-semibold text-slate-500 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={clear.isPending}
              aria-busy={clear.isPending || undefined}
              onClick={async () => {
                if (await confirm({title: 'Clear the sample?', description: 'Its fields leave this list. Listen again to capture a new one; your mapping stays.', confirmLabel: 'Clear sample', destructive: true})) clear.mutate(undefined);
              }}
            >
              {clear.isPending ? 'Clearing…' : 'Clear'}
            </button>
          </div>
          {paths.length === 0 ? (
            <p className="text-xs text-muted-foreground">The sample has no fields.</p>
          ) : (
            <ul className="grid max-h-72 gap-px overflow-y-auto rounded-lg border border-slate-200 bg-card p-1 scrollbar-thin">
              {paths.map((p) => (
                <li key={p.path}>
                  <button type="button" onClick={() => onMap(p.path)} className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50" title={`Map ${p.path}`}>
                    <span className="grid min-w-0 flex-1">
                      <code className="truncate font-mono text-[11px] font-semibold text-slate-700">{p.path}</code>
                      <span className="truncate text-[11px] text-muted-foreground">{p.value || '(empty)'}</span>
                    </span>
                    <Plus className="size-3.5 shrink-0 text-slate-300 group-hover:text-primary" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">Click a field to add it to the mapping.</p>
        </div>
      )}

      <Disclosure summary="Send a sample request" icon={<Terminal />} className="bg-card">
        <p className="text-xs">Run this in a terminal (put your secret in). {hook.listening ? 'You are listening, so it becomes the sample.' : 'Click Listen first to capture it as the sample without writing anything.'}</p>
        <CodeBlock code={curlCommand(hook.url, body, verify, header, encoding)} label="curl command" className="max-h-64 text-[10.5px] whitespace-pre-wrap break-all" />
      </Disclosure>
    </aside>
  );
}

// ─── Request log ────────────────────────────────────────────────────────────

function RecordLink({entity, id, label}: {entity: InEntity; id: string; label: string}) {
  const cls = 'inline-flex min-w-0 items-center gap-1 font-semibold text-primary hover:underline';
  const text = <><span className="truncate">{label}</span><ExternalLink className="size-3 shrink-0" /></>;
  if (entity === 'contact') return <Link to="/contacts/$contactId" params={{contactId: id}} className={cls}>{text}</Link>;
  if (entity === 'company') return <Link to="/companies/$companyId" params={{companyId: id}} className={cls}>{text}</Link>;
  if (entity === 'deal') return <Link to="/deals/$dealId" params={{dealId: id}} className={cls}>{text}</Link>;
  return <Link to="/tickets/$ticketId" params={{ticketId: id}} className={cls}>{text}</Link>;
}

const OUTCOME: Record<string, string> = {created: 'Created', updated: 'Updated', unchanged: 'No changes to', skipped: 'Skipped', none: 'Started automations'};

function ResultLine({r}: {r: IncomingRequestRow}) {
  const res = r.result;
  if (r.status === 'rejected' || (r.status === 'failed' && !res?.recordId)) return <span className="truncate text-rose-600">{r.error}</span>;
  if (r.status === 'captured') return <span className="truncate text-muted-foreground">Saved as the sample</span>;
  if (r.status === 'accepted') return <span className="truncate text-muted-foreground">{r.error ?? 'Waiting to be processed'}</span>;
  if (r.status === 'duplicate') return <span className="truncate text-muted-foreground">{res?.reason ?? 'Already received'}</span>;
  if (!res) return null;
  if (res.entity && res.recordId) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-slate-600">
        <span className="shrink-0">{OUTCOME[res.outcome]} {ENTITY_LABEL[res.entity].toLowerCase()}</span>
        <RecordLink entity={res.entity} id={res.recordId} label={res.label || 'record'} />
      </span>
    );
  }
  return <span className="truncate text-muted-foreground">{res.reason ?? OUTCOME[res.outcome]}</span>;
}

function RequestLogDialog({hook, onClose}: {hook: IncomingWebhookRow; onClose: () => void}) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const key = [...keys.incomingWebhooks, 'requests', hook.id, filter];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.get<{rows: IncomingRequestRow[]}>(`/incoming-webhooks/${hook.id}/requests`, filter === 'failed' ? {status: 'failed'} : undefined),
    refetchInterval: 5000,
  });
  const retry = useApiMutation((id: string) => api.post(`/incoming-webhooks/requests/${id}/retry`), {invalidate: [[...keys.incomingWebhooks, 'requests', hook.id]], success: 'Queued again'});
  const rows = list.data?.rows ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Request log</DialogTitle>
          <DialogDescription className="truncate">{hook.name} · the last 50 requests, kept 30 days</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as 'all' | 'failed')} className="mb-3">
            <TabsList size="sm" aria-label="Show">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="failed">Failed</TabsTrigger>
            </TabsList>
          </Tabs>
          {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {list.isError && !list.data && <LoadError error={list.error} onRetry={() => list.refetch()} title="The request log could not be loaded" />}
          {!list.isLoading && !list.isError && rows.length === 0 && <EmptyState icon={<Clock />} title={filter === 'failed' ? 'No failed requests' : 'No requests yet'} description={filter === 'failed' ? 'Requests that could not be processed show up here.' : 'Send a test request to the URL, or wait for the other tool to send one.'} />}
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const s = IN_STATUSES[r.status] ?? IN_STATUSES.accepted;
              const isOpen = open === r.id;
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left text-xs">
                    {r.status === 'processed' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : r.status === 'failed' || r.status === 'rejected' ? <TriangleAlert className="size-4 shrink-0 text-rose-500" /> : <Clock className="size-4 shrink-0 text-slate-400" />}
                    <Badge tone={s.tone} className="shrink-0">{s.label}</Badge>
                    <span className="flex min-w-0 flex-1"><ResultLine r={r} /></span>
                    <span className="w-20 shrink-0 text-right text-muted-foreground" title={dateTime(r.createdAt)}>{ago(r.createdAt)}</span>
                    <ChevronDown className={cn('size-4 shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && (
                    <div className="mb-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                        <span>Received {dateTime(r.createdAt)}</span>
                        {r.processedAt && <span>Processed {dateTime(r.processedAt)}</span>}
                        <span>{(r.size / 1024).toFixed(1)} KB{r.contentType ? ` · ${r.contentType.split(';')[0]}` : ''}</span>
                        {r.attempts > 0 && <span>Attempts: {r.attempts}</span>}
                        {r.status === 'failed' && (
                          <Button size="sm" variant="secondary" className="ml-auto h-7" onClick={() => retry.mutate(r.id)} disabled={retry.isPending} pending={retry.isPending && retry.variables === r.id} pendingLabel="Queuing…"><RefreshCw /> Retry</Button>
                        )}
                      </div>
                      {r.error && <p className="font-semibold text-rose-600">{r.error}</p>}
                      {r.result?.warnings?.length ? (
                        <ul className="grid gap-0.5 text-amber-700">
                          {r.result.warnings.map((w) => <li key={w} className="flex gap-1.5"><TriangleAlert className="mt-px size-3 shrink-0" /> {w}</li>)}
                        </ul>
                      ) : null}
                      {r.result?.contactId && r.result.entity !== 'contact' && <p className="text-slate-600">Contact: <RecordLink entity="contact" id={r.result.contactId} label="open" /></p>}
                      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
                        <div className="min-w-0">
                          <p className="mb-1 font-semibold text-slate-600">Body{r.truncated ? ' (cut)' : ''}</p>
                          <pre className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] text-slate-700 scrollbar-thin">{r.body ?? '(not stored)'}</pre>
                        </div>
                        <div className="min-w-0">
                          <p className="mb-1 font-semibold text-slate-600">Headers</p>
                          <dl className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] scrollbar-thin">
                            {Object.entries(r.headers).map(([k, v]) => (
                              <div key={k} className="flex min-w-0 flex-wrap gap-x-1.5">
                                <dt className="font-semibold text-slate-700">{k}:</dt>
                                <dd className={cn('min-w-0 break-all', v === '[redacted]' ? 'text-slate-400 italic' : 'text-slate-500')}>{v}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

