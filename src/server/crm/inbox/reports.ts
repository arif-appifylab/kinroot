import {INBOX_CHANNELS} from '@/lib/inbox';
import {registerReportObject} from '../lib/reports';

/**
 * Conversations in the report builder and on dashboards (imported for its
 * side effect from src/server/app.ts). It covers the team inbox only: team
 * mailboxes, the form channel and website chat, never someone's personal mailbox (those
 * stay private) nor spam / trash. Owner = assignee; members with owner-only
 * visibility see their conversations plus the unassigned queue, like tickets.
 */

const hoursBetween = (from: string, to: string) => `(EXTRACT(EPOCH FROM t."${to}" - t."${from}") / 3600.0)::float8`;

registerReportObject({
  key: 'conversations',
  label: 'Conversations',
  noun: ['conversation', 'conversations'],
  table: '"EmailThread"',
  where: `t."firstInboundAt" IS NOT NULL AND t."spamAt" IS NULL AND t."trashedAt" IS NULL AND (t."channel" IN ('form', 'chat')
    OR (t."channel" = 'email' AND (t."accountId" IS NULL OR EXISTS (SELECT 1 FROM "EmailAccount" a WHERE a.id = t."accountId" AND a."userId" IS NULL))))`,
  ownerSql: 't."assigneeId"',
  ownerLabel: 'Assignee',
  scopeSql: (me) => `t."assigneeId" = ${me} OR t."assigneeId" IS NULL`,
  defaultDate: 'createdAt',
  fields: [
    {key: 'firstResponseHours', label: 'First response time (hours)', kind: 'number', sql: hoursBetween('firstInboundAt', 'firstResponseAt')},
    {key: 'closeHours', label: 'Time to close (hours)', kind: 'number', sql: `CASE WHEN t."status" = 'CLOSED' THEN ${hoursBetween('firstInboundAt', 'closedAt')} END`},
    {key: 'channel', label: 'Channel', kind: 'enum', sql: 't."channel"', options: Object.entries(INBOX_CHANNELS).map(([value, c]) => ({value, label: c.label}))},
    {key: 'status', label: 'Status', kind: 'enum', sql: 't."status"::text', options: [{value: 'OPEN', label: 'Open'}, {value: 'CLOSED', label: 'Closed'}]},
    {key: 'owner', label: 'Assignee', kind: 'ref', ref: 'user', sql: 't."assigneeId"', empty: 'Unassigned'},
    {key: 'createdAt', label: 'Created', kind: 'date', sql: 't."firstInboundAt"'},
    {key: 'firstResponseAt', label: 'First response date', kind: 'date', sql: 't."firstResponseAt"'},
    {key: 'closedAt', label: 'Closed date', kind: 'date', sql: `CASE WHEN t."status" = 'CLOSED' THEN t."closedAt" END`},
  ],
});
