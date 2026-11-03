import {useRef, useState, type FormEvent} from 'react';

import type {SubmitResult} from '../../../lib/form';
import type {Rule} from '../../../lib/rules';

/**
 * The sign-in pages' form controller: the React twin of `bindForm` (src/lib/form.ts), with the same
 * rules (AGENTS.md "Buttons and forms") and the same shared field rules (src/lib/rules.ts), so the
 * browser says exactly what the server checks:
 *
 * - a field's error shows on blur, then live while typing; submit shows every error, focuses the
 *   first wrong field and sends nothing until all pass
 * - the submit button is pending (and disabled) while sending, and comes back on failure; a success
 *   that redirects keeps it pending while the next page loads
 * - the server's field errors (`fields`) land on their fields, other errors in the status line
 */
export type Values<N extends string> = Record<N, string>;
export type Status = {kind: 'error' | 'ok'; message: string} | null;

interface Options<N extends string> {
  /** Ids are `${idPrefix}-${name}`: focus and `aria-describedby` use them. */
  idPrefix: string;
  initial: Values<N>;
  /** The rules for each field; a function of all values for rules that compare fields. */
  rules: (values: Values<N>) => Partial<Record<N, Rule[]>>;
  submit: (values: Values<N>) => Promise<SubmitResult>;
}

export function useAuthForm<N extends string>({idPrefix, initial, rules, submit}: Options<N>) {
  const [values, setValues] = useState<Values<N>>(initial);
  const [touched, setTouched] = useState<Partial<Record<N, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<N, string>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  // A second press while the first is on its way never sends twice (state updates are not instant).
  const sending = useRef(false);

  const names = Object.keys(initial) as N[];
  const id = (name: N) => `${idPrefix}-${name}`;

  const check = (name: N, all: Values<N> = values, server = serverErrors): string | null => {
    if (server[name]) return server[name]!;
    for (const rule of rules(all)[name] ?? []) {
      const message = rule(all[name] ?? '');
      if (message) return message;
    }
    return null;
  };

  const error = (name: N): string | null => (touched[name] || submitted || serverErrors[name] ? check(name) : null);

  const focus = (name: N) => document.getElementById(id(name))?.focus();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    setSubmitted(true);
    setStatus(null);
    const first = names.find((name) => check(name));
    if (first) {
      focus(first);
      return;
    }
    sending.current = true;
    setPending(true);
    let result: SubmitResult;
    try {
      result = await submit(values);
    } catch {
      result = {ok: false, message: 'The site did not answer. Check your connection and try again.'};
    }
    if (result.ok && result.redirect) {
      // Keep the button pending: the next page is on its way.
      window.location.assign(result.redirect);
      return;
    }
    sending.current = false;
    setPending(false);
    if (result.ok) {
      if (result.message) setStatus({kind: 'ok', message: result.message});
      return;
    }
    const fields = Object.entries(result.fields ?? {}).filter(([name]) => names.includes(name as N)) as [N, string][];
    if (fields.length) {
      setServerErrors(Object.fromEntries(fields) as Partial<Record<N, string>>);
      focus(fields[0]![0]);
    } else if (result.message) {
      setStatus({kind: 'error', message: result.message});
    }
  }

  /** Props for a field's input: value, events and the ARIA state that ties it to its error. */
  function input(name: N, describedBy?: string) {
    const message = error(name);
    const described = [message ? `${id(name)}-error` : null, describedBy].filter(Boolean).join(' ');
    return {
      id: id(name),
      name,
      value: values[name],
      onChange: (e: {target: {value: string}}) => {
        const value = e.target.value;
        setValues((v) => ({...v, [name]: value}));
        if (serverErrors[name]) setServerErrors(({[name]: _, ...rest}) => rest as Partial<Record<N, string>>);
      },
      onBlur: () => setTouched((t) => ({...t, [name]: true})),
      'aria-invalid': message ? true : undefined,
      'aria-describedby': described || undefined,
    };
  }

  const set = (name: N, value: string) => setValues((v) => ({...v, [name]: value}));

  /** Back to a fresh form (a step shown again): no values, errors or status left from before. */
  const reset = () => {
    setValues(initial);
    setTouched({});
    setServerErrors({});
    setSubmitted(false);
    setStatus(null);
  };

  return {values, set, reset, input, error, id, pending, status, setStatus, submitted, onSubmit, focus};
}

export type AuthForm<N extends string> = ReturnType<typeof useAuthForm<N>>;
