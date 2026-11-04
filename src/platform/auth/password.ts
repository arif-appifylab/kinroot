import {constantTimeEqual, fromBase64Url, randomBytes, toBase64Url, utf8} from './encoding';

/**
 * Password hashing: scrypt through `node:crypto`, a fresh 16-byte salt per hash, a
 * 32-byte key. Workers refuse PBKDF2 above 100,000 iterations (below OWASP's 600,000)
 * and have no native Argon2; a JavaScript Argon2 takes ~2.7 s, so scrypt is the
 * strongest choice that runs here. N=2^14, r=8, p=5 is one of OWASP's settings, and
 * the cheapest of them measured on Workers: 16 MiB, ~160 ms per hash or verify. That
 * is why every route that verifies a password is rate-limited first.
 *
 * Stored as a VERSIONED string, so the cost can change later without a migration:
 * an older hash still verifies where the runtime allows it and reports
 * `needsRehash`, and the login route re-hashes it on the spot.
 *
 *   scrypt$v1$16384$8$5$<salt base64url>$<key base64url>
 *   pbkdf2-sha256$v1$100000$<salt base64url>$<key base64url>   (older: verify only)
 */
export const PASSWORD_HASH = {
  scheme: 'scrypt',
  version: 'v1',
  N: 16_384,
  r: 8,
  p: 5,
  saltBytes: 16,
  keyBytes: 32,
} as const;

/** Server and client agree on these (`src/lib/auth-rules.ts` mirrors them). */
export const PASSWORD_LIMITS = {min: 10, max: 128} as const;

const OLD_SCHEME = 'pbkdf2-sha256';
/** Bounds on a STORED cost, so a corrupted row cannot stall the Worker. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;
const MIN_N = 2 ** 13;
const MAX_N = 2 ** 17;
const MAX_P = 10;

/** NFKC so the same password typed on two keyboards hashes the same. */
const normalize = (password: string) => password.normalize('NFKC');

type ScryptCost = {N: number; r: number; p: number};

async function deriveScrypt(password: string, salt: Uint8Array<ArrayBuffer>, {N, r, p}: ScryptCost): Promise<Uint8Array> {
  // Loaded here, not at the top: browser code imports PASSWORD_LIMITS from this file.
  const {scrypt} = await import('node:crypto');
  return new Promise((resolve, reject) => {
    scrypt(utf8(normalize(password)), salt, PASSWORD_HASH.keyBytes, {N, r, p, maxmem: 2 * 128 * r * (N + p)}, (error, key) =>
      error ? reject(error) : resolve(new Uint8Array(key))
    );
  });
}

async function derivePbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(normalize(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
    key,
    PASSWORD_HASH.keyBytes * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const {scheme, version, N, r, p, saltBytes} = PASSWORD_HASH;
  const salt = randomBytes(saltBytes);
  const key = await deriveScrypt(password, salt, {N, r, p});
  return [scheme, version, N, r, p, toBase64Url(salt), toBase64Url(key)].join('$');
}

type Parsed =
  | {kind: 'scrypt'; cost: ScryptCost; salt: Uint8Array<ArrayBuffer>; key: Uint8Array}
  | {kind: 'pbkdf2'; iterations: number; salt: Uint8Array<ArrayBuffer>; key: Uint8Array};

const whole = (text: string | undefined) => (text !== undefined && /^\d+$/.test(text) ? Number(text) : NaN);

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  const [scheme, version] = parts;
  if (version !== PASSWORD_HASH.version) return null;
  const salt = fromBase64Url(parts.at(-2) ?? '');
  const key = fromBase64Url(parts.at(-1) ?? '');
  if (!salt || !key || salt.length < 16 || key.length !== PASSWORD_HASH.keyBytes) return null;
  if (scheme === PASSWORD_HASH.scheme && parts.length === 7) {
    const N = whole(parts[2]);
    const r = whole(parts[3]);
    const p = whole(parts[4]);
    const powerOfTwo = Number.isInteger(Math.log2(N));
    if (!powerOfTwo || N < MIN_N || N > MAX_N || r !== PASSWORD_HASH.r || !(p >= 1 && p <= MAX_P)) return null;
    return {kind: 'scrypt', cost: {N, r, p}, salt, key};
  }
  if (scheme === OLD_SCHEME && parts.length === 5) {
    const iterations = whole(parts[2]);
    if (!(iterations >= MIN_ITERATIONS && iterations <= MAX_ITERATIONS)) return null;
    return {kind: 'pbkdf2', iterations, salt, key};
  }
  return null;
}

