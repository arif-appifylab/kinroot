import {describe, expect, it} from 'vitest';

import {verifyOutcome} from '../src/lib/verify-outcome';

describe('verifyOutcome (confirm-email page, PIPE-10)', () => {
  it('an ordinary confirmation offers Sign in', () => {
    const out = verifyOutcome({
      ok: true,
      message: 'Your email is confirmed. You can sign in now.',
    });
    expect(out.message).toBe('Your email is confirmed. You can sign in now.');
    expect(out.link).toEqual({href: '/account/login/', text: 'Sign in'});
  });

  it('an owner address whose password was dropped points to the inbox, with no Sign in link', () => {
    const out = verifyOutcome({
      ok: true,
      setPassword: true,
      message: 'We sent you a link to choose your password.',
    });
    expect(out.message).toBe('We sent you a link to choose your password.');
    expect(out.link).toBeUndefined();
  });

  it('falls back to its own words when the answer has no message', () => {
    expect(verifyOutcome({ok: true, setPassword: true}).message).toMatch(/inbox/);
    expect(verifyOutcome(null).link?.href).toBe('/account/login/');
  });
});
