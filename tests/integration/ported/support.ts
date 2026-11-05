import {expect} from 'vitest';

import {webhookTarget} from '@/lib/webhook-targets';
import {getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import {app} from '../../../src/server/app';
import type {Db} from '../../../src/server/crm/kit/db';
import {drainBacklog} from '../../../src/server/crm/lib/jobs';
import {owner, ownerAt} from '../support/crm';
import {type Browser, db, ORIGIN} from '../support/harness';

/**
 * Helpers shared by the tests ported from Kinroot's scripts/test-*.mjs: the original scripts drove a
 * dev server over HTTP with a local SMTP sink and webhook receiver; here the real Site API runs
 * in-process and the outside services (the webhook services of src/crm/lib/webhook-targets.ts and
 * Resend's API) are faked at `fetch`, so nothing leaves the machine.
 */

export type Res = {status: number; json: Record<string, unknown>; headers: Headers};
export type Member = {id: string; name: string; role: string; email?: string};

/** The answer's JSON, or a failed test that says which call went wrong. */
export function must<T = Record<string, any>>(res: Res, what: string): T {
  expect(res.status, `${what}: ${JSON.stringify(res.json).slice(0, 500)}`).toBeLessThan(300);
  return res.json as T;
}

/**
 * A CRM Owner, signed in: the site owner ("View as admin", made the CRM Owner by its first visit), or
 * with `email`, an Owner at that real address (the site owner has none: `ownerAt`).
 */
export async function crmOwner(email?: string): Promise<{browser: Browser; me: Member}> {
  const browser = email ? (await ownerAt(email)).browser : await owner();
  const state = await browser.get('/site-api/crm/auth/state');
  expect(state.status).toBe(200);
  return {browser, me: state.json.user as Member};
}

/** A Kinroot Member row of a signed-in browser (after `teammate()`). */
export async function memberOf(browser: Browser): Promise<Member> {
  return (await browser.get('/site-api/crm/auth/state')).json.user as Member;
}

/** Runs `work` in a request scope (its own Site Database client), as a platform job or schedule would. */
export function inScope<T>(work: () => Promise<T>): Promise<T> {
  return inRequestScope(async () => {
    try {
      return await work();
    } finally {
      await getDb()?.$disconnect();
    }
  });
}

/** The harness's database client as Kinroot's `Db`. */
export const crmDb = db as unknown as Db;

/** A request from another service (no session, no CSRF token), e.g. to a Data in webhook URL. */
export async function outside(path: string, init: {method?: string; headers?: Record<string, string>; body?: string} = {}) {
  return inScope(async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
    const res = await app.request(
      `${ORIGIN}${path}`,
      {method: init.method ?? 'POST', headers: {'cf-connecting-ip': '198.51.100.20', ...init.headers}, body: init.body},
      {},
      ctx as never,
    );
    while (pending.length) await pending.shift();
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {text};
    }
    return {status: res.status, json, headers: res.headers};
  });
}

/**
 * "Time passes" for jobs planned for later: on this machine they wait in `JobBacklog` until due and
 * `crm-tick` (or the next request) sends them. Makes the matching ones due now and sends them.
 */
export async function wakeBacklog(where: {list?: string; runId?: string} = {}) {
  // Dates from here, never SQL now(): the columns are UTC `timestamp`s and the test database's zone may not be UTC.
  const past = new Date(Date.now() - 1000);
  await db.jobBacklog.updateMany({where: where.runId ? {data: {path: ['runId'], equals: where.runId}} : where.list ? {list: where.list} : {}, data: {runAt: past}});
  return inScope(() => drainBacklog(crmDb, 100));
}

/** "Time passes" for a waiting automation run: its wait is over now, and its job is sent. */
export async function wakeRun(runId: string) {
  await db.automationRun.updateMany({where: {id: runId, status: 'waiting'}, data: {waitUntil: new Date(Date.now() - 1000)}});
  return wakeBacklog({runId});
}

/** A date `ms` milliseconds ago (for moving record and cursor timestamps back: "time passes"). */
export const ago = (ms: number) => new Date(Date.now() - ms);

// ─── Outside services, faked ────────────────────────────────────────────────

export type Hit = {url: string; path: string; headers: Record<string, string>; body: string};
export type Mail = {from: string; to: string[]; subject: string; html: string; text: string};

/** What the fake services received, and how the webhook services answer (per path; 200 by default). */
export const outbound = {
  hooks: [] as Hit[],
  mails: [] as Mail[],
  answer: (_path: string): number => 200,
  reset() {
    this.hooks.length = 0;
    this.mails.length = 0;
    this.answer = () => 200;
  },
};

let installed = false;

/**
 * Fakes the webhook services (any URL `webhookTarget()` accepts) and Resend's API (domains check
 * and sending), wrapping whatever `fetch` the harness installed. Idempotent.
 */
export function fakeOutbound() {
  if (installed) return;
  installed = true;
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.hostname === 'api.resend.com') {
      if (url.pathname === '/domains') return Response.json({data: []});
      if (url.pathname === '/emails' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Mail;
        outbound.mails.push({from: body.from, to: ([] as string[]).concat(body.to), subject: body.subject, html: body.html ?? '', text: body.text ?? ''});
        return Response.json({id: `re_${outbound.mails.length}`});
      }
      return Response.json({message: 'not faked'}, {status: 404});
    }
    if (webhookTarget(href)) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      outbound.hooks.push({url: href, path: url.pathname, headers, body: String(init?.body ?? '')});
      const status = outbound.answer(url.pathname);
      return new Response(JSON.stringify({ok: status < 300}), {status, headers: {'content-type': 'application/json'}});
    }
    return previous(input, init);
  };
}

/** HMAC-SHA256 hex, to check signatures the way a receiver would. */
export async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))).toString('hex');
}

export async function hmacBase64(secret: string, message: string) {
  return Buffer.from(await hmacHex(secret, message), 'hex').toString('base64');
}

/** `X-Webhook-Signature: t=<s>,v1=<hex>` checked as Kinroot's docs tell receivers to. */
export async function signatureValid(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  return (await hmacHex(secret, `${parts.t}.${raw}`)) === parts.v1;
}

export const ZAPIER = 'https://hooks.zapier.com/hooks/catch/123456';
