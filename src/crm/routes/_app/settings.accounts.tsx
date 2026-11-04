import {createFileRoute, redirect} from '@tanstack/react-router';

/** Settings → Accounts is now the Customers tab of Settings → Team (owner request, 4 Nov): old links still work. */
export const Route = createFileRoute('/_app/settings/accounts')({
  beforeLoad: () => {
    throw redirect({to: '/settings/team', search: {tab: 'customers'}, replace: true});
  },
});
