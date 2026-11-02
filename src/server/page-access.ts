import {getAccess} from '../platform/auth/session';
import {scopeOf} from '../platform/auth/codenames';
import {pageContext} from './page';

/** The parts of `Astro` this needs (pass `Astro` itself). */
interface AstroLike {
  request: Request;
  response: {headers: Headers; status: number};
}

/** Why a gated page is not shown: `signed_out`, `refreshing` (the browser refreshes the session and reloads) or `forbidden`. */
export type PageDenied = 'signed_out' | 'refreshing' | 'forbidden';

/**
 * A SERVER-RENDERED page (`export const prerender = false`) for holders of
 * `codename` only. Everything `pageContext()` gives, plus `allowed` and, when
 * not allowed, `denied` (and the status: 401 signed out, 403 forbidden).
 * Render `<NoAccess>` instead of the content when not allowed, and read
 * private data ONLY when allowed (the Site API route checks again anyway):
 *
 *   const page = await pagePermission(Astro, PERMISSIONS.REPORT_READ);
 *   const report = page.allowed ? await read<Report>(page.api.reports.$get()) : null;
 *   ---
 *   <Base site={page.site} viewer={page.viewer} title="Reports" noindex>
 *     {page.allowed ? <main>…</main> : <NoAccess site={page.site} denied={page.denied} />}
 *   </Base>
 *
 * Same answer as the `/me` abilities (the request's memoized access). A
 * PRERENDERED page has no visitor at build time and can never be gated: make
 * it on-demand or put it in the portal. `_own` variants count only for the
 * exact `_own` codename; per-record checks belong in the Site API (`can`).
 */
export async function pagePermission(astro: AstroLike, codename: string) {
  const context = await pageContext(astro.request, astro.response);
  let denied: PageDenied | null = null;
  if (context.viewer.state === 'returning') denied = 'refreshing';
  else if (context.viewer.state !== 'user') denied = 'signed_out';
  else {
    const {permissions} = await getAccess(astro.request);
    const scope = scopeOf(new Set(permissions), codename);
    if (scope === 'none' || (scope === 'own' && !codename.endsWith('_own'))) denied = 'forbidden';
  }
  if (denied) astro.response.status = denied === 'forbidden' ? 403 : 401;
  return {...context, allowed: denied === null, denied};
}
