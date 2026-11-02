import {Bot, Check, CheckCheck, ChevronDown, Loader2, Lock, Mail, MessageCircle, Paperclip, Send, StickyNote, X} from 'lucide-react';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {ago, dateTime} from '@/lib/format';
import {keys, useApiMutation} from '@/lib/queries';
import type {ChatMessage, ConversationDetail, EmailMessage} from '@/lib/types';
import {cn} from '@/lib/utils';

import {fileSize, MessageFiles, MessageText} from '../chat/message-text';
import {MentionField} from '../mentions';
import {useCannedReplies} from '../tickets/ticket-badges';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {Textarea} from '../ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tooltip} from '../ui/menu';
import {Avatar} from '../ui/misc';
import type {ComposerMode} from './reply-composer';
import {uploadFile} from '@/lib/upload';

const invalidate = [keys.inbox, keys.timeline];

/** Strips the quoted history from an email reply (the visitor answered our email). */
const firstPart = (text: string) => {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^On .{4,300}wrote:\s*$/.test(l.trim()) || /^>/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  return (at > 0 ? lines.slice(0, at) : lines).join('\n').trim();
};

function Status({m}: {m: ChatMessage}) {
  if (m.direction !== 'OUTBOUND' || m.kind !== 'text') return null;
  if (m.status === 'FAILED') return <span className="text-destructive">Not sent</span>;
  if (m.readAt) return <span className="inline-flex items-center gap-0.5"><CheckCheck className="size-3" /> Seen</span>;
  if (m.deliveredAt) return <span className="inline-flex items-center gap-0.5"><CheckCheck className="size-3 opacity-60" /> Delivered</span>;
  return <span className="inline-flex items-center gap-0.5"><Check className="size-3" /> Sent</span>;
}

function Bubble({m, visitor}: {m: ChatMessage; visitor: string}) {
  if (m.kind === 'auto') {
    return (
      <li className="mx-auto flex max-w-[85%] items-start gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
        <Bot className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden />
        <span><span className="font-semibold">Automatic reply · </span>{m.text}</span>
      </li>
    );
  }
  const inbound = m.direction === 'INBOUND';
  return (
    <li className={cn('flex max-w-[85%] items-end gap-2', inbound ? 'self-start' : 'flex-row-reverse self-end')}>
      <Avatar name={inbound ? visitor : (m.sender?.name ?? 'Team')} color={inbound ? '#0d9488' : m.sender?.color} src={inbound ? null : m.sender?.avatarUrl} size="xs" className="mb-5 ring-0" />
      <div className={cn('min-w-0', !inbound && 'text-right')}>
        <div className={cn('inline-block max-w-full rounded-2xl px-3.5 py-2 text-left', inbound ? 'rounded-bl-md border border-slate-100 bg-card text-slate-800 shadow-soft' : 'rounded-br-md bg-primary text-white')}>
          {m.text && <MessageText text={m.text} linkClassName={inbound ? 'text-primary' : 'text-white'} />}
          <MessageFiles files={m.files} tone={inbound ? 'light' : 'dark'} />
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground" style={{justifyContent: inbound ? 'flex-start' : 'flex-end'}}>
          <Tooltip content={dateTime(m.createdAt)}><span>{inbound ? visitor : (m.sender?.name.split(' ')[0] ?? 'Team')} · {ago(m.createdAt)}</span></Tooltip>
          <Status m={m} />
          {m.emailed && <span className="inline-flex items-center gap-0.5"><Mail className="size-3" /> Emailed</span>}
        </p>
      </div>
    </li>
  );
}

