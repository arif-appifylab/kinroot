import {constantTimeEqual, fromBase64Url, randomBytes, toBase64Url, utf8} from './encoding';

/**
 * Password hashing: PBKDF2-HMAC-SHA256 through WebCrypto (no native modules,
 * so it runs on Workers), a fresh 16-byte salt per hash, a 32-byte key.
 *
 * Stored as a VERSIONED string, so the cost can be raised later without a
 * migration: a hash with fewer iterations than `CURRENT` still verifies and
 * reports `needsRehash`, and the login route re-hashes it on the spot.
 *
 *   pbkdf2-sha256$v1$600000$<salt base64url>$<key base64url>
 *
 * Cost: ~45 ms of CPU per hash or verify on the Workers runtime (600k: OWASP's
 * figure for PBKDF2-HMAC-SHA256; older 210k hashes are re-hashed at sign-in). That is why
 * every route that verifies a password is rate-limited first.
 */
export const PASSWORD_HASH = {
  scheme: 'pbkdf2-sha256',
  version: 'v1',
  iterations: 600_000,
  saltBytes: 16,
  keyBytes: 32,
} as const;

/** Server and client agree on these (`src/lib/auth-rules.ts` mirrors them). */
export const PASSWORD_LIMITS = {min: 10, max: 128} as const;

/** Bounds on a STORED iteration count, so a corrupted row cannot stall the Worker. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

/** NFKC so the same password typed on two keyboards hashes the same. */
const normalize = (password: string) => password.normalize('NFKC');

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(normalize(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
    key,
    PASSWORD_HASH.keyBytes * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number = PASSWORD_HASH.iterations): Promise<string> {
  const salt = randomBytes(PASSWORD_HASH.saltBytes);
  const key = await derive(password, salt, iterations);
  return [PASSWORD_HASH.scheme, PASSWORD_HASH.version, iterations, toBase64Url(salt), toBase64Url(key)].join('$');
}

interface Parsed {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  key: Uint8Array;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [scheme, version, rounds, salt64, key64] = parts as [string, string, string, string, string];
  if (scheme !== PASSWORD_HASH.scheme || version !== PASSWORD_HASH.version) return null;
  if (!/^\d+$/.test(rounds)) return null;
  const iterations = Number(rounds);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  const salt = fromBase64Url(salt64);
  const key = fromBase64Url(key64);
  if (!salt || !key || salt.length < 16 || key.length !== PASSWORD_HASH.keyBytes) return null;
  return {iterations, salt, key};
}

/**
 * Does `password` match `stored`? Constant-time on the derived key. An
 * unparseable hash is a plain "no" (never an exception a caller could leak).
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<{ok: boolean; needsRehash: boolean}> {
  const parsed = parse(stored);
  if (!parsed || password.length > PASSWORD_LIMITS.max * 4) {
    // Same work as a real check, so a broken row is not a timing oracle.
    await derive(password.slice(0, PASSWORD_LIMITS.max), randomBytes(16), PASSWORD_HASH.iterations);
    return {ok: false, needsRehash: false};
  }
  const key = await derive(password, parsed.salt, parsed.iterations);
  const ok = constantTimeEqual(key, parsed.key);
  return {ok, needsRehash: ok && parsed.iterations < PASSWORD_HASH.iterations};
}

/**
 * A valid hash of a random password nobody knows. Login verifies against it
 * when the email has no account, so "no such user" costs the same time as
 * "wrong password" (no user enumeration by timing).
 */
export const DUMMY_PASSWORD_HASH =
  'pbkdf2-sha256$v1$600000$wS110RKa2TFi7QjUo76uww$mfulC_fF1dXnE0A4JY35Jy5QD5n8oCRTzQunJcK4m5c';

/** Problems with a NEW password, in words; `null` when it is acceptable. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_LIMITS.min) return `Use at least ${PASSWORD_LIMITS.min} characters.`;
  if (password.length > PASSWORD_LIMITS.max) return `Use at most ${PASSWORD_LIMITS.max} characters.`;
  if (!password.trim()) return 'A password cannot be only spaces.';
  const lower = password.toLowerCase();
  const name = email?.toLowerCase().split('@')[0] ?? '';
  if (name.length >= 4 && lower.includes(name)) return 'Do not use your email address in your password.';
  if (COMMON.has(lower)) return 'That password is too common. Choose another.';
  return null;
}

/**
 * A short list of the most-used passwords that pass the length rule, checked
 * locally: a password never leaves the site for a breached-password API.
 */
const COMMON = new Set([
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'password123',
  'password1234',
  'iloveyou123',
  '1q2w3e4r5t',
  'qwerty12345',
  'abcdefghij',
  '0987654321',
  '1111111111',
  'aaaaaaaaaa',
  'passw0rd123',
  'letmein1234',
  'welcome123',
  'administrator',
]);
