import {useQueryClient} from '@tanstack/react-query';
import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ArrowRight, Loader2} from 'lucide-react';
import {useEffect, useState} from 'react';

import {AuthLayout} from '@/components/auth-layout';
import {Button} from '@/components/ui/button';
import {Checkbox, Field, Input, Label} from '@/components/ui/form';
import {BRAND, pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {keys, useAuth} from '@/lib/queries';

export const Route = createFileRoute('/setup')({
  head: () => ({meta: [{title: pageTitle('Set up')}]}),
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const auth = useAuth();
  const [form, setForm] = useState({brandName: BRAND.name as string, demoData: true});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.data && !auth.data.needsSetup) navigate({to: auth.data.user ? '/' : '/no-access'});
  }, [auth.data, navigate]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({...f, [k]: e.target.value}));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/setup', form);
      await qc.invalidateQueries({queryKey: keys.auth});
      navigate({to: '/'});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Let's set up" highlight="your CRM" subtitle="One minute and you're in. You are the owner and can invite your team right after.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Brand name" htmlFor="ws" hint="Shown across the app, emails and public pages. Change it, the logo and colours any time in Settings → Branding." error={error}>
          <Input id="ws" required value={form.brandName} onChange={set('brandName')} placeholder="Your company or product name" />
        </Field>
        <div className="flex items-start gap-3 rounded-xl bg-accent/70 p-3">
          <Checkbox id="demo" checked={form.demoData} onCheckedChange={(v) => setForm((f) => ({...f, demoData: v === true}))} className="mt-0.5" />
          <Label htmlFor="demo" className="grid gap-0.5 font-normal">
            <span className="font-semibold text-slate-800">Add sample data</span>
            <span className="text-xs text-muted-foreground">A few companies, contacts and deals so you can explore. Delete them any time.</span>
          </Label>
        </div>
        <Button type="submit" size="lg" className="group mt-1 w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Get started
          <ArrowRight className="transition-transform group-hover:translate-x-1" />
        </Button>
      </form>
    </AuthLayout>
  );
}
