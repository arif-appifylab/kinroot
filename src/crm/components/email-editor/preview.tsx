import {Monitor, Smartphone} from 'lucide-react';
import {useMemo, useState} from 'react';

import {sampleMerge, textToEditorHtml, toEmailHtml} from '@/lib/email-html';
import {accentOf, wrapEmail, type EmailDesign, type EmailLayout} from '@/lib/email-layout';
import {useEmailDesign, useMe} from '@/lib/queries';
import {cn} from '@/lib/utils';

/** Toggle group used by the preview (and the layout picker). */
export function Segmented<T extends string>({value, onChange, options, label}: {value: T; onChange: (v: T) => void; options: {value: T; label: string; icon?: React.ReactNode}[]; label: string}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-slate-500 transition-all hover:text-slate-800 [&_svg]:size-3.5',
            value === o.value && 'bg-card text-slate-900 shadow-soft',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type PreviewInput = {
  html?: string | null;
  text?: string | null;
  subject?: string;
  preheader?: string | null;
  layout: EmailLayout;
  /** Override the saved design (Settings → Email design, while editing). */
  design?: EmailDesign;
  /** Shown under the content, like the sender's signature. */
  signatureHtml?: string | null;
};

/**
 * Live preview in an iframe, built with the same functions the server uses
 * to send (toEmailHtml → wrapEmail), with sample merge values.
 */
export function EmailPreview({html, text, subject, preheader, layout, design: override, signatureHtml, height = 520}: PreviewInput & {height?: number}) {
  const {me} = useMe();
  const q = useEmailDesign();
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  const doc = useMemo(() => {
    if (!q.data) return '';
    const design = override ?? q.data.design;
    const theme = {accent: accentOf(design, q.data.brand.primary)};
    const body = html ? html : textToEditorHtml(text ?? '');
    const sig = signatureHtml ? `<div style="margin-top:24px">${toEmailHtml(signatureHtml, theme)}</div>` : '';
    const content = sampleMerge(toEmailHtml(body, theme) + sig, me);
    const out = wrapEmail({content, layout, preheader: preheader ? sampleMerge(preheader, me) : null, design, brand: q.data.brand, unsubscribeUrl: '#unsubscribe'});
    // Links in the preview must not navigate the frame.
    const safe = out.replace('<head>', '<head><style>a{pointer-events:none}</style>');
    return safe;
  }, [q.data, override, html, text, signatureHtml, layout, preheader, me]);

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Preview size" value={device} onChange={setDevice} options={[{value: 'desktop', label: 'Desktop', icon: <Monitor />}, {value: 'mobile', label: 'Mobile', icon: <Smartphone />}]} />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
        {subject !== undefined && (
          <div className="border-b border-slate-200 bg-card px-4 py-2.5">
            <p className="truncate text-sm font-bold text-slate-900">{sampleMerge(subject, me) || '(no subject)'}</p>
            {preheader && <p className="truncate text-xs text-muted-foreground">{sampleMerge(preheader, me)}</p>}
          </div>
        )}
        <div className="flex justify-center p-3">
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={doc}
            className={cn('rounded-lg bg-white transition-[width] duration-300', device === 'mobile' ? 'w-[375px] max-w-full' : 'w-full')}
            style={{height, colorScheme: 'light'}}
          />
        </div>
      </div>
    </div>
  );
}
