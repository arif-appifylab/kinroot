import {PASSWORD_LIMITS} from '../platform/auth/password';

/**
 * The new-password rules as a list people can tick off while they type, so
 * they know the rules before they submit, not from an error afterwards.
 * Mirrors `passwordProblem` in `src/platform/auth/password.ts`; the server
 * still checks everything (and also turns away the most common passwords).
 *
 * Shared by the website's forms (`bindPasswordChecks`, below) and the portal
 * (`PasswordChecks` in `src/portal/ui/form.tsx`).
 */
export interface PasswordCheck {
  id: string;
  label: string;
  ok: boolean;
}

export function passwordChecks(password: string, email = ''): PasswordCheck[] {
  const checks: PasswordCheck[] = [
    {
      id: 'length',
      label: `At least ${PASSWORD_LIMITS.min} characters`,
      ok: password.length >= PASSWORD_LIMITS.min && !!password.trim(),
    },
  ];
  // Only shown to the few who reach it.
  if (password.length > PASSWORD_LIMITS.max) {
    checks.push({id: 'max', label: `At most ${PASSWORD_LIMITS.max} characters`, ok: false});
  }
  // The same test as the server: the part before the @, when it is 4+ letters.
  const name = email.trim().toLowerCase().split('@')[0] ?? '';
  if (name.length >= 4) {
    checks.push({
      id: 'email',
      label: 'Not your email address',
      ok: !!password && !password.toLowerCase().includes(name),
    });
  }
  return checks;
}

export function matchCheck(password: string, confirm: string): PasswordCheck {
  return {id: 'match', label: 'Both passwords match', ok: !!confirm && confirm === password};
}

/** BROWSER: fills a `<ul class="pw-checks">` with the checks, ticking them off. */
export function renderChecks(list: HTMLElement, checks: PasswordCheck[]): void {
  list.replaceChildren(
    ...checks.map(check => {
      const item = document.createElement('li');
      if (check.ok) item.dataset.ok = '';
      const state = document.createElement('span');
      state.className = 'pw-checks-state';
      state.textContent = check.ok ? ' (done)' : ' (not yet)';
      item.append(check.label, state);
      return item;
    }),
  );
}

interface BindOptions {
  /** The email field, for the "not your email address" rule. */
  email?: HTMLInputElement | null;
  /** The "type it again" field and its own list, for "Both passwords match". */
  confirm?: HTMLInputElement | null;
  confirmList?: HTMLElement | null;
}

/**
 * BROWSER: keeps a password field's checklist live. The list shows from the
 * start; after a submit, rules still missing turn red (`data-tried`).
 */
export function bindPasswordChecks(input: HTMLInputElement, list: HTMLElement, options: BindOptions = {}): void {
  const {email, confirm, confirmList} = options;
  const update = () => {
    renderChecks(list, passwordChecks(input.value, email?.value ?? ''));
    if (confirm && confirmList) {
      const show = !!confirm.value || confirmList.hasAttribute('data-tried');
      confirmList.hidden = !show;
      if (show) renderChecks(confirmList, [matchCheck(input.value, confirm.value)]);
    }
  };
  for (const field of [input, email, confirm]) field?.addEventListener('input', update);
  input.form?.addEventListener('submit', () => {
    list.setAttribute('data-tried', '');
    confirmList?.setAttribute('data-tried', '');
    update();
  });
  update();
}

/** BROWSER: a show / hide button for every `[data-reveal-password]` in `root`. */
export function bindPasswordReveal(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-reveal-password]').forEach(button => {
    const input = document.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLInputElement | null;
    if (!input) return;
    button.hidden = false;
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.textContent = show ? 'Hide' : 'Show';
      button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
}
