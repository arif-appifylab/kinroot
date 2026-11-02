import {describe, expect, it} from 'vitest';

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  PASSWORD_HASH,
  passwordProblem,
  verifyPassword,
} from '../src/platform/auth/password';

describe('password hashing (PBKDF2-SHA256)', () => {
  it('writes a versioned hash string with the current cost and a fresh salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    const [scheme, version, iterations, salt, key] = a.split('$');
    expect(scheme).toBe('pbkdf2-sha256');
    expect(version).toBe('v1');
    expect(Number(iterations)).toBe(PASSWORD_HASH.iterations);
    expect(PASSWORD_HASH.iterations).toBeGreaterThanOrEqual(600_000); // OWASP (PIPE-13)
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b); // per-hash salt
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toEqual({ok: true, needsRehash: false});
    expect((await verifyPassword('correct horse batterz', stored)).ok).toBe(false);
    expect((await verifyPassword('', stored)).ok).toBe(false);
  });

  it('normalizes Unicode (NFKC) so the same password typed differently matches', async () => {
    const stored = await hashPassword('café-password'); // precomposed é
    expect((await verifyPassword('café-password', stored)).ok).toBe(true); // e + combining accent
  });

  it('asks for a rehash when the stored cost is below the current one', async () => {
    const old = await hashPassword('correct horse battery', 210_000); // the cost before 600k
    expect(await verifyPassword('correct horse battery', old)).toEqual({ok: true, needsRehash: true});
  });

  it('treats tampered or foreign hash strings as a plain "no"', async () => {
    const stored = await hashPassword('correct horse battery');
    const parts = stored.split('$');
    const flipped = [...parts.slice(0, 4), parts[4]!.replace(/^./, c => (c === 'A' ? 'B' : 'A'))].join('$');
    for (const bad of [
      flipped,
      stored.replace('v1', 'v9'),
      stored.replace(String(PASSWORD_HASH.iterations), '1000'), // below the floor
      stored.replace(String(PASSWORD_HASH.iterations), '99999999'), // above the ceiling
      '$2b$12$abcdefghijklmnopqrstuv', // bcrypt
      '',
      'not-a-hash',
    ]) {
      expect((await verifyPassword('correct horse battery', bad)).ok).toBe(false);
    }
  });

  it('ships a dummy hash that parses (so unknown emails cost the same) and matches nothing', async () => {
    const result = await verifyPassword('anything at all', DUMMY_PASSWORD_HASH);
    expect(result.ok).toBe(false);
    expect(DUMMY_PASSWORD_HASH.split('$')[2]).toBe(String(PASSWORD_HASH.iterations));
  });

  it('enforces the new-password rules in words', () => {
    expect(passwordProblem('short')).toMatch(/at least 10/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('          ')).toMatch(/spaces/);
    expect(passwordProblem('password123')).toMatch(/too common/);
    expect(passwordProblem('jane.doe-is-great', 'jane.doe@example.com')).toMatch(/email/);
    expect(passwordProblem('a long and unusual passphrase')).toBeNull();
  });
});
