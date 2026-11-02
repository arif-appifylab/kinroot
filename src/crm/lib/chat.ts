/**
 * Website live chat (module 10b): shapes and pure helpers shared by the
 * server (src/server/inbox/chat.ts), the visitor widget
 * (src/components/chat/) and Settings → Inbox → Chat. Keep this file free of
 * React and server imports.
 *
 * A chat is an inbox conversation (EmailThread, channel "chat") whose
 * messages are ChannelMessage rows; the visitor is a ChannelIdentity. The
 * Any channel added later reuses the same message model.
 */
import {addDays, defaultAvailability, localDate, rangesOn, timeIn, zonedTime, type Availability} from '@/lib/scheduling';

export const REPLY_TIMES = {
  minutes: 'Typically replies in a few minutes',
  hour: 'Typically replies in under an hour',
  hours: 'Typically replies in a few hours',
  day: 'Typically replies within a day',
} as const;
export type ReplyTime = keyof typeof REPLY_TIMES;

export type PreChatMode = 'off' | 'optional' | 'required';

export type ChatSettings = {
  enabled: boolean;
  /** Shared mailbox that emails replies to visitors who left, and transcripts. null = the first shared mailbox. */
  accountId: string | null;
  /** Header title; empty = the brand name. */
  teamName: string;
  greeting: string;
  position: 'right' | 'left';
  /** Launcher and header colour; null = the brand colour from Settings → Branding. */
  color: string | null;
  /** Team members whose avatars show in the header (up to 3). */
  avatarIds: string[];
  replyTime: ReplyTime;
  /** Name / email form before the first message. */
  preChat: PreChatMode;
  askName: boolean;
  preChatIntro: string;
  /** Office hours; outside them (or when nobody is online) the widget shows "away". */
  hours: {enabled: boolean; timezone: string; availability: Availability};
  offlineMessage: string;
  /** A visitor not seen for this many minutes gets agent replies by email (when they gave one). */
  awayAfterMin: number;
  /** Sites allowed to embed the widget (hostnames; subdomains included). Empty = anywhere. */
  allowedDomains: string[];
  /** Kept from Kinroot's Turnstile option; not used (chats are rate limited per visitor and address). */
  spamCheck: boolean;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  enabled: false,
  accountId: null,
  teamName: '',
  greeting: 'Hi there! How can we help?',
  position: 'right',
  color: null,
  avatarIds: [],
  replyTime: 'minutes',
  preChat: 'off',
  askName: true,
  preChatIntro: 'Tell us how to reach you, in case we get disconnected.',
  hours: {enabled: false, timezone: 'UTC', availability: defaultAvailability()},
  offlineMessage: "We're away right now. Leave a message and your email, and we'll reply by email.",
  awayAfterMin: 5,
  allowedDomains: [],
  spamCheck: false,
};

/** Rate limits (DB-based, src/server/lib/rate-limit.ts). */
export const CHAT_LIMITS = {
  startsPerIpHour: 10,
  startsPerVisitorHour: 5,
  messagesPerVisitorMinute: 20,
  messagesPerIpMinute: 60,
  uploadsPerVisitorHour: 10,
  messageChars: 5000,
};

/** Agents seen within this window count as online (their inbox / app polls stamp `lastSeenAt`). */
export const ONLINE_MS = 5 * 60_000;

/** Is the office open at `ms`? Ranges are wall-clock times in `hours.timezone`; "24:00" ends the day. */
export function isOpenAt(hours: ChatSettings['hours'], ms: number) {
  if (!hours.enabled) return true;
  const tz = hours.timezone || 'UTC';
  const date = localDate(ms, tz);
  return rangesOn(hours.availability, date).some((r) => {
    const start = zonedTime(date, r.start, tz);
    const end = r.end === '24:00' ? zonedTime(addDays(date, 1), '00:00', tz) : zonedTime(date, r.end, tz);
    return ms >= start && ms < end;
  });
}

