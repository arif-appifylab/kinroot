import {MessageCircle, X} from 'lucide-react';
import {useEffect, useState} from 'react';

import {cn} from '@/lib/utils';

import {ChatPanel} from './chat-panel';
import {useVisitorChat} from './use-chat';

const OPEN_EVENT = 'crm-chat:open';

/** Opens the <ChatWidget> on this page (e.g. from a "Chat with us" button). */
export const openChat = () => window.dispatchEvent(new Event(OPEN_EVENT));

/**
 * Website chat on a page built in this app (e.g. an AI-built landing page),
 * like <CrmForm> and <BookingWidget>:
 *
 *   import {ChatWidget} from '@/components/chat/chat-widget';
 *   <ChatWidget />                       // launcher bubble in the bottom corner
 *   <ChatWidget position="left" defaultOpen />
 *
 * Same visitor token (localStorage) and API as the embedded widget, so a
 * visitor keeps their conversation. Renders nothing while chat is off in
 * Settings → Inbox → Chat. A "Chat with us" button elsewhere on the page calls `openChat()`.
 */
export function ChatWidget({position, defaultOpen = false}: {position?: 'left' | 'right'; defaultOpen?: boolean}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  const [page, setPage] = useState<{page: string | null; title: string | null; referrer: string | null}>({page: null, title: null, referrer: null});
  useEffect(() => setPage({page: window.location.href, title: document.title, referrer: document.referrer || null}), []);
  const chat = useVisitorChat({meta: {...page, ancestor: null}, open});
  const cfg = chat.config;
  if (!cfg?.enabled || !cfg.allowed) return null;
  const left = (position ?? cfg.position) === 'left';
  return (
    <>
      {open && (
        <div id="crm-chat-panel" className={cn('fixed inset-0 z-50 overflow-hidden bg-white shadow-lift sm:inset-auto sm:bottom-24 sm:h-[min(640px,calc(100dvh-8rem))] sm:w-[380px] sm:rounded-2xl', left ? 'sm:left-5' : 'sm:right-5')}>
          <ChatPanel chat={chat} trap onClose={() => setOpen(false)} />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="crm-chat-panel"
        aria-label={open ? 'Close chat' : `Open chat${chat.unread ? ` (${chat.unread} unread)` : ''}`}
        className={cn('fixed bottom-5 z-50 flex size-14 cursor-pointer items-center justify-center rounded-full text-white shadow-lift transition-transform hover:scale-105', left ? 'left-5' : 'right-5', open && 'max-sm:hidden')}
        style={{background: cfg.color}}
      >
        {open ? <X className="size-6" /> : <MessageCircle className="size-6" />}
        {!open && chat.unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-rose-600 px-1.5 text-xs leading-5 font-bold" aria-hidden>{chat.unread > 9 ? '9+' : chat.unread}</span>}
      </button>
    </>
  );
}
