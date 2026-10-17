import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEmailFixture } from "../support/email-fixture";
import { ensureFirstStepTx, ensureCurrentStepTx } from "../../apps/web/src/server/email/campaignStepService";
import { EmailDeliveryService } from "../../apps/web/src/server/email/emailDeliveryService";
import { SecurityError } from "../../apps/web/src/server/security/errors";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function started(f: Awaited<ReturnType<typeof createEmailFixture>>, options?: Parameters<Awaited<ReturnType<typeof createEmailFixture>>["enrolled"]>[0]) {
  const enrolled = await f.enrolled(options);
  while (await f.funnels.processOnce()) { /* Consume fixture tracking before dispatch authority. */ }
  const execution = await f.db.$transaction(async tx => {
    await ensureFirstStepTx(tx, enrolled.membership.id, { kind: "MANUAL", actorId: f.principal.userId, requestKey: randomUUID(), requestDigest: "a".repeat(64), reason: "Explicit scheduled follow-up" }, f.now());
    return ensureCurrentStepTx(tx, enrolled.membership.id, f.now());
  });
  assert.ok(execution); const intent = await f.delivery.createStepIntent(execution.id);
  assert.ok("sendId" in intent, JSON.stringify(intent)); return { ...enrolled, execution, sendId: intent.sendId };
}

test("workers require persisted start authority and leases survive browser-session expiry", async () => {
  const f = await createEmailFixture();
  try {
    const manual = await f.enrolled(), intent = await f.delivery.createIntent(f.principal, { membershipId: manual.membership.id });
    assert.equal(await f.delivery.claimSend(intent.send.id), null);
    const scheduled = await started(f);
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    const peer = new EmailDeliveryService(f.createPeerDb(), f.auth, f.vault, f.providerFor, { now: f.now, liveEnabled: false, unsubscribeBaseUrl: "https://launchpad.test/unsubscribe" });
    const [a, b] = await Promise.all([f.delivery.claimSend(scheduled.sendId), peer.claimSend(scheduled.sendId)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal((await f.delivery.dispatchClaimed(a ?? b!)).outcome, "ACCEPTED");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    await assert.rejects(() => f.delivery.dispatch(f.principal, intent.send.id), (e: unknown) => e instanceof SecurityError && e.code === "UNAUTHENTICATED");
  } finally { await f.close(); }
});

test("expired unsubmitted lease is reclaimable but stale worker cannot dispatch", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f), lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease);
    f.setNow(new Date(f.now().getTime() + 120_000));
    assert.equal((await f.delivery.recoverOnce())?.status, "PENDING");
    await assert.rejects(() => f.delivery.dispatchClaimed(lease), (e: unknown) => e instanceof SecurityError && e.code === "EMAIL_LEASE_LOST");
    const next = await f.delivery.claimSend(scheduled.sendId); assert.ok(next); assert.notEqual(next.token, lease.token);
    assert.equal((await f.delivery.dispatchClaimed(next)).outcome, "ACCEPTED");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("cancellation after a valid claim yields without provider submission or stopping the worker", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f), lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease);
    await f.campaigns.stop(f.principal, scheduled.membership.id, { reason: "Recipient cancelled before worker submission" });
    const result = await f.delivery.dispatchClaimed(lease);
    assert.equal(result.outcome, "NOT_SUBMITTED"); assert.equal(result.code, "EMAIL_STEP_CHANGED");
    assert.equal(result.send.status, "CANCELLED"); assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: scheduled.sendId } })).leaseTokenHash, null);
  } finally { await f.close(); }
});

test("expired submitted lease becomes UNKNOWN while a late positive result retains actual acceptance", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f), lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease);
    const reached = gate(), resume = gate();
    f.transport.onSend = async request => { const result = f.transport.accept(request); reached.resolve(); await resume.promise; return result; };
    const pending = f.delivery.dispatchClaimed(lease); await reached.promise;
    f.setNow(new Date(f.now().getTime() + 120_000));
    assert.equal((await f.delivery.recoverOnce())?.status, "UNKNOWN");
    assert.equal(await f.delivery.claimSend(scheduled.sendId), null);
    resume.resolve(); assert.equal((await pending).outcome, "ACCEPTED");
    const attempt = await f.db.deliveryAttempt.findFirstOrThrow({ where: { sendId: scheduled.sendId } });
    assert.equal(attempt.outcome, "UNKNOWN"); assert.equal(attempt.errorCode, "PROCESS_INTERRUPTED");
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: scheduled.sendId } })).status, "ACCEPTED");
  } finally { await f.close(); }
});

