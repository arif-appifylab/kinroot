import {beforeEach, describe, expect, it} from 'vitest';

import {
  hashRefreshToken,
  issueFamily,
  type NewRefreshRow,
  REFRESH_POLICY,
  type RefreshRow,
  type RefreshStore,
  revokeByToken,
  rotate,
} from '../src/platform/auth/refresh';

/** An in-memory `RefreshStore` with the same conditional-update semantics as the Prisma one. */
function memoryStore() {
  const rows: (RefreshRow & {tokenHash: string; revokedReason: string | null; rotatedFromId: bigint | null})[] = [];
  let next = 1n;
  const store: RefreshStore = {
    async findByHash(tokenHash) {
      return rows.find(row => row.tokenHash === tokenHash) ?? null;
    },
    async markUsed(id, at) {
      const row = rows.find(r => r.id === id);
      if (!row || row.usedAt || row.revokedAt) return false;
      row.usedAt = at;
      return true;
    },
    async insert(row: NewRefreshRow) {
      rows.push({...row, id: next++, usedAt: null, revokedAt: null, revokedReason: null});
    },
    async revokeFamily(familyId, at, reason) {
      for (const row of rows) if (row.familyId === familyId && !row.revokedAt) Object.assign(row, {revokedAt: at, revokedReason: reason});
    },
    async revokeAllForUser(userId, at, reason) {
      for (const row of rows) if (row.userId === userId && !row.revokedAt) Object.assign(row, {revokedAt: at, revokedReason: reason});
    },
  };
  return {store, rows};
}

const device = {userAgent: 'test', ipHash: 'a'.repeat(64)};
const t0 = new Date('2026-10-19T12:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe('refresh tokens: rotation and reuse detection', () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    mem = memoryStore();
  });

  it('stores only the hash of an opaque 256-bit token', async () => {
    const {token} = await issueFamily(mem.store, 7, device, t0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mem.rows[0]!.tokenHash).toBe(await hashRefreshToken(token));
    expect(JSON.stringify(mem.rows, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(token);
  });

  it('rotates: the new token works, the old one is marked used and points to nothing new', async () => {
    const first = await issueFamily(mem.store, 7, device, t0);
    const second = await rotate(mem.store, first.token, device, at(60));
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.familyId).toBe(first.familyId);
    expect(second.token).not.toBe(first.token);
    expect(mem.rows[0]!.usedAt).toEqual(at(60));
    expect(mem.rows[1]!.rotatedFromId).toBe(mem.rows[0]!.id);
    const third = await rotate(mem.store, second.token, device, at(120));
    expect(third.kind).toBe('ok');
  });

  it('detects reuse of a rotated token after the grace window and revokes the WHOLE family', async () => {
    const first = await issueFamily(mem.store, 7, device, t0);
    const second = await rotate(mem.store, first.token, device, at(60));
    if (second.kind !== 'ok') throw new Error('rotation failed');

    // An attacker replays the stolen first token later.
    const replay = await rotate(mem.store, first.token, device, at(60 + REFRESH_POLICY.reuseGraceSeconds + 1));
    expect(replay).toEqual({kind: 'reuse', userId: 7, familyId: first.familyId});
    expect(mem.rows.every(row => row.revokedAt && row.revokedReason === 'reuse')).toBe(true);

    // The legitimate holder's newer token is dead too: the device must sign in again.
    expect((await rotate(mem.store, second.token, device, at(200))).kind).toBe('invalid');
  });

  it('treats a reuse inside the grace window as a benign race: refused, nothing revoked', async () => {
    const first = await issueFamily(mem.store, 7, device, t0);
    const second = await rotate(mem.store, first.token, device, at(60));
    if (second.kind !== 'ok') throw new Error('rotation failed');
    expect(await rotate(mem.store, first.token, device, at(62))).toEqual({kind: 'race'});
    expect(mem.rows.some(row => row.revokedAt)).toBe(false);
    expect((await rotate(mem.store, second.token, device, at(63))).kind).toBe('ok');
  });

  it('lets exactly one of two concurrent refreshes win', async () => {
    const first = await issueFamily(mem.store, 7, device, t0);
    const [a, b] = await Promise.all([
      rotate(mem.store, first.token, device, at(30)),
      rotate(mem.store, first.token, device, at(30)),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['ok', 'race']);
    expect(mem.rows.filter(row => !row.usedAt && !row.revokedAt)).toHaveLength(1);
  });

  it('expires after the sliding TTL, and never outlives the absolute lifetime', async () => {
    const first = await issueFamily(mem.store, 7, device, t0);
    expect(await rotate(mem.store, first.token, device, at(REFRESH_POLICY.ttlSeconds + 1))).toEqual({kind: 'expired'});
    expect(mem.rows[0]!.revokedReason).toBe('expired');

    // Keep refreshing every 20 days: the family still ends at the absolute limit.
    const other = memoryStore();
    let token = (await issueFamily(other.store, 8, device, t0)).token;
    let day = 0;
    let last: Awaited<ReturnType<typeof rotate>> = {kind: 'invalid'};
    while (day < 120) {
      day += 20;
      last = await rotate(other.store, token, device, at(day * 86400));
      if (last.kind !== 'ok') break;
      expect(last.expiresAt.getTime()).toBeLessThanOrEqual(at(REFRESH_POLICY.absoluteSeconds).getTime());
      token = last.token;
    }
    expect(last.kind).toBe('expired');
    expect(day).toBeLessThanOrEqual(100);
  });

  it('refuses unknown, malformed and revoked tokens', async () => {
    expect((await rotate(mem.store, 'not-a-token', device, t0)).kind).toBe('invalid');
    expect((await rotate(mem.store, 'A'.repeat(43), device, t0)).kind).toBe('invalid');
    const first = await issueFamily(mem.store, 7, device, t0);
    expect(await revokeByToken(mem.store, first.token, at(5))).toBe(7);
    expect((await rotate(mem.store, first.token, device, at(10))).kind).toBe('invalid');
  });

  it('logout-all revokes every family of the user and no one else', async () => {
    const mine = await issueFamily(mem.store, 7, device, t0);
    const other = await issueFamily(mem.store, 7, device, t0);
    const theirs = await issueFamily(mem.store, 9, device, t0);
    await mem.store.revokeAllForUser(7, at(1), 'logout_all');
    expect((await rotate(mem.store, mine.token, device, at(2))).kind).toBe('invalid');
    expect((await rotate(mem.store, other.token, device, at(2))).kind).toBe('invalid');
    expect((await rotate(mem.store, theirs.token, device, at(2))).kind).toBe('ok');
  });
});
