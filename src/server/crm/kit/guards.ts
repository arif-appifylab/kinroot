import type {Context, MiddlewareHandler} from 'hono';
import {HTTPException} from 'hono/http-exception';

import type {Member} from '../../../generated/prisma/client';
import {getAccess, getViewer} from '../../../platform/auth';
import {scopeOf} from '../../../platform/auth/codenames';
import {problem} from '../../../platform/guards';
import type {Viewer} from '../../../platform/types';
import {PERMISSIONS} from '../../permissions';
import type {Db} from './db';
import {OWNER_ADDRESS} from '../lib/owner-account';

/**
 * Who is using Kinroot, on top of the template's sign-in.
 *
 * The template decides WHO the visitor is (`viewer`: its session, two-step sign-in, devices).
 * Kinroot decides what they may do in the CRM: their team row (`Member`, src: prisma/schema.prisma)
 * and its rank Owner > Admin > Member > Viewer, exactly as before. That rank is the CRM's own data
 * (docs/agent/roles-and-permissions.md › Teams); the one SITE codename involved is
 * `site:crm:own`, which lets a holder with no team row become an Owner on the first visit.
 */

/**
 * A team member as Kinroot code sees it: the `Member` row plus `email`, which is ALWAYS the
 * signed-in viewer's OWN address (from the template's session) for `c.var.user`. Rows loaded for
 * other people carry their email only where the server needs it (sending them mail), never
 * copied into Kinroot's tables.
 */
export type User = Member & {email: string};

export type AppEnv = {
  Variables: {
    db: Db;
    user: User | null;
    viewer: Viewer;
  };
};

export type AppContext = Context<AppEnv>;

const ROLE_RANK = {VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3} as const;
export type RoleName = keyof typeof ROLE_RANK;

/** How stale "last seen" may get before a request refreshes it (one small write, not one per request). */
const SEEN_EVERY_MS = 10 * 60_000;

/**
 * Keeps the team row in step with the account, at most one write per request: `name` is a display
 * copy of `users.name`; `lastSeenAt` ("last seen 5 min ago" in Settings → Team) moves every 10 minutes.
 */
async function touch(db: Db, member: Member, viewer: Viewer): Promise<Member> {
  const name = viewer.name?.trim();
  const rename = !!name && name !== member.name;
  const seen = !member.lastSeenAt || Date.now() - member.lastSeenAt.getTime() > SEEN_EVERY_MS;
  if (!rename && !seen) return member;
  return db.member.update({where: {id: member.id}, data: {...(rename ? {name} : {}), ...(seen ? {lastSeenAt: new Date()} : {})}});
}

/**
 * Resolves the template's session into `c.var.viewer` and the team row into `c.var.user`
 * (null when signed out, not on the team, or deactivated).
 */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const viewer = await getViewer(c.req.raw);
  c.set('viewer', viewer);
  let user: User | null = null;
  if (viewer.state === 'user' && viewer.id !== null) {
    const db = c.var.db;
    let member = await db.member.findUnique({where: {userId: viewer.id}});
    if (!member) {
      // First visit of someone the site lets claim the CRM (owners, via `*`): they become an Owner.
      const {permissions} = await getAccess(c.req.raw);
      if (scopeOf(new Set(permissions), PERMISSIONS.CRM_OWN) === 'all') {
        member = await db.member.upsert({
          where: {userId: viewer.id},
          create: {userId: viewer.id, name: viewer.name?.trim() || 'Owner', role: 'OWNER'},
          update: {},
        });
      }
    }
    // The site owner has no address here: OWNER_ADDRESS routes their mail to the platform (lib/owner-account.ts).
    if (member?.active) user = {...(await touch(db, member, viewer)), email: viewer.platformOwner ? OWNER_ADDRESS : (viewer.email ?? '')};
  }
  c.set('user', user);
  await next();
};

/**
 * The signed-in team member, or the answer the browser needs: `401 token_expired` makes
 * `siteFetch` refresh the session once and retry; `401 signed_out` sends them to sign in;
 * `403 not_a_member` says they are signed in but not on this team (they need an invite).
 */
export function currentUser(c: AppContext): User {
  const user = c.var.user;
  if (user) return user;
  const state = c.var.viewer?.state;
  const answer =
    state === 'returning'
      ? c.json(problem('token_expired', 'Your session needs refreshing.'), 401)
      : state === 'user'
        ? c.json(problem('not_a_member', 'You are signed in, but not on this team yet. Ask an admin for an invite.'), 403)
        : c.json(problem('signed_out', 'Sign in required'), 401);
  throw new HTTPException(answer.status as 401 | 403, {res: answer, message: 'Sign in required'});
}

/** Route guard: signed in, on the team, and at least `min` rank. */
export function requireRole(min: RoleName = 'VIEWER'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = currentUser(c);
    if (ROLE_RANK[user.role] < ROLE_RANK[min]) throw new HTTPException(403, {message: 'Not allowed'});
    await next();
  };
}

/** Guard for writes: viewers are read-only everywhere. */
export const requireWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const user = currentUser(c);
    if (user.role === 'VIEWER') throw new HTTPException(403, {message: 'Read-only account'});
  }
  await next();
};

export const isAdmin = (user: Pick<Member, 'role'>) => ROLE_RANK[user.role] >= ROLE_RANK.ADMIN;

/** True when `actor` may act on `target`'s access: never above your own rank (anti-escalation). */
export const outranks = (actor: Pick<Member, 'role'>, target: Pick<Member, 'role'>) => ROLE_RANK[actor.role] > ROLE_RANK[target.role];