/** An email on a chat conversation: the visitor's emailed answer as a bubble, our emails (replies sent while away, transcripts) as one line. */
function EmailItem({m, visitor}: {m: EmailMessage; visitor: string}) {
  const [open, setOpen] = useState(false);
  if (m.direction === 'INBOUND') {
    return (
      <li className="flex max-w-[85%] items-end gap-2 self-start">
        <Avatar name={visitor} color="#0d9488" size="xs" className="mb-5 ring-0" />
        <div className="min-w-0">
          <div className="rounded-2xl rounded-bl-md border border-slate-100 bg-card px-3.5 py-2 text-slate-800 shadow-soft"><MessageText text={firstPart(m.text ?? '') || '(empty email)'} linkClassName="text-primary" /></div>
          <p className="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground"><Mail className="size-3" /> {visitor} · by email · {ago(m.sentAt)}</p>
        </div>
      </li>
    );
  }
  return (
    <li className="px-1 text-xs text-slate-500">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2" aria-expanded={open}>
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
        <Mail className="size-3.5" /> Emailed to {m.to.join(', ')}: {m.subject}{m.status === 'FAILED' ? ' (not sent)' : ''} · {ago(m.sentAt)} <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
      </button>
      {open && <p className="mt-2 rounded-lg border border-slate-100 bg-card p-3 whitespace-pre-wrap text-slate-600">{m.text}</p>}
    </li>
  );
}

/**
 * The conversation as chat bubbles: chat messages, emails on the thread and
 * the team's comments / event lines (passed in as `extra`, already rendered).
 * New messages from the visitor are announced to screen readers.
 */
