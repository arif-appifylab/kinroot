import {Prisma} from '../../../generated/prisma/client';
import {SOURCE_LABELS, TICKET_PRIORITIES, TICKET_STATUSES} from '@/lib/tickets';
import {registerReportObject, registerReportRef} from './reports';

/**
 * Tickets in the report builder and on dashboards. Imported for its side
 * effect from src/server/app.ts. Owner = assignee; members with owner-only
 * visibility see their tickets plus the unassigned queue, like the tickets page
 * (`ticketScope()`).
 */

registerReportRef('contact', {
  sql: (ids) => Prisma.sql`SELECT id, trim(concat_ws(' ', "firstName", "lastName")) AS label, NULL::float8 AS ord, NULL::text AS ctx FROM "Contact" WHERE id IN (${Prisma.join(ids)})`,
  // No picker list: it would show every contact's name to members limited to their own records.
});

const hoursBetween = (from: string, to: string) => `(EXTRACT(EPOCH FROM t."${to}" - t."${from}") / 3600.0)::float8`;
const open = `t."status" IN ('NEW', 'WAITING_ON_CONTACT', 'WAITING_ON_US')`;
const utcNow = `(now() AT TIME ZONE 'UTC')`;

registerReportObject({
  key: 'tickets',
  label: 'Tickets',
  noun: ['ticket', 'tickets'],
  table: '"Ticket"',
  ownerSql: 't."assigneeId"',
  ownerLabel: 'Assignee',
  scopeSql: (me) => Prisma.sql`t."assigneeId" = ${me} OR t."assigneeId" IS NULL`,
  defaultDate: 'createdAt',
  fields: [
    {key: 'firstResponseHours', label: 'First response time (hours)', kind: 'number', sql: hoursBetween('createdAt', 'firstResponseAt')},
    {key: 'resolutionHours', label: 'Resolution time (hours)', kind: 'number', sql: hoursBetween('createdAt', 'resolvedAt')},
    {key: 'csatRating', label: 'CSAT rating (1–5)', kind: 'number', sql: 't."csatRating"::float8', groupable: true, empty: 'No rating'},
    {key: 'status', label: 'Status', kind: 'enum', sql: 't."status"::text', options: TICKET_STATUSES.map((s) => ({value: s.value, label: s.label}))},
    {key: 'priority', label: 'Priority', kind: 'enum', sql: 't."priority"::text', options: TICKET_PRIORITIES.map((p) => ({value: p.value, label: p.label}))},
    {key: 'category', label: 'Category', kind: 'string', sql: `NULLIF(t."category", '')`, empty: 'No category'},
    {key: 'queue', label: 'Queue', kind: 'string', sql: `NULLIF(t."queue", '')`, empty: 'No queue'},
    {key: 'source', label: 'Source', kind: 'enum', sql: 't."source"::text', options: Object.entries(SOURCE_LABELS).map(([value, label]) => ({value, label}))},
    {key: 'owner', label: 'Assignee', kind: 'ref', ref: 'user', sql: 't."assigneeId"', empty: 'Unassigned'},
    {key: 'contact', label: 'Contact', kind: 'ref', ref: 'contact', sql: 't."contactId"', empty: 'No contact'},
    {key: 'company', label: 'Company', kind: 'ref', ref: 'company', sql: 't."companyId"', empty: 'No company'},
    {
      key: 'slaBreached',
      label: 'SLA breached',
      kind: 'boolean',
      // A stamped breach, or an open ticket already past a deadline (the stamp follows with the next job run).
      sql: `(t."firstResponseBreachedAt" IS NOT NULL OR t."resolutionBreachedAt" IS NOT NULL
        OR (${open} AND ((t."firstResponseAt" IS NULL AND t."firstResponseDueAt" < ${utcNow}) OR (t."resolvedAt" IS NULL AND t."resolutionDueAt" < ${utcNow}))))`,
    },
    {key: 'tags', label: 'Tags', kind: 'tags', sql: 't."tags"', empty: 'No tags'},
    {key: 'createdAt', label: 'Create date', kind: 'date', sql: 't."createdAt"'},
    {key: 'firstResponseAt', label: 'First response date', kind: 'date', sql: 't."firstResponseAt"'},
    {key: 'resolvedAt', label: 'Resolved date', kind: 'date', sql: 't."resolvedAt"'},
  ],
});
