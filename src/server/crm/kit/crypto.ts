import {config} from '../../../platform/config';

// Web Crypto only: no native Node addons on Workers. Passwords are the template's
// (src/platform/auth); Kinroot never hashes or checks one.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const toB64Url = (bytes: ArrayBuffer | Uint8Array) =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Secrets at rest (AES-GCM) ──────────────────────────────────────────────

/**
 * The secret Kinroot's keys are derived from: the owner-added `KINROOT_SECRET_KEY` when there is
 * one, else the site's `JWT_SECRET` (set by the platform). Changing it makes stored mailbox and
 * calendar connections unreadable (reconnect them) and old tracking / unsubscribe links invalid.
 */
function masterSecret(): string {
  const secret = config.ownerSecret('KINROOT_SECRET_KEY') ?? config.jwtSecret;
  if (!secret) throw new Error('Kinroot needs JWT_SECRET (set by the platform) to protect stored secrets.');
  return secret;
}

/** A key for one purpose, derived with HKDF so no two purposes share key material. */
async function derive(purpose: string, algorithm: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]) {
  const base = await crypto.subtle.importKey('raw', enc.encode(masterSecret()), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: enc.encode('kinroot'), info: enc.encode(purpose)},
    base,
    algorithm,
    false,
    usages,
  );
}

const aesKey = () => derive('secrets-at-rest', {name: 'AES-GCM', length: 256}, ['encrypt', 'decrypt']);

export async function encryptJson(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(), enc.encode(JSON.stringify(value)));
  return `v1.${toB64(iv)}.${toB64(cipher)}`;
}

export async function decryptJson<T>(payload: string): Promise<T> {
  const [version, iv, data] = payload.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Unsupported secret format');
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64(iv)}, await aesKey(), fromB64(data));
  return JSON.parse(dec.decode(plain)) as T;
}

// ─── Signatures (tracking links, OAuth state) ───────────────────────────────

const hmacKey = () => derive('signatures', {name: 'HMAC', hash: 'SHA-256', length: 256}, ['sign', 'verify']);

export async function sign(value: string): Promise<string> {
  return toB64Url(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(value))).slice(0, 22);
}

/** Constant-time: the comparison takes as long whether the first or the last character differs. */
export async function verifySignature(value: string, signature: string): Promise<boolean> {
  const expected = await sign(value);
  if (typeof signature !== 'string' || signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
