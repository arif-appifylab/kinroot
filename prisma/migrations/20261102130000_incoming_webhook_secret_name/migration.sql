-- Kinroot phase 8: an incoming webhook's signing key is an owner-added site secret; the hook keeps
-- only its name. Expand step: "secret" stays until a later contract migration.
BEGIN;

ALTER TABLE "IncomingWebhook" ADD COLUMN "secretName" VARCHAR(64);

COMMIT;
