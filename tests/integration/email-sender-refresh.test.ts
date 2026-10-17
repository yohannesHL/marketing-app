import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEmailFixture } from "../support/email-fixture";
import { EmailConnectionService } from "../../apps/web/src/server/email/emailConnectionService";
import { ensureFirstStepTx, ensureCurrentStepTx } from "../../apps/web/src/server/email/campaignStepService";

async function readyStep(f: Awaited<ReturnType<typeof createEmailFixture>>) {
  const enrolled = await f.enrolled();
  while (await f.funnels.processOnce()) { /* Consume fixture tracking before dispatch authority. */ }
  await f.db.$transaction(async tx => {
    await ensureFirstStepTx(tx, enrolled.membership.id, { kind: "MANUAL", actorId: f.principal.userId, requestKey: randomUUID(), requestDigest: "b".repeat(64), reason: "Scheduled cadence" }, f.now());
    await ensureCurrentStepTx(tx, enrolled.membership.id, f.now());
  });
  return enrolled;
}

test("stale sender refresh has one durable claim and works without a browser session", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await readyStep(f);
    f.setNow(new Date(f.now().getTime() + 901_000));
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    const before = f.requests.length;
    const peer = new EmailConnectionService(f.createPeerDb(), f.auth, f.vault, f.providerFor, "https://launchpad.test", f.now);
    const [a, b] = await Promise.all([f.connections.claimSenderRefresh(scheduled.membership.id), peer.claimSenderRefresh(scheduled.membership.id)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal((await f.connections.refreshClaimedSender(a ?? b!)).status, "READY");
    assert.equal(f.requests.length - before, 2);
    assert.equal(await f.connections.claimSenderRefresh(scheduled.membership.id), null);
    const sender = await f.db.emailSender.findUniqueOrThrow({ where: { id: scheduled.setup.sender.id } });
    assert.equal(sender.status, "VERIFIED"); assert.equal(sender.refreshLeaseTokenHash, null);
  } finally { await f.close(); }
});

test("connection rotation between readiness reads invalidates the worker result", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await readyStep(f); f.setNow(new Date(f.now().getTime() + 901_000));
    const lease = await f.connections.claimSenderRefresh(scheduled.membership.id); assert.ok(lease);
    const before = f.requests.length; let rotated = false;
    f.transport.onRequest = async request => {
      if (!rotated && new URL(request.url).pathname.startsWith("/domains/")) {
        rotated = true; await f.connections.update(f.principal, scheduled.setup.connection.id, { status: "ACTIVE" });
      }
      return undefined;
    };
    const result = await f.connections.refreshClaimedSender(lease);
    assert.equal(result.status, "BLOCKED");
    const sender = await f.db.emailSender.findUniqueOrThrow({ where: { id: scheduled.setup.sender.id } });
    assert.equal(sender.status, "UNVERIFIED"); assert.equal(sender.verifiedAt, null);
    assert.equal(f.requests.length - before, 1, "Second readiness HTTP call must fail its fence");
  } finally { await f.close(); }
});

test("sender refresh crash releases only an expired lease with a bounded retry time", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await readyStep(f); f.setNow(new Date(f.now().getTime() + 901_000));
    const lease = await f.connections.claimSenderRefresh(scheduled.membership.id); assert.ok(lease);
    f.setNow(new Date(f.now().getTime() + 120_000));
    assert.equal((await f.connections.recoverSenderRefreshOnce())?.code, "REFRESH_INTERRUPTED");
    assert.equal((await f.connections.refreshClaimedSender(lease)).status, "BLOCKED");
    assert.equal(await f.connections.claimSenderRefresh(scheduled.membership.id), null);
  } finally { await f.close(); }
});

test("readiness failures back off finitely and an explicit manual check can recover without sending", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await readyStep(f); f.setNow(new Date(f.now().getTime() + 901_000));
    f.transport.onRequest = request => new URL(request.url).pathname.startsWith("/domains/")
      ? Response.json({ name: "internal_server_error" }, { status: 503 }) : undefined;
    for (let count = 1; count <= 5; count++) {
      const lease = await f.connections.claimSenderRefresh(scheduled.membership.id); assert.ok(lease);
      const outcome = await f.connections.refreshClaimedSender(lease);
      assert.equal(outcome.status, count < 5 ? "DEFERRED" : "BLOCKED");
      const sender = await f.db.emailSender.findUniqueOrThrow({ where: { id: scheduled.setup.sender.id } });
      assert.equal(sender.refreshAttemptCount, count);
      assert.equal(await f.connections.claimSenderRefresh(scheduled.membership.id), null);
      if (count < 5) f.setNow(sender.refreshNextAttemptAt!);
    }
    f.transport.onRequest = undefined;
    assert.equal((await f.connections.checkSender(f.principal, scheduled.setup.sender.id)).status, "VERIFIED");
    assert.equal(await f.db.deliveryAttempt.count(), 0); assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("sender public diagnostics omit worker lease and authorization internals", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await readyStep(f);
    const checked = await f.connections.checkSender(f.principal, scheduled.setup.sender.id);
    assert.equal(checked.status, "VERIFIED");
    f.setNow(new Date(f.now().getTime() + 901_000));
    assert.ok(await f.connections.claimSenderRefresh(scheduled.membership.id));
    const connection = await f.connections.get(f.principal, scheduled.setup.connection.id);
    assert.equal(connection.senders[0].id, scheduled.setup.sender.id);
    assert.equal(connection.senders[0].refreshStatus, "CLAIMED");
    for (const dto of [checked, connection]) {
      assert.doesNotMatch(JSON.stringify(dto), /refreshLeaseTokenHash|refreshLeaseUntil|refreshMembershipId|refreshConnectionGeneration|refreshCredentialVersion/);
    }
  } finally { await f.close(); }
});
