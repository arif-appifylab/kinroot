import {Checkbox as CheckboxPrimitive, Label as LabelPrimitive, Select as SelectPrimitive, Switch as SwitchPrimitive} from 'radix-ui';
import {Check, ChevronDown} from 'lucide-react';
import * as React from 'react';

import {cn} from '@/lib/utils';

const field =
  'w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-xs transition-[color,box-shadow,border-color] duration-200 outline-none placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

/** `sm` is the compact size for filter bars (h-8, 13px); the default is for real forms. */
export type ControlSize = 'default' | 'sm';

// ─── Field wiring ───
// A `Field` names its control: the control takes the Field's id (unless it has its own) and,
// when it is that labelled control, `aria-invalid` and `aria-describedby` for the error / hint.

type FieldWiring = {id: string; labelId?: string; describedBy?: string; invalid: boolean};
const FieldContext = React.createContext<FieldWiring | null>(null);

/**
 * The surrounding `Field`'s wiring for a control that can't take a `<label for>` (a rich editor's
 * editable element): point `aria-labelledby` at `labelId` and copy `aria-invalid` / `aria-describedby`.
 */
export function useFieldWiring() {
  return React.useContext(FieldContext);
}

/** The id and error wiring a control gets from its `Field` (pass your own `id` to opt out). */
export function useFieldControl<P extends {id?: string; 'aria-invalid'?: unknown; 'aria-describedby'?: string}>(props: P): P {
  const ctx = React.useContext(FieldContext);
  if (!ctx) return props;
  const id = props.id ?? ctx.id;
  if (id !== ctx.id) return props;
  return {
    ...props,
    id,
    'aria-invalid': props['aria-invalid'] ?? (ctx.invalid ? true : undefined),
    'aria-describedby': props['aria-describedby'] ?? ctx.describedBy,
  };
}

export function Input({className, size = 'default', ...props}: Omit<React.ComponentProps<'input'>, 'size'> & {size?: ControlSize}) {
  const wired = useFieldControl(props);
  return <input data-slot="input" className={cn(field, size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10', className)} {...wired} />;
}

export function Textarea({className, ...props}: React.ComponentProps<'textarea'>) {
  const wired = useFieldControl(props);
  return <textarea data-slot="textarea" className={cn(field, 'min-h-24 py-2.5 leading-relaxed', className)} {...wired} />;
}

// ─── Select ───
// Written like a native <select> (value, onChange(e.target.value), <option>, <optgroup>), drawn
// as a design-system listbox so the open list matches the app instead of the OS menu.

type SelectOption = {value: string; label: React.ReactNode; disabled: boolean};
type SelectGroup = {label: string | null; options: SelectOption[]};

// Radix items can't use "" as a value; empty options ("Any owner") map to this.
const EMPTY = '__empty__';
const toItem = (v: string) => (v === '' ? EMPTY : v);

function readOptions(children: React.ReactNode): SelectGroup[] {
  const groups: SelectGroup[] = [{label: null, options: []}];
  const walk = (nodes: React.ReactNode, group: SelectGroup) => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;
      const p = child.props as {value?: unknown; label?: string; disabled?: boolean; children?: React.ReactNode};
      if (child.type === React.Fragment) return walk(p.children, group);
      if (child.type === 'optgroup') {
        const g: SelectGroup = {label: p.label ?? null, options: []};
        groups.push(g);
        return walk(p.children, g);
      }
      if (child.type === 'option') {
        const value = p.value === undefined ? React.Children.toArray(p.children).join('') : String(p.value);
        group.options.push({value, label: p.children, disabled: !!p.disabled});
      }
    });
  };
  walk(children, groups[0]!);
  return groups.filter((g) => g.options.length);
}