/** Next opening time after `ms` within a week, or null. */
export function nextOpening(hours: ChatSettings['hours'], ms: number) {
  if (!hours.enabled) return null;
  const tz = hours.timezone || 'UTC';
  for (let i = 0; i < 8; i++) {
    const date = addDays(localDate(ms, tz), i);
    for (const r of [...rangesOn(hours.availability, date)].sort((a, b) => a.start.localeCompare(b.start))) {
      const start = zonedTime(date, r.start, tz);
      if (start > ms) return start;
    }
  }
  return null;
}

/** "Berlin, Europe" from "Europe/Berlin" (the widget only knows the visitor's time zone). */
export function tzLocation(tz: string | null | undefined) {
  if (!tz || !tz.includes('/')) return tz || null;
  const parts = tz.split('/');
  const city = parts.at(-1)!.replace(/_/g, ' ');
  return `${city}, ${parts[0]!.replace(/_/g, ' ')}`;
}

/** The visitor's local time now, e.g. "3:42 PM". */
export const visitorTime = (tz: string | null | undefined) => {
  try {
    return tz ? timeIn(Date.now(), tz) : null;
  } catch {
    return null;
  }
};

/** Is `host` (a hostname) on the allow-list? "example.com" also allows "www.example.com" and "shop.example.com". */
export function hostAllowed(allowed: string[], host: string | null | undefined) {
  if (!allowed.length) return true;
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  return allowed.some((d) => {
    const a = d.toLowerCase().replace(/^www\./, '');
    return h === a || h.endsWith(`.${a}`);
  });
}

export const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

/**
 * Plain text → text and link segments, for rendering visitor and agent
 * messages without HTML. Only http(s) and www. links become links.
 */
export type TextPart = {text: string; href?: string};
export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  const re = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let url = m[1]!;
    // Trailing punctuation belongs to the sentence, not the link.
    const trail = url.match(/[.,;:!?)\]}'"]+$/)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    const at = m.index!;
    if (at > last) out.push({text: text.slice(last, at)});
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
      const u = new URL(href);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push({text: url, href: u.toString()});
      else out.push({text: url});
    } catch {
      out.push({text: url});
    }
    last = at + url.length;
  }
  if (last < text.length) out.push({text: text.slice(last)});
  return out;
}

// ─── What the visitor's browser gets ───

export type PublicChatConfig = {
  enabled: boolean;
  /** False when the embedding site is not on the allow-list. */
  allowed: boolean;
  teamName: string;
  greeting: string;
  position: 'right' | 'left';
  color: string;
  logo: string | null;
  avatars: {name: string; color: string; avatarUrl?: string | null}[];
  replyTime: string;
  preChat: PreChatMode;
  askName: boolean;
  preChatIntro: string;
  away: boolean;
  awayReason: 'hours' | 'nobody' | null;
  offlineMessage: string;
  /** ISO time the office opens next (outside office hours). */
  opensAt: string | null;
};

export type VisitorFile = {id: string; name: string; size: number; mimeType: string; image: boolean; url: string};

export type VisitorMessage = {
  id: string;
  from: 'visitor' | 'team' | 'system';
  /** Team member's first name and colour. */
  author: {name: string; color: string; avatarUrl?: string | null} | null;
  text: string;
  files: VisitorFile[];
  at: string;
  /** The visitor's message was read by the team. */
  seen: boolean;
  /** Came in (or went out) by email instead of the widget. */
  via: 'email' | null;
};

export type VisitorConversation = {
  id: string;
  status: 'OPEN' | 'CLOSED';
  messages: VisitorMessage[];
  teamTyping: boolean;
};

export type VisitorSession = {
  token: string;
  name: string | null;
  email: string | null;
  conversation: VisitorConversation | null;
};

/** Image types shown as thumbnails; everything else (SVG, HTML…) is a download link. */
export const INLINE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** What a visitor may attach. */
export const CHAT_UPLOAD_TYPES =
  /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/(pdf|msword|zip|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-[a-z.]+|vnd\.oasis\.opendocument\.[a-z.]+|rtf)|text\/(plain|csv))$/;

/** Accessible label for a message author in the transcript / aria-live region. */
export const speaker = (m: Pick<VisitorMessage, 'from' | 'author'>) => (m.from === 'visitor' ? 'You' : m.from === 'system' ? 'Automatic message' : (m.author?.name ?? 'Team'));
