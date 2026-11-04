import {DriverAdapterError} from '@prisma/driver-adapter-utils';
import type {
  ConnectionInfo,
  IsolationLevel,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
  TransactionOptions,
} from '@prisma/driver-adapter-utils';
import {client as createClient, type Client, type Session, type Statements} from '@prisma/ppg';

import {
  builtinParsers,
  convertArgs,
  convertDriverError,
  fieldToColumnType,
  isolationLevelToSql,
} from './db-socket-conversion';

/**
 * The Site Database driver for deployed sites and the Preview: ONE WebSocket per
 * request, instead of one HTTPS call per query. Measured in Frankfurt through the
 * real egress path: a query is ~3 ms against ~130 ms, opening the socket ~20 ms.
 * Prisma's own HTTPS client stays underneath as the fallback, so a socket that
 * can't open or dies costs time, never an answer.
 *
 * The rules that keep this correct (`tests/db-socket.test.ts` holds them):
 *
 * - Lives in the request's Prisma client (`getDb()`), never across requests: the
 *   Workers runtime refuses I/O from another request, and a socket has no owner
 *   between requests to share it safely.
 * - Only a PLAIN read may overlap other reads or be retried. Prisma sends
 *   `INSERT/UPDATE/DELETE ... RETURNING` through `queryRaw`, so the SQL decides, not
 *   the method: anything that isn't a plain `SELECT` is a write.
 * - A write waits for the reads and writes issued before it, and everything issued
 *   after it waits for it, so `Promise.all` keeps the order it was written in.
 * - A write is NEVER retried once it may have reached the database: a dead socket
 *   can't say whether it landed. It fails, as it would on a dropped connection. It
 *   only moves to HTTPS when the socket failed its check, before anything was sent.
 * - A transaction has its own socket, as in the stock adapter.
 * - A driver error reaches Prisma as a `DriverAdapterError`. Prisma's own adapter for this
 *   database throws a plain object instead, so `P2002` and friends never reach a route.
 * - A session ends after a query error, a moment later. So that socket is never used
 *   again: the next statement opens a new one, and a write can't be lost on a closing socket.
 */

/** How long a socket may take to open. Past it, this statement goes over HTTPS. */
const OPEN_TIMEOUT_MS = 5000;
/** How long a new socket may take to give its first answer before it counts as stalled. */
const FIRST_REPLY_TIMEOUT_MS = 5000;
/** Closed when idle this long, so a slow outside call doesn't keep it open. Reopening is ~20 ms. */
const IDLE_CLOSE_MS = 5000;
/** A socket that opened this slowly is worth one log line. */
const SLOW_OPEN_MS = 500;
/** At most one such line per Worker instance in this long. */
const LOG_EVERY_MS = 60_000;

