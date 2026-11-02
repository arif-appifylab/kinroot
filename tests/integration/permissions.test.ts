import {Hono} from 'hono';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {definePermissions} from '../../src/platform/auth/codenames';
import {getDb} from '../../src/platform/db';
import {can, forbidden, permissionScope, requireAuth, requirePermission, withViewer} from '../../src/platform/guards';
import {ensurePermissions, syncPermissions} from '../../src/platform/permission-sync';
import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {pagePermission} from '../../src/server/page-access';
import {Browser, configureEnv, DATABASE_URL, db, ORIGIN, resetDatabase, signedIn, userId} from './support/harness';

/**
 * The catalogue reaching the database at runtime (no migration), own-records
 * checks in a route, and the SSR page gate, against a real Postgres. The test
 * codenames live under `site:permtest:` and are removed after.
 */
const UPDATE = 'site:permtest:update';
const UPDATE_OWN = 'site:permtest:update_own';
const REPORT = 'site:permtest:report';

const catalogue = () =>
  definePermissions({
    UPDATE: {codename: UPDATE, title: 'Change notes', group: 'Notes', roles: ['permtest-editor']},
    UPDATE_OWN: {codename: UPDATE_OWN, title: 'Change own notes', group: 'Notes', roles: ['permtest-writer']},
    REPORT: {codename: REPORT, title: 'See reports', group: 'Notes', roles: ['permtest-editor', 'no-such-role']},
  });

const removeTestPermissions = () => db.$executeRawUnsafe(`DELETE FROM "permissions" WHERE "codename" LIKE 'site:permtest:%'`);

async function grantsOf(slug: string): Promise<string[]> {
  const rows = await db.rolePermission.findMany({
    where: {role: {slug}},
    select: {permission: {select: {codename: true}}},
  });
  return rows.map(r => r.permission.codename).sort();
}

/** Exactly these roles, whatever sign-up gave (the first account may have become owner). */
async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

/** A browser on another app, sharing `from`'s cookies. */
function sameSession(target: Pick<Hono, 'request'>, from: Browser) {
  const browser = new Browser(target, from.ip);
  for (const [k, v] of from.jar) browser.jar.set(k, v);
  return browser;
}

/** A route the way a site writes one: own variant let in, record checked in the handler. */
const notes = new Hono()
  .basePath('/site-api')
  .get('/notes/:owner', withViewer, requireAuth, requirePermission(UPDATE, {orOwn: true}), async c => {
    const ownerId = Number(c.req.param('owner'));
    if (!(await can(c, UPDATE, {ownerId}))) return forbidden(c);
    return c.json({ok: true});
  })
  .get('/strict', withViewer, requireAuth, requirePermission(UPDATE), c => c.json({ok: true}))
  .get('/scope', withViewer, requireAuth, async c => c.json({scope: await permissionScope(c, UPDATE)}));