test("expired definitely-unsent step is skipped locally while unknown work never expires into a new send", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f);
    const send = await f.db.messageSend.findUniqueOrThrow({ where: { id: scheduled.sendId } });
    f.setNow(send.expiresAt);
    assert.equal((await f.delivery.recoverOnce())?.status, "EXPIRED");
    assert.equal((await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: scheduled.execution.id } })).status, "SKIPPED");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("automatic definitive retries back off and stop after five attempts with the same request identity", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f);
    f.transport.onSend = () => Response.json({ name: "rate_limit_exceeded" }, { status: 429, headers: { "retry-after": "2" } });
    for (let count = 1; count <= 5; count++) {
      const lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease);
      assert.equal((await f.delivery.dispatchClaimed(lease)).outcome, "REJECTED");
      const send = await f.db.messageSend.findUniqueOrThrow({ where: { id: scheduled.sendId } });
      if (count < 5) {
        assert.equal(send.nextAttemptAt!.getTime() - f.now().getTime(), 60_000 * 2 ** (count - 1));
        assert.equal(await f.delivery.claimSend(scheduled.sendId), null);
        f.setNow(send.nextAttemptAt!); await f.connections.checkSender(f.principal, scheduled.setup.sender.id);
      } else assert.equal(send.nextAttemptAt, null);
    }
    assert.equal(await f.delivery.claimSend(scheduled.sendId), null);
    const posts = f.requests.filter(r => r.method === "POST"); assert.equal(posts.length, 5);
    assert.equal(new Set(posts.map(r => r.body)).size, 1); assert.equal(new Set(posts.map(r => r.headers.get("idempotency-key"))).size, 1);
    assert.equal((await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: scheduled.execution.id } })).status, "FAILED");
  } finally { await f.close(); }
});

test("automatic negative reconciliation is bounded and never converts UNKNOWN into a retryable send", async () => {
  const f = await createEmailFixture();
  try {
    const scheduled = await started(f), providerId = randomUUID();
    f.transport.onSend = request => { f.transport.accept(request, providerId); throw new Error("Remote acceptance response lost"); };
    const lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease); await f.delivery.dispatchClaimed(lease);
    const signed = f.signWebhook({ type: "email.delivered", created_at: f.now().toISOString(), data: { email_id: providerId,
      from: '"Fixture team" <hello@example.test>', to: [scheduled.contact.email], subject: "Your consultation", tags: { launchpad_send: scheduled.sendId } } });
    await f.delivery.ingestWebhook(scheduled.setup.ingressToken, signed.headers, signed.rawBody); await f.delivery.processOnce();
    f.transport.onRetrieve = () => Response.json({ name: "not_found" }, { status: 404 });
    for (let count = 1; count <= 5; count++) {
      const recovery = await f.delivery.claimReconciliation(scheduled.sendId); assert.ok(recovery);
      assert.equal((await f.delivery.reconcileClaimed(recovery)).outcome, "UNRESOLVED");
      const send = await f.db.messageSend.findUniqueOrThrow({ where: { id: scheduled.sendId } });
      assert.equal(send.status, "UNKNOWN"); assert.equal(send.reconcileAttemptCount, count);
      assert.equal(await f.delivery.claimSend(scheduled.sendId), null);
      if (count < 5) f.setNow(send.nextAttemptAt!);
    }
    assert.equal(await f.delivery.claimReconciliation(scheduled.sendId), null);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    assert.equal(f.requests.filter(r => new URL(r.url).pathname.startsWith("/emails/")).length, 5);
    assert.equal((await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: scheduled.execution.id } })).status, "SEND_PENDING");
  } finally { await f.close(); }
});

