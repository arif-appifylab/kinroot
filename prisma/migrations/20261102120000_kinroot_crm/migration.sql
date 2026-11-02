-- Kinroot CRM: every table of the Kinroot app, on top of the template's tables.
-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "LifecycleStage" AS ENUM ('LEAD', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CHURNED', 'OTHER');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('TODO', 'CALL', 'EMAIL', 'MEETING', 'DEADLINE');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('NONE', 'LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "InteractionKind" AS ENUM ('CALL', 'MEETING', 'EMAIL', 'SMS', 'LINKEDIN', 'WHATSAPP', 'POSTAL');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('SMTP', 'RESEND', 'POSTMARK', 'SENDGRID', 'MAILGUN', 'GMAIL', 'OUTLOOK');

-- CreateEnum
CREATE TYPE "EmailAccountStatus" AS ENUM ('CONNECTED', 'ERROR', 'PENDING');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "ChannelMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('CONTACT', 'COMPANY', 'DEAL');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'CURRENCY', 'DATE', 'SELECT', 'MULTISELECT', 'URL', 'CHECKBOX');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ListKind" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'WAITING_ON_CONTACT', 'WAITING_ON_US', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('EMAIL', 'FORM', 'PORTAL', 'MANUAL', 'WEBHOOK', 'API');

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "userId" INTEGER,
    "name" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "avatarUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "inviteEmail" TEXT,
    "inviteTokenHash" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "type" TEXT,
    "employees" INTEGER,
    "annualRevenue" DOUBLE PRECISION,
    "timezone" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "linkedin" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "linkedin" TEXT,
    "lifecycleStage" "LifecycleStage" NOT NULL DEFAULT 'LEAD',
    "leadStatus" TEXT,
    "buyingRole" TEXT,
    "emailOptOut" BOOLEAN NOT NULL DEFAULT false,
    "city" TEXT,
    "country" TEXT,
    "source" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactCompany" (
    "contactId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactCompany_pkey" PRIMARY KEY ("contactId","companyId")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "rottingDays" INTEGER NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 10,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "lostReason" TEXT,
    "expectedCloseDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "companyId" TEXT,
    "ownerId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom" JSONB NOT NULL DEFAULT '{}',
    "type" TEXT,
    "priority" TEXT,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "forecastCategory" TEXT,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealCompany" (
    "dealId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DealCompany_pkey" PRIMARY KEY ("dealId","companyId")
);

-- CreateTable
CREATE TABLE "DealContact" (
    "dealId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    CONSTRAINT "DealContact_pkey" PRIMARY KEY ("dealId","contactId")
);

-- CreateTable
CREATE TABLE "StageChange" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "TaskType" NOT NULL DEFAULT 'TODO',
    "priority" "Priority" NOT NULL DEFAULT 'NONE',
    "dueAt" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "repeat" TEXT,
    "queue" TEXT,
    "reminderAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "creatorId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "text" TEXT,
    "refId" TEXT,
    "actorId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityComment" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "kind" "InteractionKind" NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMin" INTEGER,
    "outcome" TEXT,
    "direction" TEXT,
    "locationType" TEXT,
    "location" TEXT,
    "attendeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "userId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "EmailAccountStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "trackOpens" BOOLEAN NOT NULL DEFAULT true,
    "trackClicks" BOOLEAN NOT NULL DEFAULT true,
    "dailyLimit" INTEGER NOT NULL DEFAULT 300,
    "signature" TEXT,
    "syncCursor" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "replyTo" TEXT,
    "forwardReplies" BOOLEAN NOT NULL DEFAULT false,
    "signatureHtml" TEXT,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "accountId" TEXT,
    "externalThreadId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "spamAt" TIMESTAMP(3),
    "trashedAt" TIMESTAMP(3),
    "firstInboundAt" TIMESTAMP(3),
    "waitingSince" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "formSubmissionId" TEXT,
    "identityId" TEXT,
    "contactTypingAt" TIMESTAMP(3),
    "teamTypingAt" TIMESTAMP(3),

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationComment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'comment',
    "body" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL DEFAULT '{}',
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "accountId" TEXT,
    "direction" "EmailDirection" NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "to" TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "externalId" TEXT,
    "error" TEXT,
    "trackingId" TEXT,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt" TIMESTAMP(3),
    "senderId" TEXT,
    "contactId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" "EmailDirection" NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "status" "ChannelMessageStatus" NOT NULL DEFAULT 'SENT',
    "text" TEXT NOT NULL DEFAULT '',
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identityId" TEXT,
    "senderId" TEXT,
    "contactId" TEXT,
    "externalId" TEXT,
    "error" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "emailMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelIdentity" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "contactId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "blockedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateHit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "html" TEXT,
    "preheader" TEXT,
    "layout" TEXT NOT NULL DEFAULT 'plain',
    "category" TEXT,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDef" (
    "id" TEXT NOT NULL,
    "entity" "EntityType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "entity" "EntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entity" TEXT,
    "recordId" TEXT,
    "actorId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" INTEGER,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingWebhook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "action" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "verify" TEXT NOT NULL DEFAULT 'none',
    "verifyHeader" TEXT,
    "verifyEncoding" TEXT,
    "secret" TEXT,
    "listenUntil" TIMESTAMP(3),
    "sample" JSONB,
    "sampleAt" TIMESTAMP(3),
    "lastRequestAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomingWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingWebhookRequest" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "contentType" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingWebhookRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataInRequest" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "keyName" TEXT,
    "keyPrefix" TEXT,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "errorCode" TEXT,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "replayed" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT,
    "response" JSONB,
    "records" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataInRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataInIdempotency" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataInIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataInSignature" (
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataInSignature_pkey" PRIMARY KEY ("signature")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageId" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT NOT NULL DEFAULT 'attachment',
    "uploadedById" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "actorId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "userId" TEXT NOT NULL,
    "entity" "EntityType" NOT NULL,
    "recordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("userId","entity","recordId")
);

