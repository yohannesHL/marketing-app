import { readFile, readdir } from "node:fs/promises";
import type { Client } from "@libsql/client";

/** Legacy-data fixture plus every additive connection migration; never a developer DB. */
export async function applyConnectionMigrations(client: Client) {
  await client.executeMultiple(await readFile("tests/fixtures/legacy-account-schema.sql", "utf8"));
  const root = "apps/web/prisma/migrations";
  for (const name of (await readdir(root)).sort()) {
    if (name >= "20261013000000_customer_connections" && /^\d{14}_/.test(name))
      await client.executeMultiple(await readFile(`${root}/${name}/migration.sql`, "utf8"));
  }
}
