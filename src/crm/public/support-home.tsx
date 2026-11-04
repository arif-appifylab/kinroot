import {CheckCircle2, LifeBuoy} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';

import {RichEditor} from '@/components/email-editor';
import {PublicCard} from '@/components/public-layout';
import {PortalNav, SignInPrompt, type PortalSession} from '@/components/tickets/portal';
import {Button} from '@/components/ui/button';
import {Field, Input, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {IconBadge} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {sendAttempt} from '@/lib/attempt';
import type {Brand} from '@/lib/brand';
import {useBrand} from '@/lib/use-brand';
import type {PortalConfig} from '../../server/crm/routes/support-public';
import {PublicPage} from './public-page';

/** /support: open a request; signed-in customers also see their requests (src/pages/support/index.astro). */
export default function SupportHomePage({config, brand}: {config: PortalConfig; brand: Brand}) {
  return (
    <PublicPage brand={brand}>
      <SupportHome config={config} />
    </PublicPage>
  );
}

function SupportHome({config}: {config: PortalConfig}) {
  const brand = useBrand();
  const [session, setSession] = useState<PortalSession | null>(null);
  const [form, setForm] = useState({name: '', email: '', subject: '', category: '', description: '', hp: ''});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const startedAt = useRef(Date.now());
  const f = useFormState(form, {
    name: [is.maxLength(120)],
    email: session ? [] : [is.required('Enter your email so we can reply.'), is.email(), is.maxLength(200)],
    subject: [is.required('Enter a short summary of your request.'), is.maxLength(300)],
  });

  useEffect(() => {
    if (config.enabled) api.get<{session: PortalSession | null}>('/public/support/me').then((r) => setSession(r.session)).catch(() => {});
  }, [config.enabled]);

  if (!config.enabled) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="slate" className="mx-auto"><LifeBuoy /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">Support portal unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">Please contact {brand.name} by email instead.</p>
      </PublicCard>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const {description, ...rest} = form;
      const payload = {
        ...rest,
        descriptionHtml: description,
        name: form.name || undefined,
        email: session ? undefined : form.email,
        category: form.category || undefined,
      };
      // One key per request sent: a retry after a lost answer opens no second request.
      const r = await sendAttempt(['support', payload], (headers) =>
        api.post<{signedIn: boolean; number?: number}>('/public/support/tickets', {...payload, startedAt: startedAt.current}, headers),
      );
      if (r.signedIn && r.number) window.location.assign(`/support/tickets/${r.number}`);
      else setDone(true);
    } catch (e) {
      if (!f.fail(e)) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <PublicCard className="text-center">
        <IconBadge tone="green" className="mx-auto"><CheckCircle2 /></IconBadge>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">We got your request</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a confirmation to <span className="font-semibold text-slate-700">{form.email}</span>. We'll answer by email; to follow it here, sign in (or create your account) with that address.
        </p>
      </PublicCard>
    );
  }

  const set = (patch: Partial<typeof form>) => setForm({...form, ...patch});
  return (
    <>
      <PortalNav session={session} />
      <PublicCard className="max-w-2xl sm:mt-4">
        <div className="flex items-start gap-3">
          <IconBadge><LifeBuoy /></IconBadge>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">How can {brand.name} help?</h1>
            {config.intro && <p className="mt-1 text-sm text-muted-foreground">{config.intro}</p>}
          </div>
        </div>
        <form {...f.form(() => !busy && void submit())} className="mt-6 grid gap-4">
          {!session && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Your name" htmlFor="sp-name" error={f.error('name')}><Input id="sp-name" autoComplete="name" value={form.name} onChange={(e) => set({name: e.target.value})} onBlur={f.blur('name')} /></Field>
              <Field label="Email" htmlFor="sp-email" error={f.error('email')}><Input id="sp-email" type="email" autoComplete="email" value={form.email} onChange={(e) => set({email: e.target.value})} onBlur={f.blur('email')} placeholder="you@example.com" /></Field>
            </div>
          )}
          <Field label="Subject" htmlFor="sp-subject" error={f.error('subject')}><Input id="sp-subject" maxLength={300} value={form.subject} onChange={(e) => set({subject: e.target.value})} onBlur={f.blur('subject')} placeholder="A short summary" /></Field>
          {config.categories.length > 0 && (
            <Field label="Topic" htmlFor="sp-cat">
              <NativeSelect id="sp-cat" value={form.category} onChange={(e) => set({category: e.target.value})}>
                <option value="">Choose a topic (optional)</option>
                {config.categories.map((c) => <option key={c}>{c}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field label="How can we help?">
            <RichEditor variant="text" compact minHeight={150} value={form.description} onChange={(description) => set({description})} ariaLabel="How can we help?" placeholder="Tell us what happened and what you expected." />
          </Field>
          {/* Honeypot: people never see it, bots fill it in. */}
          <input type="text" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" value={form.hp} onChange={(e) => set({hp: e.target.value})} />
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" pending={busy} pendingLabel="Sending…">Send request</Button>
          </div>
        </form>
      </PublicCard>
      {!session && (
        <PublicCard className="max-w-2xl sm:mt-6">
          <SignInPrompt title="Already contacted us?" intro="Sign in with the email you contacted us from to see your requests and reply to them." />
        </PublicCard>
      )}
    </>
  );
}
