-- Explicit automation authority, immutable waits and shared provider delivery leases.
-- Existing manual enrollments and tracking-only outboxes receive no execution rows.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

ALTER TABLE "Funnel" ADD COLUMN "automationEnrolmentEnabled" BOOLEAN NOT NULL DEFAULT false CHECK ("automationEnrolmentEnabled" IN (0,1));

ALTER TABLE "Funnel" ADD COLUMN "automationDispatchEnabled" BOOLEAN NOT NULL DEFAULT false CHECK ("automationDispatchEnabled" IN (0,1));

ALTER TABLE "FunnelEvaluationReceipt" ADD COLUMN "sourceGeneration" INTEGER CHECK ("sourceGeneration" IS NULL OR "sourceGeneration">=1);

ALTER TABLE "MessageSend" ADD COLUMN "reconcileAttemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("reconcileAttemptCount">=0);

ALTER TABLE "MessageSend" ADD COLUMN "lastReconciledAt" DATETIME;

ALTER TABLE "MessageSend" ADD COLUMN "reconcileErrorCode" TEXT;

CREATE TABLE "new_FunnelEvidenceEffect" (
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
    "evaluationEventId" TEXT,
    "evaluatedStageKey" TEXT,
    "evaluationJourneyRevision" INTEGER CHECK ("evaluationJourneyRevision" IS NULL OR "evaluationJourneyRevision">=1),
    "evaluationOccurredAt" DATETIME,
    CONSTRAINT "FunnelEvidenceEffect_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_funnelId_ownerId_environment_fkey" FOREIGN KEY ("funnelId", "ownerId", "environment") REFERENCES "Funnel" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_versionId_funnelId_ownerId_environment_fkey" FOREIGN KEY ("versionId", "funnelId", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "funnelId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_subjectId_ownerId_environment_fkey" FOREIGN KEY ("subjectId", "ownerId", "environment") REFERENCES "FunnelSubject" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_journeyId_funnelId_versionId_subjectId_cycle_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "funnelId", "versionId", "subjectId", "cycle", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "funnelId", "versionId", "subjectId", "cycle", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
,
    CONSTRAINT "FunnelEvidenceEffect_evaluationEventId_ownerId_environment_fkey" FOREIGN KEY ("evaluationEventId","ownerId","environment") REFERENCES "TrackingEvent" ("id","ownerId","environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelEvidenceEffect_evaluatedStageKey_versionId_ownerId_environment_fkey" FOREIGN KEY ("evaluatedStageKey","versionId","ownerId","environment") REFERENCES "FunnelStage" ("key","versionId","ownerId","environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CHECK (("evaluationEventId" IS NULL)=("evaluationOccurredAt" IS NULL)),
    CHECK (("evaluatedStageKey" IS NULL)=("evaluationJourneyRevision" IS NULL)),
    CHECK ("evaluatedStageKey" IS NULL OR ("evaluationEventId" IS NOT NULL AND "journeyId" IS NOT NULL))
);

INSERT INTO "new_FunnelEvidenceEffect" ("id", "ownerId", "environment", "funnelId", "versionId", "subjectId", "cycle", "journeyId", "evidenceKey", "outcome", "ruleId", "createdAt") SELECT "id", "ownerId", "environment", "funnelId", "versionId", "subjectId", "cycle", "journeyId", "evidenceKey", "outcome", "ruleId", "createdAt" FROM "FunnelEvidenceEffect";

DROP TABLE "FunnelEvidenceEffect";

ALTER TABLE "new_FunnelEvidenceEffect" RENAME TO "FunnelEvidenceEffect";

CREATE TABLE "new_FunnelActionOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "journeyId" TEXT NOT NULL,
    "transitionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" = 'STAGE_ENTERED'),
    "actionKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('LIVE', 'BACKFILL', 'REPLAY')),
    "effectEligibility" TEXT NOT NULL DEFAULT 'TRACKING_ONLY' CHECK ("effectEligibility" IN ('TRACKING_ONLY','AUTOMATION','CANCELLATION_ONLY')),
    "status" TEXT NOT NULL DEFAULT 'RECORDED' CHECK ("status" IN ('RECORDED', 'CONSUMED', 'CANCELLED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "FunnelActionOutbox_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionOutbox_journeyId_ownerId_environment_fkey" FOREIGN KEY ("journeyId", "ownerId", "environment") REFERENCES "FunnelJourney" ("id", "ownerId", "environment") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionOutbox_transitionId_journeyId_ownerId_environment_fkey" FOREIGN KEY ("transitionId", "journeyId", "ownerId", "environment") REFERENCES "FunnelStageTransition" ("id", "journeyId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
,
    CHECK ("effectEligibility" != 'AUTOMATION' OR "mode" = 'LIVE')
);

INSERT INTO "new_FunnelActionOutbox" ("id", "ownerId", "environment", "journeyId", "transitionId", "kind", "actionKey", "payload", "mode", "effectEligibility", "status", "createdAt", "completedAt") SELECT "id", "ownerId", "environment", "journeyId", "transitionId", "kind", "actionKey", "payload", "mode", "effectEligibility", "status", "createdAt", "completedAt" FROM "FunnelActionOutbox";

DROP TABLE "FunnelActionOutbox";

ALTER TABLE "new_FunnelActionOutbox" RENAME TO "FunnelActionOutbox";

CREATE TABLE "new_EmailSender" (
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
    "refreshStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "refreshRevision" INTEGER NOT NULL DEFAULT 1,
    "refreshMembershipId" TEXT,
    "refreshLeaseTokenHash" TEXT,
    "refreshLeaseUntil" DATETIME,
    "refreshConnectionGeneration" INTEGER,
    "refreshCredentialVersion" INTEGER,
    "refreshAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "refreshNextAttemptAt" DATETIME,
    "refreshLastAttemptAt" DATETIME,
    "refreshCompletedAt" DATETIME,
    "refreshErrorCode" TEXT,
    CONSTRAINT "EmailSender_connectionId_ownerId_environment_fkey" FOREIGN KEY ("connectionId", "ownerId", "environment") REFERENCES "EmailConnection" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "EmailSender_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK ("status" IN ('UNVERIFIED','VERIFIED','UNAVAILABLE'))
,
    CONSTRAINT "EmailSender_refreshMembershipId_ownerId_environment_fkey" FOREIGN KEY ("refreshMembershipId", "ownerId", "environment") REFERENCES "CampaignMembership" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CHECK ("refreshStatus" IN ('IDLE','CLAIMED','RETRY','BLOCKED')),
    CHECK ("refreshRevision">=1 AND "refreshAttemptCount">=0),
    CHECK (("refreshLeaseTokenHash" IS NULL)=("refreshLeaseUntil" IS NULL)),
    CHECK (("refreshStatus"='CLAIMED')=("refreshLeaseTokenHash" IS NOT NULL)),
    CHECK ("refreshStatus"!='CLAIMED' OR ("refreshConnectionGeneration" IS NOT NULL AND "refreshCredentialVersion" IS NOT NULL AND "refreshLastAttemptAt" IS NOT NULL)),
    CHECK ("refreshConnectionGeneration" IS NULL OR "refreshConnectionGeneration">=1),
    CHECK ("refreshCredentialVersion" IS NULL OR "refreshCredentialVersion">=1),
    CHECK ("refreshStatus"!='RETRY' OR "refreshNextAttemptAt" IS NOT NULL)
);

INSERT INTO "new_EmailSender" ("id", "ownerId", "environment", "createdAt", "connectionId", "address", "name", "replyTo", "domainId", "status", "verifiedAt", "readiness", "updatedAt") SELECT "id", "ownerId", "environment", "createdAt", "connectionId", "address", "name", "replyTo", "domainId", "status", "verifiedAt", "readiness", "updatedAt" FROM "EmailSender";

DROP TABLE "EmailSender";

ALTER TABLE "new_EmailSender" RENAME TO "EmailSender";

CREATE TABLE "new_CampaignMembershipReason" (
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
    "actionExecutionId" TEXT,
    "stopOnStageExit" BOOLEAN NOT NULL DEFAULT false,
    "stopOnGoal" BOOLEAN NOT NULL DEFAULT false,
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
,
    CONSTRAINT "CampaignMembershipReason_actionExecutionId_membershipId_journeyId_transitionId_versionId_stageKey_campaignId_requestedRevisionId_ownerId_environment_fkey" FOREIGN KEY ("actionExecutionId", "membershipId", "journeyId", "transitionId", "versionId", "stageKey", "campaignId", "requestedRevisionId", "ownerId", "environment") REFERENCES "FunnelActionExecution" ("id", "membershipId", "journeyId", "transitionId", "versionId", "stageKey", "campaignId", "requestedRevisionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CHECK ("stopOnStageExit" IN (0,1) AND "stopOnGoal" IN (0,1)),
    CHECK ("kind"!='MANUAL' OR ("actionExecutionId" IS NULL AND "stopOnStageExit"=0 AND "stopOnGoal"=0))
);

INSERT INTO "new_CampaignMembershipReason" ("id", "ownerId", "environment", "createdAt", "membershipId", "campaignId", "requestedRevisionId", "kind", "requestKey", "requestDigest", "journeyId", "transitionId", "versionId", "stageKey", "linkId", "actorId", "note", "endedAt", "endReason", "redactedAt") SELECT "id", "ownerId", "environment", "createdAt", "membershipId", "campaignId", "requestedRevisionId", "kind", "requestKey", "requestDigest", "journeyId", "transitionId", "versionId", "stageKey", "linkId", "actorId", "note", "endedAt", "endReason", "redactedAt" FROM "CampaignMembershipReason";

DROP TABLE "CampaignMembershipReason";

ALTER TABLE "new_CampaignMembershipReason" RENAME TO "CampaignMembershipReason";

CREATE TABLE "FunnelActionExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "transitionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedRevisionId" TEXT,
    "membershipId" TEXT,
    "plan" JSONB NOT NULL,
    "mode" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "evaluationTrace" JSONB NOT NULL DEFAULT '{}',
    "nextWakeAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FunnelActionExecution_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionExecution_outboxId_journeyId_transitionId_ownerId_environment_fkey" FOREIGN KEY ("outboxId", "journeyId", "transitionId", "ownerId", "environment") REFERENCES "FunnelActionOutbox" ("id", "journeyId", "transitionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionExecution_transitionId_journeyId_versionId_stageKey_ownerId_environment_fkey" FOREIGN KEY ("transitionId", "journeyId", "versionId", "stageKey", "ownerId", "environment") REFERENCES "FunnelStageTransition" ("id", "journeyId", "versionId", "toStageKey", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionExecution_campaignId_ownerId_environment_fkey" FOREIGN KEY ("campaignId", "ownerId", "environment") REFERENCES "MarketingCampaign" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionExecution_requestedRevisionId_campaignId_ownerId_environment_fkey" FOREIGN KEY ("requestedRevisionId", "campaignId", "ownerId", "environment") REFERENCES "CampaignRevision" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "FunnelActionExecution_membershipId_campaignId_ownerId_environment_fkey" FOREIGN KEY ("membershipId", "campaignId", "ownerId", "environment") REFERENCES "CampaignMembership" ("id", "campaignId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CHECK ("environment" IN ('TEST','LIVE')),
    CHECK ("kind" IN ('EMAIL_ENROLL','EMAIL_STOP')),
    CHECK ("mode" IN ('LIVE','BACKFILL','REPLAY')),
    CHECK ("status" IN ('PENDING','APPLIED','SKIPPED','CANCELLED','FAILED')),
    CHECK ("revision">=1),
    CHECK (("kind"='EMAIL_ENROLL' AND "requestedRevisionId" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt">"dueAt" AND "mode"='LIVE') OR ("kind"='EMAIL_STOP' AND "requestedRevisionId" IS NULL AND "expiresAt" IS NULL)),
    CHECK (("status"='PENDING')=("completedAt" IS NULL)),
    CHECK ("redactedAt" IS NULL OR (json("evaluationTrace")='{}' AND "status"!='PENDING'))
);

CREATE TABLE "CampaignStepExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "authorizationKind" TEXT NOT NULL,
    "authorizationRequestKey" TEXT,
    "authorizationRequestDigest" TEXT,
    "authorizationActorId" TEXT,
    "authorizationReason" TEXT,
    "authorizationActionExecutionId" TEXT,
    "previousExecutionId" TEXT,
    "sequenceAnchorAt" DATETIME NOT NULL,
    "waitStartedAt" DATETIME NOT NULL,
    "waitAnchorAt" DATETIME NOT NULL,
    "waitDeadlineAt" DATETIME,
    "dueAt" DATETIME,
    "expiresAt" DATETIME,
    "waitSourceId" TEXT,
    "sourceGeneration" INTEGER,
    "receiptId" TEXT,
    "eventId" TEXT,
    "matchRevision" INTEGER,
    "evidenceAvailableAt" DATETIME,
    "sendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "reason" TEXT,
    "evaluationTrace" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" DATETIME,
    "completedAt" DATETIME,
    "nextWakeAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CampaignStepExecution_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_membershipId_revisionId_ownerId_environment_fkey" FOREIGN KEY ("membershipId", "revisionId", "ownerId", "environment") REFERENCES "CampaignMembership" ("id", "revisionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_stepId_revisionId_ownerId_environment_fkey" FOREIGN KEY ("stepId", "revisionId", "ownerId", "environment") REFERENCES "CampaignStep" ("id", "revisionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_authorizationActionExecutionId_membershipId_ownerId_environment_fkey" FOREIGN KEY ("authorizationActionExecutionId", "membershipId", "ownerId", "environment") REFERENCES "FunnelActionExecution" ("id", "membershipId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_previousExecutionId_membershipId_revisionId_ownerId_environment_fkey" FOREIGN KEY ("previousExecutionId", "membershipId", "revisionId", "ownerId", "environment") REFERENCES "CampaignStepExecution" ("id", "membershipId", "revisionId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "CampaignStepExecution_waitSourceId_ownerId_environment_fkey" FOREIGN KEY ("waitSourceId", "ownerId", "environment") REFERENCES "TrackingSource" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_receiptId_eventId_matchRevision_ownerId_environment_fkey" FOREIGN KEY ("receiptId", "eventId", "matchRevision", "ownerId", "environment") REFERENCES "FunnelEvaluationReceipt" ("id", "eventId", "matchRevision", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "CampaignStepExecution_sendId_membershipId_revisionId_stepId_iteration_ownerId_environment_fkey" FOREIGN KEY ("sendId", "membershipId", "revisionId", "stepId", "iteration", "ownerId", "environment") REFERENCES "MessageSend" ("id", "membershipId", "revisionId", "stepId", "iteration", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE,
    CHECK ("environment" IN ('TEST','LIVE')),
    CHECK ("iteration">=1 AND "revision">=1),
    CHECK ("authorizationKind" IN ('MANUAL','STAGE','CONTINUATION')),
    CHECK ("status" IN ('WAITING','READY','SEND_PENDING','ACCEPTED','SKIPPED','CANCELLED','FAILED')),
    CHECK (("dueAt" IS NULL)=("expiresAt" IS NULL)),
    CHECK ("expiresAt" IS NULL OR "expiresAt">"dueAt"),
    CHECK ("sourceGeneration" IS NULL OR "sourceGeneration">=1),
    CHECK ("matchRevision" IS NULL OR "matchRevision">=1),
    CHECK (("receiptId" IS NULL AND "eventId" IS NULL AND "matchRevision" IS NULL AND "evidenceAvailableAt" IS NULL) OR ("receiptId" IS NOT NULL AND "eventId" IS NOT NULL AND "matchRevision" IS NOT NULL AND "evidenceAvailableAt" IS NOT NULL)),
    CHECK (("status" IN ('WAITING','READY','SEND_PENDING'))=("completedAt" IS NULL)),
    CHECK ("status" NOT IN ('READY','SEND_PENDING','ACCEPTED') OR ("dueAt" IS NOT NULL AND "resolvedAt" IS NOT NULL)),
    CHECK ("status" NOT IN ('SEND_PENDING','ACCEPTED') OR "sendId" IS NOT NULL),
    CHECK (("authorizationKind"='MANUAL' AND "previousExecutionId" IS NULL AND "authorizationActionExecutionId" IS NULL AND "authorizationRequestKey" IS NOT NULL AND "authorizationRequestDigest" IS NOT NULL AND "authorizationActorId" IS NOT NULL AND ("authorizationReason" IS NOT NULL OR "redactedAt" IS NOT NULL)) OR
     ("authorizationKind"='STAGE' AND "previousExecutionId" IS NULL AND "authorizationActionExecutionId" IS NOT NULL AND "authorizationRequestKey" IS NULL AND "authorizationRequestDigest" IS NULL AND "authorizationActorId" IS NULL AND "authorizationReason" IS NULL) OR
     ("authorizationKind"='CONTINUATION' AND "previousExecutionId" IS NOT NULL AND "authorizationActionExecutionId" IS NULL AND "authorizationRequestKey" IS NULL AND "authorizationRequestDigest" IS NULL AND "authorizationActorId" IS NULL AND "authorizationReason" IS NULL)),
    CHECK ("redactedAt" IS NULL OR ("authorizationReason" IS NULL AND json("evaluationTrace")='{}' AND "status" NOT IN ('WAITING','READY')))
);

CREATE INDEX "FunnelEvidenceEffect_ownerId_environment_subjectId_idx" ON "FunnelEvidenceEffect"("ownerId", "environment", "subjectId");

CREATE UNIQUE INDEX "FunnelEvidenceEffect_funnelId_subjectId_cycle_evidenceKey_key" ON "FunnelEvidenceEffect"("funnelId", "subjectId", "cycle", "evidenceKey");

CREATE TRIGGER "FunnelEvidenceEffect_immutable" BEFORE UPDATE ON "FunnelEvidenceEffect"
BEGIN SELECT RAISE(ABORT, 'Published funnel definitions and evidence are immutable'); END;

CREATE TRIGGER "FunnelEvidenceEffect_retain_history" BEFORE DELETE ON "FunnelEvidenceEffect"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Funnel history must be retained or redacted'); END;

CREATE INDEX "FunnelActionOutbox_ownerId_environment_status_createdAt_idx" ON "FunnelActionOutbox"("ownerId", "environment", "status", "createdAt");

CREATE UNIQUE INDEX "FunnelActionOutbox_transitionId_kind_actionKey_key" ON "FunnelActionOutbox"("transitionId", "kind", "actionKey");

CREATE TRIGGER "FunnelActionOutbox_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "journeyId", "transitionId", "kind", "actionKey", "mode", "effectEligibility", "createdAt" ON "FunnelActionOutbox"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."transitionId" IS NOT OLD."transitionId" OR NEW."kind" IS NOT OLD."kind" OR NEW."actionKey" IS NOT OLD."actionKey" OR NEW."mode" IS NOT OLD."mode" OR NEW."effectEligibility" IS NOT OLD."effectEligibility" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "FunnelActionOutbox_redact_payload" BEFORE UPDATE OF "payload" ON "FunnelActionOutbox"
WHEN NEW."payload" IS NOT OLD."payload" AND NOT (NEW."status" = 'CANCELLED' AND json(NEW."payload") = '{}')
BEGIN SELECT RAISE(ABORT, 'Outbox payload may only be removed on cancellation'); END;

CREATE TRIGGER "FunnelActionOutbox_no_reactivate" BEFORE UPDATE OF "status" ON "FunnelActionOutbox"
WHEN OLD."status" = 'CANCELLED' AND NEW."status" != 'CANCELLED'
BEGIN SELECT RAISE(ABORT, 'Cancelled outbox records cannot be reactivated'); END;

CREATE INDEX "EmailSender_connectionId_status_idx" ON "EmailSender"("connectionId", "status");

CREATE UNIQUE INDEX "EmailSender_id_connectionId_ownerId_environment_key" ON "EmailSender"("id", "connectionId", "ownerId", "environment");

CREATE UNIQUE INDEX "EmailSender_id_ownerId_environment_key" ON "EmailSender"("id", "ownerId", "environment");

CREATE TRIGGER "EmailSender_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "connectionId", "address", "name", "replyTo", "domainId" ON "EmailSender"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."connectionId" IS NOT OLD."connectionId" OR NEW."address" IS NOT OLD."address" OR NEW."name" IS NOT OLD."name" OR NEW."replyTo" IS NOT OLD."replyTo" OR NEW."domainId" IS NOT OLD."domainId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "EmailSender_retain_history" BEFORE DELETE ON "EmailSender"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE INDEX "CampaignMembershipReason_membershipId_endedAt_idx" ON "CampaignMembershipReason"("membershipId", "endedAt");

CREATE UNIQUE INDEX "CampaignMembershipReason_ownerId_environment_requestKey_key" ON "CampaignMembershipReason"("ownerId", "environment", "requestKey");

CREATE UNIQUE INDEX "CampaignMembershipReason_id_membershipId_ownerId_environment_key" ON "CampaignMembershipReason"("id", "membershipId", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignMembershipReason_id_ownerId_environment_key" ON "CampaignMembershipReason"("id", "ownerId", "environment");

CREATE TRIGGER "CampaignMembershipReason_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "createdAt", "membershipId", "campaignId", "requestedRevisionId", "kind", "requestKey", "requestDigest", "journeyId", "transitionId", "versionId", "stageKey", "linkId", "actorId" ON "CampaignMembershipReason"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."membershipId" IS NOT OLD."membershipId" OR NEW."campaignId" IS NOT OLD."campaignId" OR NEW."requestedRevisionId" IS NOT OLD."requestedRevisionId" OR NEW."kind" IS NOT OLD."kind" OR NEW."requestKey" IS NOT OLD."requestKey" OR NEW."requestDigest" IS NOT OLD."requestDigest" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."transitionId" IS NOT OLD."transitionId" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."stageKey" IS NOT OLD."stageKey" OR NEW."linkId" IS NOT OLD."linkId" OR NEW."actorId" IS NOT OLD."actorId"
BEGIN SELECT RAISE(ABORT, 'Email record identity is immutable'); END;

CREATE TRIGGER "CampaignMembershipReason_retain_history" BEFORE DELETE ON "CampaignMembershipReason"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Email history is retained until account deletion'); END;

CREATE TRIGGER "CampaignMembershipReason_end_once" BEFORE UPDATE OF "endedAt","endReason" ON "CampaignMembershipReason"
WHEN OLD."endedAt" IS NOT NULL AND (NEW."endedAt" IS NOT OLD."endedAt" OR NEW."endReason" IS NOT OLD."endReason")
BEGIN SELECT RAISE(ABORT, 'Membership reason ending is immutable'); END;

CREATE TRIGGER "CampaignMembershipReason_redact_note" BEFORE UPDATE OF "note","redactedAt" ON "CampaignMembershipReason"
WHEN (NEW."note" IS NOT OLD."note" OR NEW."redactedAt" IS NOT OLD."redactedAt") AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."note" IS NULL)
BEGIN SELECT RAISE(ABORT, 'Membership notes only permit explicit redaction'); END;

CREATE INDEX "EmailSender_refreshStatus_refreshNextAttemptAt_refreshLeaseUntil_idx" ON "EmailSender"("refreshStatus", "refreshNextAttemptAt", "refreshLeaseUntil");

CREATE UNIQUE INDEX "CampaignMembershipReason_actionExecutionId_key" ON "CampaignMembershipReason"("actionExecutionId");

CREATE UNIQUE INDEX "CampaignMembershipReason_action_binding_key" ON "CampaignMembershipReason"("actionExecutionId", "membershipId", "journeyId", "transitionId", "versionId", "stageKey", "campaignId", "requestedRevisionId", "ownerId", "environment");

CREATE INDEX "MessageSend_status_nextAttemptAt_leaseUntil_idx" ON "MessageSend"("status", "nextAttemptAt", "leaseUntil");

CREATE UNIQUE INDEX "MessageSend_step_execution_binding_key" ON "MessageSend"("id", "membershipId", "revisionId", "stepId", "iteration", "ownerId", "environment");

CREATE INDEX "FunnelActionExecution_status_nextWakeAt_dueAt_idx" ON "FunnelActionExecution"("status", "nextWakeAt", "dueAt");

CREATE INDEX "FunnelActionExecution_ownerId_environment_journeyId_status_idx" ON "FunnelActionExecution"("ownerId", "environment", "journeyId", "status");

CREATE UNIQUE INDEX "FunnelActionExecution_id_ownerId_environment_key" ON "FunnelActionExecution"("id", "ownerId", "environment");

CREATE UNIQUE INDEX "FunnelActionExecution_outboxId_actionKey_key" ON "FunnelActionExecution"("outboxId", "actionKey");

CREATE UNIQUE INDEX "FunnelActionExecution_reason_binding_key" ON "FunnelActionExecution"("id", "membershipId", "journeyId", "transitionId", "versionId", "stageKey", "campaignId", "requestedRevisionId", "ownerId", "environment");

CREATE UNIQUE INDEX "FunnelActionExecution_step_authorization_key" ON "FunnelActionExecution"("id", "membershipId", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignStepExecution_authorizationActionExecutionId_key" ON "CampaignStepExecution"("authorizationActionExecutionId");

CREATE UNIQUE INDEX "CampaignStepExecution_previousExecutionId_key" ON "CampaignStepExecution"("previousExecutionId");

CREATE UNIQUE INDEX "CampaignStepExecution_sendId_key" ON "CampaignStepExecution"("sendId");

CREATE INDEX "CampaignStepExecution_status_nextWakeAt_idx" ON "CampaignStepExecution"("status", "nextWakeAt");

CREATE INDEX "CampaignStepExecution_membershipId_status_idx" ON "CampaignStepExecution"("membershipId", "status");

CREATE INDEX "CampaignStepExecution_waitSourceId_status_waitDeadlineAt_idx" ON "CampaignStepExecution"("waitSourceId", "status", "waitDeadlineAt");

CREATE UNIQUE INDEX "CampaignStepExecution_id_ownerId_environment_key" ON "CampaignStepExecution"("id", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignStepExecution_membershipId_stepId_iteration_key" ON "CampaignStepExecution"("membershipId", "stepId", "iteration");

CREATE UNIQUE INDEX "CampaignStepExecution_ownerId_environment_authorizationRequestKey_key" ON "CampaignStepExecution"("ownerId", "environment", "authorizationRequestKey");

CREATE UNIQUE INDEX "CampaignStepExecution_previous_binding_key" ON "CampaignStepExecution"("previousExecutionId", "membershipId", "revisionId", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignStepExecution_authorization_binding_key" ON "CampaignStepExecution"("authorizationActionExecutionId", "membershipId", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignStepExecution_send_binding_key" ON "CampaignStepExecution"("sendId", "membershipId", "revisionId", "stepId", "iteration", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignStepExecution_continuation_key" ON "CampaignStepExecution"("id", "membershipId", "revisionId", "ownerId", "environment");

CREATE UNIQUE INDEX "FunnelEvaluationReceipt_wait_binding_key" ON "FunnelEvaluationReceipt"("id", "eventId", "matchRevision", "ownerId", "environment");

CREATE UNIQUE INDEX "FunnelActionOutbox_id_ownerId_environment_key" ON "FunnelActionOutbox"("id", "ownerId", "environment");

CREATE UNIQUE INDEX "FunnelActionOutbox_execution_binding_key" ON "FunnelActionOutbox"("id", "journeyId", "transitionId", "ownerId", "environment");

CREATE UNIQUE INDEX "CampaignMembership_step_binding_key" ON "CampaignMembership"("id", "revisionId", "ownerId", "environment");

CREATE INDEX "FunnelEvidenceEffect_journeyId_evaluationJourneyRevision_ruleId_createdAt_idx" ON "FunnelEvidenceEffect"("journeyId","evaluationJourneyRevision","ruleId","createdAt");

CREATE TRIGGER "FunnelEvaluationReceipt_generation_immutable" BEFORE UPDATE OF "sourceGeneration" ON "FunnelEvaluationReceipt"
WHEN NEW."sourceGeneration" IS NOT OLD."sourceGeneration"
BEGIN SELECT RAISE(ABORT, 'Automation identity and captured timing are immutable'); END;

CREATE TRIGGER "FunnelEvaluationReceipt_generation_matches" BEFORE INSERT ON "FunnelEvaluationReceipt"
WHEN NEW."sourceGeneration" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "TrackingEvent" WHERE "id"=NEW."eventId" AND "sourceGeneration"=NEW."sourceGeneration")
BEGIN SELECT RAISE(ABORT, 'Evaluation generation must match immutable source evidence'); END;

CREATE TRIGGER "FunnelEvidenceEffect_evaluation_binding" BEFORE INSERT ON "FunnelEvidenceEffect"
WHEN NEW."evaluationEventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "TrackingEvent" e WHERE e."id"=NEW."evaluationEventId" AND e."ownerId"=NEW."ownerId" AND e."environment"=NEW."environment" AND e."subjectId"=NEW."subjectId" AND e."occurredAt"=NEW."evaluationOccurredAt")
BEGIN SELECT RAISE(ABORT, 'Evaluation cause must match its owned subject and immutable occurrence'); END;

CREATE TRIGGER "MessageSend_reconciliation_counter" BEFORE UPDATE OF "reconcileAttemptCount" ON "MessageSend"
WHEN NEW."reconcileAttemptCount"<OLD."reconcileAttemptCount"
BEGIN SELECT RAISE(ABORT, 'Automatic reconciliation count cannot reset'); END;

CREATE TRIGGER "FunnelActionOutbox_no_replay" BEFORE UPDATE OF "status" ON "FunnelActionOutbox"
WHEN (OLD."effectEligibility"='TRACKING_ONLY' AND NEW."status" NOT IN (OLD."status",'CANCELLED')) OR (OLD."status"='CONSUMED' AND NEW."status" NOT IN ('CONSUMED','CANCELLED'))
BEGIN SELECT RAISE(ABORT, 'Historical or consumed outbox cannot authorize replay'); END;

CREATE TRIGGER "FunnelActionOutbox_completed_once" BEFORE UPDATE OF "completedAt" ON "FunnelActionOutbox"
WHEN OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS NOT OLD."completedAt"
BEGIN SELECT RAISE(ABORT, 'Outbox completion is immutable'); END;

CREATE TRIGGER "FunnelActionOutbox_manual_tracking_only" BEFORE INSERT ON "FunnelActionOutbox"
WHEN NEW."effectEligibility"!='TRACKING_ONLY' AND EXISTS (SELECT 1 FROM "FunnelStageTransition" WHERE "id"=NEW."transitionId" AND "triggerKind"='MANUAL')
BEGIN SELECT RAISE(ABORT, 'Manual transitions cannot authorize automation'); END;

CREATE TRIGGER "EmailSender_refresh_authority_insert" BEFORE INSERT ON "EmailSender"
WHEN NEW."refreshMembershipId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CampaignMembership" m JOIN "CampaignRevision" r ON r."id"=m."revisionId" WHERE m."id"=NEW."refreshMembershipId" AND m."ownerId"=NEW."ownerId" AND m."environment"=NEW."environment" AND r."senderId"=NEW."id")
BEGIN SELECT RAISE(ABORT, 'Sender refresh must use the pinned membership sender'); END;

CREATE TRIGGER "EmailSender_refresh_authority_update" BEFORE UPDATE OF "refreshMembershipId" ON "EmailSender"
WHEN NEW."refreshMembershipId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CampaignMembership" m JOIN "CampaignRevision" r ON r."id"=m."revisionId" WHERE m."id"=NEW."refreshMembershipId" AND m."ownerId"=NEW."ownerId" AND m."environment"=NEW."environment" AND r."senderId"=NEW."id")
BEGIN SELECT RAISE(ABORT, 'Sender refresh must use the pinned membership sender'); END;

CREATE TRIGGER "CampaignMembershipReason_action_immutable" BEFORE UPDATE OF "actionExecutionId","stopOnStageExit","stopOnGoal" ON "CampaignMembershipReason"
WHEN NEW."actionExecutionId" IS NOT OLD."actionExecutionId" OR NEW."stopOnStageExit" IS NOT OLD."stopOnStageExit" OR NEW."stopOnGoal" IS NOT OLD."stopOnGoal"
BEGIN SELECT RAISE(ABORT, 'Automation identity and captured timing are immutable'); END;

CREATE TRIGGER "CampaignMembershipReason_stage_authority" BEFORE INSERT ON "CampaignMembershipReason"
WHEN NEW."kind"='STAGE' AND NOT EXISTS (SELECT 1 FROM "FunnelActionExecution" a WHERE a."id"=NEW."actionExecutionId" AND a."kind"='EMAIL_ENROLL' AND a."membershipId"=NEW."membershipId" AND a."status" IN ('PENDING','APPLIED') AND a."redactedAt" IS NULL AND NEW."stopOnStageExit"=COALESCE(json_extract(a."plan",'$.stopOnStageExit'),1) AND NEW."stopOnGoal"=COALESCE(json_extract(a."plan",'$.stopOnGoal'),1))
BEGIN SELECT RAISE(ABORT, 'Stage reason requires its captured enrollment action'); END;

CREATE TRIGGER "FunnelActionExecution_retain_history" BEFORE DELETE ON "FunnelActionExecution"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Automation tombstones are retained until account deletion'); END;

CREATE TRIGGER "CampaignStepExecution_retain_history" BEFORE DELETE ON "CampaignStepExecution"
WHEN EXISTS (SELECT 1 FROM "User" WHERE "id"=OLD."ownerId")
BEGIN SELECT RAISE(ABORT, 'Automation tombstones are retained until account deletion'); END;

CREATE TRIGGER "FunnelActionExecution_immutable_identity" BEFORE UPDATE OF "id","ownerId","environment","outboxId","journeyId","transitionId","versionId","stageKey","actionKey","kind","campaignId","requestedRevisionId","plan","mode","dueAt","expiresAt","createdAt" ON "FunnelActionExecution"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."outboxId" IS NOT OLD."outboxId" OR NEW."journeyId" IS NOT OLD."journeyId" OR NEW."transitionId" IS NOT OLD."transitionId" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."stageKey" IS NOT OLD."stageKey" OR NEW."actionKey" IS NOT OLD."actionKey" OR NEW."kind" IS NOT OLD."kind" OR NEW."campaignId" IS NOT OLD."campaignId" OR NEW."requestedRevisionId" IS NOT OLD."requestedRevisionId" OR NEW."plan" IS NOT OLD."plan" OR NEW."mode" IS NOT OLD."mode" OR NEW."dueAt" IS NOT OLD."dueAt" OR NEW."expiresAt" IS NOT OLD."expiresAt" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Automation identity and captured timing are immutable'); END;

CREATE TRIGGER "FunnelActionExecution_membership_once" BEFORE UPDATE OF "membershipId" ON "FunnelActionExecution"
WHEN (OLD."membershipId" IS NOT NULL OR OLD."status"!='PENDING') AND NEW."membershipId" IS NOT OLD."membershipId"
BEGIN SELECT RAISE(ABORT, 'Action membership binding is immutable'); END;

CREATE TRIGGER "FunnelActionExecution_captured_plan" BEFORE INSERT ON "FunnelActionExecution"
WHEN NOT EXISTS (
 SELECT 1 FROM "FunnelActionOutbox" o, json_each(o."payload",'$.actions') a
 WHERE o."id"=NEW."outboxId" AND o."status" IN ('RECORDED','CONSUMED') AND o."effectEligibility"!='TRACKING_ONLY'
 AND o."mode"=NEW."mode" AND (NEW."kind"!='EMAIL_ENROLL' OR o."effectEligibility"='AUTOMATION')
 AND json_extract(a.value,'$.id')=NEW."actionKey" AND json_extract(a.value,'$.kind')=NEW."kind"
 AND json_extract(a.value,'$.campaignId')=NEW."campaignId" AND json_extract(a.value,'$.revisionId') IS NEW."requestedRevisionId"
 AND json(a.value)=json(NEW."plan")
)
BEGIN SELECT RAISE(ABORT, 'Action requires its original captured outbox plan'); END;

CREATE TRIGGER "FunnelActionExecution_terminal_once" BEFORE UPDATE ON "FunnelActionExecution"
WHEN OLD."status" IN ('APPLIED','SKIPPED','CANCELLED','FAILED') AND (NEW."status" IS NOT OLD."status" OR NEW."completedAt" IS NOT OLD."completedAt" OR NEW."reason" IS NOT OLD."reason")
BEGIN SELECT RAISE(ABORT, 'Resolved automation outcome cannot be changed or replayed'); END;

CREATE TRIGGER "FunnelActionExecution_redaction_once" BEFORE UPDATE OF "redactedAt","evaluationTrace" ON "FunnelActionExecution"
WHEN (OLD."redactedAt" IS NOT NULL AND (NEW."redactedAt" IS NOT OLD."redactedAt" OR json(NEW."evaluationTrace")!='{}')) OR (NEW."redactedAt" IS NOT OLD."redactedAt" AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND json(NEW."evaluationTrace")='{}'))
BEGIN SELECT RAISE(ABORT, 'Automation evidence permits only explicit one-time redaction'); END;

CREATE TRIGGER "FunnelActionExecution_terminal_trace" BEFORE UPDATE OF "evaluationTrace" ON "FunnelActionExecution"
WHEN OLD."status" IN ('APPLIED','SKIPPED','CANCELLED','FAILED') AND NEW."evaluationTrace" IS NOT OLD."evaluationTrace" AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND json(NEW."evaluationTrace")='{}')
BEGIN SELECT RAISE(ABORT, 'Completed automation trace is immutable except redaction'); END;

CREATE TRIGGER "CampaignStepExecution_terminal_once" BEFORE UPDATE ON "CampaignStepExecution"
WHEN OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED') AND (NEW."status" IS NOT OLD."status" OR NEW."completedAt" IS NOT OLD."completedAt" OR NEW."reason" IS NOT OLD."reason")
BEGIN SELECT RAISE(ABORT, 'Resolved automation outcome cannot be changed or replayed'); END;

CREATE TRIGGER "CampaignStepExecution_redaction_once" BEFORE UPDATE OF "redactedAt","evaluationTrace" ON "CampaignStepExecution"
WHEN (OLD."redactedAt" IS NOT NULL AND (NEW."redactedAt" IS NOT OLD."redactedAt" OR json(NEW."evaluationTrace")!='{}')) OR (NEW."redactedAt" IS NOT OLD."redactedAt" AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND json(NEW."evaluationTrace")='{}'))
BEGIN SELECT RAISE(ABORT, 'Automation evidence permits only explicit one-time redaction'); END;

CREATE TRIGGER "CampaignStepExecution_terminal_trace" BEFORE UPDATE OF "evaluationTrace" ON "CampaignStepExecution"
WHEN OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED') AND NEW."evaluationTrace" IS NOT OLD."evaluationTrace" AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND json(NEW."evaluationTrace")='{}')
BEGIN SELECT RAISE(ABORT, 'Completed automation trace is immutable except redaction'); END;

CREATE TRIGGER "CampaignStepExecution_immutable_identity" BEFORE UPDATE OF "id","ownerId","environment","membershipId","revisionId","stepId","iteration","authorizationKind","authorizationRequestKey","authorizationRequestDigest","authorizationActorId","authorizationActionExecutionId","previousExecutionId","sequenceAnchorAt","waitStartedAt","waitAnchorAt","waitDeadlineAt","waitSourceId","sourceGeneration","createdAt" ON "CampaignStepExecution"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."membershipId" IS NOT OLD."membershipId" OR NEW."revisionId" IS NOT OLD."revisionId" OR NEW."stepId" IS NOT OLD."stepId" OR NEW."iteration" IS NOT OLD."iteration" OR NEW."authorizationKind" IS NOT OLD."authorizationKind" OR NEW."authorizationRequestKey" IS NOT OLD."authorizationRequestKey" OR NEW."authorizationRequestDigest" IS NOT OLD."authorizationRequestDigest" OR NEW."authorizationActorId" IS NOT OLD."authorizationActorId" OR NEW."authorizationActionExecutionId" IS NOT OLD."authorizationActionExecutionId" OR NEW."previousExecutionId" IS NOT OLD."previousExecutionId" OR NEW."sequenceAnchorAt" IS NOT OLD."sequenceAnchorAt" OR NEW."waitStartedAt" IS NOT OLD."waitStartedAt" OR NEW."waitAnchorAt" IS NOT OLD."waitAnchorAt" OR NEW."waitDeadlineAt" IS NOT OLD."waitDeadlineAt" OR NEW."waitSourceId" IS NOT OLD."waitSourceId" OR NEW."sourceGeneration" IS NOT OLD."sourceGeneration" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Automation identity and captured timing are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_dueAt_once" BEFORE UPDATE OF "dueAt" ON "CampaignStepExecution"
WHEN (OLD."dueAt" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."dueAt" IS NOT OLD."dueAt"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_expiresAt_once" BEFORE UPDATE OF "expiresAt" ON "CampaignStepExecution"
WHEN (OLD."expiresAt" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."expiresAt" IS NOT OLD."expiresAt"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_resolvedAt_once" BEFORE UPDATE OF "resolvedAt" ON "CampaignStepExecution"
WHEN (OLD."resolvedAt" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."resolvedAt" IS NOT OLD."resolvedAt"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_receiptId_once" BEFORE UPDATE OF "receiptId" ON "CampaignStepExecution"
WHEN (OLD."receiptId" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."receiptId" IS NOT OLD."receiptId"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_eventId_once" BEFORE UPDATE OF "eventId" ON "CampaignStepExecution"
WHEN (OLD."eventId" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."eventId" IS NOT OLD."eventId"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_matchRevision_once" BEFORE UPDATE OF "matchRevision" ON "CampaignStepExecution"
WHEN (OLD."matchRevision" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."matchRevision" IS NOT OLD."matchRevision"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_evidenceAvailableAt_once" BEFORE UPDATE OF "evidenceAvailableAt" ON "CampaignStepExecution"
WHEN (OLD."evidenceAvailableAt" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."evidenceAvailableAt" IS NOT OLD."evidenceAvailableAt"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_sendId_once" BEFORE UPDATE OF "sendId" ON "CampaignStepExecution"
WHEN (OLD."sendId" IS NOT NULL OR OLD."status" IN ('ACCEPTED','SKIPPED','CANCELLED','FAILED')) AND NEW."sendId" IS NOT OLD."sendId"
BEGIN SELECT RAISE(ABORT, 'Resolved step timing and evidence are immutable'); END;

CREATE TRIGGER "CampaignStepExecution_authorization_redact" BEFORE UPDATE OF "authorizationReason" ON "CampaignStepExecution"
WHEN NEW."authorizationReason" IS NOT OLD."authorizationReason" AND NOT (OLD."redactedAt" IS NULL AND NEW."redactedAt" IS NOT NULL AND NEW."authorizationReason" IS NULL)
BEGIN SELECT RAISE(ABORT, 'Start reason permits only explicit redaction'); END;

CREATE TRIGGER "FunnelActionExecution_captured_timing" BEFORE INSERT ON "FunnelActionExecution"
WHEN NOT EXISTS (SELECT 1 FROM "FunnelStageTransition" t WHERE t."id"=NEW."transitionId" AND (CASE WHEN typeof(NEW."dueAt") IN ('integer','real') THEN NEW."dueAt" ELSE CAST(strftime('%s',NEW."dueAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."dueAt"),4,3) AS INTEGER) END)=(CASE WHEN typeof(t."recordedAt") IN ('integer','real') THEN t."recordedAt" ELSE CAST(strftime('%s',t."recordedAt") AS INTEGER)*1000+CAST(substr(strftime('%f',t."recordedAt"),4,3) AS INTEGER) END)+CASE WHEN NEW."kind"='EMAIL_STOP' THEN 0 ELSE COALESCE(json_extract(NEW."plan",'$.delaySeconds'),0)*1000 END AND (NEW."kind"='EMAIL_STOP' OR (CASE WHEN typeof(NEW."expiresAt") IN ('integer','real') THEN NEW."expiresAt" ELSE CAST(strftime('%s',NEW."expiresAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."expiresAt"),4,3) AS INTEGER) END)=(CASE WHEN typeof(NEW."dueAt") IN ('integer','real') THEN NEW."dueAt" ELSE CAST(strftime('%s',NEW."dueAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."dueAt"),4,3) AS INTEGER) END)+COALESCE(json_extract(NEW."plan",'$.expiresAfterDueSeconds'),604800)*1000))
BEGIN SELECT RAISE(ABORT, 'Action timing must use the captured transition and delay'); END;

CREATE TRIGGER "CampaignStepExecution_start_authority" BEFORE INSERT ON "CampaignStepExecution"
WHEN (NEW."authorizationKind"!='CONTINUATION' AND NOT EXISTS (SELECT 1 FROM "CampaignStep" WHERE "id"=NEW."stepId" AND "position"=0)) OR
 (NEW."authorizationKind"='STAGE' AND NOT EXISTS (SELECT 1 FROM "FunnelActionExecution" WHERE "id"=NEW."authorizationActionExecutionId" AND "kind"='EMAIL_ENROLL' AND "status" IN ('PENDING','APPLIED') AND "redactedAt" IS NULL)) OR
 (NEW."authorizationKind"='CONTINUATION' AND NOT EXISTS (SELECT 1 FROM "CampaignStepExecution" p JOIN "CampaignStep" ps ON ps."id"=p."stepId" JOIN "CampaignStep" ns ON ns."id"=NEW."stepId" WHERE p."id"=NEW."previousExecutionId" AND p."iteration"=NEW."iteration" AND p."status" IN ('ACCEPTED','SKIPPED') AND p."redactedAt" IS NULL AND ns."position"=ps."position"+1 AND (CASE WHEN typeof(NEW."sequenceAnchorAt") IN ('integer','real') THEN NEW."sequenceAnchorAt" ELSE CAST(strftime('%s',NEW."sequenceAnchorAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."sequenceAnchorAt"),4,3) AS INTEGER) END)=MAX((CASE WHEN typeof(p."sequenceAnchorAt") IN ('integer','real') THEN p."sequenceAnchorAt" ELSE CAST(strftime('%s',p."sequenceAnchorAt") AS INTEGER)*1000+CAST(substr(strftime('%f',p."sequenceAnchorAt"),4,3) AS INTEGER) END),(CASE WHEN typeof(p."completedAt") IN ('integer','real') THEN p."completedAt" ELSE CAST(strftime('%s',p."completedAt") AS INTEGER)*1000+CAST(substr(strftime('%f',p."completedAt"),4,3) AS INTEGER) END))))
BEGIN SELECT RAISE(ABORT, 'Step requires an explicit first authorization or resolved adjacent predecessor'); END;

CREATE TRIGGER "CampaignStepExecution_wait_binding" BEFORE INSERT ON "CampaignStepExecution"
WHEN NOT EXISTS (SELECT 1 FROM "CampaignStep" s JOIN "CampaignMembership" m ON m."id"=NEW."membershipId" WHERE s."id"=NEW."stepId" AND (
 (json_extract(s."wait",'$.kind')='EVENT' AND m."scopeKind"='SUBJECT' AND NEW."waitSourceId"=json_extract(s."wait",'$.sourceId') AND NEW."sourceGeneration" IS NOT NULL AND NEW."waitDeadlineAt" IS NOT NULL) OR
 (json_extract(s."wait",'$.kind') IN ('IMMEDIATE','DURATION','DATE') AND NEW."waitSourceId" IS NULL AND NEW."sourceGeneration" IS NULL AND NEW."waitDeadlineAt" IS NULL)))
BEGIN SELECT RAISE(ABORT, 'Wait binding must match its immutable campaign step'); END;

CREATE TRIGGER "CampaignStepExecution_evidence_insert" BEFORE INSERT ON "CampaignStepExecution"
WHEN NEW."receiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "FunnelEvaluationReceipt" r JOIN "TrackingEvent" e ON e."id"=r."eventId" JOIN "TrackingSource" s ON s."id"=e."sourceId" JOIN "CampaignMembership" m ON m."id"=NEW."membershipId" JOIN "CampaignStep" cs ON cs."id"=NEW."stepId"
 WHERE r."id"=NEW."receiptId" AND r."eventId"=NEW."eventId" AND r."matchRevision"=NEW."matchRevision" AND r."mode"='LIVE' AND r."sourceGeneration"=NEW."sourceGeneration" AND r."sourceGeneration"=e."sourceGeneration" AND r."sourceGeneration"=s."generation" AND s."status"='ACTIVE' AND e."status"='MATCHED' AND e."subjectId"=m."subjectId" AND r."subjectId"=m."subjectId" AND e."sourceId"=NEW."waitSourceId" AND e."type"=json_extract(cs."wait",'$.type') AND r."createdAt"=NEW."evidenceAvailableAt" AND (CASE WHEN typeof(e."occurredAt") IN ('integer','real') THEN e."occurredAt" ELSE CAST(strftime('%s',e."occurredAt") AS INTEGER)*1000+CAST(substr(strftime('%f',e."occurredAt"),4,3) AS INTEGER) END)>=(CASE WHEN typeof(NEW."waitAnchorAt") IN ('integer','real') THEN NEW."waitAnchorAt" ELSE CAST(strftime('%s',NEW."waitAnchorAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitAnchorAt"),4,3) AS INTEGER) END) AND (CASE WHEN typeof(e."occurredAt") IN ('integer','real') THEN e."occurredAt" ELSE CAST(strftime('%s',e."occurredAt") AS INTEGER)*1000+CAST(substr(strftime('%f',e."occurredAt"),4,3) AS INTEGER) END)<(CASE WHEN typeof(NEW."waitDeadlineAt") IN ('integer','real') THEN NEW."waitDeadlineAt" ELSE CAST(strftime('%s',NEW."waitDeadlineAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitDeadlineAt"),4,3) AS INTEGER) END) AND (CASE WHEN typeof(r."createdAt") IN ('integer','real') THEN r."createdAt" ELSE CAST(strftime('%s',r."createdAt") AS INTEGER)*1000+CAST(substr(strftime('%f',r."createdAt"),4,3) AS INTEGER) END)<(CASE WHEN typeof(NEW."waitDeadlineAt") IN ('integer','real') THEN NEW."waitDeadlineAt" ELSE CAST(strftime('%s',NEW."waitDeadlineAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitDeadlineAt"),4,3) AS INTEGER) END))
BEGIN SELECT RAISE(ABORT, 'Event wait requires original timely LIVE evidence for its exact subject and generation'); END;

CREATE TRIGGER "CampaignStepExecution_evidence_update" BEFORE UPDATE OF "receiptId","eventId","matchRevision","evidenceAvailableAt" ON "CampaignStepExecution"
WHEN NEW."receiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "FunnelEvaluationReceipt" r JOIN "TrackingEvent" e ON e."id"=r."eventId" JOIN "TrackingSource" s ON s."id"=e."sourceId" JOIN "CampaignMembership" m ON m."id"=NEW."membershipId" JOIN "CampaignStep" cs ON cs."id"=NEW."stepId"
 WHERE r."id"=NEW."receiptId" AND r."eventId"=NEW."eventId" AND r."matchRevision"=NEW."matchRevision" AND r."mode"='LIVE' AND r."sourceGeneration"=NEW."sourceGeneration" AND r."sourceGeneration"=e."sourceGeneration" AND r."sourceGeneration"=s."generation" AND s."status"='ACTIVE' AND e."status"='MATCHED' AND e."subjectId"=m."subjectId" AND r."subjectId"=m."subjectId" AND e."sourceId"=NEW."waitSourceId" AND e."type"=json_extract(cs."wait",'$.type') AND r."createdAt"=NEW."evidenceAvailableAt" AND (CASE WHEN typeof(e."occurredAt") IN ('integer','real') THEN e."occurredAt" ELSE CAST(strftime('%s',e."occurredAt") AS INTEGER)*1000+CAST(substr(strftime('%f',e."occurredAt"),4,3) AS INTEGER) END)>=(CASE WHEN typeof(NEW."waitAnchorAt") IN ('integer','real') THEN NEW."waitAnchorAt" ELSE CAST(strftime('%s',NEW."waitAnchorAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitAnchorAt"),4,3) AS INTEGER) END) AND (CASE WHEN typeof(e."occurredAt") IN ('integer','real') THEN e."occurredAt" ELSE CAST(strftime('%s',e."occurredAt") AS INTEGER)*1000+CAST(substr(strftime('%f',e."occurredAt"),4,3) AS INTEGER) END)<(CASE WHEN typeof(NEW."waitDeadlineAt") IN ('integer','real') THEN NEW."waitDeadlineAt" ELSE CAST(strftime('%s',NEW."waitDeadlineAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitDeadlineAt"),4,3) AS INTEGER) END) AND (CASE WHEN typeof(r."createdAt") IN ('integer','real') THEN r."createdAt" ELSE CAST(strftime('%s',r."createdAt") AS INTEGER)*1000+CAST(substr(strftime('%f',r."createdAt"),4,3) AS INTEGER) END)<(CASE WHEN typeof(NEW."waitDeadlineAt") IN ('integer','real') THEN NEW."waitDeadlineAt" ELSE CAST(strftime('%s',NEW."waitDeadlineAt") AS INTEGER)*1000+CAST(substr(strftime('%f',NEW."waitDeadlineAt"),4,3) AS INTEGER) END))
BEGIN SELECT RAISE(ABORT, 'Event wait requires original timely LIVE evidence for its exact subject and generation'); END;

CREATE TRIGGER "CampaignStepExecution_send_insert" BEFORE INSERT ON "CampaignStepExecution"
WHEN NEW."sendId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "dueAt"=NEW."dueAt" AND "expiresAt"=NEW."expiresAt")
BEGIN SELECT RAISE(ABORT, 'Step send must retain its resolved timing'); END;

CREATE TRIGGER "CampaignStepExecution_send_update" BEFORE UPDATE OF "sendId" ON "CampaignStepExecution"
WHEN NEW."sendId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "dueAt"=NEW."dueAt" AND "expiresAt"=NEW."expiresAt")
BEGIN SELECT RAISE(ABORT, 'Step send must retain its resolved timing'); END;

CREATE TRIGGER "CampaignStepExecution_outcome_insert" BEFORE INSERT ON "CampaignStepExecution"
WHEN (NEW."status"='ACCEPTED' AND NOT EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "status"='ACCEPTED' AND "acceptedAt"=NEW."completedAt")) OR
 (NEW."status" IN ('SKIPPED','CANCELLED','FAILED') AND NEW."sendId" IS NOT NULL AND (EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "status" IN ('SUBMITTING','UNKNOWN','ACCEPTED')) OR EXISTS (SELECT 1 FROM "DeliveryAttempt" WHERE "sendId"=NEW."sendId" AND "outcome"='IN_FLIGHT')))
BEGIN SELECT RAISE(ABORT, 'Step completion must preserve the actual provider outcome and uncertainty'); END;

CREATE TRIGGER "CampaignStepExecution_outcome_update" BEFORE UPDATE OF "status","completedAt" ON "CampaignStepExecution"
WHEN (NEW."status"='ACCEPTED' AND NOT EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "status"='ACCEPTED' AND "acceptedAt"=NEW."completedAt")) OR
 (NEW."status" IN ('SKIPPED','CANCELLED','FAILED') AND NEW."sendId" IS NOT NULL AND (EXISTS (SELECT 1 FROM "MessageSend" WHERE "id"=NEW."sendId" AND "status" IN ('SUBMITTING','UNKNOWN','ACCEPTED')) OR EXISTS (SELECT 1 FROM "DeliveryAttempt" WHERE "sendId"=NEW."sendId" AND "outcome"='IN_FLIGHT')))
BEGIN SELECT RAISE(ABORT, 'Step completion must preserve the actual provider outcome and uncertainty'); END;

COMMIT;

PRAGMA foreign_keys=ON;

PRAGMA foreign_key_check;
