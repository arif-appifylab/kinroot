// Shared shapes for API responses. Model types come from Prisma; dates arrive as ISO strings.
import type * as P from '../../generated/prisma/client';

export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? {[K in keyof T]: Jsonify<T[K]>}
      : T;

/**
 * List columns are jsonb in the database (`Json` in Prisma: the live driver can't handle Postgres
 * arrays, docs/agent/database.md); the API always sends them as lists. These are the models as sent.
 */
type Lists<T, K extends keyof T, V = string[]> = Omit<T, K> & {[F in K]: V};
export type ListModels = {
  Contact: Lists<P.Contact, 'tags'>;
  Company: Lists<P.Company, 'tags'>;
  Deal: Lists<P.Deal, 'tags'>;
  Ticket: Lists<P.Ticket, 'tags'>;
  Interaction: Lists<P.Interaction, 'attendeeIds'>;
  EmailMessage: Lists<P.EmailMessage, 'to' | 'cc' | 'bcc'>;
  CustomFieldDef: Lists<P.CustomFieldDef, 'options'>;
  Webhook: Lists<P.Webhook, 'events'>;
  Goal: Lists<P.Goal, 'kinds'>;
  TicketMessage: Lists<P.TicketMessage, 'fileIds'>;
  BookingLink: Lists<Lists<P.BookingLink, 'hostIds'>, 'durations', number[]>;
  CalendarConnection: Lists<P.CalendarConnection, 'busyCalendarIds'>;
  Import: Lists<P.Import, 'headers'>;
  Export: Lists<P.Export, 'columns'>;
  ReportSchedule: Lists<P.ReportSchedule, 'userIds' | 'emails'>;
};

export type Role = P.TeamRole;
export type LifecycleStage = P.LifecycleStage;
export type DealStatus = P.DealStatus;
export type TaskType = P.TaskType;
export type Priority = P.Priority;
export type EntityType = P.EntityType;
export type FieldType = P.FieldType;
export type EmailProvider = P.EmailProvider;

export type UserLite = {id: string; name: string; email: string; color: string; avatarUrl?: string | null};
/** `accountOwner`: the site owner's account, which has no email address on the site (it comes from the dashboard).
 * `accountId`: the member's site account (`users.id`); null for a pending invite. */
export type Me = UserLite & {role: Role; active: boolean; invited: boolean; lastSeenAt: string | null; accountOwner?: boolean; accountId?: number | null};

export type Stage = Jsonify<P.Stage>;
export type Pipeline = Jsonify<P.Pipeline> & {stages: Stage[]; _count?: {deals: number}};

export type CompanyLite = {id: string; name: string; domain: string | null};
export type ContactLite = {id: string; firstName: string; lastName: string | null; email?: string | null; title?: string | null};

export type Contact = Jsonify<ListModels['Contact']> & {
  owner: UserLite | null;
  companies: {companyId: string; role: string | null; isPrimary: boolean; company: CompanyLite}[];
  _count?: {deals: number; tasks: number};
};

export type Company = Jsonify<ListModels['Company']> & {owner: UserLite | null; _count?: {contacts: number; deals: number}};

export type TaskLite = {id: string; title: string; dueAt: string | null; type: TaskType};

export type Deal = Jsonify<ListModels['Deal']> & {
  stage: Stage;
  pipeline: {id: string; name: string; rottingDays: number};
  owner: UserLite | null;
  company: CompanyLite | null;
  companies: {companyId: string; isPrimary: boolean; company: CompanyLite & {phone: string | null; industry: string | null}}[];
  contacts: {contactId: string; contact: ContactLite & {phone?: string | null; score?: number}}[];
  _count: {tasks: number};
  nextTask?: TaskLite | null;
};

export type DealDetail = Omit<Deal, 'pipeline'> & {
  pipeline: Pipeline;
  stageChanges: (Jsonify<P.StageChange> & {toStage: Stage | null; user: UserLite | null})[];
};

