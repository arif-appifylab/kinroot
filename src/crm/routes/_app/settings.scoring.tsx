import {useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {Activity, Flame, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2, UserSearch, X} from 'lucide-react';
import {useEffect, useState} from 'react';

import {useBookingLinks} from '@/components/booking/hooks';
import {KINDS} from '@/components/activity-log';
import {useLists} from '@/components/lists/list-picker';
import {RulesSummary, SegmentBuilder, SegmentPreview} from '@/components/lists/segment-builder';
import {SingleContactPicker} from '@/components/pickers';
import {ScoreBadge, useScoringSettings} from '@/components/scoring/score';
import {LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, fullName} from '@/lib/format';
import {keys, useApiMutation, useMe, usePipelines} from '@/lib/queries';
import {
  BAND_TONES,
  bandRangeLabel,
  limitLabel,
  SCORE_EVENTS,
  scoreEventDef,
  type ScoreBand,
  type ScoreFilter,
  type ScoreRule,
  type ScoreRuleKind,
  type ScoreTestResult,
  type ScoringSettings,
  type ScoringStatus,
} from '@/lib/scoring';
import {emptyRules, type SegmentRules} from '@/lib/segments';
import type {FormRow} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/scoring')({
  head: () => ({meta: [{title: pageTitle('Lead scoring')}]}),
  component: ScoringSettingsPage,
});

const statusKey = [...keys.scoring, 'status'];
const rulesKey = [...keys.scoring, 'rules'];
/** Everything a rule or settings change can move: scores show on contacts, deals and reports. */
const scoreKeys = [keys.scoring, keys.contacts, keys.deals, keys.companies, keys.reports, keys.dashboards];

function ScoringSettingsPage() {
  const {isAdmin} = useMe();
  if (!isAdmin) {
    return (
      <SettingsSection title="Lead scoring">
        <AdminOnly />
      </SettingsSection>
    );
  }
  return (
    <>
      <Overview />
      <RulesSection />
      <BandsSection />
      <TestSection />
    </>
  );
}

// ─── Overview: bands, recalculation ───

