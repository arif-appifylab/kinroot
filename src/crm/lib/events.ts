/**
 * Domain events, shared by the server (emit) and the UI (webhook picker).
 * Add new modules' events here; webhooks and automations pick them up.
 *
 * Each event has a `label` that reads on its own (automations, delivery log),
 * a `short` label that reads under its group heading in the webhook picker,
 * and an `example()` of the `data` emit() sends for it. The examples feed the
 * webhook payload preview and "Send test event": when an emit() call site
 * changes its payload, update the example here too.
 */

// ─── Sample records for the examples (shapes follow the emit() call sites) ───

const T = '2026-03-12T14:05:09.000Z';
const T_EARLIER = '2026-03-02T09:30:00.000Z';
const OWNER = {id: 'cmuser0alexmorgan000001', name: 'Alex Morgan', email: 'alex@yourcompany.example', color: '#2563eb', avatarUrl: null};
const IDS = {
  contact: 'cmcontact0mayapatel0001',
  dropped: 'cmcontact0mayapatel0002',
  company: 'cmcompany0northwind0001',
  deal: 'cmdeal0northwindrenew01',
  pipeline: 'cmpipeline0sales0000001',
  ticket: 'cmticket0billing0000001',
  thread: 'cmthread0inbox000000001',
  account: 'cmaccount0support000001',
  list: 'cmlist0newsletter000001',
  form: 'cmform0contactus0000001',
};

const companyRef = {id: IDS.company, name: 'Northwind Traders', domain: 'northwind.example'};

const company = (over: Record<string, unknown> = {}) => ({
  id: IDS.company,
  name: 'Northwind Traders',
  domain: 'northwind.example',
  industry: 'Logistics',
  size: '51-200',
  type: 'Prospect',
  employees: 120,
  annualRevenue: 12000000,
  timezone: 'America/Los_Angeles',
  website: 'https://northwind.example',
  phone: '+1 415 555 0100',
  address: '200 Market Street',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  country: 'United States',
  linkedin: null,
  description: null,
  tags: ['enterprise'],
  custom: {},
  ownerId: OWNER.id,
  lastActivityAt: T,
  createdAt: T_EARLIER,
  updatedAt: T,
  ...over,
});

const contact = (over: Record<string, unknown> = {}) => ({
  id: IDS.contact,
  firstName: 'Maya',
  lastName: 'Patel',
  email: 'maya.patel@northwind.example',
  phone: '+1 415 555 0142',
  title: 'Head of Operations',
  linkedin: null,
  lifecycleStage: 'LEAD',
  leadStatus: 'New',
  buyingRole: 'Decision maker',
  emailOptOut: false,
  city: 'San Francisco',
  country: 'United States',
  source: 'Website',
  tags: ['inbound'],
  custom: {},
  ownerId: OWNER.id,
  lastActivityAt: T,
  createdAt: T,
  updatedAt: T,
  score: 25,
  scoreUpdatedAt: T,
  owner: OWNER,
  companies: [{contactId: IDS.contact, companyId: IDS.company, role: null, isPrimary: true, company: companyRef}],
  ...over,
});

const stage = (id: string, name: string, position: number, probability: number) => ({id, pipelineId: IDS.pipeline, name, position, probability, color: '#3b82f6'});
const PROPOSAL = stage('cmstage0proposal0000001', 'Proposal', 2, 50);
const NEGOTIATION = stage('cmstage0negotiation0001', 'Negotiation', 3, 75);

