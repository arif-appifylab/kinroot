-- Audit P1-11: a backlog job the platform refuses for good is set aside (failedAt), not resent forever.
BEGIN;

ALTER TABLE "JobBacklog" ADD COLUMN "failedAt" TIMESTAMP(3);
CREATE INDEX "JobBacklog_failedAt_runAt_idx" ON "JobBacklog"("failedAt", "runAt");

COMMIT;