export type ContactDetail = Contact & {deals: {deal: Jsonify<ListModels['Deal']> & {stage: Stage; owner: UserLite | null}}[]};
export type CompanyDetail = Company & {
  contacts: {contactId: string; role: string | null; isPrimary: boolean; contact: Jsonify<ListModels['Contact']> & {owner: UserLite | null}}[];
  deals: (Jsonify<ListModels['Deal']> & {stage: Stage; owner: UserLite | null})[];
};

export type Note = Jsonify<P.Note> & {author: UserLite | null};

export type Task = Jsonify<P.Task> & {
  assignee: UserLite | null;
  contact: ContactLite | null;
  company: {id: string; name: string} | null;
  deal: {id: string; title: string} | null;
};

export type TimelineEmail = {
  id: string;
  threadId: string;
  subject: string;
  text: string | null;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  status: P.EmailStatus;
  error: string | null;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string | null;
  sentAt: string;
  direction: P.EmailDirection;
};

export type InteractionKind = P.InteractionKind;
export type Interaction = Jsonify<ListModels['Interaction']> & {author?: UserLite | null};

/** What the timeline stores for a logged call / meeting / message. */
export type InteractionSnapshot = {
  kind: InteractionKind;
  title: string | null;
  body: string | null;
  outcome: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  durationMin: number | null;
  locationType?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | 'OTHER' | null;
  location: string | null;
  occurredAt: string;
  attendees: {id: string; name: string}[];
};

export type ActivityComment = {id: string; body: string; createdAt: string; authorId: string | null; author: UserLite | null};

export type Activity = Jsonify<P.Activity> & {
  _count?: {comments: number};
  actor: UserLite | null;
  contact: ContactLite | null;
  deal: {id: string; title: string} | null;
  email: TimelineEmail | null;
};

export type EmailAccount = Omit<Jsonify<P.EmailAccount>, 'credentials' | 'syncCursor'> & {
  info: {label: string; kind: 'smtp' | 'api' | 'oauth'; inbound: string; inboundWebhook: boolean};
  /** How replies reach the CRM: mailbox sync, the inbound webhook (Reply-To), or not at all. */
  replyCapture: 'sync' | 'webhook' | 'none';
};

export type EmailMessage = Jsonify<ListModels['EmailMessage']> & {sender: UserLite | null};

export type EmailThread = Jsonify<P.EmailThread> & {
  contact: ContactLite | null;
  deal: {id: string; title: string} | null;
  last: {text: string; fromEmail: string; fromName: string | null; direction: P.EmailDirection; status: P.EmailStatus; openCount: number} | null;
  _count: {messages: number};
};

export type EmailThreadDetail = Jsonify<P.EmailThread> & {
  contact: ContactLite | null;
  company: {id: string; name: string} | null;
  deal: {id: string; title: string} | null;
  account: {id: string; fromEmail: string; provider: EmailProvider} | null;
  messages: EmailMessage[];
};

export type EmailTemplate = Jsonify<P.EmailTemplate>;
export type CustomField = Jsonify<ListModels['CustomFieldDef']>;
export type SavedView = Jsonify<P.SavedView> & {filters: Record<string, string>};

export type AppSettings = {
  brandName: string;
  brandLogo: string;
  brandPrimary: string;
  brandSecondary: string;
  currency: string;
  recordVisibility: 'everyone' | 'owner';
  lostReasons: string[];
  sources: string[];
  inboundToken: string;
  bccAddress: string;
  googleClientId: string;
  microsoftClientId: string;
  microsoftTenant: string;
  industries: string[];
  companyTypes: string[];
  taskQueues: string[];
  autoAssociateCompanies: boolean;
  autoCreateCompanies: boolean;
};

export type SettingsResponse = {
  settings: AppSettings;
  oauth: {googleConfigured: boolean; microsoftConfigured: boolean; googleRedirectUri: string; microsoftRedirectUri: string};
  inboundWebhookUrl: string;
  /** Which inbound signing secrets the owner added (admins only; names and yes / no). */
  inboundSecrets: Record<string, boolean>;
};

