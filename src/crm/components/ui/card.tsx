import * as React from 'react';

import {cn} from '@/lib/utils';

/** White surface with the brand-tinted soft shadow. `interactive` adds the lift-on-hover. */
export function Card({className, interactive, ...props}: React.ComponentProps<'div'> & {interactive?: boolean}) {
  return (
    <div
      data-slot="card"
      className={cn(
        'rounded-xl border border-slate-100 bg-card text-card-foreground shadow-soft',
        interactive && 'transition-all duration-200 ease-out hover:-translate-y-1 hover:shadow-lift',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-start justify-between gap-3 px-5 pt-5', className)} {...props} />;
}

/** A card's title: `h2` under the screen's `h1`; `level={3}` for a card inside a section that has its own `h2`. */
export function CardTitle({className, level = 2, ...props}: React.ComponentProps<'h2'> & {level?: 2 | 3}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return <Heading className={cn('text-[15px] font-semibold text-slate-900', className)} {...props} />;
}

export function CardDescription({className, ...props}: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-5', className)} {...props} />;
}
