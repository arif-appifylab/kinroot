import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {problem} from '../../../platform/guards';
import {maskEmail} from '../../../platform/auth/admin';
import {publicFileUrl as platformPublicPath} from '../../../platform/files';
import {sha256Hex} from '../kit/crypto';
import {currentUser, type AppContext, type AppEnv} from '../kit/guards';
import {purgeFiles} from '../kit/storage';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {BRAND} from '@/lib/brand';
import {clearBrandCache} from '../lib/brand';
import {seedApp} from '../lib/seed';
import {getSettings, saveSettings} from '../lib/settings';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';
import {publicUser, seesEmails} from '../lib/users';
import {EMAIL_IMAGES, MAX_EMAIL_IMAGE} from './files';

/**
 * Kinroot's own account routes, on top of the site's sign-in (src/platform/auth). Signing in and
 * out, passwords, two-step sign-in and the account's name belong to the template
 * (`/account/*`, `/site-api/auth/*`, Settings → Security in the CRM); Kinroot never sees a password.
 *
 *   GET   /state             who is here: signed in? on the team? workspace set up?
 *   POST  /setup             first visit of the Owner: name the workspace, demo data or not
 *   GET   /invite/:token     an invite's team and (masked) address
 *   POST  /invite/:token     the signed-in account whose verified email was invited joins
 *   PATCH /me                profile colour (the name is the account's: PATCH /site-api/auth/me)
 *   *     /me/avatar         profile picture (upload in two steps, lib/uploads.ts)
 */

/** The Setting that records the Owner's first-run choices (brand name, demo data). */
const SETUP_KEY = 'workspace.setupAt';

const view = async (c: AppContext) => ({meId: c.var.user?.id ?? null, owner: await seesEmails(c)});

async function inviteByToken(c: AppContext, token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const member = await c.var.db.member.findUnique({where: {inviteTokenHash: await sha256Hex(token)}});
  // A deactivated (cancelled) invite never works, even with a link sent before (AUDIT-2 M-1).
  if (!member || member.userId !== null || !member.inviteEmail || !member.active) return null;
  if (member.inviteExpiresAt && member.inviteExpiresAt < new Date()) return null;
  return member;
}

