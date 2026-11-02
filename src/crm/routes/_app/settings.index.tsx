import {useQueryClient} from '@tanstack/react-query';
import {createFileRoute, useRouter} from '@tanstack/react-router';
import {ImagePlus, Loader2, RotateCcw} from 'lucide-react';
import {useEffect, useState} from 'react';

import {TagInput} from '@/components/pickers';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {api} from '@/lib/api';
import {keys, useApiMutation, useMe, useSettings} from '@/lib/queries';
import {BRAND} from '@/lib/brand';
import type {AppSettings} from '@/lib/types';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/')({
  component: GeneralSettings,
});

const CURRENCIES = ['USD', 'EUR', 'GBP', 'BDT', 'INR', 'AUD', 'CAD', 'SGD', 'AED', 'JPY'];

function GeneralSettings() {
  const {isAdmin} = useMe();
  const qc = useQueryClient();
  const settings = useSettings();
  const [form, setForm] = useState<AppSettings | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data.settings);
  }, [settings.data, form]);

  const save = useApiMutation(
    () =>
      api.patch('/settings', {
        brandName: form!.brandName,
        brandLogo: form!.brandLogo,
        brandPrimary: form!.brandPrimary,
        brandSecondary: form!.brandSecondary,
        currency: form!.currency,
        recordVisibility: form!.recordVisibility,
        lostReasons: form!.lostReasons,
        sources: form!.sources,
        industries: form!.industries,
        companyTypes: form!.companyTypes,
        autoAssociateCompanies: form!.autoAssociateCompanies,
        autoCreateCompanies: form!.autoCreateCompanies,
      }),
    {
      invalidate: [keys.settings, keys.auth],
      success: 'Settings saved',
      // Reload the root loader so the new name, logo and colours apply everywhere.
      onSuccess: () => (qc.invalidateQueries({queryKey: keys.dashboard}), router.invalidate()),
    },
  );

  if (!form) return <Loader2 className="size-5 animate-spin text-primary" />;
  const disabled = !isAdmin;

  return (
    <form onSubmit={(e) => (e.preventDefault(), save.mutate(undefined))}>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <BrandingSection form={form} setForm={setForm} disabled={disabled} />

      <SettingsSection title="Defaults">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default currency" htmlFor="ws-cur">
            <NativeSelect id="ws-cur" disabled={disabled} value={form.currency} onChange={(e) => setForm({...form, currency: e.target.value})}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </NativeSelect>
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title="Record visibility" description="Who can see contacts, companies and deals.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {([
            ['everyone', 'Everyone sees everything', 'Best for small, collaborative teams.'],
            ['owner', 'Members see only their own', 'Admins still see all records. Good for territories.'],
          ] as const).map(([value, title, desc]) => (
            <label key={value} className={`cursor-pointer rounded-xl border p-4 transition-all ${form.recordVisibility === value ? 'border-primary bg-accent/60 ring-2 ring-primary/15' : 'border-border hover:border-slate-300'} ${disabled ? 'pointer-events-none opacity-70' : ''}`}>
              <input type="radio" name="vis" className="sr-only" checked={form.recordVisibility === value} onChange={() => setForm({...form, recordVisibility: value})} />
              <p className="text-sm font-semibold text-slate-900">{title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
            </label>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Company association" description="Link people to companies automatically from their work email domain (e.g. jane@acme.com → Acme). Personal addresses like Gmail are ignored.">
        <div className="grid gap-3">
          <label className="flex items-start gap-3">
            <Switch checked={form.autoAssociateCompanies} disabled={disabled} onCheckedChange={(v) => setForm({...form, autoAssociateCompanies: v})} className="mt-0.5" />
            <span>
              <span className="block text-sm font-semibold text-slate-800">Associate contacts with companies by email domain</span>
              <span className="block text-xs text-muted-foreground">New and imported contacts join the company that owns their domain; adding a domain to a company picks up existing contacts.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Switch checked={form.autoCreateCompanies} disabled={disabled || !form.autoAssociateCompanies} onCheckedChange={(v) => setForm({...form, autoCreateCompanies: v})} className="mt-0.5" />
            <span>
              <span className="block text-sm font-semibold text-slate-800">Create the company when none exists yet</span>
              <span className="block text-xs text-muted-foreground">e.g. a contact at northwind.io creates “Northwind” with that domain.</span>
            </span>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title="Lists" description="Options offered in dropdowns. New values typed into a dropdown are added here automatically.">
        <div className="grid gap-4">
          <Field label="Lead sources" htmlFor="ws-sources">
            <TagInput id="ws-sources" noun="source" lowercase={false} value={form.sources} onChange={(sources) => setForm({...form, sources})} />
          </Field>
          <Field label="Industries" htmlFor="ws-ind">
            <TagInput id="ws-ind" noun="industry" lowercase={false} value={form.industries} onChange={(industries) => setForm({...form, industries})} />
          </Field>
          <Field label="Company types" htmlFor="ws-types">
            <TagInput id="ws-types" noun="type" lowercase={false} value={form.companyTypes} onChange={(companyTypes) => setForm({...form, companyTypes})} />
          </Field>
          <Field label="Lost reasons" htmlFor="ws-lost" hint="Shown when a deal is marked lost.">
            <TagInput id="ws-lost" noun="reason" lowercase={false} value={form.lostReasons} onChange={(lostReasons) => setForm({...form, lostReasons})} />
          </Field>
        </div>
      </SettingsSection>

      {isAdmin && (
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save changes</Button>
        </div>
      )}
    </form>
  );
}

const PALETTES: {name: string; primary: string; secondary: string}[] = [
  {name: 'Ocean (default)', primary: '', secondary: ''},
  {name: 'Indigo', primary: '#4f46e5', secondary: '#7c3aed'},
  {name: 'Emerald', primary: '#059669', secondary: '#0891b2'},
  {name: 'Sunset', primary: '#ea580c', secondary: '#db2777'},
  {name: 'Berry', primary: '#be185d', secondary: '#7c3aed'},
  {name: 'Graphite', primary: '#334155', secondary: '#0f766e'},
];

/** Downscale an uploaded logo to at most 256px and return a data URL (SVGs are kept as-is). */
async function readLogo(file: File): Promise<string> {
  const asDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  if (file.type === 'image/svg+xml') {
    if (file.size > 200_000) throw new Error('SVG logos must be under 200 KB');
    return asDataUrl(file);
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Name, logo and colours: this is how a company makes the app its own. */
function BrandingSection({form, setForm, disabled}: {form: AppSettings; setForm: (f: AppSettings) => void; disabled: boolean}) {
  const [error, setError] = useState<string | null>(null);
  const primary = form.brandPrimary || BRAND.primary;
  const secondary = form.brandSecondary || BRAND.secondary;

  async function onLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      setForm({...form, brandLogo: await readLogo(file)});
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SettingsSection title="Branding" description="Your name, logo and colours appear in the app, on sign-in pages, emails and public pages.">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="grid gap-4">
          <Field label="Brand name" htmlFor="b-name" hint={`The template ships as "${BRAND.name}". Use your company or product name.`}>
            <Input id="b-name" disabled={disabled} value={form.brandName} onChange={(e) => setForm({...form, brandName: e.target.value})} />
          </Field>

          <Field label="Logo" error={error} hint="Square images work best. PNG, JPEG, WebP or SVG; resized to 256 px.">
            <div className="flex items-center gap-3">
              <label className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-slate-700 hover:border-slate-300', disabled && 'pointer-events-none opacity-60')}>
                <ImagePlus className="size-4" /> {form.brandLogo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" disabled={disabled} onChange={(e) => onLogo(e.target.files?.[0])} />
              </label>
              {form.brandLogo && (
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setForm({...form, brandLogo: ''})}><RotateCcw /> Use default mark</Button>
              )}
            </div>
          </Field>

          <div className="grid gap-2">
            <span className="text-sm font-semibold text-slate-700">Colours</span>
            <div className="flex flex-wrap gap-2">
              {PALETTES.map((p) => {
                const on = form.brandPrimary === p.primary && form.brandSecondary === p.secondary;
                return (
                  <button
                    key={p.name}
                    type="button"
                    disabled={disabled}
                    onClick={() => setForm({...form, brandPrimary: p.primary, brandSecondary: p.secondary})}
                    className={cn('inline-flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold transition-all', on ? 'border-primary bg-accent text-primary ring-2 ring-primary/15' : 'border-border text-slate-600 hover:border-slate-300')}
                  >
                    <span className="size-4 rounded-full" style={{background: `linear-gradient(135deg, ${p.primary || BRAND.primary}, ${p.secondary || BRAND.secondary})`}} />
                    {p.name}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-4 pt-1">
              {(['brandPrimary', 'brandSecondary'] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    type="color"
                    disabled={disabled}
                    value={form[k] || (k === 'brandPrimary' ? BRAND.primary : BRAND.secondary)}
                    onChange={(e) => setForm({...form, [k]: e.target.value})}
                    className="h-8 w-10 cursor-pointer rounded-md border border-border bg-card p-0.5"
                  />
                  {k === 'brandPrimary' ? 'Primary' : 'Gradient partner'}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="grid content-start gap-2">
          <span className="text-sm font-semibold text-slate-700">Preview</span>
          <div className="overflow-hidden rounded-xl border border-slate-100 shadow-soft">
            <div className="flex items-center gap-2.5 bg-sidebar px-4 py-3">
              {form.brandLogo ? (
                <img src={form.brandLogo} alt="" className="size-8 rounded-lg object-contain" />
              ) : (
                <span className="size-8 rounded-lg" style={{background: `linear-gradient(135deg, ${primary}, ${secondary})`}} />
              )}
              <span className="truncate text-sm font-extrabold text-white">{form.brandName || BRAND.name}</span>
            </div>
            <div className="grid gap-3 bg-card p-4">
              <span className="text-lg font-extrabold" style={{backgroundImage: `linear-gradient(135deg, ${primary}, ${secondary})`, WebkitBackgroundClip: 'text', color: 'transparent'}}>Good morning</span>
              <span className="inline-flex h-9 w-fit items-center rounded-lg px-4 text-sm font-semibold text-white" style={{background: `linear-gradient(135deg, ${primary}, ${secondary})`}}>Primary button</span>
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
