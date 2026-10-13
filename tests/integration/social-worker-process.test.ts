import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { socialAllPlatformFixture } from "../support/social-all-platform-fixture";

test("the supervised real worker survives temporary cross-process SQLite contention and later sends one reviewed X post", { timeout: 90000 }, async () => {
  const fixture = await socialAllPlatformFixture({ realClock: true });
  let holder: ReturnType<typeof createClient> | undefined;
  let lock: Awaited<ReturnType<ReturnType<typeof createClient>["transaction"]>> | undefined;
  let locked = false, output = "";
  let worker: ReturnType<typeof spawn> | undefined;
  try {
  const owner = await fixture.customer("worker-process");
  holder = createClient({ url: fixture.sqlUrl });
  lock = await holder.transaction("write"); locked = true;
  await lock.execute('UPDATE "SocialDelivery" SET "attempts" = "attempts" WHERE 0');
  worker = spawn(process.execPath, ["--import", "tsx", "apps/web/scripts/social-worker.ts", "run"], {
    env: { ...process.env, ...fixture.environment(), CONNECTION_MODE: "mock", ADS_MODE: "mock",
      SOCIAL_PUBLISHING_ENABLED: "true", SOCIAL_APPROVED_PROVIDERS: JSON.stringify(fixture.config.approvedProviders) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", chunk => { output += String(chunk); }); worker.stderr.on("data", chunk => { output += String(chunk); });
    // Hold a real independent writer longer than Prisma's initial acquisition window.
    await delay(8000); await lock.commit(); locked = false;
    assert.equal(worker.exitCode, null, `The worker terminated instead of recovering: ${output}`);
    const connection = await owner.connect("x"), destination = connection.destinations.find((value: {selected:boolean}) => value.selected)!;
    const created = await owner.api("/api/social/posts", { title: "Worker contention recovery", body: "Fixture text", mediaIds: [],
      variants: [{ destinationId: destination.id, format: "TEXT", providerOptions: { madeWithAi: false, paidPartnership: false, maxApiCostMicros: 1000000 } }] });
    assert.equal(created.status, 201); const post = await created.json();
    const approved = await owner.api(`/api/social/posts/${post.id}/approve`, { revisionId: post.revision.id, destinationIds: [destination.id] }); assert.equal(approved.status, 200);
    const queued = await owner.api(`/api/social/posts/${post.id}/enqueue`, { revisionId: post.revision.id, destinationIds: [destination.id],
      enqueueId: randomUUID(), dueAt: new Date().toISOString(), timeZone: "UTC" }); assert.equal(queued.status, 200);
    let succeeded = false;
    for (let step = 0; step < 40; step++) {
      assert.equal(worker.exitCode, null, `The worker stopped during delivery: ${output}`);
      const current = await fixture.db.socialDelivery.findFirstOrThrow({ where: { postId: post.id } });
      if (current.status === "SUCCEEDED") { assert.equal(current.attempts, 1); succeeded = true; break; }
      await delay(500);
    }
    assert.ok(succeeded, `The reviewed delivery did not finish: ${output}`);
    assert.equal(await fixture.db.socialApiCostReservation.count({ where: { operation: "POST_CREATE" } }), 1);
    assert.doesNotMatch(output, /x-refresh|x-access|Ciphertext|fixture-x-secret|accessToken|refreshToken/);
  } finally {
    if (locked) await lock?.rollback(); holder?.close();
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await Promise.race([new Promise<void>(resolve => worker!.once("exit", () => resolve())), delay(5000).then(() => { worker!.kill("SIGKILL"); })]);
    }
    await fixture.close();
  }
});
