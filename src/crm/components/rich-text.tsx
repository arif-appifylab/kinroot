import type {ReactNode} from 'react';

import {cn} from '@/lib/utils';

/**
 * Shows rich text written with the 'text' editor (tickets, saved replies). The HTML was
 * sanitised on the server when it was stored (richBody() in src/server/lib/rich-text.ts):
 * formatting, lists, quotes and http(s) / mailto links only. Never pass anything else here.
 * Without HTML (older messages, emailed replies, forms) the plain-text fallback is shown.
 */
export function RichText({html, className, children}: {html: string | null | undefined; className?: string; children: ReactNode}) {
  if (!html) return <div className={cn('text-sm leading-relaxed whitespace-pre-wrap text-slate-800', className)}>{children}</div>;
  return (
    <div
      className={cn(
        'text-sm leading-relaxed break-words text-slate-800',
        '[&_p]:my-0 [&_p+p]:mt-2.5 [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-bold [&_h3]:mt-3 [&_h3]:font-bold',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li_p]:my-0',
        '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:break-all',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600',
        '[&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-100 [&_pre]:p-3 [&_hr]:my-3 [&_hr]:border-slate-200',
        className,
      )}
      // Sanitised on the server before it was stored; see the comment above.
      dangerouslySetInnerHTML={{__html: html}}
    />
  );
}
