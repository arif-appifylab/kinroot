import {createFileRoute, redirect} from '@tanstack/react-router';

// Import and export moved to the Contacts, Companies and Deals pages (drawers); their history is in the audit log.
export const Route = createFileRoute('/_app/settings/import')({
  beforeLoad: () => {
    throw redirect({to: '/contacts'});
  },
});