/** `size="sm"` is the compact filter-bar trigger: h-8, 13px, as wide as its label (long labels truncate). */
export function NativeSelect({size = 'default', ...input}: Omit<React.ComponentProps<'select'>, 'size'> & {size?: ControlSize}) {
  const {className, value, onChange, children, disabled, id, ref, ...rest} = useFieldControl(input);
  const sm = size === 'sm';
  const groups = readOptions(children);
  const current = value === undefined || value === null ? '' : String(value);
  const all = groups.flatMap((g) => g.options);
  // Like a native select, a value with no matching option shows the first option.
  const selected = all.find((o) => o.value === current) ?? all[0];
  const change = (v: string) => {
    const next = v === EMPTY ? '' : v;
    // Callers read e.target.value, as with a native select.
    onChange?.({target: {value: next}, currentTarget: {value: next}} as unknown as React.ChangeEvent<HTMLSelectElement>);
  };
  return (
    <SelectPrimitive.Root value={toItem(selected?.value ?? current)} onValueChange={change} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        ref={ref as unknown as React.Ref<HTMLButtonElement>}
        aria-label={rest['aria-label']}
        aria-invalid={rest['aria-invalid']}
        aria-describedby={rest['aria-describedby']}
        className={cn(
          field,
          'flex cursor-pointer items-center justify-between text-left data-[placeholder]:text-slate-400',
          sm ? 'h-8 w-auto max-w-56 gap-1.5 pr-2 pl-2.5 text-[13px]' : 'h-10 gap-2 pr-2.5',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? current}</span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className={cn('shrink-0 text-slate-500', sm ? 'size-3.5' : 'size-4')} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-slate-100 bg-popover text-popover-foreground shadow-lift data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <SelectPrimitive.Viewport className="max-h-[inherit] overflow-y-auto p-1 scrollbar-thin">
            {groups.map((g, gi) => (
              <SelectPrimitive.Group key={gi} className={cn(gi > 0 && 'mt-1 border-t border-slate-100 pt-1')}>
                {g.label && <SelectPrimitive.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{g.label}</SelectPrimitive.Label>}
                {g.options.map((o) => (
                  <SelectPrimitive.Item
                    key={o.value}
                    value={toItem(o.value)}
                    disabled={o.disabled}
                    className={cn(
                      'relative flex cursor-pointer items-center gap-2 rounded-lg pr-8 pl-2.5 text-slate-700 outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-slate-900 data-[state=checked]:font-semibold data-[state=checked]:text-slate-900',
                      sm ? 'py-1.5 text-[13px]' : 'py-2 text-sm',
                    )}
                  >
                    <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
                      <Check className="size-4 text-primary" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Label({className, ...props}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('text-sm font-semibold text-slate-700 select-none', className)} {...props} />;
}

/**
 * Label + control + optional hint/error, stacked. The label points at the control (`htmlFor`, else
 * the child's own `id`, else a generated one the kit's controls pick up), and the control gets
 * `aria-invalid` + `aria-describedby` pointing at the error (`<id>-error`) or the hint.
 *
 * `group`: the label names a set of controls (radio cards, chips, checkboxes, a picker made of
 * buttons) rather than one input: the children are wrapped in `role="group"` labelled by it.
 * A rich editor inside a Field takes its name from the label (`useFieldWiring`).
 */
export function Field({label, hint, error, children, className, htmlFor, group}: {label?: React.ReactNode; hint?: React.ReactNode; error?: string | null | false; children: React.ReactNode; className?: string; htmlFor?: string; group?: boolean}) {
  const auto = React.useId();
  const childId = React.isValidElement<{id?: unknown}>(children) && typeof children.props.id === 'string' ? children.props.id : undefined;
  const id = htmlFor ?? childId ?? auto;
  const labelId = label ? `${id}-label` : undefined;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const wiring = React.useMemo(() => ({id, labelId, describedBy, invalid: !!error}), [id, labelId, describedBy, error]);
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      {label && (group ? <Label id={labelId}>{label}</Label> : <Label id={labelId} htmlFor={id}>{label}</Label>)}
      {/* A group's controls are named by their own labels: none of them takes the Field's id. */}
      <FieldContext.Provider value={group ? null : wiring}>
        {group ? (
          <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
            {children}
          </div>
        ) : (
          children
        )}
      </FieldContext.Provider>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({className, ...props}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 cursor-pointer rounded-[5px] border border-slate-300 bg-card shadow-xs transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30 data-[state=checked]:border-primary data-[state=checked]:bg-brand data-[state=checked]:text-white',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({className, ...props}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30 data-[state=checked]:bg-brand data-[state=unchecked]:bg-slate-200',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}
