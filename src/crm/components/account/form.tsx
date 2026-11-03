import {Check, CircleAlert, CircleCheck, Eye, EyeOff, Loader2, X} from 'lucide-react';
import {type ComponentProps, type FormEvent, type ReactElement, type ReactNode, useRef, useState} from 'react';

import {Button, type ButtonProps} from '@/components/ui/button';
import {Input} from '@/components/ui/form';
import {onFields} from '@/lib/account-api';
import {cn} from '@/lib/utils';
import type {PasswordCheck} from '../../../lib/password-checks';
import type {Rule} from '../../../lib/rules';

/**
 * The account forms' pieces (AGENTS.md "Buttons and forms"), in Kinroot's look: a field with
 * its visible label and its error in place, a password input with show / hide, the live
 * password checklist, a pending button, and the form's status line.
 */

type Values = Record<string, string>;
type Schema<V extends Values> = Partial<Record<keyof V, Rule[]>>;
type Errors<V extends Values> = Partial<Record<keyof V, string>>;

/**
 * A small form state: values, per-field errors and when to show them. An error shows after
 * the field is left or after a submit, then updates while typing; `submit` validates all,
 * focuses the first wrong field and only then calls `onValid`; `setServerErrors` puts the
 * server's `422 {fields}` on their fields. `prefix` keeps ids unique when forms share a page.
 */
export function useForm<V extends Values>(prefix: string, initial: V, schema: Schema<V>) {
  const [values, setValues] = useState<V>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof V, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<Errors<V>>({});
  const refs = useRef<Partial<Record<keyof V, HTMLElement | null>>>({});

  const check = (name: keyof V): string | undefined => {
    for (const rule of schema[name] ?? []) {
      const message = rule(values[name] ?? '');
      if (message) return message;
    }
    return undefined;
  };
  const error = (name: keyof V) => (touched[name] || submitted ? (server[name] ?? check(name)) : server[name]);
  const id = (name: keyof V & string) => `${prefix}-${name}`;

  /** Everything an input needs: id, value, change, blur and its error wiring. */
  const field = (name: keyof V & string) => {
    const wrong = error(name);
    return {
      id: id(name),
      name,
      value: values[name] ?? '',
      ref: (node: HTMLElement | null) => {
        refs.current[name] = node;
      },
      onChange: (event: {target: {value: string}}) => {
        const value = event.target.value;
        setValues((current) => ({...current, [name]: value}));
        setServer((current) => ({...current, [name]: undefined}));
      },
      onBlur: () => setTouched((current) => ({...current, [name]: true})),
      'aria-invalid': wrong ? true : undefined,
      'aria-describedby': wrong ? `${id(name)}-error` : undefined,
    };
  };

  const submit = (onValid: (values: V) => void) => (event?: FormEvent) => {
    event?.preventDefault();
    setSubmitted(true);
    const first = (Object.keys(schema) as (keyof V)[]).find((name) => check(name));
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    onValid(values);
  };

  const reset = (next: V = initial) => {
    setValues(next);
    setTouched({});
    setSubmitted(false);
    setServer({});
  };

  return {
    values,
    id,
    field,
    error,
    submit,
    reset,
    setServerErrors: (errors: Errors<V>) => {
      setServer(errors);
      const first = (Object.keys(errors) as (keyof V)[]).find((name) => errors[name]);
      if (first) refs.current[first]?.focus();
    },
  };
}

/** One labelled field: the label, the control, a hint, and its error in place (`<id>-error`). */
export function FormField({id, label, hint, error, children, className}: {id: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactElement; className?: string}) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-slate-700 select-none">
        {label}
      </label>
      {children}
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

/** A password input with a show / hide button; the password is hidden at first. */
export function PasswordInput({className, ...props}: Omit<ComponentProps<'input'>, 'type' | 'size'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={cn('pr-11', className)} />
      <button
        type="button"
        aria-controls={props.id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((value) => !value)}
        className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-slate-500 outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-primary/30 [&_svg]:size-4"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

/** The live rules under a new password; the ones still missing turn red once `tried`. */
export function PasswordChecks({id, checks, tried}: {id: string; checks: PasswordCheck[]; tried?: boolean}) {
  return (
    <ul id={id} className="grid gap-1 text-xs" aria-live="polite">
      {checks.map((check) => (
        <li key={check.id} className={cn('flex items-center gap-1.5', check.ok ? 'text-green-700' : tried ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          {check.ok ? <Check className="size-3.5 shrink-0" aria-hidden /> : <X className="size-3.5 shrink-0" aria-hidden />}
          {check.label}
          <span className="sr-only">{check.ok ? ' (done)' : ' (not yet)'}</span>
        </li>
      ))}
    </ul>
  );
}

/** A Kinroot button that shows its work: spinner and present-tense label, busy and disabled. */
export function PendingButton({pending, pendingLabel, disabled, children, ...props}: ButtonProps & {pending?: boolean; pendingLabel: string}) {
  return (
    <Button {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden /> {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** A form's status line: its result, or an error that belongs to no field. */
export function FormNotice({tone, title, children}: {tone: 'success' | 'error'; title?: ReactNode; children: ReactNode}) {
  const ok = tone === 'success';
  return (
    <div role={ok ? 'status' : 'alert'} className={cn('flex gap-2.5 rounded-xl px-4 py-3 text-sm', ok ? 'bg-green-50 text-green-800' : 'bg-rose-50 text-rose-800')}>
      {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div className="grid min-w-0 flex-1 gap-2">
        {title && <p className="font-semibold">{title}</p>}
        {typeof children === 'string' ? <p className="font-medium">{children}</p> : children}
      </div>
    </div>
  );
}

/** A failed call's message in the form's status line, unless it landed on the form's fields. */
export function FormError({error}: {error: Error | null | undefined}) {
  if (!error || onFields(error)) return null;
  return <FormNotice tone="error">{error.message || 'Something went wrong. Try again.'}</FormNotice>;
}
