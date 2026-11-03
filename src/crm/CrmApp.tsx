import {QueryClient} from '@tanstack/react-query';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {Loader2} from 'lucide-react';
import {useEffect, useState} from 'react';

import {siteFetch} from '../platform/browser';
import {routeTree} from './routeTree.gen';

/**
 * Kinroot's CRM: rendered ONLY in the browser (`client:only="react"`) by
 * `src/pages/crm/[...path].astro`, which answers every `/crm/*` URL so deep links and reloads
 * work. Screens are TanStack Router file routes in `src/crm/routes` (the router plugin in
 * astro.config.mjs builds `routeTree.gen.ts` and splits each screen's code). Move the app by
 * changing `basepath` and that page's folder together.
 */
const queryClient = new QueryClient({
  defaultOptions: {queries: {staleTime: 15_000, retry: 1, refetchOnWindowFocus: false}},
});

const router = createRouter({
  routeTree,
  basepath: '/crm',
  context: {queryClient},
  scrollRestoration: true,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * One-click owner sign-in from the platform's dashboard: it opens `/portal/?owner_ticket=…`, which
 * redirects here (`/crm/?owner_ticket=…`, query kept). The Preview's cookies travel in headers, so
 * only a fetch can sign in there: the ticket goes ONCE to `POST /site-api/auth/owner` through
 * `siteFetch`, leaves the address bar at once, and only then does the router start (so `_app`'s
 * "signed out → sign in" check sees the new session). Two-step sign-in on: its code step first. A
 * spent or expired ticket: the sign-in page with the owner-link notice. As the template's
 * dashboard did (`useOwnerTicket`).
 */
let redeeming = false;

function useOwnerTicket(): boolean {
  const [pending, setPending] = useState(() => new URLSearchParams(window.location.search).has('owner_ticket'));
  useEffect(() => {
    // Once per page load: a second run would find the address already cleaned.
    if (!pending || redeeming) return;
    redeeming = true;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('owner_ticket') ?? '';
    params.delete('owner_ticket');
    const rest = params.toString();
    const here = window.location.pathname + (rest ? `?${rest}` : '');
    // Through the router's own history (not `window.history`), so the router never puts it back.
    router.history.replace(here + window.location.hash);
    const toLogin = () => window.location.replace(`/account/login/?${new URLSearchParams({notice: 'owner-link', next: here}).toString()}`);
    void (async () => {
      let res: Response;
      try {
        res = await siteFetch('/site-api/auth/owner', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ticket, next: here})});
      } catch {
        toLogin();
        return;
      }
      const data = (await res.json().catch(() => null)) as {twoFactor?: unknown; challenge?: unknown} | null;
      if (res.status === 202 && data?.twoFactor === true && typeof data.challenge === 'string') {
        window.location.replace(`/account/login/?${new URLSearchParams({mfa: data.challenge, next: here}).toString()}`);
        return;
      }
      if (!res.ok) {
        toLogin();
        return;
      }
      void queryClient.invalidateQueries();
      setPending(false);
    })();
  }, [pending]);
  return pending;
}

export default function CrmApp() {
  const signingIn = useOwnerTicket();
  if (signingIn) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <p role="status" className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Signing you in…
        </p>
      </main>
    );
  }
  return <RouterProvider router={router} />;
}
