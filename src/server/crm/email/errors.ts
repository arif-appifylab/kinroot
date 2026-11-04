/**
 * Mailbox errors in words (Settings → Email shows them as the account's "last error"), like
 * `calendar/errors.ts`. The provider's own text never reaches the browser: it is logged here,
 * short and without tokens, and mapped by its HTTP status / OAuth error code to a sentence.
 * Sentences Kinroot wrote itself (a missing secret, SMTP not offered: `MailboxSetupError`) are
 * shown as they are.
 */

/** An error from Gmail / Microsoft Graph / an email API / an OAuth token endpoint, with what we classify it by. */
export class MailboxCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'MailboxCallError';
  }
}

/** Kinroot's own words about the account's setup: shown as they are; a retry won't help (`permanent`). */
export class MailboxSetupError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'MailboxSetupError';
  }
}

export const RECONNECT = 'Reconnect this mailbox: its access was removed or expired, or its key is no longer valid.';
export const RATE_LIMITED = 'The email provider is limiting requests right now. Kinroot tries again in a few minutes.';
export const UNREACHABLE = 'The email provider did not answer in time. Kinroot tries again in a few minutes.';
export const NOT_CONFIGURED = 'The Google / Microsoft app for email is not set up. An admin can add it in Settings → Email.';
export const REFUSED = 'The email provider refused the request. Check that the sender address and its domain are verified with the provider.';
export const GENERIC = 'The mailbox could not be reached. Try again later, or connect it again.';

/** OAuth error codes that mean the grant is gone (revoked, expired, app removed). */
const DEAD_GRANT = new Set(['invalid_grant', 'unauthorized_client', 'invalid_client', 'interaction_required', 'consent_required', 'invalid_token']);

export function mailboxErrorText(e: unknown): string {
  const err = e as {name?: string; message?: string; status?: number; code?: string | null; notConfigured?: boolean};
  if (err instanceof MailboxSetupError) return err.message;
  if (err?.notConfigured) return NOT_CONFIGURED;
  if (err instanceof MailboxCallError) {
    if (err.code && DEAD_GRANT.has(err.code)) return RECONNECT;
    if (err.status === 401 || err.status === 403) return RECONNECT;
    if (err.status === 429) return RATE_LIMITED;
    if (err.status >= 500 || err.status === 408) return UNREACHABLE;
    // A 400 from the token endpoint is an OAuth error (expired or revoked refresh token).
    if (err.code) return RECONNECT;
    if (err.status >= 400) return REFUSED;
    return GENERIC;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || (err?.name === 'TypeError' && /fetch|network/i.test(err.message ?? ''))) return UNREACHABLE;
  return GENERIC;
}

/** Logs the provider's raw text server-side: short, tokens cut, email addresses masked (`m•••@domain`). */
export function logMailboxError(where: string, e: unknown) {
  if (e instanceof MailboxSetupError) return;
  const raw = String((e as Error)?.message ?? e)
    .replace(/(Bearer\s+)\S+/gi, '$1…')
    .replace(/(key|token|secret)=\S+/gi, '$1=…')
    .replace(/([^\s@<>"',;:]+)@([^\s@<>"',;]+)/g, (_, user: string, domain: string) => `${user.charAt(0)}•••@${domain}`)
    .slice(0, 200);
  const status = (e as {status?: number})?.status;
  console.error(`[mailbox] ${where}${status ? ` (HTTP ${status})` : ''}: ${raw}`);
}
