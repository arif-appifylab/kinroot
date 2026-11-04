import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {CRM_APP, publicOrigin} from '../kit/config';
import {randomToken, sha256Hex} from '../kit/crypto';
import {currentUser, outranks, requireRole, type AppContext, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {notFound, valid} from '../lib/http';
import {publicUser, seesEmails} from '../lib/users';

const role = z.enum(['ADMIN', 'MEMBER', 'VIEWER']);

/** An invite link works for 14 days (a new link can be made any time). */
const INVITE_DAYS = 14;

/** A fresh invite: the link's token (shown once, to the admin) and what is stored (its hash). */
async function newInvite() {
  const token = randomToken(24);
  return {token, data: {inviteTokenHash: await sha256Hex(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000)}};
}

const inviteUrl = (c: AppContext, token: string) => `${publicOrigin(c.req.raw)}${CRM_APP}/invite/${token}`;

const view = async (c: AppContext) => ({meId: c.var.user?.id ?? null, owner: await seesEmails(c)});

export const team = new Hono<AppEnv>()
  // Everyone can list teammates (owner pickers, @mentions). Addresses only as the site's rule allows.
  .get('/', async (c) => {
    const rows = await c.var.db.member.findMany({
      orderBy: [{active: 'desc'}, {name: 'asc'}],
      include: {user: {select: {email: true}}},
      take: 1000,
    });
    const v = await view(c);
    return c.json({users: rows.map(({user, ...m}) => publicUser({...m, email: user?.email ?? m.inviteEmail}, v))});
  })

  .post('/invite', requireRole('ADMIN'), valid('json', z.object({name: z.string().trim().min(1).max(80), email: z.email().max(254), role})), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const email = body.email.trim().toLowerCase();
    const taken = await db.member.findFirst({where: {OR: [{inviteEmail: email}, {user: {email}}]}, select: {id: true}});
    if (taken) throw new HTTPException(409, {message: 'Someone with that email is already on the team'});
    const invite = await newInvite();
    const member = await db.member.create({data: {name: body.name, role: body.role, inviteEmail: email, ...invite.data}});
    await audit(db, c, {action: 'team.invited', entity: 'user', recordId: member.id, label: member.name, meta: {role: member.role}});
    return c.json({user: publicUser({...member, email}, await view(c)), inviteUrl: inviteUrl(c, invite.token)});
  })

  .post('/:id/invite-link', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const member = await db.member.findUnique({where: {id: c.req.param('id')}});
    if (!member) throw notFound('User');
    if (member.userId !== null || !member.inviteEmail) throw new HTTPException(400, {message: 'This user has already joined'});
    const invite = await newInvite();
    await db.member.update({where: {id: member.id}, data: invite.data});
    await audit(db, c, {action: 'team.invite_link', entity: 'user', recordId: member.id, label: member.name});
    return c.json({inviteUrl: inviteUrl(c, invite.token)});
  })

  .patch('/:id', requireRole('ADMIN'), valid('json', z.object({role: role.optional(), active: z.boolean().optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const target = await db.member.findUnique({where: {id: c.req.param('id')}});
    if (!target) throw notFound('User');
    if (target.id === me.id) throw new HTTPException(400, {message: 'You cannot change your own access'});
    // Only someone above a person changes them (an Admin changes Members and Viewers, only an Owner
    // changes Admins); Owners also change other Owners. Anyone else sees no such user.
    const ownerOnOwner = me.role === 'OWNER' && target.role === 'OWNER';
    if (!outranks(me, target) && !ownerOnOwner) throw notFound('User');
    const body = c.req.valid('json');
    // Nobody gives a role above their own (as inviting: an Admin may make an Admin).
    if (body.role && outranks({role: body.role}, me)) throw notFound('User');
    // The workspace always keeps an active Owner.
    const demotes = !!body.role || body.active === false; // `role` here is never OWNER
    if (target.role === 'OWNER' && target.active && demotes) {
      const others = await db.member.count({where: {role: 'OWNER', active: true, id: {not: target.id}}});
      if (!others) throw new HTTPException(409, {message: 'The workspace needs at least one active owner'});
    }
    // Deactivating takes effect on the member's next request: every Kinroot route checks `active`.
    const {user: account, ...user} = await db.member.update({where: {id: target.id}, data: {role: body.role, active: body.active}, include: {user: {select: {email: true}}}});
    const label = user.name;
    if (body.role && body.role !== target.role) await audit(db, c, {action: 'team.role_changed', entity: 'user', recordId: user.id, label, meta: {from: target.role, to: body.role}});
    if (body.active !== undefined && body.active !== target.active) await audit(db, c, {action: body.active ? 'team.reactivated' : 'team.deactivated', entity: 'user', recordId: user.id, label});
    return c.json({user: publicUser({...user, email: account?.email ?? user.inviteEmail}, await view(c))});
  });
