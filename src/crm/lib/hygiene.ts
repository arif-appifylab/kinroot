/**
 * Data hygiene (module 7), shared by the server and the settings pages:
 * audit log categories and action labels, recycle-bin entities, duplicate
 * reasons. Server helpers live in src/server/lib/{audit,recycle-bin,duplicates}.ts.
 */

// ─── Audit log ───

export const AUDIT_CATEGORIES = {
  record: 'Records',
  auth: 'Sign-in',
  team: 'Team',
  settings: 'Settings',
  export: 'Imports & exports',
  security: 'Security',
} as const;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

/** Readable names for audit actions. Unknown actions fall back to `actionLabel()`'s humanised form. */
const AUDIT_ACTIONS: Record<string, string> = {
  'automation.enabled': 'Switched on automation',
  'automation.disabled': 'Switched off automation',
  'automation.secret_revealed': 'Viewed an automation signing secret',
  'automation.run_started': 'Ran automation by hand',
  'automation.test_started': 'Tested automation for real on a record',
  'automation.test_stopped': 'Stopped an automation test',
  'report_schedule.sent': 'Sent a scheduled report email',
  'conversation.assigned': 'Assigned a conversation',
  'conversation.closed': 'Closed a conversation',
  'conversation.reopened': 'Reopened a conversation',
  'conversation.spam': 'Marked a conversation as spam',
  'conversation.not_spam': 'Moved a conversation out of spam',
  'conversation.trashed': 'Moved a conversation to trash',
  'conversation.restored': 'Restored a conversation',
  'settings.inbox': 'Changed inbox settings',
  'settings.chat': 'Changed website chat settings',
  'settings.website': 'Changed the website pages',
  'conversation.transcript': 'Emailed a chat transcript',
  'report_schedule.paused': 'Paused a scheduled report email after failures',
  'report_schedule.resumed': 'Resumed a scheduled report email',
  'report_schedule.unsubscribed': 'Unsubscribed from a scheduled report email',
  'auth.setup': 'Set up the app',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'auth.invite_accepted': 'Accepted invite',
  'team.invited': 'Invited a teammate',
  'team.invite_link': 'Created a new invite link',
  'team.role_changed': 'Changed a role',
  'team.deactivated': 'Deactivated a user',
  'team.reactivated': 'Reactivated a user',
  'settings.updated': 'Changed settings',
  'settings.oauth_secret': 'Changed an OAuth client secret',
  'settings.email_design': 'Changed the email design',
  'settings.tickets': 'Changed ticket settings',
  'settings.audit': 'Changed audit log retention',
  'email_account.connected': 'Connected an email account',
  'email_account.updated': 'Changed an email account',
  'email_account.removed': 'Removed an email account',
  'calendar.connected': 'Connected a calendar',
  'calendar.removed': 'Disconnected a calendar',
  'webhook.secret_revealed': 'Revealed a webhook secret',
  'webhook.secret_rotated': 'Rotated a webhook secret',
  'data_in.url_revealed': 'Viewed the Data in webhook tokens',
  'data_in.url_regenerated': 'Regenerated the Data in webhook URL',
  'data_in.url_enabled': 'Turned on the Data in webhook',
  'data_in.url_disabled': 'Turned off the Data in webhook',
  'data_in.settings_updated': 'Changed the Data in rate limit',
  'file.share_link': 'Created a file share link',
  'export.csv': 'Exported CSV',
  'export.completed': 'Exported CSV',
  'export.failed': 'Export failed',
  'import.completed': 'Imported CSV',
  'import.failed': 'Import failed',
  'import.canceled': 'Canceled an import',
  'export.json': 'Exported record data',
  'bin.purged': 'Deleted forever',
  'duplicate.dismissed': 'Marked as not a duplicate',
  'duplicate.reopened': 'Reopened a duplicate pair',
};

const VERBS: Record<string, string> = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
  restored: 'Restored',
  merged: 'Merged',
  cloned: 'Cloned',
  duplicated: 'Duplicated',
  bulk_updated: 'Bulk-updated',
  status_changed: 'Changed status of',
  stage_changed: 'Moved',
  members_added: 'Added members to',
  members_removed: 'Removed members from',
  canceled: 'Canceled',
};

export const ENTITY_LABELS: Record<string, string> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  ticket: 'ticket',
  form: 'form',
  form_response: 'form response',
  list: 'list',
  booking_link: 'booking link',
  booking: 'booking',
  template: 'email template',
  canned_reply: 'canned reply',
  email_account: 'email account',
  calendar: 'calendar',
  webhook: 'webhook',
  data_in: 'Data in webhook',
  pipeline: 'pipeline',
  custom_field: 'custom field',
  user: 'user',
  file: 'file',
  report: 'report',
  audit: 'audit log',
  automation: 'automation',
  import: 'import',
  export: 'export',
  report_schedule: 'scheduled report email',
  conversation: 'conversation',
};

export function actionLabel(action: string) {
  if (AUDIT_ACTIONS[action]) return AUDIT_ACTIONS[action];
  const [entity = '', verb = ''] = action.split('.');
  const noun = ENTITY_LABELS[entity] ?? entity.replace(/_/g, ' ');
  return VERBS[verb] ? `${VERBS[verb]} ${noun}` : `${noun} ${verb.replace(/_/g, ' ')}`.trim();
}

export const AUDIT_RETENTION_DAYS = [90, 180, 365, 730] as const;
export const DEFAULT_AUDIT_RETENTION = 365;

// ─── Recycle bin ───

export const BIN_DAYS = 30;

export const BIN_ENTITIES = {
  contact: {label: 'Contact', plural: 'Contacts'},
  company: {label: 'Company', plural: 'Companies'},
  deal: {label: 'Deal', plural: 'Deals'},
  ticket: {label: 'Ticket', plural: 'Tickets'},
  form: {label: 'Form', plural: 'Forms'},
  list: {label: 'List', plural: 'Lists'},
  conversation: {label: 'Conversation', plural: 'Conversations'},
} as const;

export type BinEntity = keyof typeof BIN_ENTITIES;

/** Labels for the related-record counts shown in the bin ("3 notes, 2 tasks"). */
export const BIN_COUNT_LABELS: Record<string, [string, string]> = {
  note: ['note', 'notes'],
  task: ['task', 'tasks'],
  activity: ['timeline entry', 'timeline entries'],
  interaction: ['call / meeting', 'calls / meetings'],
  file: ['file', 'files'],
  ticketMessage: ['message', 'messages'],
  formSubmission: ['response', 'responses'],
  emailMessage: ['message', 'messages'],
  trackingEvent: ['open / click', 'opens / clicks'],
  conversationComment: ['comment', 'comments'],
  channelMessage: ['chat message', 'chat messages'],
  contactListMember: ['list membership', 'list memberships'],
};

// ─── Duplicates ───

export const DUPLICATE_REASONS: Record<string, string> = {
  email: 'Same email',
  phone: 'Same phone',
  name_company: 'Same name and company',
  name_domain: 'Same name and email domain',
  similar_name: 'Similar name',
  name: 'Same name',
  domain: 'Same domain',
  company_name: 'Same company name',
  similar_company_name: 'Similar company name',
};

export const confidence = (score: number) => (score >= 85 ? 'High' : score >= 60 ? 'Medium' : 'Low');
