// Ticket labels, settings shape and SLA helpers, shared by the server and the UI.

export type TicketStatus = 'NEW' | 'WAITING_ON_CONTACT' | 'WAITING_ON_US' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TicketSource = 'EMAIL' | 'FORM' | 'PORTAL' | 'MANUAL' | 'WEBHOOK' | 'API';

type Tone = 'neutral' | 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'violet';

/** Pipeline order. Resolved and closed tickets are "done"; everything else is open. */
export const TICKET_STATUSES: {value: TicketStatus; label: string; customer: string; tone: Tone; color: string}[] = [
  {value: 'NEW', label: 'New', customer: 'Received', tone: 'blue', color: '#2563eb'},
  {value: 'WAITING_ON_CONTACT', label: 'Waiting on contact', customer: 'Waiting for your reply', tone: 'amber', color: '#d97706'},
  {value: 'WAITING_ON_US', label: 'Waiting on us', customer: 'In progress', tone: 'violet', color: '#7c3aed'},
  {value: 'RESOLVED', label: 'Resolved', customer: 'Resolved', tone: 'green', color: '#16a34a'},
  {value: 'CLOSED', label: 'Closed', customer: 'Closed', tone: 'neutral', color: '#64748b'},
];
export const STATUS = Object.fromEntries(TICKET_STATUSES.map((s) => [s.value, s])) as Record<TicketStatus, (typeof TICKET_STATUSES)[number]>;
export const OPEN_STATUSES: TicketStatus[] = ['NEW', 'WAITING_ON_CONTACT', 'WAITING_ON_US'];
export const isOpenStatus = (s: TicketStatus) => OPEN_STATUSES.includes(s);

export const TICKET_PRIORITIES: {value: TicketPriority; label: string; tone: Tone; dot: string}[] = [
  {value: 'LOW', label: 'Low', tone: 'neutral', dot: 'bg-sky-400'},
  {value: 'NORMAL', label: 'Normal', tone: 'blue', dot: 'bg-blue-500'},
  {value: 'HIGH', label: 'High', tone: 'amber', dot: 'bg-amber-500'},
  {value: 'URGENT', label: 'Urgent', tone: 'rose', dot: 'bg-rose-500'},
];
export const PRIORITY = Object.fromEntries(TICKET_PRIORITIES.map((p) => [p.value, p])) as Record<TicketPriority, (typeof TICKET_PRIORITIES)[number]>;

export const SOURCE_LABELS: Record<TicketSource, string> = {EMAIL: 'Email', FORM: 'Form', PORTAL: 'Portal', MANUAL: 'Manual', WEBHOOK: 'Incoming webhook', API: 'Data in API'};

export const ticketRef = (n: number) => `#${n}`;
/** Goes into every outgoing subject so replies thread back even without reply headers. */
export const subjectToken = (n: number) => `[#${n}]`;
export const SUBJECT_TOKEN = /\[#(\d{1,9})\]/;

// ─── Settings (Setting row "tickets") ───────────────────────────────────────

export type SlaTarget = {firstResponseMins: number | null; resolutionMins: number | null};

export type BusinessHours = {
  enabled: boolean;
  /** IANA zone the hours are in, e.g. "Europe/Berlin". */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  start: string; // "09:00"
  end: string; // "17:00"
};

export type TicketSettings = {
  /** Mail to this address (inbound webhook or a synced mailbox) becomes a ticket. */
  supportEmail: string;
  /** Account replies are sent from; '' picks the account for supportEmail, else the default shared one. */
  replyAccountId: string;
  categories: string[];
  queues: string[];
  /** Notified about new unassigned tickets (and SLA breaches on them). Empty = admins. */
  notifyUserIds: string[];
  sla: {enabled: boolean; businessHours: BusinessHours; targets: Record<TicketPriority, SlaTarget>};
  portalEnabled: boolean;
  /** Shown on the /support page. */
  portalIntro: string;
  csatEnabled: boolean;
};

export const defaultTicketSettings = (): TicketSettings => ({
  supportEmail: '',
  replyAccountId: '',
  categories: ['Question', 'Problem', 'Billing', 'Feature request', 'Account'],
  queues: ['Support', 'Billing', 'Technical'],
  notifyUserIds: [],
  sla: {
    enabled: true,
    businessHours: {enabled: false, timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00'},
    targets: {
      URGENT: {firstResponseMins: 60, resolutionMins: 8 * 60},
      HIGH: {firstResponseMins: 4 * 60, resolutionMins: 24 * 60},
      NORMAL: {firstResponseMins: 8 * 60, resolutionMins: 3 * 24 * 60},
      LOW: {firstResponseMins: 24 * 60, resolutionMins: 5 * 24 * 60},
    },
  },
  portalEnabled: true,
  portalIntro: 'Tell us what you need help with and we will get back to you by email.',
  csatEnabled: true,
});

// ─── SLA state for badges ───────────────────────────────────────────────────

type SlaFields = {
  status: TicketStatus;
  firstResponseAt: string | null;
  firstResponseDueAt: string | null;
  firstResponseBreachedAt: string | null;
  resolvedAt: string | null;
  resolutionDueAt: string | null;
  resolutionBreachedAt: string | null;
};

export type SlaState = {kind: 'first_response' | 'resolution'; dueAt: string; breached: boolean; msLeft: number} | null;

/** The SLA clock that matters right now: first response until answered, then resolution. */
export function slaState(t: SlaFields, now = Date.now()): SlaState {
  if (!isOpenStatus(t.status)) return null;
  const pick = !t.firstResponseAt && t.firstResponseDueAt ? ('first_response' as const) : t.resolutionDueAt && !t.resolvedAt ? ('resolution' as const) : null;
  if (!pick) return null;
  const dueAt = pick === 'first_response' ? t.firstResponseDueAt! : t.resolutionDueAt!;
  const msLeft = new Date(dueAt).getTime() - now;
  return {kind: pick, dueAt, msLeft, breached: msLeft <= 0 || !!(pick === 'first_response' ? t.firstResponseBreachedAt : t.resolutionBreachedAt)};
}

/** 2d 3h · 45m · 3h 10m */
export function durationLabel(ms: number) {
  const mins = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Minutes ↔ "1h 30m"-style input used by the SLA editor. */
export function minutesLabel(mins: number | null) {
  return mins ? durationLabel(mins * 60_000) : '—';
}
