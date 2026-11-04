import {expect} from 'vitest';

import {getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import type {Db} from '../../../src/server/crm/kit/db';
import {app} from '../../../src/server/app';
import {owner, ownerAt} from '../support/crm';
import {type Browser, ORIGIN, signedIn} from '../support/harness';

/**
 * Shared helpers for the tests ported from Kinroot's scripts/ (tests/integration/ported/*).
 * The original scripts drove a dev server over HTTP; these drive the same Site API in-process
 * through the harness's Browser.
 */

export const API = '/site-api/crm';

export type Res = {status: number; json: Record<string, unknown>; headers: Headers};

/** A CRM call: `crm(browser).get('/lists')` is `GET /site-api/crm/lists`. */
export function crm(browser: Browser) {
  return {
    browser,
    get: (path: string) => browser.get(API + path) as Promise<Res>,
    post: (path: string, body: unknown = {}) => browser.post(API + path, body) as Promise<Res>,
    patch: (path: string, body: unknown) => browser.request('PATCH', API + path, body) as Promise<Res>,
    put: (path: string, body: unknown) => browser.request('PUT', API + path, body) as Promise<Res>,
    del: (path: string) => browser.delete(API + path) as Promise<Res>,
  };
}
export type Crm = ReturnType<typeof crm>;

/** The answer's JSON when it is a success; fails the test with the answer otherwise (the scripts' `must`). */
export function must<T = Record<string, unknown>>(res: Res, what: string): T {
  expect(res.status, `${what}: ${JSON.stringify(res.json).slice(0, 600)}`).toBeLessThan(300);
  return res.json as T;
}

export type Me = {id: string; name: string; email: string; role: string};

/**
 * The signed-in CRM Owner, after the workspace setup (default pipeline; demo data when asked).
 * `email`: an Owner at a real-looking address (the site owner has none, and system emails skip
 * reserved test domains, so a test that reads the owner's mail needs one).
 */
export async function workspace(demoData = false, email?: string) {
  const browser = email ? (await ownerAt(email)).browser : await owner();
  const c = crm(browser);
  const state = must<{user: Me; needsSetup: boolean}>(await c.get('/auth/state'), 'state');
  if (state.needsSetup) must(await c.post('/auth/setup', {brandName: 'Kinroot', demoData}), 'setup');
  return {c, me: state.user};
}

/** The signed-in member's own team row. */
export async function meOf(c: Crm): Promise<Me> {
  return must<{user: Me}>(await c.get('/auth/state'), 'state').user;
}

/** Polls `read` until its status is one of `done` (background work runs in-process, but some finishes after the answer): up to 10 s. */
export {settle} from '../support/wait';

/** Runs scheduled work (what the old `/jobs/run` cron did) with the Site Database of a request scope. */
export async function tick<T>(work: (db: Db) => Promise<T>): Promise<T> {
  return inRequestScope(async () => {
    try {
      return await work(getDb() as unknown as Db);
    } finally {
      await getDb()?.$disconnect();
    }
  });
}

/** The platform storage upload the browser makes (src/platform/files-browser.ts putFile); needs fakeStorage(). */
export async function putBytes(upload: {url: string; headers: Record<string, string>}, bytes: Uint8Array) {
  const res = await fetch(new URL(upload.url, ORIGIN), {method: 'PUT', headers: upload.headers, body: bytes as Uint8Array<ArrayBuffer>});
  expect(res.status).toBe(200);
}

/** Upload a CSV for import: create the upload, PUT the bytes, complete with the entity. Returns the complete answer. */
export async function uploadCsv(c: Crm, entity: string, name: string, text: string, extra: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode(text);
  const start = await c.post('/imports', {name, contentType: 'text/csv', size: bytes.byteLength});
  if (start.status !== 201) return start;
  const {fileId, upload} = start.json as {fileId: string; upload: {url: string; headers: Record<string, string>}};
  await putBytes(upload, bytes);
  return c.post(`/imports/${fileId}/complete`, {entity, ...extra});
}

/** An attachment on a contact / company / deal (the three upload calls). Returns the file row. */
export async function attach(c: Crm, target: {contactId?: string; companyId?: string; dealId?: string}, name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const start = must<{fileId: string; upload: {url: string; headers: Record<string, string>}}>(
    await c.post('/files', {name, contentType: 'text/plain', size: bytes.byteLength, ...target}),
    'file upload',
  );
  await putBytes(start.upload, bytes);
  return must<{file: {id: string; name: string}}>(await c.post(`/files/${start.fileId}/complete`), 'file complete').file;
}

/** Follows a CRM download (a redirect to a short storage link) and returns the file's text. */
export async function download(c: Crm, path: string) {
  const res = await c.browser.get(path.startsWith('/site-api') ? path : API + path);
  if (res.status !== 302 && res.status !== 303) return {status: res.status, text: ''};
  const got = await fetch(new URL(res.headers.get('location')!, ORIGIN));
  return {status: got.status, text: new TextDecoder('utf-8', {ignoreBOM: true}).decode(await got.arrayBuffer())};
}

/**
 * Wraps `globalThis.fetch` for calls whose URL `match`es (an outside service's fixed host) and
 * records them; everything else goes to the fetch that was there. `restore()` puts it back.
 */
export function stubFetch(match: (url: URL) => boolean, answer: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const previous = globalThis.fetch;
  const calls: {url: URL; init: RequestInit | undefined; body: unknown}[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, ORIGIN);
    if (!match(url)) return previous(input, init);
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* form or text body: kept as it is */
      }
    }
    calls.push({url, init, body});
    return answer(url, init);
  };
  return {calls, restore: () => void (globalThis.fetch = previous)};
}

/** A webhook URL on a service the migrated app allows (src/crm/lib/webhook-targets.ts). */
export const HOOK_URL = 'https://hooks.zapier.com/hooks/catch/123/ported/';

/** Stubs the webhook service so deliveries (run in-process as jobs) never leave the machine. */
export const stubHooks = () => stubFetch((u) => u.hostname === 'hooks.zapier.com', () => new Response('ok', {status: 200}));
