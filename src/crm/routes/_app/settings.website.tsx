import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {ExternalLink, Loader2} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';

import {LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Field, NativeSelect, Switch} from '@/components/ui/form';
import {useFormState} from '@/components/ui/form-state';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {cn} from '@/lib/utils';
import type {WebsiteSettings} from '@/lib/website';

export const Route = createFileRoute('/_app/settings/website')({
  head: () => ({meta: [{title: pageTitle('Website settings')}]}),
  component: WebsiteSettingsPage,
});

type Response = {
  settings: WebsiteSettings;
  forms: {id: string; name: string; slug: string}[];
  links: {id: string; name: string; path: string; minutes: number}[];
};

const QUERY = [...keys.settings, 'website'] as const;

function Toggle({label, hint, checked, onChange}: {label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function WebsiteSettingsPage() {
  const {isAdmin} = useMe();
  const q = useQuery({queryKey: QUERY, queryFn: () => api.get<Response>('/website/settings'), enabled: isAdmin});
  const [form, setForm] = useState<WebsiteSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);
  const save = useApiMutation(() => api.put<{settings: WebsiteSettings}>('/website/settings', form), {invalidate: [QUERY, ['website']], success: 'Website saved', onSuccess: (r) => setForm(r.settings)});
  // Both choices come from lists, so only the server can find them wrong (a form unpublished meanwhile).
  const f = useFormState((form ?? {}) as WebsiteSettings);

  if (!isAdmin) return <AdminOnly />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!form || !q.data) return <Loader2 className="size-5 animate-spin text-primary" />;
  const set = (patch: Partial<WebsiteSettings>) => setForm({...form, ...patch});
  const {forms, links} = q.data;

  return (
    <form {...f.form(() => !save.isPending && save.mutate(undefined, {onError: f.fail}))} className="min-w-0">
      <SettingsSection
        title="Website"
        description={<>Your public website: the home page at <code>/</code>, <code>/contact/</code> and <code>/demo/</code>. The team works in the app at <code>/crm/</code>. Name, logo and colours come from Branding; the page copy is edited by prompting.</>}
        actions={
          <Button type="button" variant="secondary" size="sm" asChild>
            <a href="/" target="_blank" rel="noopener noreferrer"><ExternalLink /> View website</a>
          </Button>
        }
      >
        <Toggle
          label="Show the website"
          hint={form.enabled ? 'On: everyone sees the home page at /, with a Sign in link for your team.' : 'Off: / goes to the app (sign-in when signed out) and the pages say they are unavailable.'}
          checked={form.enabled}
          onChange={(enabled) => set({enabled})}
        />
      </SettingsSection>

      <SettingsSection title="Pages" description="What Contact us and Book a demo show. Every response and booking lands in the CRM with its contact.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Contact us form" htmlFor="ws-form" error={f.error('contactFormId')} hint={forms.length ? <>The website’s own Contact us form is made for you; edit its questions in <Link to="/forms" className="font-semibold text-primary hover:underline">Forms</Link>.</> : undefined}>
            {forms.length ? (
              <NativeSelect id="ws-form" value={form.contactFormId ?? ''} onChange={(e) => set({contactFormId: e.target.value || null})}>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </NativeSelect>
            ) : (
              <p className="text-sm text-muted-foreground">No published form yet: <Link to="/forms" className="font-semibold text-primary hover:underline">publish one in Forms</Link>.</p>
            )}
          </Field>
          <Field label="Book a demo calendar" htmlFor="ws-link" error={f.error('demoLinkId')} hint={links.length ? <>A team “Product demo” link is made for you (admins host it); change hours and hosts in <Link to="/meetings" className="font-semibold text-primary hover:underline">Meetings</Link>.</> : undefined}>
            {links.length ? (
              <NativeSelect id="ws-link" value={form.demoLinkId ?? ''} onChange={(e) => set({demoLinkId: e.target.value || null})}>
                {links.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.minutes} min</option>)}
              </NativeSelect>
            ) : (
              <p className="text-sm text-muted-foreground">No active booking link yet: <Link to="/meetings" className="font-semibold text-primary hover:underline">create one in Meetings</Link>.</p>
            )}
          </Field>
        </div>
        <div className={cn('mt-5 grid gap-4 border-t border-slate-100 pt-5')}>
          <Toggle label="Chat bubble on the pages" hint={<>Only shows while website chat is on in <Link to="/settings/inbox/chat" className="font-semibold text-primary hover:underline">Settings → Inbox → Chat</Link>.</>} checked={form.showChat} onChange={(showChat) => set({showChat})} />
          <Toggle label="Support link in the menu" hint={<>Links to the support portal while it is on in <Link to="/settings/tickets" className="font-semibold text-primary hover:underline">Settings → Tickets</Link>.</>} checked={form.showSupport} onChange={(showSupport) => set({showSupport})} />
        </div>
      </SettingsSection>

      <div className="flex justify-end">
        <Button type="submit" pending={save.isPending} pendingLabel="Saving…">
          Save website
        </Button>
      </div>
    </form>
  );
}
