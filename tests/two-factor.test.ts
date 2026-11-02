import {describe, expect, it} from 'vitest';

import {deviceName} from '../src/platform/auth/security-routes';
import {
  fromBase32,
  looksLikeRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  openSecret,
  otpauthUri,
  recoveryCodeHash,
  sealSecret,
  signChallenge,
  stepAt,
  toBase32,
  totpCode,
  verifyChallenge,
} from '../src/platform/auth/two-factor';

const SECRET = 'a-test-jwt-secret-0123456789-abcdefghijklmnopqrstuv';
/** RFC 6238 appendix B: the ASCII secret "12345678901234567890" (SHA-1). */
const RFC_SECRET = toBase32(new TextEncoder().encode('12345678901234567890'));

describe('two-step sign-in (pure)', () => {
  it('base32 round-trips and matches the RFC secret', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(new TextDecoder().decode(fromBase32(RFC_SECRET)!)).toBe('12345678901234567890');
    expect(fromBase32('not base32!')).toBeNull();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('computes the RFC 6238 test vectors (last 6 digits)', async () => {
    const secret = fromBase32(RFC_SECRET)!;
    // T = 59 s → 94287082; T = 1111111109 s → 07081804; T = 2000000000 s → 69279037.
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(await totpCode(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts a code from now or one step either side, each step once', async () => {
    const now = 2_000_000_000_000;
    const step = stepAt(now);
    const secret = fromBase32(RFC_SECRET)!;
    const code = await totpCode(secret, step);
    expect(await matchTotp(RFC_SECRET, code, null, now)).toBe(step);
    expect(await matchTotp(RFC_SECRET, code, step, now)).toBeNull(); // already used
    expect(await matchTotp(RFC_SECRET, await totpCode(secret, step - 1), null, now)).toBe(step - 1);
    expect(await matchTotp(RFC_SECRET, await totpCode(secret, step - 3), null, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, '12345', null, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, null, now)).toBe(step);
  });

  it('seals a secret for one user only', async () => {
    const sealed = await sealSecret(SECRET, 7, RFC_SECRET);
    expect(sealed).not.toContain(RFC_SECRET);
    expect(await openSecret(SECRET, 7, sealed)).toBe(RFC_SECRET);
    expect(await openSecret(SECRET, 8, sealed)).toBeNull();
    expect(await openSecret(`${SECRET}-rotated`, 7, sealed)).toBeNull();
    expect(await openSecret(SECRET, 7, sealed.slice(0, -2) + 'AA')).toBeNull();
    expect(await openSecret(SECRET, 7, null)).toBeNull();
  });

  it('recovery codes: ten, distinct, matched however they are typed', async () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const first = codes[0]!;
    expect(await recoveryCodeHash(first.toUpperCase().replace(/-/g, ' '))).toBe(await recoveryCodeHash(first));
    expect(looksLikeRecoveryCode(first)).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });

  it('a challenge carries the user and session version, and expires', async () => {
    const now = Date.now();
    const token = await signChallenge(SECRET, 5, 3, now);
    expect(await verifyChallenge(SECRET, token, now)).toEqual({userId: 5, sessionVersion: 3});
    expect(await verifyChallenge(SECRET, token, now + 6 * 60 * 1000)).toBeNull();
    expect(await verifyChallenge(`${SECRET}x`, token, now)).toBeNull();
    const [payload] = token.split('.');
    expect(await verifyChallenge(SECRET, `${payload}.AAAA`, now)).toBeNull();
    expect(await verifyChallenge(SECRET, 42, now)).toBeNull();
  });

  it('builds the otpauth URI apps scan', () => {
    const uri = otpauthUri('shop.example.com', 'ann@example.com', RFC_SECRET);
    expect(uri.startsWith('otpauth://totp/shop.example.com%3Aann%40example.com?')).toBe(true);
    const query = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(query.get('secret')).toBe(RFC_SECRET);
    expect(query.get('issuer')).toBe('shop.example.com');
  });

  it('names devices from their User-Agent', () => {
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15')).toBe(
      'Safari on macOS'
    );
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0')).toBe('Edge on Windows');
    expect(deviceName(null)).toBe('A browser');
  });
});