export type Paged<T> = {rows: T[]; total: number; page: number; pageSize: number};

export type AppNotification = Omit<Jsonify<P.Notification>, 'userId'> & {actor: UserLite | null};

export type FileMeta = Omit<Jsonify<P.File>, 'storageId' | 'uploadedById'> & {uploadedBy: UserLite | null};

export type Webhook = Omit<Jsonify<ListModels['Webhook']>, 'secret' | 'updatedAt'>;
/** `event.entity` is 'webhook' for test deliveries (Send test event). */
export type WebhookDelivery = Jsonify<P.WebhookDelivery> & {event: {data: unknown; createdAt: string; entity: string}};
export type JobsStatus = {
  cronConfigured: boolean;
  lastRunAt: string | null;
  pending: number;
  failed: number;
  /** The numbers stop at this many. */
  capped: number;
  /** Jobs the platform refused for good (set aside, kept 30 days). */
  failedJobs: number;
  /** Jobs waiting for the platform's job rate limit. */
  rateLimited: number;
  /** New jobs a minute this site sends (the platform's limit, raised in the dashboard's Jobs tab). */
  perMinute: number;
  /** What to tell the owner about waiting jobs, if anything. */
  note: string | null;
  /** Local dev server: a ticker runs due jobs every 30 s, no scheduler needed. */
  devTicker: boolean;
};

export type FormStatus = P.FormStatus;
export type FormRow = Pick<Jsonify<P.Form>, 'id' | 'name' | 'slug' | 'status' | 'views' | 'starts' | 'submissionCount' | 'lastSubmissionAt' | 'updatedAt' | 'createdAt'> & {createdBy: UserLite | null};
export type FormDetail = Omit<Jsonify<P.Form>, 'fields' | 'settings'> & {fields: import('./forms').FormField[]; settings: import('./forms').FormSettings; createdBy: UserLite | null};
export type FormSubmissionRow = Omit<Jsonify<P.FormSubmission>, 'answers' | 'meta'> & {
  answers: import('./forms').StoredAnswer[];
  meta: Record<string, string>;
  contact: {id: string; firstName: string; lastName: string | null; email: string | null} | null;
  deal: {id: string; title: string} | null;
};

export type ListKind = P.ListKind;
export type ContactListRow = Omit<Jsonify<P.ContactList>, 'rules'> & {rules: import('./segments').SegmentRules; owner: UserLite | null; count: number};
export type ContactListUsage = {forms: {id: string; name: string}[]; segments: {id: string; name: string}[]};
/** A list one contact is in (segments: matched right now, so no addedAt). */
export type ContactListMembership = {id: string; name: string; kind: ListKind; addedAt: string | null; source: string | null};
export type ListMember = Contact & {listMemberships?: {createdAt: string; source: string | null}[]};

// ─── Reports, dashboards, goals, forecast ───
export type SavedReport = Omit<Jsonify<P.Report>, 'config'> & {config: import('./reports').ReportConfig; owner: UserLite | null; _count: {widgets: number}};
export type DashboardFilters = {range?: import('./reports').DateRange; ownerId?: string};
export type DashboardRow = Omit<Jsonify<P.Dashboard>, 'filters'> & {filters: DashboardFilters; owner: UserLite | null; _count: {widgets: number}};
export type DashboardWidgetSize = 'small' | 'medium' | 'large';
export type DashboardDetail = Omit<Jsonify<P.Dashboard>, 'filters'> & {
  filters: DashboardFilters;
  owner: UserLite | null;
  widgets: (Omit<Jsonify<P.DashboardWidget>, 'size'> & {size: DashboardWidgetSize; report: SavedReport})[];
};

export type GoalProgress = {
  goal: Jsonify<ListModels['Goal']> & {user: UserLite | null};
  period: {label: string; from: string; to: string};
  actual: number;
  expected: number;
  elapsed: number;
  projected: number | null;
  status: 'achieved' | 'on_track' | 'behind' | 'missed';
};

