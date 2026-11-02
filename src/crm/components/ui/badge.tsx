import {cva, type VariantProps} from 'class-variance-authority';
import * as React from 'react';

import {cn} from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-700',
      blue: 'bg-blue-50 text-blue-700',
      teal: 'bg-teal-50 text-teal-700',
      green: 'bg-green-50 text-green-700',
      amber: 'bg-amber-50 text-amber-700',
      rose: 'bg-rose-50 text-rose-700',
      violet: 'bg-violet-50 text-violet-700',
      outline: 'border border-border bg-card text-slate-600',
    },
  },
  defaultVariants: {tone: 'neutral'},
});

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({className, tone, ...props}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({tone}), className)} {...props} />;
}
