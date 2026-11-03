import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {ChevronDown, Download, History, LogIn, ScrollText, Settings2, ShieldAlert, ShieldCheck, Users} from 'lucide-react';
import {useState} from 'react';

import {Pagination, SearchInput} from '@/components/data-table';
import {FilterBar, FilterDateRange} from '@/components/filter-bar';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {SecurityEvents} from '@/components/site-admin/security-events';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/form';
import {EmptyState, IconBadge, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api, qs} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime} from '@/lib/format';
import {actionLabel, AUDIT_CATEGORIES, AUDIT_RETENTION_DAYS, ENTITY_LABELS, type AuditCategory} from '@/lib/hygiene';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {useSiteMe} from '@/lib/site-admin';
import type {AuditEntry, AuditResponse} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/audit')({
  head: () => ({meta: [{title: pageTitle('Audit log')}]}),
  component: AuditLogSettings,
});

type Filters = {actorId?: string; category?: string; action?: string; entity?: string; from?: string; to?: string; q?: string};

const CATEGORY_STYLE: Record<AuditCategory, {icon: typeof History; tone: 'blue' | 'teal' | 'violet' | 'amber' | 'slate' | 'rose'}> = {
  record: {icon: History, tone: 'blue'},
  auth: {icon: LogIn, tone: 'teal'},
  team: {icon: Users, tone: 'violet'},
  settings: {icon: Settings2, tone: 'slate'},
  export: {icon: Download, tone: 'amber'},
  security: {icon: ShieldAlert, tone: 'rose'},
};

const retentionLabel = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

/** "Chrome on macOS" from a user agent; good enough to tell devices apart. */
function device(ua: string | null) {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|axios|fetch/i.test(ua) ? 'Script' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? ua.slice(0, 40);
}