const PLAIN_SELECT = /^\s*select\b/i;
/** A `SELECT` that locks, stores or changes something: run alone, never retried. */
const NOT_ONLY_A_READ =
  /\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b|\binto\b|\b(nextval|setval|set_config|pg_notify|pg_advisory\w*)\s*\(/i;
/** Postgres ending the connection, or the connection failing: the socket is gone. */
const CONNECTION_GONE = /^(57P0[123]|08)/;

const TIMED_OUT = Symbol('timed out');

/** True for a statement that only reads, so it may overlap others and be sent again. */
export function isPlainRead(sql: string): boolean {
  return PLAIN_SELECT.test(sql) && !NOT_ONLY_A_READ.test(sql);
}

export interface SocketStats {
  /** Sockets opened by this client. */
  opens: number;
  /** Statements answered over a socket. */
  statements: number;
  /** Statements that had to use HTTPS. */
  fallbacks: number;
  /** Most statements in flight at once. */
  maxInFlight: number;
  /** Slowest socket open. */
  slowestOpenMs: number;
}

export interface SocketAdapterOptions {
  connectionString: string;
  /** `false`: every statement outside a transaction over HTTPS (`SITE_DB_TRANSPORT=https`). */
  socket?: boolean;
  /** Tests only. */
  client?: Client;
  /** Tests only. */
  timings?: {openMs?: number; firstReplyMs?: number; idleMs?: number};
}

let lastLogAt = 0;

function logSlowSocket(event: string, ms?: number) {
  const now = Date.now();
  if (now - lastLogAt < LOG_EVERY_MS) return;
  lastLogAt = now;
  // Never the SQL, its values or the connection string.
  console.warn(`[site-db] ${event}`, ms === undefined ? '' : `${ms}ms`);
}

function errorCode(error: unknown): string {
  const code = (error as {cause?: {originalCode?: unknown}} | null)?.cause?.originalCode;
  return typeof code === 'string' ? code : '';
}

/** Prisma's error for a driver error, which is what gives a route `P2002`. Anything else stays as it is. */
function adapterError(error: unknown): unknown {
  return new DriverAdapterError(convertDriverError(error) as ConstructorParameters<typeof DriverAdapterError>[0]);
}

async function runQuery(executor: Statements, query: SqlQuery): Promise<SqlResultSet> {
  try {
    const args = convertArgs(query.args, query.argTypes);
    const result = await executor.query(query.sql, ...args);
    const rows = await result.rows.collect();
    return {
      columnNames: result.columns.map(column => column.name),
      columnTypes: result.columns.map(column => fieldToColumnType(column.oid)),
      rows: rows.map(row => row.values),
    };
  } catch (error) {
    throw adapterError(error);
  }
}

async function runExec(executor: Statements, query: SqlQuery): Promise<number> {
  try {
    return await executor.exec(query.sql, ...convertArgs(query.args, query.argTypes));
  } catch (error) {
    throw adapterError(error);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export class SocketConnection implements SqlDriverAdapter {
  readonly provider = 'postgres' as const;
  readonly adapterName = 'site-db-socket';
  readonly stats: SocketStats = {opens: 0, statements: 0, fallbacks: 0, maxInFlight: 0, slowestOpenMs: 0};

  #client: Client;
  #useSocket: boolean;
  #openMs: number;
  #firstReplyMs: number;
  #idleMs: number;
  #session: Session | null = null;
  #opening: Promise<Session> | null = null;
  /** This socket has answered: nothing sent on it from now on is a test of the socket. */
  #proven = false;
  #inFlight = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #lastWrite: Promise<unknown> = Promise.resolve();
  #reads = new Set<Promise<unknown>>();

  constructor(options: SocketAdapterOptions) {
    this.#client = options.client ?? createClient({connectionString: options.connectionString, parsers: builtinParsers});
    this.#useSocket = options.socket !== false;
    this.#openMs = options.timings?.openMs ?? OPEN_TIMEOUT_MS;
    this.#firstReplyMs = options.timings?.firstReplyMs ?? FIRST_REPLY_TIMEOUT_MS;
    this.#idleMs = options.timings?.idleMs ?? IDLE_CLOSE_MS;
  }

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const work = (executor: Statements) => runQuery(executor, query);
    return isPlainRead(query.sql) ? this.#read(work) : this.#write(work);
  }

  executeRaw(query: SqlQuery): Promise<number> {
    return this.#write(executor => runExec(executor, query));
  }

  async executeScript(script: string): Promise<void> {
    await this.#client.query(script);
  }

  getConnectionInfo(): ConnectionInfo {
    return {maxBindValues: 16 << 10, schemaName: 'public', supportsRelationJoins: true};
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    return new SocketTransaction(await this.#client.newSession(), isolationLevel);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.#lastWrite, ...this.#reads]);
    clearTimeout(this.#idleTimer);
    this.#drop();
  }

  /** Reads overlap each other, never a write: a read issued after a write sees it. */
  #read<T>(work: (executor: Statements) => Promise<T>): Promise<T> {
    const running = this.#lastWrite.then(() => this.#runRead(work));
    this.#reads.add(running);
    const done = () => this.#reads.delete(running);
    running.then(done, done);
    return running;
  }

  /** A write runs alone, in the order it was issued. */
  #write<T>(work: (executor: Statements) => Promise<T>): Promise<T> {
    const running = Promise.allSettled([this.#lastWrite, ...this.#reads]).then(() => this.#runWrite(work));
    this.#lastWrite = running.then(noop, noop);
    return running;
  }

  async #runRead<T>(work: (executor: Statements) => Promise<T>): Promise<T> {
    if (!this.#useSocket) return work(this.#client);
    this.#begin();
    try {
      let session: Session;
      try {
        session = await this.#socket();
      } catch {
        return await this.#overHttps(work);
      }
      try {
        const reply = this.#proven ? await work(session) : await this.#firstReply(work(session));
        if (reply === TIMED_OUT) {
          this.#drop();
          logSlowSocket('socket stalled, used HTTPS');
          return await this.#overHttps(work);
        }
        this.#answered();
        return reply as T;
      } catch (error) {
        this.#noteFailure(session);
        // Postgres answered with an error about this statement: sending it again won't change that.
        const code = errorCode(error);
        if (code && !CONNECTION_GONE.test(code)) throw error;
        return await this.#overHttps(work);
      }
    } finally {
      this.#end();
    }
  }

  async #runWrite<T>(work: (executor: Statements) => Promise<T>): Promise<T> {
    if (!this.#useSocket) return work(this.#client);
    this.#begin();
    try {
      let session: Session;
      try {
        session = await this.#socket();
        // A write must not be what finds out a socket is bad: its fate would be unknown.
        if (!this.#proven) await this.#check(session);
      } catch {
        // Nothing of this write has been sent, so HTTPS can't apply it twice.
        this.#drop();
        return await this.#overHttps(work);
      }
      try {
        const reply = await work(session);
        this.#answered();
        return reply;
      } catch (error) {
        this.#noteFailure(session);
        throw error; // Never sent again: it may have landed.
      }
    } finally {
      this.#end();
    }
  }

  async #check(session: Session): Promise<void> {
    const reply = await this.#firstReply(
      (async () => {
        const result = await session.query('SELECT 1');
        await result.rows.collect();
      })()
    );
    if (reply === TIMED_OUT) throw new Error('socket stalled');
    this.#answered();
  }

  #firstReply<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    return withTimeout(work, this.#firstReplyMs);
  }

  #socket(): Promise<Session> {
    if (this.#session?.active) return Promise.resolve(this.#session);
    this.#session = null;
    return (this.#opening ??= this.#open().finally(() => {
      this.#opening = null;
    }));
  }

  async #open(): Promise<Session> {
    const started = Date.now();
    const opening = this.#client.newSession();
    const session = await withTimeout(opening, this.#openMs);
    if (session === TIMED_OUT) {
      void opening.then(late => late.close(), noop);
      throw new Error('socket did not open');
    }
    const took = Date.now() - started;
    this.stats.opens++;
    this.stats.slowestOpenMs = Math.max(this.stats.slowestOpenMs, took);
    if (took >= SLOW_OPEN_MS) logSlowSocket('slow socket open', took);
    this.#session = session;
    this.#proven = false;
    return session;
  }

  #answered() {
    this.#proven = true;
    this.stats.statements++;
  }

  /**
   * Never use this socket again: a session ends a moment after a query error, and a lost
   * connection has already ended it.
   */
  #noteFailure(session: Session) {
    if (this.#session === session) this.#drop();
  }

  async #overHttps<T>(work: (executor: Statements) => Promise<T>): Promise<T> {
    this.stats.fallbacks++;
    return work(this.#client);
  }

  #begin() {
    clearTimeout(this.#idleTimer);
    this.#inFlight++;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.#inFlight);
  }

  #end() {
    this.#inFlight--;
    if (this.#inFlight === 0 && this.#session) {
      this.#idleTimer = setTimeout(() => this.#drop(), this.#idleMs);
    }
  }

  #drop() {
    const session = this.#session;
    this.#session = null;
    this.#proven = false;
    try {
      session?.close();
    } catch {
      // Already closed.
    }
  }
}

