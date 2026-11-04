import {ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronUp, Loader2, Paperclip, Star, Upload, X} from 'lucide-react';
import {useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';

import {
  activeFields,
  isInput,
  pickEnding,
  validateField,
  visiblePages,
  type AnswerValue,
  type Answers,
  type Ending,
  type FormField,
  type FormSettings,
  type PublicForm,
} from '@/lib/forms';
import {cn} from '@/lib/utils';

import {BookingSlotField} from '../booking/slot-field';
import {Button} from '../ui/button';
import {Checkbox, Input, NativeSelect, Textarea} from '../ui/form';
import {siteFetch} from '../../../platform/browser';
import {sendAttempt} from '@/lib/attempt';
import {putFile, type UploadGrant} from '../../../platform/files-browser';

type Uploaded = {id: string; name: string; size: number; token?: string};
type UploadFn = (field: FormField, file: File) => Promise<Uploaded>;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Accent colour → the tokens buttons, rings and highlights use. */
export const accentStyle = (accent?: string): CSSProperties | undefined =>
  accent ? ({'--primary': accent, '--secondary': accent, '--ring': accent} as CSSProperties) : undefined;

// ─── One field ──────────────────────────────────────────────────────────────

export function FieldControl({
  field: f,
  value,
  onChange,
  error,
  big,
  autoFocus,
  upload,
  onEnter,
}: {
  field: FormField;
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue) => void;
  error?: string;
  big?: boolean;
  autoFocus?: boolean;
  upload?: UploadFn;
  onEnter?: () => void;
}) {
  const inputCls = cn(big && 'h-12 text-base');
  const id = `fld_${f.id}`;
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && onEnter && !(e.nativeEvent as KeyboardEvent).isComposing) {
      e.preventDefault();
      onEnter();
    }
  };

  switch (f.type) {
    case 'heading':
      return null;
    case 'name': {
      const v = (value as {first?: string; last?: string} | null) ?? {};
      // Each part has its own visible label (AUDIT-2 L-16); the question's label names the first part.
      const wire = {'aria-invalid': !!error, 'aria-describedby': error ? `${id}_error` : undefined};
      return (
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <SubField label="First name" htmlFor={id} labelId={`${id}_first`}>
            <Input id={id} autoFocus={autoFocus} className={inputCls} autoComplete="given-name" value={v.first ?? ''} onChange={(e) => onChange({...v, first: e.target.value} as AnswerValue)} onKeyDown={enter} aria-labelledby={`${id}_label ${id}_first`} {...wire} />
          </SubField>
          <SubField label="Last name" htmlFor={`${id}_last`}>
            <Input id={`${id}_last`} className={inputCls} autoComplete="family-name" value={v.last ?? ''} onChange={(e) => onChange({...v, last: e.target.value} as AnswerValue)} onKeyDown={enter} {...wire} />
          </SubField>
        </div>
      );
    }
    case 'address': {
      const v = (value as Record<string, string> | null) ?? {};
      const set = (k: string, x: string) => onChange({...v, [k]: x});
      const wire = {'aria-invalid': !!error, 'aria-describedby': error ? `${id}_error` : undefined};
      return (
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <SubField label="Street address" htmlFor={id} labelId={`${id}_street`} className="@md:col-span-2">
            <Input id={id} autoFocus={autoFocus} className={inputCls} autoComplete="street-address" value={v.street ?? ''} onChange={(e) => set('street', e.target.value)} aria-labelledby={`${id}_label ${id}_street`} {...wire} />
          </SubField>
          <SubField label="City" htmlFor={`${id}_city`}>
            <Input id={`${id}_city`} className={inputCls} autoComplete="address-level2" value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} {...wire} />
          </SubField>
          <SubField label="State / region" htmlFor={`${id}_state`}>
            <Input id={`${id}_state`} className={inputCls} autoComplete="address-level1" value={v.state ?? ''} onChange={(e) => set('state', e.target.value)} {...wire} />
          </SubField>
          <SubField label="Postal code" htmlFor={`${id}_postalCode`}>
            <Input id={`${id}_postalCode`} className={inputCls} autoComplete="postal-code" value={v.postalCode ?? ''} onChange={(e) => set('postalCode', e.target.value)} {...wire} />
          </SubField>
          <SubField label="Country" htmlFor={`${id}_country`}>
            <Input id={`${id}_country`} className={inputCls} autoComplete="country-name" value={v.country ?? ''} onChange={(e) => set('country', e.target.value)} onKeyDown={enter} {...wire} />
          </SubField>
        </div>
      );
    }
    case 'long_text':
      return (
        <Textarea
          id={id}
          autoFocus={autoFocus}
          rows={big ? 4 : 4}
          className={cn(big && 'text-base')}
          placeholder={f.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && onEnter?.()}
          aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined}
        />
      );
    case 'dropdown':
      return (
        <NativeSelect id={id} autoFocus={autoFocus} className={inputCls} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined}>
          <option value="">{f.placeholder || 'Select…'}</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </NativeSelect>
      );
    case 'single_choice':
    case 'multiple_choice': {
      const multi = f.type === 'multiple_choice';
      const selected = multi ? ((value as string[]) ?? []) : value ? [value as string] : [];
      return (
        <div id={id} tabIndex={-1} role={multi ? 'group' : 'radiogroup'} aria-labelledby={`${id}_label`} aria-describedby={error ? `${id}_error` : undefined} className={cn('grid gap-2 outline-none', !big && (f.options?.length ?? 0) > 4 && '@md:grid-cols-2')}>
          {f.options?.map((o, i) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                onClick={() => onChange(multi ? (on ? selected.filter((x) => x !== o) : [...selected, o]) : on ? null : o)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-all',
                  big && 'py-3 text-base',
                  on ? 'border-primary bg-primary/[0.07] text-slate-900 ring-1 ring-primary' : 'border-slate-200 bg-card text-slate-700 hover:border-primary/50',
                )}
              >
                <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold', on ? 'border-primary bg-primary text-white' : 'border-slate-300 text-slate-500', !multi && 'rounded-full')}>
                  {on ? <Check className="size-3.5" strokeWidth={3} /> : big ? LETTERS[i] : ''}
                </span>
                <span className="min-w-0 flex-1">{o}</span>
              </button>
            );
          })}
        </div>
      );
    }
    case 'yes_no':
      return (
        <div id={id} tabIndex={-1} className="flex gap-2 outline-none" role="radiogroup" aria-labelledby={`${id}_label`} aria-describedby={error ? `${id}_error` : undefined}>
          {(['yes', 'no'] as const).map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={value === o}
              onClick={() => onChange(value === o ? null : o)}
              className={cn(
                'min-w-24 cursor-pointer rounded-xl border px-5 py-2.5 text-sm font-semibold transition-all',
                big && 'py-3 text-base',
                value === o ? 'border-primary bg-primary/[0.07] text-slate-900 ring-1 ring-primary' : 'border-slate-200 bg-card text-slate-700 hover:border-primary/50',
              )}
            >
              {o === 'yes' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      );
    case 'consent':
      return (
        <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-card px-3 py-3 text-sm text-slate-700">
          <Checkbox id={id} className="mt-0.5" checked={value === true} onCheckedChange={(v) => onChange(v === true)} aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined} />
          <span className="leading-relaxed">
            {f.label}
            {f.required && <span className="text-destructive"> *</span>}
          </span>
        </label>
      );
    case 'rating':
      return <Rating id={id} error={error} scale={f.scale ?? 5} value={(value as number) ?? 0} onChange={onChange} big={big} />;
    case 'file':
      return <FileField field={f} value={(value as Uploaded[]) ?? []} onChange={onChange} upload={upload} />;
    case 'booking':
      return <BookingSlotField field={f} value={value} onChange={onChange} />;
    case 'number':
      return <Input id={id} autoFocus={autoFocus} className={inputCls} type="number" inputMode="decimal" min={f.min} max={f.max} placeholder={f.placeholder} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} onKeyDown={enter} aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined} />;
    case 'date':
      return <Input id={id} autoFocus={autoFocus} className={cn(inputCls, 'w-auto')} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} onKeyDown={enter} aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined} />;
    default: {
      const type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'website' ? 'url' : 'text';
      const auto = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'company' ? 'organization' : f.type === 'website' ? 'url' : undefined;
      return <Input id={id} autoFocus={autoFocus} className={inputCls} type={type} autoComplete={auto} placeholder={f.placeholder} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} aria-invalid={!!error} aria-describedby={error ? `${id}_error` : undefined} />;
    }
  }
}