const deal = (over: Record<string, unknown> = {}) => ({
  id: IDS.deal,
  title: 'Northwind annual renewal',
  value: 18000,
  currency: 'USD',
  pipelineId: IDS.pipeline,
  stageId: PROPOSAL.id,
  status: 'OPEN',
  lostReason: null,
  expectedCloseDate: '2026-04-30T00:00:00.000Z',
  closedAt: null,
  position: 1,
  companyId: IDS.company,
  ownerId: OWNER.id,
  tags: [],
  custom: {},
  type: 'Existing business',
  priority: 'High',
  stageEnteredAt: T_EARLIER,
  lastActivityAt: T,
  createdAt: T_EARLIER,
  updatedAt: T,
  forecastCategory: null,
  stage: PROPOSAL,
  pipeline: {id: IDS.pipeline, name: 'Sales', rottingDays: 14},
  owner: OWNER,
  company: companyRef,
  companies: [{dealId: IDS.deal, companyId: IDS.company, isPrimary: true, company: {...companyRef, phone: '+1 415 555 0100', industry: 'Logistics'}}],
  _count: {tasks: 1},
  contacts: [{dealId: IDS.deal, contactId: IDS.contact, contact: {id: IDS.contact, firstName: 'Maya', lastName: 'Patel', email: 'maya.patel@northwind.example', title: 'Head of Operations', phone: '+1 415 555 0142', score: 25}}],
  ...over,
});

// Deletes and restores send the bare row (no owner / stage / company objects).
const contactRow = (over: Record<string, unknown> = {}) => contact({owner: undefined, companies: undefined, ...over});
const dealRow = (over: Record<string, unknown> = {}) => deal({stage: undefined, pipeline: undefined, owner: undefined, company: undefined, companies: undefined, _count: undefined, contacts: undefined, ...over});

