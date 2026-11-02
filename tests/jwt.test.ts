import {describe, expect, it} from 'vitest';

import {fromUtf8, fromBase64Url, toBase64Url, utf8} from '../src/platform/auth/encoding';
import {ACCESS_TOKEN_TTL_SECONDS, signAccessToken, verifyAccessToken} from '../src/platform/auth/jwt';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const subject = {userId: 42, familyId: '0b1e7c4e-6a43-4c5e-9d55-1a2b3c4d5e6f', sessionVersion: 3};
const now = new Date('2026-10-19T12:00:00Z');

const segments = (token: string) => token.split('.') as [string, string, string];
const encode = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));
const decode = (segment: string) => JSON.parse(fromUtf8(fromBase64Url(segment)!)) as Record<string, unknown>;

describe('access tokens (HS256)', () => {
  it('round-trips the minimal claims, with a 10-minute lifetime', async () => {
    const token = await signAccessToken(SECRET, subject, now);
    const result = await verifyAccessToken(SECRET, token, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({sub: '42', sid: subject.familyId, sv: 3, typ: 'access'});
    expect(result.claims.exp - result.claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(600);
    expect(decode(segments(token)[0])).toEqual({alg: 'HS256', typ: 'JWT'});
    // No permissions, no email in the token.
    expect(Object.keys(decode(segments(token)[1])).sort()).toEqual(['exp', 'iat', 'sid', 'sub', 'sv', 'typ']);
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signAccessToken('another-secret-that-is-also-32-characters', subject, now);
    expect(await verifyAccessToken(SECRET, token, now)).toEqual({ok: false, reason: 'signature'});
  });

  it('refuses a token whose payload was changed (privilege escalation attempt)', async () => {
    const [head, , sig] = segments(await signAccessToken(SECRET, subject, now));
    const forged = encode({...decode(segments(await signAccessToken(SECRET, subject, now))[1]), sub: '1'});
    expect(await verifyAccessToken(SECRET, `${head}.${forged}.${sig}`, now)).toEqual({ok: false, reason: 'signature'});
  });

  it('refuses alg "none", other algorithms and extra header fields', async () => {
    const [, payload, sig] = segments(await signAccessToken(SECRET, subject, now));
    for (const header of [
      {alg: 'none', typ: 'JWT'},
      {alg: 'HS512', typ: 'JWT'},
      {alg: 'RS256', typ: 'JWT'},
      {alg: 'HS256', typ: 'JWT', kid: '../../etc/passwd'},
      {alg: 'HS256'},
    ]) {
      expect((await verifyAccessToken(SECRET, `${encode(header)}.${payload}.${sig}`, now)).ok).toBe(false);
      expect((await verifyAccessToken(SECRET, `${encode(header)}.${payload}.`, now)).ok).toBe(false);
    }
  });

  it('refuses expired and not-yet-valid tokens (5 s leeway)', async () => {
    const token = await signAccessToken(SECRET, subject, now);
    const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
    expect((await verifyAccessToken(SECRET, token, later(600 + 4))).ok).toBe(true);
    expect(await verifyAccessToken(SECRET, token, later(600 + 6))).toEqual({ok: false, reason: 'expired'});
    expect(await verifyAccessToken(SECRET, token, later(-60))).toEqual({ok: false, reason: 'expired'});
  });

  it('refuses malformed input without throwing', async () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', '...', 'x'.repeat(5000), 'eyJ.eyJ.sig', '%%%.%%%.%%%']) {
      const result = await verifyAccessToken(SECRET, bad, now);
      expect(result.ok).toBe(false);
    }
  });
});
