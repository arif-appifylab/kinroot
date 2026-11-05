import {useQuery} from '@tanstack/react-query';
import {createFileRoute} from '@tanstack/react-router';
import {ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Eye, FlaskConical, Info, KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Send, ShieldCheck, Trash2, TriangleAlert, Webhook as WebhookIcon} from 'lucide-react';
import {useId, useMemo, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {LoadError} from '@/components/data-table';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, IconBadge, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {DataInSettings} from '@/components/webhooks/data-in';
import {CodeBlock, copy, Disclosure} from '@/components/webhooks/shared';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {EVENT_GROUPS, EVENT_TYPES, eventDef, WEBHOOK_HEADERS, webhookExampleBody} from '@/lib/events';
import {ago, dateTime} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {JobsStatus, Webhook, WebhookDelivery} from '@/lib/types';
import {cn} from '@/lib/utils';
import {WEBHOOK_HINT, WEBHOOK_REFUSED, webhookTarget} from '@/lib/webhook-targets';

export const Route = createFileRoute('/_app/settings/webhooks')({
  head: () => ({meta: [{title: pageTitle('Webhooks')}]}),
  validateSearch: z.object({tab: z.enum(['outgoing', 'incoming']).optional()}),
  component: WebhookSettings,
});

type EventItem = {type: string; label: string; short: string};
const GROUPS = EVENT_GROUPS as readonly {label: string; events: readonly EventItem[]}[];

const VERIFY_SNIPPET = `// Node / Workers: verify X-Webhook-Signature ("t=<unix>,v1=<hex>")
import {createHmac, timingSafeEqual} from 'node:crypto';

function verify(rawBody, header, secret) {
  const {t, v1} = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min replay window
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}`;

function WebhookSettings() {
  const {isAdmin} = useMe();
  const {tab = 'outgoing'} = Route.useSearch();
  const navigate = Route.useNavigate();

  if (!isAdmin) {
    return (
      <SettingsSection title="Webhooks">
        <AdminOnly />
      </SettingsSection>
    );
  }
  return (
    <>
      <Tabs value={tab} onValueChange={(v) => navigate({search: {tab: v === 'incoming' ? 'incoming' : undefined}, replace: true})} className="mb-4">
        <TabsList aria-label="Webhook direction">
          <TabsTrigger value="outgoing"><ArrowUpFromLine /> Outgoing</TabsTrigger>
          <TabsTrigger value="incoming"><ArrowDownToLine /> Incoming</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'incoming' ? (
        <DataInSettings />
      ) : (
        <OutgoingWebhooks />
      )}
    </>
  );
}