function Rating({id, error, scale, value, onChange, big}: {id: string; error?: string; scale: number; value: number; onChange: (v: AnswerValue) => void; big?: boolean}) {
  const [hover, setHover] = useState(0);
  return (
    <div id={id} tabIndex={-1} className="flex flex-wrap gap-1 outline-none" role="radiogroup" aria-labelledby={`${id}_label`} aria-describedby={error ? `${id}_error` : undefined} onMouseLeave={() => setHover(0)}>
      {Array.from({length: scale}, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of ${scale}`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? null : n)}
          className="cursor-pointer rounded-md p-1 transition-transform hover:scale-110"
        >
          <Star className={cn(big ? 'size-9' : 'size-7', (hover || value) >= n ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
        </button>
      ))}
    </div>
  );
}

function FileField({field, value, onChange, upload}: {field: FormField; value: Uploaded[]; onChange: (v: AnswerValue) => void; upload?: UploadFn}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = field.accept === 'images' ? 'image/*' : field.accept === 'documents' ? '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.csv,.rtf' : undefined;
  async function pick(list: FileList | null) {
    if (!list?.length || !upload) return;
    setBusy(true);
    setError(null);
    const next = [...value];
    for (const file of [...list].slice(0, 5 - value.length)) {
      if (file.size > 5 * 1024 * 1024) {
        setError(`${file.name} is larger than 5 MB`);
        continue;
      }
      try {
        next.push(await upload(field, file));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    onChange(next as AnswerValue);
    setBusy(false);
  }
  return (
    <div className="grid gap-2">
      <button
        id={`fld_${field.id}`}
        type="button"
        aria-busy={busy || undefined}
        disabled={!upload || busy || value.length >= 5}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => (e.preventDefault(), pick(e.dataTransfer.files))}
        className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-slate-300 bg-card px-4 py-5 text-sm text-slate-500 transition-colors hover:border-primary/60 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
        <span className="font-semibold">{busy ? 'Uploading…' : 'Choose a file or drop it here'}</span>
        <span className="text-xs">{upload ? `Up to 5 MB${field.accept === 'images' ? ', images only' : field.accept === 'documents' ? ', documents only' : ''}` : 'Uploads work on the published form'}</span>
      </button>
      <input ref={ref} type="file" hidden multiple accept={accept} onChange={(e) => (pick(e.target.files), (e.target.value = ''))} />
      {value.map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <Paperclip className="size-4 text-slate-400" />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <button type="button" aria-label={`Remove ${f.name}`} className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive" onClick={() => onChange(value.filter((x) => x.id !== f.id) as AnswerValue)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

/** A visible label for one part of a name or address question. */
function SubField({label, htmlFor, labelId, className, children}: {label: string; htmlFor: string; labelId?: string; className?: string; children: ReactNode}) {
  return (
    <div className={cn('grid gap-1', className)}>
      <label htmlFor={htmlFor} id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function FieldLabel({field: f, big, number}: {field: FormField; big?: boolean; number?: number}) {
  if (f.type === 'consent') return null;
  if (f.type === 'heading') {
    return (
      <div>
        <h2 className={cn('font-extrabold tracking-tight text-slate-900', big ? 'text-2xl sm:text-3xl' : 'text-lg')}>{f.label}</h2>
        {f.description && <p className={cn('mt-1 whitespace-pre-line text-muted-foreground', big ? 'text-base' : 'text-sm')}>{f.description}</p>}
      </div>
    );
  }
  return (
    <div className={cn(big ? 'mb-4' : 'mb-1.5')}>
      <label id={`fld_${f.id}_label`} htmlFor={`fld_${f.id}`} className={cn('block font-semibold text-slate-800', big ? 'text-xl sm:text-2xl' : 'text-sm')}>
        {number !== undefined && <span className="mr-2 text-primary">{number}→</span>}
        {f.label}
        {f.required && <span className="text-destructive"> *</span>}
      </label>
      {f.description && <p className={cn('mt-0.5 whitespace-pre-line text-muted-foreground', big ? 'text-base' : 'text-xs')}>{f.description}</p>}
    </div>
  );
}

// ─── The form ───────────────────────────────────────────────────────────────

type Mode = 'live' | 'preview';

function initialAnswers(fields: FormField[], params: URLSearchParams | null): Answers {
  const a: Answers = {};
  for (const f of fields) if (f.type === 'hidden') a[f.id] = (f.param && params?.get(f.param)) || f.defaultValue || null;
  return a;
}

/**
 * Renders a form for respondents: classic pages or one question at a time,
 * logic, validation, uploads, spam check and the ending. `preview` never
 * talks to the server (used by the builder).
 */
export function FormRenderer({
  form,
  mode = 'live',
  embed = false,
  className,
  onSubmitted,
}: {
  form: PublicForm;
  mode?: Mode;
  embed?: boolean;
  className?: string;
  onSubmitted?: (ending: Ending) => void;
}) {
  const s = form.settings;
  const params = useMemo(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)), []);
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(form.fields, params));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
  const [ending, setEnding] = useState<Ending | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [hp, setHp] = useState('');
  const startedAt = useRef(Date.now());
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const live = mode === 'live';
  const conversational = s.layout === 'conversational';

  const pages = visiblePages(form.fields, answers);
  // One question per step in conversational mode.
  const steps = conversational ? pages.flatMap((p) => p.fields.map((f) => ({id: f.id, fields: [f]}))) : pages;
  const current = Math.min(index, Math.max(0, steps.length - 1));
  const step = steps[current];
  const last = current >= steps.length - 1;
  const progress = steps.length ? Math.round((current / steps.length) * 100) : 0;

  // Analytics: one view per browser session, one start on first input.
  useEffect(() => {
    if (!live || form.closed) return;
    const key = `form-view:${form.slug}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* private mode: count anyway */
    }
    siteFetch(`/site-api/crm/public/forms/${form.slug}/event`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'view'})}).catch(() => {});
  }, [live, form.slug, form.closed]);

  // Embeds tell the parent page how tall they are.
  useEffect(() => {
    if (!embed || !root.current) return;
    // Measure the form, not the document: the document is never shorter than the iframe, so it could only grow.
    const post = () => root.current && window.parent?.postMessage({type: 'crm-form:resize', slug: form.slug, height: root.current.getBoundingClientRect().height + 24}, '*');
    const ro = new ResizeObserver(post);
    ro.observe(root.current);
    post();
    return () => ro.disconnect();
  }, [embed, form.slug]);

  function set(id: string, v: AnswerValue) {
    if (live && !started.current) {
      started.current = true;
      siteFetch(`/site-api/crm/public/forms/${form.slug}/event`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'start'})}).catch(() => {});
    }
    setAnswers((a) => ({...a, [id]: v}));
    if (errors[id]) setErrors(({[id]: _drop, ...rest}) => rest);
  }

  function check(fields: FormField[]) {
    const next: Record<string, string> = {};
    for (const f of fields) {
      if (!isInput(f.type)) continue;
      const e = validateField(f, answers[f.id]);
      if (e) next[f.id] = e;
    }
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) document.getElementById(`fld_${first}`)?.focus();
    return !first;
  }

  async function upload(field: FormField, file: File): Promise<Uploaded> {
    // Storage takes the bytes directly (docs/agent/files.md): ask, PUT, confirm.
    const base = `/site-api/crm/public/forms/${form.slug}/upload`;
    const res = await siteFetch(base, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({fieldId: field.id, name: file.name, contentType: file.type, size: file.size})});
    const data = (await res.json().catch(() => ({}))) as {fileId?: string; upload?: UploadGrant['upload']; file?: Uploaded; error?: string};
    if (!res.ok || !data.file || !data.upload || !data.fileId) throw new Error(data.error ?? 'Upload failed');
    const put = await putFile(data.upload, file);
    if (!put.ok) throw new Error(put.message);
    const done = await siteFetch(`${base}/${data.fileId}/complete`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
    if (!done.ok) throw new Error(((await done.json().catch(() => ({}))) as {error?: string}).error ?? 'Upload failed');
    return data.file;
  }

  async function submit() {
    setSubmitError(null);
    const all = activeFields(form.fields, answers);
    if (!check(all.filter((f) => f.type !== 'hidden'))) {
      // Jump back to the first step with an error.
      const bad = all.find((f) => f.type !== 'hidden' && validateField(f, answers[f.id]));
      const at = steps.findIndex((st) => st.fields.some((f) => f.id === bad?.id));
      if (at >= 0) setIndex(at);
      return;
    }
    if (!live) {
      const e = pickEnding({...s, endings: s.endings} as FormSettings, form.fields, answers);
      setEnding(e);
      setStatus('done');
      onSubmitted?.(e);
      return;
    }
    setStatus('submitting');
    const meta: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      const v = params?.get(k);
      if (v) meta[k] = v.slice(0, 300);
    }
    // Opened from a company's website (embed.js), the page and referrer came along in the address.
    meta.page = (params?.get('page') || window.location.href).slice(0, 1000);
    const ref = params?.get('ref') || document.referrer;
    if (ref) meta.referrer = ref.slice(0, 1000);
    const payload = Object.fromEntries(all.map((f) => [f.id, answers[f.id] ?? null]));
    try {
      // One key per response sent: a retry after a lost answer saves nothing twice.
      const data = await sendAttempt(['form', form.slug, payload, meta], async (headers) => {
        const res = await siteFetch(`/site-api/crm/public/forms/${form.slug}/submit`, {
          method: 'POST',
          headers: {'content-type': 'application/json', ...headers},
          body: JSON.stringify({answers: payload, meta, hp, startedAt: startedAt.current}),
        });
        const body = (await res.json().catch(() => ({}))) as {ending?: Ending; error?: string; fields?: Record<string, string>};
        if (!res.ok || !body.ending) throw Object.assign(new Error(body.error ?? 'Something went wrong. Please try again.'), {status: res.status, fields: body.fields});
        return body as {ending: Ending};
      });
      setEnding(data.ending);
      setStatus('done');
      onSubmitted?.(data.ending);
      if (embed) window.parent?.postMessage({type: 'crm-form:submitted', slug: form.slug}, '*');
      const url = data.ending.redirectUrl;
      if (url && /^https?:\/\//i.test(url)) {
        setTimeout(() => {
          try {
            (embed ? window.top! : window).location.href = url;
          } catch {
            window.open(url, '_blank', 'noopener');
          }
        }, 900);
      }
    } catch (e) {
      setStatus('idle');
      // An answer the server refused (`fields`, keyed by question id): its words go under that
      // question, on its step, and focus moves there.
      const fields = Object.fromEntries(Object.entries((e as {fields?: Record<string, string>}).fields ?? {}).filter(([id]) => all.some((f) => f.id === id)));
      const first = Object.keys(fields)[0];
      if (!first) return setSubmitError((e as Error).message);
      setErrors(fields);
      const at = steps.findIndex((st) => st.fields.some((f) => f.id === first));
      if (at >= 0) setIndex(at);
      setTimeout(() => document.getElementById(`fld_${first}`)?.focus());
    }
  }

  function next() {
    if (!step) return;
    if (!check(step.fields)) return;
    if (last) submit();
    else {
      setIndex(current + 1);
      if (!conversational) root.current?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }
  const back = () => setIndex(Math.max(0, current - 1));

  const shell = (children: ReactNode) => (
    <div ref={root} style={accentStyle(s.accent)} className={cn('@container w-full', className)}>
      {children}
    </div>
  );

  if (live && form.closed) {
    return shell(
      <div className="py-10 text-center">
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{s.title || form.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{form.closed}</p>
      </div>,
    );
  }

  if (status === 'done' && ending) {
    return shell(
      <div className="flex flex-col items-center py-10 text-center animate-in fade-in-0 zoom-in-95">
        <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="size-7" />
        </span>
        <h2 className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900">{ending.title}</h2>
        <p className="mt-2 max-w-md whitespace-pre-line text-muted-foreground">{ending.message}</p>
        {ending.redirectUrl && live && <p className="mt-4 text-xs text-muted-foreground">Redirecting…</p>}
        {!live && (
          <Button variant="secondary" size="sm" className="mt-6" onClick={() => (setStatus('idle'), setEnding(null), setIndex(0), setAnswers(initialAnswers(form.fields, params)))}>
            Restart preview
          </Button>
        )}
      </div>,
    );
  }

  const honeypot = (
    <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
      <label>
        Leave this empty
        <input tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} name="website_url" />
      </label>
    </div>
  );

  const footer = (
    <>
      {submitError && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700" role="alert">{submitError}</p>}
    </>
  );

  if (!step) return shell(<p className="py-10 text-center text-sm text-muted-foreground">This form has no questions yet.</p>);

  // ── Conversational: one question at a time ──
  if (conversational) {
    const f = step.fields[0]!;
    const number = steps.slice(0, current + 1).filter((st) => st.fields[0]!.type !== 'heading').length;
    const autoAdvance = f.type === 'single_choice' || f.type === 'yes_no' || f.type === 'rating' || f.type === 'dropdown';
    return shell(
      <div className="relative">
        {honeypot}
        {s.progressBar && (
          <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{width: `${Math.max(4, progress)}%`}} />
          </div>
        )}
        {current === 0 && (s.title || s.intro) && f.type !== 'heading' && (
          <div className="mb-8">
            {s.title && <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{s.title}</h1>}
            {s.intro && <p className="mt-2 whitespace-pre-line text-muted-foreground">{s.intro}</p>}
          </div>
        )}
        <div key={f.id} className="min-h-[260px] animate-in fade-in-0 slide-in-from-bottom-3 duration-300">
          <FieldLabel field={f} big number={f.type === 'heading' ? undefined : number} />
          <div className="mt-2">
            <FieldControl
              field={f}
              big
              autoFocus
              value={answers[f.id]}
              error={errors[f.id]}
              upload={live ? upload : undefined}
              onEnter={next}
              onChange={(v) => {
                set(f.id, v);
                if (autoAdvance && v !== null && !last) setTimeout(() => setIndex((i) => (i === current ? i + 1 : i)), 280);
              }}
            />
          </div>
          {errors[f.id] && <p id={`fld_${f.id}_error`} className="mt-2 text-sm font-medium text-destructive" role="alert">{errors[f.id]}</p>}
          {footer}
          <div className="mt-6 flex items-center gap-3">
            <Button size="lg" onClick={next} pending={status === 'submitting'} pendingLabel="Sending…">
              {last ? s.submitLabel || 'Submit' : f.type === 'heading' ? 'Continue' : 'OK'} {!last && <Check />}
            </Button>
            {!last && f.type !== 'long_text' && <span className="hidden text-xs text-muted-foreground sm:inline">press Enter ↵</span>}
            <div className="ml-auto flex gap-1">
              <Button variant="secondary" size="icon" onClick={back} disabled={current === 0} aria-label="Previous question"><ChevronUp /></Button>
              <Button variant="secondary" size="icon" onClick={next} disabled={last} aria-label="Next question"><ChevronDown /></Button>
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── Classic: pages of fields ──
  const page = pages[current]!;
  return shell(
    <div className="relative">
      {honeypot}
      {current === 0 && (s.title || s.intro) && (
        <div className="mb-6">
          {s.title && <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{s.title}</h1>}
          {s.intro && <p className="mt-2 whitespace-pre-line text-muted-foreground">{s.intro}</p>}
        </div>
      )}
      {pages.length > 1 && (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>{current > 0 && page.title ? page.title : `Step ${current + 1}`}</span>
            <span>
              {current + 1} of {pages.length}
            </span>
          </div>
          {s.progressBar && (
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary transition-all duration-500" style={{width: `${Math.max(4, ((current + 1) / pages.length) * 100)}%`}} />
            </div>
          )}
        </div>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
        className="grid grid-cols-1 gap-x-4 gap-y-5 @md:grid-cols-2"
      >
        {page.fields.map((f) => (
          <div key={f.id} className={cn('min-w-0', (f.width !== 'half' || f.type === 'heading') && '@md:col-span-2')}>
            <FieldLabel field={f} />
            <FieldControl field={f} value={answers[f.id]} error={errors[f.id]} upload={live ? upload : undefined} onChange={(v) => set(f.id, v)} />
            {errors[f.id] && <p id={`fld_${f.id}_error`} className="mt-1.5 text-xs font-medium text-destructive" role="alert">{errors[f.id]}</p>}
          </div>
        ))}
        <div className="@md:col-span-2">
          {footer}
          <div className="mt-2 flex items-center gap-3">
            {current > 0 && (
              <Button type="button" variant="secondary" onClick={back} disabled={status === 'submitting'}>
                <ArrowLeft /> Back
              </Button>
            )}
            <Button type="submit" className="min-w-32" pending={status === 'submitting'} pendingLabel="Sending…">
              {last ? s.submitLabel || 'Submit' : 'Next'} {!last && <ArrowRight />}
            </Button>
          </div>
        </div>
      </form>
    </div>,
  );
}
