import {type FormEvent, useEffect, useRef, useState} from 'react';

import {ApiError} from '@/lib/api';

/**
 * Kinroot's form rules (AGENTS.md "Buttons and forms") for forms whose state the screen already
 * keeps (`useState({...})`): the screen keeps its values, this keeps the errors.
 *
 *   const f = useFormState(form, {title: [is.required('Give the deal a name.')], value: [is.number({min: 0})]});
 *   <form {...f.form(() => create.mutate(undefined, {onError: f.fail}))}>
 *     <Field label="Deal name" error={f.error('title')}>
 *       <Input value={form.title} onChange={…} onBlur={f.blur('title')} />
 *     </Field>
 *
 * - An error shows after the field is left or after a submit, then updates while typing.
 * - Submit validates every field, focuses the first wrong one and sends nothing until all are right.
 * - The server's `422 {error, fields}` (or a 400 / 409 that names its field: `fieldError()` on the
 *   server) lands on its fields (`fail`); a server error clears when that field changes. Input is
 *   never cleared on an error.
 * The kit's `Field` wires the error to its control (`aria-invalid`, `aria-describedby`).
 */

/** Returns the words that say how to fix the value, or nothing when it is fine. */
export type Check<T, V> = (value: T, values: V) => string | null | undefined | false;
export type FormRules<V> = {[K in keyof V]?: Check<V[K], V>[]};

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** Shared rules; empty values pass every rule but `required` (pair them when a value is needed). */
export const is = {
  required:
    (message = 'This field is required.') =>
    (v: unknown) =>
      v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) ? message : null,
  maxLength:
    (max: number, message = `Use at most ${max} characters.`) =>
    (v: unknown) =>
      text(v).length > max ? message : null,
  email:
    (message = 'Enter a valid email address, like name@example.com.') =>
    (v: unknown) =>
      text(v) && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text(v)) ? message : null,
  url:
    (message = 'Enter a full web address that starts with https://') =>
    (v: unknown) => {
      const s = text(v);
      if (!s) return null;
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:' ? null : message;
      } catch {
        return message;
      }
    },
  number:
    ({min, max, integer, message}: {min?: number; max?: number; integer?: boolean; message?: string} = {}) =>
    (v: unknown) => {
      const s = text(v);
      if (!s) return null;
      const n = Number(s);
      const range = min !== undefined && max !== undefined ? ` between ${min} and ${max}` : min !== undefined ? ` of ${min} or more` : max !== undefined ? ` of ${max} or less` : '';
      const words = message ?? `Enter ${integer ? 'a whole number' : 'a number'}${range}.`;
      if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return words;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) return words;
      return null;
    },
  pattern:
    (re: RegExp, message: string) =>
    (v: unknown) =>
      text(v) && !re.test(text(v)) ? message : null,
};

export function useFormState<V extends Record<string, unknown>>(values: V, rules: FormRules<V> = {}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const [touched, setTouched] = useState<Partial<Record<keyof V, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<{errors: Record<string, string>; at: V} | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  // After a failed submit (or a 422), focus the first wrong field in the form.
  useEffect(() => {
    if (!focusTick) return;
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const check = (name: keyof V) => {
    for (const rule of rules[name] ?? []) {
      const message = rule(values[name], values);
      if (message) return message;
    }
    return undefined;
  };
  const fromServer = (name: keyof V) => (server && Object.is(server.at[name], values[name]) ? server.errors[name as string] : undefined);
  const error = (name: keyof V): string | undefined => fromServer(name) ?? (touched[name] || submitted ? check(name) : undefined);

  const submit = (onValid: () => void) => (event?: FormEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    setSubmitted(true);
    setServer(null);
    if ((Object.keys(rules) as (keyof V)[]).some((name) => check(name))) {
      setFocusTick((t) => t + 1);
      return;
    }
    onValid();
  };

  return {
    /** Attach to the `<form>` (or the element holding the fields) so the first wrong field can be focused. */
    ref,
    error,
    /** The field's error has something to say (after a blur or submit). */
    invalid: (name: keyof V) => !!error(name),
    /** True when every rule passes (for a submit button outside a form, say). */
    valid: () => !(Object.keys(rules) as (keyof V)[]).some((name) => check(name)),
    /** A server error on a nested key (`custom.region`): clears when its top-level value (`custom`) changes. */
    nested: (name: string): string | undefined => {
      const top = name.split('.')[0] as keyof V;
      return server && Object.is(server.at[top], values[top]) ? server.errors[name] : undefined;
    },
    /** `onBlur` for the field's control: its error shows from now on. */
    blur: (name: keyof V) => () => setTouched((t) => (t[name] ? t : {...t, [name]: true})),
    submit,
    /** Props for the `<form>`: no browser popups, validate all, focus the first wrong field. */
    form: (onValid: () => void) => ({ref, noValidate: true, onSubmit: submit(onValid)}),
    /**
     * Pass as a mutation's `onError`: puts the server's `422 {fields}` on their fields; true when it did.
     * False when none of them is a field of this form (`start` on a form without it): the caller shows
     * the words elsewhere instead of losing them.
     */
    fail: (e: unknown) => {
      if (!(e instanceof ApiError) || !Object.keys(e.fields).some((name) => name.split('.')[0]! in values)) return false;
      // A list item's error (`blockedDomains.2`) also lands on its list's field (`blockedDomains`).
      const errors = {...e.fields};
      for (const [name, message] of Object.entries(e.fields)) errors[name.split('.')[0]!] ??= message;
      setServer({errors, at: values});
      setFocusTick((t) => t + 1);
      return true;
    },
    reset: () => {
      setTouched({});
      setSubmitted(false);
      setServer(null);
    },
  };
}

export type FormState<V extends Record<string, unknown>> = ReturnType<typeof useFormState<V>>;
