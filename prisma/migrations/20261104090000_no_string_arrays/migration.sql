-- Scalar lists (String[] / Int[]) become jsonb arrays (docs/agent/database.md: "Don't use String[] or
-- other Prisma scalar lists"). The live database is reached through src/platform/db-socket.ts, whose
-- driver writes a JS array as "a,b" (`malformed array literal`) and can't read text[] back, so every
-- list column moves to jsonb, which it handles. Data is KEPT: each column is converted in place with
-- `USING to_jsonb(col)` ({a,b} -> ["a","b"], {} -> [], {30,60} -> [30,60]); nothing is dropped and
-- re-added. The array default is dropped first (it can't be cast), then set again as jsonb. Prisma
-- left the list columns nullable in the database (it never writes NULL there): a stray NULL becomes the
-- column's default and the columns become NOT NULL, as the schema says.
-- The four `tags` columns get a GIN index (jsonb_path_ops) for the `@>` containment filters
-- (has tag / has all / has any) used by lists, segments and reports.
BEGIN;

ALTER TABLE "Company"
  ALTER COLUMN "tags" DROP DEFAULT,
  ALTER COLUMN "tags" TYPE jsonb USING COALESCE(to_jsonb("tags"), '[]'::jsonb),
  ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "tags" SET NOT NULL;

ALTER TABLE "Contact"
  ALTER COLUMN "tags" DROP DEFAULT,
  ALTER COLUMN "tags" TYPE jsonb USING COALESCE(to_jsonb("tags"), '[]'::jsonb),
  ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "tags" SET NOT NULL;

ALTER TABLE "Deal"
  ALTER COLUMN "tags" DROP DEFAULT,
  ALTER COLUMN "tags" TYPE jsonb USING COALESCE(to_jsonb("tags"), '[]'::jsonb),
  ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "tags" SET NOT NULL;

ALTER TABLE "Interaction"
  ALTER COLUMN "attendeeIds" DROP DEFAULT,
  ALTER COLUMN "attendeeIds" TYPE jsonb USING COALESCE(to_jsonb("attendeeIds"), '[]'::jsonb),
  ALTER COLUMN "attendeeIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "attendeeIds" SET NOT NULL;

ALTER TABLE "EmailMessage"
  ALTER COLUMN "to" DROP DEFAULT,
  ALTER COLUMN "to" TYPE jsonb USING COALESCE(to_jsonb("to"), '[]'::jsonb),
  ALTER COLUMN "to" SET NOT NULL,
  ALTER COLUMN "cc" DROP DEFAULT,
  ALTER COLUMN "cc" TYPE jsonb USING COALESCE(to_jsonb("cc"), '[]'::jsonb),
  ALTER COLUMN "cc" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "cc" SET NOT NULL,
  ALTER COLUMN "bcc" DROP DEFAULT,
  ALTER COLUMN "bcc" TYPE jsonb USING COALESCE(to_jsonb("bcc"), '[]'::jsonb),
  ALTER COLUMN "bcc" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "bcc" SET NOT NULL;

ALTER TABLE "ChannelMessage"
  ALTER COLUMN "fileIds" DROP DEFAULT,
  ALTER COLUMN "fileIds" TYPE jsonb USING COALESCE(to_jsonb("fileIds"), '[]'::jsonb),
  ALTER COLUMN "fileIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "fileIds" SET NOT NULL;

ALTER TABLE "CustomFieldDef"
  ALTER COLUMN "options" DROP DEFAULT,
  ALTER COLUMN "options" TYPE jsonb USING COALESCE(to_jsonb("options"), '[]'::jsonb),
  ALTER COLUMN "options" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "options" SET NOT NULL;

ALTER TABLE "Webhook"
  ALTER COLUMN "events" DROP DEFAULT,
  ALTER COLUMN "events" TYPE jsonb USING COALESCE(to_jsonb("events"), '[]'::jsonb),
  ALTER COLUMN "events" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "events" SET NOT NULL;

ALTER TABLE "Goal"
  ALTER COLUMN "kinds" DROP DEFAULT,
  ALTER COLUMN "kinds" TYPE jsonb USING COALESCE(to_jsonb("kinds"), '[]'::jsonb),
  ALTER COLUMN "kinds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "kinds" SET NOT NULL;

ALTER TABLE "Ticket"
  ALTER COLUMN "tags" DROP DEFAULT,
  ALTER COLUMN "tags" TYPE jsonb USING COALESCE(to_jsonb("tags"), '[]'::jsonb),
  ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "tags" SET NOT NULL;

ALTER TABLE "TicketMessage"
  ALTER COLUMN "fileIds" DROP DEFAULT,
  ALTER COLUMN "fileIds" TYPE jsonb USING COALESCE(to_jsonb("fileIds"), '[]'::jsonb),
  ALTER COLUMN "fileIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "fileIds" SET NOT NULL;

ALTER TABLE "BookingLink"
  ALTER COLUMN "hostIds" DROP DEFAULT,
  ALTER COLUMN "hostIds" TYPE jsonb USING COALESCE(to_jsonb("hostIds"), '[]'::jsonb),
  ALTER COLUMN "hostIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "hostIds" SET NOT NULL,
  ALTER COLUMN "durations" DROP DEFAULT,
  ALTER COLUMN "durations" TYPE jsonb USING COALESCE(to_jsonb("durations"), '[30]'::jsonb),
  ALTER COLUMN "durations" SET DEFAULT '[30]'::jsonb,
  ALTER COLUMN "durations" SET NOT NULL;

ALTER TABLE "CalendarConnection"
  ALTER COLUMN "busyCalendarIds" DROP DEFAULT,
  ALTER COLUMN "busyCalendarIds" TYPE jsonb USING COALESCE(to_jsonb("busyCalendarIds"), '[]'::jsonb),
  ALTER COLUMN "busyCalendarIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "busyCalendarIds" SET NOT NULL;

ALTER TABLE "DeletedRecord"
  ALTER COLUMN "fileIds" DROP DEFAULT,
  ALTER COLUMN "fileIds" TYPE jsonb USING COALESCE(to_jsonb("fileIds"), '[]'::jsonb),
  ALTER COLUMN "fileIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "fileIds" SET NOT NULL;

ALTER TABLE "DuplicatePair"
  ALTER COLUMN "reasons" DROP DEFAULT,
  ALTER COLUMN "reasons" TYPE jsonb USING COALESCE(to_jsonb("reasons"), '[]'::jsonb),
  ALTER COLUMN "reasons" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "reasons" SET NOT NULL;

ALTER TABLE "Import"
  ALTER COLUMN "headers" DROP DEFAULT,
  ALTER COLUMN "headers" TYPE jsonb USING COALESCE(to_jsonb("headers"), '[]'::jsonb),
  ALTER COLUMN "headers" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "headers" SET NOT NULL;

ALTER TABLE "Export"
  ALTER COLUMN "columns" DROP DEFAULT,
  ALTER COLUMN "columns" TYPE jsonb USING COALESCE(to_jsonb("columns"), '[]'::jsonb),
  ALTER COLUMN "columns" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "columns" SET NOT NULL;

ALTER TABLE "ReportSchedule"
  ALTER COLUMN "userIds" DROP DEFAULT,
  ALTER COLUMN "userIds" TYPE jsonb USING COALESCE(to_jsonb("userIds"), '[]'::jsonb),
  ALTER COLUMN "userIds" SET NOT NULL,
  ALTER COLUMN "emails" DROP DEFAULT,
  ALTER COLUMN "emails" TYPE jsonb USING COALESCE(to_jsonb("emails"), '[]'::jsonb),
  ALTER COLUMN "emails" SET NOT NULL;

ALTER TABLE "ReportScheduleSend"
  ALTER COLUMN "delivered" DROP DEFAULT,
  ALTER COLUMN "delivered" TYPE jsonb USING COALESCE(to_jsonb("delivered"), '[]'::jsonb),
  ALTER COLUMN "delivered" SET NOT NULL;

CREATE INDEX "Company_tags_idx" ON "Company" USING GIN ("tags" jsonb_path_ops);
CREATE INDEX "Contact_tags_idx" ON "Contact" USING GIN ("tags" jsonb_path_ops);
CREATE INDEX "Deal_tags_idx" ON "Deal" USING GIN ("tags" jsonb_path_ops);
CREATE INDEX "Ticket_tags_idx" ON "Ticket" USING GIN ("tags" jsonb_path_ops);

COMMIT;