function Overview() {
  const settings = useScoringSettings();
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.get<ScoringStatus>('/scoring/status'),
    // Poll while a recalculation runs.
    refetchInterval: (q) => (q.state.data?.recalc && !q.state.data.recalc.finishedAt ? 2000 : false),
  });
  const running = !!status.data?.recalc && !status.data.recalc.finishedAt;
  const recalc = useApiMutation(() => api.post('/scoring/recalculate'), {invalidate: [statusKey], success: 'Recalculating every score'});
  // When a recalculation finishes, scores everywhere may have moved.
  const qc = useQueryClient();
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      for (const queryKey of scoreKeys) void qc.invalidateQueries({queryKey});
    }
  }, [running, wasRunning, qc]);

  const bands = settings.data?.bands ?? [];
  const counts = new Map(status.data?.bands.map((b) => [b.key, b.count]));
  const r = status.data?.recalc;
  return (
    <SettingsSection
      title="Lead scoring"
      description="Score contacts on who they are (property rules) and what they do (behaviour rules). Points add up and can go negative; bands turn the score into Cold, Warm or Hot."
      actions={
        <Button size="sm" variant="secondary" onClick={() => recalc.mutate(undefined)} pending={recalc.isPending || running} pendingLabel="Recalculating…">
          <RefreshCw /> Recalculate all
        </Button>
      }
    >
      {(settings.isError || status.isError) && <LoadError error={settings.error ?? status.error} onRetry={() => (settings.refetch(), status.refetch())} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {bands.map((b) => (
          <Link key={b.key} to="/contacts" search={{scoreBand: b.key, sort: 'score', dir: 'desc'}} className="rounded-xl border border-slate-200 p-3 transition-colors hover:border-primary/50">
            <Badge tone={b.tone}><Flame /> {b.name}</Badge>
            <p className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums">{counts.get(b.key)?.toLocaleString() ?? '…'}</p>
            <p className="text-xs text-muted-foreground">{counts.get(b.key) === 1 ? 'contact' : 'contacts'} · score {bandRangeLabel(b.key, bands)}</p>
          </Link>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {running && r
          ? `Recalculating: ${Math.min(r.processed, r.total).toLocaleString()} of ${r.total.toLocaleString()} contacts…`
          : `${status.data?.enabledCount ?? 0} of ${status.data?.ruleCount ?? 0} rules on. ${r?.finishedAt ? `Last full recalculation ${ago(r.finishedAt)}. ` : ''}Scores also refresh in the background (decay, time-based rules) whenever the scheduled job runs${status.data?.lastPassAt ? `, last pass ${ago(status.data.lastPassAt)}` : ''}.`}
      </p>
    </SettingsSection>
  );
}

// ─── Rules ───

function RulesSection() {
  const rules = useQuery({queryKey: rulesKey, queryFn: () => api.get<{rows: ScoreRule[]}>('/scoring/rules'), select: (d) => d.rows});
  const [editing, setEditing] = useState<{kind: ScoreRuleKind; rule: ScoreRule | null} | null>(null);
  const property = (rules.data ?? []).filter((r) => r.kind === 'property');
  const behavior = (rules.data ?? []).filter((r) => r.kind === 'behavior');

  return (
    <>
      <SettingsSection
        title="Property rules"
        description="Points while a contact matches, e.g. job title contains “VP” (+15) or company size 1-10 (−5). Uses the same conditions as segments, and updates when the contact or its company changes."
        actions={<Button size="sm" onClick={() => setEditing({kind: 'property', rule: null})}><Plus /> Property rule</Button>}
      >
        {rules.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {rules.isError && <LoadError error={rules.error} onRetry={() => rules.refetch()} />}
        {!rules.isLoading && !rules.isError && property.length === 0 && (
          <EmptyState icon={<SlidersHorizontal />} title="No property rules yet" description="Reward the people who fit your ideal customer: title, lifecycle, company size or industry, custom fields, deals…" />
        )}
        <div className="grid gap-3">
          {property.map((r) => <RuleRow key={r.id} rule={r} onEdit={() => setEditing({kind: 'property', rule: r})} />)}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Behaviour rules"
        description="Points each time a contact does something, e.g. opens an email (+5), submits a form (+20) or books a meeting (+30). They count from when the rule is created."
        actions={<Button size="sm" onClick={() => setEditing({kind: 'behavior', rule: null})}><Plus /> Behaviour rule</Button>}
      >
        {!rules.isLoading && !rules.isError && behavior.length === 0 && (
          <EmptyState icon={<Activity />} title="No behaviour rules yet" description="Pick the actions that show buying intent and how many points each one is worth." />
        )}
        <div className="grid gap-3">
          {behavior.map((r) => <RuleRow key={r.id} rule={r} onEdit={() => setEditing({kind: 'behavior', rule: r})} />)}
        </div>
      </SettingsSection>

      {editing && <RuleDialog kind={editing.kind} rule={editing.rule} onClose={() => setEditing(null)} />}
    </>
  );
}

const points = (n: number) => (n > 0 ? `+${n}` : String(n));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function useFilterOptions(kind: string | undefined) {
  const forms = useQuery({queryKey: keys.forms, queryFn: () => api.get<{rows: FormRow[]}>('/forms'), select: (d) => d.rows, enabled: kind === 'form', staleTime: 60_000});
  const links = useBookingLinks();
  const pipelines = usePipelines();
  const lists = useLists('STATIC');
  switch (kind) {
    case 'form':
      return (forms.data ?? []).map((f) => ({value: f.id, label: f.name}));
    case 'booking_link':
      return (links.data ?? []).map((l) => ({value: l.id, label: l.name}));
    case 'pipeline':
      return (pipelines.data ?? []).map((p) => ({value: p.id, label: p.name}));
    case 'list':
      return (lists.data ?? []).map((l) => ({value: l.id, label: l.name}));
    case 'interaction_kind':
      return Object.entries(KINDS).map(([value, k]) => ({value, label: k.label}));
    default:
      return [];
  }
}

function behaviourText(rule: Pick<ScoreRule, 'event' | 'filter'>, options: {value: string; label: string}[]) {
  const def = scoreEventDef(rule.event);
  if (!def) return 'Unknown event';
  const v = def.filter ? rule.filter[def.filter.key] : undefined;
  return v ? `${def.label} · ${def.filter!.label.toLowerCase()}: ${options.find((o) => o.value === v)?.label ?? 'a deleted one'}` : def.label;
}

function RuleRow({rule, onEdit}: {rule: ScoreRule; onEdit: () => void}) {
  const toggle = useApiMutation((enabled: boolean) => api.patch(`/scoring/rules/${rule.id}`, {enabled}), {invalidate: [rulesKey, statusKey]});
  const remove = useApiMutation(() => api.del(`/scoring/rules/${rule.id}`), {invalidate: [rulesKey, statusKey], success: 'Rule deleted, scores are being recalculated'});
  const options = useFilterOptions(scoreEventDef(rule.event)?.filter?.kind);
  return (
    <Card className={cn('flex flex-col gap-3 p-4 sm:flex-row sm:items-start', !rule.enabled && 'opacity-70')}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={cn('flex h-10 min-w-12 shrink-0 items-center justify-center rounded-xl px-2 text-sm font-extrabold tabular-nums', rule.points < 0 ? 'bg-rose-50 text-rose-700' : 'bg-green-50 text-green-700')}>{points(rule.points)}</span>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="truncate text-sm font-semibold text-slate-900">{rule.name}</p>
          {rule.kind === 'property' ? (
            <RulesSummary rules={rule.rules} />
          ) : (
            <p className="text-xs text-muted-foreground">{behaviourText(rule, options)} · {limitLabel(rule).toLowerCase()}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {rule.kind === 'property' ? plural(rule.stats?.contacts ?? 0, 'contact matches', 'contacts match') + ' now' : `${plural(rule.stats?.awards30d ?? 0, 'time', 'times')} in the last 30 days`}
            {!rule.enabled && ' · off'}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={rule.enabled} disabled={toggle.isPending || remove.isPending} aria-busy={toggle.isPending || undefined} onCheckedChange={(v) => toggle.mutate(v)} aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} “${rule.name}”`} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={remove.isPending}><Button variant="ghost" size="icon-sm" pending={remove.isPending} aria-label={remove.isPending ? `Deleting ${rule.name}…` : `Actions for “${rule.name}”`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete “${rule.name}”?`, description: `Its points stop counting for every contact.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

type LimitMode = 'always' | 'once' | 'limited';

function RuleDialog({kind, rule, onClose}: {kind: ScoreRuleKind; rule: ScoreRule | null; onClose: () => void}) {
  const first = SCORE_EVENTS[0]!;
  const [name, setName] = useState(rule?.name ?? '');
  const [pts, setPts] = useState(String(rule?.points ?? (kind === 'behavior' ? first.suggested : 10)));
  const [rules, setRules] = useState<SegmentRules>(rule?.kind === 'property' ? rule.rules : emptyRules());
  const [event, setEvent] = useState(rule?.event ?? first.type);
  const [filter, setFilter] = useState<ScoreFilter>(rule?.filter ?? {});
  const [mode, setMode] = useState<LimitMode>(!rule?.limitCount ? 'always' : rule.limitCount === 1 && !rule.limitDays ? 'once' : 'limited');
  const [count, setCount] = useState(String(rule?.limitCount ?? 3));
  const [days, setDays] = useState(rule?.limitDays ? String(rule.limitDays) : '30');
  const def = scoreEventDef(event);
  const options = useFilterOptions(def?.filter?.kind);

  const save = useApiMutation(
    () => {
      const body =
        kind === 'property'
          ? {kind, name: name.trim(), points: Number(pts), rules}
          : {
              kind,
              name: name.trim() || def?.label,
              points: Number(pts),
              event,
              filter: def?.filter && filter[def.filter.key] ? {[def.filter.key]: filter[def.filter.key]} : {},
              limitCount: mode === 'always' ? null : mode === 'once' ? 1 : Math.max(1, Math.round(Number(count) || 1)),
              limitDays: mode === 'limited' && days ? Math.max(1, Math.round(Number(days))) : null,
            };
      return rule ? api.patch(`/scoring/rules/${rule.id}`, body) : api.post('/scoring/rules', body);
    },
    {invalidate: [rulesKey, statusKey], success: rule ? 'Rule saved' : 'Rule added', onSuccess: onClose},
  );

  const f = useFormState({name, pts, mode, count, days}, {
    name: [(v) => (kind === 'property' && !v.trim() ? 'Give the rule a name.' : null), is.maxLength(120)],
    pts: [is.required('Enter the points, like 10 or -5.'), is.number({min: -1000, max: 1000, integer: true, message: 'Use a whole number from -1000 to 1000.'}), (v) => (Number(v) === 0 ? 'Use a number other than 0.' : null)],
    count: [(v, all) => (all.mode === 'limited' ? is.required('Enter how many times it counts.')(v) || is.number({min: 1, max: 1000, integer: true, message: 'Use a whole number from 1 to 1000.'})(v) : null)],
    days: [(v, all) => (all.mode === 'limited' ? is.number({min: 1, max: 3650, integer: true, message: 'Use a whole number of days from 1 to 3650, or leave it empty for ever.'})(v) : null)],
  });
  const limitError = f.error('count') || f.error('days');

  const pickEvent = (type: string) => {
    const next = scoreEventDef(type);
    setEvent(type);
    setFilter({});
    if (!rule && next && (pts === '' || SCORE_EVENTS.some((e) => String(e.suggested) === pts))) setPts(String(next.suggested));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size={kind === 'property' ? 'lg' : 'md'}>
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{rule ? 'Edit rule' : kind === 'property' ? 'New property rule' : 'New behaviour rule'}</DialogTitle>
            <DialogDescription>
              {kind === 'property' ? 'Contacts get these points while they match the conditions, and lose them when they stop matching.' : 'Contacts get these points each time they do this, up to the limit you set.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label="Name" error={f.error('name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} placeholder={kind === 'property' ? 'e.g. Decision makers' : def?.label} maxLength={120} autoFocus />
              </Field>
              <Field label="Points" hint="Negative takes points off" error={f.error('pts')}>
                <Input type="number" inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} onBlur={f.blur('pts')} />
              </Field>
            </div>
            {kind === 'property' ? (
              <>
                <SegmentBuilder rules={rules} onChange={setRules} exclude={['score']} />
                <SegmentPreview rules={rules} />
                <DraftTest rules={rules} points={Number(pts) || 0} />
              </>
            ) : (
              <>
                <Field label="When the contact…">
                  <NativeSelect value={event} onChange={(e) => pickEvent(e.target.value)}>
                    {SCORE_EVENTS.map((e) => <option key={e.type} value={e.type}>{e.label}</option>)}
                  </NativeSelect>
                </Field>
                {def?.filter && (
                  <Field label={def.filter.label} hint="Leave on “any” to count all of them.">
                    <NativeSelect value={filter[def.filter.key] ?? ''} onChange={(e) => setFilter({[def.filter!.key]: e.target.value || undefined})}>
                      <option value="">any {def.filter.label.toLowerCase()}</option>
                      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </NativeSelect>
                  </Field>
                )}
                <Field label="How often it counts">
                  <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as LimitMode)}>
                    <option value="always">Every time</option>
                    <option value="once">Once per contact</option>
                    <option value="limited">A limited number of times…</option>
                  </NativeSelect>
                </Field>
                {mode === 'limited' && (
                  <div className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                      Up to
                      <Input className="h-9 w-20" type="number" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} onBlur={f.blur('count')} aria-label="Times" aria-invalid={f.invalid('count') || undefined} aria-describedby={limitError ? 'score-limit-error' : undefined} />
                      times per
                      <Input className="h-9 w-20" type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} onBlur={f.blur('days')} aria-label="Days" placeholder="ever" aria-invalid={f.invalid('days') || undefined} aria-describedby={limitError ? 'score-limit-error' : undefined} />
                      days
                    </div>
                    {limitError && <p id="score-limit-error" role="alert" className="text-xs font-medium text-destructive">{limitError}</p>}
                  </div>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel={rule ? 'Saving…' : 'Adding…'}>{rule ? 'Save rule' : 'Add rule'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Does one contact match the conditions being edited? */
function DraftTest({rules, points: pts}: {rules: SegmentRules; points: number}) {
  const [contactId, setContactId] = useState<string | null>(null);
  const json = JSON.stringify(rules);
  const test = useQuery({
    queryKey: [...keys.scoring, 'draft', contactId, json, pts],
    queryFn: () => api.post<ScoreTestResult>('/scoring/test', {contactId, draft: {rules: JSON.parse(json), points: pts}}),
    enabled: !!contactId,
    retry: false,
  });
  const d = test.data?.draft;
  return (
    <div className="grid gap-2 rounded-xl border border-slate-200 p-3">
      <p className="text-xs font-bold text-slate-800">Test on a contact</p>
      <SingleContactPicker onChange={setContactId} />
      {test.isFetching && <p className="text-xs text-muted-foreground">Checking…</p>}
      {d && !test.isFetching && (
        <p className="text-sm text-slate-700">
          {d.matches ? <>Matches: this rule gives {fullName(test.data!.contact)} <span className="font-bold">{points(d.points)}</span>.</> : `${fullName(test.data!.contact)} doesn't match, so this rule adds nothing.`}
        </p>
      )}
    </div>
  );
}

// ─── Bands, decay, notifications ───

const EMPTY_SETTINGS: ScoringSettings = {bands: [], decay: {mode: 'off', days: 30}, notify: 'up'};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'band';

function BandsSection() {
  const settings = useScoringSettings();
  const [edited, setDraft] = useState<ScoringSettings | null>(null);
  const draft = edited ?? settings.data ?? null;
  const save = useApiMutation(() => api.patch<{settings: ScoringSettings; recalculating: boolean}>('/scoring/settings', draft), {
    invalidate: scoreKeys,
    success: (r) => (r.recalculating ? 'Saved, recalculating scores' : 'Saved'),
    onSuccess: (r) => setDraft(r.settings),
  });
  const f = useFormState(draft ?? EMPTY_SETTINGS, {
    bands: [
      (bands) => (bands.some((b) => !b.name.trim()) ? 'Give every band a name.' : null),
      (bands) => (bands.some((b, i) => i > 0 && (b.min === null || !Number.isInteger(b.min) || Math.abs(b.min) > 100_000)) ? 'Give every band after the first a whole-number starting score.' : null),
    ],
    decay: [(d) => (d.mode !== 'off' && (!Number.isInteger(d.days) || d.days < 1 || d.days > 3650) ? 'Use a whole number of days from 1 to 3650.' : null)],
  });
  if (settings.isError && !draft) return <SettingsSection title="Bands & decay"><LoadError error={settings.error} onRetry={() => settings.refetch()} /></SettingsSection>;
  if (!draft) return null;
  const bandsError = f.error('bands');

  const setBand = (i: number, patch: Partial<ScoreBand>) => setDraft({...draft, bands: draft.bands.map((b, j) => (j === i ? {...b, ...patch} : b))});
  const addBand = () => {
    const top = Math.max(0, ...draft.bands.map((b) => b.min ?? 0));
    let key = 'band';
    for (let n = 2; draft.bands.some((b) => b.key === key); n++) key = `band-${n}`;
    setDraft({...draft, bands: [...draft.bands, {key, name: 'New band', min: top + 25, tone: 'violet'}]});
  };

  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))}>
    <SettingsSection
      title="Bands & decay"
      description="Bands are score ranges. Crossing into another band writes a timeline entry, notifies the contact owner and fires the “Lead score band changed” event for webhooks (and automations later). Lifecycle stages are never changed automatically."
      actions={<Button type="submit" size="sm" pending={save.isPending} pendingLabel="Saving…">Save</Button>}
    >
      <div className="grid gap-6">
        <div className="grid gap-2">
          {draft.bands.map((b, i) => (
            <div key={i} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-slate-200 p-2.5 sm:grid-cols-[minmax(0,1fr)_150px_140px_auto]">
              <Input
                value={b.name}
                onChange={(e) => setBand(i, {name: e.target.value, ...(settings.data?.bands.some((x) => x.key === b.key) ? {} : {key: slug(e.target.value)})})}
                aria-label="Band name"
                maxLength={30}
                onBlur={f.blur('bands')}
                aria-invalid={bandsError && !b.name.trim() ? true : undefined}
                aria-describedby={bandsError ? 'bands-error' : undefined}
              />
              {i === 0 ? (
                <span className="px-1 text-xs text-muted-foreground">Everything below the next band</span>
              ) : (
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  from
                  <Input type="number" inputMode="numeric" className="h-9" value={b.min ?? ''} onChange={(e) => setBand(i, {min: e.target.value === '' ? null : Math.round(Number(e.target.value))})} onBlur={f.blur('bands')} aria-label="Minimum score" aria-invalid={bandsError && (b.min === null || !Number.isInteger(b.min)) ? true : undefined} aria-describedby={bandsError ? 'bands-error' : undefined} />
                </label>
              )}
              <NativeSelect value={b.tone} onChange={(e) => setBand(i, {tone: e.target.value as ScoreBand['tone']})} aria-label="Colour">
                {BAND_TONES.map((t) => <option key={t} value={t}>{t === 'neutral' ? 'grey' : t}</option>)}
              </NativeSelect>
              <div className="flex items-center justify-end gap-2">
                <Badge tone={b.tone}><Flame /> {b.name || '…'}</Badge>
                <Button type="button" variant="ghost" size="icon-sm" disabled={draft.bands.length === 1} onClick={() => setDraft({...draft, bands: draft.bands.filter((_, j) => j !== i)})} aria-label="Remove band"><X /></Button>
              </div>
            </div>
          ))}
          {bandsError && <p id="bands-error" role="alert" className="text-xs font-medium text-destructive">{bandsError}</p>}
          {draft.bands.length < 8 && <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={addBand}><Plus /> Add band</Button>}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Field label="Decay" hint="Applies to behaviour points; property points last as long as the contact matches." error={f.error('decay')}>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect className="w-auto" value={draft.decay.mode} onChange={(e) => setDraft({...draft, decay: {...draft.decay, mode: e.target.value as ScoringSettings['decay']['mode']}})}>
                <option value="off">Points never expire</option>
                <option value="half">Points count half after</option>
                <option value="expire">Points expire after</option>
              </NativeSelect>
              {draft.decay.mode !== 'off' && (
                <span className="flex items-center gap-2 text-sm text-slate-600">
                  <Input type="number" inputMode="numeric" className="w-20" value={draft.decay.days} onChange={(e) => setDraft({...draft, decay: {...draft.decay, days: Math.max(1, Math.round(Number(e.target.value) || 1))}})} aria-label="Days" />
                  days
                </span>
              )}
            </div>
          </Field>
          <Field label="Notify the contact owner">
            <NativeSelect value={draft.notify} onChange={(e) => setDraft({...draft, notify: e.target.value as ScoringSettings['notify']})}>
              <option value="up">When a contact moves up a band</option>
              <option value="both">When a contact changes band (up or down)</option>
              <option value="off">Never</option>
            </NativeSelect>
          </Field>
        </div>
      </div>
    </SettingsSection>
    </form>
  );
}

