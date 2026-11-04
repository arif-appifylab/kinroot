-- AUDIT-2 M-10: a property scoring rule awards a contact at most once while it holds. Two rescoring
-- jobs on the same contact (a merge, an import) both saw "no award yet" and both inserted one: a
-- false band change with its notifications, automations and webhooks, then a "fall" on the next
-- pass. A partial unique index makes the second insert a no-op (`createMany({skipDuplicates})`).
-- Prisma's schema can't express a partial index, so it lives here only (like a CHECK); Prisma
-- leaves it alone (database.md › Indexes: a later --create-only migration that drops it must have
-- that line removed).
BEGIN;

-- Duplicates already there: keep the oldest active award per (rule, contact), revoke the rest
-- (the next rescore would have revoked them anyway).
UPDATE "ScoreEvent" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY "ruleId", "contactId" ORDER BY "createdAt", id) AS n
    FROM "ScoreEvent"
    WHERE kind = 'property' AND "revokedAt" IS NULL AND "ruleId" IS NOT NULL
  ) d
  WHERE d.n > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScoreEvent_property_active_key" ON "ScoreEvent" ("ruleId", "contactId")
  WHERE kind = 'property' AND "revokedAt" IS NULL;

COMMIT;
