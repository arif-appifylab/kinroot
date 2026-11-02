import {createFileRoute, Link, Outlet, useRouterState} from '@tanstack/react-router';
import {CalendarDays, Columns3, CopyCheck, FileText, Flame, Globe, Inbox, LifeBuoy, Mail, ScrollText, Settings2, SlidersHorizontal, Trash2, UserCircle, Users, Webhook} from 'lucide-react';

import {PageHeader} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/settings')({
  head: () => ({meta: [{title: pageTitle('Settings')}]}),
  component: SettingsLayout,
});

const NAV = [
  {to: '/settings', label: 'General', icon: Settings2, exact: true},
  {to: '/settings/profile', label: 'Profile', icon: UserCircle},
  {to: '/settings/team', label: 'Team', icon: Users},
  {to: '/settings/pipelines', label: 'Pipelines', icon: Columns3},
  {to: '/settings/fields', label: 'Custom fields', icon: SlidersHorizontal},
  {to: '/settings/email', label: 'Email', icon: Mail},
  {to: '/settings/inbox', label: 'Inbox', icon: Inbox},
  {to: '/settings/website', label: 'Website', icon: Globe},
  {to: '/settings/calendar', label: 'Calendar', icon: CalendarDays},
  {to: '/settings/templates', label: 'Templates', icon: FileText},
  {to: '/settings/tickets', label: 'Tickets', icon: LifeBuoy},
  {to: '/settings/scoring', label: 'Lead scoring', icon: Flame},
  {to: '/settings/webhooks', label: 'Webhooks', icon: Webhook},
  {to: '/settings/duplicates', label: 'Duplicates', icon: CopyCheck},
  {to: '/settings/recycle-bin', label: 'Recycle bin', icon: Trash2},
  {to: '/settings/audit', label: 'Audit log', icon: ScrollText},
] as const;

function SettingsLayout() {
  const path = useRouterState({select: (s) => s.location.pathname});
  const brand = useBrand();
  return (
    <div>
      <PageHeader title="Settings" description={`Shape ${brand.name} around how your team sells.`} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[210px_minmax(0,1fr)]">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 scrollbar-thin xl:mx-0 xl:flex-col xl:px-0" aria-label="Settings">
          {NAV.map((n) => {
            const active = 'exact' in n ? path === n.to || path === `${n.to}/` : path.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn(
                  'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-all',
                  active ? 'bg-card text-slate-900 shadow-soft' : 'text-slate-500 hover:bg-card/60 hover:text-slate-900',
                )}
              >
                <n.icon className={cn('size-4', active ? 'text-primary' : 'text-slate-400')} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
