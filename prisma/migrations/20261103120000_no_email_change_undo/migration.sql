-- Only databases that ran an earlier version of this change have this column.
ALTER TABLE "email_changes" DROP COLUMN IF EXISTS "old_email";