/** In-app link for the audited record, when it can still be opened. */
function recordLink(e: AuditEntry): string | null {
  if (!e.recordId || /\.(deleted|purged)$/.test(e.action)) return null;
  const paths: Record<string, string> = {contact: '/contacts/', company: '/companies/', deal: '/deals/', list: '/lists/', form: '/forms/', booking_link: '/meetings/links/'};
  return paths[e.entity ?? ''] ? `${paths[e.entity!]}${e.recordId}` : null;
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function MetaView({meta}: {meta: Record<string, unknown>}) {
  const {changes, ...rest} = meta as {changes?: {field: string; from: unknown; to: unknown}[]} & Record<string, unknown>;
  return (
    <div className="mt-2 grid gap-1.5 rounded-xl bg-slate-50 p-3 text-xs">
      {Array.isArray(changes) &&
        changes.map((ch) => (
          <div key={ch.field} className="grid grid-cols-1 gap-1 sm:grid-cols-[140px_minmax(0,1fr)]">
            <span className="font-semibold text-slate-600">{ch.field}</span>
            <span className="min-w-0 break-words text-slate-700">
              <span className="text-slate-500 line-through decoration-slate-300">{show(ch.from)}</span> → <span className="font-medium">{show(ch.to)}</span>
            </span>
          </div>
        ))}
      {Object.entries(rest).map(([k, v]) => (
        <div key={k} className="grid grid-cols-1 gap-1 sm:grid-cols-[140px_minmax(0,1fr)]">
          <span className="font-semibold text-slate-600">{k}</span>
          <span className="min-w-0 font-mono break-words text-slate-700">{show(v)}</span>
        </div>
      ))}
    </div>
  );
}

/** Imports and exports in words, plus their files while they are kept. */
function IoSummary({entry: e, live}: {entry: AuditEntry; live: Set<string>}) {
  const m = e.meta as Record<string, unknown>;
  const n = (k: string) => (typeof m[k] === 'number' ? (m[k] as number).toLocaleString() : null);
  const parts = e.action.startsWith('import.')
    ? [m.object, n('rows') && `${n('rows')} rows`, n('created') && `${n('created')} created`, n('updated') && `${n('updated')} updated`, n('skipped') && `${n('skipped')} skipped`, m.errors ? `${n('errors')} with errors` : null]
    : [m.object, n('rows') && `${n('rows')} rows`, Array.isArray(m.columns) && `${m.columns.length} columns`, m.filters && Object.keys(m.filters as object).length ? `filters: ${Object.entries(m.filters as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join(', ')}` : 'no filters', m.emailed ? 'emailed' : null];
  const file = typeof m.fileId === 'string' && live.has(m.fileId) ? m.fileId : null;
  const errors = typeof m.errorFileId === 'string' && live.has(m.errorFileId) ? m.errorFileId : null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-600">
      <span>{parts.filter(Boolean).join(' · ')}</span>
      {file && <a className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" href={`/site-api/crm/files/${file}?download=1`}><Download className="size-3" /> Download file</a>}
      {errors && <a className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" href={`/site-api/crm/files/${errors}?download=1`}><Download className="size-3" /> Download errors</a>}
    </p>
  );
}

function AuditRow({entry: e, live}: {entry: AuditEntry; live: Set<string>}) {
  const [open, setOpen] = useState(false);
  const style = CATEGORY_STYLE[e.category as AuditCategory] ?? CATEGORY_STYLE.record;
  const failed = e.action === 'auth.login_failed';
  const Icon = failed ? ShieldAlert : style.icon;
  const hasMeta = Object.keys(e.meta ?? {}).length > 0;
  const link = recordLink(e);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <IconBadge tone={failed ? 'rose' : style.tone} className="size-8 rounded-lg [&_svg]:size-4"><Icon /></IconBadge>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{e.actorName ?? e.actorEmail ?? 'System'}</span>
            <span className="mx-1.5 text-slate-300">·</span>
            <span className={cn(failed && 'font-semibold text-rose-600')}>{actionLabel(e.action)}</span>
            {e.label && (
              <>
                <span className="mx-1.5 text-slate-300">·</span>
                {link ? <Link to={link as '/'} className="font-medium text-slate-900 hover:text-primary hover:underline">{e.label}</Link> : <span className="font-medium text-slate-900">{e.label}</span>}
              </>
            )}
          </p>
          {/^(import|export)\.(completed|failed|canceled)$/.test(e.action) && <IoSummary entry={e} live={live} />}
          <p className="mt-0.5 text-xs text-muted-foreground">
            <time dateTime={e.createdAt} title={dateTime(e.createdAt)}>{ago(e.createdAt)}</time>
            {e.ip && <> · {e.ip}</>}
            {e.userAgent && <> · {device(e.userAgent)}</>}
            {e.actorEmail && e.actorName && <> · {e.actorEmail}</>}
          </p>
        </div>
        {hasMeta && (
          <Button variant="ghost" size="icon-sm" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)}>
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
        )}
      </div>
      {open && <div className="pl-11"><MetaView meta={e.meta} /></div>}
    </div>
  );
}

type AuditTab = 'crm' | 'security';

/**
 * Two logs, two gates. "CRM activity" is Kinroot's own log (team Owners and Admins). "Sign-in &
 * security" is the site's `audit_events` (sign-ups, sign-ins, password, two-step and role changes,
 * blocked accounts), read from `/site-api/admin/audit` and shown to whoever holds the SITE
 * permission site:audit:read, as the template's Activity screen was.
 */
function AuditLogSettings() {
  const {isAdmin} = useMe();
  const site = useSiteMe();
  const canSecurity = Boolean(site.abilities?.readAudit);
  const [picked, setPicked] = useState<AuditTab | null>(null);
  const tab: AuditTab = picked ?? (isAdmin || !canSecurity ? 'crm' : 'security');

  if (!canSecurity) return <CrmAuditLog />;
  return (
    <Tabs value={tab} onValueChange={(v) => setPicked(v as AuditTab)}>
      <TabsList className="mb-4" aria-label="Which log">
        <TabsTrigger value="crm">
          <History /> CRM activity
        </TabsTrigger>
        <TabsTrigger value="security">
          <ShieldCheck /> Sign-in &amp; security
        </TabsTrigger>
      </TabsList>
      <TabsContent value="crm">
        <CrmAuditLog />
      </TabsContent>
      <TabsContent value="security">
        <SettingsSection title="Sign-in & security" description="Everyone with an account on this site, team and support customers: sign-ups, sign-ins with a code or from the platform, password and email changes, two-step sign-in, role changes, blocked accounts and refused sign-in tokens.">
          <SecurityEvents />
        </SettingsSection>
      </TabsContent>
    </Tabs>
  );
}

