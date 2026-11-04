import {Dialog as DialogPrimitive} from 'radix-ui';
import {X} from 'lucide-react';
import * as React from 'react';

import {cn} from '@/lib/utils';

/**
 * Every popup in the app is a right-side drawer: full height, slides in from
 * the right, full width on phones. Compose it as
 *
 *   <Dialog open onOpenChange={(o) => !o && onClose()}>
 *     <DialogContent size="md">
 *       <DialogHeader><DialogTitle>…</DialogTitle></DialogHeader>
 *       <DialogBody>…</DialogBody>          ← the only part that scrolls
 *       <DialogFooter>…actions</DialogFooter> ← always visible
 *     </DialogContent>
 *   </Dialog>
 *
 * A `<form>` wrapping header/body/footer needs `className="flex min-h-0 flex-1 flex-col"`.
 * `size`: sm ≈420px (confirmations, short forms) · md ≈560px (default forms) ·
 * lg ≈760px (wide forms, tables) · xl ≈1040px (editor + preview). The drawer is
 * a CSS container, so two-column bodies use container variants
 * (`grid-cols-1 @3xl:grid-cols-2`) and stack whenever the drawer is narrow.
 * Esc, the overlay and the close button close it; focus is trapped inside.
 * For yes/no questions use `confirm()` from `./confirm` instead.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<DrawerSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[760px]',
  xl: 'max-w-[1040px]',
};

function Overlay({className, ...props}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0', className)}
      {...props}
    />
  );
}

/**
 * Remembers where focus goes back to on close, before an `autoFocus` field
 * inside takes it. Opened from a dropdown item, that item is gone by then, so
 * it is the menu's trigger button instead.
 */
function RememberFocus({into}: {into: React.RefObject<HTMLElement | null>}) {
  React.useState(() => {
    if (typeof document === 'undefined') return;
    const el = document.activeElement as HTMLElement | null;
    const trigger = el?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
    into.current = (trigger && document.getElementById(trigger)) || el;
  });
  return null;
}

export function DialogContent({className, children, size = 'md', onCloseAutoFocus, ...props}: React.ComponentProps<typeof DialogPrimitive.Content> & {size?: DrawerSize}) {
  const back = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented && back.current?.isConnected) (e.preventDefault(), back.current.focus());
        }}
        className={cn(
          '@container fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col overflow-hidden border-l border-slate-100 bg-card shadow-lift outline-none',
          'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-200',
          SIZES[size],
          className,
        )}
        {...props}
      >
        <RememberFocus into={back} />
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('grid shrink-0 gap-1 border-b border-slate-100 px-6 pt-5 pb-4 pr-12', className)} {...props} />;
}

export function DialogBody({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-6 py-5 scrollbar-thin', className)} {...props} />;
}

export function DialogFooter({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex shrink-0 flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4 @sm:flex-row @sm:justify-end', className)} {...props} />;
}

export function DialogTitle({className, ...props}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg font-bold text-slate-900', className)} {...props} />;
}

export function DialogDescription({className, ...props}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
