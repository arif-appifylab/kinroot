-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- MANAGED: payments (src/platform/payments.ts, docs/agent/payments.md).
-- payment_events: events already handled (one row per event id; swept after 90 days).
-- orders, memberships: written by src/server/payments-hooks.ts.

-- CreateTable
CREATE TABLE "payment_events" (
    "id" VARCHAR(128) NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "checkout_id" VARCHAR(80) NOT NULL,
    "price_key" VARCHAR(63) NOT NULL,
    "mode" VARCHAR(4) NOT NULL DEFAULT 'test',
    "email" VARCHAR(254),
    "user_id" INTEGER,
    "status" VARCHAR(20) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "metadata" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" SERIAL NOT NULL,
    "subscription_id" VARCHAR(128) NOT NULL,
    "price_key" VARCHAR(63) NOT NULL,
    "mode" VARCHAR(4) NOT NULL DEFAULT 'test',
    "email" VARCHAR(254),
    "user_id" INTEGER,
    "status" VARCHAR(20) NOT NULL,
    "current_period_end" TIMESTAMP(3),
    "access_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_events_received_at_idx" ON "payment_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_checkout_id_key" ON "orders"("checkout_id");

-- CreateIndex
CREATE INDEX "orders_user_id_id_idx" ON "orders"("user_id", "id");

-- CreateIndex
CREATE INDEX "orders_email_id_idx" ON "orders"("email", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_subscription_id_key" ON "memberships"("subscription_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_price_key_idx" ON "memberships"("user_id", "price_key");

-- CreateIndex
CREATE INDEX "memberships_email_price_key_idx" ON "memberships"("email", "price_key");


COMMIT;