const ticket = (over: Record<string, unknown> = {}) => ({
  id: IDS.ticket,
  number: 1042,
  subject: 'Invoice shows the wrong billing address',
  description: 'Hi, our March invoice still has our old address. Could you update it?',
  descriptionHtml: '<p>Hi, our March invoice still has our old address. Could you update it?</p>',
  status: 'NEW',
  priority: 'NORMAL',
  category: 'Billing',
  queue: 'Billing',
  source: 'EMAIL',
  tags: [],
  assigneeId: OWNER.id,
  contactId: IDS.contact,
  companyId: IDS.company,
  dealId: null,
  emailThreadId: null,
  firstResponseAt: null,
  firstResponseDueAt: '2026-03-12T18:05:09.000Z',
  firstResponseBreachedAt: null,
  resolvedAt: null,
  resolutionDueAt: '2026-03-14T14:05:09.000Z',
  resolutionBreachedAt: null,
  closedAt: null,
  csatRating: null,
  csatComment: null,
  csatAt: null,
  csatSentAt: null,
  lastMessageAt: T,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const ticketMessage = {
  id: 'cmticketmsg0reply000001',
  ticketId: IDS.ticket,
  kind: 'reply',
  direction: 'OUTBOUND',
  via: 'app',
  body: 'Thanks Maya, the address is updated and a corrected invoice is on its way.',
  html: '<p>Thanks Maya, the address is updated and a corrected invoice is on its way.</p>',
  authorId: OWNER.id,
  fromEmail: null,
  fromName: null,
  emailMessageId: 'cmemail0message00000002',
  fileIds: [],
  data: {},
  createdAt: T,
};

const conversation = (over: Record<string, unknown> = {}) => ({
  conversationId: IDS.thread,
  subject: 'Question about volume pricing',
  channel: 'email',
  status: 'OPEN',
  assigneeId: OWNER.id,
  accountId: IDS.account,
  contactId: IDS.contact,
  companyId: IDS.company,
  dealId: null,
  ...over,
});

const booking = (over: Record<string, unknown> = {}) => ({
  bookingId: 'cmbooking0intro00000001',
  link: {id: 'cmbookinglink0intro0001', name: 'Intro call (30 min)'},
  hostId: OWNER.id,
  contactId: IDS.contact,
  interactionId: 'cminteraction0meeting01',
  status: 'CONFIRMED',
  startAt: '2026-03-18T16:00:00.000Z',
  endAt: '2026-03-18T16:30:00.000Z',
  timezone: 'America/Los_Angeles',
  invitee: {name: 'Maya Patel', email: 'maya.patel@northwind.example', phone: null, company: 'Northwind Traders', notes: 'Would like to see the reporting features.'},
  location: 'https://meet.example/abc-defg-hij',
  locationType: 'VIDEO',
  source: 'page',
  cancelReason: null,
  ...over,
});

const emailMessage = (over: Record<string, unknown> = {}) => ({
  id: 'cmemail0message00000001',
  threadId: IDS.thread,
  accountId: IDS.account,
  direction: 'OUTBOUND',
  status: 'SENT',
  fromEmail: 'alex@yourcompany.example',
  fromName: 'Alex Morgan',
  to: ['maya.patel@northwind.example'],
  cc: [],
  bcc: [],
  subject: 'Your renewal quote',
  text: 'Hi Maya, the renewal quote is attached. Best, Alex',
  messageId: '<cm0quote.1741788309@yourcompany.example>',
  inReplyTo: null,
  externalId: null,
  error: null,
  trackingId: 'trk_5d1f0c2a9b',
  openCount: 0,
  clickCount: 0,
  firstOpenedAt: null,
  senderId: OWNER.id,
  contactId: IDS.contact,
  sentAt: T,
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 'cmtask0sendquote0000001',
  title: 'Send the renewal quote',
  description: null,
  type: 'EMAIL',
  priority: 'HIGH',
  dueAt: '2026-03-13T17:00:00.000Z',
  done: false,
  doneAt: null,
  repeat: null,
  queue: null,
  reminderAt: null,
  remindedAt: null,
  assigneeId: OWNER.id,
  creatorId: OWNER.id,
  contactId: IDS.contact,
  companyId: null,
  dealId: IDS.deal,
  createdAt: T,
  updatedAt: T,
  assignee: OWNER,
  contact: {id: IDS.contact, firstName: 'Maya', lastName: 'Patel'},
  company: null,
  deal: {id: IDS.deal, title: 'Northwind annual renewal'},
  ...over,
});

const listMember = (source: string) => ({list: {id: IDS.list, name: 'Newsletter'}, contactId: IDS.contact, source});

// ─── Catalogue ──────────────────────────────────────────────────────────────

export const EVENT_GROUPS = [
  {
    label: 'Contacts',
    events: [
      {type: 'contact.created', label: 'Contact created', short: 'Created', example: () => contact()},
      {type: 'contact.updated', label: 'Contact updated', short: 'Updated', example: () => ({...contact({lifecycleStage: 'QUALIFIED'}), changes: [{field: 'lifecycleStage', from: 'LEAD', to: 'QUALIFIED'}]})},
      {type: 'contact.deleted', label: 'Contact deleted', short: 'Deleted', example: () => contactRow()},
      {type: 'contact.merged', label: 'Contacts merged', short: 'Merged', example: () => ({keptId: IDS.contact, droppedId: IDS.dropped, dropped: contactRow({id: IDS.dropped, email: 'maya@northwind.example', companies: [], deals: [], listMemberships: []})})},
      {type: 'contact.restored', label: 'Contact restored from the recycle bin', short: 'Restored from bin', example: () => contactRow()},
    ],
  },
  {
    label: 'Companies',
    events: [
      {type: 'company.created', label: 'Company created', short: 'Created', example: () => company()},
      {type: 'company.updated', label: 'Company updated', short: 'Updated', example: () => ({...company({employees: 140}), changes: [{field: 'employees', from: 120, to: 140}]})},
      {type: 'company.deleted', label: 'Company deleted', short: 'Deleted', example: () => company()},
      {type: 'company.merged', label: 'Companies merged', short: 'Merged', example: () => ({keptId: IDS.company, droppedId: 'cmcompany0northwind0002', dropped: company({id: 'cmcompany0northwind0002', name: 'Northwind', domain: null})})},
      {type: 'company.restored', label: 'Company restored from the recycle bin', short: 'Restored from bin', example: () => company()},
    ],
  },
  {
    label: 'Deals',
    events: [
      {type: 'deal.created', label: 'Deal created', short: 'Created', example: () => deal()},
      {type: 'deal.updated', label: 'Deal updated', short: 'Updated', example: () => ({...deal(), changes: [{field: 'value', from: 15000, to: 18000}]})},
      {type: 'deal.stage_changed', label: 'Deal stage changed', short: 'Stage changed', example: () => ({deal: deal({stageId: NEGOTIATION.id, stage: NEGOTIATION}), from: {id: PROPOSAL.id, name: PROPOSAL.name}, to: {id: NEGOTIATION.id, name: NEGOTIATION.name}})},
      {type: 'deal.won', label: 'Deal won', short: 'Won', example: () => deal({status: 'WON', closedAt: T})},
      {type: 'deal.lost', label: 'Deal lost', short: 'Lost', example: () => deal({status: 'LOST', closedAt: T, lostReason: 'Chose a competitor'})},
      {type: 'deal.deleted', label: 'Deal deleted', short: 'Deleted', example: () => dealRow()},
      {type: 'deal.restored', label: 'Deal restored from the recycle bin', short: 'Restored from bin', example: () => dealRow()},
    ],
  },
  {
    label: 'Forms',
    events: [
      {
        type: 'form.submitted',
        label: 'Form submitted',
        short: 'Form submitted',
        example: () => ({
          form: {id: IDS.form, name: 'Contact us', slug: 'contact-us'},
          submissionId: 'cmsubmission0contact001',
          answers: [
            {fieldId: 'name', label: 'Name', type: 'name', value: {first: 'Maya', last: 'Patel'}},
            {fieldId: 'email', label: 'Email', type: 'email', value: 'maya.patel@northwind.example'},
            {fieldId: 'message', label: 'How can we help?', type: 'long_text', value: 'We would like a demo for our operations team.'},
          ],
          meta: {page: 'https://yourcompany.example/contact', referrer: 'https://www.google.com/', utm_source: 'google'},
          contactId: IDS.contact,
          dealId: null,
        }),
      },
    ],
  },
  {
    label: 'Lists',
    events: [
      {type: 'list.member_added', label: 'Contact added to a list', short: 'Contact added', example: () => listMember('manual')},
      {type: 'list.member_removed', label: 'Contact removed from a list', short: 'Contact removed', example: () => listMember('manual')},
      {
        type: 'broadcast.sent',
        label: 'Email to a list (broadcast) sent',
        short: 'Broadcast sent',
        example: () => ({id: 'cmbroadcast0march00001', subject: 'March product update', list: {id: IDS.list, name: 'Newsletter'}, accountId: IDS.account, total: 1250, sent: 1238, failed: 4, skipped: 8}),
      },
    ],
  },
  {
    label: 'Tickets',
    events: [
      {type: 'ticket.created', label: 'Ticket created', short: 'Created', example: () => ticket()},
      {type: 'ticket.status_changed', label: 'Ticket status changed', short: 'Status changed', example: () => ({...ticket({status: 'RESOLVED', resolvedAt: T}), from: 'WAITING_ON_US', to: 'RESOLVED'})},
      {type: 'ticket.replied', label: 'Ticket replied (team or customer)', short: 'Replied', example: () => ({ticket: ticket({status: 'WAITING_ON_CONTACT', firstResponseAt: T}), message: ticketMessage})},
      {type: 'ticket.assigned', label: 'Ticket assigned', short: 'Assigned', example: () => ({...ticket(), previousAssigneeId: null})},
      {type: 'ticket.sla_breached', label: 'Ticket SLA breached', short: 'SLA breached', example: () => ({ticket: ticket({firstResponseBreachedAt: '2026-03-12T18:05:09.000Z'}), sla: 'first_response', dueAt: '2026-03-12T18:05:09.000Z'})},
      {type: 'ticket.deleted', label: 'Ticket deleted', short: 'Deleted', example: () => ticket()},
      {type: 'ticket.restored', label: 'Ticket restored from the recycle bin', short: 'Restored from bin', example: () => ticket()},
    ],
  },
  {
    label: 'Inbox',
    events: [
      {type: 'conversation.created', label: 'Inbox conversation created (first message in)', short: 'Conversation created', example: () => conversation({from: 'maya.patel@northwind.example', spam: false})},
      {type: 'conversation.assigned', label: 'Inbox conversation assigned', short: 'Conversation assigned', example: () => conversation({previousAssigneeId: null, via: 'manual'})},
      {type: 'conversation.closed', label: 'Inbox conversation closed', short: 'Conversation closed', example: () => conversation({status: 'CLOSED', reason: 'manual'})},
      {type: 'conversation.reopened', label: 'Inbox conversation reopened', short: 'Conversation reopened', example: () => conversation({reason: 'reply'})},
      {
        type: 'chat.started',
        label: 'Website chat started',
        short: 'Website chat started',
        example: () => conversation({subject: 'Chat with Maya Patel', channel: 'chat', accountId: null, visitor: {name: 'Maya Patel', email: 'maya.patel@northwind.example'}, page: 'https://yourcompany.example/pricing', away: false, spam: false}),
      },
    ],
  },
  {
    label: 'Meetings',
    events: [
      {type: 'meeting.booked', label: 'Meeting booked', short: 'Booked', example: () => booking()},
      {type: 'meeting.rescheduled', label: 'Meeting rescheduled', short: 'Rescheduled', example: () => ({...booking({startAt: '2026-03-19T17:00:00.000Z', endAt: '2026-03-19T17:30:00.000Z'}), previousStartAt: '2026-03-18T16:00:00.000Z'})},
      {type: 'meeting.canceled', label: 'Meeting canceled', short: 'Canceled', example: () => booking({status: 'CANCELED', cancelReason: 'Something came up, will rebook next week.'})},
    ],
  },
  {
    label: 'Lead scoring',
    events: [
      {
        type: 'contact.score_changed',
        label: 'Lead score band changed (e.g. Warm → Hot)',
        short: 'Score band changed',
        example: () => ({contactId: IDS.contact, oldScore: 45, newScore: 55, oldBand: {key: 'warm', name: 'Warm'}, newBand: {key: 'hot', name: 'Hot'}, direction: 'up'}),
      },
    ],
  },
  {
    label: 'Activity',
    events: [
      {type: 'task.created', label: 'Task created', short: 'Task created', example: () => task()},
      {type: 'task.completed', label: 'Task completed', short: 'Task completed', example: () => task({done: true, doneAt: T})},
      {
        type: 'note.created',
        label: 'Note added',
        short: 'Note added',
        example: () => ({id: 'cmnote0renewalcall00001', body: 'Maya confirmed budget for the renewal; wants the quote by Friday.', pinned: false, authorId: OWNER.id, contactId: IDS.contact, companyId: null, dealId: null, createdAt: T, updatedAt: T, author: OWNER}),
      },
      {
        type: 'interaction.logged',
        label: 'Call, meeting or message logged',
        short: 'Call or meeting logged',
        example: () => ({id: 'cminteraction0call00001', kind: 'CALL', title: 'Renewal check-in', body: 'Discussed seat count for next year.', occurredAt: T, durationMin: 20, outcome: 'Connected', direction: 'OUTBOUND', locationType: null, location: null, attendeeIds: [IDS.contact], authorId: OWNER.id, contactId: IDS.contact, companyId: IDS.company, dealId: IDS.deal, createdAt: T, updatedAt: T}),
      },
      {type: 'email.sent', label: 'Email sent', short: 'Email sent', example: () => emailMessage({dealId: IDS.deal})},
      {
        type: 'email.received',
        label: 'Email received',
        short: 'Email received',
        example: () => emailMessage({id: 'cmemail0message00000003', direction: 'INBOUND', status: 'RECEIVED', fromEmail: 'maya.patel@northwind.example', fromName: 'Maya Patel', to: ['alex@yourcompany.example'], subject: 'Re: Your renewal quote', text: 'Thanks Alex, looks good. We will sign this week.', trackingId: null, senderId: null, dealId: IDS.deal, companyId: IDS.company}),
      },
      {type: 'email.opened', label: 'Email opened (first open)', short: 'Email opened', example: () => ({messageId: 'cmemail0message00000001', contactId: IDS.contact, dealId: IDS.deal, subject: 'Your renewal quote'})},
      {type: 'email.clicked', label: 'Email link clicked (first click)', short: 'Email link clicked', example: () => ({messageId: 'cmemail0message00000001', contactId: IDS.contact, dealId: IDS.deal, subject: 'Your renewal quote', url: 'https://yourcompany.example/pricing'})},
      {
        type: 'file.uploaded',
        label: 'File uploaded',
        short: 'File uploaded',
        example: () => ({id: 'cmfile0renewalquote0001', name: 'Northwind renewal quote.pdf', mimeType: 'application/pdf', size: 184320, purpose: 'attachment', contactId: null, companyId: null, dealId: IDS.deal, createdAt: T, uploadedBy: OWNER}),
      },
    ],
  },
  {
    label: 'Data in webhook',
    events: [
      {
        type: 'data_in.received',
        label: 'Data in webhook event received',
        short: 'Custom event received',
        example: () => ({
          event: 'trial.started',
          contactId: IDS.contact,
          properties: {plan: 'Pro', seats: 12},
          occurredAt: T,
          key: {id: 'url:Kx9Qe2ZtR4mB', name: 'Data in URL'},
        }),
      },
    ],
  },
  {
    label: 'Reports',
    events: [
      {
        type: 'report.sent',
        label: 'Scheduled report email sent',
        short: 'Scheduled report sent',
        example: () => ({scheduleId: 'cmschedule0weekly000001', reportId: 'cmreport0pipeline000001', dashboardId: null, name: 'Weekly pipeline', subject: 'Weekly pipeline: 2 – 8 Mar 2026', range: '2 – 8 Mar 2026', recipients: 3, externalRecipients: 1, slotAt: '2026-03-09T08:00:00.000Z', manual: false, ownerId: OWNER.id}),
      },
    ],
  },
  {
    label: 'Automations',
    events: [
      {
        type: 'automation.run_failed',
        label: 'Automation run failed',
        short: 'Run failed',
        example: () => ({automation: {id: 'cmautomation0welcome001', name: 'Welcome new leads'}, run: {id: 'cmautorun0000000000001', object: 'contact', recordId: IDS.contact, record: 'Maya Patel', source: 'event', error: 'The email account is disconnected'}}),
      },
    ],
  },
] as const;

export type EventType = (typeof EVENT_GROUPS)[number]['events'][number]['type'];

export const EVENT_TYPES = EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.type)) as EventType[];

