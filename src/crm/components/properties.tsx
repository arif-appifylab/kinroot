import {Check, History, Loader2, Pencil, X} from 'lucide-react';
import {useEffect, useRef, useState, type ReactNode} from 'react';

import {ApiError, shownInPlace} from '@/lib/api';
import {useMe} from '@/lib/queries';
import type {CustomField} from '@/lib/types';
import {cn} from '@/lib/utils';

import {CustomFieldInput, CustomFieldValue} from './custom-fields';
import {CreatableSelect} from './pickers';
import {usePropertyHistory} from './property-history';
import {Card} from './ui/card';
import {Field, Input, NativeSelect} from './ui/form';
import {Tooltip} from './ui/menu';

export function PropertyCard({title, children, action}: {title: string; children: ReactNode; action?: ReactNode}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {action}
      </div>
      <dl className="divide-y divide-slate-50 px-1 py-1">{children}</dl>
    </Card>
  );
}

function Row({label, children, onEdit, editing, field, editRef}: {label: string; children: ReactNode; onEdit?: () => void; editing?: boolean; field?: string; editRef?: React.Ref<HTMLButtonElement>}) {
  const history = usePropertyHistory();
  return (
    // A click anywhere on the row edits it (mouse); keyboard users reach the row's own "Edit" button.
    <div className={cn('group grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2 rounded-lg px-3 py-2', onEdit && !editing && 'cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50')} onClick={!editing ? onEdit : undefined}>
      <dt className="pt-0.5 text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1 text-sm text-slate-800">
        <div className="min-w-0 flex-1 break-words">{children}</div>
        {field && history && !editing && (
          <Tooltip content="Property history">
            <button
              type="button"
              aria-label={`${label}: property history`}
              onClick={(e) => (e.stopPropagation(), history.open(field))}
              className="-my-0.5 cursor-pointer rounded p-0.5 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none pointer-coarse:opacity-100"
            >
              <History className="size-3" />
            </button>
          </Tooltip>
        )}
        {onEdit && !editing && (
          <button
            ref={editRef}
            type="button"
            aria-label={`Edit ${label}`}
            onClick={(e) => (e.stopPropagation(), onEdit())}
            className="-my-0.5 shrink-0 cursor-pointer rounded p-0.5 text-slate-300 opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/30 pointer-coarse:opacity-100"
          >
            <Pencil className="size-3" />
          </button>
        )}
      </dd>
    </div>
  );
}

/** Read-only row. */
export function Property({label, children, field}: {label: string; children: ReactNode; field?: string}) {
  return <Row label={label} field={field}>{children}</Row>;
}

type EditorProps<T> = {value: T; onChange: (v: T) => void; onCommit: () => void; onCancel: () => void};

/** A check on a value: the words that say how to fix it, or nothing (the server's rule, in the browser). */
export type PropertyCheck<T> = (value: T) => string | null | undefined | false;

/** The server's words for this field (`422 {fields}`), as a sentence: "First name is required". */
function savedError(e: unknown, field: string | undefined, label: string): string {
  if (e instanceof ApiError) {
    const entry = field ? Object.entries(e.fields).find(([k]) => k === field || k.startsWith(`${field}.`)) : undefined;
    const words = entry?.[1] ?? (Object.keys(e.fields).length === 1 ? Object.values(e.fields)[0] : undefined);
    if (words) return /^[a-z]/.test(words) ? `${label} ${words}.`.replace(/\.\.$/, '.') : words;
    if (e.message) return e.message;
  }
  return e instanceof Error && e.message ? e.message : 'That did not save. Try again.';
}

/**
 * Click-to-edit row. `render` shows the value; `editor` renders the control.
 * Enter commits, Escape cancels. `field` (the property key, e.g. `ownerId`
 * or `custom.region`) adds a history button that opens the Property history drawer.
 *
 * Saving (AUDIT-2 M-16): `rules` run first (the server's rules), and a wrong value stays in the
 * editor with its error under it. When `onSave` returns a promise (`mutateAsync`), the editor stays
 * open, its Save pending, until the save answers; a refusal shows under the input, nothing typed is lost.
 */
export function EditableProperty<T>({label, value, display, editor, onSave, field, rules}: {label: string; value: T; display: ReactNode; editor: (p: EditorProps<T>) => ReactNode; onSave: (v: T) => unknown; field?: string; rules?: PropertyCheck<T>[]}) {
  const {canEdit} = useMe();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  // Back from editing (Enter, Escape, Save, Cancel): focus returns to the row's Edit button.
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing && (!document.activeElement || document.activeElement === document.body)) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const change = (v: T) => (setDraft(v), setError(null));
  const commit = async () => {
    if (saving) return;
    if (JSON.stringify(draft) === JSON.stringify(value)) return (setError(null), setEditing(false));
    for (const rule of rules ?? []) {
      const message = rule(draft);
      if (message) return setError(message);
    }
    setSaving(true);
    try {
      await onSave(draft);
      setError(null);
      setEditing(false);
    } catch (e) {
      if (e && typeof e === 'object') shownInPlace.set(e, 'shown');
      setError(savedError(e, field, label));
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    if (saving) return;
    setDraft(value);
    setError(null);
    setEditing(false);
  };

  return (
    <Row label={label} field={field} onEdit={canEdit ? () => setEditing(true) : undefined} editing={editing} editRef={editRef}>
      {editing ? (
        <Field error={error} className="gap-1">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">{editor({value: draft, onChange: change, onCommit: () => void commit(), onCancel: cancel})}</div>
            <button type="button" aria-label={saving ? `Saving ${label}…` : `Save ${label}`} aria-busy={saving || undefined} disabled={saving} onClick={() => void commit()} className="cursor-pointer rounded-md p-1 text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-wait">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            </button>
            <button type="button" aria-label="Cancel" disabled={saving} onClick={cancel} className="cursor-pointer rounded-md p-1 text-muted-foreground outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"><X className="size-4" /></button>
          </div>
        </Field>
      ) : (
        display
      )}
    </Row>
  );
}

