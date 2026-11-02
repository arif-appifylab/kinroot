import type {Rule} from './rules';

/**
 * BROWSER: the website's form controller, for `.astro` pages (the portal uses
 * `useForm` in React). It applies the template's form rules (AGENTS.md
 * "Buttons and forms") to a plain `<form novalidate>`:
 *
 * - every field validates IN PLACE: on blur, then on every keystroke once
 *   shown; the error sits under the field (`aria-invalid`, `aria-describedby`)
 * - submit validates everything, shows every error, focuses the first wrong
 *   field and sends nothing until all pass
 * - the submit button shows a spinner and a pending label, is `aria-busy`
 *   and disabled while sending, and comes back on failure
 * - the server's field errors land on their fields; other errors in the
 *   form's `[data-form-status]` line, in words; never an `alert()`
 *
 * Markup per field: `<div class="field"><label for="x">…</label><input id="x" name="x">`
 * plus an optional `<p class="field-hint" id="x-hint">`. Something that must stay
 * described whatever the state (a password's live rules) names its id in the
 * input's `data-describedby`.
 */
export type SubmitResult =
  | {ok: true; message?: string; redirect?: string}
  | {ok: false; message?: string; fields?: Record<string, string>};

interface Options {
  rules: Record<string, Rule[]>;
  pendingLabel: string;
  submit: (values: Record<string, string>) => Promise<SubmitResult>;
  /** Called after a success that did not redirect (e.g. to swap the form for a message). */
  done?: (message: string | undefined) => void;
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const describedBy = (input: Control, id: string) => [id, input.dataset.describedby].filter(Boolean).join(' ');

export function bindForm(form: HTMLFormElement, options: Options): void {
  form.noValidate = true;
  const status = form.querySelector<HTMLElement>('[data-form-status]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const idle = button?.innerHTML ?? '';
  const touched = new Set<string>();
  const serverErrors = new Map<string, string>();
  let submitted = false;

  const control = (name: string) => form.elements.namedItem(name) as Control | null;

  const check = (name: string): string | null => {
    const server = serverErrors.get(name);
    if (server) return server;
    const value = control(name)?.value ?? '';
    for (const rule of options.rules[name] ?? []) {
      const message = rule(value);
      if (message) return message;
    }
    return null;
  };

  const show = (name: string, message: string | null) => {
    const input = control(name);
    if (!input) return;
    const field = input.closest('.field');
    const id = `${input.id}-error`;
    let note = document.getElementById(id);
    if (message) {
      if (!note) {
        note = document.createElement('p');
        note.id = id;
        note.className = 'field-error';
        note.setAttribute('role', 'alert');
        (field ?? input.parentElement)?.append(note);
      }
      note.textContent = message;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', describedBy(input, id));
      field?.setAttribute('data-invalid', '');
      const hint = document.getElementById(`${input.id}-hint`);
      if (hint) hint.hidden = true;
    } else {
      note?.remove();
      input.removeAttribute('aria-invalid');
      field?.removeAttribute('data-invalid');
      const hint = document.getElementById(`${input.id}-hint`);
      if (hint) {
        hint.hidden = false;
        input.setAttribute('aria-describedby', describedBy(input, hint.id));
      } else if (input.dataset.describedby) {
        input.setAttribute('aria-describedby', input.dataset.describedby);
      } else {
        input.removeAttribute('aria-describedby');
      }
    }
  };

  const say = (message: string, kind: 'error' | 'ok') => {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.className = kind === 'error' ? 'notice notice-error' : 'notice notice-ok';
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };

  for (const name of Object.keys(options.rules)) {
    const input = control(name);
    if (!input) continue;
    input.addEventListener('blur', () => {
      touched.add(name);
      show(name, check(name));
    });
    input.addEventListener('input', () => {
      serverErrors.delete(name);
      if (touched.has(name) || submitted) show(name, check(name));
    });
  }

  const setPending = (pending: boolean) => {
    if (!button) return;
    button.disabled = pending;
    if (pending) {
      button.setAttribute('aria-busy', 'true');
      button.replaceChildren();
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      button.append(spinner, document.createTextNode(options.pendingLabel));
    } else {
      button.removeAttribute('aria-busy');
      button.innerHTML = idle;
    }
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button?.disabled) return;
    submitted = true;
    say('', 'ok');
    const names = Object.keys(options.rules);
    let first: string | null = null;
    for (const name of names) {
      const message = check(name);
      show(name, message);
      if (message && !first) first = name;
    }
    if (first) {
      control(first)?.focus();
      return;
    }
    const values: Record<string, string> = {};
    for (const [name, value] of new FormData(form)) if (typeof value === 'string') values[name] = value;

    setPending(true);
    let result: SubmitResult;
    try {
      result = await options.submit(values);
    } catch {
      result = {ok: false, message: 'The site did not answer. Check your connection and try again.'};
    }
    if (result.ok && result.redirect) {
      // Keep the button pending: the next page is on its way.
      window.location.assign(result.redirect);
      return;
    }
    setPending(false);
    if (result.ok) {
      if (result.message) say(result.message, 'ok');
      options.done?.(result.message);
      return;
    }
    let focused = false;
    for (const [name, message] of Object.entries(result.fields ?? {})) {
      if (!control(name)) continue;
      serverErrors.set(name, message);
      show(name, message);
      if (!focused) {
        control(name)?.focus();
        focused = true;
      }
    }
    if (result.message && !focused) say(result.message, 'error');
  });
}

/**
 * POSTs JSON to a Site API route and maps the answer to a `SubmitResult`:
 * `{error, message, fields}` problems become field errors or a status line.
 */
export async function postJson(
  send: (path: string, init: RequestInit) => Promise<Response>,
  path: string,
  body: unknown
): Promise<{res: Response | null; data: Record<string, unknown> | null; result: SubmitResult}> {
  let res: Response;
  try {
    res = await send(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  } catch {
    return {res: null, data: null, result: {ok: false, message: 'The site did not answer. Check your connection and try again.'}};
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return {res, data, result: {ok: true, message: typeof data?.message === 'string' ? data.message : undefined}};
  return {
    res,
    data,
    result: {
      ok: false,
      message: typeof data?.message === 'string' ? data.message : `Something went wrong (${res.status}). Try again.`,
      fields: (data?.fields as Record<string, string> | undefined) ?? undefined,
    },
  };
}
