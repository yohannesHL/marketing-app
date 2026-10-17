-- Native subscription business identity; retained records keep their original keys and kinds.
-- Rebuild only parents with inline subject-kind CHECKs. Never rename an old parent.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

DROP TRIGGER "CampaignMembership_subject_recipient";

CREATE TABLE "new_FunnelSubject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "kind" TEXT NOT NULL CHECK ("kind" IN ('CONTACT', 'SALES', 'PURCHASE', 'SUBSCRIPTION')),
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOccurredAt" DATETIME,
    CONSTRAINT "FunnelSubject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunnelSubject_contactId_ownerId_environment_fkey" FOREIGN KEY ("contactId", "ownerId", "environment") REFERENCES "FunnelContact" ("id", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

INSERT INTO "new_FunnelSubject" ("id", "ownerId", "environment", "kind", "contactId", "createdAt", "lastOccurredAt") SELECT "id", "ownerId", "environment", "kind", "contactId", "createdAt", "lastOccurredAt" FROM "FunnelSubject";

DROP TABLE "FunnelSubject";
ALTER TABLE "new_FunnelSubject" RENAME TO "FunnelSubject";

CREATE INDEX "FunnelSubject_ownerId_environment_kind_contactId_idx" ON "FunnelSubject"("ownerId", "environment", "kind", "contactId");

CREATE UNIQUE INDEX "FunnelSubject_id_ownerId_environment_key" ON "FunnelSubject"("id", "ownerId", "environment");

CREATE TRIGGER "FunnelSubject_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment" ON "FunnelSubject"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment"
BEGIN SELECT RAISE(ABORT, 'Tracking record identity is immutable'); END;

CREATE TABLE "new_Funnel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "environment" TEXT NOT NULL CHECK ("environment" IN ('TEST', 'LIVE')),
    "name" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL CHECK ("subjectKind" IN ('CONTACT', 'SALES', 'PURCHASE', 'SUBSCRIPTION')),
    "draft" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1 CHECK ("draftRevision" >= 1),
    "publishedVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "automationEnrolmentEnabled" BOOLEAN NOT NULL DEFAULT false CHECK ("automationEnrolmentEnabled" IN (0,1)),
    "automationDispatchEnabled" BOOLEAN NOT NULL DEFAULT false CHECK ("automationDispatchEnabled" IN (0,1)),
    CONSTRAINT "Funnel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Funnel_publishedVersionId_id_ownerId_environment_fkey" FOREIGN KEY ("publishedVersionId", "id", "ownerId", "environment") REFERENCES "FunnelVersion" ("id", "funnelId", "ownerId", "environment") ON DELETE NO ACTION ON UPDATE CASCADE
);

INSERT INTO "new_Funnel" ("id", "ownerId", "environment", "name", "subjectKind", "draft", "draftRevision", "publishedVersionId", "status", "createdAt", "updatedAt", "automationEnrolmentEnabled", "automationDispatchEnabled") SELECT "id", "ownerId", "environment", "name", "subjectKind", "draft", "draftRevision", "publishedVersionId", "status", "createdAt", "updatedAt", "automationEnrolmentEnabled", "automationDispatchEnabled" FROM "Funnel";

DROP TABLE "Funnel";
ALTER TABLE "new_Funnel" RENAME TO "Funnel";

CREATE INDEX "Funnel_ownerId_environment_status_idx" ON "Funnel"("ownerId", "environment", "status");

CREATE UNIQUE INDEX "Funnel_id_ownerId_environment_key" ON "Funnel"("id", "ownerId", "environment");

CREATE TRIGGER "Funnel_immutable_identity" BEFORE UPDATE OF "id", "ownerId", "environment", "subjectKind", "createdAt" ON "Funnel"
WHEN NEW."id" IS NOT OLD."id" OR NEW."ownerId" IS NOT OLD."ownerId" OR NEW."environment" IS NOT OLD."environment" OR NEW."subjectKind" IS NOT OLD."subjectKind" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'Funnel record identity is immutable'); END;

CREATE TRIGGER "CampaignMembership_subject_recipient" BEFORE INSERT ON "CampaignMembership"
WHEN NEW."scopeKind" = 'SUBJECT' AND NOT EXISTS (
 SELECT 1 FROM "FunnelSubject" WHERE "id"=NEW."subjectId" AND "contactId"=NEW."contactId" AND "ownerId"=NEW."ownerId" AND "environment"=NEW."environment")
BEGIN SELECT RAISE(ABORT, 'Membership subject and contact must match'); END;

-- One canonical subscription ID per source namespace and business subject.
CREATE UNIQUE INDEX "FunnelSubjectReference_subscription_per_source_key"
ON "FunnelSubjectReference" ("ownerId", "sourceId", "subjectId") WHERE "kind"='SUBSCRIPTION';

CREATE TRIGGER "FunnelSubject_kind_immutable" BEFORE UPDATE OF "kind" ON "FunnelSubject"
WHEN NEW."kind" IS NOT OLD."kind"
BEGIN SELECT RAISE(ABORT, 'Business subject kind is immutable'); END;

CREATE TRIGGER "FunnelSubjectReference_subscription_binding_insert" BEFORE INSERT ON "FunnelSubjectReference"
WHEN (NEW."kind"='SUBSCRIPTION') IS NOT COALESCE((SELECT "kind"='SUBSCRIPTION' FROM "FunnelSubject" WHERE "id"=NEW."subjectId"),0)
BEGIN SELECT RAISE(ABORT, 'Subscription references require a subscription subject'); END;

CREATE TRIGGER "FunnelSubjectReference_subscription_binding_update" BEFORE UPDATE OF "kind","subjectId" ON "FunnelSubjectReference"
WHEN (NEW."kind"='SUBSCRIPTION') IS NOT COALESCE((SELECT "kind"='SUBSCRIPTION' FROM "FunnelSubject" WHERE "id"=NEW."subjectId"),0)
BEGIN SELECT RAISE(ABORT, 'Subscription references require a subscription subject'); END;

CREATE TRIGGER "FunnelSubjectReference_subscription_immutable" BEFORE UPDATE OF "sourceId","subjectId","kind","externalId" ON "FunnelSubjectReference"
WHEN (OLD."kind"='SUBSCRIPTION' OR NEW."kind"='SUBSCRIPTION') AND
 (NEW."sourceId" IS NOT OLD."sourceId" OR NEW."subjectId" IS NOT OLD."subjectId" OR NEW."kind" IS NOT OLD."kind" OR NEW."externalId" IS NOT OLD."externalId")
BEGIN SELECT RAISE(ABORT, 'Subscription identity is immutable'); END;

COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
