ALTER TABLE "ProviderAuthorization" ADD COLUMN "refreshExpiresAt" DATETIME;
CREATE TABLE "SocialCredentialRenewalLease" (
 "authorizationId" TEXT NOT NULL PRIMARY KEY,
 "ownerId" TEXT NOT NULL,
 "provider" TEXT NOT NULL CHECK("provider" IN ('TIKTOK','X','LINKEDIN')),
 "connectionMode" TEXT NOT NULL CHECK("connectionMode" IN ('MOCK','LIVE')),
 "authorizationGeneration" INTEGER NOT NULL CHECK("authorizationGeneration">0),
 "credentialVersion" INTEGER NOT NULL CHECK("credentialVersion">0),
 "refreshDigest" TEXT NOT NULL CHECK(length("refreshDigest")=64),
 "leaseTokenHash" TEXT NOT NULL CHECK(length("leaseTokenHash")=64),
 "leaseUntil" DATETIME NOT NULL,
 "startedAt" DATETIME,
 "requestCount" INTEGER NOT NULL DEFAULT 0 CHECK("requestCount">=0),
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 FOREIGN KEY("authorizationId") REFERENCES "ProviderAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SocialCredentialRenewalLease_leaseUntil_idx" ON "SocialCredentialRenewalLease"("leaseUntil");
CREATE TRIGGER "SocialCredentialRenewalLease_binding_insert" BEFORE INSERT ON "SocialCredentialRenewalLease"
WHEN NOT EXISTS(SELECT 1 FROM "ProviderAuthorization" a WHERE a."id"=NEW."authorizationId" AND a."userId"=NEW."ownerId"
 AND a."provider"=NEW."provider" AND a."capability"='SOCIAL' AND a."connectionMode"=NEW."connectionMode"
 AND a."generation"=NEW."authorizationGeneration" AND a."credentialVersion"=NEW."credentialVersion" AND a."status"='CONNECTED')
BEGIN SELECT RAISE(ABORT,'Refresh lease requires matching owned social authorization'); END;
CREATE TRIGGER "SocialCredentialRenewalLease_binding_update" BEFORE UPDATE OF "authorizationId","ownerId","provider","connectionMode","authorizationGeneration","credentialVersion" ON "SocialCredentialRenewalLease"
WHEN NOT EXISTS(SELECT 1 FROM "ProviderAuthorization" a WHERE a."id"=NEW."authorizationId" AND a."userId"=NEW."ownerId"
 AND a."provider"=NEW."provider" AND a."capability"='SOCIAL' AND a."connectionMode"=NEW."connectionMode"
 AND a."generation"=NEW."authorizationGeneration" AND a."credentialVersion"=NEW."credentialVersion" AND a."status"='CONNECTED')
BEGIN SELECT RAISE(ABORT,'Refresh lease requires matching owned social authorization'); END;
