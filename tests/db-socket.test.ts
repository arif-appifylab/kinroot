import {readFileSync} from 'node:fs';

import {DriverAdapterError} from '@prisma/driver-adapter-utils';
import {describe, expect, it, vi} from 'vitest';

import {CONVERSION_FROM_ADAPTER_VERSION} from '../src/platform/db-socket-conversion';
import {isPlainRead, SocketConnection} from '../src/platform/db-socket';

type Reply = {rows?: unknown[][]; error?: unknown; hold?: Promise<unknown>; closes?: boolean};
type Script = (sql: string) => Reply | undefined;

/** A stand-in for the driver: logs every statement, and answers what the test says. */
function fakeClient(script: Script = () => undefined) {
  const log: string[] = [];
  const sessions: Array<{active: boolean; close(): void}> = [];
  const answer = (where: string, session?: {active: boolean}) => ({
    query: async (sql: string) => {
      log.push(`${where}:${sql}`);
      const reply = script(sql) ?? {};
      if (reply.hold) await reply.hold;
      if (reply.closes && session) session.active = false;
      if (reply.error) throw reply.error;
      const rows = (reply.rows ?? []).map(values => ({values}));
      return {columns: [{name: 'v', oid: 23}], rows: {collect: async () => rows}};
    },
    exec: async (sql: string) => {
      log.push(`${where}:${sql}`);
      const reply = script(sql) ?? {};
      if (reply.hold) await reply.hold;
      if (reply.closes && session) session.active = false;
      if (reply.error) throw reply.error;
      return 1;
    },
  });
  const client = {
    ...answer('https'),
    newSession: vi.fn(async () => {
      const id = sessions.length + 1;
      const session = {
        active: true,
        close() {
          session.active = false;
        },
      };
      sessions.push(session);
      return Object.assign(session, answer(`socket${id}`, session));
    }),
  };
  return {client: client as never, log, sessions, newSession: client.newSession};
}

const sql = (text: string) => ({sql: text, args: [], argTypes: []});
const connection = (fake: ReturnType<typeof fakeClient>, timings = {}) =>
  new SocketConnection({connectionString: 'postgres://u:p@db.prisma.io/x', client: fake.client, timings});

/** A driver error as the driver raises it: Postgres's code and message. */
const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), {name: 'DatabaseError', code, details: {severity: 'ERROR'}});

const SELECT = 'SELECT 1';
const INSERT_RETURNING = 'INSERT INTO t(v) VALUES (1) RETURNING id';
const UPDATE = 'UPDATE t SET v = 1';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return {opened, open};
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('what counts as a read', () => {
  it.each([
    ['SELECT id FROM t', true],
    ['  select id from t', true],
    ['WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x', false],
    [INSERT_RETURNING, false],
    ['UPDATE t SET v = 1 RETURNING id', false],
    ['DELETE FROM t RETURNING id', false],
    ['SELECT * FROM t FOR UPDATE', false],
    ['SELECT * FROM t FOR NO KEY UPDATE', false],
    ['SELECT * FROM t FOR SHARE', false],
    ['SELECT * INTO copy FROM t', false],
    ["SELECT nextval('s')", false],
    ['SELECT pg_advisory_lock(1)', false],
  ])('%s → %s', (text, expected) => {
    expect(isPlainRead(text)).toBe(expected);
  });
});

describe('one socket per client', () => {
  it('opens once, lazily, and runs every statement on it', async () => {
    const fake = fakeClient();
    const conn = connection(fake);
    expect(fake.newSession).not.toHaveBeenCalled();
    await conn.queryRaw(sql(SELECT));
    await conn.queryRaw(sql(SELECT));
    await conn.executeRaw(sql(UPDATE));
    expect(fake.newSession).toHaveBeenCalledTimes(1);
    expect(fake.log.every(line => line.startsWith('socket1:'))).toBe(true);
    await conn.dispose();
    expect(fake.sessions[0].active).toBe(false);
  });

  it('sends concurrent reads together on one socket', async () => {
    const hold = gate();
    const fake = fakeClient(() => ({hold: hold.opened}));
    const conn = connection(fake);
    const reads = [conn.queryRaw(sql(SELECT)), conn.queryRaw(sql('SELECT 2')), conn.queryRaw(sql('SELECT 3'))];
    await tick();
    expect(fake.log).toHaveLength(3); // None waited for another's answer.
    hold.open();
    await Promise.all(reads);
    expect(fake.newSession).toHaveBeenCalledTimes(1);
    expect(conn.stats.maxInFlight).toBe(3);
  });

  it('closes when idle and opens again when needed', async () => {
    const fake = fakeClient();
    const conn = connection(fake, {idleMs: 5});
    await conn.queryRaw(sql(SELECT));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fake.sessions[0].active).toBe(false);
    await conn.queryRaw(sql(SELECT));
    expect(fake.newSession).toHaveBeenCalledTimes(2);
  });

  it('does not close a socket with statements in flight', async () => {
    const hold = gate();
    const fake = fakeClient(() => ({hold: hold.opened}));
    const conn = connection(fake, {idleMs: 1});
    const read = conn.queryRaw(sql(SELECT));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.sessions[0].active).toBe(true);
    hold.open();
    await read;
  });
});

