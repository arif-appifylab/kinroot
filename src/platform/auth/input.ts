/**
 * Pure input helpers for the auth routes (no runtime imports: unit-tested).
 */

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max + 1) : '');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@.]{2,63}$/;

/** Trimmed, lower-cased, or null when it cannot be an email address. */
export function normalizeEmail(value: unknown): string | null {
  const email = text(value, 254).toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** A same-site PATH to go to after signing in; anything else falls back. */
export function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\\]/.test(value)) return fallback;
  return value;
}
