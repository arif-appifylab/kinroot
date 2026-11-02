import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';
import {Toaster} from 'sonner';

import {ConfirmHost} from '@/components/ui/confirm';
import {useTheme} from '@/lib/theme';

// The page's <head> (title, favicon, theme, brand colours) is the host page's
// (src/layouts/Crm.astro); this root only provides the app-wide pieces.
export const Route = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: RootComponent,
});

function RootComponent() {
  const {queryClient} = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
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
