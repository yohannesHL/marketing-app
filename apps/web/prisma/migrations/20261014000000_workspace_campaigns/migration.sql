CREATE TABLE "WorkspaceCampaign" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "type" TEXT NOT NULL, "name" TEXT NOT NULL,
 "websiteUrl" TEXT NOT NULL DEFAULT '', "brief" TEXT NOT NULL DEFAULT '', "goal" TEXT NOT NULL DEFAULT '', "audience" TEXT NOT NULL DEFAULT '',
 "platforms" JSONB NOT NULL DEFAULT '[]', "plan" JSONB NOT NULL DEFAULT '{}', "creatives" JSONB NOT NULL DEFAULT '[]', "socialPostIds" JSONB NOT NULL DEFAULT '[]',
 "status" TEXT NOT NULL DEFAULT 'DRAFT', "version" INTEGER NOT NULL DEFAULT 1,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "WorkspaceCampaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkspaceCampaign_ownerId_updatedAt_idx" ON "WorkspaceCampaign"("ownerId", "updatedAt");
CREATE TABLE "BrandKit" (
 "ownerId" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT '', "websiteUrl" TEXT NOT NULL DEFAULT '', "voice" TEXT NOT NULL DEFAULT '', "audience" TEXT NOT NULL DEFAULT '',
 "colors" JSONB NOT NULL DEFAULT '[]', "rules" TEXT NOT NULL DEFAULT '', "logoUrl" TEXT NOT NULL DEFAULT '', "version" INTEGER NOT NULL DEFAULT 1, "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "BrandKit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
