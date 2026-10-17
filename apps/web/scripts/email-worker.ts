import "dotenv/config";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/server/prisma/client";
import { pruneEmailEvidence } from "../src/server/email/emailRetention";
import { emailServices } from "../src/server/email/emailRuntime";

async function main() {
  const command = process.argv[2] ?? "run-once";
  if (!["run-once", "run", "prune"].includes(command)) throw new Error("Invalid worker command.");
  const database = process.env.DATABASE_URL;
  if (!database || database === ":memory:" || decodeURIComponent(database).includes(":memory:") || /[?&]mode=memory(?:&|$)/i.test(database))
    throw new Error("Configure the persistent database shared with the web app.");
  if (database.startsWith("file:")) {
    const filename = database.startsWith("file://") ? fileURLToPath(database) : decodeURIComponent(database.slice(5).split(/[?#]/, 1)[0]);
    if (!isAbsolute(filename) || /[?#]/.test(database))
      throw new Error("Configure an absolute persistent SQLite file shared with the web app.");
  }
  if (command === "prune") {
    const sendDays = process.env.EMAIL_SEND_RETENTION_DAYS === undefined ? 365 : Number(process.env.EMAIL_SEND_RETENTION_DAYS);
    console.log(JSON.stringify(await pruneEmailEvidence(prisma, new Date(), { sendDays }))); return;
  }
  const service = emailServices().delivery;
  const report = (result: Awaited<ReturnType<typeof service.processOnce>>) => {
    if (result) console.log(JSON.stringify({ status: result.status }));
  };
  if (command === "run-once") report(await service.processOnce());
  else {
    let stopped = false;
    const controller = new AbortController();
    const stop = () => { stopped = true; controller.abort(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      while (!stopped) {
        const result = await service.processOnce();
        report(result);
        if (!result && !stopped) await setTimeout(1000, undefined, { signal: controller.signal }).catch(error => {
          if (!stopped) throw error;
        });
      }
    } finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
    }
  }
}

main().catch((error: unknown) => {
  // Do not log evidence, SQL arguments, contact data or exception messages.
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    /^(?:P[0-9]{4}|[A-Z][A-Z_]{0,63})$/.test(error.code) ? error.code : "INTERNAL_ERROR";
  console.error(JSON.stringify({ status: "STOPPED", code }));
  console.error("Email receipt processing stopped. Check configuration, migrations and worker health.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