describe('order', () => {
  it('a write waits for earlier reads, later reads wait for it', async () => {
    const earlier = gate();
    const write = gate();
    const fake = fakeClient(text => (text === 'SELECT 1' ? {hold: earlier.opened} : text === UPDATE ? {hold: write.opened} : undefined));
    const conn = connection(fake);
    const all = [conn.queryRaw(sql(SELECT)), conn.executeRaw(sql(UPDATE)), conn.queryRaw(sql('SELECT 2'))];
    await tick();
    expect(fake.log.map(line => line.split(':')[1])).toEqual(['SELECT 1']);
    earlier.open();
    await tick();
    expect(fake.log.filter(line => line.endsWith(UPDATE))).toHaveLength(1);
    expect(fake.log.some(line => line.endsWith('SELECT 2'))).toBe(false);
    write.open();
    await Promise.all(all);
    expect(fake.log.at(-1)).toContain('SELECT 2');
  });

  it('treats RETURNING through queryRaw as a write', async () => {
    const hold = gate();
    const fake = fakeClient(text => (text === INSERT_RETURNING ? {hold: hold.opened} : undefined));
    const conn = connection(fake);
    const all = [conn.queryRaw(sql(INSERT_RETURNING)), conn.queryRaw(sql(SELECT))];
    await tick();
    expect(fake.log.some(line => line.endsWith(SELECT) && !line.includes('socket1:SELECT 1'))).toBe(false);
    hold.open();
    await Promise.all(all);
  });

  it('a failed write does not block what follows', async () => {
    const fake = fakeClient(text => (text === UPDATE ? {error: pgError('23505')} : undefined));
    const conn = connection(fake);
    const [write, read] = await Promise.allSettled([conn.executeRaw(sql(UPDATE)), conn.queryRaw(sql(SELECT))]);
    expect(write.status).toBe('rejected');
    expect(read.status).toBe('fulfilled');
  });
});

describe('a write is never sent twice', () => {
  const countOf = (log: string[], text: string) => log.filter(line => line.endsWith(`:${text}`)).length;

  it.each([
    ['executeRaw', UPDATE],
    ['queryRaw', INSERT_RETURNING],
  ] as const)('%s on a socket that dies mid-write fails, once', async (method, text) => {
    const fake = fakeClient(sqlText => (sqlText === text ? {closes: true, error: new Error('socket closed')} : undefined));
    const conn = connection(fake);
    await expect(conn[method](sql(text))).rejects.toThrow();
    expect(countOf(fake.log, text)).toBe(1);
    expect(conn.stats.fallbacks).toBe(0);
  });

  it('Postgres ending the connection mid-write fails, once, and the next statement opens anew', async () => {
    let killed = false;
    const fake = fakeClient(text => {
      if (text === UPDATE && !killed) {
        killed = true;
        return {error: pgError('57P01', 'terminating connection')};
      }
      return undefined;
    });
    const conn = connection(fake);
    await expect(conn.executeRaw(sql(UPDATE))).rejects.toMatchObject({cause: {originalCode: '57P01'}});
    expect(countOf(fake.log, UPDATE)).toBe(1);
    await conn.queryRaw(sql(SELECT));
    expect(fake.newSession).toHaveBeenCalledTimes(2);
  });

  it('checks a new socket BEFORE its first write, and uses HTTPS if the check fails', async () => {
    const fake = fakeClient(text => (text === 'SELECT 1' ? {error: new Error('bad socket'), closes: true} : undefined));
    const conn = connection(fake);
    await conn.executeRaw(sql(UPDATE));
    expect(fake.log).toEqual(['socket1:SELECT 1', `https:${UPDATE}`]);
  });

  it('checks once: a proven socket takes the write directly', async () => {
    const fake = fakeClient();
    const conn = connection(fake);
    await conn.queryRaw(sql('SELECT 9'));
    await conn.executeRaw(sql(UPDATE));
    expect(fake.log).toEqual(['socket1:SELECT 9', `socket1:${UPDATE}`]);
  });
});