-- CreateTable
CREATE TABLE "Form" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "views" INTEGER NOT NULL DEFAULT 0,
    "starts" INTEGER NOT NULL DEFAULT 0,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "lastSubmissionAt" TIMESTAMP(3),
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "email" TEXT,
    "contactId" TEXT,
    "dealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "ListKind" NOT NULL DEFAULT 'STATIC',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactListMember" (
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "source" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactListMember_pkey" PRIMARY KEY ("listId","contactId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardWidget" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT 'medium',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DashboardWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTH',
    "target" DOUBLE PRECISION NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "descriptionHtml" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "category" TEXT,
    "queue" TEXT,
    "source" "TicketSource" NOT NULL DEFAULT 'MANUAL',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigneeId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "emailThreadId" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "firstResponseDueAt" TIMESTAMP(3),
    "firstResponseBreachedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolutionDueAt" TIMESTAMP(3),
    "resolutionBreachedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "csatRating" INTEGER,
    "csatComment" TEXT,
    "csatAt" TIMESTAMP(3),
    "csatSentAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT,
    "via" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "html" TEXT,
    "authorId" TEXT,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "emailMessageId" TEXT,
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CannedReply" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "html" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulingProfile" (
    "userId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulingProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "BookingLink" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'personal',
    "userId" TEXT,
    "hostIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durations" INTEGER[] DEFAULT ARRAY[30]::INTEGER[],
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "availability" JSONB NOT NULL DEFAULT '{}',
    "bufferBefore" INTEGER NOT NULL DEFAULT 0,
    "bufferAfter" INTEGER NOT NULL DEFAULT 0,
    "minNoticeMin" INTEGER NOT NULL DEFAULT 240,
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 60,
    "dailyLimit" INTEGER,
    "slotStepMin" INTEGER,
    "locationType" TEXT NOT NULL DEFAULT 'VIDEO',
    "location" TEXT,
    "questions" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bookingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "linkId" TEXT,
    "hostId" TEXT,
    "interactionId" TEXT,
    "contactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "company" TEXT,
    "notes" TEXT,
    "locationType" TEXT,
    "location" TEXT,
    "source" TEXT NOT NULL DEFAULT 'page',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "cancelReason" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "calendars" JSONB NOT NULL DEFAULT '[]',
    "busyCalendarIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetCalendarId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "syncMeetings" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "interactionId" TEXT,
    "changeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "listId" TEXT,
    "listName" TEXT NOT NULL,
    "accountId" TEXT,
    "createdById" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "preheader" TEXT,
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "waitingUntil" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "excluded" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "contactId" TEXT,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "points" INTEGER NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "event" TEXT,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "limitCount" INTEGER,
    "limitDays" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoreRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreEvent" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "eventType" TEXT,
    "eventId" TEXT,
    "refId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entity" TEXT,
    "recordId" TEXT,
    "label" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorEmail" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletedRecord" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL,
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedById" TEXT,
    "deletedByName" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeletedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicatePair" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dismissedById" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DuplicatePair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "object" TEXT NOT NULL,
    "triggerKind" TEXT NOT NULL,
    "triggerEvent" TEXT,
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "reenroll" TEXT NOT NULL DEFAULT 'always',
    "reenrollDays" INTEGER,
    "activeFrom" TIMESTAMP(3),
    "activeUntil" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "origin" TEXT NOT NULL DEFAULT '',
    "webhookSecret" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "cursorAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3),
    "failureStreak" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "recordId" TEXT,
    "recordLabel" TEXT,
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "source" TEXT NOT NULL,
    "eventType" TEXT,
    "dedupeKey" TEXT,
    "chainId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "cursor" TEXT,
    "waitUntil" TIMESTAMP(3),
    "error" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "test" TEXT,
    "definition" JSONB,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationFire" (
    "automationId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationFire_pkey" PRIMARY KEY ("automationId","recordId","value")
);

-- CreateTable
CREATE TABLE "Import" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "fileName" TEXT NOT NULL,
    "fileId" TEXT,
    "errorFileId" TEXT,
    "userId" TEXT,
    "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "options" JSONB NOT NULL DEFAULT '{}',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "preview" JSONB,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "token" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportIssue" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "column" TEXT,
    "message" TEXT NOT NULL,

    CONSTRAINT "ImportIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Export" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "userId" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "listId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileId" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "emailMe" BOOLEAN NOT NULL DEFAULT false,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT,
    "error" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "dashboardId" TEXT,
    "ownerId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "monthDay" INTEGER,
    "time" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "userIds" TEXT[],
    "emails" TEXT[],
    "subject" TEXT,
    "note" TEXT,
    "range" TEXT NOT NULL DEFAULT 'report',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL DEFAULT '',
    "cursor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRunAt" TIMESTAMP(3),
    "lastSlotAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportScheduleSend" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "slotAt" TIMESTAMP(3) NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "delivered" TEXT[],
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportScheduleSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobBacklog" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBacklog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportChunk" (
    "exportId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "ExportChunk_pkey" PRIMARY KEY ("exportId","seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_userId_key" ON "Member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_inviteEmail_key" ON "Member"("inviteEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Member_inviteTokenHash_key" ON "Member"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "Company_domain_idx" ON "Company"("domain");

-- CreateIndex
CREATE INDEX "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_ownerId_idx" ON "Company"("ownerId");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_score_idx" ON "Contact"("score");

-- CreateIndex
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");

-- CreateIndex
CREATE INDEX "Contact_lastName_firstName_idx" ON "Contact"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "ContactCompany_companyId_idx" ON "ContactCompany"("companyId");

-- CreateIndex
CREATE INDEX "Stage_pipelineId_position_idx" ON "Stage"("pipelineId", "position");

-- CreateIndex
CREATE INDEX "Deal_pipelineId_stageId_position_idx" ON "Deal"("pipelineId", "stageId", "position");

-- CreateIndex
CREATE INDEX "Deal_status_idx" ON "Deal"("status");

-- CreateIndex
CREATE INDEX "Deal_ownerId_idx" ON "Deal"("ownerId");

-- CreateIndex
CREATE INDEX "Deal_companyId_idx" ON "Deal"("companyId");

-- CreateIndex
CREATE INDEX "DealCompany_companyId_idx" ON "DealCompany"("companyId");

-- CreateIndex
CREATE INDEX "DealContact_contactId_idx" ON "DealContact"("contactId");

-- CreateIndex
CREATE INDEX "StageChange_dealId_createdAt_idx" ON "StageChange"("dealId", "createdAt");

-- CreateIndex
CREATE INDEX "Note_contactId_idx" ON "Note"("contactId");

-- CreateIndex
CREATE INDEX "Note_companyId_idx" ON "Note"("companyId");

-- CreateIndex
CREATE INDEX "Note_dealId_idx" ON "Note"("dealId");

-- CreateIndex
CREATE INDEX "Task_assigneeId_done_dueAt_idx" ON "Task"("assigneeId", "done", "dueAt");

-- CreateIndex
CREATE INDEX "Task_assigneeId_reminderAt_idx" ON "Task"("assigneeId", "reminderAt");

-- CreateIndex
CREATE INDEX "Task_dealId_idx" ON "Task"("dealId");

-- CreateIndex
CREATE INDEX "Task_contactId_idx" ON "Task"("contactId");

-- CreateIndex
CREATE INDEX "Task_companyId_idx" ON "Task"("companyId");

-- CreateIndex
CREATE INDEX "Activity_contactId_createdAt_idx" ON "Activity"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_companyId_createdAt_idx" ON "Activity"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_dealId_createdAt_idx" ON "Activity"("dealId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_createdAt_idx" ON "Activity"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityComment_activityId_createdAt_idx" ON "ActivityComment"("activityId", "createdAt");

-- CreateIndex
CREATE INDEX "Interaction_contactId_occurredAt_idx" ON "Interaction"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "Interaction_companyId_occurredAt_idx" ON "Interaction"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "Interaction_dealId_occurredAt_idx" ON "Interaction"("dealId", "occurredAt");

-- CreateIndex
CREATE INDEX "Interaction_kind_occurredAt_idx" ON "Interaction"("kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThread_formSubmissionId_key" ON "EmailThread"("formSubmissionId");

-- CreateIndex
CREATE INDEX "EmailThread_accountId_externalThreadId_idx" ON "EmailThread"("accountId", "externalThreadId");

-- CreateIndex
CREATE INDEX "EmailThread_contactId_idx" ON "EmailThread"("contactId");

-- CreateIndex
CREATE INDEX "EmailThread_dealId_idx" ON "EmailThread"("dealId");

-- CreateIndex
CREATE INDEX "EmailThread_lastMessageAt_idx" ON "EmailThread"("lastMessageAt");

-- CreateIndex
CREATE INDEX "EmailThread_status_assigneeId_idx" ON "EmailThread"("status", "assigneeId");

-- CreateIndex
CREATE INDEX "EmailThread_assigneeId_idx" ON "EmailThread"("assigneeId");

-- CreateIndex
CREATE INDEX "EmailThread_snoozedUntil_idx" ON "EmailThread"("snoozedUntil");

-- CreateIndex
CREATE INDEX "EmailThread_trashedAt_idx" ON "EmailThread"("trashedAt");

-- CreateIndex
CREATE INDEX "EmailThread_identityId_idx" ON "EmailThread"("identityId");

-- CreateIndex
CREATE INDEX "ConversationComment_threadId_createdAt_idx" ON "ConversationComment"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_trackingId_key" ON "EmailMessage"("trackingId");

-- CreateIndex
CREATE INDEX "EmailMessage_threadId_sentAt_idx" ON "EmailMessage"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX "EmailMessage_accountId_externalId_idx" ON "EmailMessage"("accountId", "externalId");

-- CreateIndex
CREATE INDEX "EmailMessage_messageId_idx" ON "EmailMessage"("messageId");

-- CreateIndex
CREATE INDEX "EmailMessage_accountId_sentAt_idx" ON "EmailMessage"("accountId", "sentAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_threadId_createdAt_idx" ON "ChannelMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_identityId_idx" ON "ChannelMessage"("identityId");

-- CreateIndex
CREATE INDEX "ChannelMessage_contactId_idx" ON "ChannelMessage"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_channel_externalId_key" ON "ChannelMessage"("channel", "externalId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_contactId_idx" ON "ChannelIdentity"("contactId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_email_idx" ON "ChannelIdentity"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIdentity_channel_externalId_key" ON "ChannelIdentity"("channel", "externalId");

-- CreateIndex
CREATE INDEX "RateHit_key_at_idx" ON "RateHit"("key", "at");

-- CreateIndex
CREATE INDEX "TrackingEvent_messageId_idx" ON "TrackingEvent"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDef_entity_key_key" ON "CustomFieldDef"("entity", "key");

-- CreateIndex
CREATE INDEX "SavedView_entity_idx" ON "SavedView"("entity");

-- CreateIndex
CREATE INDEX "Event_type_createdAt_idx" ON "Event"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Event_entity_recordId_idx" ON "Event"("entity", "recordId");

-- CreateIndex
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingWebhook_tokenHash_key" ON "IncomingWebhook"("tokenHash");

-- CreateIndex
CREATE INDEX "IncomingWebhookRequest_webhookId_createdAt_idx" ON "IncomingWebhookRequest"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "IncomingWebhookRequest_createdAt_idx" ON "IncomingWebhookRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingWebhookRequest_webhookId_idempotencyKey_key" ON "IncomingWebhookRequest"("webhookId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "DataInRequest_createdAt_idx" ON "DataInRequest"("createdAt");

-- CreateIndex
CREATE INDEX "DataInRequest_action_createdAt_idx" ON "DataInRequest"("action", "createdAt");

-- CreateIndex
CREATE INDEX "DataInIdempotency_createdAt_idx" ON "DataInIdempotency"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DataInIdempotency_apiKeyId_key_key" ON "DataInIdempotency"("apiKeyId", "key");

-- CreateIndex
CREATE INDEX "DataInSignature_createdAt_idx" ON "DataInSignature"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "File_storageId_key" ON "File"("storageId");

-- CreateIndex
CREATE INDEX "File_contactId_idx" ON "File"("contactId");

-- CreateIndex
CREATE INDEX "File_companyId_idx" ON "File"("companyId");

-- CreateIndex
CREATE INDEX "File_dealId_idx" ON "File"("dealId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Follow_entity_recordId_idx" ON "Follow"("entity", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "Form_slug_key" ON "Form"("slug");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_createdAt_idx" ON "FormSubmission"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_contactId_idx" ON "FormSubmission"("contactId");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_email_idx" ON "FormSubmission"("formId", "email");

-- CreateIndex
CREATE INDEX "ContactList_name_idx" ON "ContactList"("name");

-- CreateIndex
CREATE INDEX "ContactListMember_contactId_idx" ON "ContactListMember"("contactId");

-- CreateIndex
CREATE INDEX "DashboardWidget_dashboardId_position_idx" ON "DashboardWidget"("dashboardId", "position");

-- CreateIndex
CREATE INDEX "Goal_userId_idx" ON "Goal"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_emailThreadId_key" ON "Ticket"("emailThreadId");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_status_idx" ON "Ticket"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Ticket_contactId_idx" ON "Ticket"("contactId");

-- CreateIndex
CREATE INDEX "Ticket_companyId_idx" ON "Ticket"("companyId");

-- CreateIndex
CREATE INDEX "Ticket_dealId_idx" ON "Ticket"("dealId");

-- CreateIndex
CREATE INDEX "Ticket_lastMessageAt_idx" ON "Ticket"("lastMessageAt");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketMessage_emailMessageId_idx" ON "TicketMessage"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulingProfile_handle_key" ON "SchedulingProfile"("handle");

-- CreateIndex
CREATE INDEX "BookingLink_kind_slug_idx" ON "BookingLink"("kind", "slug");

-- CreateIndex
CREATE INDEX "BookingLink_userId_idx" ON "BookingLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_interactionId_key" ON "Booking"("interactionId");

-- CreateIndex
CREATE INDEX "Booking_hostId_startAt_idx" ON "Booking"("hostId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_linkId_startAt_idx" ON "Booking"("linkId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_email_idx" ON "Booking"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_userId_provider_email_key" ON "CalendarConnection"("userId", "provider", "email");

-- CreateIndex
CREATE INDEX "CalendarEvent_interactionId_idx" ON "CalendarEvent"("interactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_connectionId_externalId_key" ON "CalendarEvent"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "Broadcast_listId_createdAt_idx" ON "Broadcast"("listId", "createdAt");

-- CreateIndex
CREATE INDEX "Broadcast_status_idx" ON "Broadcast"("status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON "BroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_contactId_idx" ON "BroadcastRecipient"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_email_key" ON "BroadcastRecipient"("broadcastId", "email");

-- CreateIndex
CREATE INDEX "ScoreRule_kind_enabled_idx" ON "ScoreRule"("kind", "enabled");

-- CreateIndex
CREATE INDEX "ScoreRule_event_idx" ON "ScoreRule"("event");

-- CreateIndex
CREATE INDEX "ScoreEvent_contactId_createdAt_idx" ON "ScoreEvent"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "ScoreEvent_ruleId_contactId_idx" ON "ScoreEvent"("ruleId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreEvent_ruleId_eventId_contactId_key" ON "ScoreEvent"("ruleId", "eventId", "contactId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_recordId_idx" ON "AuditLog"("entity", "recordId");

-- CreateIndex
CREATE INDEX "AuditLog_category_createdAt_idx" ON "AuditLog"("category", "createdAt");

-- CreateIndex
CREATE INDEX "DeletedRecord_entity_deletedAt_idx" ON "DeletedRecord"("entity", "deletedAt");

-- CreateIndex
CREATE INDEX "DeletedRecord_deletedById_deletedAt_idx" ON "DeletedRecord"("deletedById", "deletedAt");

-- CreateIndex
CREATE INDEX "DeletedRecord_expiresAt_idx" ON "DeletedRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "DeletedRecord_recordId_idx" ON "DeletedRecord"("recordId");

-- CreateIndex
CREATE INDEX "DuplicatePair_entity_status_score_idx" ON "DuplicatePair"("entity", "status", "score");

-- CreateIndex
CREATE INDEX "DuplicatePair_bId_idx" ON "DuplicatePair"("bId");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicatePair_entity_aId_bId_key" ON "DuplicatePair"("entity", "aId", "bId");

-- CreateIndex
CREATE INDEX "Automation_enabled_triggerKind_idx" ON "Automation"("enabled", "triggerKind");

-- CreateIndex
CREATE INDEX "Automation_triggerEvent_idx" ON "Automation"("triggerEvent");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_dedupeKey_key" ON "AutomationRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt");

-- CreateIndex
CREATE INDEX "AutomationRun_recordId_startedAt_idx" ON "AutomationRun"("recordId", "startedAt");

-- CreateIndex
CREATE INDEX "AutomationRun_status_startedAt_idx" ON "AutomationRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AutomationRunStep_runId_startedAt_idx" ON "AutomationRunStep"("runId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRunStep_runId_stepId_key" ON "AutomationRunStep"("runId", "stepId");

-- CreateIndex
CREATE INDEX "Import_userId_createdAt_idx" ON "Import"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Import_status_createdAt_idx" ON "Import"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportIssue_importId_phase_row_idx" ON "ImportIssue"("importId", "phase", "row");

-- CreateIndex
CREATE INDEX "Export_userId_createdAt_idx" ON "Export"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Export_status_createdAt_idx" ON "Export"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_active_nextRunAt_idx" ON "ReportSchedule"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_ownerId_idx" ON "ReportSchedule"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportScheduleSend_scheduleId_slotAt_key" ON "ReportScheduleSend"("scheduleId", "slotAt");

-- CreateIndex
CREATE INDEX "JobBacklog_runAt_idx" ON "JobBacklog"("runAt");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactCompany" ADD CONSTRAINT "ContactCompany_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactCompany" ADD CONSTRAINT "ContactCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealCompany" ADD CONSTRAINT "DealCompany_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealCompany" ADD CONSTRAINT "DealCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealContact" ADD CONSTRAINT "DealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealContact" ADD CONSTRAINT "DealContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageChange" ADD CONSTRAINT "StageChange_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageChange" ADD CONSTRAINT "StageChange_fromStageId_fkey" FOREIGN KEY ("fromStageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageChange" ADD CONSTRAINT "StageChange_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageChange" ADD CONSTRAINT "StageChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityComment" ADD CONSTRAINT "ActivityComment_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityComment" ADD CONSTRAINT "ActivityComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ChannelIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationComment" ADD CONSTRAINT "ConversationComment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationComment" ADD CONSTRAINT "ConversationComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ChannelIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelIdentity" ADD CONSTRAINT "ChannelIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingWebhookRequest" ADD CONSTRAINT "IncomingWebhookRequest_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "IncomingWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataInRequest" ADD CONSTRAINT "DataInRequest_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulingProfile" ADD CONSTRAINT "SchedulingProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "BookingLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ScoreRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunStep" ADD CONSTRAINT "AutomationRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFire" ADD CONSTRAINT "AutomationFire_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_errorFileId_fkey" FOREIGN KEY ("errorFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_importId_fkey" FOREIGN KEY ("importId") REFERENCES "Import"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportScheduleSend" ADD CONSTRAINT "ReportScheduleSend_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportChunk" ADD CONSTRAINT "ExportChunk_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "Export"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
