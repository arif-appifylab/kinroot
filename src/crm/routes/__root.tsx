import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet, useRouterState} from '@tanstack/react-router';
import {useEffect, useRef} from 'react';
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
      <RouteFocus />
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

/**
 * After a navigation to another screen, focus moves to that screen's `<h1>` so keyboard and
 * screen-reader users start at the top of the new screen. Waits for the heading to render (data
 * screens show it once loaded) and never takes focus from something the person moved it to.
 */
function RouteFocus() {
  const path = useRouterState({select: (s) => s.location.pathname});
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const before = document.activeElement;
    let tries = 0;
    let timer = 0;
    const focusHeading = () => {
      const now = document.activeElement;
      // Focus already moved on (a dialog, a field with autoFocus): leave it there.
      if (now && now !== before && now !== document.body && now.isConnected) return;
      const heading = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');
      if (!heading) {
        if (++tries < 20) timer = window.setTimeout(focusHeading, 100);
        return;
      }
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.classList.add('outline-none');
      heading.focus({preventScroll: true});
    };
    timer = window.setTimeout(focusHeading, 0);
    return () => window.clearTimeout(timer);
  }, [path]);
  return null;
}
