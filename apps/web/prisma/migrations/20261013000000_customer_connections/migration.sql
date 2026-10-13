-- AlterTable
ALTER TABLE "User" ADD COLUMN "loginEmail" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- AlterTable
ALTER TABLE "AdProxyExecution" ADD COLUMN "ownerId" TEXT;

-- CreateTable
CREATE TABLE "CustomerSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "CustomerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OAuthAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "requestedScopes" JSONB NOT NULL,
    "verifierCiphertext" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CustomerSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "externalGrantId" TEXT,
    "accessCiphertext" TEXT,
    "refreshCiphertext" TEXT,
    "expiresAt" DATETIME,
    "scopes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "disconnectedAt" DATETIME,
    CONSTRAINT "ProviderAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConnectionDestination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorizationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ConnectionDestination_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ProviderAuthorization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConnectionOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "destinationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "requiredScopes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ConnectionOperation_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ConnectionDestination" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConnectionAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectionAuditEvent_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ProviderAuthorization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSession_tokenHash_key" ON "CustomerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerSession_userId_idx" ON "CustomerSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAttempt_stateHash_key" ON "OAuthAttempt"("stateHash");

-- CreateIndex
CREATE INDEX "OAuthAttempt_expiresAt_idx" ON "OAuthAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "ProviderAuthorization_userId_status_idx" ON "ProviderAuthorization"("userId", "status");

-- CreateIndex
CREATE INDEX "ProviderAuthorization_provider_externalGrantId_idx" ON "ProviderAuthorization"("provider", "externalGrantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAuthorization_userId_provider_providerUserId_capability_key" ON "ProviderAuthorization"("userId", "provider", "providerUserId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionDestination_authorizationId_kind_externalId_key" ON "ConnectionDestination"("authorizationId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "ConnectionOperation_destinationId_status_idx" ON "ConnectionOperation"("destinationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_loginEmail_key" ON "User"("loginEmail");
