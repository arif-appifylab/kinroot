-- AUDIT-2 L-13: the "possible duplicate" hint in the create dialogs (and the duplicate check after a
-- save) matched a contact's email and phone through expressions no index served, so every keystroke
-- pause scanned the whole Contact table. These two expression indexes serve those matches
-- (lib/duplicates.ts, contactCandidates: the expressions must stay identical to emailKeySql() and the
-- phone branch); names and the work domain use the trigram indexes of crm_search_trigram.
-- Prisma's schema can't express an expression index, so they live here only; Prisma leaves them
-- alone (database.md › Indexes: a later --create-only migration that drops them must have those
-- lines removed).
BEGIN;

CREATE INDEX IF NOT EXISTS "Contact_email_key_idx" ON "Contact" ((CASE WHEN split_part(lower(trim(email)), '@', 2) IN ('gmail.com', 'googlemail.com')
  THEN replace(split_part(split_part(lower(trim(email)), '@', 1), '+', 1), '.', '') || '@gmail.com'
  ELSE split_part(split_part(lower(trim(email)), '@', 1), '+', 1) || '@' || split_part(lower(trim(email)), '@', 2) END));

CREATE INDEX IF NOT EXISTS "Contact_phone_key_idx" ON "Contact" ((right(regexp_replace(phone, '\D', '', 'g'), 10)));

COMMIT;
