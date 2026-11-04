import {Check, History, Pencil, X} from 'lucide-react';
import {useEffect, useRef, useState, type ReactNode} from 'react';

import {useMe} from '@/lib/queries';
import type {CustomField} from '@/lib/types';
import {cn} from '@/lib/utils';

import {CustomFieldInput, CustomFieldValue} from './custom-fields';
import {CreatableSelect} from './pickers';
import {usePropertyHistory} from './property-history';
import {Card} from './ui/card';
import {Input, NativeSelect} from './ui/form';
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

/**
 * Click-to-edit row. `render` shows the value; `editor` renders the control.
 * Enter / blur commits, Escape cancels. `field` (the property key, e.g. `ownerId`
 * or `custom.region`) adds a history button that opens the Property history drawer.
 */
export function EditableProperty<T>({label, value, display, editor, onSave, field}: {label: string; value: T; display: ReactNode; editor: (p: EditorProps<T>) => ReactNode; onSave: (v: T) => unknown; field?: string}) {
  const {canEdit} = useMe();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Back from editing (Enter, Escape, Save, Cancel): focus returns to the row's Edit button.
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing && (!document.activeElement || document.activeElement === document.body)) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (JSON.stringify(draft) !== JSON.stringify(value)) await onSave(draft);
  };
  const cancel = () => (setDraft(value), setEditing(false));

  return (
    <Row label={label} field={field} onEdit={canEdit ? () => setEditing(true) : undefined} editing={editing} editRef={editRef}>
      {editing ? (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{editor({value: draft, onChange: setDraft, onCommit: commit, onCancel: cancel})}</div>
          <button type="button" aria-label={`Save ${label}`} onClick={commit} className="cursor-pointer rounded-md p-1 text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/30"><Check className="size-4" /></button>
          <button type="button" aria-label="Cancel" onClick={cancel} className="cursor-pointer rounded-md p-1 text-slate-400 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary/30"><X className="size-4" /></button>
        </div>
      ) : (
        display
      )}
    </Row>
  );
}

const empty = <span className="text-slate-400">—</span>;

export function TextProperty({label, value, onSave, type = 'text', href, field}: {label: string; value: string | null | undefined; onSave: (v: string | null) => unknown; type?: string; href?: string; field?: string}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <EditableProperty
      label={label}
      field={field}
      value={value ?? ''}
      onSave={(v) => onSave(v.trim() || null)}
      display={value ? (href ? <a href={href} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">{value}</a> : value) : empty}
      editor={({value: v, onChange, onCommit, onCancel}) => (
        <Input
          ref={ref}
          autoFocus
          aria-label={label}
          type={type}
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

export function NumberProperty({label, value, onSave, format, field}: {label: string; value: number | null | undefined; onSave: (v: number | null) => unknown; format?: (n: number) => string; field?: string}) {
  return (
    <EditableProperty
      label={label}
      field={field}
      value={value === null || value === undefined ? '' : String(value)}
      display={value === null || value === undefined ? empty : format ? format(value) : value.toLocaleString()}
      editor={({value: v, onChange, onCommit, onCancel}) => (
        <Input autoFocus aria-label={label} type="number" inputMode="decimal" step="any" className="h-8" value={v} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? onCommit() : e.key === 'Escape' && onCancel())} />
      )}
      onSave={(v) => onSave(v === '' ? null : Number(v))}
    />
  );
}
