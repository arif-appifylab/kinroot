/**
 * Minimal SMTP client (EHLO, STARTTLS / implicit TLS, AUTH PLAIN|LOGIN, DATA).
 *
 * Runs on Cloudflare Workers through `cloudflare:sockets` (ports 465/587; 25 is
 * blocked) and on Node (local dev / Preview) through node:net + node:tls,
 * both via socket.ts.
 */
import {openSocket, withTimeout as withDeadline, type SocketSecurity} from './socket';

export type SmtpSecurity = SocketSecurity;

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
};

export type SmtpEnvelope = {from: string; to: string[]; data: string};

interface Transport {
  write(data: string): Promise<void>;
  read(): Promise<string | null>;
  upgrade(): Promise<void>;
  close(): void;
}

const enc = new TextEncoder();

/** The shared byte socket (socket.ts), decoded as text: SMTP replies are line-based ASCII. */
async function openTransport(cfg: SmtpConfig): Promise<Transport> {
  const socket = await openSocket(cfg);
  let dec = new TextDecoder();
  return {
    write: (data) => socket.write(data),
    async read() {
      const chunk = await socket.read();
      return chunk === null ? null : dec.decode(chunk, {stream: true});
    },
    async upgrade() {
      await socket.upgrade();
      dec = new TextDecoder();
    },
    close: () => socket.close(),
  };
}

export class SmtpError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

class Session {
  private buffer = '';
  constructor(private t: Transport) {}

  /** Reads one (possibly multi-line) reply. */
  async reply(): Promise<{code: number; lines: string[]}> {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) {
        const chunk = await this.t.read();
        if (chunk === null) throw new SmtpError('Connection closed by server');
        this.buffer += chunk;
        continue;
      }
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) return {code: Number(line.slice(0, 3)), lines};
    }
  }

  async cmd(line: string, expect: number[], redact = false) {
    await this.t.write(`${line}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) {
      throw new SmtpError(`${redact ? line.split(' ')[0] : line} → ${r.lines.join(' ')}`, r.code);
    }
    return r;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => withDeadline(p, ms, () => new SmtpError(`${what} timed out`));

const b64 = (s: string) => {
  let bin = '';
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Connects, authenticates and (optionally) delivers one message. */
export async function smtpSend(cfg: SmtpConfig, envelope?: SmtpEnvelope): Promise<{response: string}> {
  const transport = await withTimeout(openTransport(cfg), 15_000, 'Connecting to SMTP server');
  const s = new Session(transport);
  try {
    return await withTimeout(
      (async () => {
        const greet = await s.reply();
        if (greet.code !== 220) throw new SmtpError(`Unexpected greeting: ${greet.lines.join(' ')}`, greet.code);
        let ehlo = await s.cmd('EHLO ezy-crm.local', [250]);

        if (cfg.security === 'starttls') {
          await s.cmd('STARTTLS', [220]);
          await transport.upgrade();
          ehlo = await s.cmd('EHLO ezy-crm.local', [250]);
        }

        if (cfg.username) {
          const authLine = ehlo.lines.find((l) => /^250[- ]AUTH/i.test(l)) ?? '';
          if (/PLAIN/i.test(authLine) || !/LOGIN/i.test(authLine)) {
            await s.cmd(`AUTH PLAIN ${b64(`\0${cfg.username}\0${cfg.password ?? ''}`)}`, [235], true);
          } else {
            await s.cmd('AUTH LOGIN', [334]);
            await s.cmd(b64(cfg.username), [334], true);
            await s.cmd(b64(cfg.password ?? ''), [235], true);
          }
        }

        if (!envelope) {
          await s.cmd('QUIT', [221]).catch(() => {});
          return {response: 'Connected and authenticated'};
        }

        await s.cmd(`MAIL FROM:<${envelope.from}>`, [250]);
        for (const rcpt of envelope.to) await s.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
        await s.cmd('DATA', [354]);
        // Dot-stuffing: lines starting with "." get an extra "."
        const body = envelope.data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        await transport.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
        const done = await s.reply();
        if (done.code !== 250) throw new SmtpError(`Message rejected: ${done.lines.join(' ')}`, done.code);
        await s.cmd('QUIT', [221]).catch(() => {});
        return {response: done.lines.join(' ')};
      })(),
      45_000,
      'SMTP session',
    );
  } finally {
    transport.close();
  }
}