export function ChatTimeline({detail, extra}: {detail: ConversationDetail; extra: {at: string; key: string; node: ReactNode}[]}) {
  const chat = detail.chat!;
  const visitor = chat.visitor?.label ?? 'Visitor';
  const box = useRef<HTMLOListElement>(null);
  const items = useMemo(
    () =>
      [
        ...chat.messages.map((m) => ({at: m.createdAt, key: `cm${m.id}`, node: <Bubble key={`cm${m.id}`} m={m} visitor={visitor} />})),
        ...detail.messages.map((m) => ({at: m.sentAt, key: `em${m.id}`, node: <EmailItem key={`em${m.id}`} m={m} visitor={visitor} />})),
        ...extra,
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [chat.messages, detail.messages, extra, visitor],
  );
  const lastInbound = [...chat.messages].reverse().find((m) => m.direction === 'INBOUND');
  const [announce, setAnnounce] = useState('');
  const seen = useRef(lastInbound?.id);
  useEffect(() => {
    if (lastInbound && lastInbound.id !== seen.current) {
      seen.current = lastInbound.id;
      setAnnounce(`${visitor}: ${lastInbound.text}`);
    }
  }, [lastInbound, visitor]);

  // Stay at the bottom when new messages arrive, unless the agent scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length, chat.typing]);

  return (
    <>
      <ol
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-slate-50/50 p-4 scrollbar-thin"
        aria-label="Chat messages"
      >
        {items.map((i) => i.node)}
        {chat.typing && (
          <li className="flex items-center gap-2 self-start text-xs text-muted-foreground">
            <span className="flex gap-0.5 rounded-full bg-card px-3 py-2 shadow-soft" aria-hidden>
              {[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-slate-400" style={{animationDelay: `${d}ms`}} />)}
            </span>
            {visitor} is typing…
          </li>
        )}
      </ol>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </>
  );
}

type Pending = {id: string; name: string; size: number};

/**
 * Chat mode of the composer: plain text, saved replies, attachments, Enter to
 * send (Shift+Enter for a new line), Send & close; Comment mode is internal,
 * with @mentions, exactly like email conversations.
 */
export function ChatComposer({detail, mode, onMode, focusKey}: {detail: ConversationDetail; mode: ComposerMode; onMode: (m: ComposerMode) => void; focusKey: number}) {
  const t = detail.conversation;
  const visitor = detail.chat?.visitor ?? null;
  const canned = useCannedReplies();
  const [text, setText] = useState('');
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastPing = useRef(0);

  useEffect(() => {
    setText('');
    setComment('');
    setFiles([]);
  }, [t.id]);
  useEffect(() => {
    if (!focusKey) return;
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('textarea')?.focus());
  }, [focusKey, mode]);

  const send = useApiMutation((close: boolean) => api.post(`/inbox/conversations/${t.id}/chat`, {text, fileIds: files.map((f) => f.id), close}), {
    invalidate,
    onSuccess: () => {
      setText('');
      setFiles([]);
      lastPing.current = 0;
    },
  });
  const addComment = useApiMutation(() => api.post(`/inbox/conversations/${t.id}/comments`, {body: comment}), {invalidate, success: 'Comment added', onSuccess: () => setComment('')});

  // Typing indicator for the visitor: at most one ping every 4 seconds.
  const typing = (value: string) => {
    setText(value);
    if (value && Date.now() - lastPing.current > 4000) {
      lastPing.current = Date.now();
      api.post(`/inbox/conversations/${t.id}/typing`, {typing: true}).catch(() => null);
    }
  };

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of [...list].slice(0, 5 - files.length)) {
        if (f.size > 5 * 1024 * 1024) {
          toast.error(`${f.name} is larger than 5 MB`);
          continue;
        }
        const r = await uploadFile<{file: Pending}>('/inbox/chat/upload', f);
        setFiles((x) => [...x, r.file]);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  const ready = (text.trim() || files.length) && !send.isPending && !uploading;
  const submit = (close = false) => ready && send.mutate(close);
  const submitComment = () => comment.trim() && !addComment.isPending && addComment.mutate(undefined);
  const hint = !visitor
    ? null
    : visitor.online
      ? 'On the site now: replies show up in their chat'
      : visitor.email
        ? visitor.away
          ? `Left the site: replies they don't read are emailed to ${visitor.email}`
          : 'Not on the page right now'
        : 'Left the site without an email: they see replies when they come back';

  return (
    <Card className={cn('overflow-hidden', mode === 'comment' && 'ring-1 ring-amber-200')}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
        {([['reply', MessageCircle, 'Chat'], ['comment', StickyNote, 'Comment']] as const).map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => onMode(m)}
            aria-pressed={mode === m}
            className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors', mode === m ? (m === 'comment' ? 'bg-amber-50 text-amber-700' : 'bg-accent text-primary') : 'text-slate-500 hover:text-slate-800')}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {mode === 'comment' ? <span className="inline-flex items-center gap-1"><Lock className="size-3" /> Only your team sees comments · @ to mention</span> : hint}
        </span>
      </div>
      <div ref={box} className="grid gap-2.5 p-3">
        {mode === 'comment' ? (
          <MentionField
            aria-label="Comment"
            value={comment}
            onChange={setComment}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submitComment()}
            rows={3}
            placeholder="Share context with your team. Type @ to mention someone. The visitor never sees this."
            className="bg-amber-50/40"
          />
        ) : (
          <>
            <Textarea
              aria-label="Chat message"
              value={text}
              rows={3}
              maxLength={5000}
              placeholder="Write a message… Enter to send, Shift+Enter for a new line"
              onChange={(e) => typing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit(false);
                }
              }}
            />
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 py-1 pr-1 pl-2.5 text-xs font-medium text-slate-700">
                    <Paperclip className="size-3" /> <span className="max-w-40 truncate">{f.name}</span> <span className="text-muted-foreground">{fileSize(f.size)}</span>
                    <button type="button" className="cursor-pointer rounded p-0.5 text-slate-400 hover:text-destructive" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X className="size-3" /></button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'reply' && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="secondary" size="sm">Saved replies <ChevronDown /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
                  <DropdownMenuLabel>Insert a saved reply</DropdownMenuLabel>
                  {canned.data?.map((r) => (
                    <DropdownMenuItem key={r.id} onSelect={() => setText((x) => (x.trim() ? `${x.trimEnd()}\n${r.body}` : r.body))}>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{r.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{r.body}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {!canned.data?.length && <p className="px-2.5 py-2 text-sm text-muted-foreground">No saved replies yet (Settings → Tickets)</p>}
                </DropdownMenuContent>
              </DropdownMenu>
              <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => attach(e.target.files)} />
              <Tooltip content="Attach a file (up to 5 MB)">
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach a file" disabled={uploading || files.length >= 5} onClick={() => input.current?.click()}>
                  {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
                </Button>
              </Tooltip>
            </>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mode === 'comment' ? (
              <Button type="button" size="sm" onClick={submitComment} disabled={!comment.trim() || addComment.isPending}>
                {addComment.isPending ? <Loader2 className="animate-spin" /> : <StickyNote />} Add comment
              </Button>
            ) : (
              <>
                {t.status === 'OPEN' && <Button type="button" variant="secondary" size="sm" onClick={() => submit(true)} disabled={!ready}>Send & close</Button>}
                <Button type="button" size="sm" onClick={() => submit(false)} disabled={!ready}>{send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
