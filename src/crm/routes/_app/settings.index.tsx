import {useQueryClient} from '@tanstack/react-query';
import {createFileRoute, useRouter} from '@tanstack/react-router';
import {ImagePlus, Loader2, RotateCcw} from 'lucide-react';
import {useEffect, useState} from 'react';

import {TagInput} from '@/components/pickers';
import {LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {api} from '@/lib/api';
import {uploadFile} from '@/lib/upload';
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

  const f = useFormState((form ?? {brandName: ''}) as AppSettings, {
    brandName: [is.required('Enter your company or product name.'), is.maxLength(60)],
  });

  if (settings.isError && !form) return <LoadError error={settings.error} onRetry={() => settings.refetch()} />;
  if (!form) return <Loader2 className="size-5 animate-spin text-primary" />;
  const disabled = !isAdmin;

  return (
    <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))}>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <BrandingSection form={form} setForm={setForm} disabled={disabled} nameError={f.error('brandName')} onNameBlur={f.blur('brandName')} logoError={f.error('brandLogo')} />

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
            <label key={value} className={`cursor-pointer rounded-xl border p-4 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40 ${form.recordVisibility === value ? 'border-primary bg-accent/60 ring-2 ring-primary/15' : 'border-border hover:border-slate-300'} ${disabled ? 'pointer-events-none opacity-70' : ''}`}>
              <input type="radio" name="vis" className="sr-only" disabled={disabled} checked={form.recordVisibility === value} onChange={() => setForm({...form, recordVisibility: value})} />
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
          <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save changes</Button>
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

/** SVG logos stay in the settings as a data URL (storage only offers SVG as a download); the server allows 60 KB. */
const SVG_LOGO_MAX = 60 * 1024;

/**
 * The logo to save: an SVG as a data URL (up to 60 KB), any other image downscaled to at most 256px,
 * uploaded as a PUBLIC storage file (POST /files/public, docs/agent/files.md) and saved as its link.
 */
async function readLogo(file: File): Promise<string> {
  if (file.type === 'image/svg+xml') {
    if (file.size > SVG_LOGO_MAX) throw new Error('SVG logos can be up to 60 KB. Use a smaller SVG, or a PNG.');
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be read. Use a PNG, JPEG, WebP or SVG file.');
  });
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('That image could not be read. Use a PNG, JPEG, WebP or SVG file.');
  const {url} = await uploadFile<{url: string | null}>('/files/public', new File([png], 'logo.png', {type: 'image/png'}));
  if (!url) throw new Error('The logo was uploaded but has no public link yet. Please try again.');
  return url;
}

/** Name, logo and colours: this is how a company makes the app its own. */
function BrandingSection({form, setForm, disabled, nameError, onNameBlur, logoError}: {form: AppSettings; setForm: (f: AppSettings) => void; disabled: boolean; nameError?: string; onNameBlur?: () => void; logoError?: string}) {
  const [uploadError, setError] = useState<string | null>(null);
  // The upload's own problem, else the server's (a logo it can't use lands here on save).
  const error = uploadError ?? logoError ?? null;
  const primary = form.brandPrimary || BRAND.primary;
  const secondary = form.brandSecondary || BRAND.secondary;

  const [uploading, setUploading] = useState(false);

  async function onLogo(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again after an error
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      setForm({...form, brandLogo: await readLogo(file)});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <SettingsSection title="Branding" description="Your name, logo and colours appear in the app, on sign-in pages, emails and public pages.">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="grid gap-4">
          <Field label="Brand name" htmlFor="b-name" error={nameError} hint={`Shown across the app, sign-in pages, emails and public pages (the default is "${BRAND.name}"). Use your company or product name.`}>
            <Input id="b-name" disabled={disabled} value={form.brandName} onChange={(e) => setForm({...form, brandName: e.target.value})} onBlur={onNameBlur} />
          </Field>

          <Field label="Logo" htmlFor="b-logo" error={error} hint="Square images work best. PNG, JPEG or WebP (resized to 256 px), or an SVG up to 60 KB. Saved with the settings.">
            <div className="flex items-center gap-3">
              <label aria-busy={uploading || undefined} className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-slate-700 hover:border-slate-300', (disabled || uploading) && 'pointer-events-none opacity-60')}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} {uploading ? 'Uploading…' : form.brandLogo ? 'Replace logo' : 'Upload logo'}
                <input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" disabled={disabled || uploading} aria-invalid={error ? true : undefined} aria-describedby={error ? 'b-logo-error' : 'b-logo-hint'} onChange={(e) => onLogo(e.currentTarget)} />
              </label>
              {form.brandLogo && (
                <Button type="button" variant="ghost" size="sm" disabled={disabled || uploading} onClick={() => setForm({...form, brandLogo: ''})}><RotateCcw /> Use default mark</Button>
              )}
            </div>
          </Field>

          <div className="grid gap-2">
            <span id="b-colours" className="text-sm font-semibold text-slate-700">Colours</span>
            <div role="group" aria-labelledby="b-colours" className="flex flex-wrap gap-2">
              {PALETTES.map((p) => {
                const on = form.brandPrimary === p.primary && form.brandSecondary === p.secondary;
                return (
                  <button
                    key={p.name}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    onClick={() => setForm({...form, brandPrimary: p.primary, brandSecondary: p.secondary})}
                    className={cn('inline-flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed', on ? 'border-primary bg-accent text-primary ring-2 ring-primary/15' : 'border-border text-slate-600 hover:border-slate-300')}
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
