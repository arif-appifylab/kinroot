-- AUDIT-2 H-2 and M-9: indexes the large tables were missing.
-- H-2: WebhookDelivery.eventId. Each delivery looked up by event, and the daily prune's event
--      delete (ON DELETE CASCADE into WebhookDelivery) scanned the whole table once per event: on a
--      big table the 60 s prune job was killed and every later prune step never ran.
-- M-9: Activity.refId (edits / deletes of the note, interaction, file or chat behind a timeline
--      entry), EmailMessage.contactId (contact delete and merge: ON DELETE SET NULL), EmailThread
--      .companyId (company delete and merge), FormSubmission.dealId (deal delete and merge), and a
--      GIN jsonb_path_ops index on Interaction.attendeeIds (a contact's meetings: `@>` containment).
-- The schema declares each one (`@@index`), so `migrate dev` sees no drift. A normal CREATE INDEX
-- inside the transaction (docs/agent/database.md › Big live tables: this CRM's tables are tens of
-- thousands of rows at most); IF NOT EXISTS keeps it safe to re-run.
BEGIN;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookDelivery_eventId_idx" ON "WebhookDelivery"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Activity_refId_idx" ON "Activity"("refId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailMessage_contactId_idx" ON "EmailMessage"("contactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailThread_companyId_idx" ON "EmailThread"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FormSubmission_dealId_idx" ON "FormSubmission"("dealId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Interaction_attendeeIds_idx" ON "Interaction" USING GIN ("attendeeIds" jsonb_path_ops);

COMMIT;
