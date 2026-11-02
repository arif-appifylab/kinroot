import {cva, type VariantProps} from 'class-variance-authority';
import {Slot} from 'radix-ui';
import * as React from 'react';

import {cn} from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        // Signature gradient with a lift on hover.
        default: 'bg-brand text-primary-foreground shadow-btn hover:-translate-y-0.5 hover:shadow-[0_6px_20px_0_rgb(37_99_235/0.38)] active:translate-y-0',
        secondary: 'border border-border bg-card text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-accent hover:text-accent-foreground',
        soft: 'bg-accent text-primary hover:bg-blue-100',
        destructive: 'bg-destructive text-destructive-foreground hover:-translate-y-0.5 hover:brightness-110',
        success: 'bg-success text-white hover:-translate-y-0.5 hover:brightness-110 shadow-[0_4px_14px_0_rgb(22_163_74/0.3)]',
        link: 'text-primary underline-offset-4 hover:underline px-0',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-8 rounded-lg px-3 text-[13px]',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: {variant: 'default', size: 'default'},
  },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {asChild?: boolean};

export function Button({className, variant, size, asChild = false, ...props}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({variant, size, className}))} {...props} />;
}

export {buttonVariants};
