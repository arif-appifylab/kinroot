import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate, useRouterState} from '@tanstack/react-router';
import {BarChart3, Building2, CalendarDays, CheckSquare, ChevronDown, ClipboardList, Handshake, Inbox, LayoutDashboard, LifeBuoy, ListChecks, LogOut, Menu, Plus, Search, Settings, User, UserCog, Workflow, X} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {keys, useMe} from '@/lib/queries';
import type {InboxCounts, Task, TicketCounts} from '@/lib/types';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';
import {logout} from '../../platform/browser';

import {CommandPalette} from './command-palette';
import {CreateProvider, useCreate} from './create-dialogs';
import {LogoMark} from './logo';
import {NotificationBell} from './notifications';
import {ThemeToggle} from './theme-toggle';
import {Button} from './ui/button';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from './ui/menu';
import {Avatar} from './ui/misc';

const NAV = [
  {to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true},
  {to: '/deals', label: 'Deals', icon: Handshake},
  {to: '/contacts', label: 'Contacts', icon: User},
  {to: '/companies', label: 'Companies', icon: Building2},
  {to: '/lists', label: 'Lists', icon: ListChecks},
  {to: '/tasks', label: 'Tasks', icon: CheckSquare, badge: 'tasks'},
  {to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox'},
  {to: '/tickets', label: 'Tickets', icon: LifeBuoy, badge: 'tickets'},
  {to: '/forms', label: 'Forms', icon: ClipboardList},
  {to: '/reports', label: 'Reports', icon: BarChart3},
  {to: '/meetings', label: 'Meetings', icon: CalendarDays},
  {to: '/automations', label: 'Automations', icon: Workflow},
] as const;

function useBadges() {
  const tasks = useQuery({queryKey: [...keys.tasks, 'counts'], queryFn: () => api.get<{overdue: number; open: number}>('/tasks/counts'), refetchInterval: 60_000});
  // Unread conversations waiting on me or on the team queue (shared inbox counts, same privacy rules).
  const inbox = useQuery({queryKey: [...keys.inbox, 'counts'], queryFn: () => api.get<InboxCounts>('/inbox/counts'), refetchInterval: 60_000});
  const tickets = useQuery({queryKey: [...keys.tickets, 'counts'], queryFn: () => api.get<TicketCounts>('/tickets/counts'), refetchInterval: 60_000});
  return {tasks: tasks.data?.overdue ?? 0, inbox: inbox.data?.unread ?? 0, tickets: tickets.data?.mine ?? 0};
}

function Sidebar({onNavigate}: {onNavigate?: () => void}) {
  const brand = useBrand();
  const path = useRouterState({select: (s) => s.location.pathname});
  const badges = useBadges();

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      <div className="blob -top-24 -left-20 size-64 bg-blue-600/30" />
      <div className="blob -bottom-24 -right-24 size-64 bg-teal-500/20" />
      <div className="relative flex h-16 items-center gap-2.5 px-5">
        <LogoMark className="size-8" />
        <span className="truncate text-[15px] font-extrabold tracking-tight text-white">{brand.name}</span>
      </div>
      <nav className="relative flex-1 space-y-1 px-3 py-2" aria-label="Main">
        {NAV.map((item) => {
          const active = 'exact' in item ? path === item.to : path.startsWith(item.to);
          const badge = 'badge' in item ? item.badge : null;
          const count = badge ? badges[badge] : 0;
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                active ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]' : 'text-slate-400 hover:bg-white/5 hover:text-white',
              )}
            >
              <span className={cn('flex size-7 items-center justify-center rounded-md transition-all', active ? 'bg-brand text-white shadow-glow' : 'text-slate-400 group-hover:text-white')}>
                <item.icon className="size-4" />
              </span>
              {item.label}
              {count > 0 && (
                <span className={cn('ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold', badge === 'tasks' ? 'bg-rose-500 text-white' : 'bg-blue-500 text-white')}>
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="relative px-3 pb-4">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
            path.startsWith('/settings') ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white',
          )}
        >
          <span className="flex size-7 items-center justify-center"><Settings className="size-4" /></span>
          Settings
        </Link>
      </div>
    </div>
  );
}

