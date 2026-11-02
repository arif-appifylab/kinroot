/**
 * Shared inbox (module 10): shapes and catalogues used by the server
 * (src/server/inbox/) and the inbox page. A conversation is an EmailThread
 * with at least one message from outside the team (`firstInboundAt`).
 *
 * Channels are strings on `EmailThread.channel`, so a new one (e.g. website
 * chat) is a new entry here plus its ingest path; see AGENTS.md.
 */

/** Channels that show in the inbox. Ticket threads (`channel: 'ticket'`) are worked from their ticket. */
export const INBOX_CHANNELS = {
  email: {label: 'Email'},
  form: {label: 'Forms'},
  chat: {label: 'Chat'},
} as const;

/**
 * Channels whose messages are ChannelMessage rows (not EmailMessage) and whose
 * conversations always belong to the team inbox. New channels join this list.
 */
export const MESSAGE_CHANNELS = ['chat'] as const;
export const isMessageChannel = (channel: string) => (MESSAGE_CHANNELS as readonly string[]).includes(channel);

export type InboxChannel = keyof typeof INBOX_CHANNELS;
export const CHANNEL_KEYS = Object.keys(INBOX_CHANNELS) as InboxChannel[];

/** Left navigation: views (status-based), channels (where it came in) and folders. */
export const INBOX_VIEWS = {
  unassigned: 'Unassigned',
  mine: 'Assigned to me',
  open: 'All open',
  snoozed: 'Snoozed',
  closed: 'Closed',
} as const;

export const INBOX_FOLDERS = {
  sent: 'Sent',
  spam: 'Spam',
  trash: 'Trash',
} as const;

export type InboxView = keyof typeof INBOX_VIEWS | keyof typeof INBOX_FOLDERS;
export const VIEW_KEYS = [...Object.keys(INBOX_VIEWS), ...Object.keys(INBOX_FOLDERS)] as InboxView[];

/** Channel filters in the left navigation: the team inbox, the viewer's own mailboxes, form responses. */
export const CHANNEL_FILTERS = {
  team: 'Team email',
  personal: 'My email',
  form: 'Forms',
  chat: 'Chat',
} as const;
export type ChannelFilter = keyof typeof CHANNEL_FILTERS;

export const INBOX_SORTS = {
  newest: 'Newest',
  oldest: 'Oldest',
  waiting: 'Waiting longest',
} as const;
export type InboxSort = keyof typeof INBOX_SORTS;

export const BULK_ACTIONS = ['assign', 'close', 'reopen', 'read', 'unread', 'snooze', 'unsnooze', 'spam', 'not_spam', 'trash', 'restore', 'delete'] as const;
/** "Spam & block": the sender's address, their domain, or (chat) the visitor. */
export const BLOCK_KINDS = ['address', 'domain', 'visitor'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** Trashed conversations move to the recycle bin after this many days. */
export const TRASH_DAYS = 30;

export type InboxSettings = {
  /** Shared accounts whose mail feeds the team inbox; 'all' = every shared account (the default). */
  teamAccounts: 'all' | string[];
  /** Who works the team inbox besides admins: everyone, or the chosen members. */
  access: 'everyone' | 'members';
  memberIds: string[];
  /** Members see every team conversation, or only theirs and unassigned ones. Admins always see all. */
  visibility: 'all' | 'mine_and_unassigned';
  /** New inbound team conversations: left unassigned, or shared round robin among `roundRobinIds`. */
  assignment: 'manual' | 'round_robin';
  roundRobinIds: string[];
  /** A reply keeps the conversation with its current assignee; off: a reply to a closed one goes back to the queue. */
  autoAssignReplies: boolean;
  /** Close open conversations after this many days without a reply from the contact (null = off). */
  autoCloseDays: number | null;
  /** Mail from these addresses / domains goes straight to Spam. */
  blockedAddresses: string[];
  blockedDomains: string[];
};

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  teamAccounts: 'all',
  access: 'everyone',
  memberIds: [],
  visibility: 'all',
  assignment: 'manual',
  roundRobinIds: [],
  autoAssignReplies: true,
  autoCloseDays: null,
  blockedAddresses: [],
  blockedDomains: [],
};

/** Keyboard shortcuts on the inbox page (shown in the help popover). */
export const INBOX_SHORTCUTS = [
  ['j', 'Next conversation'],
  ['k', 'Previous conversation'],
  ['r', 'Reply'],
  ['c', 'Comment'],
  ['a', 'Assign'],
  ['e', 'Close / reopen'],
  ['?', 'Show shortcuts'],
] as const;

export const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? '';