describe.skipIf(!DATABASE_URL)('permissions (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await removeTestPermissions();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await removeTestPermissions();
    for (const slug of ['permtest-editor', 'permtest-writer']) {
      await db.role.create({data: {slug, name: slug, description: null}});
    }
  });

  it('inserts new codenames with their default roles once, and never re-grants', async () => {
    const first = await ensurePermissions(db, catalogue());
    expect(first.created.sort()).toEqual([REPORT, UPDATE, UPDATE_OWN]);
    expect(await grantsOf('permtest-editor')).toEqual([REPORT, UPDATE]);
    expect(await grantsOf('permtest-writer')).toEqual([UPDATE_OWN]);

    // The owner takes REPORT away from editors: a later sync must not give it back.
    await db.rolePermission.deleteMany({where: {role: {slug: 'permtest-editor'}, permission: {codename: REPORT}}});
    const again = await ensurePermissions(db, catalogue());
    expect(again).toEqual({created: [], updated: []});
    expect(await grantsOf('permtest-editor')).toEqual([UPDATE]);
  });

  it('two isolates syncing at once insert each row once', async () => {
    await Promise.all([ensurePermissions(db, catalogue()), ensurePermissions(db, catalogue())]);
    expect(await db.permission.count({where: {codename: {startsWith: 'site:permtest:'}}})).toBe(3);
    expect(await grantsOf('permtest-editor')).toEqual([REPORT, UPDATE]);
  });

  it('updates a changed title from the code', async () => {
    await ensurePermissions(db, catalogue());
    const renamed = definePermissions({...catalogue(), UPDATE: {codename: UPDATE, title: 'Edit any note', group: 'Notes'}});
    expect((await ensurePermissions(db, renamed)).updated).toEqual([UPDATE]);
    expect((await db.permission.findUniqueOrThrow({where: {codename: UPDATE}})).title).toBe('Edit any note');
  });

  it('the Site API middleware syncs on the first request with cookies, once', async () => {
    const cat = catalogue();
    const site = new Hono().use(syncPermissions(cat)).get('/x', c => c.json({ok: true}));
    const count = () => db.permission.count({where: {codename: {startsWith: 'site:permtest:'}}});
    const guest = new Browser(site);
    await guest.get('/x');
    expect(await count()).toBe(0); // a guest holds nothing: no sync
    guest.jar.set('__Host-anything', '1');
    await guest.get('/x');
    expect(await count()).toBe(3);
    await removeTestPermissions();
    await guest.get('/x');
    expect(await count()).toBe(0); // synced once per isolate, not per request
  });

  it('the core catalogue is already in step with the seed migration', async () => {
    const {CATALOGUE} = await import('../../src/server/permissions');
    expect(await ensurePermissions(db, CATALOGUE)).toEqual({created: [], updated: []});
  });

  it('own-records: the _own variant reaches only the viewer’s own record', async () => {
    await ensurePermissions(db, catalogue());
    const writer = await signedIn(app, 'writer@example.test', undefined, '203.0.113.41');
    const editor = await signedIn(app, 'editor@example.test', undefined, '203.0.113.42');
    const member = await signedIn(app, 'member@example.test', undefined, '203.0.113.43');
    await setRoles('writer@example.test', 'member', 'permtest-writer');
    await setRoles('editor@example.test', 'member', 'permtest-editor');
    await setRoles('member@example.test', 'member');
    const writerId = await userId('writer@example.test');
    const editorId = await userId('editor@example.test');

    const w = sameSession(notes, writer);
    expect((await w.get(`/site-api/notes/${writerId}`)).status).toBe(200);
    expect((await w.get(`/site-api/notes/${editorId}`)).status).toBe(403);
    expect((await w.get('/site-api/strict')).status).toBe(403); // own does not satisfy the full codename
    expect((await w.get('/site-api/scope')).json.scope).toBe('own');

    const e = sameSession(notes, editor);
    expect((await e.get(`/site-api/notes/${writerId}`)).status).toBe(200);
    expect((await e.get('/site-api/strict')).status).toBe(200);
    expect((await e.get('/site-api/scope')).json.scope).toBe('all');

    const m = sameSession(notes, member);
    expect((await m.get(`/site-api/notes/${await userId('member@example.test')}`)).status).toBe(403);
    expect((await m.get('/site-api/scope')).json.scope).toBe('none');
    expect((await new Browser(notes).get(`/site-api/notes/${writerId}`)).status).toBe(401);
  });

  it('pagePermission: allowed, forbidden, signed out', async () => {
    await ensurePermissions(db, catalogue());
    const editor = await signedIn(app, 'editor@example.test', undefined, '203.0.113.51');
    const member = await signedIn(app, 'member@example.test', undefined, '203.0.113.52');
    await setRoles('editor@example.test', 'member', 'permtest-editor');
    await setRoles('member@example.test', 'member');

    const visit = (browser: Browser | null) =>
      inRequestScope(async () => {
        const headers = new Headers();
        if (browser) headers.set('cookie', [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; '));
        const astro = {request: new Request(`${ORIGIN}/reports`, {headers}), response: {headers: new Headers(), status: 200}};
        const page = await pagePermission(astro, REPORT);
        await getDb()?.$disconnect();
        return {allowed: page.allowed, denied: page.denied, status: astro.response.status, viewer: page.viewer.state};
      });

    expect(await visit(editor)).toEqual({allowed: true, denied: null, status: 200, viewer: 'user'});
    expect(await visit(member)).toEqual({allowed: false, denied: 'forbidden', status: 403, viewer: 'user'});
    expect(await visit(null)).toEqual({allowed: false, denied: 'signed_out', status: 401, viewer: 'guest'});
  });
});
