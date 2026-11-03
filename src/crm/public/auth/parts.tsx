import {AlertCircle, Check, CheckCircle2, Circle, Loader2} from 'lucide-react';
import {useEffect, useRef, type ReactNode} from 'react';

import {Button, type ButtonProps} from '@/components/ui/button';
import {Label} from '@/components/ui/form';
import {IconBadge} from '@/components/ui/misc';
import {cn} from '@/lib/utils';

import {matchCheck, passwordChecks, type PasswordCheck} from '../../../lib/password-checks';
import type {Status} from './use-auth-form';

/**
 * The sign-in pages' building blocks, in Kinroot's UI kit. The kit's `Field` has no ids on its
 * hint and error, so `AuthField` adds them (`aria-describedby` points at them).
 */
export function AuthField({id, label, error, hint, children}: {id: string; label: string; error?: string | null; hint?: ReactNode; children: ReactNode}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The form's status line: errors that belong to no field, or a short confirmation. */
export function StatusLine({status}: {status: Status}) {
  if (!status) return null;
  const error = status.kind === 'error';
  return (
    <p
      role={error ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm font-medium', error ? 'bg-rose-50 text-rose-700' : 'bg-green-50 text-green-700')}
    >
      {error ? <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>{status.message}</span>
    </p>
  );
}

/** A box above the form explaining why the visitor is here (`?notice=`), or a link that can't work. */
export function Notice({children}: {children: ReactNode}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-3 text-sm font-medium text-amber-800">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/**
 * The kit's disabled buttons ignore the pointer; these show it can't act (AGENTS.md: visibly
 * disabled, `cursor: not-allowed`) and don't lift on hover. A disabled button still sends no click.
 */
const DISABLED = 'disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:no-underline';

/** A button that shows a spinner and a present-tense label while its action runs, disabled meanwhile. */
export function PendingButton({pending, pendingLabel, children, disabled, ...props}: ButtonProps & {pending: boolean; pendingLabel: string}) {
  return (
    <Button {...props} className={cn(DISABLED, props.className)} disabled={pending || disabled} aria-busy={pending || undefined}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden /> {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** A small text button (resend, switch method), styled as a link. */
export function LinkButton({className, ...props}: ButtonProps) {
  return <Button type="button" variant="link" size="sm" className={cn('h-auto px-0 py-0 text-[13px]', DISABLED, className)} {...props} />;
}

/** A plain link to another sign-in page, styled like the kit's link button. */
export function TextLink({href, children}: {href: string; children: ReactNode}) {
  return (
    <a href={href} className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {children}
    </a>
  );
}

/**
 * A new password's rules, ticked off while typing (src/lib/password-checks.ts, the server's rules).
 * After a submit the rules still missing turn red. With `confirm`, the list is "Both passwords
 * match" alone, shown once the second field has a value (or after a submit).
 */
export function PasswordChecklist({id, password, email = '', confirm, tried}: {id: string; password: string; email?: string; confirm?: string; tried: boolean}) {
  const checks: PasswordCheck[] = confirm === undefined ? passwordChecks(password, email) : [matchCheck(password, confirm)];
  const hidden = confirm !== undefined && !confirm && !tried;
  return (
    <ul id={id} hidden={hidden} className="grid gap-1 text-xs" aria-live="polite">
      {checks.map((check) => (
        <li key={check.id} className={cn('flex items-center gap-1.5', check.ok ? 'text-green-700' : tried ? 'text-destructive' : 'text-muted-foreground')}>
          {check.ok ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
          {check.label}
          <span className="sr-only">{check.ok ? ' (done)' : ' (not yet)'}</span>
        </li>
      ))}
    </ul>
  );
}

/** What replaces a form after a success with nothing else to do (focus moves to it). */
export function DonePanel({message, link}: {message: string; link?: {href: string; text: string}}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="grid justify-items-center gap-4 text-center outline-none">
      <IconBadge tone="green" className="size-12 [&_svg]:size-6">
        <CheckCircle2 aria-hidden />
      </IconBadge>
      <p className="text-sm leading-relaxed text-slate-700">{message}</p>
      {link && (
        <Button asChild className="w-full">
          <a href={link.href}>{link.text}</a>
        </Button>
      )}
    </div>
  );
}

/** The links row under the card ("Forgot your password?" · "Create an account"). */
export function LinksRow({children}: {children: ReactNode}) {
  return <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center [&>[aria-hidden]]:text-slate-300">{children}</p>;
}

export const Dot = () => <span aria-hidden>·</span>;
