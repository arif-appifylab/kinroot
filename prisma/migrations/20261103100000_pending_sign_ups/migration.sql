-- A sign-up waiting for its emailed code: no account exists until the code proves the inbox.
CREATE TABLE "pending_sign_ups" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "browser_hash" CHAR(64) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_sign_ups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_sign_ups_email_browser_hash_key" ON "pending_sign_ups"("email", "browser_hash");
CREATE INDEX "pending_sign_ups_expires_at_idx" ON "pending_sign_ups"("expires_at");
