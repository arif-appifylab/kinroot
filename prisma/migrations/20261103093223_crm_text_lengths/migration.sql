-- Audit P3-14 (part 2): the column refuses text longer than the code ever writes
-- (docs/agent/database.md › Column types: `@db.VarChar(n)`, n = the validator's max). Only columns
-- whose EVERY writer is capped were changed: a zod `.max(n)` on the only route that writes them, or a
-- `.slice(0, n)` at the single write site (checked across src/server/crm, the seed and the tests):
--   Automation.name 120 / description 1000 (routes/automations.ts; duplicate slices the name),
--   IncomingWebhook.name 100 / verifyHeader 100 (routes/incoming-webhooks.ts hookBody),
--   IncomingWebhookRequest.contentType 200, TrackingEvent.url 1000 / userAgent 300,
--   AuditLog.label 300 / userAgent 300 (lib/audit.ts row()), Booking.name 200 / title 300
--   (scheduling/bookings.ts), ImportIssue.column 200 / message 500, Import.error 500,
--   Export.error 500, CalendarConnection.lastError 500.
-- Not changed: record fields with several writers that don't all cap (Contact.firstName from
-- bookings / forms, Deal.title, Ticket.subject, EmailThread.subject from inbound mail…), and long
-- text (bodies, HTML, JSON). Those need their writers capped first, then a later migration.
-- text -> varchar(n) is a type change: Postgres re-checks every row (fails if one is longer; none
-- are) and the Publish asks the owner to approve it. The site is not live yet, so there are no live rows to check.
BEGIN;

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "label" SET DATA TYPE VARCHAR(300),
ALTER COLUMN "userAgent" SET DATA TYPE VARCHAR(300);
-- AlterTable
ALTER TABLE "Automation" ALTER COLUMN "name" SET DATA TYPE VARCHAR(120),
ALTER COLUMN "description" SET DATA TYPE VARCHAR(1000);
-- AlterTable
ALTER TABLE "Booking" ALTER COLUMN "title" SET DATA TYPE VARCHAR(300),
ALTER COLUMN "name" SET DATA TYPE VARCHAR(200);
-- AlterTable
ALTER TABLE "CalendarConnection" ALTER COLUMN "lastError" SET DATA TYPE VARCHAR(500);
-- AlterTable
ALTER TABLE "Export" ALTER COLUMN "error" SET DATA TYPE VARCHAR(500);
-- AlterTable
ALTER TABLE "Import" ALTER COLUMN "error" SET DATA TYPE VARCHAR(500);
-- AlterTable
ALTER TABLE "ImportIssue" ALTER COLUMN "column" SET DATA TYPE VARCHAR(200),
ALTER COLUMN "message" SET DATA TYPE VARCHAR(500);
-- AlterTable
ALTER TABLE "IncomingWebhook" ALTER COLUMN "name" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "verifyHeader" SET DATA TYPE VARCHAR(100);
-- AlterTable
ALTER TABLE "IncomingWebhookRequest" ALTER COLUMN "contentType" SET DATA TYPE VARCHAR(200);
-- AlterTable
ALTER TABLE "TrackingEvent" ALTER COLUMN "url" SET DATA TYPE VARCHAR(1000),
ALTER COLUMN "userAgent" SET DATA TYPE VARCHAR(300);

COMMIT;
