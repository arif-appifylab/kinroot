import {ClipboardList, Lock, Mail, MessageCircle} from 'lucide-react';
import {useMemo, useRef, useState} from 'react';

import {fullName} from '@/lib/format';
import type {ConversationRow} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Tooltip} from '../ui/menu';
import {EmailFrame} from '../email-frame';

/** Who is on the other side of a conversation. */
export function senderLabel(c: Pick<ConversationRow, 'contact' | 'sender' | 'last'>) {
  if (c.contact) return fullName(c.contact);
  return c.sender?.name || c.sender?.email || c.last?.fromName || c.last?.fromEmail || 'Unknown sender';
}

export function ChannelIcon({channel, personal, className}: {channel: string; personal?: boolean; className?: string}) {
  const [Icon, label] = channel === 'form' ? [ClipboardList, 'Form response'] : channel === 'chat' ? [MessageCircle, 'Website chat'] : personal ? [Lock, 'Your mailbox (private)'] : [Mail, 'Team email'];
  return (
    <Tooltip content={label}>
      <span className={cn('inline-flex shrink-0 text-muted-foreground', className)} aria-label={label}>
        <Icon className="size-3.5" />
      </span>
    </Tooltip>
  );
}

/** A received email's HTML (already sanitised by the server), isolated from the app (EmailFrame). */
export function MessageFrame({html}: {html: string}) {
  return <EmailFrame html={html} baseCss=".email-root a{color:#2563eb}.email-root blockquote{margin:0 0 0 .25em;padding-left:.75em;border-left:2px solid #e2e8f0;color:#64748b}" />;
}
