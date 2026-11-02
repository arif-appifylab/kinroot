import {ClipboardList, Lock, Mail, MessageCircle} from 'lucide-react';
import {useMemo, useRef, useState} from 'react';

import {fullName} from '@/lib/format';
import type {ConversationRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Tooltip} from '../ui/menu';

/** Who is on the other side of a conversation. */
export function senderLabel(c: Pick<ConversationRow, 'contact' | 'sender' | 'last'>) {
  if (c.contact) return fullName(c.contact);
  return c.sender?.name || c.sender?.email || c.last?.fromName || c.last?.fromEmail || 'Unknown sender';
}

export function ChannelIcon({channel, personal, className}: {channel: string; personal?: boolean; className?: string}) {
  const [Icon, label] = channel === 'form' ? [ClipboardList, 'Form response'] : channel === 'chat' ? [MessageCircle, 'Website chat'] : personal ? [Lock, 'Your mailbox (private)'] : [Mail, 'Team email'];
  return (
    <Tooltip content={label}>
      <span className={cn('inline-flex shrink-0 text-slate-400', className)} aria-label={label}>
        <Icon className="size-3.5" />
      </span>
    </Tooltip>
  );
}

/**
 * A received email's HTML, already sanitised by the server, in a sandboxed
 * frame: no scripts, a CSP that only lets images and inline styles through,
 * links open in a new tab. Same-origin (without scripts) so the height can be
 * measured.
 */
export function MessageFrame({html}: {html: string}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"><base target="_blank"><style>
html,body{margin:0;padding:0;background:#fff}body{font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1e293b;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%!important}a{color:#2563eb}blockquote{margin:0 0 0 .25em;padding-left:.75em;border-left:2px solid #e2e8f0;color:#64748b}
</style></head><body>${html}</body></html>`,
    [html],
  );
  const measure = () => {
    const d = ref.current?.contentDocument;
    if (d?.documentElement) setHeight(Math.min(6000, Math.max(40, d.documentElement.scrollHeight + 2)));
  };
  return (
    <iframe
      ref={ref}
      title="Email message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={() => {
        measure();
        setTimeout(measure, 400);
      }}
      className="block w-full rounded-lg border-0 bg-white"
      style={{height, colorScheme: 'light'}}
    />
  );
}