export type ForecastRow = Record<import('./reports').ForecastCategory, number> & {key: string; label: string; weighted: number; count: number};
export type ForecastDeal = {
  id: string;
  title: string;
  value: number;
  currency: string;
  expectedCloseDate: string;
  stage: {id: string; name: string; probability: number; color: string};
  owner: UserLite | null;
  company: {id: string; name: string} | null;
  category: import('./reports').ForecastCategory | 'OMIT';
  auto: import('./reports').ForecastCategory;
  override: import('./reports').ForecastOverride | null;
  weighted: number;
};
export type ForecastData = {rows: ForecastRow[]; totals: ForecastRow; deals: ForecastDeal[]; noCloseDate: {count: number; value: number}; range: {from: string; to: string}};
// ─── Tickets ────────────────────────────────────────────────────────────────

export type TicketRow = Jsonify<ListModels['Ticket']> & {
  assignee: UserLite | null;
  contact: (ContactLite & {phone: string | null; emailOptOut: boolean}) | null;
  company: CompanyLite | null;
  deal: {id: string; title: string; status: DealStatus; value: number; currency: string} | null;
};

export type TicketFile = {id: string; name: string; mimeType: string; size: number};

export type TicketMessage = Omit<Jsonify<ListModels['TicketMessage']>, 'kind'> & {
  kind: 'reply' | 'note' | 'event';
  author: UserLite | null;
  files: TicketFile[];
  email: {id: string; status: P.EmailStatus; error: string | null; openCount: number} | null;
};

export type TicketCounts = {
  mine: number;
  unassigned: number;
  open: number;
  breached: number;
  csat: {average: number | null; count: number};
  byStatus: Partial<Record<P.TicketStatus, number>>;
};

export type CannedReply = Jsonify<P.CannedReply>;

export type TicketSettingsResponse = {settings: import('./tickets').TicketSettings; sharedAccounts: {id: string; label: string; fromEmail: string}[]};
export type EmailDesignResponse = {design: import('./email-layout').EmailDesign; brand: {name: string; logoSrc: string; primary: string}};
// ─── Scheduling ───
export type BookingLinkRow = Omit<Jsonify<ListModels['BookingLink']>, 'availability' | 'questions'> & {
  availability: import('./scheduling').Availability;
  questions: import('./scheduling').BookingQuestions;
  path: string;
  url: string;
  user?: UserLite | null;
  canEdit?: boolean;
};
export type SchedulingProfile = Jsonify<P.SchedulingProfile>;
export type CalendarConnectionView = Omit<Jsonify<ListModels['CalendarConnection']>, 'credentials' | 'calendars'> & {calendars: {id: string; name: string; primary: boolean; writable: boolean}[]};
export type CalendarState = {connections: CalendarConnectionView[]; providers: {google: boolean; microsoft: boolean}; redirectUris: {google: string; microsoft: string}};
export type MeetingRow = Interaction & {
  author: UserLite | null;
  contact: {id: string; firstName: string; lastName: string | null; email: string | null} | null;
  company: {id: string; name: string} | null;
  deal: {id: string; title: string} | null;
  onCalendar: boolean;
  booking: {id: string; status: string; source: string; name: string; email: string; linkName: string | null; manageUrl: string} | null;
};

// ─── Data hygiene: audit log, recycle bin, duplicates ───
export type AuditEntry = Omit<Jsonify<P.AuditLog>, 'meta'> & {meta: Record<string, unknown>};
export type AuditResponse = {rows: AuditEntry[]; total: number; page: number; pageSize: number; actions: string[]; settings: {retentionDays: number}; liveFiles: string[]};
export type BinEntry = Omit<Jsonify<P.DeletedRecord>, 'snapshot' | 'fileIds' | 'counts'> & {counts: Record<string, number>};
export type BinResponse = {rows: BinEntry[]; total: number; page: number; pageSize: number; counts: Record<string, number>};
export type RestoreResult = {id: string; entity: string; recordId: string; label: string; path: string; warning: string | null};
export type DuplicateContact = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  owner: UserLite | null;
  companies: {isPrimary: boolean; company: {id: string; name: string}}[];
  _count: {deals: number; notes: number};
};
export type DuplicateCompany = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  owner: UserLite | null;
  _count: {contacts: number; deals: number};
};
export type DuplicatePairRow<T = DuplicateContact | DuplicateCompany> = {id: string; score: number; reasons: string[]; status: 'open' | 'dismissed'; dismissedAt: string | null; a: T; b: T};
export type DuplicateHintMatch = {id: string; label: string; detail: string | null; score: number; reasons: string[]};

