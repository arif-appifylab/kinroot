import {DropdownMenu as Menu, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive} from 'radix-ui';
import * as React from 'react';

import {cn} from '@/lib/utils';

const surface = 'z-50 rounded-xl border border-slate-100 bg-popover p-1 text-popover-foreground shadow-lift data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0';

// ─── Dropdown menu ───
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({className, sideOffset = 6, align = 'end', ...props}: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content sideOffset={sideOffset} align={align} className={cn(surface, 'min-w-44', className)} {...props} />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({className, destructive, ...props}: React.ComponentProps<typeof Menu.Item> & {destructive?: boolean}) {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4 [&_svg]:text-slate-400',
        destructive && 'text-destructive data-[highlighted]:bg-rose-50 data-[highlighted]:text-destructive [&_svg]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({className, ...props}: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn('px-2.5 py-1.5 text-xs font-semibold text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator({className, ...props}: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-slate-100', className)} {...props} />;
}

// ─── Popover ───
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({className, sideOffset = 6, align = 'start', ...props}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content sideOffset={sideOffset} align={align} className={cn(surface, 'w-72 p-0 outline-none', className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}

// ─── Tooltip ───
export function Tooltip({content, children, side = 'top'}: {content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'}) {
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 rounded-lg bg-sidebar px-2.5 py-1.5 text-xs font-medium text-white ring-1 ring-white/10 shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0">
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
