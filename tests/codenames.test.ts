import {describe, expect, it} from 'vitest';

import {canDelegate, CODENAME_RE, grants} from '../src/platform/auth/codenames';

describe('codenames', () => {
  it('grants exact codenames and wildcard parents only', () => {
    const admin = new Set(['site:user:*', 'site:job:manage']);
    expect(grants(admin, 'site:user:read')).toBe(true);
    expect(grants(admin, 'site:user:update')).toBe(true);
    expect(grants(admin, 'site:job:manage')).toBe(true);
    expect(grants(admin, 'site:role:update')).toBe(false);
    expect(grants(admin, 'site:users:read')).toBe(false); // not a prefix match
    expect(grants(new Set(['*']), 'site:anything:at:all')).toBe(true);
    expect(grants(new Set(['site:*']), 'site:role:update')).toBe(true);
    expect(grants(new Set(), 'site:user:read')).toBe(false);
  });

  it('only lets you hand out what you hold (anti-escalation)', () => {
    const admin = new Set(['site:user:*', 'site:role:read']);
    expect(canDelegate(admin, ['site:user:read', 'site:user:update'])).toBe(true);
    expect(canDelegate(admin, ['site:user:*'])).toBe(true);
    expect(canDelegate(admin, ['*'])).toBe(false); // cannot make an owner
    expect(canDelegate(admin, ['site:*'])).toBe(false);
    expect(canDelegate(admin, ['site:role:update'])).toBe(false);
    expect(canDelegate(new Set(['site:user:read']), ['site:user:*'])).toBe(false);
    expect(canDelegate(new Set(['*']), ['*', 'site:role:update'])).toBe(true);
  });

  it('accepts only well-formed codenames', () => {
    for (const ok of ['*', 'site:job:manage', 'site:user:*', 'site:crm:contact:read']) expect(CODENAME_RE.test(ok)).toBe(true);
    for (const bad of ['', 'Site:job', 'site:*:read', 'site::read', 'site:job:manage:a:b', 'site job', '**']) {
      expect(CODENAME_RE.test(bad)).toBe(false);
    }
  });
});
