import {MessageCircleOff} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';
import {Toaster} from 'sonner';

import {ChatPanel} from '@/components/chat/chat-panel';
import {useVisitorChat, type PageMeta} from '@/components/chat/use-chat';
import {IconBadge} from '@/components/ui/misc';

/**
 * The visitor's chat as a page of this site (src/pages/chat/): Kinroot's chat panel, full height.
 *
 *   /chat/?page=…&title=…   opened by widget.js (a company's website) as a small popup window: the
 *                           site may not be framed (X-Frame-Options: DENY), so it is a window of its
 *                           own. It tells the page that opened it how many replies are unread.
 *   /chat/c/<token>         "continue the conversation" from an email sent to the visitor.
 */
export default function ChatPage({continueToken, valid = true}: {continueToken?: string; valid?: boolean}) {
  const initial = useMemo<PageMeta>(() => {
    const q = new URLSearchParams(window.location.search);
    return {page: q.get('page')?.slice(0, 2000) ?? null, title: q.get('title')?.slice(0, 200) ?? null, referrer: q.get('ref')?.slice(0, 1000) ?? null, ancestor: null};
  }, []);
  const [meta] = useState(initial);
  const chat = useVisitorChat({meta, open: true, ...(continueToken ? {continueToken} : {})});
  const popup = !!window.opener && !continueToken;

  // The page that opened this window shows the unread count on its chat button (it checks our origin).
  useEffect(() => {
    if (!popup) return;
    try {
      window.opener?.postMessage({type: 'crm-chat:unread', count: chat.unread}, '*');
    } catch {
      // The opener went away: nothing to tell.
    }
  }, [popup, chat.unread]);

  if (!valid) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-6">
        <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-soft">
          <IconBadge tone="slate" className="mx-auto size-12 [&_svg]:size-6">
            <MessageCircleOff />
          </IconBadge>
          <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-900">This link has expired</h1>
          <p className="mt-2 text-sm text-muted-foreground">Reply to our email instead, or start a new chat from our website.</p>
        </div>
      </main>
    );
  }

  return (
    <main className={popup ? 'h-dvh' : 'grid min-h-dvh place-items-start bg-background p-4 sm:place-items-center'}>
      <div className={popup ? 'h-full' : 'mx-auto h-[min(680px,calc(100dvh-2rem))] w-full max-w-lg overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-soft'}>
        <ChatPanel chat={chat} onClose={popup ? () => window.close() : undefined} />
      </div>
      <Toaster position="bottom-center" richColors />
    </main>
  );
}
