-- A sign-up's code now belongs to the address, not the row. Safe on any earlier version of this change.
ALTER TABLE "pending_sign_ups" DROP COLUMN IF EXISTS "code_hash", DROP COLUMN IF EXISTS "tries";
CREATE INDEX IF NOT EXISTS "pending_sign_ups_browser_hash_idx" ON "pending_sign_ups"("browser_hash");
