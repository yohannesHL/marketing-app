ALTER TABLE "ProviderAuthorization" ADD COLUMN "authorizedAt" DATETIME;
CREATE TABLE "ProviderRevocationFence" (
  "id" TEXT NOT NULL PRIMARY KEY, "provider" TEXT NOT NULL, "connectionMode" TEXT NOT NULL,
  "subjectDigest" TEXT NOT NULL, "revokedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ProviderRevocationFence_provider_connectionMode_subjectDigest_key"
  ON "ProviderRevocationFence"("provider", "connectionMode", "subjectDigest");
CREATE TABLE "ProviderLifecycleEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "provider" TEXT NOT NULL, "connectionMode" TEXT NOT NULL,
  "subjectDigest" TEXT NOT NULL, "action" TEXT NOT NULL,
  "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "receiptId" TEXT
);
CREATE TABLE "ProviderDeletionReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY, "provider" TEXT NOT NULL, "connectionMode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME
);
ALTER TABLE "AdPlatformInvocation" ADD COLUMN "authorizationId" TEXT;
ALTER TABLE "AdPlatformInvocation" ADD COLUMN "destinationId" TEXT;
ALTER TABLE "AdPlatformInvocation" ADD COLUMN "connectionMode" TEXT NOT NULL DEFAULT 'LEGACY';
CREATE INDEX "AdPlatformInvocation_authorizationId_connectionMode_idx" ON "AdPlatformInvocation"("authorizationId", "connectionMode");
