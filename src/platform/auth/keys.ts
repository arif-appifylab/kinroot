import {toHex, utf8} from './encoding';

/**
 * ONE secret (`JWT_SECRET`), several independent keys: HKDF-SHA256 derives a
 * separate key per purpose, so a key used for one job can never be replayed
 * against another (a rate-limit hash is never a valid JWT signature).
 */
export type KeyPurpose = 'jwt-hs256' | 'subject-hash' | 'mfa-challenge' | 'totp-seal' | 'sign-in-code';

const SALT = utf8('site-auth-v1');

async function deriveRaw(secret: string, purpose: KeyPurpose): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8(purpose)}, base, 256);
}

/** The HMAC-SHA256 key for `purpose`, for `sign` and `verify` only (never exportable). */
export async function hmacKey(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await deriveRaw(secret, purpose), {name: 'HMAC', hash: 'SHA-256'}, false, [
    'sign',
    'verify',
  ]);
}

/**
 * A keyed, one-way 64-hex fingerprint of an email or an IP address, for rate
 * limits and audit rows. Keyed so that a leaked table cannot be reversed with
 * a dictionary of emails or the IPv4 space. Never store the raw value.
 */
export async function subjectHash(secret: string, kind: 'email' | 'ip', value: string): Promise<string> {
  const key = await hmacKey(secret, 'subject-hash');
  const mac = await crypto.subtle.sign('HMAC', key, utf8(`${kind}:${value}`));
  return toHex(new Uint8Array(mac));
}

/** The AES-256-GCM key for `purpose`, for `encrypt` and `decrypt` only (never exportable). */
export async function aesKey(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await deriveRaw(secret, purpose), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}
