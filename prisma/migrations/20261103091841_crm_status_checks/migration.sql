-- Audit P3-14 (part 1): CHECK constraints on the small fixed string sets (docs/agent/database.md ›
-- Constraints): the column refuses a value the code never writes. Each allowed list is every value
-- the server code writes to that column (src/server/crm/**: validators, typed unions, literals), checked
-- against the seed, the tests and the data already stored. NULL stays allowed on the nullable columns.
-- Left without a CHECK on purpose (open-ended, grow with features, or free text): Activity.type,
-- Event.type/entity, Notification.type, ContactListMember.source, ChannelMessage.channel,
-- ChannelIdentity.channel, Deal.type/priority (free text), Ticket.category/queue, AuditLog.entity.
-- Adding a value later = this list + a new migration that drops and re-adds that one constraint.
--
-- Added NOT VALID (no scan under the ADD's lock), then VALIDATE CONSTRAINT checks the existing rows.
BEGIN;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_object_check" CHECK ("object" IN ('contact', 'company', 'deal', 'ticket', 'none')) NOT VALID;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_triggerKind_check" CHECK ("triggerKind" IN ('event', 'date', 'inactivity', 'manual')) NOT VALID;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_reenroll_check" CHECK ("reenroll" IN ('always', 'never', 'after')) NOT VALID;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_object_check" CHECK ("object" IN ('contact', 'company', 'deal', 'ticket', 'none')) NOT VALID;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_status_check" CHECK ("status" IN ('running', 'waiting', 'done', 'failed', 'skipped', 'canceled')) NOT VALID;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_source_check" CHECK ("source" IN ('event', 'date', 'inactivity', 'manual', 'list', 'test')) NOT VALID;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_test_check" CHECK ("test" IN ('quick', 'timed', 'record')) NOT VALID;
ALTER TABLE "AutomationRunStep" ADD CONSTRAINT "AutomationRunStep_status_check" CHECK ("status" IN ('running', 'done', 'skipped', 'failed')) NOT VALID;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_category_check" CHECK ("category" IN ('record', 'auth', 'team', 'settings', 'export', 'security')) NOT VALID;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_status_check" CHECK ("status" IN ('CONFIRMED', 'CANCELED')) NOT VALID;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_source_check" CHECK ("source" IN ('page', 'widget', 'form')) NOT VALID;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_locationType_check" CHECK ("locationType" IN ('VIDEO', 'PHONE', 'IN_PERSON', 'OTHER')) NOT VALID;
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_kind_check" CHECK ("kind" IN ('personal', 'team')) NOT VALID;
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_locationType_check" CHECK ("locationType" IN ('VIDEO', 'PHONE', 'IN_PERSON', 'OTHER')) NOT VALID;
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_status_check" CHECK ("status" IN ('SCHEDULED', 'SENDING', 'SENT', 'CANCELED')) NOT VALID;
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELED')) NOT VALID;
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_provider_check" CHECK ("provider" IN ('google', 'microsoft')) NOT VALID;
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_status_check" CHECK ("status" IN ('CONNECTED', 'ERROR')) NOT VALID;
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_kind_check" CHECK ("kind" IN ('text', 'auto')) NOT VALID;
ALTER TABLE "ConversationComment" ADD CONSTRAINT "ConversationComment_kind_check" CHECK ("kind" IN ('comment', 'event')) NOT VALID;
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_size_check" CHECK ("size" IN ('small', 'medium', 'large')) NOT VALID;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_forecastCategory_check" CHECK ("forecastCategory" IN ('PIPELINE', 'BEST_CASE', 'COMMIT', 'OMIT')) NOT VALID;
ALTER TABLE "DeletedRecord" ADD CONSTRAINT "DeletedRecord_entity_check" CHECK ("entity" IN ('contact', 'company', 'deal', 'ticket', 'form', 'list', 'conversation')) NOT VALID;
ALTER TABLE "DuplicatePair" ADD CONSTRAINT "DuplicatePair_entity_check" CHECK ("entity" IN ('contact', 'company')) NOT VALID;
ALTER TABLE "DuplicatePair" ADD CONSTRAINT "DuplicatePair_status_check" CHECK ("status" IN ('open', 'dismissed')) NOT VALID;
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_layout_check" CHECK ("layout" IN ('plain', 'branded')) NOT VALID;
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_channel_check" CHECK ("channel" IN ('email', 'form', 'chat', 'ticket')) NOT VALID;
ALTER TABLE "Export" ADD CONSTRAINT "Export_entity_check" CHECK ("entity" IN ('contact', 'company', 'deal')) NOT VALID;
ALTER TABLE "Export" ADD CONSTRAINT "Export_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed')) NOT VALID;
ALTER TABLE "File" ADD CONSTRAINT "File_purpose_check" CHECK ("purpose" IN ('attachment', 'public', 'form', 'form_pending', 'chat', 'chat_pending', 'ticket', 'import', 'import_errors', 'export', 'trash')) NOT VALID;
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_metric_check" CHECK ("metric" IN ('won_revenue', 'deals_won', 'activities')) NOT VALID;
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_period_check" CHECK ("period" IN ('MONTH', 'QUARTER')) NOT VALID;
ALTER TABLE "Import" ADD CONSTRAINT "Import_entity_check" CHECK ("entity" IN ('contact', 'company', 'deal')) NOT VALID;
ALTER TABLE "Import" ADD CONSTRAINT "Import_status_check" CHECK ("status" IN ('draft', 'validating', 'ready', 'queued', 'running', 'done', 'failed', 'canceled')) NOT VALID;
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_phase_check" CHECK ("phase" IN ('validate', 'run')) NOT VALID;
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_level_check" CHECK ("level" IN ('error', 'warning')) NOT VALID;
ALTER TABLE "IncomingWebhook" ADD CONSTRAINT "IncomingWebhook_action_check" CHECK ("action" IN ('contact', 'company', 'deal', 'ticket', 'automations')) NOT VALID;
ALTER TABLE "IncomingWebhook" ADD CONSTRAINT "IncomingWebhook_verify_check" CHECK ("verify" IN ('none', 'header', 'hmac')) NOT VALID;
ALTER TABLE "IncomingWebhook" ADD CONSTRAINT "IncomingWebhook_verifyEncoding_check" CHECK ("verifyEncoding" IN ('hex', 'base64')) NOT VALID;
ALTER TABLE "IncomingWebhook" ADD CONSTRAINT "IncomingWebhook_lastStatus_check" CHECK ("lastStatus" IN ('accepted', 'processed', 'failed', 'duplicate', 'rejected', 'captured')) NOT VALID;
ALTER TABLE "IncomingWebhookRequest" ADD CONSTRAINT "IncomingWebhookRequest_status_check" CHECK ("status" IN ('accepted', 'processed', 'failed', 'duplicate', 'rejected', 'captured')) NOT VALID;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_direction_check" CHECK ("direction" IN ('INBOUND', 'OUTBOUND')) NOT VALID;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_locationType_check" CHECK ("locationType" IN ('VIDEO', 'PHONE', 'IN_PERSON', 'OTHER')) NOT VALID;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_frequency_check" CHECK ("frequency" IN ('daily', 'weekly', 'monthly')) NOT VALID;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_range_check" CHECK ("range" IN ('report', 'previous')) NOT VALID;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_lastStatus_check" CHECK ("lastStatus" IN ('sent', 'failed', 'no_mailbox', 'partial')) NOT VALID;
ALTER TABLE "ReportScheduleSend" ADD CONSTRAINT "ReportScheduleSend_status_check" CHECK ("status" IN ('pending', 'sent', 'failed', 'no_mailbox')) NOT VALID;
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_kind_check" CHECK ("kind" IN ('property', 'behavior')) NOT VALID;
ALTER TABLE "ScoreRule" ADD CONSTRAINT "ScoreRule_kind_check" CHECK ("kind" IN ('property', 'behavior')) NOT VALID;
ALTER TABLE "Task" ADD CONSTRAINT "Task_repeat_check" CHECK ("repeat" IN ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')) NOT VALID;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_kind_check" CHECK ("kind" IN ('reply', 'note', 'event')) NOT VALID;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_direction_check" CHECK ("direction" IN ('INBOUND', 'OUTBOUND')) NOT VALID;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_via_check" CHECK ("via" IN ('app', 'email', 'portal', 'form')) NOT VALID;
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_type_check" CHECK ("type" IN ('open', 'click')) NOT VALID;

ALTER TABLE "Automation" VALIDATE CONSTRAINT "Automation_object_check";
ALTER TABLE "Automation" VALIDATE CONSTRAINT "Automation_triggerKind_check";
ALTER TABLE "Automation" VALIDATE CONSTRAINT "Automation_reenroll_check";
ALTER TABLE "AutomationRun" VALIDATE CONSTRAINT "AutomationRun_object_check";
ALTER TABLE "AutomationRun" VALIDATE CONSTRAINT "AutomationRun_status_check";
ALTER TABLE "AutomationRun" VALIDATE CONSTRAINT "AutomationRun_source_check";
ALTER TABLE "AutomationRun" VALIDATE CONSTRAINT "AutomationRun_test_check";
ALTER TABLE "AutomationRunStep" VALIDATE CONSTRAINT "AutomationRunStep_status_check";
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_category_check";
ALTER TABLE "Booking" VALIDATE CONSTRAINT "Booking_status_check";
ALTER TABLE "Booking" VALIDATE CONSTRAINT "Booking_source_check";
ALTER TABLE "Booking" VALIDATE CONSTRAINT "Booking_locationType_check";
ALTER TABLE "BookingLink" VALIDATE CONSTRAINT "BookingLink_kind_check";
ALTER TABLE "BookingLink" VALIDATE CONSTRAINT "BookingLink_locationType_check";
ALTER TABLE "Broadcast" VALIDATE CONSTRAINT "Broadcast_status_check";
ALTER TABLE "BroadcastRecipient" VALIDATE CONSTRAINT "BroadcastRecipient_status_check";
ALTER TABLE "CalendarConnection" VALIDATE CONSTRAINT "CalendarConnection_provider_check";
ALTER TABLE "CalendarConnection" VALIDATE CONSTRAINT "CalendarConnection_status_check";
ALTER TABLE "ChannelMessage" VALIDATE CONSTRAINT "ChannelMessage_kind_check";
ALTER TABLE "ConversationComment" VALIDATE CONSTRAINT "ConversationComment_kind_check";
ALTER TABLE "DashboardWidget" VALIDATE CONSTRAINT "DashboardWidget_size_check";
ALTER TABLE "Deal" VALIDATE CONSTRAINT "Deal_forecastCategory_check";
ALTER TABLE "DeletedRecord" VALIDATE CONSTRAINT "DeletedRecord_entity_check";
ALTER TABLE "DuplicatePair" VALIDATE CONSTRAINT "DuplicatePair_entity_check";
ALTER TABLE "DuplicatePair" VALIDATE CONSTRAINT "DuplicatePair_status_check";
ALTER TABLE "EmailTemplate" VALIDATE CONSTRAINT "EmailTemplate_layout_check";
ALTER TABLE "EmailThread" VALIDATE CONSTRAINT "EmailThread_channel_check";
ALTER TABLE "Export" VALIDATE CONSTRAINT "Export_entity_check";
ALTER TABLE "Export" VALIDATE CONSTRAINT "Export_status_check";
ALTER TABLE "File" VALIDATE CONSTRAINT "File_purpose_check";
ALTER TABLE "Goal" VALIDATE CONSTRAINT "Goal_metric_check";
ALTER TABLE "Goal" VALIDATE CONSTRAINT "Goal_period_check";
ALTER TABLE "Import" VALIDATE CONSTRAINT "Import_entity_check";
ALTER TABLE "Import" VALIDATE CONSTRAINT "Import_status_check";
ALTER TABLE "ImportIssue" VALIDATE CONSTRAINT "ImportIssue_phase_check";
ALTER TABLE "ImportIssue" VALIDATE CONSTRAINT "ImportIssue_level_check";
ALTER TABLE "IncomingWebhook" VALIDATE CONSTRAINT "IncomingWebhook_action_check";
ALTER TABLE "IncomingWebhook" VALIDATE CONSTRAINT "IncomingWebhook_verify_check";
ALTER TABLE "IncomingWebhook" VALIDATE CONSTRAINT "IncomingWebhook_verifyEncoding_check";
ALTER TABLE "IncomingWebhook" VALIDATE CONSTRAINT "IncomingWebhook_lastStatus_check";
ALTER TABLE "IncomingWebhookRequest" VALIDATE CONSTRAINT "IncomingWebhookRequest_status_check";
ALTER TABLE "Interaction" VALIDATE CONSTRAINT "Interaction_direction_check";
ALTER TABLE "Interaction" VALIDATE CONSTRAINT "Interaction_locationType_check";
ALTER TABLE "ReportSchedule" VALIDATE CONSTRAINT "ReportSchedule_frequency_check";
ALTER TABLE "ReportSchedule" VALIDATE CONSTRAINT "ReportSchedule_range_check";
ALTER TABLE "ReportSchedule" VALIDATE CONSTRAINT "ReportSchedule_lastStatus_check";
ALTER TABLE "ReportScheduleSend" VALIDATE CONSTRAINT "ReportScheduleSend_status_check";
ALTER TABLE "ScoreEvent" VALIDATE CONSTRAINT "ScoreEvent_kind_check";
ALTER TABLE "ScoreRule" VALIDATE CONSTRAINT "ScoreRule_kind_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_repeat_check";
ALTER TABLE "TicketMessage" VALIDATE CONSTRAINT "TicketMessage_kind_check";
ALTER TABLE "TicketMessage" VALIDATE CONSTRAINT "TicketMessage_direction_check";
ALTER TABLE "TicketMessage" VALIDATE CONSTRAINT "TicketMessage_via_check";
ALTER TABLE "TrackingEvent" VALIDATE CONSTRAINT "TrackingEvent_type_check";

COMMIT;
