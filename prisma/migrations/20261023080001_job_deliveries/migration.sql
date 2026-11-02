-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- MANAGED: the replay guard for signed background job deliveries
-- (src/platform/background.ts). One row per job try, across every Worker
-- instance; rows older than a day are swept on the way.

-- CreateTable
CREATE TABLE "job_deliveries" (
    "job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_deliveries_pkey" PRIMARY KEY ("job_id","attempt")
);

-- CreateIndex
CREATE INDEX "job_deliveries_seen_at_idx" ON "job_deliveries"("seen_at");

COMMIT;
