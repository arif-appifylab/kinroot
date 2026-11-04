import {useQueryClient} from '@tanstack/react-query';
import {ExternalLink} from 'lucide-react';

import {api} from '@/lib/api';
import {money, shortDate} from '@/lib/format';
import {useMe} from '@/lib/queries';
import type {CustomField} from '@/lib/types';

import {CreatableSelect} from './pickers';
import {Badge} from './ui/badge';
import {Checkbox, Input} from './ui/form';

/** Choice fields: admins can add a missing option straight from the dropdown. */
function ChoiceFieldInput({id, field, value, onChange}: {id: string; field: CustomField; value: unknown; onChange: (v: unknown) => void}) {
  const {isAdmin} = useMe();
  const qc = useQueryClient();
  const multiple = field.type === 'MULTISELECT';
  return (
    <CreatableSelect
      id={id}
      multiple={multiple}
      value={multiple ? ((value as string[] | undefined) ?? []) : ((value as string | undefined) ?? null)}
      onChange={onChange}
      options={field.options}
      noun="option"
      placeholder={multiple ? 'Choose options' : 'Choose…'}
      onCreate={
        isAdmin
          ? async (label) => {
              await api.patch(`/fields/${field.id}`, {options: [...field.options, label]});
              await qc.invalidateQueries({queryKey: ['fields']});
            }
          : undefined
      }
    />
  );
}

export function CustomFieldInput({field, value, onChange}: {field: CustomField; value: unknown; onChange: (v: unknown) => void}) {
  const id = `cf-${field.key}`;
  switch (field.type) {
    case 'NUMBER':
    case 'CURRENCY':
      return <Input id={id} type="number" step="any" value={(value as number | undefined) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'DATE':
      return <Input id={id} type="date" value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'URL':
      return <Input id={id} type="url" placeholder="https://" value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'CHECKBOX':
      return (
        <div className="flex h-10 items-center">
          <Checkbox id={id} checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
        </div>
      );
    case 'SELECT':
    case 'MULTISELECT':
      return <ChoiceFieldInput id={id} field={field} value={value} onChange={onChange} />;
    default:
      return <Input id={id} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
  }
}

export function CustomFieldValue({field, value, currency = 'USD'}: {field: CustomField; value: unknown; currency?: string}) {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return <span className="text-muted-foreground">—</span>;
  switch (field.type) {
    case 'CURRENCY':
      return <>{money(Number(value), currency)}</>;
    case 'DATE':
      return <>{shortDate(String(value))}</>;
    case 'CHECKBOX':
      return <>{value ? 'Yes' : 'No'}</>;
    case 'URL':
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          {String(value).replace(/^https?:\/\//, '').slice(0, 40)} <ExternalLink className="size-3" />
        </a>
      );
    case 'MULTISELECT':
      return (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((v) => <Badge key={v} tone="blue">{v}</Badge>)}
        </span>
      );
    default:
      return <>{String(value)}</>;
  }
}
