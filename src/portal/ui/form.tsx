import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
  useRef,
  useState,
} from 'react';

import {type PasswordCheck} from '../../lib/password-checks';
import {type Rule, rules} from '../../lib/rules';
import {Icon} from './icon';

/**
 * Form controls. EVERY field in the portal uses these (AGENTS.md "Buttons and
 * forms"): a field always has a visible label and shows its own error in
 * place, in words, never a browser bubble. Text inputs and textareas are
 * plain `<input>` / `<textarea>` inside a `Field`, wired with
 * `{...form.field('name')}`; `.field` styles them.
 */

// ----------------------------------------------------------------- fields --

/**
 * One labelled field: the label, the control, a hint, and its error IN PLACE.
 * The control gets its wiring from `form.field(name)` (id, value, onChange,
 * onBlur, aria-invalid, aria-describedby).
 */
export function Field({
  label,
  hint,
  error,
  id,
  optional,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  id: string;
  optional?: boolean;
  children: ReactElement;
}) {
  return (
    <div className="field" data-invalid={error ? '' : undefined}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="muted"> (optional)</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------- passwords --

/**
 * A new-password input with a show / hide button. Spread `form.field(name)`
 * into it as into an `<input>`. Pair it with `PasswordChecks` so the rules
 * show while typing (`src/lib/password-checks.ts`).
 */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement> & {ref?: (node: HTMLInputElement | null) => void}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-input">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        className="pw-reveal"
        type="button"
        aria-controls={props.id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown(value => !value)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** The live rules under a password field; missing ones turn red once `tried`. */
export function PasswordChecks({id, checks, tried}: {id: string; checks: PasswordCheck[]; tried?: boolean}) {
  return (
    <ul className="pw-checks" id={id} data-tried={tried ? '' : undefined}>
      {checks.map(check => (
        <li key={check.id} data-ok={check.ok ? '' : undefined}>
          {check.label}
          <span className="pw-checks-state">{check.ok ? ' (done)' : ' (not yet)'}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- validation --

// Pure rules live in `src/lib/rules.ts` (shared with the website's forms).
export {rules, type Rule};

type Values = Record<string, string | boolean>;
type Schema<V extends Values> = Partial<Record<keyof V, Rule[]>>;
type Errors<V extends Values> = Partial<Record<keyof V, string>>;

/**
 * A small form state: values, per-field errors, when to show them.
 *
 * - An error shows after the field is left (blur) or after a submit attempt,
 *   never while the visitor is still typing their first value; once shown it
 *   updates on every keystroke, so it disappears the moment the value is right.
 * - `submit(onValid)` validates everything, shows every error, focuses the
 *   first wrong field, and only then calls `onValid`.
 * - `setServerErrors` puts the server's answer on the fields it names.
 */
export function useForm<V extends Values>(initial: V, schema: Schema<V>) {
  const [values, setValues] = useState<V>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof V, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<Errors<V>>({});
  const refs = useRef<Partial<Record<keyof V, HTMLElement | null>>>({});

  const check = (name: keyof V, all: V = values): string | undefined => {
    const value = all[name];
    if (typeof value !== 'string') return undefined;
    for (const rule of schema[name] ?? []) {
      const message = rule(value);
      if (message) return message;
    }
    return undefined;
  };
  const errorOf = (name: keyof V) =>
    touched[name] || submitted ? (server[name] ?? check(name)) : server[name];

  const set = <K extends keyof V>(name: K, value: V[K]) => {
    setValues(current => ({...current, [name]: value}));
    setServer(current => ({...current, [name]: undefined}));
  };

  /** Everything a text input, textarea or select needs. */
  const field = (name: keyof V & string) => {
    const error = errorOf(name);
    const id = `f-${name}`;
    return {
      id,
      name,
      value: String(values[name] ?? ''),
      ref: (node: HTMLElement | null) => {
        refs.current[name] = node;
      },
      onChange: (event: {target: {value: string}}) => set(name, event.target.value as V[typeof name]),
      onBlur: () => setTouched(current => ({...current, [name]: true})),
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? `${id}-error` : `${id}-hint`,
    };
  };

  const submit = (onValid: (values: V) => void) => (event?: FormEvent) => {
    event?.preventDefault();
    setSubmitted(true);
    const first = (Object.keys(schema) as (keyof V)[]).find(name => check(name));
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
    set,
    field,
    error: errorOf,
    submit,
    reset,
    setServerErrors: (errors: Errors<V>) => setServer(errors),
  };
}

// ---------------------------------------------------------------- choices --

/**
 * A dropdown for a LONG list (countries, time zones, 6+ options). Five or
 * fewer options: `RadioCards` (every choice visible, with an explanation).
 * Spread `form.field(name)` into it like an `<input>`.
 */
export function Select({
  options,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: {value: string; label: string}[];
  ref?: (node: HTMLElement | null) => void;
}) {
  return (
    <span className="select">
      <select {...props}>
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevrons-up-down" size={16} className="select-chevron" />
    </span>
  );
}

/** A checkbox with its label (and an optional line under it). */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox" data-disabled={disabled ? '' : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>
        <span className="checkbox-label">{label}</span>
        {description && <span className="checkbox-description">{description}</span>}
      </span>
    </label>
  );
}

/**
 * An on / off setting that applies AT ONCE (no Save button): "Remote",
 * "Email me a weekly summary". A choice that is saved with a form is a
 * `Checkbox`. While saving, pass `pending`: the switch is disabled.
 */
export function Switch({
  label,
  description,
  checked,
  onChange,
  disabled,
  pending,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <span className="switch-text">
        <span className="switch-label" id={`${id}-label`}>
          {label}
        </span>
        {description && (
          <span className="switch-description" id={`${id}-description`}>
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-busy={pending || undefined}
        disabled={disabled || pending}
        onClick={() => onChange(!checked)}>
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Two to five choices, each one visible with a title, a line of explanation
 * and a tick on the picked one. Use it instead of a dropdown for short lists.
 */
export function RadioCards<V extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  columns = 2,
}: {
  legend: ReactNode;
  name: string;
  value: V;
  onChange: (value: V) => void;
  options: {value: V; title: ReactNode; description?: ReactNode; disabled?: boolean}[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <fieldset className="radio-cards">
      <legend>{legend}</legend>
      <div className={`radio-cards-grid cols-${columns}`}>
        {options.map(option => (
          <label key={option.value} className="radio-card" data-disabled={option.disabled ? '' : undefined}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="radio-card-body">
              <span className="radio-card-title">{option.title}</span>
              {option.description && <span className="radio-card-description">{option.description}</span>}
            </span>
            <span className="radio-card-tick" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A search box for a toolbar: an icon, a visible-to-screen-readers label. */
export function SearchInput({label, ...props}: InputHTMLAttributes<HTMLInputElement> & {label: string}) {
  return (
    <span className="search-input">
      <Icon name="search" size={16} />
      <input type="search" aria-label={label} {...props} />
    </span>
  );
}
