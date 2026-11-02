import {createFileRoute, Link, Outlet, useRouterState} from '@tanstack/react-router';
import {Inbox, MessageCircle} from 'lucide-react';

import {cn} from '@/lib/utils';

/** Settings → Inbox: the team inbox (General) and the website chat channel (Chat). */
export const Route = createFileRoute('/_app/settings/inbox')({
  component: InboxSettingsLayout,
});

const TABS = [
  {to: '/settings/inbox', label: 'General', icon: Inbox, exact: true},
  {to: '/settings/inbox/chat', label: 'Chat', icon: MessageCircle},
] as const;

function InboxSettingsLayout() {
  const path = useRouterState({select: (s) => s.location.pathname.replace(/\/$/, '')});
  return (
    <div>
      <nav className="mb-5 flex gap-1 border-b border-slate-200" aria-label="Inbox settings">
        {TABS.map((t) => {
          const active = 'exact' in t ? path === t.to : path.startsWith(t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? 'page' : undefined}
              className={cn('-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors', active ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-900')}
            >
              <t.icon className="size-4" /> {t.label}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}
