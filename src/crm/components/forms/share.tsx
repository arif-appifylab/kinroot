import {Code2, Copy, ExternalLink, Link2, MousePointerClick, Sparkles} from 'lucide-react';
import type {ReactNode} from 'react';
import {toast} from 'sonner';

import type {FormStatus} from '@/lib/types';

import {SettingsSection} from '../settings-section';
import {Button} from '../ui/button';
import {Input} from '../ui/form';
import {IconBadge} from '../ui/misc';

function copy(text: string, what = 'Copied') {
  navigator.clipboard.writeText(text);
  toast.success(what);
}

function Snippet({code, label}: {code: string; label: string}) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl bg-slate-950 p-4 pr-12 text-xs leading-relaxed text-slate-200 scrollbar-thin">{code}</pre>
      <Button size="icon-sm" variant="ghost" className="absolute top-2 right-2 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => copy(code, `${label} copied`)} aria-label={`Copy ${label}`}>
        <Copy />
      </Button>
    </div>
  );
}

function Way({icon, title, description, children}: {icon: ReactNode; title: string; description: string; children: ReactNode}) {
  return (
    <div className="grid gap-3 border-b border-slate-100 py-5 first:pt-0 last:border-0 last:pb-0">
      <div className="flex items-start gap-3">
        <IconBadge tone="blue" className="shrink-0">{icon}</IconBadge>
        <div>
          <p className="text-sm font-bold text-slate-900">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Share tab: hosted link, inline embed, popup button, and the React component for AI-built pages. */
export function SharePanel({slug, status, onPublish}: {slug: string; status: FormStatus; onPublish: () => void}) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const url = `${origin}/f/${slug}`;
  const script = `<script src="${origin}/site-api/crm/public/forms/embed.js" async></script>`;
  return (
    <div className="max-w-3xl">
      {status !== 'PUBLISHED' && (
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center">
          <p className="flex-1">{status === 'CLOSED' ? 'This form is closed. Links and embeds show the closed message.' : 'This form is a draft. Publish it so the link and embeds accept responses.'}</p>
          <Button size="sm" onClick={onPublish}>{status === 'CLOSED' ? 'Reopen form' : 'Publish now'}</Button>
        </div>
      )}
      <SettingsSection title="Share" description="Use any of these; responses all land in the same place.">
        <Way icon={<Link2 />} title="Link" description="Send it by email, chat or social. UTM parameters on the link are saved with each response.">
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" size="icon" onClick={() => copy(url, 'Link copied')} aria-label="Copy link"><Copy /></Button>
            <Button variant="secondary" size="icon" asChild><a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open form"><ExternalLink /></a></Button>
          </div>
        </Way>
        <Way icon={<Code2 />} title="Button on a website" description="Paste where the button should appear. It opens the form in a small window and passes the page's UTM parameters along.">
          <Snippet label="Embed code" code={`<div data-crm-form="${slug}" data-label="Get in touch"></div>\n${script}`} />
          <p className="text-xs text-muted-foreground">
            Forms open as a page of this site: other websites can't show it inside their own page. Change the button with <code>data-label</code> and <code>data-color</code>.
          </p>
        </Way>
        <Way icon={<MousePointerClick />} title="Your own button" description="Any element with this attribute opens the form in a small window.">
          <Snippet label="Popup code" code={`<button data-crm-form-popup="${slug}">Talk to sales</button>\n${script}`} />
        </Way>
        <Way icon={<Sparkles />} title="In a page built in this app" description="For landing pages the AI builds in this codebase: renders the form inline, no iframe.">
          <Snippet label="Component code" code={`import {CrmForm} from '@/components/forms/crm-form';\n\n<CrmForm slug="${slug}" />`} />
        </Way>
      </SettingsSection>
    </div>
  );
}
