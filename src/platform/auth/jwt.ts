import {fromBase64Url, fromUtf8, toBase64Url, utf8} from './encoding';
import {hmacKey} from './keys';

/**
 * Access tokens: compact JWS, HS256 ONLY, signed with a key derived from
 * `JWT_SECRET`. Short-lived (10 minutes) and carried in an HttpOnly cookie.
 * Claims are the minimum to find the session: never permissions, never PII.
 *
 *   sub  the user's id (string)        sid  the refresh-token family (session)
 *   sv   the user's session version    typ  'access'
 *   iat / exp                          (seconds since the epoch)
 *
 * `verifyAccessToken` refuses anything that is not exactly what we issue:
 * another `alg` (incl. `none`), a `kid`, extra segments, a bad signature,
 * an expired or not-yet-valid token, missing claims.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 600;

/** Clock skew tolerated on `exp` / `iat`. */
const LEEWAY_SECONDS = 5;

export interface AccessClaims {
  sub: string;
  sid: string;
  sv: number;
  typ: 'access';
  iat: number;
  exp: number;
}

const HEADER = toBase64Url(utf8(JSON.stringify({alg: 'HS256', typ: 'JWT'})));

const nowSeconds = (now: Date) => Math.floor(now.getTime() / 1000);

export async function signAccessToken(
  secret: string,
  subject: {userId: number; familyId: string; sessionVersion: number},
  now: Date = new Date(),
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS
): Promise<string> {
  const iat = nowSeconds(now);
  const claims: AccessClaims = {
    sub: String(subject.userId),
    sid: subject.familyId,
    sv: subject.sessionVersion,
    typ: 'access',
    iat,
    exp: iat + ttlSeconds,
  };
  const body = `${HEADER}.${toBase64Url(utf8(JSON.stringify(claims)))}`;
  const key = await hmacKey(secret, 'jwt-hs256');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(body)));
  return `${body}.${toBase64Url(signature)}`;
}

export type VerifyResult = {ok: true; claims: AccessClaims} | {ok: false; reason: 'malformed' | 'signature' | 'expired'};

function json(segment: string): Record<string, unknown> | null {
  const bytes = fromBase64Url(segment);
  if (!bytes) return null;
  try {
    const value = JSON.parse(fromUtf8(bytes)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyAccessToken(secret: string, token: string, now: Date = new Date()): Promise<VerifyResult> {
  if (token.length > 2048) return {ok: false, reason: 'malformed'};
  const parts = token.split('.');
  if (parts.length !== 3) return {ok: false, reason: 'malformed'};
  const [head, payload, sig] = parts as [string, string, string];

  // The header must be EXACTLY ours: no algorithm choice is left to the token.
  const header = json(head);
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || Object.keys(header).length !== 2) {
    return {ok: false, reason: 'malformed'};
  }
  const signature = fromBase64Url(sig);
  if (!signature || signature.length !== 32) return {ok: false, reason: 'malformed'};

  // WebCrypto's HMAC verify compares in constant time.
  const key = await hmacKey(secret, 'jwt-hs256');
  if (!(await crypto.subtle.verify('HMAC', key, signature, utf8(`${head}.${payload}`)))) {
    return {ok: false, reason: 'signature'};
  }

  const claims = json(payload);
  if (
    !claims ||
    claims.typ !== 'access' ||
    typeof claims.sub !== 'string' ||
    !/^\d{1,10}$/.test(claims.sub) ||
    typeof claims.sid !== 'string' ||
    claims.sid.length > 64 ||
    !Number.isSafeInteger(claims.sv) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp)
  ) {
    return {ok: false, reason: 'malformed'};
  }
  const t = nowSeconds(now);
  if ((claims.exp as number) <= t - LEEWAY_SECONDS || (claims.iat as number) > t + LEEWAY_SECONDS) {
    return {ok: false, reason: 'expired'};
  }
  return {ok: true, claims: claims as unknown as AccessClaims};
}