test("older unknown sends without candidate IDs cannot starve later positive reconciliation", async () => {
  const f = await createEmailFixture();
  try {
    const published = await f.publishedCampaign(), sendIds: string[] = [];
    f.transport.onSend = () => { throw new Error("No response"); };
    for (let count = 0; count < 21; count++) {
      const scheduled = await started(f, { published, journey: false }); sendIds.push(scheduled.sendId);
      const lease = await f.delivery.claimSend(scheduled.sendId); assert.ok(lease); await f.delivery.dispatchClaimed(lease);
    }
    const target = sendIds.sort().at(-1)!, providerId = randomUUID();
    const request = f.requests.find(r => r.method === "POST" && (r.json?.tags as {name: string; value: string}[]).some(t => t.name === "launchpad_send" && t.value === target))!;
    f.transport.accept(request, providerId);
    const signed = f.signWebhook({ type: "email.delivered", created_at: f.now().toISOString(), data: { email_id: providerId,
      from: request.json!.from, to: request.json!.to, subject: request.json!.subject, tags: { launchpad_send: target } } });
    await f.delivery.ingestWebhook(published.setup.ingressToken, signed.headers, signed.rawBody); await f.delivery.processOnce();
    assert.equal(await f.delivery.claimReconciliation(), null, "The bounded first page should yield after deferring unknown IDs");
    const lease = await f.delivery.claimReconciliation(); assert.ok(lease); assert.equal(lease.sendId, target);
    assert.equal((await f.delivery.reconcileClaimed(lease)).outcome, "MATCHED");
    assert.equal(await f.db.messageSend.count({ where: { status: "UNKNOWN", reconcileAttemptCount: 0 } }), 20);
  } finally { await f.close(); }
});

test("verified unmatched permanent negatives suppress the address without inventing a send or subject binding", async () => {
  for (const [type, bounce, reason] of [
    ["email.bounced", { type: "Permanent", subType: "General" }, "HARD_BOUNCE"],
    ["email.complained", undefined, "COMPLAINT"],
    ["email.suppressed", undefined, "PROVIDER_SUPPRESSION"],
  ] as const) {
    const f = await createEmailFixture();
    try {
      const first = await f.enrolled({ journey: false }), second = await f.enrolled({ recipient: first, category: "news", journey: false });
      const original = await f.delivery.createIntent(f.principal, { membershipId: first.membership.id });
      const pending = await f.delivery.createIntent(f.principal, { membershipId: second.membership.id });
      const providerId = randomUUID();
      f.transport.onSend = request => { f.transport.accept(request, providerId); throw new Error("Lost response"); };
      assert.equal((await f.delivery.dispatch(f.principal, original.send.id)).outcome, "UNKNOWN");
      const signed = f.signWebhook({ type, created_at: f.now().toISOString(), data: { email_id: providerId,
        from: '"Fixture team" <hello@example.test>', to: [first.contact.email], subject: "Your consultation",
        tags: { launchpad_send: original.send.id }, ...(bounce ? { bounce } : {}) } });
      const receipt = await f.delivery.ingestWebhook(first.setup.ingressToken, signed.headers, signed.rawBody);
      assert.equal((await f.delivery.processOnce())?.status, "UNMATCHED");
      assert.equal(await f.db.emailSuppression.count({ where: { reason, category: "*", active: true } }), 1, type);
      assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: pending.send.id } })).status, "CANCELLED");
      assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: original.send.id } })).status, "UNKNOWN");
      assert.equal((await f.db.emailDeliveryReceipt.findUniqueOrThrow({ where: { id: receipt.receiptId } })).sendId, null);
      assert.equal(await f.db.trackingEvent.count({ where: { dedupeKey: `email-receipt:${receipt.receiptId}` } }), 0);
      const audits = await f.db.emailPolicyAudit.count();
      assert.equal((await f.delivery.reconcile(f.principal, original.send.id)).outcome, "MATCHED");
      assert.equal((await f.delivery.processOnce())?.status, "MATCHED");
      assert.equal(await f.db.emailPolicyAudit.count(), audits, "Binding later must not apply suppression twice");
    } finally { await f.close(); }
  }
});

test("unmatched soft and multi-recipient bounces cannot establish a permanent address hold", async () => {
  for (const multi of [false, true]) {
    const f = await createEmailFixture();
    try {
      const enrolled = await f.enrolled({ journey: false });
      const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
      const signed = f.signWebhook({ type: "email.bounced", created_at: f.now().toISOString(), data: { email_id: randomUUID(),
        from: '"Fixture team" <hello@example.test>', to: multi ? [enrolled.contact.email, "another@example.test"] : [enrolled.contact.email],
        subject: "Your consultation", tags: {}, bounce: { type: multi ? "Permanent" : "Transient", subType: "General" } } });
      await f.delivery.ingestWebhook(enrolled.setup.ingressToken, signed.headers, signed.rawBody);
      assert.equal((await f.delivery.processOnce())?.status, "UNMATCHED");
      assert.equal(await f.db.emailSuppression.count({ where: { active: true } }), 0);
      assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } })).status, "PENDING");
    } finally { await f.close(); }
  }
});
