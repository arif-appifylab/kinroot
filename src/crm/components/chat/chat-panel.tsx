import {Check, CheckCheck, Loader2, Mail, Paperclip, Send, X} from 'lucide-react';
import {useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent} from 'react';

import {speaker, type VisitorMessage} from '@/lib/chat';
import {cn} from '@/lib/utils';

import {is, useFormState} from '../ui/form-state';

import {fileSize, MessageFiles, MessageText} from './message-text';
import type {ChatState, UploadedFile} from './use-chat';

/**
 * The visitor's chat panel: header (brand colour, team, availability),
 * messages, the optional pre-chat form, the "leave your email" prompt while
 * the team is away, and the composer. Used by the chat window the website
 * snippet opens (/chat/), the in-app <ChatWidget>, the email link page (/chat/c/…)
 * and the live preview in Settings → Inbox → Chat. Always light; messages are
 * plain text with safe links. `trap` keeps keyboard focus inside the panel.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const fieldClass = 'h-9 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[var(--chat)] focus:ring-2 focus:ring-[var(--chat)]/20 aria-invalid:border-rose-500';
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});

function Initials({name, color, src, size = 28}: {name: string; color: string; src?: string | null; size?: number}) {
  if (src) return <img src={src} alt="" aria-hidden className="shrink-0 rounded-full object-cover ring-2 ring-white" style={{width: size, height: size}} />;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-white" style={{width: size, height: size, background: color, fontSize: size * 0.4}} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Bubble({m, color, last}: {m: VisitorMessage; color: string; last: boolean}) {
  if (m.from === 'system') {
    return <li className="mx-2 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-slate-600"><span className="sr-only">Automatic message: </span>{m.text}</li>;
  }
  const mine = m.from === 'visitor';
  return (
    <li className={cn('flex max-w-[85%] flex-col', mine ? 'items-end self-end' : 'items-start self-start')}>
      {!mine && m.author && <span className="mb-0.5 px-1 text-[11px] font-semibold text-slate-500">{m.author.name}</span>}
      <div className={cn('max-w-full rounded-2xl px-3.5 py-2', mine ? 'rounded-br-md text-white' : 'rounded-bl-md bg-slate-100 text-slate-800')} style={mine ? {background: color} : undefined}>
        <span className="sr-only">{speaker(m)}: </span>
        {m.text && <MessageText text={m.text} linkClassName={mine ? 'text-white' : 'text-slate-900'} />}
        <MessageFiles files={m.files} tone={mine ? 'dark' : 'light'} />
      </div>
      <span className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-slate-400">
        {m.via === 'email' && <Mail className="size-3" aria-label="by email" />}
        {time(m.at)}
        {mine && last && (m.seen ? <span className="inline-flex items-center gap-0.5"><CheckCheck className="size-3" /> Seen</span> : <Check className="size-3" aria-label="Sent" />)}
      </span>
    </li>
  );
}

export function ChatPanel({chat, onClose, trap, preview, className}: {chat: ChatState; onClose?: () => void; trap?: boolean; preview?: boolean; className?: string}) {
  const cfg = chat.config;
  const color = cfg?.color || '#2563eb';
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [awayEmail, setAwayEmail] = useState('');
  const [hp, setHp] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const uid = useId();
  const startedAt = useRef(Date.now());
  const conv = chat.conversation;
  const messages = conv?.messages ?? [];
  const known = chat.session?.email;
  const preChat = !conv && cfg && cfg.preChat !== 'off' && !known;
  // The pre-chat details and the "reply by email" address: errors under the fields, never browser popups.
  const details = useFormState(
    {name, email},
    preChat
      ? {
          name: [is.maxLength(120)],
          email: [...(cfg?.preChat === 'required' ? [is.required('Enter your email so we can reply.')] : []), is.email('Enter a valid email, like you@example.com.'), is.maxLength(200)],
        }
      : {},
  );
  const away = useFormState({awayEmail}, {awayEmail: [is.required('Enter your email to get the reply.'), is.email('Enter a valid email, like you@example.com.')]});
  const lastMine = [...messages].reverse().find((m) => m.from === 'visitor')?.id;

  // Newest message in view; new ones are announced by the log's aria-live.
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length, conv?.teamTyping]);

  useEffect(() => {
    if (!preview) input.current?.focus({preventScroll: true});
  }, [preview]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      onClose();
      return;
    }
    if (!trap || e.key !== 'Tab' || !root.current) return;
    const els = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0]!;
    const last = els.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  async function attach(list: FileList | null) {
    if (!list?.length || preview) return;
    setUploading(true);
    for (const f of [...list].slice(0, 5 - files.length)) {
      const up = await chat.upload(f);
      if (up) setFiles((x) => [...x, up]);
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  const canSend = !preview && !chat.sending && !uploading && (!!text.trim() || files.length > 0);
  const send = details.submit(() => void submit());
  async function submit() {
    if (!canSend) return;
    const ok = conv
      ? await chat.send(text.trim(), files)
      : await chat.start({text: text.trim(), files, name: preChat ? name : undefined, email: preChat && emailOk(email) ? email : undefined, hp, startedAt: startedAt.current});
    if (ok) {
      setText('');
      setFiles([]);
      input.current?.focus();
    }
  }

  const status = !cfg ? '' : cfg.away ? (cfg.awayReason === 'hours' && cfg.opensAt ? `We're away · back ${new Date(cfg.opensAt).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'})}` : "We're away right now") : cfg.replyTime;

  if (!cfg && chat.loading) {
    return <div className={cn('light-scope flex h-full items-center justify-center bg-white text-slate-400', className)}><Loader2 className="size-5 animate-spin" aria-label="Loading chat" /></div>;
  }
  if (!cfg || !cfg.enabled || !cfg.allowed) {
    return (
      <div className={cn('light-scope flex h-full flex-col items-center justify-center gap-2 bg-white p-6 text-center', className)}>
        <p className="text-sm font-semibold text-slate-800">Chat is not available right now</p>
        {chat.error && <p className="text-xs text-slate-500">{chat.error}</p>}
      </div>
    );
  }

  return (
    <div ref={root} onKeyDown={onKeyDown} role={onClose ? "dialog" : "region"} aria-label={`Chat with ${cfg.teamName}`} className={cn('light-scope flex h-full min-h-0 flex-col overflow-hidden bg-white text-slate-900 [color-scheme:light]', className)} style={{'--chat': color} as CSSProperties}>
      <header className="flex items-center gap-3 px-4 py-3.5 text-white" style={{background: color}}>
        {cfg.avatars.length ? (
          <span className="flex -space-x-2">{cfg.avatars.map((a) => <Initials key={a.name} name={a.name} color={a.color} src={a.avatarUrl} size={32} />)}</span>
        ) : cfg.logo ? (
          <img src={cfg.logo} alt="" className="size-8 rounded-full bg-white object-contain p-0.5" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold">{cfg.teamName}</h2>
          <p className="flex items-center gap-1.5 truncate text-xs text-white/85">
            <span className={cn('size-2 shrink-0 rounded-full', cfg.away ? 'bg-amber-300' : 'bg-green-300')} aria-hidden />
            {status}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="cursor-pointer rounded-full p-1.5 text-white/90 hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none" aria-label="Close chat">
            <X className="size-5" />
          </button>
        )}
      </header>

      <ol ref={list} role="log" aria-live="polite" aria-label="Messages" className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-4">
        <li className="flex max-w-[85%] flex-col items-start self-start">
          <div className="rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2 text-slate-800"><MessageText text={cfg.greeting} /></div>
        </li>
        {cfg.away && !conv && <li className="mx-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">{cfg.offlineMessage}</li>}
        {messages.map((m) => <Bubble key={m.id} m={m} color={color} last={m.id === lastMine} />)}
        {conv?.teamTyping && (
          <li className="flex items-center gap-1 self-start rounded-full bg-slate-100 px-3 py-2.5" aria-label="Typing">
            {[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-slate-400" style={{animationDelay: `${d}ms`}} />)}
          </li>
        )}
        {conv?.status === 'CLOSED' && <li className="mx-2 text-center text-xs text-slate-400">This conversation was closed. Write again any time to reopen it.</li>}
      </ol>

      {/* Away, and we don't know how to reach them: ask for an email. */}
      {conv && cfg.away && !known && (
        <form
          className="mx-3 mb-2 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3"
          {...away.form(async () => {
            if (savingEmail) return;
            setSavingEmail(true);
            try {
              await chat.identify({email: awayEmail.trim()});
            } finally {
              setSavingEmail(false);
            }
          })}
        >
          <label htmlFor={`${uid}-away-email`} className="text-xs font-semibold text-slate-700">Get the reply by email</label>
          <div className="flex gap-2">
            <input
              id={`${uid}-away-email`}
              type="email"
              autoComplete="email"
              value={awayEmail}
              onChange={(e) => setAwayEmail(e.target.value)}
              onBlur={away.blur('awayEmail')}
              aria-invalid={away.invalid('awayEmail') || undefined}
              aria-describedby={away.invalid('awayEmail') ? `${uid}-away-email-error` : undefined}
              placeholder="you@example.com"
              className={cn(fieldClass, 'min-w-0 flex-1 bg-white')}
            />
            <button type="submit" className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{background: color}} disabled={savingEmail} aria-busy={savingEmail || undefined}>
              {savingEmail && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {savingEmail ? 'Saving…' : 'Save'}
            </button>
          </div>
          {away.error('awayEmail') && <p id={`${uid}-away-email-error`} role="alert" className="text-xs font-medium text-rose-700">{away.error('awayEmail')}</p>}
        </form>
      )}
      {conv && known && cfg.away && <p className="mx-3 mb-2 text-center text-[11px] text-slate-500">We'll reply to {known} if you've left by then.</p>}

      <form ref={details.ref} noValidate className="border-t border-slate-100 p-3" onSubmit={send}>
        {preChat && (
          <div className="mb-2.5 grid gap-2">
            {cfg.preChatIntro && <p className="text-xs text-slate-500">{cfg.preChatIntro}</p>}
            {cfg.askName && (
              <div className="grid gap-1">
                <label htmlFor={`${uid}-name`} className="text-xs font-semibold text-slate-700">Your name</label>
                <input
                  id={`${uid}-name`}
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={details.blur('name')}
                  aria-invalid={details.invalid('name') || undefined}
                  aria-describedby={details.invalid('name') ? `${uid}-name-error` : undefined}
                  placeholder="Jane Doe"
                  maxLength={120}
                  className={fieldClass}
                />
                {details.error('name') && <p id={`${uid}-name-error`} role="alert" className="text-xs font-medium text-rose-700">{details.error('name')}</p>}
              </div>
            )}
            <div className="grid gap-1">
              <label htmlFor={`${uid}-email`} className="text-xs font-semibold text-slate-700">{cfg.preChat === 'required' ? 'Your email' : 'Your email (optional)'}</label>
              <input
                id={`${uid}-email`}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={details.blur('email')}
                aria-invalid={details.invalid('email') || undefined}
                aria-describedby={details.invalid('email') ? `${uid}-email-error` : undefined}
                placeholder="you@example.com"
                maxLength={200}
                className={fieldClass}
              />
              {details.error('email') && <p id={`${uid}-email-error`} role="alert" className="text-xs font-medium text-rose-700">{details.error('email')}</p>}
            </div>
          </div>
        )}
        {files.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-1 rounded-lg bg-slate-100 py-1 pr-1 pl-2 text-xs text-slate-700">
                <span className="max-w-36 truncate">{f.name}</span> <span className="text-slate-400">{fileSize(f.size)}</span>
                <button type="button" className="cursor-pointer rounded p-0.5 text-slate-400 hover:text-rose-600" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X className="size-3" /></button>
              </li>
            ))}
          </ul>
        )}
        {chat.error && (
          <p role="alert" className="mb-2 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
            <span className="flex-1">{chat.error}</span>
            <button type="button" onClick={chat.clearError} aria-label="Dismiss" className="cursor-pointer"><X className="size-3.5" /></button>
          </p>
        )}
        {/* Honeypot: hidden from people, filled by bots. */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden value={hp} onChange={(e) => setHp(e.target.value)} className="absolute -left-[9999px] h-0 w-0 opacity-0" />
        <div className="flex items-end gap-1.5 rounded-xl border border-slate-300 bg-white p-1.5 focus-within:border-[var(--chat)] focus-within:ring-2 focus-within:ring-[var(--chat)]/20">
          <label htmlFor="chat-message" className="sr-only">Message</label>
          <textarea
            ref={input}
            id="chat-message"
            rows={1}
            value={text}
            maxLength={5000}
            disabled={preview}
            placeholder={conv ? 'Write a message…' : 'Ask us anything…'}
            onChange={(e) => {
              setText(e.target.value);
              chat.typing();
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="max-h-[120px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none placeholder:text-slate-400"
          />
          <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => attach(e.target.files)} accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.txt,.csv,.zip" />
          <button type="button" disabled={preview || uploading || files.length >= 5} aria-busy={uploading || undefined} onClick={() => fileInput.current?.click()} className="cursor-pointer rounded-lg p-2 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-[var(--chat)]/30 disabled:cursor-not-allowed disabled:opacity-50" aria-label={uploading ? 'Uploading…' : 'Attach a file (up to 5 MB)'}>
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </button>
          <button type="submit" disabled={!canSend} aria-busy={chat.sending || undefined} className="cursor-pointer rounded-lg p-2 text-white transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat)]/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40" style={{background: color}} aria-label={chat.sending ? 'Sending…' : 'Send'}>
            {chat.sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-slate-400">Enter to send · Shift+Enter for a new line</p>
      </form>
    </div>
  );
}
