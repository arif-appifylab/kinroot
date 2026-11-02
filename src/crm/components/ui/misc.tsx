import {Tabs as TabsPrimitive} from 'radix-ui';
import * as React from 'react';

import {initials} from '@/lib/format';
import {cn} from '@/lib/utils';

/** A person: their profile picture when they have one (src), else initials on their colour. */
export function Avatar({name, color, src, size = 'md', className}: {name: string; color?: string | null; src?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string}) {
  const sizes = {xs: 'size-5 text-[9px]', sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-14 text-lg'};
  const [broken, setBroken] = React.useState(false);
  if (src && !broken) {
    return <img src={src} alt="" aria-hidden onError={() => setBroken(true)} className={cn('shrink-0 rounded-full object-cover ring-2 ring-card', sizes[size], className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-card', sizes[size], className)}
      style={{background: color ? `linear-gradient(135deg, ${color}, ${color}cc)` : 'linear-gradient(135deg, var(--primary), var(--secondary))'}}
    >
      {initials(name)}
    </span>
  );
}

/** Soft tinted circle/square holding an icon (feature-card style). */
export function IconBadge({children, tone = 'blue', className}: {children: React.ReactNode; tone?: 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'violet' | 'slate'; className?: string}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600',
    teal: 'bg-teal-50 text-teal-600',
    green: 'bg-green-50 text-green-600',
    amber: 'bg-amber-50 text-amber-600',
    rose: 'bg-rose-50 text-rose-600',
    violet: 'bg-violet-50 text-violet-600',
    slate: 'bg-slate-100 text-slate-500',
  };
  return <span className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5', tones[tone], className)}>{children}</span>;
}

export function Skeleton({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-lg bg-slate-200/70', className)} {...props} />;
}

export function Separator({className}: {className?: string}) {
  return <div role="separator" className={cn('h-px w-full bg-slate-100', className)} />;
}

export function EmptyState({icon, title, description, action, className}: {icon: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string}) {
  return (
    <div className={cn('relative flex flex-col items-center justify-center overflow-hidden px-6 py-14 text-center', className)}>
      <div className="blob top-6 left-1/2 size-40 -translate-x-1/2 bg-blue-200/50" />
      <IconBadge className="relative size-12 shadow-soft [&_svg]:size-6">{icon}</IconBadge>
      <h3 className="relative mt-4 text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="relative mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="relative mt-5">{action}</div>}
    </div>
  );
}

// ─── Tabs ───
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

/** `size="sm"` matches the h-8 controls of a `FilterBar`. */
export function TabsList({className, size = 'default', ...props}: React.ComponentProps<typeof TabsPrimitive.List> & {size?: 'default' | 'sm'}) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex items-center gap-1 bg-slate-100/80', size === 'sm' ? 'gap-0.5 rounded-lg p-0.5 [&>button]:rounded-md [&>button]:px-2.5 [&>button]:py-1' : 'rounded-xl p-1', className)}
      {...props}
    />
  );
}

export function TabsTrigger({className, ...props}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-500 transition-all outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-primary/30 data-[state=active]:bg-card data-[state=active]:text-slate-900 data-[state=active]:shadow-soft [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

/** Page title row used at the top of every screen. */
export function PageHeader({title, description, actions, children}: {title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode}) {
  return (
    <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold leading-tight text-slate-900 sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
