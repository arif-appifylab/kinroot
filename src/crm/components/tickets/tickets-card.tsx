import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {LifeBuoy, Plus} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, useMe} from '@/lib/queries';
import type {Paged, TicketRow} from '@/lib/types';

import {LoadError} from '../data-table';
import {PropertyCard} from '../properties';
import {Button} from '../ui/button';
import {NewTicketDialog, type TicketDefaults} from './new-ticket-dialog';
import {SlaBadge, StatusBadge} from './ticket-badges';

/** "Tickets" card on contact, company and deal pages: open ones first. */
export function TicketsCard({record, defaults}: {record: {contactId?: string; companyId?: string; dealId?: string}; defaults: TicketDefaults}) {
  const {canEdit} = useMe();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: [...keys.tickets, 'record', record],
    queryFn: () => api.get<Paged<TicketRow>>('/tickets', {...record, status: 'all', sort: 'updated', pageSize: 20}),
  });
  const rows = [...(list.data?.rows ?? [])].sort((a, b) => Number(['RESOLVED', 'CLOSED'].includes(a.status)) - Number(['RESOLVED', 'CLOSED'].includes(b.status)));

  return (
    <>
      {/* The count only once it is known: a failed load is not "0 tickets". */}
      <PropertyCard title={list.data ? `Tickets · ${list.data.total}` : 'Tickets'} action={canEdit && <Button variant="ghost" size="sm" onClick={() => setCreating(true)}><Plus /> New</Button>}>
        {list.isPending && <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>}
        {list.isError && !list.data && <LoadError error={list.error} onRetry={() => list.refetch()} title="Tickets could not be loaded" className="py-2" />}
        {list.data && rows.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No support tickets</p>}
        {rows.map((t) => (
          <Link key={t.id} to="/tickets/$ticketId" params={{ticketId: String(t.number)}} className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 hover:bg-slate-50">
            <LifeBuoy className="mt-0.5 size-4 shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-800"><span className="text-muted-foreground">#{t.number}</span> {t.subject}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <StatusBadge status={t.status} />
                <SlaBadge ticket={t} compact />
                <span>{ago(t.lastMessageAt)}</span>
              </div>
            </div>
          </Link>
        ))}
        {(list.data?.total ?? 0) > rows.length && (
          <Link to="/tickets" search={{view: 'list', status: 'all', ...record}} className="block px-3 py-2 text-xs font-semibold text-primary hover:underline">See all</Link>
        )}
      </PropertyCard>
      {creating && <NewTicketDialog defaults={defaults} onClose={() => setCreating(false)} />}
    </>
  );
}
