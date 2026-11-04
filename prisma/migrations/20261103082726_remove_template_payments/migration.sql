-- Kinroot phase 10 clean-up (owner approved): the template's checkout, orders and memberships are gone
-- (Kinroot sells nothing). The platform's own `payment_events` table stays (src/platform/payments.ts).
BEGIN;

DROP TABLE IF EXISTS "memberships";
DROP TABLE IF EXISTS "orders";

COMMIT;