/** The stock adapter's transaction: its own socket, `BEGIN` on first use, closed at the end. */
class SocketTransaction implements Transaction {
  readonly provider = 'postgres' as const;
  readonly adapterName = 'site-db-socket';
  readonly options: TransactionOptions = {usePhantomQuery: false};

  #session: Session;
  #isolationLevel?: IsolationLevel;
  #begun = false;
  #finished = false;

  constructor(session: Session, isolationLevel?: IsolationLevel) {
    this.#session = session;
    this.#isolationLevel = isolationLevel;
  }

  async #ensureBegun() {
    if (this.#begun) return;
    const level = this.#isolationLevel ? ` ISOLATION LEVEL ${isolationLevelToSql(this.#isolationLevel)}` : '';
    try {
      await this.#session.query(`BEGIN${level}`);
      this.#begun = true;
    } catch (error) {
      this.#session.close();
      throw adapterError(error);
    }
  }

  async commit() {
    if (this.#finished) throw new Error('Transaction already finished');
    try {
      await this.#ensureBegun();
      await this.#session.query('COMMIT');
      this.#finished = true;
    } catch (error) {
      throw adapterError(error);
    } finally {
      this.#session.close();
    }
  }

  async rollback() {
    if (this.#finished) throw new Error('Transaction already finished');
    try {
      if (this.#begun) await this.#session.query('ROLLBACK');
      this.#finished = true;
    } catch (error) {
      throw adapterError(error);
    } finally {
      this.#session.close();
    }
  }

  async createSavepoint(name: string) {
    await this.executeRaw({sql: `SAVEPOINT ${name}`, args: [], argTypes: []});
  }

  async rollbackToSavepoint(name: string) {
    await this.executeRaw({sql: `ROLLBACK TO SAVEPOINT ${name}`, args: [], argTypes: []});
  }

  async releaseSavepoint(name: string) {
    await this.executeRaw({sql: `RELEASE SAVEPOINT ${name}`, args: [], argTypes: []});
  }

  async executeRaw(query: SqlQuery) {
    await this.#ensureBegun();
    return runExec(this.#session, query);
  }

  async queryRaw(query: SqlQuery) {
    await this.#ensureBegun();
    return runQuery(this.#session, query);
  }
}

export class SocketAdapter implements SqlDriverAdapterFactory {
  readonly provider = 'postgres' as const;
  readonly adapterName = 'site-db-socket';
  /** The connection Prisma opened, for its stats. */
  connection: SocketConnection | null = null;

  #options: SocketAdapterOptions;

  constructor(options: SocketAdapterOptions) {
    this.#options = options;
  }

  async connect(): Promise<SocketConnection> {
    this.connection = new SocketConnection(this.#options);
    return this.connection;
  }
}

function noop() {}
