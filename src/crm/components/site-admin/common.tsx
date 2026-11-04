import {AlertCircle, Loader2, Lock} from 'lucide-react';
import type {ComponentProps, ReactNode} from 'react';

import {Button} from '@/components/ui/button';

/**
 * Pieces shared by Settings → Team (its account actions), Roles and the Audit log's "Sign-in & security" tab
 * (the site's own admin, `src/crm/lib/site-admin.ts`).
 */

/** Shown instead of a screen the viewer's site roles do not open (the server refuses it too). */
export function NoSiteAccess({children}: {children: ReactNode}) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
      <Lock className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A failed read or action, in words, where it happened. */
export function ErrorNote({error, onRetry}: {error: Error | null; onRetry?: () => void}) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
      <AlertCircle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{error.message}</span>
      {onRetry && (
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** "Load more" under a keyset-paged list; pending while the next page loads. */
export function LoadMore({hasNextPage, isFetchingNextPage, fetchNextPage}: {hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown}) {
  if (!hasNextPage) return null;
  return (
    <div className="flex justify-center pt-4">
      <Button type="button" variant="secondary" size="sm" aria-busy={isFetchingNextPage || undefined} disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
        {isFetchingNextPage ? (
          <>
            <Loader2 className="animate-spin" /> Loading…
          </>
        ) : (
          'Load more'
        )}
      </Button>
    </div>
  );
}

/** A submit button that shows its work: spinner, present-tense label, `aria-busy`, disabled. */
export function PendingButton({pending, pendingLabel, children, disabled, ...props}: ComponentProps<typeof Button> & {pending: boolean; pendingLabel: string}) {
  return (
    <Button {...props} aria-busy={pending || undefined} disabled={pending || disabled}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" /> {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
