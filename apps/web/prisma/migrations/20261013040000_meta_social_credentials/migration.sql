CREATE TABLE "MetaPageCredential" (
  "authorizationId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL CHECK(length("pageId") BETWEEN 1 AND 64 AND "pageId" NOT GLOB '*[^0-9]*'),
  "ownerId" TEXT NOT NULL,
  "connectionMode" TEXT NOT NULL CHECK("connectionMode" IN ('MOCK', 'LIVE')),
  "authorizationGeneration" INTEGER NOT NULL CHECK("authorizationGeneration" > 0),
  "credentialVersion" INTEGER NOT NULL CHECK("credentialVersion" > 0),
  "accessCiphertext" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK("version" > 0),
  "expiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  PRIMARY KEY ("authorizationId", "pageId"),
  FOREIGN KEY ("authorizationId") REFERENCES "ProviderAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MetaPageCredential_ownerId_connectionMode_idx" ON "MetaPageCredential"("ownerId", "connectionMode");
CREATE TRIGGER "MetaPageCredential_owned_social_insert" BEFORE INSERT ON "MetaPageCredential"
WHEN NOT EXISTS (SELECT 1 FROM "ProviderAuthorization" a WHERE a."id" = NEW."authorizationId"
  AND a."userId" = NEW."ownerId" AND a."provider" = 'META' AND a."capability" = 'SOCIAL'
  AND a."connectionMode" = NEW."connectionMode" AND a."generation" = NEW."authorizationGeneration")
BEGIN SELECT RAISE(ABORT, 'Page credentials require matching owned SOCIAL authorization'); END;
CREATE TRIGGER "MetaPageCredential_owned_social_update" BEFORE UPDATE OF "authorizationId", "ownerId", "connectionMode", "authorizationGeneration" ON "MetaPageCredential"
WHEN NOT EXISTS (SELECT 1 FROM "ProviderAuthorization" a WHERE a."id" = NEW."authorizationId"
  AND a."userId" = NEW."ownerId" AND a."provider" = 'META' AND a."capability" = 'SOCIAL'
  AND a."connectionMode" = NEW."connectionMode" AND a."generation" = NEW."authorizationGeneration")
BEGIN SELECT RAISE(ABORT, 'Page credentials require matching owned SOCIAL authorization'); END;
