import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { socialAllPlatformFixture } from "../support/social-all-platform-fixture";

async function stop(worker: ChildProcess | undefined) {
  if (!worker || !worker.pid || worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => worker.kill("SIGKILL"), 5000);
    worker.once("exit", () => { clearTimeout(timer); resolve(); });
    worker.kill("SIGTERM");
  });
}

test("an approved future schedule waits, survives sign-out, and publishes once through the background worker without a browser", { timeout: 90000 }, async () => {
  const fixture = await socialAllPlatformFixture({ realClock: true });
  let worker: ChildProcess | undefined;
  let output = "", spawnError: Error | undefined;
  try {
    const owner = await fixture.customer("approved-future-schedule");
    const connection = await owner.connect("x");
    const destination = connection.destinations.find((value: { selected: boolean }) => value.selected)!;
    const image = await owner.upload("png");
    const created = await owner.api("/api/social/posts", {
      title: "Approved future campaign post", body: "Fixture image", mediaIds: [image.id],
      variants: [{ destinationId: destination.id, format: "IMAGE", mediaIds: [image.id],
        providerOptions: { madeWithAi: false, paidPartnership: false, maxApiCostMicros: 1000000 } }],
    });
    assert.equal(created.status, 201);
    const post = await created.json();
    const schedule = { revisionId: post.revision.id, destinationIds: [destination.id],
      enqueueId: randomUUID(), dueAt: new Date(Date.now() + 8000).toISOString(), timeZone: "Europe/London" };
    // Scheduling cannot substitute for approval of the exact content/destination revision.
    const unreviewed = await owner.api(`/api/social/posts/${post.id}/enqueue`, schedule);
    assert.equal(unreviewed.status, 409); assert.equal((await unreviewed.json()).code, "REVIEW_REQUIRED");
    assert.equal(await fixture.db.socialDelivery.count(), 0);
    const approved = await owner.api(`/api/social/posts/${post.id}/approve`, {
      revisionId: post.revision.id, destinationIds: [destination.id],
    });
    assert.equal(approved.status, 200);
    const reviewed = await fixture.db.socialPostRevision.findUniqueOrThrow({ where: { id: post.revision.id } });
    assert.ok(reviewed.reviewedAt); assert.equal(reviewed.reviewedById, owner.principal.userId);
    const queued = await owner.api(`/api/social/posts/${post.id}/enqueue`, schedule);
    assert.equal(queued.status, 200);
    const deliveryId = (await queued.json()).deliveries[0].id;
    await fixture.auth.logout(owner.principal);
    assert.equal(await fixture.db.customerSession.count({ where: { userId: owner.principal.userId } }), 0);
    assert.equal((await owner.api(`/api/social/posts/${post.id}`, {}, "GET")).status, 401);

    // This is the actual CLI and production runtime in a separate process, using
    // the same durable database/media and actual SDK HTTP against local Mockoon.
    // No browser or in-process worker.runOnce call participates in dispatch.
    worker = spawn(process.execPath, ["--import", "tsx", "apps/web/scripts/social-worker.ts", "run"], {
      env: { ...process.env, ...fixture.environment(), CONNECTION_MODE: "mock", ADS_MODE: "mock" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.on("error", error => { spawnError = error; });
    worker.stdout!.on("data", chunk => { output += String(chunk); });
    worker.stderr!.on("data", chunk => { output += String(chunk); });
    const running = () => {
      assert.equal(spawnError, undefined, "Background worker could not start.");
      assert.equal(worker!.exitCode, null, `Worker stopped: ${output}`);
      assert.equal(worker!.signalCode, null, `Worker was interrupted: ${output}`);
    };
    await delay(1500);
    running();
    assert.ok(Date.now() < Date.parse(schedule.dueAt), "Fixture setup exceeded the future scheduling window.");
    const waiting = await fixture.db.socialDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    assert.equal(waiting.status, "QUEUED"); assert.equal(waiting.attempts, 0);
    assert.equal(waiting.dueAt.toISOString(), schedule.dueAt); assert.equal(waiting.timeZone, "Europe/London");
    assert.equal(await fixture.db.socialApiCostReservation.count({ where: { deliveryId, operation: "POST_CREATE" } }), 0);
    assert.equal((await fixture.counts()).x["qa-create"], "0");

    const deadline = Date.parse(schedule.dueAt) + 20000;
    let delivered = false;
    while (Date.now() < deadline) {
      running();
      const current = await fixture.db.socialDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      if (current.status === "SUCCEEDED") {
        assert.ok(current.completedAt && current.completedAt >= new Date(schedule.dueAt));
        assert.equal(current.externalId, "6002"); assert.equal(current.attempts, 1);
        delivered = true; break;
      }
      assert.ok(!["BLOCKED", "FAILED", "UNCERTAIN"].includes(current.status), `Delivery stopped with ${current.status}: ${current.errorCode}`);
      await delay(250);
    }
    assert.ok(delivered, `The background worker did not finish the future schedule: ${output}`);
    // Leave the continuous worker polling beyond completion to detect resubmission.
    await delay(1500); running();
    assert.equal((await fixture.counts()).x["qa-create"], "1");
    assert.equal(await fixture.db.socialApiCostReservation.count({ where: { deliveryId, operation: "POST_CREATE" } }), 1);
    assert.equal(await fixture.db.socialDeliveryAttempt.count({ where: { deliveryId } }), 1);
    assert.equal((await fixture.db.socialPost.findUniqueOrThrow({ where: { id: post.id } })).status, "COMPLETED");
    assert.deepEqual(await fixture.db.socialPostRevision.findUniqueOrThrow({ where: { id: reviewed.id } }), reviewed);
    assert.doesNotMatch(output, /x-refresh|x-access|Ciphertext|fixture-x-secret|accessToken|refreshToken/);
  } finally {
    await stop(worker);
    await fixture.close();
  }
});
