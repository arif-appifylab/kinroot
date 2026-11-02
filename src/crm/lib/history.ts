/**
 * Property history: every change to a contact, company, deal or ticket, built
 * by `recordHistory()` (src/server/lib/history.ts) from all the places that
 * record changes and shown by the Property history drawer
 * (src/components/property-history.tsx). Shared by browser and server.
 */

export const HISTORY_ENTITIES = ['contact', 'company', 'deal', 'ticket'] as const;
export type HistoryEntity = (typeof HISTORY_ENTITIES)[number];

/** Who made a change. `user` has the teammate; the rest are named sources. */
export type HistoryActor = {
  kind: 'user' | 'automation' | 'import' | 'form' | 'webhook' | 'api' | 'merge' | 'customer' | 'system';
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  /** The teammate behind a merge, import or bulk edit, when known. */
  by?: string | null;
};

export type HistoryEntry = {
  id: string;
  /** `change` of one property; `created`, `merged` and `restored` are record events. */
  kind: 'change' | 'created' | 'merged' | 'restored';
  /** Property key (`lifecycleStage`, `custom.region`, `stageId`…); null for record events. */
  field: string | null;
  label: string;
  /** Human-readable values; null means empty. */
  from: string | null;
  to: string | null;
  /** Extra context: "Created from Website form", "Merged with Jane Doe", "Bulk edit". */
  note: string | null;
  actor: HistoryActor;
  at: string;
};

export type HistoryPage = {
  rows: HistoryEntry[];
  nextCursor: string | null;
  total: number;
  /** Label of the `field` filter, also when that property has no changes yet. */
  fieldLabel: string | null;
  /** Properties that have history, for the filter (most changed first). */
  fields: {field: string; label: string; count: number}[];
};

/** Labels of built-in properties, per entity. Custom fields use their definition's label. */
export const HISTORY_LABELS: Record<HistoryEntity, Record<string, string>> = {
  contact: {
    firstName: 'First name',
    lastName: 'Last name',
    email: 'Email',
    phone: 'Phone',
    title: 'Job title',
    linkedin: 'LinkedIn',
    city: 'City',
    country: 'Country',
    lifecycleStage: 'Lifecycle stage',
    leadStatus: 'Lead status',
    buyingRole: 'Buying role',
    source: 'Source',
    ownerId: 'Owner',
    tags: 'Tags',
    emailOptOut: 'Opted out of email',
  },
  company: {
    name: 'Name',
    domain: 'Domain',
    website: 'Website',
    industry: 'Industry',
    type: 'Type',
    employees: 'Employees',
    size: 'Size',
    annualRevenue: 'Annual revenue',
    phone: 'Phone',
    address: 'Address',
    city: 'City',
    state: 'State / region',
    postalCode: 'Postal code',
    country: 'Country',
    timezone: 'Time zone',
    linkedin: 'LinkedIn',
    description: 'Description',
    ownerId: 'Owner',
    tags: 'Tags',
  },
  deal: {
    title: 'Name',
    value: 'Value',
    currency: 'Currency',
    pipelineId: 'Pipeline',
    stageId: 'Stage',
    status: 'Status',
    lostReason: 'Lost reason',
    expectedCloseDate: 'Close date',
    companyId: 'Primary company',
    ownerId: 'Owner',
    type: 'Deal type',
    priority: 'Priority',
    tags: 'Tags',
    forecastCategory: 'Forecast category',
  },
  ticket: {
    subject: 'Subject',
    description: 'Description',
    status: 'Status',
    priority: 'Priority',
    category: 'Category',
    queue: 'Queue',
    assigneeId: 'Assignee',
    contactId: 'Contact',
    companyId: 'Company',
    dealId: 'Deal',
    tags: 'Tags',
  },
};

/** "forecast category" / "postalCode" → "Forecast category" / "Postal code" for keys without a label. */
export const humanizeField = (field: string) => {
  const s = field.replace(/^custom\./, '').replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
