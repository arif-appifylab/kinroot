import {expect} from 'vitest';

import {app} from '../../../src/server/app';
import {type Browser, db, resetDatabase, signedIn, userId} from './harness';

export {userId};

/** Kinroot's tables (PascalCase; the template's are snake_case), emptied with the template's. */
export async function resetCrm() {
  await resetDatabase();
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

export async function owner() {
  const browser = await signedIn(app, 'owner@example.com');
  await setRoles('owner@example.com', 'owner');
  return browser;
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
