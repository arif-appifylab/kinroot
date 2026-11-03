import {expect} from 'vitest';

import {getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import type {Db} from '../../../src/server/crm/kit/db';
import {runJob} from '../../../src/server/crm/lib/jobs';
import {env} from '../support/cloudflare-workers';
import type {Browser} from '../support/harness';

/**
 * Shared by the ported Kinroot scripts: the original pointed a mailbox at a local SMTP sink; SMTP is
 * gone (PLAN.md, visible change 1), so mailboxes here are Resend accounts whose key is the owner
 * secret `RESEND_API_KEY`, and calls to api.resend.com are captured instead of sent. Inbound mail is
 * posted to the inbound webhook with the Basic credentials of `INBOUND_BASIC_AUTH` (visible change 7).
 */

export type Mail = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: {filename: string; content: string; content_type: string}[];
};

/** Every email that would have gone to Resend, in order. */
export const mails: Mail[] = [];
/** While set, Resend answers this status (a provider error) and nothing is captured. */
export const resend: {fail: number | null} = {fail: null};

const INBOUND_AUTH = 'kinroot:a-long-inbound-password';
let previous: typeof fetch | null = null;

export function fakeResend() {
  if (previous) return;
  env.RESEND_API_KEY = 're_test_0123456789';
  env.INBOUND_BASIC_AUTH = INBOUND_AUTH;
  previous = globalThis.fetch;
  const before = previous;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const path = new URL(url).pathname;
      if (path === '/domains') return Response.json({data: []});
      if (path === '/emails' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        if (resend.fail) return Response.json({message: 'try again later'}, {status: resend.fail});
        mails.push(JSON.parse(String(init?.body ?? '{}')) as Mail);
        return Response.json({id: `re_${mails.length}`});
      }
      return Response.json({message: 'not found'}, {status: 404});
    }
    return before(input, init);
  };
}

export function restoreResend() {
  if (previous) globalThis.fetch = previous;
  previous = null;
  delete env.RESEND_API_KEY;
  delete env.INBOUND_BASIC_AUTH;
  mails.length = 0;
  resend.fail = null;
}

/** Mail captured since `from` (an index into `mails`) to `address`. */
export const mailsTo = (address: string, from = 0) => mails.slice(from).filter(m => m.to.includes(address));

/** A Resend mailbox (`shared` = a team account; needs an admin). */
export async function mailbox(browser: Browser, account: {fromEmail: string; fromName?: string; replyTo?: string; shared?: boolean; isDefault?: boolean}) {
  const res = await browser.post('/site-api/crm/email/accounts', {
    credentials: {provider: 'RESEND'},
    account: {fromName: account.fromName ?? 'Team', shared: false, ...account},
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.account as {id: string; status: string; fromEmail: string};
}

/** Posts a message to the inbound webhook the way the mail service would (signed with the owner secret). */
export async function inbound(browser: Browser, payload: Record<string, unknown>) {
  const settings = await browser.get('/site-api/crm/settings');
  const token = (settings.json.settings as {inboundToken: string}).inboundToken;
  const res = await browser.request('POST', `/site-api/crm/inbound/${token}`, payload, {authorization: `Basic ${btoa(INBOUND_AUTH)}`});
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as {ok: boolean; stored?: boolean};
}

/**
 * Runs scheduled work (what the original's `POST /jobs/run` did) the way a platform schedule runs
 * it: in its own scope with the Site Database and an outbox, so the jobs it queues run once it ends.
 */
export function inJob<T>(work: (db: Db) => Promise<T>): Promise<T> {
  return inRequestScope(async () => {
    let out: T | undefined;
    try {
      await runJob(async d => {
        out = await work(d);
      });
    } finally {
      await getDb()?.$disconnect();
    }
    return out as T;
  });
}
