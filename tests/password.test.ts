import {describe, expect, it, vi} from 'vitest';

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  PASSWORD_HASH,
  passwordProblem,
  verifyPassword,
} from '../src/platform/auth/password';

/** A hash as older releases wrote it. */
async function oldHash(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, key, 256);
  return ['pbkdf2-sha256', 'v1', iterations, Buffer.from(salt).toString('base64url'), Buffer.from(bits).toString('base64url')].join('$');
}

describe('password hashing (scrypt)', () => {
  it('writes a versioned hash string with the current cost and a fresh salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    const [scheme, version, N, r, p, salt, key] = a.split('$');
    expect(scheme).toBe('scrypt');
    expect(version).toBe('v1');
    expect([N, r, p]).toEqual(['16384', '8', '5']);
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b); // per-hash salt
  });

  it("keeps to OWASP's settings and what the Workers runtime allows", () => {
    // OWASP: N=2^14, r=8, p=5. Workers refuse PBKDF2 above 100,000, and Node doesn't, so a
    // Node test can't catch that: never go back to PBKDF2 without testing on the Workers runtime.
    expect(PASSWORD_HASH).toMatchObject({scheme: 'scrypt', N: 2 ** 14, r: 8, p: 5});
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

  it('verifies an older PBKDF2 hash and asks for a rehash', async () => {
    const old = await oldHash('correct horse battery', 100_000);
    expect(await verifyPassword('correct horse battery', old)).toEqual({ok: true, needsRehash: true});
    expect(await verifyPassword('correct horse batterz', old)).toEqual({ok: false, needsRehash: false});
  });

  it('asks for a rehash when a scrypt cost differs from the current one', async () => {
    const stored = await hashPassword('correct horse battery');
    const {scrypt} = await import('node:crypto');
    const salt = Buffer.from(stored.split('$')[5]!, 'base64url');
    const key: Buffer = await new Promise((resolve, reject) =>
      scrypt('correct horse battery', salt, 32, {N: 2 ** 13, r: 8, p: 10, maxmem: 64 * 1024 * 1024}, (e, k) => (e ? reject(e) : resolve(k)))
    );
    const older = ['scrypt', 'v1', 2 ** 13, 8, 10, salt.toString('base64url'), key.toString('base64url')].join('$');
    expect(await verifyPassword('correct horse battery', older)).toEqual({ok: true, needsRehash: true});
  });

  it('a stored hash the runtime refuses is a plain "no", never an exception', async () => {
    const stored = await oldHash('correct horse battery', 100_000);
    const refused = vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValueOnce(new Error('iteration counts above 100000 are not supported'));
    expect(await verifyPassword('correct horse battery', stored.replace('100000', '600000'))).toEqual({ok: false, needsRehash: false});
    refused.mockRestore();
  });

  it('treats tampered or foreign hash strings as a plain "no"', async () => {
    const stored = await hashPassword('correct horse battery');
    const parts = stored.split('$');
    const flipped = [...parts.slice(0, 4), parts[4]!.replace(/^./, c => (c === 'A' ? 'B' : 'A'))].join('$');
    for (const bad of [
      flipped,
      stored.replace('v1', 'v9'),
      stored.replace('$16384$', '$1024$'), // below the floor
      stored.replace('$16384$', '$4194304$'), // above the ceiling
      stored.replace('$16384$', '$20000$'), // not a power of two
      stored.replace('$8$5$', '$16$5$'), // another block size
      stored.replace('$8$5$', '$8$99$'), // too many passes
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
    expect(DUMMY_PASSWORD_HASH.split('$').slice(0, 5)).toEqual(['scrypt', 'v1', String(PASSWORD_HASH.N), String(PASSWORD_HASH.r), String(PASSWORD_HASH.p)]);
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
