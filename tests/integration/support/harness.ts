import type {Hono} from 'hono';

import {resetOwnerAccountsForTests} from '../../../src/platform/auth/owner';
import {PREVIEW_COOKIE_HEADER, PREVIEW_SET_COOKIE_HEADER} from '../../../src/platform/auth/preview-cookies';
import {createDb, getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import {env} from './cloudflare-workers';

/**
 * Drives the REAL Site API (`src/server/app.ts`) in Node, against a real
 * Postgres, the way a browser would: an origin, cookies kept in a jar, the
 * CSRF cookie echoed in `x-csrf-token`, a client IP (`cf-connecting-ip`).
 * Each request runs in its own request scope with an execution context, and
 * its background work (`waitUntil`: relayed emails) finishes before it returns.
 *
 * Emails to the platform (`POST {SITE_URL}/api/site/v1/emails`) are
 * captured here. With `TEST_PLATFORM_URL` + `TEST_SITE_KEY` set, they are ALSO
 * sent to that real platform API, and its status is recorded.
 */

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const ORIGIN = 'https://shop.example.test';
const PLATFORM = process.env.TEST_PLATFORM_URL?.replace(/\/+$/, '') || 'https://platform.example.test';

export function configureEnv() {
  env.DATABASE_URL = DATABASE_URL;
  env.JWT_SECRET = 'integration-test-secret-0123456789-abcdefghijklmnop';
  env.SITE_URL = PLATFORM;
  env.SITE_KEY = process.env.TEST_SITE_KEY ?? 'stk_test_stub';
  env.SITE_PREVIEW = '';
}

export interface SentEmail {
  kind: string;
  to: string;
  path?: string;
  expiresInMinutes?: number;
  /** `sign_in_code` only: the 6 digits. */
  code?: string;
  /** The real platform's answer, when TEST_PLATFORM_URL is set. */
  platformStatus?: number;
}

export const emails: SentEmail[] = [];
const realFetch = globalThis.fetch;

/**
 * The platform's contract for `POST /api/site/v1/emails`, copied from
 * `api/app/modules/site_api/site_api.validator.ts`: a payload the real API
 * would refuse fails the test here.
 */
const KINDS = [
  'password_reset',
  'verify_email',
  'password_changed',
  'account_exists',
  'notification',
  'confirm_email_change',
  'email_changed',
  'sign_in_code',
];
const LINK_REQUIRED = ['password_reset', 'verify_email', 'confirm_email_change'];
// eslint-disable-next-line no-control-regex
const SITE_PATH = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

function assertContract(body: Record<string, unknown>) {
  const fail = (why: string) => {
    throw new Error(`email payload breaks the platform contract: ${why} ${JSON.stringify(body)}`);
  };
  const allowed = new Set(['kind', 'to', 'path', 'expiresInMinutes', 'subject', 'text', 'code']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) fail(`unknown field ${key}`);
  if (!KINDS.includes(String(body.kind))) fail('kind');
  if (typeof body.to !== 'string' || body.to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) fail('to');
  if (body.path !== undefined && (typeof body.path !== 'string' || body.path.length > 512 || !SITE_PATH.test(body.path))) {
    fail('path');
  }
  if (LINK_REQUIRED.includes(String(body.kind)) && body.path === undefined) fail('path required');
  if (body.kind === 'sign_in_code' && (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code))) fail('code');
  if (body.kind !== 'sign_in_code' && body.code !== undefined) fail('code only for sign_in_code');
  if (
    body.expiresInMinutes !== undefined &&
    (!Number.isInteger(body.expiresInMinutes) || (body.expiresInMinutes as number) < 1 || (body.expiresInMinutes as number) > 7 * 24 * 60)
  ) {
    fail('expiresInMinutes');
  }
}

/**
 * One-click owner sign-in tickets the fake platform will redeem ONCE
 * (`POST /api/site/v1/owner-sign-in`, apps/api owner_sign_in.service.ts): ticket → answer.
 */
