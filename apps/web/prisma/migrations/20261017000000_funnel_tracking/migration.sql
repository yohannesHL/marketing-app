-- Additive tracking foundation. Existing advertising/social tables and their CHECKs/triggers remain unchanged.
-- Composite foreign keys bind every association to one customer and environment.

-- CreateTable
CREATE TABLE "TrackingSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "provider" TEXT NOT NULL CHECK ("provider" IN ('NATIVE', 'API', 'CALENDLY', 'SHOPIFY')),
    "externalAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credentialCiphertext" TEXT,
    "ingressTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'DISCONNECTED')),
    "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation" >= 1),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrackingSource_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "email" TEXT,
    "name" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FunnelContact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    CONSTRAINT "FunnelIdentity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelIdentity_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelIdentity_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelSubject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "kind" TEXT NOT NULL CHECK ("kind" IN ('CONTACT', 'SALES', 'PURCHASE')),
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOccurredAt" DATETIME,
    CONSTRAINT "FunnelSubject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelSubject_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelSubjectReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    CONSTRAINT "FunnelSubjectReference_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelSubjectReference_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelSubjectReference_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingVisitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingVisitor_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingVisitor_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingCorrelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "emailDigest" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingCorrelation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingCorrelation_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingCorrelation_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "sourceGeneration" INTEGER NOT NULL CHECK ("sourceGeneration" >= 1),
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "rawPayloadDigest" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "ingestionMode" TEXT NOT NULL DEFAULT 'LIVE' CHECK ("ingestionMode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "processingMode" TEXT NOT NULL DEFAULT 'LIVE' CHECK ("processingMode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'MATCHED', 'UNMATCHED', 'QUARANTINED', 'REDACTED', 'BLOCKED')),
    "reason" TEXT,
    "subjectId" TEXT,
    "contactId" TEXT,
    "visitorId" TEXT,
    "factId" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0 CHECK ("duplicateCount" >= 0),
    "conflictCount" INTEGER NOT NULL DEFAULT 0 CHECK ("conflictCount" >= 0),
    "late" BOOLEAN NOT NULL DEFAULT false CHECK ("late" IN (0, 1)),
    CONSTRAINT "TrackingEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingEvent_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingEvent_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "TrackingEvent_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "TrackingEvent_visitorId_ownerId_environment_fkey" FOREIGN KEY ("visitorId", "ownerId", "environment") REFERENCES "TrackingVisitor" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "TrackingEvent_factId_ownerId_environment_fkey" FOREIGN KEY ("factId", "ownerId", "environment") REFERENCES "TrackingFact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "subjectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "authority" TEXT NOT NULL CHECK ("authority" IN ('PROVIDER_VERIFIED', 'SERVER_ASSERTED', 'USER_RECORDED')),
    "occurredAt" DATETIME NOT NULL,
    "attributes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingFact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingFact_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "eventId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingAudit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingAudit_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingAudit_eventId_ownerId_environment_fkey" FOREIGN KEY ("eventId", "ownerId", "environment") REFERENCES "TrackingEvent" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingRateLimit" (
    "sourceId" TEXT NOT NULL,
    "bucket" DATETIME NOT NULL,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "count" INTEGER NOT NULL CHECK ("count" >= 0),

    PRIMARY KEY ("sourceId", "bucket"),
    CONSTRAINT "TrackingRateLimit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingRateLimit_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingDeletion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "sourceId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "externalIdDigest" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingDeletion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingDeletion_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackingSource_ingressTokenHash_key" ON "TrackingSource"("ingressTokenHash");

-- CreateIndex
CREATE INDEX "TrackingSource_ownerId_environment_status_idx" ON "TrackingSource"("ownerId", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingSource_id_ownerId_environment_key" ON "TrackingSource"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingSource_ownerId_environment_provider_externalAccountId_key" ON "TrackingSource"("ownerId", "environment", "provider", "externalAccountId");

-- CreateIndex
CREATE INDEX "FunnelContact_ownerId_environment_email_idx" ON "FunnelContact"("ownerId", "environment", "email");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelContact_id_ownerId_environment_key" ON "FunnelContact"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "FunnelIdentity_contactId_ownerId_environment_idx" ON "FunnelIdentity"("contactId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelIdentity_ownerId_sourceId_namespace_externalId_key" ON "FunnelIdentity"("ownerId", "sourceId", "namespace", "externalId");

-- CreateIndex
CREATE INDEX "FunnelSubject_ownerId_environment_kind_contactId_idx" ON "FunnelSubject"("ownerId", "environment", "kind", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelSubject_id_ownerId_environment_key" ON "FunnelSubject"("id", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "FunnelSubjectReference_subjectId_ownerId_environment_idx" ON "FunnelSubjectReference"("subjectId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelSubjectReference_ownerId_sourceId_kind_externalId_key" ON "FunnelSubjectReference"("ownerId", "sourceId", "kind", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingVisitor_tokenHash_key" ON "TrackingVisitor"("tokenHash");

-- CreateIndex
CREATE INDEX "TrackingVisitor_sourceId_expiresAt_idx" ON "TrackingVisitor"("sourceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingVisitor_id_ownerId_environment_key" ON "TrackingVisitor"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingCorrelation_tokenHash_key" ON "TrackingCorrelation"("tokenHash");

-- CreateIndex
CREATE INDEX "TrackingCorrelation_sourceId_expiresAt_idx" ON "TrackingCorrelation"("sourceId", "expiresAt");

-- CreateIndex
CREATE INDEX "TrackingCorrelation_subjectId_ownerId_environment_idx" ON "TrackingCorrelation"("subjectId", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "TrackingEvent_status_receivedAt_idx" ON "TrackingEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_ownerId_environment_sourceId_occurredAt_idx" ON "TrackingEvent"("ownerId", "environment", "sourceId", "occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_ownerId_environment_subjectId_occurredAt_idx" ON "TrackingEvent"("ownerId", "environment", "subjectId", "occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_expiresAt_idx" ON "TrackingEvent"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_id_ownerId_environment_key" ON "TrackingEvent"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_ownerId_sourceId_type_dedupeKey_key" ON "TrackingEvent"("ownerId", "sourceId", "type", "dedupeKey");

-- CreateIndex
CREATE INDEX "TrackingFact_ownerId_environment_occurredAt_idx" ON "TrackingFact"("ownerId", "environment", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingFact_id_ownerId_environment_key" ON "TrackingFact"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingFact_ownerId_subjectId_key_key" ON "TrackingFact"("ownerId", "subjectId", "key");

-- CreateIndex
CREATE INDEX "TrackingAudit_ownerId_environment_sourceId_createdAt_idx" ON "TrackingAudit"("ownerId", "environment", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "TrackingAudit_eventId_idx" ON "TrackingAudit"("eventId");

-- CreateIndex
CREATE INDEX "TrackingRateLimit_bucket_idx" ON "TrackingRateLimit"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingDeletion_ownerId_sourceId_namespace_externalIdDigest_key" ON "TrackingDeletion"("ownerId", "sourceId", "namespace", "externalIdDigest");

-- A row cannot be moved to another customer or environment after creation.
CREATE TRIGGER "TrackingSource_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "provider", "externalAccountId" ON "TrackingSource"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."provider" IS NOT OLD."provider" OR NEW."externalAccountId" IS NOT OLD."externalAccountId"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "FunnelContact_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "FunnelContact"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "FunnelIdentity_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "FunnelIdentity"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "FunnelSubject_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "FunnelSubject"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "FunnelSubjectReference_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "FunnelSubjectReference"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingVisitor_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingVisitor"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingCorrelation_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingCorrelation"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingEvent_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingEvent"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingFact_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingFact"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingAudit_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingAudit"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingRateLimit_immutable_identity" BEFORE UPDATE OF "sourceId", "bucket", "ownerId", "environment" ON "TrackingRateLimit"
WHEN NEW."sourceId" IS NOT OLD."sourceId" OR NEW."bucket" IS NOT OLD."bucket" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TRIGGER "TrackingDeletion_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "TrackingDeletion"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

-- Reprocessing changes only processing state; original ingestion evidence is immutable.
CREATE TRIGGER "TrackingEvent_immutable_evidence" BEFORE UPDATE OF "sourceId", "sourceGeneration", "type", "dedupeKey", "rawPayloadDigest", "ingestionMode", "occurredAt", "receivedAt" ON "TrackingEvent"
WHEN NEW."sourceId" IS NOT OLD."sourceId" OR NEW."sourceGeneration" IS NOT OLD."sourceGeneration" OR NEW."type" IS NOT OLD."type" OR NEW."dedupeKey" IS NOT OLD."dedupeKey" OR NEW."rawPayloadDigest" IS NOT OLD."rawPayloadDigest" OR NEW."ingestionMode" IS NOT OLD."ingestionMode" OR NEW."occurredAt" IS NOT OLD."occurredAt" OR NEW."receivedAt" IS NOT OLD."receivedAt"
BEGIN SELECT RAISE(ABORT, 'Tracking event evidence is immutable'); END;

-- Payload removal is the sole update exception. Deleted/expired events cannot become live again.
CREATE TRIGGER "TrackingEvent_envelope_redaction_only" BEFORE UPDATE OF "envelope" ON "TrackingEvent"
WHEN NEW."envelope" IS NOT OLD."envelope" AND NEW."status" != 'REDACTED'
BEGIN SELECT RAISE(ABORT, 'Tracking event payload may only be redacted'); END;
CREATE TRIGGER "TrackingEvent_no_redacted_replay" BEFORE UPDATE OF "status" ON "TrackingEvent"
WHEN OLD."status" = 'REDACTED' AND NEW."status" != 'REDACTED'
BEGIN SELECT RAISE(ABORT, 'Redacted tracking events cannot be replayed'); END;
