/**
 * Raw TCP/TLS sockets for SMTP.
 *
 * Cloudflare Workers: `cloudflare:sockets` (port 25 is blocked there).
 * Node (local dev / Preview): node:net + node:tls. Both modules are imported
 * through a variable so the bundler never tries to resolve the other runtime.
 * Reads are raw bytes; the SMTP client decodes its own replies.
 */

export type SocketSecurity = 'tls' | 'starttls' | 'none';

export type SocketConfig = {host: string; port: number; security: SocketSecurity};

export interface ByteTransport {
  write(data: string | Uint8Array): Promise<void>;
  /** Next chunk, or null once the server closed the connection. */
  read(): Promise<Uint8Array | null>;
  /** STARTTLS: switch the open connection to TLS. */
  upgrade(): Promise<void>;
  close(): void;
}

const enc = new TextEncoder();
const bytes = (data: string | Uint8Array) => (typeof data === 'string' ? enc.encode(data) : data);

export const isWorkers = () => typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

async function cloudflareSocket(cfg: SocketConfig): Promise<ByteTransport> {
  const mod = 'cloudflare:sockets';
  const {connect} = (await import(/* @vite-ignore */ mod)) as {
    connect: (addr: {hostname: string; port: number}, opts: {secureTransport: 'on' | 'off' | 'starttls'; allowHalfOpen: boolean}) => any;
  };
  let socket = connect(
    {hostname: cfg.host, port: cfg.port},
    {secureTransport: cfg.security === 'tls' ? 'on' : cfg.security === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false},
  );
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  return {
    write: (data) => writer.write(bytes(data)),
    async read() {
      const {value, done} = await reader.read();
      return done ? null : (value as Uint8Array);
    },
    async upgrade() {
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    close: () => void socket.close().catch(() => {}),
  };
}

async function nodeSocket(cfg: SocketConfig): Promise<ByteTransport> {
  const netMod = 'node:net';
  const tlsMod = 'node:tls';
  const net = await import(/* @vite-ignore */ netMod);
  const tls = await import(/* @vite-ignore */ tlsMod);

  const queue: Uint8Array[] = [];
  let waiting: ((v: Uint8Array | null) => void) | null = null;
  let ended = false;
  let failure: Error | null = null;
  const push = (chunk: Uint8Array | null) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(chunk);
    } else if (chunk !== null) queue.push(chunk);
  };
  const attach = (s: any) => {
    s.on('data', (d: Uint8Array) => push(new Uint8Array(d)));
    s.on('end', () => {
      ended = true;
      push(null);
    });
    s.on('error', (e: Error) => {
      failure = e;
      ended = true;
      push(null);
    });
  };

  let socket: any = await new Promise((resolve, reject) => {
    const s =
      cfg.security === 'tls'
        ? tls.connect({host: cfg.host, port: cfg.port, servername: cfg.host}, () => resolve(s))
        : net.connect({host: cfg.host, port: cfg.port}, () => resolve(s));
    s.once('error', reject);
  });
  attach(socket);

  return {
    write: (data) => new Promise((res, rej) => socket.write(bytes(data), (e?: Error) => (e ? rej(e) : res()))),
    read() {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve(null);
      return new Promise((r) => (waiting = r));
    },
    async upgrade() {
      socket.removeAllListeners('data');
      socket.removeAllListeners('end');
      socket.removeAllListeners('error');
      const raw = socket;
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({socket: raw, servername: cfg.host}, () => resolve(s));
        s.once('error', reject);
      });
      attach(socket);
    },
    close: () => socket.end(),
  };
}

export const openSocket = (cfg: SocketConfig) => (isWorkers() ? cloudflareSocket(cfg) : nodeSocket(cfg));

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(onTimeout()), ms)))]).finally(() => clearTimeout(timer));
}
