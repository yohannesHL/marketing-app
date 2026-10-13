ALTER TABLE "OAuthAttempt" ADD COLUMN "reconnectAuthorizationId" TEXT;
ALTER TABLE "OAuthAttempt" ADD COLUMN "exchangeClaimHash" TEXT;
ALTER TABLE "ConnectionDestination" ADD COLUMN "available" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ConnectionDestination" ADD COLUMN "metadata" JSONB;
ALTER TABLE "ConnectionDestination" ADD COLUMN "lastCheckedAt" DATETIME;
ALTER TABLE "ProviderAuthorization" ADD COLUMN "connectionMode" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "ConnectionDestination" ADD COLUMN "selectedContext" JSONB;
