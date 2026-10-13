import "dotenv/config";
import { setTimeout } from "node:timers/promises";
import { prisma } from "../src/server/prisma/client";
import { socialDeliveryWorker } from "../src/server/social/runtime";

async function main() {
  const command = process.argv[2] ?? "run-once";
  if (!["run-once", "reconcile-once", "run"].includes(command)) throw new Error("Invalid worker command.");
  const worker = socialDeliveryWorker();
  const report = (result: Awaited<ReturnType<typeof worker.runOnce>>) => {
    if (result) console.log(JSON.stringify({ status: result.status }));
  };
  if (command === "reconcile-once") {
    const id = process.argv[3];
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid delivery ID.");
    report(await worker.reconcileOnce(id));
  } else if (command === "run-once") {
    report(await worker.runOnce());
  } else {
    let stopped = false;
    const stop = () => { stopped = true; };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      while (!stopped) {
        let result = await worker.runOnce();
        if (!result && !stopped) result = await worker.reconcileNext();
        report(result);
        if (!result && !stopped) await setTimeout(1000);
      }
    } finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
    }
  }
}

main().catch((error: unknown) => {
  // Never log provider payloads, SQL arguments, tokens or exception messages.
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    /^(?:P[0-9]{4}|[A-Z][A-Z_]{0,63})$/.test(error.code) ? error.code : "INTERNAL_ERROR";
  console.error(JSON.stringify({ status: "STOPPED", code }));
  console.error("Social delivery stopped. Check configuration, migrations and the server keyring.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
