import {ChevronDown, Copy} from 'lucide-react';
import type {ReactNode} from 'react';
import {toast} from 'sonner';

import {cn} from '@/lib/utils';

import {Button} from '../ui/button';

/** Bits shared by the Outgoing and Incoming tabs of Settings → Webhooks. */

export function copy(text: string, what = 'Copied') {
  navigator.clipboard.writeText(text);
  toast.success(what);
}

/** A native <details> disclosure: collapsed by default, keyboard and screen-reader friendly. */
export function Disclosure({summary, icon, children, className, open}: {summary: ReactNode; icon?: ReactNode; children: ReactNode; className?: string; open?: boolean}) {
  return (
    <details className={cn('group rounded-xl border border-slate-200', className)} open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        {icon && <span className="text-slate-400 [&_svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-3 border-t border-slate-100 px-3 py-3 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

/** Dark code block with a copy button; scrolls inside itself, never the page. */
export function CodeBlock({code, label, className}: {code: string; label: string; className?: string}) {
  return (
    <div className="relative min-w-0">
      <pre className={cn('max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 pr-10 font-mono text-[11px] leading-relaxed text-slate-200 scrollbar-thin', className)}>{code}</pre>
      <Button type="button" size="icon-sm" variant="ghost" className="absolute top-1.5 right-1.5 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => copy(code)} aria-label={`Copy ${label}`}>
        <Copy />
      </Button>
    </div>
  );
}
