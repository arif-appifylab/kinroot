BEGIN;

-- One row per thing that must happen once: the first request runs it, a repeat gets the same answer.
CREATE TABLE "idempotency_keys" (
    "id" SERIAL NOT NULL,
    "scope" VARCHAR(120) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

COMMIT;
