import {createFileRoute, Link, Outlet, useRouterState} from '@tanstack/react-router';
import {BarChart3, CalendarClock, LayoutGrid, Target, TrendingUp} from 'lucide-react';

import {pageTitle} from '@/lib/brand';
import {cn} from '@/lib/utils';

export const Route = createFileRoute('/_app/reports')({
  head: () => ({meta: [{title: pageTitle('Reports')}]}),
  component: ReportsLayout,
});

const NAV = [
  {to: '/reports', label: 'Dashboards', icon: LayoutGrid, match: (p: string) => p === '/reports' || p === '/reports/' || p.startsWith('/reports/dashboards')},
  {to: '/reports/saved', label: 'Reports', icon: BarChart3, match: (p: string) => !/^\/reports\/?($|dashboards|goals|forecast|schedules)/.test(p)},
  {to: '/reports/goals', label: 'Goals', icon: Target, match: (p: string) => p.startsWith('/reports/goals')},
  {to: '/reports/forecast', label: 'Forecast', icon: TrendingUp, match: (p: string) => p.startsWith('/reports/forecast')},
  {to: '/reports/schedules', label: 'Scheduled emails', icon: CalendarClock, match: (p: string) => p.startsWith('/reports/schedules')},
] as const;

function ReportsLayout() {
  const path = useRouterState({select: (s) => s.location.pathname});
  return (
    <div>
      <nav className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1 scrollbar-thin sm:mx-0 sm:px-0" aria-label="Reports">
        <div className="inline-flex items-center gap-1 rounded-xl bg-slate-100/80 p-1">
          {NAV.map((n) => {
            const active = n.match(path);
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap transition-all',
                  active ? 'bg-card text-slate-900 shadow-soft' : 'text-slate-500 hover:text-slate-800',
                )}
              >
                <n.icon className={cn('size-3.5', active ? 'text-primary' : 'text-slate-400')} />
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
