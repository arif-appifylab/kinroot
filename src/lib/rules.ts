/**
 * Pure field rules, shared by the portal (`useForm` in `src/portal/ui/form.tsx`)
 * and the website's forms (`bindForm` in `src/lib/form.ts`). A rule returns
 * the error message when the value is wrong, `null` when it is fine. Mirror
 * the server's limits exactly; the server always checks again.
 */
import {PASSWORD_LIMITS} from '../platform/auth/password';
import {passwordChecks} from './password-checks';

export type Rule = (value: string) => string | null;

export const rules = {
  required:
    (message = 'This field is required.'): Rule =>
    value =>
      value.trim() ? null : message,
  maxLength:
    (max: number, message = `Use at most ${max} characters.`): Rule =>
    value =>
      value.trim().length <= max ? null : message,
  minLength:
    (min: number, message = `Use at least ${min} characters.`): Rule =>
    value =>
      !value.trim() || value.trim().length >= min ? null : message,
  email:
    (message = 'Enter a valid email address, like name@example.com.'): Rule =>
    value =>
      !value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) ? null : message,
  pattern:
    (re: RegExp, message: string): Rule =>
    value =>
      !value.trim() || re.test(value.trim()) ? null : message,
  wholeNumber:
    (message = 'Use whole numbers only, like 2500.'): Rule =>
    value =>
      !value.trim() || /^\d+$/.test(value.trim()) ? null : message,
  /** A NEW password: the same length limits as `src/platform/auth/password.ts`. */
  newPassword: (): Rule => value =>
    !value
      ? 'Choose a password.'
      : value.length < PASSWORD_LIMITS.min
        ? `Use at least ${PASSWORD_LIMITS.min} characters.`
        : value.length > PASSWORD_LIMITS.max
          ? `Use at most ${PASSWORD_LIMITS.max} characters.`
          : null,
  /**
   * A NEW password shown with its live checklist (`src/lib/password-checks.ts`):
   * the list says which rule is missing, so the error only points to it.
   */
  passwordMeetsRules:
    (email: () => string = () => ''): Rule =>
    value =>
      !value
        ? 'Choose a password.'
        : passwordChecks(value, email()).every(check => check.ok)
          ? null
          : 'Your password does not meet every rule below yet.',
};

export const {passwordMeetsRules} = rules;

/** Rules shared by the sign-in forms, so every page says the same thing. */
export const AUTH_RULES = {
  name: [rules.required('Enter your name.'), rules.maxLength(80)],
  email: [rules.required('Enter your email address.'), rules.email(), rules.maxLength(254)],
  password: [rules.required('Enter your password.')],
  newPassword: [rules.newPassword()],
};
