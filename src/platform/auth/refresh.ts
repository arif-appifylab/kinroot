import {randomBytes, sha256Hex, toBase64Url} from './encoding';

/**
 * Refresh tokens: OPAQUE (256 random bits, base64url), stored only as their
 * SHA-256, rotated on every use, grouped in a FAMILY (= one signed-in device).
 *
 *   sign in        → a new family, token #1
 *   refresh        → token #n is marked used, token #n+1 is issued
 *   reuse of #n    → someone holds a copy: the WHOLE family is revoked and the
 *                    device must sign in again (an audit event is written)
 *   reuse within   → two tabs refreshed at once: refused WITHOUT revoking, and
 *   the grace        the losing tab already has the winner's cookies
 *
 * Sliding expiry (`ttl`) capped by an absolute lifetime per family.
 *
 * The rules live here, on a small store interface, so they are unit-tested
 * without a database (`tests/refresh.test.ts`); `store.ts` implements it on
 * Prisma.
 */
export const REFRESH_POLICY = {
  ttlSeconds: 30 * 24 * 3600,
  absoluteSeconds: 90 * 24 * 3600,
  reuseGraceSeconds: 10,
} as const;

export interface RefreshRow {
  id: bigint;
  familyId: string;
  userId: number;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface NewRefreshRow {
  familyId: string;
  userId: number;
  tokenHash: string;
  rotatedFromId: bigint | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent: string | null;
  ipHash: string | null;
}

export interface RefreshStore {
  findByHash(tokenHash: string): Promise<RefreshRow | null>;
  /** Marks the row used IF it is still unused and unrevoked. True when THIS call did it. */
  markUsed(id: bigint, at: Date): Promise<boolean>;
  insert(row: NewRefreshRow): Promise<void>;
  revokeFamily(familyId: string, at: Date, reason: RevokeReason): Promise<void>;
  revokeAllForUser(userId: number, at: Date, reason: RevokeReason): Promise<void>;
}

export type RevokeReason = 'logout' | 'logout_all' | 'reuse' | 'password' | 'suspended' | 'expired' | 'admin' | 'email' | 'device';

export interface DeviceInfo {
  userAgent: string | null;
  ipHash: string | null;
}

export const hashRefreshToken = (token: string) => sha256Hex(token);

/** 32 random bytes → 43 base64url characters. */
export const newOpaqueToken = () => toBase64Url(randomBytes(32));

const addSeconds = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);
const earliest = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

/** Starts a family (a sign-in). Returns the token to set as the cookie. */
export async function issueFamily(
  store: RefreshStore,
  userId: number,
  device: DeviceInfo,
  now: Date = new Date()
): Promise<{token: string; familyId: string; expiresAt: Date}> {
  const token = newOpaqueToken();
  const familyId = crypto.randomUUID();
  const absoluteExpiresAt = addSeconds(now, REFRESH_POLICY.absoluteSeconds);
  const expiresAt = earliest(addSeconds(now, REFRESH_POLICY.ttlSeconds), absoluteExpiresAt);
  await store.insert({
    familyId,
    userId,
    tokenHash: await hashRefreshToken(token),
    rotatedFromId: null,
    expiresAt,
    absoluteExpiresAt,
    userAgent: device.userAgent?.slice(0, 255) ?? null,
    ipHash: device.ipHash,
  });
  return {token, familyId, expiresAt};
}

export type RotateResult =
  | {kind: 'ok'; token: string; userId: number; familyId: string; expiresAt: Date}
  /** Unknown, revoked or malformed: sign in again. */
  | {kind: 'invalid'}
  | {kind: 'expired'}
  /** A concurrent refresh won: retry with the cookies the browser now has. */
  | {kind: 'race'}
  /** A used token came back after the grace window: the family is now revoked. */
  | {kind: 'reuse'; userId: number; familyId: string};

export async function rotate(
  store: RefreshStore,
  token: string,
  device: DeviceInfo,
  now: Date = new Date()
): Promise<RotateResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return {kind: 'invalid'};
  const row = await store.findByHash(await hashRefreshToken(token));
  if (!row || row.revokedAt) return {kind: 'invalid'};

  if (row.usedAt) {
    if (now.getTime() - row.usedAt.getTime() <= REFRESH_POLICY.reuseGraceSeconds * 1000) return {kind: 'race'};
    await store.revokeFamily(row.familyId, now, 'reuse');
    return {kind: 'reuse', userId: row.userId, familyId: row.familyId};
  }

  if (row.expiresAt.getTime() <= now.getTime() || row.absoluteExpiresAt.getTime() <= now.getTime()) {
    await store.revokeFamily(row.familyId, now, 'expired');
    return {kind: 'expired'};
  }

  // The conditional update is the lock: of two concurrent refreshes, one wins.
  if (!(await store.markUsed(row.id, now))) return {kind: 'race'};

  const next = newOpaqueToken();
  const expiresAt = earliest(addSeconds(now, REFRESH_POLICY.ttlSeconds), row.absoluteExpiresAt);
  await store.insert({
    familyId: row.familyId,
    userId: row.userId,
    tokenHash: await hashRefreshToken(next),
    rotatedFromId: row.id,
    expiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    userAgent: device.userAgent?.slice(0, 255) ?? null,
    ipHash: device.ipHash,
  });
  return {kind: 'ok', token: next, userId: row.userId, familyId: row.familyId, expiresAt};
}

/** Logout of one device: revokes the family the presented token belongs to. */
export async function revokeByToken(store: RefreshStore, token: string, now: Date = new Date()): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await store.findByHash(await hashRefreshToken(token));
  if (!row) return null;
  if (!row.revokedAt) await store.revokeFamily(row.familyId, now, 'logout');
  return row.userId;
}
