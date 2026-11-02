import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet, useRouterState} from '@tanstack/react-router';
import {useEffect} from 'react';
import {Toaster} from 'sonner';

import {ConfirmHost} from '@/components/ui/confirm';
import {api} from '@/lib/api';
import {DEFAULT_BRAND, setCurrentBrand, type Brand} from '@/lib/brand';
import {useTheme} from '@/lib/theme';

// The page's <head> (title, favicon, theme, brand colours) is the host page's
// (src/layouts/Crm.astro); this root only provides the app-wide pieces.
export const Route = createRootRouteWithContext<{queryClient: QueryClient}>()({
  // The company's name, logo and colours (Settings → Branding): `useBrand()` reads them here.
  loader: async (): Promise<Brand> => {
    const brand = await api.get<Brand>('/public/brand').catch(() => DEFAULT_BRAND);
    setCurrentBrand(brand);
    return brand;
  },
  staleTime: 60_000,
  component: RootComponent,
});

function RootComponent() {
  const {queryClient} = Route.useRouteContext();
  setCurrentBrand(Route.useLoaderData());
  return (
    <QueryClientProvider client={queryClient}>
      <DocumentTitle />
      <Outlet />
      <ThemedToaster />
      <ConfirmHost />
    </QueryClientProvider>
  );
}

function ThemedToaster() {
  const {dark} = useTheme();
  return <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" richColors closeButton toastOptions={{className: 'font-sans'}} />;
}

/** Each screen's `head()` title ("Deals · Acme") as the tab title, after every navigation. */
function DocumentTitle() {
  const title = useRouterState({
    select: (s) => {
      for (const m of [...s.matches].reverse()) {
        const t = m.meta?.find((x) => x && 'title' in x)?.title;
        if (t) return t;
      }
      return null;
    },
  });
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  return null;
}
