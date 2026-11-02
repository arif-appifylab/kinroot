import {createFileRoute} from '@tanstack/react-router';
import {LogOut, UserPlus} from 'lucide-react';

import {AuthLayout} from '@/components/auth-layout';
import {Button} from '@/components/ui/button';
import {pageTitle} from '@/lib/brand';
import {signInPath} from '@/lib/api';
import {useAuth} from '@/lib/queries';
import {logout} from '../../platform/browser';

export const Route = createFileRoute('/no-access')({
  head: () => ({meta: [{title: pageTitle('Ask for an invite')}]}),
  component: NoAccess,
});

/** Signed in to the site, but not on the CRM team (yet): joining is by invite. */
function NoAccess() {
  const auth = useAuth();
  const signedIn = auth.data?.signedIn ?? false;
  return (
    <AuthLayout
      title={signedIn ? 'You are not on' : 'Sign in to'}
      highlight={`${auth.data?.brandName ?? 'the CRM'}`}
      subtitle={
        signedIn
          ? 'Your account is signed in, but it has not joined this team. Ask an admin to invite you, then open the invite link from your email.'
          : 'Sign in with your account to open the CRM.'
      }
    >
      <div className="grid gap-3">
        {signedIn ? (
          <Button type="button" variant="secondary" size="lg" className="w-full" onClick={() => void logout()}>
            <LogOut /> Sign in with another account
          </Button>
        ) : (
          <Button asChild size="lg" className="w-full">
            <a href={signInPath()}>
              <UserPlus /> Sign in
            </a>
          </Button>
        )}
        <a className="text-center text-sm text-muted-foreground hover:text-foreground" href="/">
          Back to the website
        </a>
      </div>
    </AuthLayout>
  );
}
