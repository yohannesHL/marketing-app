-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'SOCIAL_PUBLISHING' CHECK("category" = 'SOCIAL_PUBLISHING'),
    "title" TEXT NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialPost_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialPostRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "reviewedAt" DATETIME,
    "reviewedById" TEXT,
    "approvedDestinations" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialPostRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialMediaAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verifiedAt" DATETIME,
    "filename" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialMediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialRevisionMedia" (
    "revisionId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    PRIMARY KEY ("revisionId", "mediaId"),
    CONSTRAINT "SocialRevisionMedia_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SocialPostRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialRevisionMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "SocialMediaAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialPostVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "mediaIds" JSONB NOT NULL,
    "providerOptions" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "SocialPostVariant_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SocialPostRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialPostVariant_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ConnectionDestination" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialEnqueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "timeZone" TEXT NOT NULL,
    "destinationIds" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialEnqueue_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialEnqueue_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialEnqueue_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SocialPostRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "enqueueId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "authorizationGeneration" INTEGER NOT NULL,
    "postGeneration" INTEGER NOT NULL,
    "connectionMode" TEXT NOT NULL,
    "requiredScopes" JSONB NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "timeZone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'PREPARE',
    "leaseTokenHash" TEXT,
    "leaseUntil" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "publishStartedAt" DATETIME,
    "externalId" TEXT,
    "publishUrl" TEXT,
    "errorCode" TEXT,
    "cancellationRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "SocialDelivery_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialDelivery_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SocialPostRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialDelivery_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SocialPostVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialDelivery_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ConnectionDestination" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialDelivery_enqueueId_fkey" FOREIGN KEY ("enqueueId") REFERENCES "SocialEnqueue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialDeliveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deliveryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "leaseHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "errorCode" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "SocialDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "SocialDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialDeliveryProgress" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "encryptedState" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialDeliveryProgress_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "SocialDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Existing campaigns remain paid; no historical row is reclassified.
ALTER TABLE "Campaign" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'PAID_ADVERTISING' CHECK("category" = 'PAID_ADVERTISING');

-- CreateIndex
CREATE INDEX "SocialPost_ownerId_updatedAt_idx" ON "SocialPost"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostRevision_postId_number_key" ON "SocialPostRevision"("postId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SocialMediaAsset_storageKey_key" ON "SocialMediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "SocialMediaAsset_ownerId_status_idx" ON "SocialMediaAsset"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialRevisionMedia_revisionId_position_key" ON "SocialRevisionMedia"("revisionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostVariant_revisionId_destinationId_key" ON "SocialPostVariant"("revisionId", "destinationId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialEnqueue_ownerId_key_key" ON "SocialEnqueue"("ownerId", "key");

-- CreateIndex
CREATE INDEX "SocialDelivery_status_dueAt_nextAttemptAt_idx" ON "SocialDelivery"("status", "dueAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SocialDelivery_authorizationId_connectionMode_idx" ON "SocialDelivery"("authorizationId", "connectionMode");

-- CreateIndex
CREATE UNIQUE INDEX "SocialDelivery_revisionId_destinationId_key" ON "SocialDelivery"("revisionId", "destinationId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialDeliveryAttempt_deliveryId_number_key" ON "SocialDeliveryAttempt"("deliveryId", "number");


-- Reviewed content is append-only; edits always create a new revision.
CREATE TRIGGER SocialPostRevision_immutable_content BEFORE UPDATE OF title, body, contentDigest, postId, number ON SocialPostRevision
WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.contentDigest IS NOT OLD.contentDigest OR NEW.postId IS NOT OLD.postId OR NEW.number IS NOT OLD.number
BEGIN SELECT RAISE(ABORT, 'Social revision content is immutable'); END;
CREATE TRIGGER SocialPostVariant_immutable_content BEFORE UPDATE OF revisionId, destinationId, format, title, body, mediaIds, providerOptions ON SocialPostVariant
WHEN NEW.revisionId IS NOT OLD.revisionId OR NEW.destinationId IS NOT OLD.destinationId OR NEW.format IS NOT OLD.format OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.mediaIds IS NOT OLD.mediaIds OR NEW.providerOptions IS NOT OLD.providerOptions
BEGIN SELECT RAISE(ABORT, 'Social variant content is immutable'); END;