function CrmAuditLog() {
  const {isAdmin} = useMe();
  const team = useTeam();
  const [f, setF] = useState<Filters>({});
  const [qDraft, setQDraft] = useState('');
  const [page, setPage] = useState(1);
  const params = {...f, page, pageSize: 50};
  const list = useQuery({queryKey: [...keys.audit, params], queryFn: () => api.get<AuditResponse>('/audit', params), enabled: isAdmin, placeholderData: keepPreviousData});
  const retention = useApiMutation((retentionDays: number) => api.put('/audit/settings', {retentionDays}), {invalidate: [keys.audit], success: 'Retention saved'});
  const set = (patch: Filters) => (setF((x) => ({...x, ...patch})), setPage(1));
  const filtered = Object.values(f).some(Boolean);

  if (!isAdmin) {
    return (
      <SettingsSection title="Audit log">
        <AdminOnly />
      </SettingsSection>
    );
  }

  const data = list.data;
  return (
    <SettingsSection
      title="Audit log"
      description={`Who did what, when and from where: record changes, sign-ins, team and settings changes, imports and exports (with their files for 7 days) and secrets. Entries are kept for ${retentionLabel(data?.settings.retentionDays ?? 365)}.`}
      actions={
        <>
          <NativeSelect size="sm" aria-label="Keep entries for" value={data?.settings.retentionDays ?? 365} onChange={(e) => retention.mutate(Number(e.target.value))}>
            {AUDIT_RETENTION_DAYS.map((d) => <option key={d} value={d}>Keep {retentionLabel(d)}</option>)}
          </NativeSelect>
          <Button variant="secondary" size="sm" asChild><a href={`/site-api/crm/audit/export.csv${qs(f)}`}><Download /> Export CSV</a></Button>
        </>
      }
    >
      <FilterBar className="mb-4" active={filtered} onClear={() => (setF({}), setQDraft(''), setPage(1))}>
        <form onSubmit={(e) => (e.preventDefault(), set({q: qDraft || undefined}))} className="contents">
          <SearchInput size="sm" value={qDraft} onChange={(v) => (setQDraft(v), !v && set({q: undefined}))} placeholder="Search record, person, IP…" />
        </form>
        <NativeSelect size="sm" aria-label="User" value={f.actorId ?? ''} onChange={(e) => set({actorId: e.target.value || undefined})}>
          <option value="">Anyone</option>
          {team.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Kind" value={f.category ?? ''} onChange={(e) => set({category: e.target.value || undefined, action: undefined})}>
          <option value="">Every kind</option>
          {Object.entries(AUDIT_CATEGORIES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Action" value={f.action ?? ''} onChange={(e) => set({action: e.target.value || undefined})}>
          <option value="">Any action</option>
          {data?.actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Record type" value={f.entity ?? ''} onChange={(e) => set({entity: e.target.value || undefined})}>
          <option value="">Any record type</option>
          {Object.entries(ENTITY_LABELS).map(([k, label]) => <option key={k} value={k}>{label[0]!.toUpperCase() + label.slice(1)}</option>)}
        </NativeSelect>
        <FilterDateRange from={f.from} to={f.to} onChange={set} />
      </FilterBar>

      {list.isLoading && <div className="grid gap-3">{Array.from({length: 5}, (_, i) => <Skeleton key={i} className="h-12" />)}</div>}
      {data && data.rows.length === 0 && (
        <EmptyState icon={<ScrollText />} title={filtered ? 'Nothing matches these filters' : 'No entries yet'} description="Changes, sign-ins and exports show up here as they happen." />
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="divide-y divide-slate-100">{data.rows.map((e) => <AuditRow key={e.id} entry={e} live={new Set(data.liveFiles ?? [])} />)}</div>
          <div className="-mx-5 -mb-5 mt-4"><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
        </>
      )}
      {data && <p className="mt-4 text-xs text-muted-foreground"><Badge tone="neutral">{data.total}</Badge> {data.total === 1 ? 'entry' : 'entries'}{filtered ? ' match' : ' in total'}. Times are shown in your time zone; the CSV uses UTC.</p>}
    </SettingsSection>
  );
}
