import {Prisma} from '../../../generated/prisma/client';
import {registerReportObject, registerReportRef} from '../lib/reports';

/**
 * Bookings in the report builder and on dashboards. Imported for its side
 * effect from src/server/app.ts. Owner = the host who takes the meeting.
 */

registerReportRef('bookingLink', {
  sql: (ids) => Prisma.sql`SELECT id, name AS label, NULL::float8 AS ord, CASE WHEN kind = 'team' THEN 'Team' END AS ctx FROM "BookingLink" WHERE id IN (${Prisma.join(ids)})`,
  list: Prisma.sql`SELECT id, name AS label FROM "BookingLink" ORDER BY name LIMIT 500`,
});

registerReportObject({
  key: 'bookings',
  label: 'Bookings',
  noun: ['booking', 'bookings'],
  table: '"Booking"',
  ownerSql: 't."hostId"',
  ownerLabel: 'Host',
  defaultDate: 'startAt',
  fields: [
    {key: 'durationMin', label: 'Duration (minutes)', kind: 'number', sql: '(EXTRACT(EPOCH FROM t."endAt" - t."startAt") / 60.0)::float8', groupable: true},
    {key: 'link', label: 'Booking link', kind: 'ref', ref: 'bookingLink', sql: 't."linkId"', empty: 'Deleted link'},
    {key: 'owner', label: 'Host', kind: 'ref', ref: 'user', sql: 't."hostId"', empty: 'No host'},
    {key: 'status', label: 'Status', kind: 'enum', sql: 't."status"', options: [{value: 'CONFIRMED', label: 'Confirmed'}, {value: 'CANCELED', label: 'Canceled'}]},
    {key: 'source', label: 'Booked from', kind: 'enum', sql: 't."source"', options: [{value: 'page', label: 'Booking page'}, {value: 'widget', label: 'Embedded widget'}, {value: 'form', label: 'Form'}]},
    {key: 'startAt', label: 'Meeting time', kind: 'date', sql: 't."startAt"'},
    {key: 'createdAt', label: 'Booked on', kind: 'date', sql: 't."createdAt"'},
  ],
});