const isCurrent = ({N, r, p}: ScryptCost) => N === PASSWORD_HASH.N && r === PASSWORD_HASH.r && p === PASSWORD_HASH.p;

/** Same work as a real check, so a broken row or unknown address is not a timing oracle. */
async function burn(password: string): Promise<void> {
  const {N, r, p} = PASSWORD_HASH;
  await deriveScrypt(password.slice(0, PASSWORD_LIMITS.max), randomBytes(16), {N, r, p});
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
    await burn(password);
    return {ok: false, needsRehash: false};
  }
  if (parsed.kind === 'scrypt') {
    const ok = constantTimeEqual(await deriveScrypt(password, parsed.salt, parsed.cost), parsed.key);
    return {ok, needsRehash: ok && !isCurrent(parsed.cost)};
  }
  try {
    const ok = constantTimeEqual(await derivePbkdf2(password, parsed.salt, parsed.iterations), parsed.key);
    return {ok, needsRehash: ok};
  } catch {
    // Workers refuse PBKDF2 above 100,000 iterations. This person signs in by email or resets it.
    await burn(password);
    return {ok: false, needsRehash: false};
  }
}

/**
 * A valid hash of a random password nobody knows. Login verifies against it
 * when the email has no account, so "no such user" costs the same time as
 * "wrong password" (no user enumeration by timing).
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$v1$16384$8$5$jIWw_e34wcMC0VDfa9vblQ$1hVERmuMP9dNVumGgy2F5AdiT9jK-80sGGPRtPQQrb8';

/** Problems with a NEW password, in words; `null` when it is acceptable. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_LIMITS.min) return `Use at least ${PASSWORD_LIMITS.min} characters.`;
  if (password.length > PASSWORD_LIMITS.max) return `Use at most ${PASSWORD_LIMITS.max} characters.`;
  if (!password.trim()) return 'A password cannot be only spaces.';
  const lower = password.toLowerCase();
  const name = email?.toLowerCase().split('@')[0] ?? '';
  if (name.length >= 4 && lower.includes(name)) return 'Do not use your email address in your password.';
  if (COMMON.has(lower) || looksCommon(lower)) return 'That password is too common. Choose another.';
  return null;
}

/** Common words behind swapped letters, repeats or numbers (`P@ssw0rd12345`, `adminadmin12`, `aaaaaaaaaaaa`). */
function looksCommon(lower: string): boolean {
  if (new Set(lower).size <= 2) return true;
  const trim = (value: string) => value.replace(/[^a-z]+$/, '').replace(/^[^a-z]+/, '');
  // Numbers around a word first, so only those inside it read as swapped letters.
  const plain = trim(trim(lower).replace(/@/g, 'a').replace(/\$/g, 's').replace(/0/g, 'o').replace(/3/g, 'e').replace(/[1!]/g, 'i'));
  const word = plain.match(/^(.+?)\1+$/)?.[1] ?? plain;
  return [trim(lower), plain, word].some(candidate => COMMON_WORDS.has(candidate));
}

/**
 * The most-used words in passwords: on their own, or with only numbers or symbols around them
 * (`password12345`, `!!welcome2024`), they are the first things anyone guesses.
 */
const COMMON_WORDS = new Set(
  (
    'password passw0rd passwort motdepasse contrasena qwerty qwertyuiop qwertyui asdfgh asdfghjkl zxcvbn zxcvbnm ' +
    'letmein welcome welcomeback iloveyou admin administrator root login master secret changeme default test testing ' +
    'football baseball basketball soccer hockey dragon monkey shadow sunshine princess superman batman michael ' +
    'trustno abc abcd abcde abcdef abcdefg abcdefgh abcdefghij access computer internet whatever freedom starwars ' +
    'pokemon liverpool chelsea arsenal manchester google facebook samsung apple summer winter spring autumn ' +
    'bangladesh dhaka india pakistan america'
  ).split(' ')
);

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
