import {useCallback, useEffect, useRef, useState} from 'react';

import type {PublicChatConfig, VisitorConversation, VisitorMessage, VisitorSession} from '@/lib/chat';
import {siteFetch} from '../../../platform/browser';
import {putFile, type UploadGrant} from '../../../platform/files-browser';

/**
 * The visitor's side of website chat: config, the signed visitor token
 * (localStorage on our origin, shared by the embedded iframe and the in-app
 * <ChatWidget>), sending, uploads and polling.
 *
 * Polling (no websockets on this stack): every 3 s while the panel is open,
 * the page visible and the visitor active in the last 2 minutes; every 10 s
 * when open but idle; every 30 s while the panel is closed (for the unread
 * badge); paused while the page is hidden. Errors back off up to a minute.
 */

const STORE = 'crm-chat.v1';
const readToken = () => {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
};
const writeToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(STORE, t);
    else localStorage.removeItem(STORE);
  } catch {
    // private mode / blocked storage: the chat still works for this page view
  }
};

export class ChatError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Not the app's `api` client: a visitor is never sent to sign in. `siteFetch` carries the site's
 * CSRF token, which every write to the Site API needs (the visitor's chat runs on this site).
 */
async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await siteFetch(`/site-api/crm/public/chat${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const data = (await res.json().catch(() => ({}))) as {error?: string};
  if (!res.ok) throw new ChatError(data.error ?? `Something went wrong (${res.status})`, res.status);
  return data as T;
}

export type PageMeta = {page: string | null; title: string | null; referrer: string | null; ancestor: string | null};

const utmOf = (page: string | null) => {
  try {
    const q = new URL(page ?? '').searchParams;
    return Object.fromEntries([...q.entries()].filter(([k]) => /^utm_(source|medium|campaign|term|content)$/.test(k)).map(([k, v]) => [k, v.slice(0, 200)]));
  } catch {
    return {};
  }
};

export type UploadedFile = {id: string; name: string; size: number; mimeType: string; token: string};

export type ChatState = {
  config: PublicChatConfig | null;
  loading: boolean;
  session: Omit<VisitorSession, 'conversation'> | null;
  conversation: VisitorConversation | null;
  error: string | null;
  sending: boolean;
  unread: number;
  start: (input: {text: string; files: UploadedFile[]; name?: string; email?: string; hp?: string; startedAt?: number}) => Promise<boolean>;
  send: (text: string, files: UploadedFile[]) => Promise<boolean>;
  upload: (file: File) => Promise<UploadedFile | null>;
  identify: (input: {name?: string; email: string}) => Promise<boolean>;
  typing: () => void;
  clearError: () => void;
};

const merge = (a: VisitorMessage[], b: VisitorMessage[]) => {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at));
};

export function useVisitorChat({meta, open, continueToken}: {meta: PageMeta; open: boolean; continueToken?: string}): ChatState {
  const [config, setConfig] = useState<PublicChatConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<ChatState['session']>(null);
  const [conversation, setConversation] = useState<VisitorConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const lastActive = useRef(Date.now());
  const typingAt = useRef(0);
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const tokenRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const body = useCallback(() => ({meta: {...metaRef.current, utm: utmOf(metaRef.current.page), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}}), []);

  const adopt = useCallback((s: VisitorSession | null) => {
    if (!s) {
      tokenRef.current = null;
      writeToken(null);
      setSession(null);
      setConversation(null);
      return;
    }
    tokenRef.current = s.token;
    writeToken(s.token);
    setSession({token: s.token, name: s.name, email: s.email});
    if (s.conversation) setConversation(s.conversation);
  }, []);

  const expired = useCallback(
    (e: unknown) => {
      if (e instanceof ChatError && e.status === 401) {
        adopt(null);
        return true;
      }
      return false;
    },
    [adopt],
  );

  // Config, then the returning visitor's session (or the conversation from an email link).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const {config: cfg} = await call<{config: PublicChatConfig}>('/config', body());
        if (!live) return;
        setConfig(cfg);
        if (cfg.enabled && cfg.allowed) {
          if (continueToken) {
            const r = await call<{session: VisitorSession}>('/continue', {token: continueToken});
            if (live) adopt(r.session);
          } else if (readToken()) {
            const r = await call<{session: VisitorSession | null}>('/session', {...body(), token: readToken()}).catch((e) => (expired(e) ? {session: null} : Promise.reject(e)));
            if (live) adopt(r.session);
          }
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [adopt, body, continueToken, expired]);

  // Activity (typing, moving the mouse in the panel) keeps the fast rhythm.
  useEffect(() => {
    const mark = () => (lastActive.current = Date.now());
    window.addEventListener('keydown', mark);
    window.addEventListener('pointerdown', mark);
    window.addEventListener('focus', mark);
    return () => {
      window.removeEventListener('keydown', mark);
      window.removeEventListener('pointerdown', mark);
      window.removeEventListener('focus', mark);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    lastActive.current = Date.now();
    if (document.visibilityState === 'visible') setUnread(0);
  }, [open]);

  // The polling loop.
  const conversationId = conversation?.id ?? null;
  useEffect(() => {
    if (!conversationId || !session) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const delay = () => {
      if (failures) return Math.min(60_000, 3000 * 2 ** failures);
      if (!openRef.current) return 30_000;
      return Date.now() - lastActive.current < 120_000 ? 3000 : 10_000;
    };
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState !== 'visible') return; // resumes on visibilitychange
      const conv = convRef.current;
      const after = conv?.messages.at(-1)?.at ?? null;
      const visible = openRef.current && document.visibilityState === 'visible';
      try {
        const r = await call<{conversation: (VisitorConversation & {seenUpTo: string | null}) | null; away: boolean}>('/poll', {
          ...body(),
          token: tokenRef.current,
          conversationId,
          after,
          typing: Date.now() - typingAt.current < 5000,
          visible,
        });
        failures = 0;
        setConfig((c) => (c && c.away !== r.away ? {...c, away: r.away} : c));
        if (r.conversation) {
          const fresh = r.conversation;
          const fromTeam = fresh.messages.filter((m) => m.from !== 'visitor' && !conv?.messages.some((x) => x.id === m.id)).length;
          if (fromTeam && !visible) setUnread((n) => n + fromTeam);
          setConversation((prev) => {
            const messages = merge(prev?.messages ?? [], fresh.messages).map((m) => (m.from === 'visitor' && fresh.seenUpTo && m.at <= fresh.seenUpTo ? {...m, seen: true} : m));
            return {id: fresh.id, status: fresh.status, teamTyping: fresh.teamTyping, messages};
          });
        }
      } catch (e) {
        if (expired(e)) return;
        failures++;
      }
      if (!stop) timer = setTimeout(tick, delay());
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        lastActive.current = Date.now();
        if (openRef.current) setUnread(0);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Opening the panel restarts the loop, so it polls right away at the fast rhythm.
  }, [body, conversationId, expired, session, open]);

  const start: ChatState['start'] = async (input) => {
    setSending(true);
    setError(null);
    try {
      const r = await call<{session: VisitorSession}>('/start', {...body(), token: tokenRef.current, text: input.text, files: input.files.map((f) => ({id: f.id, token: f.token})), name: input.name || null, email: input.email || null, hp: input.hp, startedAt: input.startedAt});
      adopt(r.session);
      return true;
    } catch (e) {
      if (!expired(e)) setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  };

  const send: ChatState['send'] = async (text, files) => {
    if (!convRef.current) return start({text, files});
    setSending(true);
    setError(null);
    try {
      const r = await call<{conversation: VisitorConversation}>('/messages', {...body(), token: tokenRef.current, conversationId: convRef.current.id, text, files: files.map((f) => ({id: f.id, token: f.token}))});
      setConversation((prev) => (prev ? {...prev, status: 'OPEN', messages: merge(prev.messages, r.conversation.messages)} : r.conversation));
      typingAt.current = 0;
      return true;
    } catch (e) {
      if (!expired(e)) setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  };

  const upload: ChatState['upload'] = async (file) => {
    if (file.size > 5 * 1024 * 1024) {
      setError(`${file.name} is larger than 5 MB`);
      return null;
    }
    try {
      // Storage takes the bytes directly (docs/agent/files.md): ask, PUT, confirm.
      const r = await call<{fileId: string; upload: UploadGrant['upload']; file: UploadedFile; token: string}>('/upload', {
        name: file.name,
        contentType: file.type,
        size: file.size,
        token: tokenRef.current,
        page: metaRef.current.page,
        ancestor: metaRef.current.ancestor,
      });
      const put = await putFile(r.upload, file);
      if (!put.ok) throw new ChatError(put.message, put.status);
      await call(`/upload/${r.fileId}/complete`, {});
      if (!tokenRef.current) {
        tokenRef.current = r.token;
        writeToken(r.token);
      }
      return r.file;
    } catch (e) {
      if (!expired(e)) setError((e as Error).message);
      return null;
    }
  };

  const identify: ChatState['identify'] = async (input) => {
    if (!tokenRef.current) {
      setSession((s) => ({token: s?.token ?? '', name: input.name ?? s?.name ?? null, email: input.email}));
      return true;
    }
    try {
      const r = await call<{session: VisitorSession}>('/identify', {...body(), token: tokenRef.current, ...input});
      adopt(r.session);
      return true;
    } catch (e) {
      if (!expired(e)) setError((e as Error).message);
      return false;
    }
  };

  return {
    config,
    loading,
    session,
    conversation,
    error,
    sending,
    unread,
    start,
    send,
    upload,
    identify,
    typing: () => {
      typingAt.current = Date.now();
      lastActive.current = Date.now();
    },
    clearError: () => setError(null),
  };
}
