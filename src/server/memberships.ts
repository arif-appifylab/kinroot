import {createMiddleware} from 'hono/factory';

import type {Viewer} from '../lib/types';
import {getDb} from '../platform/db';
import {problem} from '../platform/guards';
import {grantsAccess} from '../platform/payments';
import {pageContext} from './page';
import type {PageDenied} from './page-access';

/**
 * Member-only content: open to a signed-in user holding a membership for one of `priceKeys`
 * (docs/agent/payments.md). A membership is theirs when it was bought signed in (`user_id`), or
 * with their email address once that address is VERIFIED (someone else may have typed it).
 *
 *   Route:  .get('/lessons/:id', withViewer, requireAuth, requireMembership(['club-monthly', 'club-yearly']), withDb, …)
 *   Page:   const page = await pageMembership(Astro, ['club-monthly', 'club-yearly']);
 *           {page.allowed ? <main>…</main> : <MembersOnly denied={page.denied} />}
 */

/** The member's memberships that open `priceKeys` now (bounded: one query, at most 20 rows). */
export async function activeMemberships(viewer: Viewer, priceKeys: readonly string[]) {
  const db = getDb();
  if (!db || viewer.state !== 'user' || viewer.id === null || priceKeys.length === 0) return [];
  const owners = [
    {userId: viewer.id},
    ...(viewer.email && viewer.emailVerified ? [{email: viewer.email.toLowerCase()}] : []),
  ];
  const rows = await db.membership.findMany({
    where: {priceKey: {in: [...priceKeys]}, OR: owners},
    select: {subscriptionId: true, priceKey: true, status: true, currentPeriodEnd: true, accessEndsAt: true, mode: true},
    orderBy: {id: 'desc'},
    take: 20,
  });
  return rows.filter(row => grantsAccess(row.status, row.accessEndsAt));
}

export async function hasMembership(viewer: Viewer, priceKeys: readonly string[]): Promise<boolean> {
  return (await activeMemberships(viewer, priceKeys)).length > 0;
}

/** Route guard, after `withViewer → requireAuth`: 403 `membership_required` when not a member. */
export const requireMembership = (priceKeys: readonly string[]) =>
  createMiddleware<{Variables: {viewer: Viewer}}>(async (c, next) => {
    if (!(await hasMembership(c.var.viewer, priceKeys))) {
      return c.json(problem('membership_required', 'This is for members. Join to see it.'), 403);
    }
    await next();
  });

export type MembershipDenied = PageDenied | 'not_member';

/**
 * A SERVER-RENDERED page (`prerender = false`) for members only: `pageContext()` plus `allowed`
 * and `denied` (`signed_out` 401, `refreshing`, `not_member` 403). Read member content ONLY when
 * allowed.
 */
export async function pageMembership(
  astro: {request: Request; response: {headers: Headers; status: number}},
  priceKeys: readonly string[]
) {
  const context = await pageContext(astro.request, astro.response);
  let denied: MembershipDenied | null = null;
  if (context.viewer.state === 'returning') denied = 'refreshing';
  else if (context.viewer.state !== 'user') denied = 'signed_out';
  else if (!(await hasMembership(context.viewer, priceKeys))) denied = 'not_member';
  if (denied) astro.response.status = denied === 'not_member' ? 403 : 401;
  return {...context, allowed: denied === null, denied};
}
