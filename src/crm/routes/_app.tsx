import {createFileRoute, Outlet, redirect} from '@tanstack/react-router';

import {AppShell} from '@/components/app-shell';
import {signInPath} from '@/lib/api';
import {authQuery} from '@/lib/queries';

// The signed-in app: data comes from /site-api/crm through the site's session. Its home is the
// dashboard at /crm/. Signing in is the site's own page; a signed-in account that is not on the
// team sees /crm/no-access (it needs an invite); the Owner's first visit goes to /crm/setup.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({context}) => {
    const auth = await context.queryClient.ensureQueryData(authQuery);
    if (!auth.signedIn) {
      window.location.assign(signInPath());
      throw redirect({to: '/no-access'});
    }
    if (!auth.user) throw redirect({to: '/no-access'});
    if (auth.needsSetup) throw redirect({to: '/setup'});
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
