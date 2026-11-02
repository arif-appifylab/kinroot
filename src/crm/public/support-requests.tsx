import {ChevronRight, Inbox, Loader2} from 'lucide-react';

import {PublicCard} from '@/components/public-layout';
import {CustomerStatus, PortalNav, SignInPrompt, usePortal, type PortalSession} from '@/components/tickets/portal';
import {PublicPage} from './public-page';
import {EmptyState} from '@/components/ui/misc';
import type {Brand} from '@/lib/brand';
import {ago} from '@/lib/format';
import type {TicketStatus} from '@/lib/tickets';

type Mine = {session: PortalSession | null; tickets?: {number: number; subject: string; status: TicketStatus; createdAt: string; lastMessageAt: string}[]};

/** /support/tickets: the signed-in customer's requests (src/pages/support/tickets/index.astro). */
export default function MyRequestsPage({brand}: {brand: Brand}) {
  return (
    <PublicPage brand={brand}>
      <MyRequests />
    </PublicPage>
  );
}

function MyRequests() {
  const {data, error} = usePortal<Mine>('/public/support/me');

  if (error) return <PublicCard><p className="text-sm font-medium text-destructive">{error}</p></PublicCard>;
  if (!data) return <PublicCard className="flex justify-center"><Loader2 className="size-5 animate-spin text-primary" /></PublicCard>;
  if (!data.session) {
    return (
      <PublicCard>
        <SignInPrompt title="Sign in to see your requests" intro="Use the email address you contacted us from." />
      </PublicCard>
    );
  }
  const rows = data.tickets ?? [];
  return (
    <>
      <PortalNav session={data.session} />
      <PublicCard className="max-w-2xl p-0 sm:mt-4 sm:p-0">
        <div className="border-b border-slate-100 px-6 py-5">
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{data.session.firstName ? `Hi ${data.session.firstName}, your requests` : 'Your requests'}</h1>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Inbox />} title="No requests yet" action={<a href="/support/" className="text-sm font-semibold text-primary hover:underline">Open a request</a>} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.number}>
                <a href={`/support/tickets/${r.number}`} className="flex items-center gap-3 px-6 py-4 transition-colors hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900"><span className="text-slate-400">#{r.number}</span> {r.subject}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Updated {ago(r.lastMessageAt)}</p>
                  </div>
                  <CustomerStatus status={r.status} />
                  <ChevronRight className="size-4 text-slate-300" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </PublicCard>
    </>
  );
}
