import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

/** A template upgrade leaves `prisma/schema.prisma` to you (docs/agent/upgrade.md): the managed code needs these. */
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

describe('this site has what the managed code needs (docs/agent/upgrade.md)', () => {
  it('model User: platformOwnerId', () => {
    expect(schema).toMatch(/platformOwnerId\s+String\?\s+@unique\s+@map\("platform_owner_id"\)/);
  });
  it('model AuthState: ownerEnvId', () => {
    expect(schema).toMatch(/ownerEnvId\s+String\?\s+@map\("owner_env_id"\)/);
    expect(schema).toMatch(/model IdempotencyKey \{[^}]*@@map\("idempotency_keys"\)/);
    // Kinroot sells nothing: the template's checkout files (and their idempotency checks) are removed.
  });
  it('both generators: relationJoins', () => {
    expect(schema.match(/previewFeatures\s*=\s*\[[^\]]*"relationJoins"/g)?.length).toBeGreaterThanOrEqual(1);
  });
});