describe('recovery', () => {
  it('a read on a socket that dies goes over HTTPS', async () => {
    let first = true;
    const flaky = fakeClient(() => {
      if (first) {
        first = false;
        return {closes: true, error: new Error('socket closed')};
      }
      return undefined;
    });
    const conn2 = connection(flaky);
    await expect(conn2.queryRaw(sql(SELECT))).resolves.toBeDefined();
    expect(flaky.log).toEqual([`socket1:${SELECT}`, `https:${SELECT}`]);
    expect(conn2.stats.fallbacks).toBe(1);
  });

  it('a read Postgres cut off (57P01) goes over HTTPS', async () => {
    let first = true;
    const fake = fakeClient(() => {
      if (first) {
        first = false;
        return {error: pgError('57P01', 'terminating connection')};
      }
      return undefined;
    });
    const conn = connection(fake);
    await conn.queryRaw(sql(SELECT));
    expect(conn.stats.fallbacks).toBe(1);
  });

  it('a bad query is that query\'s error, not sent again', async () => {
    const fake = fakeClient(() => ({error: pgError('42P01', 'no such table')}));
    const conn = connection(fake);
    await expect(conn.queryRaw(sql(SELECT))).rejects.toMatchObject({cause: {originalCode: '42P01'}});
    expect(fake.log).toHaveLength(1);
    expect(conn.stats.fallbacks).toBe(0);
  });

  it('a socket that won\'t open goes over HTTPS', async () => {
    const fake = fakeClient();
    fake.newSession.mockRejectedValueOnce(new Error('refused'));
    const conn = connection(fake);
    await conn.queryRaw(sql(SELECT));
    await conn.executeRaw(sql(UPDATE));
    expect(fake.log[0]).toBe(`https:${SELECT}`);
    expect(conn.stats.fallbacks).toBe(1);
  });

  it('a socket that takes too long to open goes over HTTPS, and is closed when it opens late', async () => {
    const fake = fakeClient();
    const late = {active: true, close: vi.fn()};
    let release!: (value: never) => void;
    fake.newSession.mockImplementationOnce(() => new Promise(resolve => (release = resolve)) as never);
    const conn = connection(fake, {openMs: 5});
    await conn.queryRaw(sql(SELECT));
    expect(fake.log).toEqual([`https:${SELECT}`]);
    release(late as never);
    await tick();
    expect(late.close).toHaveBeenCalled();
  });

  it('a new socket that stalls on its first read goes over HTTPS', async () => {
    const never = new Promise(() => {});
    let first = true;
    const fake = fakeClient(() => {
      if (first) {
        first = false;
        return {hold: never};
      }
      return undefined;
    });
    const conn = connection(fake, {firstReplyMs: 5});
    await conn.queryRaw(sql(SELECT));
    expect(fake.log).toEqual([`socket1:${SELECT}`, `https:${SELECT}`]);
    expect(fake.sessions[0].active).toBe(false);
  });

  it('a new socket that stalls on its check sends the write over HTTPS', async () => {
    const never = new Promise(() => {});
    const fake = fakeClient(text => (text === 'SELECT 1' ? {hold: never} : undefined));
    const conn = connection(fake, {firstReplyMs: 5});
    await conn.executeRaw(sql(UPDATE));
    expect(fake.log).toEqual(['socket1:SELECT 1', `https:${UPDATE}`]);
  });

  it('logs nothing but the event: no SQL, values or connection string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const never = new Promise(() => {});
    let first = true;
    const fake = fakeClient(() => {
      if (first) {
        first = false;
        return {hold: never};
      }
      return undefined;
    });
    const conn = connection(fake, {firstReplyMs: 5});
    await conn.queryRaw(sql("SELECT 'secret-value'"));
    for (const call of warn.mock.calls) {
      const line = call.join(' ');
      expect(line).not.toContain('secret-value');
      expect(line).not.toContain('postgres://');
    }
    warn.mockRestore();
  });
});

