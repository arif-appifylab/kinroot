import {type ErrorComponentProps, Link, useRouter} from '@tanstack/react-router';
import {AlertTriangle, Compass, Home, RotateCw} from 'lucide-react';
import {type ReactNode, useState} from 'react';

import {Button} from '@/components/ui/button';
import {IconBadge} from '@/components/ui/misc';
import {ApiError} from '@/lib/api';

/**
 * The router's own screens (AUDIT-2 M-15), set as `defaultNotFoundComponent` and
 * `defaultErrorComponent` in `CrmApp.tsx`: an unknown `/crm/…` address and a screen that failed to
 * load. Each has the screen's one `<h1>` (focus moves there after a navigation) and a way on.
 */
function RouteState({icon, tone, title, children, actions}: {icon: ReactNode; tone: 'blue' | 'rose'; title: string; children: ReactNode; actions: ReactNode}) {
  return (
    <div className="grid min-h-[60vh] place-items-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <IconBadge tone={tone} className="size-12 shadow-soft [&_svg]:size-6">
          {icon}
        </IconBadge>
        <h1 className="mt-4 text-2xl font-extrabold text-slate-900">{title}</h1>
        <div className="mt-2 text-sm text-muted-foreground">{children}</div>
        <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

export function NotFoundScreen() {
  return (
    <RouteState
      icon={<Compass />}
      tone="blue"
      title="Page not found"
      actions={
        <Button asChild>
          <Link to="/">
            <Home /> Go to the dashboard
          </Link>
        </Button>
      }
    >
      <p>There is nothing at this address. The link may be old, or the record may have been deleted.</p>
    </RouteState>
  );
}

/** Words the person can act on: the server's own message for an API refusal, never a stack trace. */
function messageOf(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof TypeError) return 'The server did not answer. Check your connection and try again.';
  return 'Something went wrong while loading this screen. Try again; if it keeps happening, reload the page.';
}

export function RouteErrorScreen({error, reset}: ErrorComponentProps) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      // Runs the failed loaders again, then shows the screen (or this one, with the new error).
      await router.invalidate();
      reset();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <RouteState
      icon={<AlertTriangle />}
      tone="rose"
      title="This screen could not be loaded"
      actions={
        <>
          <Button type="button" pending={retrying} pendingLabel="Retrying…" onClick={() => void retry()}>
            <RotateCw /> Retry
          </Button>
          <Button asChild variant="secondary">
            <Link to="/">
              <Home /> Go to the dashboard
            </Link>
          </Button>
        </>
      }
    >
      <p role="alert">{messageOf(error)}</p>
    </RouteState>
  );
}
