import {createFileRoute} from '@tanstack/react-router';

import {BroadcastHistory, ListsNav} from '@/components/lists/broadcasts';
import {PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';

export const Route = createFileRoute('/_app/lists/broadcasts')({
  head: () => ({meta: [{title: pageTitle('Broadcasts')}]}),
  component: BroadcastsPage,
});

function BroadcastsPage() {
  return (
    <div>
      <PageHeader title="Lists" description="One-off emails sent to a list or segment: scheduled, sending and sent, with opens, clicks and unsubscribes." />
      <ListsNav current="broadcasts" />
      <BroadcastHistory title="Broadcasts" />
    </div>
  );
}
