-- These are conservative API cost allocations, not actual charges or credit balances.
CREATE TABLE "SocialApiBudgetWindow" (
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "connectionMode" TEXT NOT NULL CHECK ("connectionMode" IN ('MOCK', 'LIVE')),
    "windowStart" DATETIME NOT NULL,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("reservedMicros" >= 0),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("ownerId", "provider", "connectionMode", "windowStart")
);
CREATE TABLE "XConnectionCostApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('OAUTH', 'CONNECTION_READ')),
    "ownerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "connectionMode" TEXT NOT NULL CHECK ("connectionMode" IN ('MOCK', 'LIVE')),
    "stateHash" TEXT,
    "oauthAttemptId" TEXT,
    "authorizationId" TEXT,
    "authorizationGeneration" INTEGER,
    "credentialVersion" INTEGER,
    "capMicros" BIGINT NOT NULL CHECK ("capMicros" >= 0),
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (("kind" = 'OAUTH' AND "stateHash" IS NOT NULL AND "oauthAttemptId" IS NOT NULL AND "authorizationId" IS NULL) OR
           ("kind" = 'CONNECTION_READ' AND "stateHash" IS NULL AND "oauthAttemptId" IS NULL AND "authorizationId" IS NOT NULL AND "authorizationGeneration" IS NOT NULL AND "credentialVersion" IS NOT NULL))
);
CREATE UNIQUE INDEX "XConnectionCostApproval_stateHash_key" ON "XConnectionCostApproval"("stateHash");
CREATE UNIQUE INDEX "XConnectionCostApproval_oauthAttemptId_key" ON "XConnectionCostApproval"("oauthAttemptId");
CREATE INDEX "XConnectionCostApproval_ownerId_sessionId_expiresAt_idx" ON "XConnectionCostApproval"("ownerId", "sessionId", "expiresAt");
CREATE TABLE "SocialApiCostReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "connectionMode" TEXT NOT NULL CHECK ("connectionMode" IN ('MOCK', 'LIVE')),
    "windowStart" DATETIME NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DELIVERY' CHECK ("kind" IN ('DELIVERY', 'CONNECTION')),
    "connectionApprovalId" TEXT,
    "deliveryId" TEXT,
    "revisionId" TEXT,
    "authorizationId" TEXT,
    "authorizationGeneration" INTEGER,
    "credentialVersion" INTEGER,
    "leaseHash" TEXT,
    "operation" TEXT NOT NULL,
    "costMicros" BIGINT NOT NULL CHECK ("costMicros" >= 0),
    "reviewedCapMicros" BIGINT NOT NULL CHECK ("reviewedCapMicros" >= 0),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (("kind" = 'DELIVERY' AND "connectionApprovalId" IS NULL AND "deliveryId" IS NOT NULL AND "revisionId" IS NOT NULL AND "authorizationId" IS NOT NULL AND "authorizationGeneration" IS NOT NULL AND "credentialVersion" IS NOT NULL AND "leaseHash" IS NOT NULL) OR
           ("kind" = 'CONNECTION' AND "connectionApprovalId" IS NOT NULL AND "deliveryId" IS NULL AND "revisionId" IS NULL AND "authorizationId" IS NULL AND "authorizationGeneration" IS NULL AND "credentialVersion" IS NULL AND "leaseHash" IS NULL)),
    CONSTRAINT "SocialApiCostReservation_connectionApproval_fkey" FOREIGN KEY ("connectionApprovalId") REFERENCES "XConnectionCostApproval" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SocialApiCostReservation_window_fkey" FOREIGN KEY ("ownerId", "provider", "connectionMode", "windowStart") REFERENCES "SocialApiBudgetWindow" ("ownerId", "provider", "connectionMode", "windowStart") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SocialApiCostReservation_deliveryId_idx" ON "SocialApiCostReservation"("deliveryId");
CREATE INDEX "SocialApiCostReservation_ownerId_provider_connectionMode_createdAt_idx" ON "SocialApiCostReservation"("ownerId", "provider", "connectionMode", "createdAt");
CREATE INDEX "SocialApiCostReservation_connectionApprovalId_idx" ON "SocialApiCostReservation"("connectionApprovalId");
