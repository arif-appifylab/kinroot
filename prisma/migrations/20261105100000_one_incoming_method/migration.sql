-- Owner request (5 Nov): Settings → Webhooks → Incoming keeps ONE method, the Data in webhook
-- (access token in the URL + X-Signature-Token header). The other two go with their tables:
--   * "Advanced: signed requests": API keys ("ApiKey") and the used-signature log
--     ("DataInSignature"); the Data in log ("DataInRequest") loses its link to a key.
--   * Custom incoming webhooks with field mapping ("IncomingWebhook", "IncomingWebhookRequest").
-- Nothing else references these tables (checked against pg_constraint): the only foreign keys
-- into them are IncomingWebhookRequest → IncomingWebhook and DataInRequest → ApiKey, both removed
-- here first. The site was never published, so no real data is lost.
-- An idempotency row is now scoped to the sender ("url:<id>"), so its column says so.
BEGIN;

ALTER TABLE "DataInRequest" DROP CONSTRAINT IF EXISTS "DataInRequest_apiKeyId_fkey";
ALTER TABLE "DataInRequest" DROP COLUMN IF EXISTS "apiKeyId";

DROP TABLE IF EXISTS "IncomingWebhookRequest" CASCADE;
DROP TABLE IF EXISTS "IncomingWebhook" CASCADE;
DROP TABLE IF EXISTS "ApiKey" CASCADE;
DROP TABLE IF EXISTS "DataInSignature" CASCADE;

ALTER TABLE "DataInIdempotency" RENAME COLUMN "apiKeyId" TO "scope";
ALTER INDEX "DataInIdempotency_apiKeyId_key_key" RENAME TO "DataInIdempotency_scope_key_key";

-- The signed mode's encrypted signing secret, kept in the Data in settings row.
UPDATE "Setting" SET "value" = "value" - 'secret' - 'rotatedAt' WHERE "key" = 'data-in';

COMMIT;
