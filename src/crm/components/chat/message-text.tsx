import {FileText, Paperclip} from 'lucide-react';

import {linkify} from '@/lib/chat';
import {cn} from '@/lib/utils';

/**
 * Chat text is plain text, never HTML: line breaks are kept and http(s)
 * links become links (rel noopener, new tab). Used by the visitor widget and
 * the inbox.
 */
export function MessageText({text, className, linkClassName}: {text: string; className?: string; linkClassName?: string}) {
  return (
    <p className={cn('text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', className)}>
      {linkify(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className={cn('underline underline-offset-2', linkClassName)}>
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Attachments: raster images as thumbnails (opening the full file), anything else (SVG, PDF, documents) as a download link. */
export function MessageFiles({files, tone = 'light'}: {files: {id: string; name: string; size: number; image: boolean; url: string}[]; tone?: 'light' | 'dark'}) {
  if (!files.length) return null;
  const download = (url: string) => `${url}${url.includes('?') ? '&' : '?'}download=1`;
  return (
    <div className="mt-1.5 grid gap-1.5">
      {files.map((f) =>
        f.image ? (
          <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="block w-fit overflow-hidden rounded-lg border border-black/5">
            <img src={f.url} alt={f.name} loading="lazy" className="max-h-48 max-w-full object-contain" />
          </a>
        ) : (
          <a
            key={f.id}
            href={download(f.url)}
            className={cn('flex w-fit max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold', tone === 'dark' ? 'border-white/30 text-white hover:bg-white/10' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')}
          >
            {/pdf|document|text/.test(f.name) ? <FileText className="size-3.5 shrink-0" /> : <Paperclip className="size-3.5 shrink-0" />}
            <span className="min-w-0 truncate">{f.name}</span>
            <span className="shrink-0 font-normal opacity-70">{fileSize(f.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
