import { LocalSqliteAdapter } from "./localSqliteAdapter";

import { PrismaClient } from "../../generated/prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __launchpadPrisma__: PrismaClient | undefined;
}

export const prisma =
  globalThis.__launchpadPrisma__ ??
  new PrismaClient({
    adapter: new LocalSqliteAdapter({
      url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
    }),
    // Prisma query errors can include credential fields; handlers expose safe errors.
    log: [],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__launchpadPrisma__ = prisma;
}
