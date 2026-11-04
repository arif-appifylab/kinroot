import {useQuery} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';
import {Command} from 'cmdk';
import {Building2, CheckSquare, Handshake, Inbox, LayoutDashboard, LifeBuoy, Plus, Search, Settings, StickyNote, User} from 'lucide-react';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {fullName, money} from '@/lib/format';
import {STATUS, type TicketStatus} from '@/lib/tickets';

import {useCreate} from './create-dialogs';

type Results = {
  contacts: {id: string; firstName: string; lastName: string | null; email: string | null; title: string | null}[];
  companies: {id: string; name: string; domain: string | null}[];
  deals: {id: string; title: string; value: number; currency: string; status: string; stage: {name: string}}[];
  notes: {id: string; body: string; contactId: string | null; companyId: string | null; dealId: string | null}[];
  tickets?: {id: string; number: number; subject: string; status: TicketStatus}[];
};

const item =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-700 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4 [&_svg]:text-slate-400 data-[selected=true]:[&_svg]:text-primary';
const group = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-slate-400 [&_[cmdk-group-heading]]:uppercase';

export function CommandPalette({open, onOpenChange}: {open: boolean; onOpenChange: (o: boolean) => void}) {
  const navigate = useNavigate();
  const create = useCreate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const results = useQuery({queryKey: ['search', debounced], queryFn: () => api.get<Results>('/search', {q: debounced}), enabled: debounced.length > 0, placeholderData: (p) => p});

  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const r = debounced ? results.data : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-100 bg-card shadow-lift data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Search and commands</DialogPrimitive.Title>
          <Command shouldFilter={!debounced} loop>
            <div className="flex items-center gap-3 border-b border-slate-100 px-4">
              <Search className="size-4 text-slate-400" />
              <Command.Input value={q} onValueChange={setQ} aria-label="Search or run a command" placeholder="Search people, companies, deals, tickets, notes… or type a command" className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-slate-400" />
              <kbd className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">ESC</kbd>
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2 scrollbar-thin">
              <Command.Empty className="py-10 text-center text-sm text-muted-foreground">{results.isFetching ? 'Searching…' : 'Nothing found'}</Command.Empty>

              {r && r.contacts.length > 0 && (
                <Command.Group heading="People" className={group}>
                  {r.contacts.map((c) => (
                    <Command.Item key={c.id} value={`c-${c.id}`} className={item} onSelect={() => go(() => navigate({to: '/contacts/$contactId', params: {contactId: c.id}}))}>
                      <User /> <span className="font-medium">{fullName(c)}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">{c.email ?? c.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {r && r.companies.length > 0 && (
                <Command.Group heading="Companies" className={group}>
                  {r.companies.map((c) => (
                    <Command.Item key={c.id} value={`co-${c.id}`} className={item} onSelect={() => go(() => navigate({to: '/companies/$companyId', params: {companyId: c.id}}))}>
                      <Building2 /> <span className="font-medium">{c.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{c.domain}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {r && r.deals.length > 0 && (
                <Command.Group heading="Deals" className={group}>
                  {r.deals.map((d) => (
                    <Command.Item key={d.id} value={`d-${d.id}`} className={item} onSelect={() => go(() => navigate({to: '/deals/$dealId', params: {dealId: d.id}}))}>
                      <Handshake /> <span className="truncate font-medium">{d.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{d.status === 'OPEN' ? d.stage.name : d.status.toLowerCase()} · {money(d.value, d.currency, true)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {r && !!r.tickets?.length && (
                <Command.Group heading="Tickets" className={group}>
                  {r.tickets.map((t) => (
                    <Command.Item key={t.id} value={`t-${t.id}`} className={item} onSelect={() => go(() => navigate({to: '/tickets/$ticketId', params: {ticketId: String(t.number)}}))}>
                      <LifeBuoy /> <span className="truncate font-medium"><span className="text-slate-400">#{t.number}</span> {t.subject}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{STATUS[t.status].label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {r && r.notes.length > 0 && (
                <Command.Group heading="Notes" className={group}>
                  {r.notes.map((n) => (
                    <Command.Item
                      key={n.id}
                      value={`n-${n.id}`}
                      className={item}
                      onSelect={() =>
                        go(() =>
                          n.dealId
                            ? navigate({to: '/deals/$dealId', params: {dealId: n.dealId}})
                            : n.contactId
                              ? navigate({to: '/contacts/$contactId', params: {contactId: n.contactId}})
                              : n.companyId && navigate({to: '/companies/$companyId', params: {companyId: n.companyId}}),
                        )
                      }
                    >
                      <StickyNote /> <span className="truncate">{n.body}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {!debounced && (
                <>
                  <Command.Group heading="Create" className={group}>
                    <Command.Item className={item} onSelect={() => go(() => create.open({kind: 'deal'}))}><Plus /> New deal</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => create.open({kind: 'contact'}))}><Plus /> New contact</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => create.open({kind: 'company'}))}><Plus /> New company</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => create.open({kind: 'task'}))}><Plus /> New task</Command.Item>
                  </Command.Group>
                  <Command.Group heading="Go to" className={group}>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/'}))}><LayoutDashboard /> Dashboard</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/deals'}))}><Handshake /> Deals</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/contacts'}))}><User /> Contacts</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/companies'}))}><Building2 /> Companies</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/tasks'}))}><CheckSquare /> Tasks</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/inbox'}))}><Inbox /> Inbox</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/tickets'}))}><LifeBuoy /> Tickets</Command.Item>
                    <Command.Item className={item} onSelect={() => go(() => navigate({to: '/settings'}))}><Settings /> Settings</Command.Item>
                  </Command.Group>
                </>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
