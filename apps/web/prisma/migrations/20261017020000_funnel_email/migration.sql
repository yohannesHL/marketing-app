-- Campaign ownership, immutable content, stable enrollment and durable email evidence.
-- Rebuild only TrackingSource to extend its inline provider CHECK. Do not rename
-- the old parent: every existing child must continue to reference TrackingSource.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE "new_TrackingSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "provider" TEXT NOT NULL CHECK ("provider" IN ('NATIVE', 'API', 'CALENDLY', 'SHOPIFY', 'RESEND')),
    "externalAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credentialCiphertext" TEXT CHECK ("provider" != 'RESEND' OR "credentialCiphertext" IS NULL),
    "ingressTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'DISCONNECTED')),
    "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation" >= 1),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrackingSource_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TrackingSource" ("id", "ownerId", "environment", "provider", "externalAccountId", "name", "config", "credentialCiphertext", "ingressTokenHash", "status", "generation", "createdAt", "updatedAt") SELECT "id", "ownerId", "environment", "provider", "externalAccountId", "name", "config", "credentialCiphertext", "ingressTokenHash", "status", "generation", "createdAt", "updatedAt" FROM "TrackingSource";
DROP TABLE "TrackingSource";
ALTER TABLE "new_TrackingSource" RENAME TO "TrackingSource";
CREATE UNIQUE INDEX "TrackingSource_ingressTokenHash_key" ON "TrackingSource"("ingressTokenHash");
CREATE INDEX "TrackingSource_ownerId_environment_status_idx" ON "TrackingSource"("ownerId", "environment", "status");
CREATE UNIQUE INDEX "TrackingSource_id_ownerId_environment_key" ON "TrackingSource"("id", "ownerId", "environment");
CREATE UNIQUE INDEX "TrackingSource_ownerId_environment_provider_externalAccountId_key" ON "TrackingSource"("ownerId", "environment", "provider", "externalAccountId");
CREATE TRIGGER "TrackingSource_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "provider", "externalAccountId" ON "TrackingSource"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."provider" IS NOT OLD."provider" OR NEW."externalAccountId" IS NOT OLD."externalAccountId"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;
-- CreateTable
CREATE TABLE "EmailConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'RESEND',
    "credentialCiphertext" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "providerWebhookId" TEXT,
    "expectedWebhookUrlDigest" TEXT,
    "capabilities" JSONB NOT NULL,
    "readiness" JSONB NOT NULL,
    "verifiedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailConnection_sourceId_provider_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "provider", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "provider", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("provider" = 'RESEND'),
    CHECK ("credentialVersion" >= 1)
);

-- CreateTable
CREATE TABLE "EmailSender" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "replyTo" TEXT,
    "domainId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" DATETIME,
    "readiness" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailSender_connectionId_ownerId_environment_fkey" FOREIGN KEY ("connectionId", "ownerId", "environment") REFERENCES "EmailConnection" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailSender_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("status" IN ('UNVERIFIED','VERIFIED','UNAVAILABLE'))
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'EMAIL',
    "membershipScope" TEXT NOT NULL DEFAULT 'SUBJECT',
    "draft" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "publishedRevisionId" TEXT,
    "enrolmentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dispatchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MarketingCampaign_publishedRevisionId_id_ownerId_environment_fkey" FOREIGN KEY ("publishedRevisionId", "id", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MarketingCampaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("category" IN ('EMAIL','PAID','SOCIAL','EXTERNAL')),
    CHECK ("membershipScope" IN ('SUBJECT','CONTACT')),
    CHECK ("status" IN ('DRAFT','ACTIVE','ARCHIVED')),
    CHECK ("draftRevision" >= 1),
    CHECK ("enrolmentEnabled" IN (0,1)),
    CHECK ("dispatchEnabled" IN (0,1))
);

-- CreateTable
CREATE TABLE "CampaignRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "subscriptionCategory" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "sendWindow" JSONB NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    CONSTRAINT "CampaignRevision_campaignId_ownerId_environment_fkey" FOREIGN KEY ("campaignId", "ownerId", "environment") REFERENCES "MarketingCampaign" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignRevision_senderId_ownerId_environment_fkey" FOREIGN KEY ("senderId", "ownerId", "environment") REFERENCES "EmailSender" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignRevision_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("number" >= 1),
    CHECK ("schemaVersion" = 1),
    CHECK (length(trim("subscriptionCategory")) > 0 AND "subscriptionCategory" != '*')
);

-- CreateTable
CREATE TABLE "CampaignStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "wait" JSONB NOT NULL DEFAULT '{"kind":"IMMEDIATE"}',
    "expiresAfterDueSeconds" INTEGER NOT NULL DEFAULT 604800,
    CONSTRAINT "CampaignStep_revisionId_ownerId_environment_fkey" FOREIGN KEY ("revisionId", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStep_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("position" >= 0),
    CHECK ("expiresAfterDueSeconds" > 0),
    CHECK (length(trim("subject")) > 0),
    CHECK (COALESCE(length(trim("html")),0) > 0 OR COALESCE(length(trim("text")),0) > 0)
);

