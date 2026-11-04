import {describe, expect, it} from 'vitest';

import {CalendarCallError, calendarErrorText, GENERIC, NOT_CONFIGURED, RATE_LIMITED, RECONNECT, UNREACHABLE} from '../src/server/crm/calendar/errors';

/** AUDIT P2-17: a calendar's sync error is shown in words, never the provider's own text. */
describe('calendar errors in words', () => {
  it('maps expired or revoked access to "reconnect"', () => {
    expect(calendarErrorText(new CalendarCallError('Token has been expired or revoked.', 400, 'invalid_grant'))).toBe(RECONNECT);
    expect(calendarErrorText(new CalendarCallError('Google Calendar: Invalid Credentials', 401))).toBe(RECONNECT);
    expect(calendarErrorText(new CalendarCallError('Microsoft Graph: Access denied', 403))).toBe(RECONNECT);
  });

  it('maps rate limits, outages and timeouts', () => {
    expect(calendarErrorText(new CalendarCallError('Rate Limit Exceeded', 429))).toBe(RATE_LIMITED);
    expect(calendarErrorText(new CalendarCallError('Backend Error', 503))).toBe(UNREACHABLE);
    expect(calendarErrorText(Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}))).toBe(UNREACHABLE);
    expect(calendarErrorText(new TypeError('fetch failed'))).toBe(UNREACHABLE);
  });

  it('says when the app is not set up, and something generic for the rest', () => {
    expect(calendarErrorText(Object.assign(new Error('Google OAuth app is not configured'), {notConfigured: true}))).toBe(NOT_CONFIGURED);
    expect(calendarErrorText(new CalendarCallError('Google Calendar: Bad Request <secret details>', 400))).toBe(GENERIC);
    expect(calendarErrorText(new Error('Unexpected token < in JSON'))).toBe(GENERIC);
    for (const text of [RECONNECT, RATE_LIMITED, UNREACHABLE, NOT_CONFIGURED, GENERIC]) expect(text.length).toBeLessThanOrEqual(500);
  });
});
