-- Audit P2-24: indexes for the CRM's hot reads, one per query shape (docs/agent/database.md › Indexes).
--   * Contact / Company / Deal lists: default order newest first (createdAt DESC, id DESC, the keyset
--     order) and the "last activity" sort + the "no activity for N days" automation trigger.
--   * Task (done, dueAt): the "task overdue" trigger reads open tasks by due time for every assignee.
--   * Booking (status, startAt): the "meeting starts in N" trigger reads confirmed bookings by start.
--   * EmailThread: the Spam folder (spamAt), and a PARTIAL index for the inbox views, their counts
--     (polled by the app) and the newest-first list, skipping outbound-only and spam/trashed threads.
--   * Contact lower(email): case-insensitive email lookups (support portal, broadcasts, forms, chat).
-- The partial and the expression index are SQL only (Prisma's schema can't hold them; noted next to
-- the models in schema.prisma). Plain CREATE INDEX inside the transaction: the site is not live yet and
-- these tables are small; on a big live table each would be its own CREATE INDEX CONCURRENTLY migration.
BEGIN;

CREATE INDEX "Booking_status_startAt_idx" ON "Booking"("status", "startAt");

CREATE INDEX "Company_createdAt_id_idx" ON "Company"("createdAt" DESC, "id" DESC);
CREATE INDEX "Company_lastActivityAt_idx" ON "Company"("lastActivityAt");

CREATE INDEX "Contact_createdAt_id_idx" ON "Contact"("createdAt" DESC, "id" DESC);
CREATE INDEX "Contact_lastActivityAt_idx" ON "Contact"("lastActivityAt");
CREATE INDEX "Contact_email_lower_idx" ON "Contact"(lower("email"));

CREATE INDEX "Deal_createdAt_id_idx" ON "Deal"("createdAt" DESC, "id" DESC);
CREATE INDEX "Deal_lastActivityAt_idx" ON "Deal"("lastActivityAt");

CREATE INDEX "EmailThread_spamAt_idx" ON "EmailThread"("spamAt");
CREATE INDEX "EmailThread_inbox_status_lastMessageAt_idx" ON "EmailThread"("status", "lastMessageAt" DESC)
  WHERE "firstInboundAt" IS NOT NULL AND "spamAt" IS NULL AND "trashedAt" IS NULL;

CREATE INDEX "Task_done_dueAt_idx" ON "Task"("done", "dueAt");

COMMIT;
