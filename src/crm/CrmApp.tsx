import {QueryClient} from '@tanstack/react-query';
import {createRouter, RouterProvider} from '@tanstack/react-router';

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

export default function CrmApp() {
  return <RouterProvider router={router} />;
}
