import {describe, expect, it} from 'vitest';

import {cookieName, readCookie, serializeCookie} from '../src/platform/auth/cookies';
import {normalizeEmail, safeNext} from '../src/platform/auth/input';

describe('cookies', () => {
  it('uses __Host- cookies with Secure, HttpOnly, SameSite=Lax and Path=/ in production', () => {
    const value = serializeCookie('site_at', 'abc', 'https://shop.example.com/x', {maxAgeSeconds: 600, httpOnly: true});
    expect(value).toBe('__Host-site_at=abc; Path=/; Max-Age=600; SameSite=Lax; Secure; HttpOnly');
    expect(value).not.toMatch(/Domain=/);
    expect(cookieName('site_rt', 'https://shop.example.com')).toBe('__Host-site_rt');
  });

  it('drops the prefix and Secure on localhost only', () => {
    expect(serializeCookie('site_csrf', 't', 'http://localhost:4321/', {maxAgeSeconds: 10, httpOnly: false})).toBe(
      'site_csrf=t; Path=/; Max-Age=10; SameSite=Lax'
    );
  });

  it('reads one cookie by its exact name', () => {
    const header = 'a=1; __Host-site_at=tok%20en; site_at_x=no';
    expect(readCookie(header, '__Host-site_at')).toBe('tok en');
    expect(readCookie(header, 'site_at')).toBeNull();
    expect(readCookie(null, 'a')).toBeNull();
  });
});

describe('input', () => {
  it('normalizes emails and refuses junk', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    for (const bad of ['', 'jane', 'jane@', '@example.com', 'jane@example', 'a b@example.com', 42, null]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('only follows same-site paths after sign-in (no open redirect)', () => {
    expect(safeNext('/dashboard/jobs?x=1', '/dashboard')).toBe('/dashboard/jobs?x=1');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/a\nb', '', 7]) {
      expect(safeNext(bad, '/dashboard')).toBe('/dashboard');
    }
  });
});