export const ownerTickets = new Map<string, {email: string; name: string; ownerEmails: string[]}>();

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PLATFORM}/api/site/v1/owner-sign-in`) {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${env.SITE_KEY}`) throw new Error('owner sign-in without the Site Key');
    const {ticket} = JSON.parse(String(init?.body ?? '{}')) as {ticket?: string};
    const answer = ticket ? ownerTickets.get(ticket) : undefined;
    if (!answer || !ticket) return new Response(JSON.stringify({errors: [{code: 'E_OWNER_TICKET_INVALID'}]}), {status: 404});
    ownerTickets.delete(ticket);
    return new Response(JSON.stringify({data: answer}), {status: 200});
  }
  if (url === `${PLATFORM}/api/site/v1/emails`) {
    const body = JSON.parse(String(init?.body ?? '{}')) as SentEmail;
    assertContract(body as unknown as Record<string, unknown>);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${env.SITE_KEY}`) throw new Error('email relay without the Site Key');
    if (process.env.TEST_PLATFORM_URL) {
      const res = await realFetch(input, init);
      body.platformStatus = res.status;
      emails.push(body);
      return res;
    }
    emails.push(body);
    return new Response(JSON.stringify({data: {queued: true}}), {status: 202});
  }
  if (url.startsWith(PLATFORM)) return new Response('{}', {status: 404});
  return realFetch(input, init);
};

/** The 6-digit code in the last sign-in code email to `to`. */
export function codeFrom(to: string): string {
  const mail = [...emails].reverse().find(e => e.kind === 'sign_in_code' && e.to === to);
  if (!mail?.code) throw new Error(`no sign-in code email to ${to}`);
  return mail.code;
}

/** The token in the last email of `kind` to `to`. */
export function tokenFrom(kind: string, to: string): string {
  const mail = [...emails].reverse().find(e => e.kind === kind && e.to === to);
  const token = mail?.path ? new URL(mail.path, ORIGIN).searchParams.get('token') : null;
  if (!token) throw new Error(`no ${kind} email to ${to}`);
  return token;
}

/** A direct client for setup and assertions (never the code under test). */
export const db = createDb(DATABASE_URL || 'postgresql://unused@localhost/unused');

export async function resetDatabase() {
  await db.$executeRawUnsafe(
    'TRUNCATE "users", "user_roles", "refresh_tokens", "password_resets", "email_verifications", "email_changes", "recovery_codes", "sign_in_codes", "login_attempts", "audit_events", "jobs", "job_deliveries" RESTART IDENTITY CASCADE'
  );
  await db.$executeRawUnsafe('DELETE FROM "roles" WHERE NOT "is_system"');
  await db.$executeRawUnsafe('UPDATE "auth_state" SET "owner_user_id" = NULL');
  emails.length = 0;
  ownerTickets.clear();
  resetOwnerAccountsForTests();
}

type App = Pick<Hono, 'request'>;

/**
 * One browser: a cookie jar, an IP, a user agent. `gateway: 'preview'` is a
 * browser behind the editor Preview's gateway, which drops `Cookie` and
 * `Set-Cookie`: the jar then travels only in the Preview's cookie headers
 * (`src/platform/auth/preview-cookies.ts`), as `src/platform/browser.ts` does.
 */
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly app: App,
    readonly ip = '203.0.113.10',
    readonly gateway: 'direct' | 'preview' = 'direct'
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(`__Host-${name}`);
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers = new Headers({
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': this.ip,
      'user-agent': 'integration-test',
      ...extra,
    });
    if (method !== 'GET') {
      if (!this.cookie('site_csrf')) await this.request('GET', '/site-api/auth/csrf');
      if (!('x-csrf-token' in extra)) headers.set('x-csrf-token', this.cookie('site_csrf') ?? '');
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const jar = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.jar.size) headers.set(this.gateway === 'preview' ? PREVIEW_COOKIE_HEADER : 'cookie', jar);

    const res = await inRequestScope(async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
      const response = await this.app.request(
        `${ORIGIN}${path}`,
        {method, headers, body: body === undefined ? undefined : JSON.stringify(body)},
        {},
        ctx as never
      );
      // Background work can start more background work (register → verify email): drain it all.
      while (pending.length) await pending.shift();
      await getDb()?.$disconnect();
      return response;
    });

    if (this.gateway === 'preview') {
      // The gateway dropped Set-Cookie; the Preview hands the cookies over in a header.
      const mirrored = JSON.parse(res.headers.get(PREVIEW_SET_COOKIE_HEADER) ?? '[]') as [string, string, number][];
      for (const [name, value, maxAge] of mirrored) {
        if (maxAge > 0) this.jar.set(name, value);
        else this.jar.delete(name);
      }
    } else {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';').map(part => part.trim());
        const eq = pair!.indexOf('=');
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        const maxAge = attrs.find(a => a.startsWith('Max-Age='));
        if (maxAge === 'Max-Age=0') this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {text};
    }
    return {status: res.status, json, headers: res.headers};
  }

  get = (path: string) => this.request('GET', path);
  delete = (path: string) => this.request('DELETE', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
}

/** Register, confirm and sign in: a ready signed-in browser. */
export async function signedIn(app: App, email: string, password = 'a long test passphrase', ip?: string) {
  const browser = new Browser(app, ip);
  const reg = await browser.post('/site-api/auth/register', {email, name: email.split('@')[0], password});
  if (reg.status !== 202) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`);
  const verify = await browser.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', email)});
  if (verify.status !== 200) throw new Error(`verify ${verify.status}`);
  const login = await browser.post('/site-api/auth/login', {email, password});
  if (login.status !== 200) throw new Error(`login ${login.status} ${JSON.stringify(login.json)}`);
  return browser;
}

/**
 * An OWNER address (`ownerEmails` / `SITE_OWNER_EMAILS`) signing up: register,
 * confirm (which drops the registered password and emails a link to choose
 * one), set the password through that link (which claims owner), sign in.
 */
export async function ownerSignedIn(app: App, email: string, password = 'a long test passphrase', ip?: string) {
  const browser = new Browser(app, ip);
  const reg = await browser.post('/site-api/auth/register', {email, name: email.split('@')[0], password: 'a squat-proof first pass'});
  if (reg.status !== 202) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`);
  const verify = await browser.post('/site-api/auth/verify-email', {token: tokenFrom('verify_email', email)});
  if (verify.status !== 200 || verify.json.setPassword !== true) throw new Error(`verify ${verify.status} ${JSON.stringify(verify.json)}`);
  const reset = await browser.post('/site-api/auth/reset-password', {token: tokenFrom('password_reset', email), password});
  if (reset.status !== 200) throw new Error(`reset ${reset.status} ${JSON.stringify(reset.json)}`);
  const login = await browser.post('/site-api/auth/login', {email, password});
  if (login.status !== 200) throw new Error(`login ${login.status} ${JSON.stringify(login.json)}`);
  return browser;
}

export async function userId(email: string): Promise<number> {
  return (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
}
