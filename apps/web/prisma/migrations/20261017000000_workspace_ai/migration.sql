CREATE TABLE "AiRequestWindow" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "windowStart" DATETIME NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "AiRequestWindow_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AiRequestWindow_ownerId_windowStart_idx" ON "AiRequestWindow"("ownerId", "windowStart");
