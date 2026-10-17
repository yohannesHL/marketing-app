-- Additive custom funnel rules storage. No existing table is rebuilt and no prior trigger is replaced.
-- Published definitions, stage history, commands, and evidence effects retain their identity.

-- CreateTable
CREATE TABLE "Funnel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "name" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL CHECK ("subjectKind" IN ('CONTACT', 'SALES', 'PURCHASE')),
    "draft" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1 CHECK ("draftRevision" >= 1),
    "publishedVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Funnel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Funnel_publishedVersionId_id_ownerId_environment_fkey" FOREIGN KEY ("publishedVersionId", "id", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "funnelId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "funnelId" TEXT NOT NULL,
    "number" INTEGER NOT NULL CHECK ("number" >= 1),
    "schemaVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("schemaVersion" >= 1),
    "definition" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    CONSTRAINT "FunnelVersion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelVersion_funnelId_ownerId_environment_fkey" FOREIGN KEY ("funnelId", "ownerId", "environment") REFERENCES "Funnel" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" BOOLEAN NOT NULL DEFAULT false CHECK ("goal" IN (0, 1)),
    "terminal" TEXT NOT NULL DEFAULT 'NONE' CHECK ("terminal" IN ('NONE', 'SUCCESS', 'FAILURE')),
    CONSTRAINT "FunnelStage_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelStage_versionId_ownerId_environment_fkey" FOREIGN KEY ("versionId", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelJourney" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "funnelId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1 CHECK ("cycle" >= 1),
    "currentStageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "lastTransitionOccurredAt" DATETIME,
    CONSTRAINT "FunnelJourney_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelJourney_funnelId_ownerId_environment_fkey" FOREIGN KEY ("funnelId", "ownerId", "environment") REFERENCES "Funnel" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelJourney_versionId_funnelId_ownerId_environment_fkey" FOREIGN KEY ("versionId", "funnelId", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "funnelId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelJourney_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelJourney_currentStageKey_versionId_ownerId_environment_fkey" FOREIGN KEY ("currentStageKey", "versionId", "ownerId", "environment") REFERENCES "FunnelStage" ("key", "versionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelStageTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "journeyId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL CHECK ("sequence" >= 1),
    "fromStageKey" TEXT,
    "toStageKey" TEXT NOT NULL,
    "ruleId" TEXT,
    "eventId" TEXT,
    "receiptId" TEXT,
    "actorId" TEXT,
    "triggerKind" TEXT NOT NULL,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "evaluationTrace" JSONB NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commandKey" TEXT,
    "commandDigest" TEXT,
    "redactedAt" DATETIME,
    CHECK (("commandKey" IS NULL AND "commandDigest" IS NULL) OR ("commandKey" IS NOT NULL AND length("commandKey") > 0 AND "commandDigest" IS NOT NULL AND length("commandDigest") > 0)),
    CHECK ("receiptId" IS NULL OR "eventId" IS NOT NULL),
    CHECK ("redactedAt" IS NULL OR ("note" IS NULL AND json("evaluationTrace") = '{}')),
    CONSTRAINT "FunnelStageTransition_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelStageTransition_journeyId_versionId_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "versionId", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "versionId", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelStageTransition_fromStageKey_versionId_ownerId_environment_fkey" FOREIGN KEY ("fromStageKey", "versionId", "ownerId", "environment") REFERENCES "FunnelStage" ("key", "versionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelStageTransition_toStageKey_versionId_ownerId_environment_fkey" FOREIGN KEY ("toStageKey", "versionId", "ownerId", "environment") REFERENCES "FunnelStage" ("key", "versionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelStageTransition_eventId_ownerId_environment_fkey" FOREIGN KEY ("eventId", "ownerId", "environment") REFERENCES "TrackingEvent" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelStageTransition_receiptId_eventId_ownerId_environment_fkey" FOREIGN KEY ("receiptId", "eventId", "ownerId", "environment") REFERENCES "FunnelEvaluationReceipt" ("id", "eventId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelPropertySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "subjectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FunnelPropertySnapshot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelPropertySnapshot_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelPropertySnapshot_sourceId_ownerId_environment_fkey" FOREIGN KEY ("sourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelEvaluationReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "eventId" TEXT NOT NULL,
    "matchRevision" INTEGER NOT NULL CHECK ("matchRevision" >= 1),
    "subjectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'CONSUMED', 'CANCELLED', 'FAILED')),
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "FunnelEvaluationReceipt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvaluationReceipt_eventId_ownerId_environment_fkey" FOREIGN KEY ("eventId", "ownerId", "environment") REFERENCES "TrackingEvent" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvaluationReceipt_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelEvidenceEffect" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "funnelId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1 CHECK ("cycle" >= 1),
    "journeyId" TEXT,
    "evidenceKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "ruleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FunnelEvidenceEffect_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_funnelId_ownerId_environment_fkey" FOREIGN KEY ("funnelId", "ownerId", "environment") REFERENCES "Funnel" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_versionId_funnelId_ownerId_environment_fkey" FOREIGN KEY ("versionId", "funnelId", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "funnelId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_journeyId_funnelId_versionId_subjectId_cycle_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "funnelId", "versionId", "subjectId", "cycle", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "funnelId", "versionId", "subjectId", "cycle", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunnelActionOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "journeyId" TEXT NOT NULL,
    "transitionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" = 'STAGE_ENTERED'),
    "actionKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "effectEligibility" TEXT NOT NULL DEFAULT 'TRACKING_ONLY' CHECK ("effectEligibility" = 'TRACKING_ONLY'),
    "status" TEXT NOT NULL DEFAULT 'RECORDED' CHECK ("status" IN ('RECORDED', 'CANCELLED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "FunnelActionOutbox_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionOutbox_journeyId_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionOutbox_transitionId_journeyId_ownerId_environment_fkey" FOREIGN KEY ("transitionId", "journeyId", "ownerId", "environment") REFERENCES "FunnelStageTransition" ("id", "journeyId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- Preserve TrackingEvent's existing CHECKs, foreign keys, indexes, and evidence triggers.
ALTER TABLE "TrackingEvent" ADD COLUMN "matchRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("matchRevision" >= 0);

-- CreateIndex
CREATE INDEX "Funnel_ownerId_environment_status_idx" ON "Funnel"("ownerId", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Funnel_id_ownerId_environment_key" ON "Funnel"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelVersion_id_ownerId_environment_key" ON "FunnelVersion"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelVersion_id_funnelId_ownerId_environment_key" ON "FunnelVersion"("id", "funnelId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelVersion_funnelId_number_key" ON "FunnelVersion"("funnelId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStage_versionId_key_key" ON "FunnelStage"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStage_key_versionId_ownerId_environment_key" ON "FunnelStage"("key", "versionId", "ownerId", "environment");

-- CreateIndex
CREATE INDEX "FunnelJourney_ownerId_environment_subjectId_status_idx" ON "FunnelJourney"("ownerId", "environment", "subjectId", "status");

-- CreateIndex
CREATE INDEX "FunnelJourney_funnelId_status_idx" ON "FunnelJourney"("funnelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelJourney_id_ownerId_environment_key" ON "FunnelJourney"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelJourney_id_versionId_ownerId_environment_key" ON "FunnelJourney"("id", "versionId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelJourney_evidence_binding_key" ON "FunnelJourney"("id", "funnelId", "versionId", "subjectId", "cycle", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelJourney_funnelId_subjectId_cycle_key" ON "FunnelJourney"("funnelId", "subjectId", "cycle");

-- CreateIndex
CREATE INDEX "FunnelStageTransition_ownerId_environment_recordedAt_idx" ON "FunnelStageTransition"("ownerId", "environment", "recordedAt");

-- CreateIndex
CREATE INDEX "FunnelStageTransition_eventId_idx" ON "FunnelStageTransition"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStageTransition_id_ownerId_environment_key" ON "FunnelStageTransition"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStageTransition_id_journeyId_ownerId_environment_key" ON "FunnelStageTransition"("id", "journeyId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStageTransition_journeyId_sequence_key" ON "FunnelStageTransition"("journeyId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStageTransition_ownerId_commandKey_key" ON "FunnelStageTransition"("ownerId", "commandKey");

-- CreateIndex
CREATE INDEX "FunnelPropertySnapshot_ownerId_environment_subjectId_idx" ON "FunnelPropertySnapshot"("ownerId", "environment", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelPropertySnapshot_subjectId_sourceId_eventType_key" ON "FunnelPropertySnapshot"("subjectId", "sourceId", "eventType");

-- CreateIndex
CREATE INDEX "FunnelEvaluationReceipt_status_createdAt_idx" ON "FunnelEvaluationReceipt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FunnelEvaluationReceipt_ownerId_environment_subjectId_status_idx" ON "FunnelEvaluationReceipt"("ownerId", "environment", "subjectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvaluationReceipt_id_ownerId_environment_key" ON "FunnelEvaluationReceipt"("id", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvaluationReceipt_id_eventId_ownerId_environment_key" ON "FunnelEvaluationReceipt"("id", "eventId", "ownerId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvaluationReceipt_eventId_matchRevision_key" ON "FunnelEvaluationReceipt"("eventId", "matchRevision");

-- CreateIndex
CREATE INDEX "FunnelEvidenceEffect_ownerId_environment_subjectId_idx" ON "FunnelEvidenceEffect"("ownerId", "environment", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvidenceEffect_funnelId_subjectId_cycle_evidenceKey_key" ON "FunnelEvidenceEffect"("funnelId", "subjectId", "cycle", "evidenceKey");

-- CreateIndex
CREATE INDEX "FunnelActionOutbox_ownerId_environment_status_createdAt_idx" ON "FunnelActionOutbox"("ownerId", "environment", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelActionOutbox_transitionId_kind_actionKey_key" ON "FunnelActionOutbox"("transitionId", "kind", "actionKey");

-- A completed cycle remains history; a new cycle is explicit. At most one is active.
CREATE UNIQUE INDEX "FunnelJourney_one_active_subject" ON "FunnelJourney"("ownerId", "environment", "funnelId", "subjectId") WHERE "status" = 'ACTIVE';

-- The revision is a durable hand-off from tracking matching to rule evaluation.
-- Historical matches are deliberately BACKFILL so deploying the worker cannot send old actions.
UPDATE "TrackingEvent" SET "matchRevision" = 1 WHERE "status" = 'MATCHED';
INSERT INTO "FunnelEvaluationReceipt" ("id", "ownerId", "environment", "eventId", "matchRevision", "subjectId", "mode", "status", "reason", "createdAt")
SELECT 'funnel38-backfill:' || "id", "ownerId", "environment", "id", 1, "subjectId", 'BACKFILL', 'PENDING', 'MIGRATION_BACKFILL', CURRENT_TIMESTAMP
FROM "TrackingEvent" WHERE "status" = 'MATCHED' AND "subjectId" IS NOT NULL;

CREATE TRIGGER "TrackingEvent_monotonic_match_revision" BEFORE UPDATE OF "matchRevision" ON "TrackingEvent"
WHEN NEW."matchRevision" < OLD."matchRevision"
BEGIN SELECT RAISE(ABORT, 'Tracking match revision cannot decrease'); END;

CREATE TRIGGER "Funnel_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "subjectKind", "createdAt" ON "Funnel"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."subjectKind" IS NOT OLD."subjectKind" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelJourney_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "funnelId", "versionId", "subjectId", "cycle", "startedAt" ON "FunnelJourney"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."funnelId" IS NOT OLD."funnelId" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."subjectId" IS NOT OLD."subjectId" OR NEW."cycle" IS NOT OLD."cycle" OR NEW."startedAt" IS NOT OLD."startedAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelPropertySnapshot_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "subjectId", "sourceId", "eventType" ON "FunnelPropertySnapshot"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."subjectId" IS NOT OLD."subjectId" OR NEW."sourceId" IS NOT OLD."sourceId" OR NEW."eventType" IS NOT OLD."eventType"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelEvaluationReceipt_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "eventId", "matchRevision", "subjectId", "mode", "createdAt" ON "FunnelEvaluationReceipt"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."eventId" IS NOT OLD."eventId" OR NEW."matchRevision" IS NOT OLD."matchRevision" OR NEW."subjectId" IS NOT OLD."subjectId" OR NEW."mode" IS NOT OLD."mode" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelActionOutbox_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "journeyId", "transitionId", "kind", "actionKey", "mode", "effectEligibility", "createdAt" ON "FunnelActionOutbox"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."transitionId" IS NOT OLD."transitionId" OR NEW."kind" IS NOT OLD."kind" OR NEW."actionKey" IS NOT OLD."actionKey" OR NEW."mode" IS NOT OLD."mode" OR NEW."effectEligibility" IS NOT OLD."effectEligibility" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelVersion_immutable" BEFORE UPDATE ON "FunnelVersion"
BEGIN SELECT RAISE(ABORT, 'Published funnel definitions and evidence are immutable'); END;

CREATE TRIGGER "FunnelStage_immutable" BEFORE UPDATE ON "FunnelStage"
BEGIN SELECT RAISE(ABORT, 'Published funnel definitions and evidence are immutable'); END;

CREATE TRIGGER "FunnelEvidenceEffect_immutable" BEFORE UPDATE ON "FunnelEvidenceEffect"
BEGIN SELECT RAISE(ABORT, 'Published funnel definitions and evidence are immutable'); END;

CREATE TRIGGER "FunnelVersion_retain_history" BEFORE DELETE ON "FunnelVersion"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE TRIGGER "FunnelStage_retain_history" BEFORE DELETE ON "FunnelStage"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE TRIGGER "FunnelJourney_retain_history" BEFORE DELETE ON "FunnelJourney"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE TRIGGER "FunnelStageTransition_retain_history" BEFORE DELETE ON "FunnelStageTransition"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE TRIGGER "FunnelEvaluationReceipt_retain_history" BEFORE DELETE ON "FunnelEvaluationReceipt"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE TRIGGER "FunnelEvidenceEffect_retain_history" BEFORE DELETE ON "FunnelEvidenceEffect"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

-- Privacy removal is the only history update: notes and trace values become empty;
-- command/dedupe keys, routing decisions, and timestamps cannot be rewritten.
CREATE TRIGGER "FunnelStageTransition_append_only" BEFORE UPDATE ON "FunnelStageTransition"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."sequence" IS NOT OLD."sequence" OR NEW."fromStageKey" IS NOT OLD."fromStageKey" OR NEW."toStageKey" IS NOT OLD."toStageKey" OR NEW."ruleId" IS NOT OLD."ruleId" OR NEW."eventId" IS NOT OLD."eventId" OR NEW."receiptId" IS NOT OLD."receiptId" OR NEW."actorId" IS NOT OLD."actorId" OR NEW."triggerKind" IS NOT OLD."triggerKind" OR NEW."mode" IS NOT OLD."mode" OR NEW."reasonCode" IS NOT OLD."reasonCode" OR NEW."occurredAt" IS NOT OLD."occurredAt" OR NEW."recordedAt" IS NOT OLD."recordedAt" OR NEW."commandKey" IS NOT OLD."commandKey" OR NEW."commandDigest" IS NOT OLD."commandDigest"
 OR ((NEW."note" IS NOT OLD."note" OR NEW."evaluationTrace" IS NOT OLD."evaluationTrace" OR NEW."redactedAt" IS NOT OLD."redactedAt")
     AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."note" IS NULL AND json(NEW."evaluationTrace") = '{}'))
BEGIN SELECT RAISE(ABORT, 'Funnel transitions are append-only except explicit redaction'); END;

-- The service increments the event and inserts its receipt in the same transaction.
CREATE TRIGGER "FunnelEvaluationReceipt_requires_match" BEFORE INSERT ON "FunnelEvaluationReceipt"
WHEN NOT EXISTS (
  SELECT 1 FROM "TrackingEvent" WHERE "id" = NEW."eventId" AND "ownerId" = NEW."ownerId" AND "environment" = NEW."environment"
    AND "status" = 'MATCHED' AND "subjectId" = NEW."subjectId" AND "matchRevision" = NEW."matchRevision"
)
BEGIN SELECT RAISE(ABORT, 'Evaluation receipt requires the current matched event revision'); END;

CREATE TRIGGER "FunnelEvaluationReceipt_terminal" BEFORE UPDATE OF "status" ON "FunnelEvaluationReceipt"
WHEN OLD."status" != 'PENDING' AND NEW."status" != OLD."status"
BEGIN SELECT RAISE(ABORT, 'Completed evaluation receipts cannot be reactivated'); END;

CREATE TRIGGER "FunnelActionOutbox_redact_payload" BEFORE UPDATE OF "payload" ON "FunnelActionOutbox"
WHEN NEW."payload" IS NOT OLD."payload" AND NOT (NEW."status" = 'CANCELLED' AND json(NEW."payload") = '{}')
BEGIN SELECT RAISE(ABORT, 'Outbox payload may only be removed on cancellation'); END;
CREATE TRIGGER "FunnelActionOutbox_no_reactivate" BEFORE UPDATE OF "status" ON "FunnelActionOutbox"
WHEN OLD."status" = 'CANCELLED' AND NEW."status" != 'CANCELLED'
BEGIN SELECT RAISE(ABORT, 'Cancelled outbox records cannot be reactivated'); END;
