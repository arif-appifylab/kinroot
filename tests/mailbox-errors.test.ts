import {describe, expect, it, vi} from 'vitest';

import {GENERIC, logMailboxError, MailboxCallError, mailboxErrorText, MailboxSetupError, NOT_CONFIGURED, RATE_LIMITED, RECONNECT, REFUSED, UNREACHABLE} from '../src/server/crm/email/errors';

/** A mailbox's sync / send error is shown in words, never the provider's own text (like calendar-errors.test.ts). */
describe('mailbox errors in words', () => {
  it('maps expired or revoked access to "reconnect"', () => {
    expect(mailboxErrorText(new MailboxCallError('Token has been expired or revoked.', 400, 'invalid_grant'))).toBe(RECONNECT);
    expect(mailboxErrorText(new MailboxCallError('Gmail: Request had invalid authentication credentials.', 401))).toBe(RECONNECT);
    expect(mailboxErrorText(new MailboxCallError('Microsoft Graph: Access is denied.', 403))).toBe(RECONNECT);
    expect(mailboxErrorText(new MailboxCallError('AADSTS70000: something about the grant', 400, 'unknown_oauth_code'))).toBe(RECONNECT);
  });

  it('maps rate limits, outages and timeouts', () => {
    expect(mailboxErrorText(new MailboxCallError('Gmail: User-rate limit exceeded', 429))).toBe(RATE_LIMITED);
    expect(mailboxErrorText(new MailboxCallError('Microsoft Graph: Service unavailable', 503))).toBe(UNREACHABLE);
    expect(mailboxErrorText(Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}))).toBe(UNREACHABLE);
    expect(mailboxErrorText(new TypeError('fetch failed'))).toBe(UNREACHABLE);
  });

  it('says when the app is not set up, keeps Kinroot’s own words, and is generic for the rest', () => {
    expect(mailboxErrorText(Object.assign(new Error('Google OAuth app is not configured'), {notConfigured: true}))).toBe(NOT_CONFIGURED);
    const own = new MailboxSetupError('Add the RESEND_API_KEY secret in the site dashboard to send with Resend.');
    expect(mailboxErrorText(own)).toBe(own.message);
    expect(own.permanent).toBe(true);
    expect(mailboxErrorText(new MailboxCallError('Resend 422: The gmail.com domain is not verified <secret details>', 422))).toBe(REFUSED);
    expect(mailboxErrorText(new Error('Unexpected token < in JSON'))).toBe(GENERIC);
    for (const text of [RECONNECT, RATE_LIMITED, UNREACHABLE, NOT_CONFIGURED, REFUSED, GENERIC]) expect(text.length).toBeLessThanOrEqual(500);
  });
});

describe('mailbox error log', () => {
  it('logs the provider text short, with tokens cut and addresses masked', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    logMailboxError('send RESEND', new MailboxCallError('Resend 422: Invalid `to` field: maria.lopez@client.example (Bearer abc.def)', 422));
    logMailboxError('verify', new MailboxSetupError('Add the RESEND_API_KEY secret'));
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('m•••@client.example');
    expect(lines[0]).not.toContain('maria.lopez');
    expect(lines[0]).not.toContain('abc.def');
    expect(lines[0]).toContain('(HTTP 422)');
  });
});