function UserMenu() {
  const {me} = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function signOut() {
    qc.clear();
    // The site's sign-out: ends the session, then reloads (the CRM page then asks to sign in).
    await logout();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex cursor-pointer items-center gap-2 rounded-full py-1 pr-2 pl-1 transition-colors outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary/30">
          <Avatar name={me.name} color={me.color} src={me.avatarUrl} size="sm" />
          <span className="hidden text-sm font-semibold text-slate-700 md:inline">{me.name.split(' ')[0]}</span>
          <ChevronDown className="hidden size-3.5 text-slate-400 md:inline" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>
          <p className="text-sm font-semibold text-slate-900">{me.name}</p>
          <p className="truncate text-xs font-normal">{me.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({to: '/settings/profile'})}><UserCog /> Profile & security</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate({to: '/settings'})}><Settings /> Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}><LogOut /> Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({onMenu, onSearch}: {onMenu: () => void; onSearch: () => void}) {
  const create = useCreate();
  const navigate = useNavigate();
  const {canEdit} = useMe();
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200/70 bg-card/80 px-4 backdrop-blur-md sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </Button>
      <button
        onClick={onSearch}
        className="flex h-10 w-full max-w-md cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/80 px-3 text-sm text-slate-400 transition-all hover:border-slate-300 hover:bg-card focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="hidden rounded-md border border-slate-200 bg-card px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 sm:inline">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <NotificationBell />
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-9">
                <Plus /> <span className="hidden sm:inline">New</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => create.open({kind: 'deal'})}><Handshake /> Deal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create.open({kind: 'contact'})}><User /> Contact</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create.open({kind: 'company'})}><Building2 /> Company</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create.open({kind: 'task'})}><CheckSquare /> Task</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate({to: '/tickets', search: {new: '1'}})}><LifeBuoy /> Ticket</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <UserMenu />
      </div>
    </header>
  );
}

/** Polls for due task reminders and shows each once as a toast. */
function Reminders() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const due = useQuery({
    queryKey: [...keys.tasks, 'reminders'],
    queryFn: () => api.get<{rows: Task[]}>('/tasks/reminders'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    for (const t of due.data?.rows ?? []) {
      api.post(`/tasks/${t.id}/reminded`).catch(() => {});
      const target = t.deal
        ? () => navigate({to: '/deals/$dealId', params: {dealId: t.deal!.id}})
        : t.contact
          ? () => navigate({to: '/contacts/$contactId', params: {contactId: t.contact!.id}})
          : () => navigate({to: '/tasks'});
      toast(`⏰ ${t.title}`, {description: t.dueAt ? `Due ${new Date(t.dueAt).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'})}` : undefined, duration: 20_000, action: {label: 'Open', onClick: target}});
    }
    if (due.data?.rows.length) qc.invalidateQueries({queryKey: [...keys.tasks, 'counts']});
  }, [due.data, navigate, qc]);
  return null;
}

function Shell({children}: {children: ReactNode}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50 animate-in fade-in-0" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-in slide-in-from-left">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <button onClick={() => setMobileOpen(false)} className="absolute top-4 right-3 cursor-pointer rounded-md p-1.5 text-slate-400 hover:text-white" aria-label="Close menu">
              <X className="size-5" />
            </button>
          </aside>
        </div>
      )}
      <TopBar onMenu={() => setMobileOpen(true)} onSearch={() => setPaletteOpen(true)} />
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Reminders />
    </div>
  );
}

export function AppShell({children}: {children: ReactNode}) {
  return (
    <CreateProvider>
      <Shell>{children}</Shell>
    </CreateProvider>
  );
}
