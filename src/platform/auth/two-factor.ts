import {constantTimeEqualText, fromBase64Url, fromUtf8, randomBytes, sha256Hex, toBase64Url, utf8} from './encoding';
import {aesKey, hmacKey} from './keys';

/**
 * Two-step sign-in: an authenticator app code (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds, the
 * kind Google Authenticator, 1Password and Authy read from a QR code) or a one-use recovery code.
 *
 *   - The TOTP secret is stored SEALED (AES-256-GCM, a key derived from JWT_SECRET for this one
 *     purpose), never in clear. Rotating JWT_SECRET makes sealed secrets unreadable: those
 *     users sign in with a recovery code, or an owner turns two-step off for them in Users.
 *   - A code is accepted once: the step it matched is stored, and that step or an older one
 *     never works again (no replay of a code someone watched being typed).
 *   - Recovery codes are kept as SHA-256 hashes; each works once.
 *   - Between the password and the code, the browser holds a CHALLENGE: a signed 5-minute token
 *     naming the user and their session version (a password change voids it). Pure functions.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes one step either side of now still count (clock drift on phones). */
const WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_SECONDS = 5 * 60;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh secret: 20 random bytes, as base32 (what an authenticator app is given). */
export const newTotpSecret = () => toBase32(randomBytes(20));

/** The 6-digit code for one 30-second step. */
export async function totpCode(secret: Uint8Array<ArrayBuffer>, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let rest = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = rest & 255;
    rest = Math.floor(rest / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret, {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1]! & 15;
  const binary =
    ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * The step `code` matches (now, or one step either side), or null. A step at or before
 * `lastStep` (the last accepted one) never matches: each code works once.
 */
export async function matchTotp(
  secretBase32: string,
  code: string,
  lastStep: number | null,
  now = Date.now()
): Promise<number | null> {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = fromBase32(secretBase32);
  if (!secret) return null;
  const current = stepAt(now);
  let found: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    // Compare every candidate (no early exit), so timing says nothing about which one matched.
    if (constantTimeEqualText(await totpCode(secret, step), digits) && (lastStep === null || step > lastStep)) {
      found ??= step;
    }
  }
  return found;
}

/** What an authenticator app scans: `otpauth://totp/<site>:<email>?secret=…&issuer=<site>`. */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS)});
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ------------------------------------------------------------- sealing --

/** `v1.<iv>.<ciphertext>` (base64url), bound to the user id (a sealed value cannot be moved). */
export async function sealSecret(jwtSecret: string, userId: number, plain: string): Promise<string> {
  const key = await aesKey(jwtSecret, 'totp-seal');
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: utf8(`user:${userId}`)},
    key,
    utf8(plain)
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(data))}`;
}

/** The sealed value, or null (another key, another user, or tampered). */
export async function openSecret(jwtSecret: string, userId: number, sealed: string | null): Promise<string | null> {
  const [version, ivText, dataText] = (sealed ?? '').split('.');
  if (version !== 'v1' || !ivText || !dataText) return null;
  const iv = fromBase64Url(ivText);
  const data = fromBase64Url(dataText);
  if (!iv || !data) return null;
  try {
    const key = await aesKey(jwtSecret, 'totp-seal');
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: utf8(`user:${userId}`)}, key, data);
    return fromUtf8(new Uint8Array(plain));
  } catch {
    return null;
  }
}

// ------------------------------------------------------- recovery codes --

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes like `k7m2-x9qp-4hzt` (about 70 bits each), shown once. */
export function newRecoveryCodes(): string[] {
  return Array.from({length: RECOVERY_CODE_COUNT}, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, b => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** The stored form of a recovery code (case, spaces and dashes do not matter when typed). */
export const recoveryCodeHash = (code: string) => sha256Hex(`recovery:${code.toLowerCase().replace(/[\s-]/g, '')}`);

export const looksLikeRecoveryCode = (code: string) => /^[a-z0-9]{12}$/.test(code.toLowerCase().replace(/[\s-]/g, ''));

// ------------------------------------------------------------ challenge --

interface ChallengePayload {
  u: number;
  sv: number;
  e: number;
}

/** The token the browser holds between the password and the code. */
export async function signChallenge(jwtSecret: string, userId: number, sessionVersion: number, now = Date.now()) {
  const payload = toBase64Url(
    utf8(JSON.stringify({u: userId, sv: sessionVersion, e: Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS}))
  );
  const key = await hmacKey(jwtSecret, 'mfa-challenge');
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(payload)));
  return `${payload}.${toBase64Url(mac)}`;
}

/** {userId, sessionVersion}, or null for a bad, tampered or expired challenge. */
export async function verifyChallenge(jwtSecret: string, token: unknown, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [payload, macText] = token.split('.');
  if (!payload || !macText) return null;
  const mac = fromBase64Url(macText);
  if (!mac) return null;
  const key = await hmacKey(jwtSecret, 'mfa-challenge');
  if (!(await crypto.subtle.verify('HMAC', key, mac, utf8(payload)))) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  try {
    const data = JSON.parse(fromUtf8(bytes)) as ChallengePayload;
    if (!Number.isInteger(data.u) || !Number.isInteger(data.sv) || !Number.isInteger(data.e)) return null;
    if (data.e < Math.floor(now / 1000)) return null;
    return {userId: data.u, sessionVersion: data.sv};
  } catch {
    return null;
  }
}