/** Outgoing: events sent to other tools as they happen. */
function OutgoingWebhooks() {
  const list = useQuery({queryKey: keys.webhooks, queryFn: () => api.get<{rows: Webhook[]; jobs: JobsStatus}>('/webhooks')});
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Webhook | null>(null);

  const rows = list.data?.rows ?? [];
  // Keep the drawer on the fresh row after a save or a toggle.
  const editingHook = editing && editing !== 'new' ? (rows.find((r) => r.id === editing.id) ?? editing) : null;
  return (
    <>
      <SettingsSection
        title="Outgoing webhooks"
        description="Send events to your automation and chat tools as they happen. Every request is signed so the receiver can trust it."
        actions={<Button size="sm" onClick={() => setEditing('new')}><Plus /> Add webhook</Button>}
      >
        {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {list.isError && <LoadError error={list.error} onRetry={() => list.refetch()} title="The webhooks could not be loaded" />}
        {!list.isLoading && !list.isError && rows.length === 0 && (
          <EmptyState
            icon={<WebhookIcon />}
            title="No webhooks yet"
            description="Add an endpoint URL and pick the events it should receive, like deal won or contact created."
            action={<Button size="sm" onClick={() => setEditing('new')}><Plus /> Add webhook</Button>}
          />
        )}
        <div className="grid gap-3">
          {rows.map((w) => (
            <WebhookRow key={w.id} hook={w} onEdit={() => setEditing(w)} onDeliveries={() => setDeliveriesFor(w)} onSecret={setSecret} />
          ))}
        </div>
        <VerifyDisclosure />
      </SettingsSection>

      {list.data && <JobsCard jobs={list.data.jobs} />}

      {editing && <WebhookDialog hook={editing === 'new' ? null : editingHook} onClose={() => setEditing(null)} onCreated={(s) => (setEditing(null), setSecret(s))} onDeliveries={(w) => setDeliveriesFor(w)} />}
      {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
      {deliveriesFor && <DeliveriesDialog hook={deliveriesFor} onClose={() => setDeliveriesFor(null)} />}
    </>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

/** "Send test event": posts a signed example of `type` to the saved URL; the result lands in the delivery log. */
function useSendTest(hookId: string, onDone?: (d: WebhookDelivery) => void) {
  return useApiMutation((type: string | undefined) => api.post<{delivery: WebhookDelivery}>(`/webhooks/${hookId}/test`, type ? {type} : {}), {
    invalidate: [keys.webhooks],
    onSuccess: ({delivery: d}) => {
      onDone?.(d);
      if (d.status === 'SUCCESS') toast.success(`Test ${d.eventType} delivered · HTTP ${d.responseStatus} in ${d.durationMs} ms`);
      else toast.error(`Test failed: ${d.error ?? `HTTP ${d.responseStatus}`}`);
    },
  });
}

// ─── Webhook list ───────────────────────────────────────────────────────────

function hookState(w: Webhook) {
  if (!w.active) return w.failures > 0 ? {label: 'Turned off after failures', tone: 'rose' as const} : {label: 'Off', tone: 'neutral' as const};
  if (w.failures > 0) return {label: `Failing (${w.failures})`, tone: 'amber' as const};
  return {label: 'Active', tone: 'green' as const};
}

/** The event a quick test sends: the first one subscribed to. */
const firstEvent = (w: Pick<Webhook, 'events'>) => w.events.find((e) => e !== '*') ?? 'contact.created';

function WebhookRow({hook: w, onEdit, onDeliveries, onSecret}: {hook: Webhook; onEdit: () => void; onDeliveries: () => void; onSecret: (s: string) => void}) {
  const state = hookState(w);
  const toggle = useApiMutation((active: boolean) => api.patch(`/webhooks/${w.id}`, {active}), {invalidate: [keys.webhooks]});
  const remove = useApiMutation(() => api.del(`/webhooks/${w.id}`), {invalidate: [keys.webhooks], success: 'Webhook deleted'});
  const rotate = useApiMutation(() => api.post<{secret: string}>(`/webhooks/${w.id}/rotate`), {invalidate: [keys.webhooks], onSuccess: (r) => onSecret(r.secret)});
  const reveal = useApiMutation(() => api.get<{secret: string}>(`/webhooks/${w.id}/secret`), {onSuccess: (r) => onSecret(r.secret)});
  const test = useSendTest(w.id);
  const events = w.events.includes('*') ? 'All events' : `${w.events.length} event${w.events.length === 1 ? '' : 's'}`;

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IconBadge tone={w.active ? 'blue' : 'slate'} className="mt-0.5 shrink-0"><WebhookIcon /></IconBadge>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold text-slate-900" title={w.url}>{w.url}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge tone={state.tone}>{state.label}</Badge>
            <span>{events}</span>
            {w.description && <span>· {w.description}</span>}
            {w.lastDeliveryAt && <span>· last delivery {ago(w.lastDeliveryAt)}{w.lastStatus ? ` (HTTP ${w.lastStatus})` : ''}</span>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Switch checked={w.active} onCheckedChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} aria-busy={toggle.isPending || undefined} aria-label={w.active ? 'Turn off' : 'Turn on'} />
        <Button variant="secondary" size="sm" onClick={() => test.mutate(firstEvent(w))} disabled={!w.active} pending={test.isPending} pendingLabel="Sending…" title={`Send a signed example of ${firstEvent(w)}`}>
          <Send /> Test
        </Button>
        <Button variant="secondary" size="sm" onClick={onDeliveries}><Clock /> Log</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" pending={remove.isPending || rotate.isPending || reveal.isPending}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit and preview payload</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => reveal.mutate(undefined)}><Eye /> Show signing secret</DropdownMenuItem>
            <DropdownMenuItem onSelect={async () => (await confirm({title: 'Rotate the secret?', description: 'The receiver must switch to the new one.', confirmLabel: 'Rotate secret'})) && rotate.mutate(undefined)}><KeyRound /> Rotate secret</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete the webhook to ${w.url}?`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

// ─── Add / edit drawer ──────────────────────────────────────────────────────

function WebhookDialog({hook, onClose, onCreated, onDeliveries}: {hook: Webhook | null; onClose: () => void; onCreated: (secret: string) => void; onDeliveries: (w: Webhook) => void}) {
  const ids = useId();
  const [url, setUrl] = useState(hook?.url ?? '');
  const [description, setDescription] = useState(hook?.description ?? '');
  const [all, setAll] = useState(hook ? hook.events.includes('*') : false);
  const [events, setEvents] = useState<string[]>(hook && !hook.events.includes('*') ? hook.events : []);
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const save = useApiMutation(
    () => {
      const body = {url: url.trim(), description: description.trim() || null, events: all ? ['*'] : events};
      return hook ? api.patch(`/webhooks/${hook.id}`, body) : api.post<{secret: string}>('/webhooks', body);
    },
    {
      invalidate: [keys.webhooks],
      success: hook ? 'Webhook saved' : undefined,
      onSuccess: (r) => (hook ? onClose() : onCreated((r as {secret: string}).secret)),
    },
  );
  // Order follows the catalogue, so "first selected" is stable whatever order they were ticked in.
  const f = useFormState({url, description}, {
    url: [is.required('Enter the webhook URL.'), is.maxLength(2000), (v) => (webhookTarget(v) ? null : WEBHOOK_REFUSED)],
    description: [is.maxLength(200)],
  });
  const ordered = EVENT_TYPES.filter((t) => events.includes(t));
  const previewType = hovered ?? (picked && (all || !events.length || events.includes(picked)) ? picked : null) ?? ordered[0] ?? 'contact.created';

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="xl">
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{hook ? 'Edit webhook' : 'Add webhook'}</DialogTitle>
            <DialogDescription>We POST a signed JSON payload to this URL whenever one of the chosen events happens.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,1fr)_400px]">
              <div className="grid min-w-0 content-start gap-5">
                <Field label="Endpoint URL" htmlFor={`${ids}-url`} error={f.error('url')} hint={WEBHOOK_HINT}>
                  <Input
                    id={`${ids}-url`}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={f.blur('url')}
                    placeholder="https://…"
                    type="url"
                    autoFocus
                  />
                </Field>
                <Field label="Description" htmlFor={`${ids}-desc`} hint="Optional, e.g. “Post won deals to the sales channel”" error={f.error('description')}>
                  <Input id={`${ids}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={f.blur('description')} maxLength={200} />
                </Field>

                <section aria-labelledby={`${ids}-events`} className="grid gap-3">
                  <h3 id={`${ids}-events`} className="text-sm font-semibold text-slate-800">Events</h3>
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
                    <span>
                      <span className="block text-sm font-semibold text-slate-800">Send every event</span>
                      <span className="block text-xs text-muted-foreground">Includes events added by future modules.</span>
                    </span>
                    <Switch checked={all} onCheckedChange={setAll} />
                  </label>
                  {all ? (
                    <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-muted-foreground">
                      <Info className="mt-px size-3.5 shrink-0" />
                      All {EVENT_TYPES.length} events are sent, plus any added later. Turn this off to pick specific ones.
                    </p>
                  ) : (
                    <EventPicker selected={events} onChange={setEvents} onPreview={setHovered} />
                  )}
                </section>
              </div>

              <PayloadPreview type={previewType} hovering={!!hovered} onPick={(t) => (setPicked(t), setHovered(null))} hook={hook} urlChanged={!!hook && url.trim() !== hook.url} onDeliveries={onDeliveries} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" disabled={!all && !events.length} pending={save.isPending} pendingLabel={hook ? 'Saving…' : 'Adding…'}>
              {hook ? 'Save' : 'Add webhook'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const matches = (q: string, ...texts: string[]) => texts.some((t) => t.toLowerCase().includes(q));

/** Grouped, searchable checklist: one column, short labels, the event key in small mono under each. */
function EventPicker({selected, onChange, onPreview}: {selected: string[]; onChange: (next: string[]) => void; onPreview: (type: string | null) => void}) {
  const ids = useId();
  const [query, setQuery] = useState('');
  // Groups that already have picks start open; a new webhook opens the first group.
  const [open, setOpen] = useState<Set<string>>(() => {
    const withPicks = GROUPS.filter((g) => g.events.some((e) => selected.includes(e.type))).map((g) => g.label);
    return new Set(withPicks.length ? withPicks : GROUPS.slice(0, 1).map((g) => g.label));
  });
  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () => GROUPS.map((g) => ({...g, shown: !q || matches(q, g.label) ? g.events : g.events.filter((e) => matches(q, e.label, e.short, e.type))})).filter((g) => g.shown.length),
    [q],
  );
  const set = (types: string[], on: boolean) => onChange(on ? [...new Set([...selected, ...types])] : selected.filter((t) => !types.includes(t)));
  const toggleGroup = (label: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
  });

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} placeholder="Search events, e.g. won or ticket" className="pl-9" aria-label="Search events" />
      </div>
      <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span aria-live="polite">{selected.length ? `${selected.length} of ${EVENT_TYPES.length} selected` : 'Pick at least one event'}</span>
        {selected.length > 0 && (
          <button type="button" className="cursor-pointer font-semibold text-primary hover:underline" onClick={() => onChange([])}>Clear</button>
        )}
      </div>

      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200" onMouseLeave={() => onPreview(null)}>
        {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No events match “{query.trim()}”.</p>}
        {groups.map((g) => {
          const isOpen = !!q || open.has(g.label);
          const count = g.events.filter((e) => selected.includes(e.type)).length;
          const shownTypes = g.shown.map((e) => e.type);
          const allOn = shownTypes.every((t) => selected.includes(t));
          const listId = `${ids}-${g.label.replace(/\W+/g, '-')}`;
          return (
            <section key={g.label}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left disabled:cursor-default" onClick={() => toggleGroup(g.label)} aria-expanded={isOpen} aria-controls={listId} disabled={!!q}>
                  <ChevronRight className={cn('size-4 shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-90')} />
                  <span className="truncate text-sm font-semibold text-slate-800">{g.label}</span>
                  <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums', count ? 'bg-blue-50 text-blue-700' : 'text-muted-foreground')} aria-label={`${count} of ${g.events.length} selected`}>
                    {count}/{g.events.length}
                  </span>
                </button>
                <button type="button" className="shrink-0 cursor-pointer text-xs font-semibold text-primary hover:underline" onClick={() => set(shownTypes, !allOn)}>
                  {allOn ? 'Select none' : 'Select all'}
                </button>
              </div>
              {isOpen && (
                <ul id={listId} className="grid gap-px px-1.5 pb-2">
                  {g.shown.map((e) => (
                    <li key={e.type}>
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50" title={e.label} onMouseEnter={() => onPreview(e.type)} onFocus={() => onPreview(e.type)} onBlur={() => onPreview(null)}>
                        <Checkbox className="mt-0.5" checked={selected.includes(e.type)} onCheckedChange={(v) => set([e.type], v === true)} />
                        <span className="grid min-w-0">
                          <span className="truncate text-sm text-slate-700">{e.short}</span>
                          <code className="truncate font-mono text-[11px] text-muted-foreground">{e.type}</code>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** What one delivery contains: headers + the JSON body, for the hovered / picked / first selected event. */
function PayloadPreview({type, hovering, onPick, hook, urlChanged, onDeliveries}: {type: string; hovering: boolean; onPick: (type: string) => void; hook: Webhook | null; urlChanged: boolean; onDeliveries: (w: Webhook) => void}) {
  const ids = useId();
  const [result, setResult] = useState<WebhookDelivery | null>(null);
  const test = useSendTest(hook?.id ?? '', setResult);
  const body = useMemo(() => JSON.stringify(webhookExampleBody(type), null, 2), [type]);
  const def = eventDef(type);
  const testBlocked = !hook ? 'Save the webhook first, then send a test from here or from its row.' : !hook.active ? 'Turn the webhook on to send a test.' : urlChanged ? 'Save your changes first: tests go to the saved URL.' : null;

  return (
    <aside aria-labelledby={`${ids}-title`} className="grid min-w-0 content-start gap-3 self-start rounded-xl border border-slate-200 bg-slate-50/60 p-4 @4xl:sticky @4xl:top-0">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold text-slate-800">Payload</h3>
        <p className="text-xs text-muted-foreground">Each delivery is a POST with this JSON body. The data is an example.</p>
      </div>
      <Field label="Event" htmlFor={`${ids}-event`} hint={hovering ? 'Showing the event under your pointer.' : undefined}>
        <NativeSelect id={`${ids}-event`} value={type} onChange={(e) => onPick(e.target.value)}>
          {GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.events.map((e) => <option key={e.type} value={e.type}>{e.label}</option>)}
            </optgroup>
          ))}
        </NativeSelect>
      </Field>

      <div className="grid gap-1.5">
        <p className="text-xs font-semibold text-slate-600">Headers</p>
        <dl className="grid gap-1 rounded-lg border border-slate-200 bg-card p-2.5 font-mono text-[11px]">
          {WEBHOOK_HEADERS.map((h) => (
            <div key={h.name} className="flex min-w-0 flex-wrap gap-x-1.5" title={h.hint}>
              <dt className="font-semibold text-slate-700">{h.name}:</dt>
              <dd className="min-w-0 break-all text-slate-500">
                {h.name === 'X-Webhook-Event' ? type : h.value}
                {h.name === 'X-Webhook-Test' && <span className="font-sans text-muted-foreground"> · tests only</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="grid gap-1.5">
        <p className="text-xs font-semibold text-slate-600">Body{def ? <span className="font-normal text-muted-foreground"> · {def.label}</span> : null}</p>
        <CodeBlock code={body} label="payload" />
      </div>

      <div className="grid gap-1.5 border-t border-slate-200 pt-3">
        <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => test.mutate(type)} disabled={!!testBlocked} pending={test.isPending} pendingLabel="Sending…">
          <Send /> Send test event
        </Button>
        {testBlocked ? (
          <p className="text-xs text-muted-foreground">{testBlocked}</p>
        ) : result ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {result.status === 'SUCCESS' ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <TriangleAlert className="size-3.5 text-rose-500" />}
            <span>{result.status === 'SUCCESS' ? `HTTP ${result.responseStatus} in ${result.durationMs} ms` : (result.error ?? `HTTP ${result.responseStatus}`)}</span>
            {hook && <button type="button" className="cursor-pointer font-semibold text-primary hover:underline" onClick={() => onDeliveries(hook)}>Open delivery log</button>}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Posts this example, signed, to the saved URL with X-Webhook-Test: true. The answer shows here and in the delivery log.</p>
        )}
      </div>
    </aside>
  );
}

// ─── Secret, delivery log ───────────────────────────────────────────────────

function SecretDialog({secret, onClose}: {secret: string; onClose: () => void}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>The receiver uses this to check the X-Webhook-Signature header. Keep it private, like a password.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-2">
            <Input readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Signing secret" />
            <Button variant="secondary" size="icon" onClick={() => copy(secret, 'Secret copied')} aria-label="Copy secret"><Copy /></Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesDialog({hook, onClose}: {hook: Webhook; onClose: () => void}) {
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [...keys.webhooks, 'deliveries', hook.id],
    queryFn: () => api.get<{rows: WebhookDelivery[]}>(`/webhooks/${hook.id}/deliveries`),
    refetchInterval: 5000,
  });
  const redeliver = useApiMutation((id: string) => api.post(`/webhooks/deliveries/${id}/redeliver`), {
    invalidate: [[...keys.webhooks, 'deliveries', hook.id]],
    success: 'Queued for delivery',
  });
  const rows = list.data?.rows ?? [];
  const tone = {SUCCESS: 'green', FAILED: 'rose', PENDING: 'amber'} as const;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Delivery log</DialogTitle>
          <DialogDescription className="truncate font-mono">{hook.url}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {list.isError && !list.data && <LoadError error={list.error} onRetry={() => list.refetch()} title="The delivery log could not be loaded" />}
          {!list.isLoading && !list.isError && rows.length === 0 && <EmptyState icon={<Clock />} title="No deliveries yet" description="Send a test, or wait for one of the subscribed events." />}
          <ul className="divide-y divide-slate-100">
            {rows.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id} className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left">
                  {d.status === 'SUCCESS' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : d.status === 'FAILED' ? <TriangleAlert className="size-4 shrink-0 text-rose-500" /> : <RefreshCw className="size-4 shrink-0 text-amber-500" />}
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <code className="truncate text-xs font-semibold text-slate-800">{d.eventType}</code>
                    {d.event.entity === 'webhook' && <Badge tone="violet" className="shrink-0"><FlaskConical /> Test</Badge>}
                  </span>
                  <Badge tone={tone[d.status]}>{d.status === 'PENDING' && d.attempts ? 'Retrying' : d.status.toLowerCase()}</Badge>
                  <span className="hidden w-16 text-right text-xs text-muted-foreground @lg:inline">{d.responseStatus ? `HTTP ${d.responseStatus}` : '—'}</span>
                  <span className="hidden w-14 text-right text-xs text-muted-foreground @lg:inline">{d.durationMs !== null ? `${d.durationMs} ms` : ''}</span>
                  <span className="w-20 text-right text-xs text-muted-foreground">{ago(d.createdAt)}</span>
                  <ChevronDown className={cn('size-4 shrink-0 text-slate-400 transition-transform', open === d.id && 'rotate-180')} />
                </button>
                {open === d.id && (
                  <div className="mb-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                      <span>Created {dateTime(d.createdAt)}</span>
                      <span>Attempts: {d.attempts}</span>
                      {d.deliveredAt && <span>Delivered {dateTime(d.deliveredAt)}</span>}
                      {d.error && <span className="font-semibold text-rose-600">{d.error}</span>}
                      <Button size="sm" variant="secondary" className="ml-auto h-7" onClick={() => redeliver.mutate(d.id)} disabled={redeliver.isPending} pending={redeliver.isPending && redeliver.variables === d.id} pendingLabel="Queuing…"><RefreshCw /> Redeliver</Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
                      <div className="min-w-0">
                        <p className="mb-1 font-semibold text-slate-600">Payload data</p>
                        <pre className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] text-slate-700 scrollbar-thin">{JSON.stringify(d.event.data, null, 2)}</pre>
                      </div>
                      <div className="min-w-0">
                        <p className="mb-1 font-semibold text-slate-600">Response</p>
                        <pre className="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700 scrollbar-thin">{d.responseBody || '(empty)'}</pre>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ─── Verifying requests, background jobs ────────────────────────────────────

function VerifyDisclosure() {
  return (
    <Disclosure summary="Verify that requests come from us" icon={<ShieldCheck />} className="mt-4">
      <p>
        Each delivery is signed with the webhook's secret, so the receiving app can check the <code className="text-slate-700">X-Webhook-Signature</code> header and reject forged or replayed requests.
      </p>
      <CodeBlock code={VERIFY_SNIPPET} label="verification snippet" className="max-h-64 text-[10.5px]" />
      <p className="text-xs">
        Answer with any 2xx status within 10 seconds. Failed deliveries are retried 5 more times over about 11 hours (30 s, 2 min, 8 min, 32 min, 2 h, 8.5 h). After 20 deliveries in a row fail for good, the webhook is turned off.
      </p>
    </Disclosure>
  );
}

function JobsCard({jobs}: {jobs: JobsStatus}) {
  const count = (n: number) => (n >= jobs.capped ? `${jobs.capped - 1}+` : String(n));
  const stale = !jobs.lastRunAt || Date.now() - new Date(jobs.lastRunAt).getTime() > 15 * 60_000;
  const running = jobs.cronConfigured && !stale;
  const scheduler = running
    ? {value: 'Running', tone: 'green' as const, hint: `Last run ${ago(jobs.lastRunAt!)}`}
    : jobs.devTicker
      ? {value: 'Running locally', tone: 'green' as const, hint: 'Jobs run automatically every 30 s'}
      : {value: jobs.cronConfigured ? 'Not running' : 'Not set up', tone: 'amber' as const, hint: jobs.lastRunAt ? `Last run ${ago(jobs.lastRunAt)}` : 'Never ran'};

  return (
    <SettingsSection title="Background jobs" description="Webhook deliveries run right after each change. A scheduled call to the job runner retries failures and syncs mailboxes.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Scheduler" value={scheduler.value} tone={scheduler.tone} hint={scheduler.hint} />
        <Stat label="Waiting" value={count(jobs.pending)} hint="Queued or retrying" />
        <Stat label="Failed (7 days)" value={count(jobs.failed)} tone={jobs.failed ? 'rose' : undefined} hint="Deliveries that gave up after all retries" />
      </div>
      {jobs.failedJobs > 0 && (
        <p className="mt-4 flex items-start gap-2 text-xs text-rose-700">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {count(jobs.failedJobs)} background job{jobs.failedJobs === 1 ? ' was' : 's were'} refused for good by the platform and set aside (kept 30 days). Check the Jobs tab of this app in your dashboard.
        </p>
      )}
      {jobs.note && (
        <p className="mt-4 flex items-start gap-2 text-xs text-amber-700">
          <Info className="mt-px size-3.5 shrink-0" />
          {jobs.note}
        </p>
      )}
      <JobsRate perMinute={jobs.perMinute} />
      {!running && (
        <p className={cn('mt-4 flex items-start gap-2 text-xs', jobs.devTicker ? 'text-muted-foreground' : 'text-amber-700')}>
          {jobs.devTicker ? <Info className="mt-px size-3.5 shrink-0" /> : <TriangleAlert className="mt-px size-3.5 shrink-0" />}
          {jobs.devTicker
            ? 'Running locally: jobs run right away here; the schedule (retries, mailbox syncs) runs on the live site.'
            : 'No scheduled run in the last 15 minutes, so failed deliveries are not being retried. Check the Jobs tab of this app in your dashboard.'}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        The site's background jobs retry failed webhook deliveries, send scheduled and waiting work (broadcasts, report emails, reminders) and sync connected mailboxes, every minute. Nothing to set up; their history is in the Jobs tab of this app in your dashboard.
      </p>
    </SettingsSection>
  );
}

/** The site's job rate: the same number the owner set in the dashboard's Jobs tab (10 by default, up to 50). */
function JobsRate({perMinute}: {perMinute: number}) {
  const ids = useId();
  const [value, setValue] = useState(String(perMinute));
  const f = useFormState({perMinute: value}, {perMinute: [is.required('Enter how many new jobs a minute this site may send.'), is.number({min: 1, max: 1000, integer: true})]});
  const save = useApiMutation(() => api.put<{perMinute: number}>('/webhooks/jobs-rate', {perMinute: Number(value)}), {invalidate: [keys.webhooks], success: 'Job rate saved'});
  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="mt-4 flex flex-wrap items-end gap-3">
      <Field label="New jobs a minute" htmlFor={`${ids}-rate`} error={f.error('perMinute')} hint="Match the limit in the Jobs tab of your dashboard (10 unless you raised it).">
        <Input id={`${ids}-rate`} value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} onBlur={f.blur('perMinute')} inputMode="numeric" className="w-28" />
      </Field>
      <Button type="submit" variant="secondary" size="sm" pending={save.isPending} pendingLabel="Saving…" disabled={value === String(perMinute)}>
        Save
      </Button>
    </form>
  );
}

function Stat({label, value, hint, tone}: {label: string; value: string; hint?: string; tone?: 'green' | 'amber' | 'rose'}) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-extrabold tracking-tight text-slate-900', tone === 'green' && 'text-emerald-600', tone === 'amber' && 'text-amber-600', tone === 'rose' && 'text-rose-600')}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
