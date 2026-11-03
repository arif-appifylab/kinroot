import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Laptop, LogOut, Smartphone} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {confirm} from '@/components/ui/confirm';
import {IconBadge, Skeleton} from '@/components/ui/misc';
import {accountApi, AccountError, accountKeys, type DeviceSession, SIGN_IN_AGAIN, sessionsQuery} from '@/lib/account-api';
import {ago} from '@/lib/format';
import {FormError, PendingButton} from './form';

/** A phone or a computer, guessed from the device's label ("Safari on iOS"). */
const isPhone = (device: string) => /iphone|ipad|ios|android|mobile|phone|tablet/i.test(device);

/**
 * Settings → Security › Signed-in devices (`GET /site-api/auth/sessions`): sign out one
 * (`DELETE /sessions/:id`), every other one, or every device including this one (`POST /logout-all`).
 */
export function DevicesSection() {
  const queryClient = useQueryClient();
  const sessions = useQuery(sessionsQuery);
  const refresh = () => queryClient.invalidateQueries({queryKey: accountKeys.sessions});
  // Leaves the page when done (it then renders signed out), so pending never needs resetting.
  const [leaving, setLeaving] = useState<'this' | 'all' | null>(null);

  const signOut = useMutation({
    mutationFn: (session: DeviceSession) => accountApi.signOutDevice(session.id),
    onSuccess: (_data, session) => {
      if (session.current) {
        setLeaving('this');
        window.location.assign(SIGN_IN_AGAIN);
        return;
      }
      toast.success(`Signed out ${session.device}.`);
      return refresh();
    },
  });
  const others = useMutation({
    // At most 50 devices are listed; a few at a time, so the browser never floods the server.
    mutationFn: async (rows: DeviceSession[]) => {
      let failed = 0;
      for (let i = 0; i < rows.length; i += 5) {
        const results = await Promise.allSettled(rows.slice(i, i + 5).map((row) => accountApi.signOutDevice(row.id)));
        failed += results.filter((r) => r.status === 'rejected' && !(r.reason instanceof AccountError && r.reason.status === 404)).length;
      }
      if (failed) throw new Error(`${failed} device${failed === 1 ? '' : 's'} could not be signed out. Try again.`);
      return rows.length;
    },
    onSuccess: (count) => toast.success(`Signed out ${count} other device${count === 1 ? '' : 's'}.`),
    onSettled: refresh,
  });
  const everywhere = useMutation({
    mutationFn: () => accountApi.signOutEverywhere(),
    onMutate: () => setLeaving('all'),
    onSuccess: () => window.location.assign(SIGN_IN_AGAIN),
    onError: () => setLeaving(null),
  });

  const rows = sessions.data ?? [];
  const otherRows = rows.filter((row) => !row.current);
  const busyId = signOut.isPending ? signOut.variables?.id : null;
  const locked = leaving != null || others.isPending;

  return (
    <SettingsSection
      title="Signed-in devices"
      description="Where your account is signed in now. Sign out any you don't know."
      actions={
        <>
          <PendingButton
            type="button"
            variant="secondary"
            size="sm"
            pending={others.isPending}
            pendingLabel="Signing out…"
            disabled={!otherRows.length || locked || busyId != null}
            onClick={async () => {
              const ok = await confirm({
                title: 'Sign out your other devices?',
                description: `${otherRows.length} other device${otherRows.length === 1 ? '' : 's'} will have to sign in again. This one stays signed in.`,
                confirmLabel: 'Sign out other devices',
                destructive: true,
              });
              if (ok) others.mutate(otherRows);
            }}
          >
            Sign out other devices
          </PendingButton>
          <PendingButton
            type="button"
            variant="secondary"
            size="sm"
            pending={leaving === 'all'}
            pendingLabel="Signing out…"
            disabled={!sessions.data || locked || busyId != null}
            onClick={async () => {
              const ok = await confirm({
                title: 'Sign out everywhere?',
                description: 'Every device signs out, including this one. You sign in again afterwards.',
                confirmLabel: 'Sign out everywhere',
                destructive: true,
              });
              if (ok) everywhere.mutate();
            }}
          >
            <LogOut /> Sign out everywhere
          </PendingButton>
        </>
      }
    >
      {sessions.error && <FormError error={sessions.error} />}
      {!sessions.data && !sessions.error && (
        <div className="grid gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {sessions.data && !rows.length && <p className="text-sm text-muted-foreground">No signed-in devices.</p>}
      {rows.length > 0 && (
        <ul className="-my-2 divide-y divide-slate-100">
          {rows.map((session) => (
            <li key={session.id} className="flex items-center gap-3 py-3" aria-busy={busyId === session.id || undefined}>
              <IconBadge tone={session.current ? 'blue' : 'slate'} className="size-9">
                {isPhone(session.device) ? <Smartphone aria-hidden /> : <Laptop aria-hidden />}
              </IconBadge>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                  {session.device}
                  {session.current && <Badge tone="blue">This device</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">Active {ago(session.lastActiveAt)}</p>
              </div>
              <PendingButton
                type="button"
                variant="ghost"
                size="sm"
                pending={busyId === session.id || (leaving === 'this' && session.current)}
                pendingLabel="Signing out…"
                disabled={(busyId != null && busyId !== session.id) || (locked && !(leaving === 'this' && session.current))}
                onClick={() => signOut.mutate(session)}
                aria-label={`Sign out ${session.device}${session.current ? ' (this device)' : ''}`}
              >
                Sign out
              </PendingButton>
            </li>
          ))}
        </ul>
      )}
      {(signOut.error || others.error || everywhere.error) && (
        <div className="mt-3">
          <FormError error={signOut.error ?? others.error ?? everywhere.error} />
        </div>
      )}
    </SettingsSection>
  );
}
