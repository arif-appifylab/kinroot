import {describe, expect, it} from 'vitest';

import {serializeCookie} from '../src/platform/auth/cookies';
import {bridgedCookieHeader, mirroredSetCookies} from '../src/platform/auth/preview-cookies';

describe('preview cookies (the editor Preview only)', () => {
  it('mirrors the auth cookies a response sets, with their lifetime, exactly as sent', () => {
    const lines = [
      serializeCookie('site_at', 'a.b.c', 'https://4321-sbx.example.dev/', {maxAgeSeconds: 600, httpOnly: true}),
      serializeCookie('site_rt', 'r/t+=', 'https://4321-sbx.example.dev/', {maxAgeSeconds: 2_592_000, httpOnly: true}),
      serializeCookie('site_csrf', 'tok', 'http://localhost:4321/', {maxAgeSeconds: 0, httpOnly: false}),
      'theme=dark; Path=/; Max-Age=60',
    ];
    expect(JSON.parse(mirroredSetCookies(lines)!)).toEqual([
      ['__Host-site_at', 'a.b.c', 600],
      ['__Host-site_rt', 'r%2Ft%2B%3D', 2_592_000],
      ['site_csrf', 'tok', 0],
    ]);
  });

  it('mirrors nothing when no auth cookie is set', () => {
    expect(mirroredSetCookies([])).toBeNull();
    expect(mirroredSetCookies(['theme=dark; Path=/'])).toBeNull();
  });

  it('turns the carried auth cookies back into a Cookie header, dropping anything else', () => {
    expect(bridgedCookieHeader(null, '__Host-site_at=a.b.c; theme=dark; site_csrf=t')).toBe('__Host-site_at=a.b.c; site_csrf=t');
    expect(bridgedCookieHeader('lang=en', 'site_rt=r')).toBe('lang=en; site_rt=r');
  });

  it('refuses values that would smuggle another cookie or attribute in', () => {
    expect(bridgedCookieHeader(null, 'site_at=a,b')).toBeNull();
    expect(bridgedCookieHeader(null, 'site_at="x"')).toBeNull();
    expect(bridgedCookieHeader(null, 'site_at=a b')).toBeNull();
    expect(bridgedCookieHeader(null, `site_at=${'x'.repeat(9000)}`)).toBeNull();
    expect(bridgedCookieHeader(null, '')).toBeNull();
    expect(bridgedCookieHeader(null, undefined)).toBeNull();
  });
});
