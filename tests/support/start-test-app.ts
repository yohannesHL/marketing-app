import { applyConnectionMigrations } from "./test-database";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "launchpad-e2e-"));
  const url = `file:${join(directory, "test.db")}`;
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:3000";
  const client = createClient({ url });
  await applyConnectionMigrations(client);
  client.close();
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const auth = new CustomerAuth(db, { origin });
  for (const project of ["chromium", "firefox", "webkit"]) {
    for (const prefix of ["e2e", "other"])
      await auth.provisionCustomer({
        email: `${prefix}-${project}@example.test`,
        name: "Test customer",
        password: "isolated-test-password-for-fixtures",
      });
  }
  await db.$disconnect();
  const env = {
    ...process.env,
    DATABASE_URL: url,
    APP_ORIGIN: origin,
    BASE_URL: origin,
    INTERNAL_BASE_URL: origin,
    ADS_MODE: "mock",
    CONNECTION_ACTIVE_KEY_ID: "test",
    CONNECTION_TOKEN_KEYS: JSON.stringify({
      test: randomBytes(32).toString("base64"),
    }),
    PORT: new URL(origin).port || "3000",
    NODE_ENV: "production",
  };
  const build = spawn(
    "npm",
    ["--workspace", "@launchpad/web", "run", "build"],
    { env, stdio: "inherit" },
  );
  const built = await new Promise<number | null>((resolve) =>
    build.once("exit", resolve),
  );
  if (built !== 0) {
    await rm(directory, { recursive: true, force: true });
    process.exitCode = built ?? 1;
    return;
  }
  const server = spawn(process.execPath, ["server.js"], {
    cwd: join(process.cwd(), "apps/web"),
    env,
    stdio: "inherit",
  });
  const stop = () => server.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.once("exit", async (code) => {
    await rm(directory, { recursive: true, force: true });
    process.exitCode = code ?? 0;
  });
}

main().catch(() => {
  console.error("Isolated test application setup failed.");
  process.exitCode = 1;
});