// ─── Test on a contact ───

function TestSection() {
  const [contactId, setContactId] = useState<string | null>(null);
  const test = useQuery({
    queryKey: [...keys.scoring, 'test', contactId],
    queryFn: () => api.post<ScoreTestResult>('/scoring/test', {contactId}),
    enabled: !!contactId,
  });
  const t = test.data;
  return (
    <SettingsSection title="Test on a contact" description="See what every rule gives one contact right now, including rules that are switched off. Nothing is saved.">
      <div className="grid gap-4">
        <div className="max-w-md"><SingleContactPicker onChange={setContactId} /></div>
        {test.isFetching && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Scoring…</p>}
        {test.error && <p className="text-sm text-destructive">{(test.error as Error).message}</p>}
        {t && !test.isFetching && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-accent/50 p-4">
              <IconBadge tone="blue"><UserSearch /></IconBadge>
              <div className="min-w-0 flex-1">
                <Link to="/contacts/$contactId" params={{contactId: t.contact.id}} className="font-semibold text-slate-900 hover:text-primary">{fullName(t.contact)}</Link>
                <p className="text-xs text-muted-foreground">
                  Rules give {t.computed} now; the stored score is {t.stored}
                  {t.computed !== t.stored && ' (it updates on the next change or recalculation)'}.
                </p>
              </div>
              <ScoreBadge score={t.computed} />
            </div>
            {t.rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rules yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {t.rules.map((r) => (
                  <li key={r.ruleId} className={cn('flex items-center gap-3 px-3 py-2 text-sm', !r.enabled && 'opacity-60')}>
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{r.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {r.kind === 'property' ? (r.matches ? 'matches' : 'no match') : `${r.awards ?? 0}×`}
                      {!r.enabled && ' · off'}
                    </span>
                    <span className={cn('w-14 shrink-0 text-right font-bold tabular-nums', r.points < 0 ? 'text-rose-700' : r.points > 0 ? 'text-green-700' : 'text-slate-400')}>{r.points === 0 ? '0' : points(Math.round(r.points * 10) / 10)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
