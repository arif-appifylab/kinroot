/**
 * Calendar provider errors in words (Settings → Calendar shows them as the connection's "last
 * error"). The provider's own text never reaches the browser: it is logged here, short and
 * without tokens, and mapped by its HTTP status / OAuth error code to a sentence.
 */

/** An error from Google / Microsoft with what we can classify it by. */
export class CalendarCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'CalendarCallError';
  }
}

export const RECONNECT = 'Reconnect this calendar: its access was removed or expired.';
export const RATE_LIMITED = 'The calendar provider is limiting requests right now. Kinroot tries again in a few minutes.';
export const UNREACHABLE = 'The calendar provider did not answer in time. Kinroot tries again in a few minutes.';
export const NOT_CONFIGURED = 'The Google / Microsoft app for calendars is not set up. An admin can add it in Settings → Email.';
export const GENERIC = 'The calendar could not be synced. Try again later, or connect the calendar again.';

/** OAuth error codes that mean the grant is gone (revoked, expired, app removed). */
const DEAD_GRANT = new Set(['invalid_grant', 'unauthorized_client', 'invalid_client', 'interaction_required', 'consent_required', 'invalid_token']);

export function calendarErrorText(e: unknown): string {
  const err = e as {name?: string; message?: string; status?: number; code?: string | null; notConfigured?: boolean};
  if (err?.notConfigured) return NOT_CONFIGURED;
  if (err instanceof CalendarCallError) {
    if (err.code && DEAD_GRANT.has(err.code)) return RECONNECT;
    if (err.status === 401 || err.status === 403) return RECONNECT;
    if (err.status === 429) return RATE_LIMITED;
    if (err.status >= 500 || err.status === 408) return UNREACHABLE;
    // A 400 from the token endpoint is an OAuth error (expired or revoked refresh token).
    if (err.code) return RECONNECT;
    return GENERIC;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || (err?.name === 'TypeError' && /fetch|network/i.test(err.message ?? ''))) return UNREACHABLE;
  return GENERIC;
}

/** Logs the provider's raw text server-side (short; tokens are never part of these messages, cut anyway). */
export function logCalendarError(where: string, e: unknown) {
  const raw = String((e as Error)?.message ?? e)
    .replace(/(Bearer\s+)\S+/gi, '$1…')
    .slice(0, 200);
  const status = (e as {status?: number})?.status;
  console.error(`[calendar] ${where}${status ? ` (HTTP ${status})` : ''}: ${raw}`);
}
