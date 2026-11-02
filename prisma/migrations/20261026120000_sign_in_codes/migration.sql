-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- Sign-in codes (src/platform/auth/code-routes.ts): an account signs in with a
-- 6-digit code emailed to it, no password needed. Additive only.

-- CreateTable
CREATE TABLE "sign_in_codes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_in_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sign_in_codes_user_id_created_at_idx" ON "sign_in_codes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "sign_in_codes_expires_at_idx" ON "sign_in_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "sign_in_codes" ADD CONSTRAINT "sign_in_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