describe('errors reach Prisma in its own form', () => {
  it('a duplicate is a DriverAdapterError of kind UniqueConstraintViolation: that is what makes P2002', async () => {
    const fake = fakeClient(text => (text === UPDATE ? {error: pgError('23505', 'duplicate key')} : undefined));
    const conn = connection(fake);
    const error = await conn.executeRaw(sql(UPDATE)).catch(e => e);
    expect(error).toBeInstanceOf(DriverAdapterError);
    expect(error.cause).toMatchObject({kind: 'UniqueConstraintViolation', originalCode: '23505'});
  });

  it('the next statement after a query error opens a new socket: the old one is closing', async () => {
    const fake = fakeClient(text => (text === UPDATE ? {error: pgError('23505')} : undefined));
    const conn = connection(fake);
    await conn.queryRaw(sql('SELECT 9'));
    await expect(conn.executeRaw(sql(UPDATE))).rejects.toBeInstanceOf(DriverAdapterError);
    expect(fake.sessions[0].active).toBe(false);
    await conn.executeRaw(sql('DELETE FROM t'));
    expect(fake.log.at(-1)).toBe('socket2:DELETE FROM t');
    expect(conn.stats.fallbacks).toBe(0);
  });

  it('a read that hit a real error on a socket already closing is that error, not sent again', async () => {
    const fake = fakeClient(() => ({closes: true, error: pgError('42P01', 'no such table')}));
    const conn = connection(fake);
    await expect(conn.queryRaw(sql(SELECT))).rejects.toMatchObject({cause: {originalCode: '42P01'}});
    expect(fake.log).toHaveLength(1);
  });

  it('a transaction statement error reaches Prisma the same way', async () => {
    const fake = fakeClient(text => (text === UPDATE ? {error: pgError('23505')} : undefined));
    const conn = connection(fake);
    const tx = await conn.startTransaction();
    await expect(tx.executeRaw(sql(UPDATE))).rejects.toBeInstanceOf(DriverAdapterError);
  });
});

describe('with the socket off', () => {
  it('sends statements over HTTPS and opens nothing', async () => {
    const fake = fakeClient(text => (text === UPDATE ? {error: pgError('23505')} : undefined));
    const conn = new SocketConnection({connectionString: 'postgres://u:p@db.prisma.io/x', client: fake.client, socket: false});
    await conn.queryRaw(sql(SELECT));
    await expect(conn.executeRaw(sql(UPDATE))).rejects.toBeInstanceOf(DriverAdapterError);
    expect(fake.newSession).not.toHaveBeenCalled();
    expect(fake.log).toEqual([`https:${SELECT}`, `https:${UPDATE}`]);
  });
});

describe('transactions', () => {
  it('each has its own socket, and BEGIN comes first', async () => {
    const fake = fakeClient();
    const conn = connection(fake);
    await conn.queryRaw(sql(SELECT));
    const tx = await conn.startTransaction();
    await tx.executeRaw(sql(UPDATE));
    await tx.commit();
    expect(fake.newSession).toHaveBeenCalledTimes(2);
    expect(fake.log.slice(1)).toEqual(['socket2:BEGIN', `socket2:${UPDATE}`, 'socket2:COMMIT']);
    expect(fake.sessions[1].active).toBe(false);
    expect(fake.sessions[0].active).toBe(true);
  });

  it('rolls back and closes', async () => {
    const fake = fakeClient();
    const conn = connection(fake);
    const tx = await conn.startTransaction('SERIALIZABLE');
    await tx.executeRaw(sql(UPDATE));
    await tx.rollback();
    expect(fake.log).toEqual(['socket1:BEGIN ISOLATION LEVEL SERIALIZABLE', `socket1:${UPDATE}`, 'socket1:ROLLBACK']);
    expect(fake.sessions[0].active).toBe(false);
  });
});

describe('the copied conversion', () => {
  it('matches the installed adapter: copy it again when this fails', () => {
    const pkg = JSON.parse(readFileSync(new URL('../node_modules/@prisma/adapter-ppg/package.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(CONVERSION_FROM_ADAPTER_VERSION);
  });
});
