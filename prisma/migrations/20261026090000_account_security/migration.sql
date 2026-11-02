-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- Account security (src/platform/auth): two-step sign-in (an authenticator app
-- code or a recovery code) and moving an account to a new email address.
-- Additive only: no existing row changes.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "totp_secret_sealed" VARCHAR(255),
ADD COLUMN "totp_pending_sealed" VARCHAR(255),
ADD COLUMN "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN "totp_last_step" INTEGER;

-- CreateTable
CREATE TABLE "email_changes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "new_email" VARCHAR(254) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_changes_token_hash_key" ON "email_changes"("token_hash");

-- CreateIndex
CREATE INDEX "email_changes_user_id_created_at_idx" ON "email_changes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "email_changes_expires_at_idx" ON "email_changes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_user_id_code_hash_key" ON "recovery_codes"("user_id", "code_hash");

-- AddForeignKey
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
