-- CreateTable
CREATE TABLE "AdProxyExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "source" TEXT,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AdPlatformInvocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "adapterPayload" JSONB NOT NULL,
    "downstreamPath" TEXT,
    "downstreamRequest" JSONB,
    "downstreamResponse" JSONB,
    "success" BOOLEAN,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "AdPlatformInvocation_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "AdProxyExecution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AdPlatformInvocation_executionId_idx" ON "AdPlatformInvocation"("executionId");
