import {randomUUID} from 'node:crypto';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {IdempotencyConflict, idempotent, idempotencyKeyOf} from '../../src/platform/idempotency';
import {sweep} from '../../src/platform/auth/store';

import {DATABASE_URL, db} from './support/harness';

const key = () => randomUUID();
const scope = `test:${randomUUID().slice(0, 8)}`;

/**
 * The rules in docs/agent/orders-and-stock.md, run for real: many requests at the same moment on
 * real Postgres. A shop's table stands in here, with the same statements a site would write.
 */
describe.skipIf(!DATABASE_URL)('doing things once, and never selling too many', () => {
  beforeAll(async () => {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "test_stock" ("id" INT PRIMARY KEY, "stock" INT NOT NULL CHECK ("stock" >= 0))`);
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "test_sales" ("id" SERIAL PRIMARY KEY, "item" INT NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "test_bookings" ("id" SERIAL PRIMARY KEY, "slot" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'held')`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "test_bookings_taken" ON "test_bookings" ("slot") WHERE "status" <> 'cancelled'`);
  });

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "test_stock", "test_sales", "test_bookings"`);
    await db.idempotencyKey.deleteMany({where: {scope}});
  });

  const salesOf = async (item: number) =>
    Number((await db.$queryRawUnsafe<{n: bigint}[]>(`SELECT COUNT(*) AS n FROM "test_sales" WHERE "item" = ${item}`))[0]!.n);

  it('runs once under a burst and gives everyone the same answer', async () => {
    const k = key();
    const item = 1001;
    const answers = await Promise.all(
      Array.from({length: 12}, () =>
        idempotent(db, {scope, key: k, request: {item}}, async tx => {
          await tx.$executeRaw`INSERT INTO "test_sales" ("item") VALUES (${item})`;
          return {sold: item, at: new Date('2026-11-02T00:00:00Z')};
        })
      )
    );
    expect(await salesOf(item)).toBe(1);
    expect(answers.filter(a => !a.replayed)).toHaveLength(1);
    for (const a of answers) expect(a.value).toEqual({sold: item, at: '2026-11-02T00:00:00.000Z'});
  }, 60_000);

  it('a failure frees the key and saves nothing; the retry runs', async () => {
    const k = key();
    const item = 1002;
    await expect(
      idempotent(db, {scope, key: k, request: {item}}, async tx => {
        await tx.$executeRaw`INSERT INTO "test_sales" ("item") VALUES (${item})`;
        throw new Error('sold out');
      })
    ).rejects.toThrow('sold out');
    expect(await salesOf(item)).toBe(0);
    const again = await idempotent(db, {scope, key: k, request: {item}}, async tx => {
      await tx.$executeRaw`INSERT INTO "test_sales" ("item") VALUES (${item})`;
      return {ok: true};
    });
    expect(again).toEqual({value: {ok: true}, replayed: false});
    expect(await salesOf(item)).toBe(1);
  });

  it('refuses the same key with a different request, whatever the order of its fields', async () => {
    const k = key();
    await idempotent(db, {scope, key: k, request: {a: 1, b: {c: 2, d: 3}}}, async () => ({done: true}));
    const same = await idempotent(db, {scope, key: k, request: {b: {d: 3, c: 2}, a: 1}}, async () => ({done: false}));
    expect(same).toEqual({value: {done: true}, replayed: true});
    await expect(idempotent(db, {scope, key: k, request: {a: 2}}, async () => ({}))).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  it('keeps scopes apart, refuses bad keys and big answers', async () => {
    const k = key();
    await idempotent(db, {scope, key: k, request: 1}, async () => 'first');
    expect((await idempotent(db, {scope: `${scope}:other`, key: k, request: 2}, async () => 'second')).value).toBe('second');
    await db.idempotencyKey.deleteMany({where: {scope: `${scope}:other`}});
    await expect(idempotent(db, {scope, key: 'short', request: 1}, async () => 1)).rejects.toThrow('idempotency key');
    await expect(idempotent(db, {scope, key: key(), request: 1}, async () => 'x'.repeat(70_000))).rejects.toThrow('64 KB');
    const noKey = new Request('https://x.test/');
    expect(idempotencyKeyOf(noKey)).toBeNull();
    const k2 = key();
    expect(idempotencyKeyOf(new Request('https://x.test/', {headers: {'Idempotency-Key': k2}}))).toBe(k2);
    expect(idempotencyKeyOf(new Request('https://x.test/', {headers: {'Idempotency-Key': 'bad key'}}))).toBeNull();
  });

  it('a conditional update never sells more than there is', async () => {
    await db.$executeRawUnsafe(`INSERT INTO "test_stock" ("id", "stock") VALUES (1, 5)`);
    const buy = () => db.$executeRaw`UPDATE "test_stock" SET "stock" = "stock" - 1 WHERE "id" = 1 AND "stock" >= 1`;
    const sold = await Promise.all(Array.from({length: 40}, buy));
    expect(sold.reduce((sum, n) => sum + n, 0)).toBe(5);
    const [row] = await db.$queryRawUnsafe<{stock: number}[]>(`SELECT "stock" FROM "test_stock" WHERE "id" = 1`);
    expect(row!.stock).toBe(0);
  }, 60_000);

  it('a read then a write does sell too many, which is why the rule exists', async () => {
    await db.$executeRawUnsafe(`INSERT INTO "test_stock" ("id", "stock") VALUES (2, 5)`);
    let sold = 0;
    await Promise.all(
      Array.from({length: 40}, async () => {
        const [row] = await db.$queryRaw<{stock: number}[]>`SELECT "stock" FROM "test_stock" WHERE "id" = 2`;
        if (row!.stock < 1) return;
        await db.$executeRaw`UPDATE "test_stock" SET "stock" = GREATEST("stock" - 1, 0) WHERE "id" = 2`;
        sold += 1;
      })
    );
    expect(sold).toBeGreaterThan(5);
  }, 60_000);

  it('a unique index gives one slot to one person, and a cancelled slot can be booked again', async () => {
    const book = () =>
      db.$queryRaw<{id: number}[]>`INSERT INTO "test_bookings" ("slot") VALUES ('mon-9') ON CONFLICT DO NOTHING RETURNING "id"`;
    const tries = await Promise.all(Array.from({length: 20}, book));
    expect(tries.filter(t => t.length)).toHaveLength(1);
    await db.$executeRaw`UPDATE "test_bookings" SET "status" = 'cancelled' WHERE "slot" = 'mon-9'`;
    expect(await book()).toHaveLength(1);
  }, 60_000);

  it('an advisory lock holds a limit across many rows', async () => {
    const seats = 3;
    const take = () =>
      db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('class-7', 0))`;
        const [{n}] = (await tx.$queryRaw`SELECT COUNT(*) AS n FROM "test_sales" WHERE "item" = 7777`) as {n: bigint}[];
        if (Number(n) >= seats) return false;
        await tx.$executeRaw`INSERT INTO "test_sales" ("item") VALUES (7777)`;
        return true;
      }, {timeout: 30_000, maxWait: 30_000});
    const taken = await Promise.all(Array.from({length: 15}, take));
    expect(taken.filter(Boolean)).toHaveLength(seats);
    expect(await salesOf(7777)).toBe(seats);
  }, 60_000);

  it('old keys are swept', async () => {
    const k = key();
    await idempotent(db, {scope, key: k, request: 1}, async () => 1);
    await sweep(db, new Date(Date.now() + 8 * 24 * 3600 * 1000));
    expect(await db.idempotencyKey.count({where: {scope, key: k}})).toBe(0);
  });
});
