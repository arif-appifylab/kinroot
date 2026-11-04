import {Eye, EyeOff} from 'lucide-react';
import * as React from 'react';

import {cn} from '@/lib/utils';

import {Input, type ControlSize} from './form';

/**
 * A password field with a show / hide button (AGENTS.md: every password field has one, hidden by
 * default). The button only switches the input's type: the value never leaves the field.
 */
export function PasswordInput({className, id, size, ...props}: Omit<React.ComponentProps<'input'>, 'type' | 'size'> & {size?: ControlSize}) {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="relative">
      <Input id={id} type={shown ? 'text' : 'password'} size={size} className={cn('pr-11', className)} {...props} />
      <button
        type="button"
        aria-controls={id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 right-0 inline-flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-muted-foreground transition-colors outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-primary/30 [&_svg]:size-4"
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </button>
    </div>
  );
}
