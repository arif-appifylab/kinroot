BEGIN;

-- The site's owner account is tied to an opaque id from the platform, never to an email.
ALTER TABLE "users" ADD COLUMN "platform_owner_id" VARCHAR(64);
CREATE UNIQUE INDEX "users_platform_owner_id_key" ON "users"("platform_owner_id");

-- The SITE_OWNER_ID this database last saw: a change means the site changed hands.
ALTER TABLE "auth_state" ADD COLUMN "owner_env_id" VARCHAR(64);

COMMIT;