/** The server's rules for inline edits (`contactBody`, `companyBody`, `dealBody`), shared by the record pages. */
export const propertyRules = {
  required: (words: string) => (v: string | null | undefined) => (!v || !String(v).trim() ? words : null),
  email: (v: string | null | undefined) => (v && v.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? 'Enter a valid email address, like name@example.com.' : null),
  /** `httpUrl` on the server: a web address; "example.com" is taken as https://example.com. */
  webAddress: (v: string | null | undefined) => {
    const s = v?.trim();
    if (!s) return null;
    if (s.length > 2000) return 'Use at most 2000 characters.';
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')) return null;
    } catch {
      // refused below
    }
    return 'Enter a web address, like https://example.com.';
  },
  number:
    ({min, max, integer}: {min: number; max: number; integer?: boolean}) =>
    (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (!s) return null;
      const n = Number(s);
      return !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max ? `Enter ${integer ? 'a whole number' : 'a number'} between ${min.toLocaleString()} and ${max.toLocaleString()}.` : null;
    },
};

const empty = <span className="text-muted-foreground">—</span>;

/** `maxLength`: the field's limit (src/crm/lib/record-limits.ts), so the inline edit can't go past what the server takes. */
export function TextProperty({label, value, onSave, type = 'text', href, field, maxLength, required, rules = []}: {label: string; value: string | null | undefined; onSave: (v: string | null) => unknown; type?: string; href?: string; field?: string; maxLength?: number; required?: string; rules?: PropertyCheck<string>[]}) {
  const ref = useRef<HTMLInputElement>(null);
  const checks: PropertyCheck<string>[] = [
    ...(required ? [propertyRules.required(required)] : []),
    (v) => maxLength !== undefined && v.trim().length > maxLength && `Use at most ${maxLength} characters.`,
    ...(type === 'email' ? [propertyRules.email] : []),
    ...rules,
  ];
  return (
    <EditableProperty
      label={label}
      field={field}
      rules={checks}
      value={value ?? ''}
      onSave={(v) => onSave(v.trim() || null)}
      display={value ? (href ? <a href={href} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">{value}</a> : value) : empty}
      editor={({value: v, onChange, onCommit, onCancel}) => (
        <Input
          ref={ref}
          autoFocus
          aria-label={label}
          type={type}
          maxLength={maxLength}
          className="h-8"
          value={v}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit();
            if (e.key === 'Escape') onCancel();
          }}
        />
      )}
    />
  );
}

export function SelectProperty({label, value, options, onSave, display, field}: {label: string; value: string | null | undefined; options: {value: string; label: string}[]; onSave: (v: string | null) => unknown; display?: ReactNode; field?: string}) {
  return (
    <EditableProperty
      label={label}
      field={field}
      value={value ?? ''}
      onSave={(v) => onSave(v || null)}
      display={display ?? (options.find((o) => o.value === value)?.label ?? empty)}
      editor={({value: v, onChange, onCancel}) => (
        <NativeSelect autoFocus aria-label={label} className="h-8" value={v} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </NativeSelect>
      )}
    />
  );
}

export function CustomFieldProperties({fields, values, onSave, currency}: {fields: CustomField[]; values: Record<string, unknown>; onSave: (key: string, v: unknown) => unknown; currency?: string}) {
  return (
    <>
      {fields.map((f) => (
        <EditableProperty
          key={f.id}
          label={f.label}
          field={`custom.${f.key}`}
          value={(values[f.key] ?? null) as unknown}
          onSave={(v) => onSave(f.key, v)}
          display={<CustomFieldValue field={f} value={values[f.key]} currency={currency} />}
          editor={({value, onChange}) => <CustomFieldInput field={f} value={value} onChange={onChange} />}
        />
      ))}
    </>
  );
}

/** Pick from a list; with `creatable`, a missing value can be typed in directly. */
export function ChoiceProperty({label, value, options, onSave, creatable, noun, field}: {label: string; value: string | null | undefined; options: string[]; onSave: (v: string | null) => unknown; creatable?: boolean; noun?: string; field?: string}) {
  return (
    <EditableProperty
      label={label}
      field={field}
      value={value ?? null}
      display={value ?? empty}
      editor={({value: v, onChange}) => <CreatableSelect noun={noun} value={v} options={options} onChange={(x) => onChange(x as string | null)} onCreate={creatable ? () => {} : undefined} />}
      onSave={onSave}
    />
  );
}

export function NumberProperty({label, value, onSave, format, field, rules}: {label: string; value: number | null | undefined; onSave: (v: number | null) => unknown; format?: (n: number) => string; field?: string; rules?: PropertyCheck<string>[]}) {
  return (
    <EditableProperty
      label={label}
      field={field}
      rules={rules}
      value={value === null || value === undefined ? '' : String(value)}
      display={value === null || value === undefined ? empty : format ? format(value) : value.toLocaleString()}
      editor={({value: v, onChange, onCommit, onCancel}) => (
        <Input autoFocus aria-label={label} type="number" inputMode="decimal" step="any" className="h-8" value={v} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? onCommit() : e.key === 'Escape' && onCancel())} />
      )}
      onSave={(v) => onSave(v === '' ? null : Number(v))}
    />
  );
}
