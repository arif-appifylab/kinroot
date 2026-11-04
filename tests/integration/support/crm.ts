import {expect} from 'vitest';

import {setCacheModeForTests} from '../../../src/platform/cache';
import {app} from '../../../src/server/app';
import {type Browser, db, ownerAccountId, ownerSignedIn, resetDatabase, signedIn, userId} from './harness';

export {ownerAccountId, userId};

/** Kinroot's tables (PascalCase; the template's are snake_case), emptied with the template's. */
export async function resetCrm() {
  await resetDatabase();
  // Cached settings and brand (the Preview's in-memory Site Cache) belong to the emptied database.
  setCacheModeForTests(null);
  const tables = await db.$queryRaw<{t: string}[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^[A-Z]'`;
  // Names come from the catalogue just read, quoted; never from input.
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map(r => `"${r.t.replace(/"/g, '')}"`).join(', ')} CASCADE`);
}

/** Exactly these site roles (sign-up may have made the first account owner). */
export async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

/** The site owner, in through a "View as admin" ticket (the one way to be owner): the CRM's first Owner. */
export async function owner() {
  return ownerSignedIn(app);
}

/** The site owner's Kinroot `Member` id (after their first CRM request). */
export async function ownerMemberId() {
  return (await db.member.findUniqueOrThrow({where: {userId: await ownerAccountId()}, select: {id: true}})).id;
}

/**
 * A CRM Owner with a real address (the site owner has none on the site), the way the product makes
 * one: the site owner gives that account a site role holding `site:crm:own` (Settings → Roles and
 * Accounts), and its first CRM request makes it an Owner. For tests that read an Owner's own mail.
 */
export async function ownerAt(email: string) {
  const site = await owner();
  expect((await site.get('/site-api/crm/auth/state')).status).toBe(200);
  const browser = await signedIn(app, email);
  const made = await site.post('/site-api/admin/roles', {slug: 'crm-owner', name: 'CRM owner', description: '', permissions: ['site:crm:own']});
  expect([201, 409]).toContain(made.status);
  expect((await site.request('PUT', `/site-api/admin/users/${await userId(email)}/roles`, {roles: ['member', 'crm-owner']})).status).toBe(200);
  const state = await browser.get('/site-api/crm/auth/state');
  expect((state.json.user as {role?: string} | null)?.role).toBe('OWNER');
  return {browser, site};
}

/** Signs up `email`, then joins the team through an invite the owner makes. */
export async function teammate(ownerBrowser: Browser, email: string, role: 'ADMIN' | 'MEMBER' | 'VIEWER' = 'MEMBER') {
  const invite = await ownerBrowser.post('/site-api/crm/team/invite', {name: email.split('@')[0], email, role});
  expect(invite.status).toBe(200);
  const token = String(invite.json.inviteUrl).split('/invite/')[1]!;
  const browser = await signedIn(app, email);
  await setRoles(email, 'member');
  const joined = await browser.post(`/site-api/crm/auth/invite/${token}`);
  expect(joined.status).toBe(200);
  return {browser, token};
}

/**
 * The platform's file storage, faked for Kinroot's import / export / upload tests (the harness
 * fakes only emails and owner sign-in). Same contract as src/platform/files.ts: create an upload,
 * PUT the bytes to the site-relative upload URL, complete, then short links to read them.
 */
export const storedFiles = new Map<string, {name: string; contentType: string; size: number; visibility: string; bytes: Uint8Array | null}>();
let storageOn = false;

export function fakeStorage() {
  if (storageOn) return;
  storageOn = true;
  const previous = globalThis.fetch;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status, headers: {'content-type': 'application/json'}});
  const meta = (id: string) => {
    const f = storedFiles.get(id)!;
    const now = new Date().toISOString();
    return {id, name: f.name, contentType: f.contentType, size: f.size, visibility: f.visibility, status: f.bytes ? 'ready' : 'pending', environment: 'staging', createdAt: now, completedAt: f.bytes ? now : null};
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const api = /^\/api\/site\/v1\/files(?:\/(file_[0-9a-z]{26}))?(\/[a-z]+)?$/.exec(url.pathname);
    if (api) {
      const [, id, action] = api;
      if (!id && action === '/uploads' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {name: string; contentType: string; size: number; visibility?: string};
        const fileId = `file_${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
        storedFiles.set(fileId, {name: body.name, contentType: body.contentType, size: body.size, visibility: body.visibility ?? 'private', bytes: null});
        return json({file: meta(fileId), upload: {method: 'PUT', url: `/__platform/files/put/${fileId}`, headers: {}, expiresAt: new Date(Date.now() + 600_000).toISOString()}}, 201);
      }
      if (!id || !storedFiles.has(id)) return new Response(JSON.stringify({errors: [{code: 'E_NOT_FOUND', message: 'No such file'}]}), {status: 404});
      if (action === '/complete') return json({file: meta(id)});
      if (action === '/url') return json({url: `/__platform/files/get/${id}`, expiresAt: new Date(Date.now() + 300_000).toISOString()});
      if (action === '/delete') return storedFiles.delete(id), json({deleted: true});
      if (!action) return json({file: meta(id)});
    }
    const put = /^\/__platform\/files\/put\/(file_[0-9a-z]{26})$/.exec(url.pathname);
    if (put && method === 'PUT' && storedFiles.has(put[1]!)) {
      storedFiles.get(put[1]!)!.bytes = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
      return json({file: meta(put[1]!)});
    }
    const get = /^\/__platform\/files\/get\/(file_[0-9a-z]{26})$/.exec(url.pathname);
    if (get && storedFiles.get(get[1]!)?.bytes) return new Response(storedFiles.get(get[1]!)!.bytes as Uint8Array<ArrayBuffer>);
    return previous(input, init);
  };
}
