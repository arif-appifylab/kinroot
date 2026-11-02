import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {useEffect, useState} from 'react';

import {postJson} from '../lib/form';
import {siteFetch} from '../platform/browser';

import {ApiError} from './api';
import {RouteError, RoutePending, routeTree} from './routes';

/**
 * The portal: rendered ONLY in the browser (`client:only="react"`) by
 * `src/pages/dashboard/[...path].astro`, which answers every `/dashboard/*` URL, so
 * deep links and reloads work. Move it by changing `basepath` and that page's
 * folder together — never under `/api` or another platform path.
 *
 * Instant screens: TanStack Query owns the data (fresh for 30 s, so going back
 * to a screen shows it at once and refreshes in the background after that);
 * the router preloads a screen's code and data when a `<Link>` is hovered or
 * focused (`defaultPreload: 'intent'`), through each route's `loader`.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // One retry for a network blip; never for an answer the server meant (401, 403, 404, 422…).
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
    },
  },
});

const router = createRouter({
  routeTree,
  basepath: '/dashboard',
  context: {queryClient},
  defaultPreload: 'intent',
  // The router never caches loader results itself: Query does (staleTime above).
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingComponent: RoutePending,
  // Show the pending state only when a screen is slow (no flash on fast ones).
  defaultPendingMs: 300,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * `/dashboard/?owner_ticket=…` (the platform opens `/portal/?owner_ticket=…`, which redirects here): the editor's "Open portal" (one click from the dashboard, into the
 * Preview). The Preview's cookies travel in headers, so only a fetch can sign in there: the ticket
 * goes to `POST /site-api/auth/owner` once, leaves the address at once, and then the portal opens
 * signed in. Two-step sign-in on: its code step first. A spent or expired ticket: the sign-in page.
 */
function useOwnerTicket(): boolean {
  const [pending, setPending] = useState(() => new URLSearchParams(window.location.search).has('owner_ticket'));
  useEffect(() => {
    if (!pending) return;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('owner_ticket') ?? '';
    params.delete('owner_ticket');
    const rest = params.toString();
    const here = window.location.pathname + (rest ? `?${rest}` : '');
    window.history.replaceState(null, '', here + window.location.hash);
    void postJson(siteFetch, '/site-api/auth/owner', {ticket, next: here}).then(({res, data}) => {
      if (res?.status === 202 && data?.twoFactor === true && typeof data.challenge === 'string') {
        const q = new URLSearchParams({mfa: data.challenge, next: here});
        window.location.replace(`/account/login/?${q.toString()}`);
        return;
      }
      if (!res?.ok) {
        window.location.replace(`/account/login/?${new URLSearchParams({notice: 'owner-link', next: here}).toString()}`);
        return;
      }
      void queryClient.invalidateQueries();
      setPending(false);
    });
  }, [pending]);
  return pending;
}

export default function PortalApp() {
  const signingIn = useOwnerTicket();
  return (
    <QueryClientProvider client={queryClient}>
      {signingIn ? (
        <p className="app-signing-in" role="status">Signing you in…</p>
      ) : (
        <RouterProvider router={router} />
      )}
    </QueryClientProvider>
  );
}