// ─── Shared inbox (module 10) ───

export type InboxCounts = {
  views: {unassigned: number; mine: number; open: number; snoozed: number; closed: number};
  channels: {team: number; personal: number; form: number; chat: number};
  folders: {spam: number; trash: number};
  unread: number;
  /** Unread chats waiting on me or the queue, and their newest message (for the new-message sound). */
  chat: {unread: number; latest: string | null};
  teamAccess: boolean;
};

type InboxAccount = {id: string; fromEmail: string; label: string; userId: string | null};

export type ConversationRow = Jsonify<P.EmailThread> & {
  assignee: UserLite | null;
  contact: ContactLite | null;
  account: InboxAccount | null;
  _count: {messages: number; comments: number};
  sender: {email: string; name: string | null} | null;
  personal: boolean;
  last: {direction: P.EmailDirection; fromEmail: string; fromName: string | null; text: string; sentAt: string} | null;
  /** Chat: the visitor is on the site right now. */
  online: boolean;
};

export type ConversationComment = Jsonify<P.ConversationComment> & {kind: 'comment' | 'event'; author: UserLite | null};

type SidebarDeal = {id: string; title: string; value: number; currency: string; status: DealStatus; stage: {name: string}};

export type ConversationDetail = {
  conversation: Jsonify<P.EmailThread> & {
    assignee: UserLite | null;
    account: (InboxAccount & {provider: EmailProvider}) | null;
    personal: boolean;
    inInbox: boolean;
    ticket: {id: string; number: number} | null;
  };
  messages: EmailMessage[];
  comments: ConversationComment[];
  replyTo: string | null;
  canReply: boolean;
  /** Chat (and other message channels): messages, the visitor, presence. */
  chat: ChatDetail | null;
  sidebar: {
    contact:
      | (ContactLite & {phone: string | null; lifecycleStage: LifecycleStage; score: number; emailOptOut: boolean; owner: UserLite | null; companies: {company: CompanyLite}[]})
      | null;
    company: (CompanyLite & {industry: string | null}) | null;
    deal: SidebarDeal | null;
    deals: SidebarDeal[];
    tickets: {id: string; number: number; subject: string; status: P.TicketStatus}[];
    activity: {id: string; type: string; title: string; createdAt: string}[];
    sender: {email: string; name: string | null} | null;
    contactHidden: boolean;
  };
};

export type ChatFile = {id: string; name: string; size: number; mimeType: string; image: boolean; url: string};
export type ChatMessage = {
  id: string;
  direction: P.EmailDirection;
  kind: 'text' | 'auto';
  status: P.ChannelMessageStatus;
  text: string;
  files: ChatFile[];
  sender: UserLite | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  emailed: boolean;
  emailMessageId: string | null;
};
export type ChatVisitor = {
  id: string;
  label: string;
  name: string | null;
  email: string | null;
  /** False until the visitor opened a link mailed to that address: anyone can type any email into the chat. */
  emailVerified: boolean;
  blocked: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  online: boolean;
  away: boolean;
  page: string | null;
  title: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  timeZone: string | null;
  location: string | null;
  userAgent: string | null;
  pages: {url: string; title: string | null; at: string}[];
  conversations: number;
};
export type ChatDetail = {messages: ChatMessage[]; visitor: ChatVisitor | null; typing: boolean; awayAfterMin: number};