type EventDef = {type: EventType; label: string; short: string; example: () => unknown};
const BY_TYPE = new Map<string, EventDef>((EVENT_GROUPS as readonly {events: readonly EventDef[]}[]).flatMap((g) => g.events.map((e) => [e.type, e] as const)));

export const eventDef = (type: string) => BY_TYPE.get(type) ?? null;

/** Example `data` for an event type (what emit() sends), or null for an unknown type. */
export const eventExample = (type: string) => BY_TYPE.get(type)?.example() ?? null;

/** Headers on every webhook delivery (see deliverWebhook in src/server/lib/webhooks.ts). */
export const WEBHOOK_HEADERS = [
  {name: 'Content-Type', value: 'application/json', hint: 'The body is JSON.'},
  {name: 'X-Webhook-Event', value: '<type>', hint: 'The event type, same as "type" in the body.'},
  {name: 'X-Webhook-Id', value: '<delivery id>', hint: 'Unique per delivery and stays the same on retries: use it to ignore repeats.'},
  {name: 'X-Webhook-Signature', value: 't=<unix seconds>,v1=<hex>', hint: 'HMAC-SHA256 of "<t>.<raw body>" with the signing secret.'},
  {name: 'X-Webhook-Test', value: 'true', hint: 'Only on test deliveries sent from Settings.'},
] as const;

/** The body we POST for an event: {id, type, createdAt, data}. */
export function webhookExampleBody(type: string, at = T) {
  return {id: 'cmevent0example00000001', type, createdAt: at, data: eventExample(type) ?? {}};
}
