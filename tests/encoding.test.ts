import {describe, expect, it} from 'vitest';

import {
  constantTimeEqual,
  constantTimeEqualText,
  fromBase64Url,
  randomBytes,
  sha256Hex,
  toBase64Url,
  utf8,
} from '../src/platform/auth/encoding';
import {subjectHash} from '../src/platform/auth/keys';

describe('encoding and constant-time helpers', () => {
  it('round-trips base64url and rejects anything else', () => {
    const bytes = randomBytes(32);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url('abc+/=')).toBeNull();
    expect(fromBase64Url('a')).toBeNull();
  });

  it('compares equal-length values without short-circuiting, and different lengths as unequal', () => {
    expect(constantTimeEqual(utf8('abc'), utf8('abc'))).toBe(true);
    expect(constantTimeEqual(utf8('abc'), utf8('abd'))).toBe(false);
    expect(constantTimeEqual(utf8('abc'), utf8('abcd'))).toBe(false);
    expect(constantTimeEqualText('', '')).toBe(true);
  });

  it('hashes with SHA-256 to 64 hex characters', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keys email and IP hashes with the secret, so they cannot be reversed by dictionary', async () => {
    const secret = 'test-secret-that-is-at-least-32-characters-long';
    const a = await subjectHash(secret, 'email', 'jane@example.com');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await subjectHash(secret, 'email', 'jane@example.com'));
    expect(a).not.toBe(await sha256Hex('jane@example.com'));
    expect(a).not.toBe(await subjectHash('another-secret-that-is-also-32-characters', 'email', 'jane@example.com'));
    expect(a).not.toBe(await subjectHash(secret, 'ip', 'jane@example.com'));
  });
});
