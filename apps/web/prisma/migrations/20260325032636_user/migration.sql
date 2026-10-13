-- CreateTable
CREATE TABLE "PlatformUserAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "accessToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformUserAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "isBusiness" BOOLEAN
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlatformCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "platformUserAccountId" TEXT,
    CONSTRAINT "PlatformCampaign_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlatformCampaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlatformCampaign_platformUserAccountId_fkey" FOREIGN KEY ("platformUserAccountId") REFERENCES "PlatformUserAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PlatformCampaign" ("accountId", "campaignId", "externalId", "id", "platform") SELECT "accountId", "campaignId", "externalId", "id", "platform" FROM "PlatformCampaign";
DROP TABLE "PlatformCampaign";
ALTER TABLE "new_PlatformCampaign" RENAME TO "PlatformCampaign";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
