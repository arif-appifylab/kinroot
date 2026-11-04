-- AUDIT-2 M-11: the job backlog was first-in first-out, so a big import's scoring / duplicate /
-- webhook jobs held booking confirmations, form emails, SLA checks and CSAT behind them for an hour.
-- Each waiting job now has a priority (0 = someone waits for it, 1 = normal, 2 = bulk) and the drain
-- sends the lowest first, still within the per-minute rate. Rows written by the previous code get
-- the default (normal), so this is safe for it too.
BEGIN;

-- AlterTable
ALTER TABLE "JobBacklog" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 1;

-- Waiting rows already there.
UPDATE "JobBacklog" SET "priority" = 0 WHERE "failedAt" IS NULL AND list IN ('crm-booking-email', 'crm-booking-reminder', 'crm-form-after-submit', 'crm-ticket-sla-check', 'crm-ticket-csat', 'crm-email-forward-reply', 'crm-report-send', 'crm-chat-email-visitor', 'crm-inbox-wake');
UPDATE "JobBacklog" SET "priority" = 2 WHERE "failedAt" IS NULL AND list IN ('crm-scoring-events', 'crm-scoring-rescore', 'crm-scoring-recalc', 'crm-duplicates-check', 'crm-duplicates-scan', 'crm-webhook-deliver');

-- CreateIndex
CREATE INDEX "JobBacklog_failedAt_priority_runAt_idx" ON "JobBacklog"("failedAt", "priority", "runAt");

COMMIT;
