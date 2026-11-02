import {useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ArrowRight, Loader2, LogIn, UserPlus} from 'lucide-react';
import {useState} from 'react';

import {AuthLayout} from '@/components/auth-layout';
import {Button} from '@/components/ui/button';
import {pageTitle} from '@/lib/brand';
import {api} from '@/lib/api';
import {keys} from '@/lib/queries';

export const Route = createFileRoute('/invite/$token')({
  head: () => ({meta: [{title: pageTitle('Join your team')}]}),
  component: InvitePage,
});

type Invite = {email: string; name: string; brandName: string; signedIn: boolean};

/**
 * An invite link. Accounts are the site's: the invited person signs in (or creates an account with
 * the invited address and confirms it), comes back here, and joins. The link never signs anyone in.
 */
function InvitePage() {
  const {token} = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({queryKey: ['invite', token], queryFn: () => api.get<Invite>(`/auth/invite/${token}`), retry: false});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = encodeURIComponent(`/crm/invite/${token}`);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/auth/invite/${token}`);
      await qc.invalidateQueries({queryKey: keys.auth});
      navigate({to: '/'});
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (invite.isError) {
    return (
      <AuthLayout title="This invite" highlight="can't be used" subtitle={(invite.error as Error).message}>
        <a className="text-sm font-semibold text-primary hover:underline" href="/">
          Back to the website
        </a>
      </AuthLayout>
    );
  }

  const data = invite.data;
  return (
    <AuthLayout
      title="Join"
      highlight={data?.brandName ?? 'your team'}
      subtitle={data ? `You were invited as ${data.name} (${data.email}).` : 'Loading your invite…'}
    >
      {data &&
        (data.signedIn ? (
          <div className="grid gap-3">
            <Button type="button" size="lg" className="group w-full" disabled={busy} aria-busy={busy} onClick={join}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? 'Joining…' : 'Join the team'}
              {!busy && <ArrowRight className="transition-transform group-hover:translate-x-1" />}
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Sign in with the invited address, or create your account with it, then you come back here to join.</p>
            <Button asChild size="lg" className="w-full">
              <a href={`/account/register/?next=${back}`}>
                <UserPlus /> Create your account
              </a>
            </Button>
            <Button asChild variant="secondary" size="lg" className="w-full">
              <a href={`/account/login/?next=${back}`}>
                <LogIn /> I already have an account
              </a>
            </Button>
          </div>
        ))}
    </AuthLayout>
  );
}