export const auth = new Hono<AppEnv>()
  .get('/state', async (c) => {
    // An expired session is refreshed by the browser (`siteFetch` on 401 token_expired), not sent to sign in.
    if (c.var.viewer.state === 'returning') return c.json(problem('token_expired', 'Your session needs refreshing.'), 401);
    const db = c.var.db;
    const me = c.var.user;
    const [settings, setupDone] = await Promise.all([getSettings(db), db.setting.findUnique({where: {key: SETUP_KEY}, select: {key: true}})]);
    return c.json({
      // Only the Owner is asked to set the workspace up, once.
      needsSetup: me?.role === 'OWNER' && !setupDone,
      signedIn: c.var.viewer.state === 'user',
      user: me ? publicUser(me, await view(c)) : null,
      brandName: settings.brandName ?? BRAND.name,
    });
  })

  .post(
    '/setup',
    valid('json', z.object({brandName: z.string().trim().min(1).max(60), demoData: z.boolean().default(true)})),
    async (c) => {
      const me = currentUser(c);
      if (me.role !== 'OWNER') throw new HTTPException(403, {message: 'Only the owner sets the workspace up'});
      const db = c.var.db;
      const body = c.req.valid('json');
      // One setup, ever: a conditional insert, so two clicks never seed twice.
      const claimed = await db.setting.createMany({data: [{key: SETUP_KEY, value: new Date().toISOString()}], skipDuplicates: true});
      if (!claimed.count) throw new HTTPException(409, {message: 'This app is already set up'});
      await saveSettings(db, {brandName: body.brandName});
      await clearBrandCache();
      await seedApp(db, me.id, body.demoData);
      await audit(db, c, {action: 'auth.setup', entity: 'user', recordId: me.id, label: me.name, meta: {demoData: body.demoData}});
      return c.json({user: publicUser(me, await view(c))});
    },
  )

  .get('/invite/:token', async (c) => {
    const invited = await inviteByToken(c, c.req.param('token'));
    if (!invited) throw new HTTPException(404, {message: 'This invite link is invalid, expired or was already used'});
    const settings = await getSettings(c.var.db);
    // The link may have been forwarded: the address only masked, enough to recognise.
    return c.json({email: maskEmail(invited.inviteEmail!), name: invited.name, brandName: settings.brandName, signedIn: c.var.viewer.state === 'user'});
  })

  .post('/invite/:token', async (c) => {
    const db = c.var.db;
    const viewer = c.var.viewer;
    if (viewer.state !== 'user' || viewer.id === null) throw new HTTPException(401, {message: 'Sign in or create your account first'});
    const invited = await inviteByToken(c, c.req.param('token'));
    if (!invited) throw new HTTPException(404, {message: 'This invite link is invalid, expired or was already used'});
    // Never a sign-in link: it adds the SIGNED-IN account, and only the one it was sent to.
    if (!viewer.emailVerified) throw new HTTPException(403, {message: 'Confirm your email address first, then open the invite again'});
    if ((viewer.email ?? '').toLowerCase() !== invited.inviteEmail!.toLowerCase()) {
      throw new HTTPException(403, {message: 'This invite was sent to another address. Sign in with the account it was sent to.'});
    }
    if (await db.member.findUnique({where: {userId: viewer.id}, select: {id: true}})) throw new HTTPException(409, {message: 'You are already on this team'});
    // Conditional: only a still-pending invite is taken (two tabs, one join).
    const taken = await db.member.updateMany({
      // Only an active invite; joining never re-activates a row an admin switched off.
      where: {id: invited.id, userId: null, active: true, inviteTokenHash: invited.inviteTokenHash},
      data: {userId: viewer.id, name: viewer.name?.trim() || invited.name, inviteEmail: null, inviteTokenHash: null, inviteExpiresAt: null},
    });
    if (!taken.count) throw new HTTPException(404, {message: 'This invite link is invalid, expired or was already used'});
    const user = await db.member.findUniqueOrThrow({where: {id: invited.id}});
    c.set('user', {...user, email: viewer.email ?? ''});
    await audit(db, c, {action: 'auth.invite_accepted', entity: 'user', recordId: user.id, label: user.name});
    return c.json({user: publicUser({...user, email: viewer.email}, {meId: user.id, owner: false})});
  })

  .patch(
    '/me',
    valid('json', z.object({
      // The account's name is changed through the site (PATCH /site-api/auth/me); this keeps the copy in step.
      name: z.string().trim().min(1).max(80).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    })),
    async (c) => {
      const me = currentUser(c);
      const body = c.req.valid('json');
      const user = await c.var.db.member.update({where: {id: me.id}, data: {name: body.name, color: body.color}});
      return c.json({user: publicUser({...user, email: me.email}, await view(c))});
    },
  )

  /**
   * Profile picture. Stored as a purpose "public" file so it shows on public pages too (chat,
   * booking); kept as a site path so it works on any domain. The previous picture is removed.
   */
  .post('/me/avatar', valid('json', uploadBody), async (c) => {
    const me = currentUser(c);
    const checked = checkUpload(c.req.valid('json'), {
      maxBytes: MAX_EMAIL_IMAGE,
      tooBig: 'Pictures can be up to 2 MB',
      accept: (mime) => EMAIL_IMAGES.has(mime),
      wrongType: 'Use a PNG, JPEG, GIF or WebP image',
    });
    const {file, upload} = await startUpload(c.var.db, checked, {purpose: 'public', uploadedById: me.id});
    return c.json({fileId: file.id, upload}, 201);
  })

  .post('/me/avatar/:fileId/complete', async (c) => {
    const me = currentUser(c);
    const file = await completeUpload(c.var.db, {id: c.req.param('fileId'), purpose: 'public', uploadedById: me.id});
    await removeAvatarFile(c, me.avatarUrl);
    const user = await c.var.db.member.update({where: {id: me.id}, data: {avatarUrl: platformPublicPath({id: file.storageId!, name: file.name})}});
    return c.json({user: publicUser({...user, email: me.email}, await view(c))}, 201);
  })

  .delete('/me/avatar', async (c) => {
    const me = currentUser(c);
    await removeAvatarFile(c, me.avatarUrl);
    const user = await c.var.db.member.update({where: {id: me.id}, data: {avatarUrl: null}});
    return c.json({user: publicUser({...user, email: me.email}, await view(c))});
  });

/** The file behind a profile picture path (/__platform/files/<id>/…), if it was the user's own upload. */
async function removeAvatarFile(c: AppContext, url: string | null) {
  const storageId = url?.match(/\/__platform\/files\/(file_[0-9a-z]+)\//)?.[1];
  if (storageId) await purgeFiles(c.var.db, {storageId, purpose: 'public', uploadedById: currentUser(c).id});
}