-- CreateTable
CREATE TABLE "StageCampaignLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "versionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'ATTRIBUTION',
    CONSTRAINT "StageCampaignLink_versionId_ownerId_environment_fkey" FOREIGN KEY ("versionId", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "StageCampaignLink_stageKey_versionId_ownerId_environment_fkey" FOREIGN KEY ("stageKey", "versionId", "ownerId", "environment") REFERENCES "FunnelStage" ("key", "versionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "StageCampaignLink_campaignId_ownerId_environment_fkey" FOREIGN KEY ("campaignId", "ownerId", "environment") REFERENCES "MarketingCampaign" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "StageCampaignLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("purpose" = 'ATTRIBUTION')
);

-- CreateTable
CREATE TABLE "CampaignMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "subjectId" TEXT,
    "contactId" TEXT NOT NULL,
    "addressDigest" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "stoppedAt" DATETIME,
    "stopReason" TEXT,
    CONSTRAINT "CampaignMembership_campaignId_scopeKind_ownerId_environment_fkey" FOREIGN KEY ("campaignId", "scopeKind", "ownerId", "environment") REFERENCES "MarketingCampaign" ("id", "membershipScope", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembership_revisionId_campaignId_ownerId_environment_fkey" FOREIGN KEY ("revisionId", "campaignId", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembership_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembership_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembership_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("scopeKind" IN ('SUBJECT','CONTACT')),
    CHECK ("status" IN ('ACTIVE','PAUSED','BLOCKED','STOPPED','COMPLETED')),
    CHECK ("cycle" >= 1),
    CHECK ("revision" >= 1),
    CHECK (("scopeKind" = 'SUBJECT' AND "subjectId" IS NOT NULL AND "scopeKey" = 'SUBJECT:' || "subjectId") OR ("scopeKind" = 'CONTACT' AND "subjectId" IS NULL AND "scopeKey" = 'CONTACT:' || "contactId")),
    CHECK ("endedAt" IS NULL OR "status" IN ('STOPPED','COMPLETED'))
);

-- CreateTable
CREATE TABLE "CampaignMembershipReason" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "membershipId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedRevisionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "journeyId" TEXT,
    "transitionId" TEXT,
    "versionId" TEXT,
    "stageKey" TEXT,
    "linkId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "endedAt" DATETIME,
    "endReason" TEXT,
    "redactedAt" DATETIME,
    CONSTRAINT "CampaignMembershipReason_membershipId_campaignId_ownerId_environment_fkey" FOREIGN KEY ("membershipId", "campaignId", "ownerId", "environment") REFERENCES "CampaignMembership" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembershipReason_requestedRevisionId_campaignId_ownerId_environment_fkey" FOREIGN KEY ("requestedRevisionId", "campaignId", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembershipReason_journeyId_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembershipReason_transitionId_journeyId_versionId_stageKey_ownerId_environment_fkey" FOREIGN KEY ("transitionId", "journeyId", "versionId", "stageKey", "ownerId", "environment") REFERENCES "FunnelStageTransition" ("id", "journeyId", "versionId", "toStageKey", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembershipReason_linkId_versionId_stageKey_campaignId_ownerId_environment_fkey" FOREIGN KEY ("linkId", "versionId", "stageKey", "campaignId", "ownerId", "environment") REFERENCES "StageCampaignLink" ("id", "versionId", "stageKey", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignMembershipReason_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("kind" IN ('MANUAL','STAGE')),
    CHECK ("kind" != 'MANUAL' OR "actorId" IS NOT NULL),
    CHECK (("transitionId" IS NULL AND "versionId" IS NULL AND "stageKey" IS NULL AND "linkId" IS NULL) OR ("transitionId" IS NOT NULL AND "journeyId" IS NOT NULL AND "versionId" IS NOT NULL AND "stageKey" IS NOT NULL)),
    CHECK ("kind" != 'STAGE' OR "transitionId" IS NOT NULL),
    CHECK ("redactedAt" IS NULL OR "note" IS NULL)
);

-- CreateTable
CREATE TABLE "EmailSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addressDigest" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "changedAt" DATETIME NOT NULL,
    "provenance" JSONB NOT NULL,
    CONSTRAINT "EmailSubscription_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("state" IN ('UNKNOWN','OPTED_IN','OPTED_OUT')),
    CHECK ("revision" >= 1),
    CHECK (length(trim("category")) > 0 AND "category" != '*')
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addressDigest" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" DATETIME,
    CONSTRAINT "EmailSuppression_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("reason" IN ('OPT_OUT','HARD_BOUNCE','COMPLAINT','PROVIDER_SUPPRESSION','ADMIN','CONTACT_DELETED')),
    CHECK ("active" IN (0,1)),
    CHECK (("active" = 1 AND "revokedAt" IS NULL) OR ("active" = 0 AND "revokedAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "EmailPolicyAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addressDigest" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "actorId" TEXT,
    "sourceId" TEXT,
    "receiptId" TEXT,
    "provenance" JSONB NOT NULL,
    "redactedAt" DATETIME,
    CONSTRAINT "EmailPolicyAudit_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailPolicyAudit_receiptId_ownerId_environment_fkey" FOREIGN KEY ("receiptId", "ownerId", "environment") REFERENCES "EmailDeliveryReceipt" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailPolicyAudit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("redactedAt" IS NULL OR ("provenance" = '{}' AND "reason" = 'REDACTED'))
);

-- CreateTable
CREATE TABLE "MessageSend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "membershipId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "connectionId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "recipientDigest" TEXT NOT NULL,
    "subscriptionCategory" TEXT NOT NULL,
    "payloadCiphertext" TEXT,
    "requestDigest" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerMessageIdDigest" TEXT,
    "dueAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deliveryState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "cancelRequestedAt" DATETIME,
    "acceptedAt" DATETIME,
    "firstSubmittedAt" DATETIME,
    "idempotencyExpiresAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "leaseTokenHash" TEXT,
    "leaseUntil" DATETIME,
    "connectionGeneration" INTEGER NOT NULL,
    "membershipRevision" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "redactedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageSend_membershipId_revisionId_contactId_recipientDigest_ownerId_environment_fkey" FOREIGN KEY ("membershipId", "revisionId", "contactId", "recipientDigest", "ownerId", "environment") REFERENCES "CampaignMembership" ("id", "revisionId", "contactId", "addressDigest", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_revisionId_senderId_subscriptionCategory_ownerId_environment_fkey" FOREIGN KEY ("revisionId", "senderId", "subscriptionCategory", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "senderId", "subscriptionCategory", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_stepId_revisionId_ownerId_environment_fkey" FOREIGN KEY ("stepId", "revisionId", "ownerId", "environment") REFERENCES "CampaignStep" ("id", "revisionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_connectionId_ownerId_environment_fkey" FOREIGN KEY ("connectionId", "ownerId", "environment") REFERENCES "EmailConnection" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_senderId_connectionId_ownerId_environment_fkey" FOREIGN KEY ("senderId", "connectionId", "ownerId", "environment") REFERENCES "EmailSender" ("id", "connectionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSend_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("iteration" >= 1),
    CHECK ("connectionGeneration" >= 1),
    CHECK ("membershipRevision" >= 1),
    CHECK ("revision" >= 1),
    CHECK ("status" IN ('PENDING','CLAIMED','SUBMITTING','ACCEPTED','UNKNOWN','BLOCKED','FAILED','CANCELLED','EXPIRED','SUPPRESSED')),
    CHECK ("deliveryState" IN ('UNKNOWN','SENT','DELIVERED','BOUNCED','COMPLAINED','SUPPRESSED','FAILED','DELAYED')),
    CHECK (("leaseTokenHash" IS NULL) = ("leaseUntil" IS NULL)),
    CHECK (("firstSubmittedAt" IS NULL) = ("idempotencyExpiresAt" IS NULL)),
    CHECK ("acceptedAt" IS NULL OR "status" = 'ACCEPTED'),
    CHECK ("redactedAt" IS NULL OR ("payloadCiphertext" IS NULL AND "providerMessageId" IS NULL)),
    CHECK ("status" NOT IN ('PENDING','CLAIMED','SUBMITTING') OR "payloadCiphertext" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "MessageSendAttribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "reasonId" TEXT NOT NULL,
    CONSTRAINT "MessageSendAttribution_sendId_membershipId_ownerId_environment_fkey" FOREIGN KEY ("sendId", "membershipId", "ownerId", "environment") REFERENCES "MessageSend" ("id", "membershipId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSendAttribution_reasonId_membershipId_ownerId_environment_fkey" FOREIGN KEY ("reasonId", "membershipId", "ownerId", "environment") REFERENCES "CampaignMembershipReason" ("id", "membershipId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "MessageSendAttribution_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "membershipRevision" INTEGER NOT NULL,
    "sendRevision" INTEGER NOT NULL,
    "leaseTokenHash" TEXT,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "outcome" TEXT NOT NULL DEFAULT 'IN_FLIGHT',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    CONSTRAINT "DeliveryAttempt_sendId_ownerId_environment_fkey" FOREIGN KEY ("sendId", "ownerId", "environment") REFERENCES "MessageSend" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "DeliveryAttempt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("number" >= 1),
    CHECK ("connectionGeneration" >= 1),
    CHECK ("credentialVersion" >= 1),
    CHECK ("membershipRevision" >= 1),
    CHECK ("sendRevision" >= 1),
    CHECK ("outcome" IN ('IN_FLIGHT','ACCEPTED','REJECTED','UNKNOWN','NOT_ACCEPTED','CANCELLED_BEFORE_SUBMIT')),
    CHECK (("outcome" = 'IN_FLIGHT' AND "completedAt" IS NULL) OR ("outcome" != 'IN_FLIGHT' AND "completedAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "EmailDeliveryReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionId" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "providerDeliveryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rawPayloadDigest" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "providerMessageId" TEXT,
    "providerMessageIdDigest" TEXT,
    "addressDigest" TEXT,
    "sendId" TEXT,
    "opaqueSendRef" TEXT,
    "verificationKeyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "EmailDeliveryReceipt_connectionId_ownerId_environment_fkey" FOREIGN KEY ("connectionId", "ownerId", "environment") REFERENCES "EmailConnection" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailDeliveryReceipt_sendId_connectionId_ownerId_environment_fkey" FOREIGN KEY ("sendId", "connectionId", "ownerId", "environment") REFERENCES "MessageSend" ("id", "connectionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailDeliveryReceipt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("connectionGeneration" >= 1),
    CHECK ("verificationKeyVersion" >= 1),
    CHECK ("duplicateCount" >= 0),
    CHECK ("conflictCount" >= 0),
    CHECK ("status" IN ('QUEUED','MATCHED','UNMATCHED','QUARANTINED','REDACTED')),
    CHECK ("status" != 'REDACTED' OR ("envelope" = '{}' AND "providerMessageId" IS NULL AND "addressDigest" IS NULL AND "opaqueSendRef" IS NULL))
);

-- CreateTable
CREATE TABLE "EmailUnsubscribeToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST','LIVE')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenHash" TEXT NOT NULL,
    "addressDigest" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sendId" TEXT,
    "revokedAt" DATETIME,
    CONSTRAINT "EmailUnsubscribeToken_sendId_addressDigest_category_ownerId_environment_fkey" FOREIGN KEY ("sendId", "addressDigest", "category", "ownerId", "environment") REFERENCES "MessageSend" ("id", "recipientDigest", "subscriptionCategory", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailUnsubscribeToken_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_sourceId_key" ON "EmailConnection"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_sourceId_provider_ownerId_environment_key" ON "EmailConnection"("sourceId", "provider", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_id_ownerId_environment_key" ON "EmailConnection"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "EmailSender_connectionId_status_idx" ON "EmailSender"("connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSender_id_connectionId_ownerId_environment_key" ON "EmailSender"("id", "connectionId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSender_id_ownerId_environment_key" ON "EmailSender"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "MarketingCampaign_ownerId_environment_status_idx" ON "MarketingCampaign"("ownerId", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_id_membershipScope_ownerId_environment_key" ON "MarketingCampaign"("id", "membershipScope", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_id_ownerId_environment_key" ON "MarketingCampaign"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRevision_campaignId_number_key" ON "CampaignRevision"("campaignId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRevision_id_campaignId_ownerId_environment_key" ON "CampaignRevision"("id", "campaignId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRevision_sender_category_binding_key" ON "CampaignRevision"("id", "senderId", "subscriptionCategory", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRevision_id_ownerId_environment_key" ON "CampaignRevision"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_revisionId_key_key" ON "CampaignStep"("revisionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_revisionId_position_key" ON "CampaignStep"("revisionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_id_revisionId_ownerId_environment_key" ON "CampaignStep"("id", "revisionId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_id_ownerId_environment_key" ON "CampaignStep"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "StageCampaignLink_versionId_key_key" ON "StageCampaignLink"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "StageCampaignLink_membership_binding_key" ON "StageCampaignLink"("id", "versionId", "stageKey", "campaignId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "StageCampaignLink_id_ownerId_environment_key" ON "StageCampaignLink"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "CampaignMembership_ownerId_environment_contactId_status_idx" ON "CampaignMembership"("ownerId", "environment", "contactId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembership_campaignId_scopeKey_cycle_key" ON "CampaignMembership"("campaignId", "scopeKey", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembership_id_campaignId_ownerId_environment_key" ON "CampaignMembership"("id", "campaignId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembership_recipient_binding_key" ON "CampaignMembership"("id", "revisionId", "contactId", "addressDigest", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembership_id_ownerId_environment_key" ON "CampaignMembership"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "CampaignMembershipReason_membershipId_endedAt_idx" ON "CampaignMembershipReason"("membershipId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembershipReason_ownerId_environment_requestKey_key" ON "CampaignMembershipReason"("ownerId", "environment", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembershipReason_id_membershipId_ownerId_environment_key" ON "CampaignMembershipReason"("id", "membershipId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembershipReason_id_ownerId_environment_key" ON "CampaignMembershipReason"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSubscription_ownerId_environment_addressDigest_category_key" ON "EmailSubscription"("ownerId", "environment", "addressDigest", "category");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSubscription_id_ownerId_environment_key" ON "EmailSubscription"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "EmailSuppression_ownerId_environment_addressDigest_active_idx" ON "EmailSuppression"("ownerId", "environment", "addressDigest", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_ownerId_environment_addressDigest_category_reason_key" ON "EmailSuppression"("ownerId", "environment", "addressDigest", "category", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_id_ownerId_environment_key" ON "EmailSuppression"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "EmailPolicyAudit_ownerId_environment_requestKey_key" ON "EmailPolicyAudit"("ownerId", "environment", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailPolicyAudit_id_ownerId_environment_key" ON "EmailPolicyAudit"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "MessageSend_ownerId_environment_status_dueAt_idx" ON "MessageSend"("ownerId", "environment", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_membershipId_stepId_iteration_key" ON "MessageSend"("membershipId", "stepId", "iteration");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_connectionId_idempotencyKey_key" ON "MessageSend"("connectionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_connectionId_providerMessageId_key" ON "MessageSend"("connectionId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_connectionId_providerMessageIdDigest_key" ON "MessageSend"("connectionId", "providerMessageIdDigest");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_id_connectionId_ownerId_environment_key" ON "MessageSend"("id", "connectionId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_id_membershipId_ownerId_environment_key" ON "MessageSend"("id", "membershipId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_unsubscribe_binding_key" ON "MessageSend"("id", "recipientDigest", "subscriptionCategory", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSend_id_ownerId_environment_key" ON "MessageSend"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSendAttribution_sendId_reasonId_key" ON "MessageSendAttribution"("sendId", "reasonId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageSendAttribution_id_ownerId_environment_key" ON "MessageSendAttribution"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_sendId_number_key" ON "DeliveryAttempt"("sendId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_id_ownerId_environment_key" ON "DeliveryAttempt"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "EmailDeliveryReceipt_status_receivedAt_idx" ON "EmailDeliveryReceipt"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryReceipt_connectionId_providerMessageIdDigest_idx" ON "EmailDeliveryReceipt"("connectionId", "providerMessageIdDigest");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryReceipt_connectionId_providerDeliveryId_key" ON "EmailDeliveryReceipt"("connectionId", "providerDeliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryReceipt_id_ownerId_environment_key" ON "EmailDeliveryReceipt"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "EmailUnsubscribeToken_tokenHash_key" ON "EmailUnsubscribeToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "EmailUnsubscribeToken_id_ownerId_environment_key" ON "EmailUnsubscribeToken"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingSource_id_provider_ownerId_environment_key" ON "TrackingSource"("id", "provider", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStageTransition_campaign_reason_binding_key" ON "FunnelStageTransition"("id", "journeyId", "versionId", "toStageKey", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignMembership_open_scope_key" ON "CampaignMembership"("ownerId","environment","campaignId","scopeKey") WHERE "endedAt" IS NULL;

CREATE TRIGGER "EmailConnection_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "sourceId", "provider" ON "EmailConnection"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."sourceId" IS NOT OLD."sourceId" OR NEW."provider" IS NOT OLD."provider"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailSender_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "connectionId", "address", "name", "replyTo", "domainId" ON "EmailSender"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."connectionId" IS NOT OLD."connectionId" OR NEW."address" IS NOT OLD."address" OR NEW."name" IS NOT OLD."name" OR NEW."replyTo" IS NOT OLD."replyTo" OR NEW."domainId" IS NOT OLD."domainId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "MarketingCampaign_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "category", "membershipScope" ON "MarketingCampaign"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."category" IS NOT OLD."category" OR NEW."membershipScope" IS NOT OLD."membershipScope"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "CampaignMembership_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "campaignId", "revisionId", "scopeKind", "scopeKey", "subjectId", "contactId", "addressDigest", "cycle", "startedAt" ON "CampaignMembership"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."campaignId" IS NOT OLD."campaignId" OR NEW."revisionId" IS NOT OLD."revisionId" OR NEW."scopeKind" IS NOT OLD."scopeKind" OR NEW."scopeKey" IS NOT OLD."scopeKey" OR NEW."subjectId" IS NOT OLD."subjectId" OR NEW."contactId" IS NOT OLD."contactId" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."cycle" IS NOT OLD."cycle" OR NEW."startedAt" IS NOT OLD."startedAt"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "CampaignMembershipReason_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "membershipId", "campaignId", "requestedRevisionId", "kind", "requestKey", "requestDigest", "journeyId", "transitionId", "versionId", "stageKey", "linkId", "actorId" ON "CampaignMembershipReason"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."membershipId" IS NOT OLD."membershipId" OR NEW."campaignId" IS NOT OLD."campaignId" OR NEW."requestedRevisionId" IS NOT OLD."requestedRevisionId" OR NEW."kind" IS NOT OLD."kind" OR NEW."requestKey" IS NOT OLD."requestKey" OR NEW."requestDigest" IS NOT OLD."requestDigest" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."transitionId" IS NOT OLD."transitionId" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."stageKey" IS NOT OLD."stageKey" OR NEW."linkId" IS NOT OLD."linkId" OR NEW."actorId" IS NOT OLD."actorId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailSubscription_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "addressDigest", "category" ON "EmailSubscription"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."category" IS NOT OLD."category"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailSuppression_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "addressDigest", "category", "reason" ON "EmailSuppression"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."category" IS NOT OLD."category" OR NEW."reason" IS NOT OLD."reason"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailPolicyAudit_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "addressDigest", "category", "action", "requestKey", "requestDigest", "actorId", "sourceId", "receiptId" ON "EmailPolicyAudit"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."category" IS NOT OLD."category" OR NEW."action" IS NOT OLD."action" OR NEW."requestKey" IS NOT OLD."requestKey" OR NEW."requestDigest" IS NOT OLD."requestDigest" OR NEW."actorId" IS NOT OLD."actorId" OR NEW."sourceId" IS NOT OLD."sourceId" OR NEW."receiptId" IS NOT OLD."receiptId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "MessageSend_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "membershipId", "revisionId", "stepId", "iteration", "connectionId", "senderId", "contactId", "recipientDigest", "subscriptionCategory", "requestDigest", "idempotencyKey", "dueAt", "expiresAt" ON "MessageSend"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."membershipId" IS NOT OLD."membershipId" OR NEW."revisionId" IS NOT OLD."revisionId" OR NEW."stepId" IS NOT OLD."stepId" OR NEW."iteration" IS NOT OLD."iteration" OR NEW."connectionId" IS NOT OLD."connectionId" OR NEW."senderId" IS NOT OLD."senderId" OR NEW."contactId" IS NOT OLD."contactId" OR NEW."recipientDigest" IS NOT OLD."recipientDigest" OR NEW."subscriptionCategory" IS NOT OLD."subscriptionCategory" OR NEW."requestDigest" IS NOT OLD."requestDigest" OR NEW."idempotencyKey" IS NOT OLD."idempotencyKey" OR NEW."dueAt" IS NOT OLD."dueAt" OR NEW."expiresAt" IS NOT OLD."expiresAt"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "DeliveryAttempt_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "sendId", "number", "connectionGeneration", "credentialVersion", "membershipRevision", "sendRevision", "leaseTokenHash", "startedAt" ON "DeliveryAttempt"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."sendId" IS NOT OLD."sendId" OR NEW."number" IS NOT OLD."number" OR NEW."connectionGeneration" IS NOT OLD."connectionGeneration" OR NEW."credentialVersion" IS NOT OLD."credentialVersion" OR NEW."membershipRevision" IS NOT OLD."membershipRevision" OR NEW."sendRevision" IS NOT OLD."sendRevision" OR NEW."leaseTokenHash" IS NOT OLD."leaseTokenHash" OR NEW."startedAt" IS NOT OLD."startedAt"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailDeliveryReceipt_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "connectionId", "connectionGeneration", "providerDeliveryId", "type", "rawPayloadDigest", "providerMessageIdDigest", "verificationKeyVersion", "occurredAt", "receivedAt" ON "EmailDeliveryReceipt"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."connectionId" IS NOT OLD."connectionId" OR NEW."connectionGeneration" IS NOT OLD."connectionGeneration" OR NEW."providerDeliveryId" IS NOT OLD."providerDeliveryId" OR NEW."type" IS NOT OLD."type" OR NEW."rawPayloadDigest" IS NOT OLD."rawPayloadDigest" OR NEW."providerMessageIdDigest" IS NOT OLD."providerMessageIdDigest" OR NEW."verificationKeyVersion" IS NOT OLD."verificationKeyVersion" OR NEW."occurredAt" IS NOT OLD."occurredAt" OR NEW."receivedAt" IS NOT OLD."receivedAt"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailUnsubscribeToken_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "tokenHash", "addressDigest", "category", "sendId" ON "EmailUnsubscribeToken"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."tokenHash" IS NOT OLD."tokenHash" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."category" IS NOT OLD."category" OR NEW."sendId" IS NOT OLD."sendId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "CampaignRevision_immutable" BEFORE UPDATE ON "CampaignRevision"
BEGIN SELECT RAISE(ABORT, 'Published email content and attribution are immutable'); END;

CREATE TRIGGER "CampaignStep_immutable" BEFORE UPDATE ON "CampaignStep"
BEGIN SELECT RAISE(ABORT, 'Published email content and attribution are immutable'); END;

CREATE TRIGGER "StageCampaignLink_immutable" BEFORE UPDATE ON "StageCampaignLink"
BEGIN SELECT RAISE(ABORT, 'Published email content and attribution are immutable'); END;

CREATE TRIGGER "MessageSendAttribution_immutable" BEFORE UPDATE ON "MessageSendAttribution"
BEGIN SELECT RAISE(ABORT, 'Published email content and attribution are immutable'); END;

CREATE TRIGGER "EmailConnection_retain_history" BEFORE DELETE ON "EmailConnection"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailSender_retain_history" BEFORE DELETE ON "EmailSender"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "MarketingCampaign_retain_history" BEFORE DELETE ON "MarketingCampaign"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "CampaignRevision_retain_history" BEFORE DELETE ON "CampaignRevision"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "CampaignStep_retain_history" BEFORE DELETE ON "CampaignStep"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "StageCampaignLink_retain_history" BEFORE DELETE ON "StageCampaignLink"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "CampaignMembership_retain_history" BEFORE DELETE ON "CampaignMembership"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "CampaignMembershipReason_retain_history" BEFORE DELETE ON "CampaignMembershipReason"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailSubscription_retain_history" BEFORE DELETE ON "EmailSubscription"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailSuppression_retain_history" BEFORE DELETE ON "EmailSuppression"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailPolicyAudit_retain_history" BEFORE DELETE ON "EmailPolicyAudit"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "MessageSend_retain_history" BEFORE DELETE ON "MessageSend"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "MessageSendAttribution_retain_history" BEFORE DELETE ON "MessageSendAttribution"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "DeliveryAttempt_retain_history" BEFORE DELETE ON "DeliveryAttempt"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailDeliveryReceipt_retain_history" BEFORE DELETE ON "EmailDeliveryReceipt"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "EmailUnsubscribeToken_retain_history" BEFORE DELETE ON "EmailUnsubscribeToken"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

-- Recipient binding is validated at enrollment, then retained as history even
-- when contact deletion legitimately unlinks the current subject/contact map.
CREATE TRIGGER "CampaignMembership_subject_recipient" BEFORE INSERT ON "CampaignMembership"
WHEN NEW."scopeKind" = 'SUBJECT' AND NOT EXISTS (
 SELECT 1 FROM "FunnelSubject" WHERE "id"=NEW."subjectId" AND "contactId"=NEW."contactId" AND "ownerId"=NEW."ownerId" AND "environment"=NEW."environment")
BEGIN SELECT RAISE(ABORT, 'Membership subject and contact must match'); END;

CREATE TRIGGER "CampaignMembership_no_reopen" BEFORE UPDATE ON "CampaignMembership"
WHEN (OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS NOT OLD."endedAt") OR
 (OLD."status" IN ('STOPPED','COMPLETED') AND NEW."status" NOT IN ('STOPPED','COMPLETED'))
BEGIN SELECT RAISE(ABORT, 'Closed or stopped membership cannot reactivate'); END;

CREATE TRIGGER "CampaignMembership_preserve_unknown_slot" BEFORE UPDATE OF "endedAt" ON "CampaignMembership"
WHEN NEW."endedAt" IS NOT NULL AND (EXISTS (SELECT 1 FROM "MessageSend" WHERE "membershipId"=OLD."id" AND "status" IN ('SUBMITTING','UNKNOWN')) OR
 EXISTS (SELECT 1 FROM "DeliveryAttempt" a JOIN "MessageSend" s ON s."id"=a."sendId" WHERE s."membershipId"=OLD."id" AND a."outcome"='IN_FLIGHT'))
BEGIN SELECT RAISE(ABORT, 'Unresolved submission retains its membership slot'); END;

CREATE TRIGGER "CampaignMembershipReason_end_once" BEFORE UPDATE OF "endedAt","endReason" ON "CampaignMembershipReason"
WHEN OLD."endedAt" IS NOT NULL AND (NEW."endedAt" IS NOT OLD."endedAt" OR NEW."endReason" IS NOT OLD."endReason")
BEGIN SELECT RAISE(ABORT, 'Membership reason ending is immutable'); END;

CREATE TRIGGER "CampaignMembershipReason_redact_note" BEFORE UPDATE OF "note","redactedAt" ON "CampaignMembershipReason"
WHEN (NEW."note" IS NOT OLD."note" OR NEW."redactedAt" IS NOT OLD."redactedAt") AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."note" IS NULL)
BEGIN SELECT RAISE(ABORT, 'Membership notes only permit explicit redaction'); END;

CREATE TRIGGER "EmailPolicyAudit_redact_only" BEFORE UPDATE OF "reason","provenance","redactedAt" ON "EmailPolicyAudit"
WHEN (NEW."reason" IS NOT OLD."reason" OR NEW."provenance" IS NOT OLD."provenance" OR NEW."redactedAt" IS NOT OLD."redactedAt") AND NOT
 (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."provenance"='{}' AND NEW."reason"='REDACTED')
BEGIN SELECT RAISE(ABORT, 'Policy audit only permits explicit redaction'); END;

CREATE TRIGGER "EmailPolicyAudit_receipt_source" BEFORE INSERT ON "EmailPolicyAudit"
WHEN NEW."sourceId" IS NOT NULL AND NEW."receiptId" IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM "EmailDeliveryReceipt" r JOIN "EmailConnection" c ON c."id"=r."connectionId" WHERE r."id"=NEW."receiptId" AND c."sourceId"=NEW."sourceId")
BEGIN SELECT RAISE(ABORT, 'Policy receipt and source must match'); END;

CREATE TRIGGER "EmailConnection_credential_version" BEFORE UPDATE OF "credentialCiphertext","credentialVersion" ON "EmailConnection"
WHEN NEW."credentialVersion" < OLD."credentialVersion" OR (NEW."credentialCiphertext" IS NOT OLD."credentialCiphertext" AND NEW."credentialVersion" <= OLD."credentialVersion")
BEGIN SELECT RAISE(ABORT, 'Credential changes require a new version'); END;

CREATE TRIGGER "MessageSend_redact_payload" BEFORE UPDATE OF "payloadCiphertext","redactedAt" ON "MessageSend"
WHEN (NEW."payloadCiphertext" IS NOT OLD."payloadCiphertext" OR NEW."redactedAt" IS NOT OLD."redactedAt") AND NOT
 (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."payloadCiphertext" IS NULL)
BEGIN SELECT RAISE(ABORT, 'Send request only permits explicit redaction'); END;

CREATE TRIGGER "MessageSend_submission_timestamps" BEFORE UPDATE OF "firstSubmittedAt","idempotencyExpiresAt","acceptedAt" ON "MessageSend"
WHEN (OLD."firstSubmittedAt" IS NOT NULL AND NEW."firstSubmittedAt" IS NOT OLD."firstSubmittedAt") OR
 (OLD."idempotencyExpiresAt" IS NOT NULL AND NEW."idempotencyExpiresAt" IS NOT OLD."idempotencyExpiresAt") OR
 (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS NOT OLD."acceptedAt")
BEGIN SELECT RAISE(ABORT, 'Submission and acceptance evidence is immutable'); END;

CREATE TRIGGER "MessageSend_provider_binding" BEFORE UPDATE OF "providerMessageId","providerMessageIdDigest" ON "MessageSend"
WHEN (OLD."providerMessageIdDigest" IS NOT NULL AND NEW."providerMessageIdDigest" IS NOT OLD."providerMessageIdDigest") OR
 (OLD."providerMessageId" IS NOT NULL AND NEW."providerMessageId" IS NOT OLD."providerMessageId" AND NOT (NEW."redactedAt" IS NOT NULL AND NEW."providerMessageId" IS NULL))
BEGIN SELECT RAISE(ABORT, 'Provider message binding is immutable'); END;

CREATE TRIGGER "MessageSend_submission_fences" BEFORE UPDATE OF "connectionGeneration","membershipRevision" ON "MessageSend"
WHEN (NEW."connectionGeneration" IS NOT OLD."connectionGeneration" OR NEW."membershipRevision" IS NOT OLD."membershipRevision") AND
 (OLD."status" NOT IN ('PENDING','BLOCKED','FAILED') OR EXISTS (SELECT 1 FROM "DeliveryAttempt" WHERE "sendId"=OLD."id" AND "outcome" IN ('IN_FLIGHT','UNKNOWN','ACCEPTED')))
BEGIN SELECT RAISE(ABORT, 'Submitted send permission snapshots cannot be replaced'); END;

CREATE TRIGGER "DeliveryAttempt_complete_once" BEFORE UPDATE OF "outcome","completedAt","providerMessageId","errorCode" ON "DeliveryAttempt"
WHEN OLD."completedAt" IS NOT NULL AND (
 NEW."outcome" IS NOT OLD."outcome" OR NEW."completedAt" IS NOT OLD."completedAt" OR NEW."errorCode" IS NOT OLD."errorCode" OR
 (NEW."providerMessageId" IS NOT OLD."providerMessageId" AND NOT (NEW."providerMessageId" IS NULL AND EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=OLD."sendId" AND "redactedAt" IS NOT NULL))))
BEGIN SELECT RAISE(ABORT, 'Delivery attempt outcome is immutable'); END;

CREATE TRIGGER "EmailDeliveryReceipt_binding_once" BEFORE UPDATE OF "sendId" ON "EmailDeliveryReceipt"
WHEN OLD."sendId" IS NOT NULL AND NEW."sendId" IS NOT OLD."sendId"
BEGIN SELECT RAISE(ABORT, 'Receipt cannot be rebound'); END;

CREATE TRIGGER "EmailDeliveryReceipt_redact_evidence" BEFORE UPDATE OF "envelope","providerMessageId","addressDigest","opaqueSendRef" ON "EmailDeliveryReceipt"
WHEN (NEW."envelope" IS NOT OLD."envelope" OR NEW."providerMessageId" IS NOT OLD."providerMessageId" OR NEW."addressDigest" IS NOT OLD."addressDigest" OR NEW."opaqueSendRef" IS NOT OLD."opaqueSendRef") AND NOT
 (NEW."status"='REDACTED' AND NEW."envelope"='{}' AND NEW."providerMessageId" IS NULL AND NEW."addressDigest" IS NULL AND NEW."opaqueSendRef" IS NULL)
BEGIN SELECT RAISE(ABORT, 'Delivery evidence only permits explicit redaction'); END;

CREATE TRIGGER "EmailDeliveryReceipt_no_redacted_replay" BEFORE UPDATE OF "status" ON "EmailDeliveryReceipt"
WHEN OLD."status"='REDACTED' AND NEW."status"!='REDACTED'
BEGIN SELECT RAISE(ABORT, 'Redacted receipt cannot replay'); END;

CREATE TRIGGER "EmailUnsubscribeToken_revoke_once" BEFORE UPDATE OF "revokedAt" ON "EmailUnsubscribeToken"
WHEN OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NOT OLD."revokedAt"
BEGIN SELECT RAISE(ABORT, 'Revoked unsubscribe token cannot reactivate'); END;

COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
