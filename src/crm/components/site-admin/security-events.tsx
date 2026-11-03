import {useInfiniteQuery} from '@tanstack/react-query';
import {Ban, History, KeyRound, LogIn, LogOut, Mail, ShieldAlert, ShieldCheck, Trash2, UserPlus} from 'lucide-react';

import {EmptyState, IconBadge, Skeleton} from '@/components/ui/misc';
import {dateTime, ago} from '@/lib/format';
import {describeSiteEvent, type EventKind, siteAuditQuery} from '@/lib/site-admin';

import {ErrorNote, LoadMore} from './common';

const KIND_STYLE: Record<EventKind, {icon: typeof History; tone: 'blue' | 'teal' | 'violet' | 'amber' | 'slate' | 'rose' | 'green'}> = {
  signup: {icon: UserPlus, tone: 'green'},
  signin: {icon: LogIn, tone: 'teal'},
  signout: {icon: LogOut, tone: 'slate'},
  email: {icon: Mail, tone: 'blue'},
  password: {icon: KeyRound, tone: 'blue'},
  twoFactor: {icon: ShieldCheck, tone: 'violet'},
  warning: {icon: ShieldAlert, tone: 'amber'},
  roles: {icon: ShieldCheck, tone: 'slate'},
  owner: {icon: ShieldCheck, tone: 'violet'},
  blocked: {icon: Ban, tone: 'rose'},
  deleted: {icon: Trash2, tone: 'rose'},
  other: {icon: History, tone: 'slate'},
};

/**
 * The site's own sign-in and security events (`audit_events`, `GET /site-api/admin/audit`,
 * site:audit:read): sign-ups, sign-ins with a code, password and email changes, two-step sign-in,
 * role changes, blocked accounts, refused tokens. Newest first, 25 at a time.
 */
export function SecurityEvents() {
  const events = useInfiniteQuery(siteAuditQuery);
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];

  if (events.isPending) return <div className="grid gap-3">{Array.from({length: 5}, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (events.error && !rows.length) return <ErrorNote error={events.error} onRetry={() => void events.refetch()} />;
  if (!rows.length) {
    return <EmptyState icon={<ShieldCheck />} title="Nothing yet" description="Sign-ups, sign-ins with a code, password and role changes show here as they happen." />;
  }
  return (
    <>
      <ul className="divide-y divide-slate-100">
        {rows.map((event) => {
          const line = describeSiteEvent(event);
          const style = KIND_STYLE[line.kind];
          const Icon = style.icon;
          return (
            <li key={event.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <IconBadge tone={style.tone} className="size-8 rounded-lg [&_svg]:size-4">
                <Icon />
              </IconBadge>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-700">
                  {line.who ? (
                    <>
                      <span className="font-semibold text-slate-900">{line.who}</span> {line.what}
                    </>
                  ) : (
                    line.what
                  )}
                </p>
                {line.detail && <p className="mt-0.5 text-xs text-slate-600">{line.detail}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <time dateTime={event.createdAt} title={dateTime(event.createdAt)}>
                    {ago(event.createdAt)}
                  </time>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {events.error && <div className="mt-4"><ErrorNote error={events.error} /></div>}
      <LoadMore hasNextPage={events.hasNextPage} isFetchingNextPage={events.isFetchingNextPage} fetchNextPage={events.fetchNextPage} />
    </>
  );
}
