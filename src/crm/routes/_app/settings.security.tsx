import {createFileRoute, redirect} from '@tanstack/react-router';

/** Settings → Security is now part of Settings → Your account (owner request, 4 Nov): old links still work. */
export const Route = createFileRoute('/_app/settings/security')({
  beforeLoad: () => {
    throw redirect({to: '/settings/profile', hash: 'security', replace: true});
  },
});
