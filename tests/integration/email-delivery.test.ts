import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { EmailDeliveryService } from "../../apps/web/src/server/email/emailDeliveryService";
import type { EmailProviderContext, FrozenEmailRequest } from "../../apps/web/src/server/email/emailProvider";
import { SecurityError } from "../../apps/web/src/server/security/errors";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function message(f: EmailFixture, sendId: string, providerMessageId: string, type = "email.delivered", to = "maya@example.test") {
  return { type, created_at: f.now().toISOString(), data: { email_id: providerMessageId,
    from: '"Fixture team" <hello@example.test>', to: [to], subject: "Your consultation", tags: { launchpad_send: sendId } } };
}
async function receipt(f: EmailFixture, ingressToken: string, payload: unknown, deliveryId?: string) {
  const signed = f.signWebhook(payload, { deliveryId });
  return f.delivery.ingestWebhook(ingressToken, signed.headers, signed.rawBody);
}
const sendRequests = (f: EmailFixture) => f.requests.filter(r => r.method === "POST" && new URL(r.url).pathname === "/emails");

test("one membership step retains one frozen intent and a safe owned history", async () => {
  const f = await createEmailFixture();
  try {
    const { membership } = await f.enrolled();
    const service = new EmailDeliveryService(f.db, f.auth, f.vault, f.providerFor, {
      now: f.now, liveEnabled: false, unsubscribeBaseUrl: "https://launchpad.test/email/unsubscribe",
    });
    const first = await service.createIntent(f.principal, { membershipId: membership.id });
    const again = await service.createIntent(f.principal, { membershipId: membership.id });
    assert.equal(first.send.id, again.send.id);
    assert.equal(again.existing, true);
    assert.equal((await service.get(f.principal, first.send.id)).attempts.length, 0);
    assert.doesNotMatch(JSON.stringify(first), /payloadCiphertext|credentialCiphertext|idempotencyKey|unsubscribeUrl/);
  } finally { await f.close(); }
});

test("concurrent explicit dispatch submits one frozen request and retains acceptance", async () => {
  const f = await createEmailFixture();
  try {
    const { membership } = await f.enrolled(); let calls = 0;
    const base = f.providerFor("TEST");
    const provider = Object.assign(Object.create(base), { send: async (context: EmailProviderContext, request: FrozenEmailRequest) => {
      await context.beforeRequest("SEND"); calls++;
      assert.equal(request.idempotencyKey.startsWith("launchpad-email:"), true);
      assert.equal(JSON.parse(request.body).to.length, 1);
      return { kind: "ACCEPTED" as const, providerMessageId: "2f8f7cf0-984a-4667-9873-596abf8ef7c8" };
    } });
    const service = new EmailDeliveryService(f.db, f.auth, f.vault, () => provider, { now: f.now, liveEnabled: false, unsubscribeBaseUrl: "https://launchpad.test/email/unsubscribe" });
    const { send } = await service.createIntent(f.principal, { membershipId: membership.id });
    await Promise.all([service.dispatch(f.principal, send.id), service.dispatch(f.principal, send.id)]);
    assert.equal(calls, 1);
    const history = await service.get(f.principal, send.id);
    assert.equal(history.send.status, "ACCEPTED");
    assert.equal(history.attempts.length, 1);
    assert.equal((await service.dispatch(f.principal, send.id)).outcome, "ALREADY_ACCEPTED");
  } finally { await f.close(); }
});

test("lost acceptance remains UNKNOWN until owned positive evidence; dispatch and retry never post again", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), providerId = randomUUID();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = request => { f.transport.accept(request, providerId); throw new Error("Connection closed after remote acceptance"); };
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "UNKNOWN");
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "UNKNOWN");
    assert.equal((await f.delivery.retry(f.principal, send.id)).outcome, "UNKNOWN");
    assert.equal((await f.delivery.reconcile(f.principal, send.id, { providerMessageId: randomUUID() })).outcome, "UNRESOLVED");
    assert.equal((await f.delivery.get(f.principal, send.id)).send.status, "UNKNOWN");
    const signed = await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId));
    assert.equal((await f.delivery.processOnce())?.status, "UNMATCHED");
    assert.equal(await f.delivery.processOnce(), null, "Unmatched receipt must yield without busy looping");
    assert.equal((await f.delivery.reconcile(f.principal, send.id)).outcome, "MATCHED");
    assert.equal((await f.delivery.processOnce())?.status, "MATCHED");
    assert.equal(await f.delivery.processOnce(), null);
    const history = await f.delivery.get(f.principal, send.id);
    assert.equal(history.send.status, "ACCEPTED"); assert.equal(history.send.deliveryState, "DELIVERED");
    assert.equal(history.attempts[0].outcome, "UNKNOWN", "Recovery must not rewrite the completed original attempt");
    assert.equal(sendRequests(f).length, 1);
    const tracking = await f.db.trackingEvent.findFirstOrThrow({ where: { dedupeKey: `email-receipt:${signed.receiptId}` } });
    assert.equal(tracking.subjectId, enrolled.subject.id); assert.equal(tracking.contactId, enrolled.contact.id);
    assert.deepEqual((tracking.envelope as { properties: unknown }).properties, { deliveryState: "DELIVERED", sendId: send.id,
      campaignId: enrolled.campaign.id, campaignRevisionId: enrolled.revision.id, stepId: enrolled.step.id });
  } finally { await f.close(); }
});

test("definitive rate-limit retry waits then reuses exact body/key; plain dispatch cannot retry", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = () => Response.json({ name: "rate_limit_exceeded" }, { status: 429, headers: { "retry-after": "2" } });
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "REJECTED");
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).code, "EXPLICIT_RETRY_REQUIRED");
    assert.equal((await f.delivery.retry(f.principal, send.id)).code, "RETRY_NOT_DUE");
    f.setNow(new Date(f.now().getTime() + 2_000)); f.transport.onSend = undefined;
    assert.equal((await f.delivery.retry(f.principal, send.id)).outcome, "ACCEPTED");
    const requests = sendRequests(f); assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].headers.get("idempotency-key"), requests[1].headers.get("idempotency-key"));
    assert.deepEqual((await f.delivery.get(f.principal, send.id)).attempts.map(a => a.outcome), ["REJECTED", "ACCEPTED"]);
  } finally { await f.close(); }
});

test("stopping before the final fence prevents HTTP; stopping after it preserves real acceptance", async () => {
  const f = await createEmailFixture();
  try {
    const before = await f.enrolled(), reached = gate(), resume = gate(), base = f.providerFor("TEST");
    const provider = Object.assign(Object.create(base), { send: async (context: EmailProviderContext, request: FrozenEmailRequest) => {
      reached.resolve(); await resume.promise; return base.send(context, request);
    } });
    const service = new EmailDeliveryService(f.db, f.auth, f.vault, () => provider, { now: f.now, liveEnabled: false, unsubscribeBaseUrl: "https://launchpad.test/email/unsubscribe" });
    const first = await service.createIntent(f.principal, { membershipId: before.membership.id });
    const pending = service.dispatch(f.principal, first.send.id); await reached.promise;
    await f.campaigns.stop(f.principal, before.membership.id, { reason: "Recipient cancelled before submit" });
    resume.resolve(); assert.equal((await pending).outcome, "NOT_SUBMITTED"); assert.equal(sendRequests(f).length, 0);
    assert.equal((await service.get(f.principal, first.send.id)).send.status, "CANCELLED");

    const after = await f.enrolled(), atProvider = gate(), release = gate();
    const second = await f.delivery.createIntent(f.principal, { membershipId: after.membership.id });
    f.transport.onSend = async request => { atProvider.resolve(); await release.promise; return f.transport.accept(request); };
    const submitted = f.delivery.dispatch(f.principal, second.send.id); await atProvider.promise;
    await f.campaigns.stop(f.principal, after.membership.id, { reason: "Recipient cancelled after submit" });
    const stopped = await f.db.campaignMembership.findUniqueOrThrow({ where: { id: after.membership.id } });
    assert.equal(stopped.endedAt, null, "Unknown remote work holds the membership slot");
    release.resolve(); assert.equal((await submitted).outcome, "ACCEPTED");
    const history = await f.delivery.get(f.principal, second.send.id);
    assert.ok(history.send.cancelRequestedAt); assert.equal(history.send.status, "ACCEPTED");
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: after.membership.id } })).status, "STOPPED");
  } finally { await f.close(); }
});

test("callback before response is retained, then requeued on acceptance with durable receipt dedupe", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), providerId = randomUUID(), reached = gate(), resume = gate();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = async request => { const response = f.transport.accept(request, providerId); reached.resolve(); await resume.promise; return response; };
    const pending = f.delivery.dispatch(f.principal, send.id); await reached.promise;
    const payload = message(f, send.id, providerId), deliveryId = `msg_${randomUUID()}`;
    const first = await receipt(f, enrolled.setup.ingressToken, payload, deliveryId);
    const duplicate = await receipt(f, enrolled.setup.ingressToken, payload, deliveryId);
    assert.equal(first.receiptId, duplicate.receiptId); assert.equal(duplicate.duplicate, true);
    assert.equal((await f.delivery.processOnce())?.status, "UNMATCHED"); assert.equal(await f.delivery.processOnce(), null);
    resume.resolve(); await pending;
    assert.equal((await f.delivery.processOnce())?.status, "MATCHED"); assert.equal(await f.delivery.processOnce(), null);
    assert.equal(await f.db.trackingEvent.count({ where: { dedupeKey: `email-receipt:${first.receiptId}` } }), 1);
    const stored = await f.db.emailDeliveryReceipt.findUniqueOrThrow({ where: { id: first.receiptId } });
    assert.equal(stored.duplicateCount, 1); assert.equal(stored.sendId, send.id);
    await assert.rejects(() => receipt(f, enrolled.setup.ingressToken, { ...payload, type: "email.bounced" }, deliveryId),
      (error: unknown) => error instanceof SecurityError && error.code === "DELIVERY_CONFLICT");
    assert.equal((await f.db.emailDeliveryReceipt.findUniqueOrThrow({ where: { id: first.receiptId } })).conflictCount, 1);
    assert.equal((await f.delivery.get(f.principal, send.id)).send.deliveryState, "DELIVERED");
  } finally { await f.close(); }
});

test("opaque callback tags cannot bind another message or recipient and foreign owners cannot operate a send", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), other = await f.owner(), providerId = randomUUID();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = request => { f.transport.accept(request, providerId); throw new Error("Lost response"); };
    await f.delivery.dispatch(f.principal, send.id);
    await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId)); await f.delivery.processOnce();
    f.knownEmails.get(providerId)!.to = ["different@example.test"];
    const reconciliation = await f.delivery.reconcile(f.principal, send.id);
    assert.equal(reconciliation.outcome, "UNRESOLVED");
    assert.ok("code" in reconciliation); assert.equal(reconciliation.code, "PROVIDER_EVIDENCE_MISMATCH");
    assert.equal((await f.delivery.get(f.principal, send.id)).send.status, "UNKNOWN");
    for (const operation of [() => f.delivery.get(other.principal, send.id), () => f.delivery.dispatch(other.principal, send.id),
      () => f.delivery.reconcile(other.principal, send.id), () => f.delivery.createIntent(other.principal, { membershipId: enrolled.membership.id })])
      await assert.rejects(operation, (error: unknown) => error instanceof SecurityError && error.code === "NOT_FOUND");
    assert.equal(sendRequests(f).length, 1);
  } finally { await f.close(); }
});

test("unsubscribe GET is inert, POST is category scoped and idempotent, and the same link works after explicit resubscribe", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled();
    await f.consent(enrolled.contact.id, "news");
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    await f.delivery.dispatch(f.principal, send.id);
    const request = sendRequests(f)[0].json!, url = String((request.headers as Record<string, string>)["List-Unsubscribe"]).slice(1, -1), token = new URL(url).pathname.split("/").at(-1)!;
    assert.deepEqual(await f.delivery.unsubscribeInfo(token), { valid: true });
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_IN");
    await f.delivery.unsubscribe(token); const audits = await f.db.emailPolicyAudit.count();
    await f.delivery.unsubscribe(token); assert.equal(await f.db.emailPolicyAudit.count(), audits);
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_OUT");
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "news")).state, "OPTED_IN");
    await f.consent(enrolled.contact.id); await f.delivery.unsubscribe(token);
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_OUT");
  } finally { await f.close(); }
});

test("deletion during provider submission redacts unmatched receipts and never resurrects raw identity", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), providerId = randomUUID(), reached = gate(), resume = gate();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = async request => { const response = f.transport.accept(request, providerId); reached.resolve(); await resume.promise; return response; };
    const pending = f.delivery.dispatch(f.principal, send.id); await reached.promise;
    const before = await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId)); await f.delivery.processOnce();
    await f.tracking.deleteContact(f.principal, enrolled.contact.id);
    const during = await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId, "email.sent"));
    resume.resolve(); assert.equal((await pending).outcome, "ACCEPTED");
    const stored = await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } });
    assert.ok(stored.redactedAt); assert.equal(stored.payloadCiphertext, null); assert.equal(stored.providerMessageId, null); assert.ok(stored.providerMessageIdDigest);
    const after = await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId, "email.opened"));
    for (const id of [before.receiptId, during.receiptId, after.receiptId]) {
      const row = await f.db.emailDeliveryReceipt.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "REDACTED"); assert.deepEqual(row.envelope, {}); assert.equal(row.providerMessageId, null);
      assert.equal(row.addressDigest, null); assert.equal(row.opaqueSendRef, null);
    }
    assert.equal(await f.delivery.processOnce(), null);
    assert.equal((await f.db.deliveryAttempt.findFirstOrThrow({ where: { sendId: send.id } })).providerMessageId, null);
  } finally { await f.close(); }
});

test("global hard-bounce suppression stops other categories and provider removal cannot clear a local opt-out", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.enrolled(), second = await f.enrolled({ recipient: first, category: "news" });
    const sent = await f.delivery.createIntent(f.principal, { membershipId: first.membership.id });
    const pending = await f.delivery.createIntent(f.principal, { membershipId: second.membership.id });
    await f.delivery.dispatch(f.principal, sent.send.id);
    const providerId = (await f.db.messageSend.findUniqueOrThrow({ where: { id: sent.send.id } })).providerMessageId!;
    const bounced = { ...message(f, sent.send.id, providerId, "email.bounced"), data: {
      ...message(f, sent.send.id, providerId).data, bounce: { type: "Permanent", subType: "General" } } };
    await receipt(f, first.setup.ingressToken, bounced); await f.delivery.processOnce();
    assert.equal((await f.delivery.get(f.principal, pending.send.id)).send.status, "CANCELLED");
    assert.equal((await f.campaigns.policy(f.principal, first.contact.id, "news")).eligible, false);
    assert.equal((await f.delivery.dispatch(f.principal, pending.send.id)).outcome, "NOT_SUBMITTED");
    const body = sendRequests(f)[0].json!, unsubscribe = String((body.headers as Record<string, string>)["List-Unsubscribe"]).slice(1, -1);
    await f.delivery.unsubscribe(new URL(unsubscribe).pathname.split("/").at(-1)!);
    await receipt(f, first.setup.ingressToken, { type: "suppression.removed", created_at: f.now().toISOString(),
      data: { email: "maya@example.test", origin: "manual", source_id: null } });
    assert.equal((await f.delivery.processOnce())?.reason, "LOCAL_POLICY_UNCHANGED");
    const policy = await f.campaigns.policy(f.principal, first.contact.id, "consultation");
    assert.equal(policy.state, "OPTED_OUT"); assert.equal(policy.eligible, false);
    assert.deepEqual(policy.holds.map(h => h.reason).sort(), ["HARD_BOUNCE", "OPT_OUT"]);
    assert.equal(sendRequests(f).length, 1);
  } finally { await f.close(); }
});

test("manual sends respect the immutable window and fresh readiness; rejected intents cannot cross a connection generation", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.setNow(new Date("2026-10-19T18:00:00Z"));
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).code, "EMAIL_READINESS_REQUIRED");
    await f.connections.checkSender(f.principal, enrolled.setup.sender.id);
    const deferred = await f.delivery.dispatch(f.principal, send.id);
    assert.equal(deferred.code, "SEND_WINDOW_CLOSED"); assert.equal(deferred.nextEligibleAt, "2026-10-20T09:00:00.000Z");
    assert.equal(sendRequests(f).length, 0); assert.equal((await f.delivery.get(f.principal, send.id)).attempts.length, 0);
    f.setNow(new Date("2026-10-20T09:00:00Z")); await f.connections.checkSender(f.principal, enrolled.setup.sender.id);
    f.transport.onSend = () => Response.json({ name: "rate_limit_exceeded" }, { status: 429, headers: { "retry-after": "1" } });
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "REJECTED");
    await f.connections.update(f.principal, enrolled.setup.connection.id, { status: "ACTIVE" });
    await f.connections.checkSender(f.principal, enrolled.setup.sender.id);
    f.setNow(new Date(f.now().getTime() + 1_000));
    assert.equal((await f.delivery.retry(f.principal, send.id)).code, "CONNECTION_CHANGED"); assert.equal(sendRequests(f).length, 1);
  } finally { await f.close(); }
});

test("retry cannot outlive provider idempotency and contact-scoped callbacks do not invent a deal attribution", async () => {
  const f = await createEmailFixture();
  try {
    const rejected = await f.enrolled();
    const first = await f.delivery.createIntent(f.principal, { membershipId: rejected.membership.id });
    f.transport.onSend = () => Response.json({ name: "rate_limit_exceeded" }, { status: 429, headers: { "retry-after": "1" } });
    await f.delivery.dispatch(f.principal, first.send.id);
    f.setNow(new Date(f.now().getTime() + 86_400_000));
    assert.equal((await f.delivery.retry(f.principal, first.send.id)).code, "IDEMPOTENCY_EXPIRED");
    f.transport.onSend = undefined;
    const contact = await f.enrolled({ membershipScope: "CONTACT", journey: false });
    const second = await f.delivery.createIntent(f.principal, { membershipId: contact.membership.id });
    await f.delivery.dispatch(f.principal, second.send.id);
    const providerId = (await f.db.messageSend.findUniqueOrThrow({ where: { id: second.send.id } })).providerMessageId!;
    const accepted = await receipt(f, contact.setup.ingressToken, message(f, second.send.id, providerId));
    assert.equal((await f.delivery.processOnce())?.status, "MATCHED");
    assert.equal(await f.db.trackingEvent.count({ where: { dedupeKey: `email-receipt:${accepted.receiptId}` } }), 0);
    assert.equal((await f.delivery.get(f.principal, second.send.id)).send.deliveryState, "DELIVERED");
    assert.equal(sendRequests(f).length, 2);
  } finally { await f.close(); }
});

test("late opened callback retains its own time and does not inherit a later delivery state", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id }); await f.delivery.dispatch(f.principal, send.id);
    const providerId = (await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } })).providerMessageId!;
    f.setNow(new Date(f.now().getTime() + 120_000));
    await receipt(f, enrolled.setup.ingressToken, message(f, send.id, providerId)); await f.delivery.processOnce();
    const opened = await receipt(f, enrolled.setup.ingressToken, { ...message(f, send.id, providerId, "email.opened"), created_at: "2026-10-19T10:01:00.000Z" });
    await f.delivery.processOnce();
    const tracking = await f.db.trackingEvent.findFirstOrThrow({ where: { dedupeKey: `email-receipt:${opened.receiptId}` } });
    assert.equal(tracking.occurredAt.toISOString(), "2026-10-19T10:01:00.000Z");
    assert.equal("deliveryState" in (tracking.envelope as { properties: object }).properties, false);
    assert.equal((await f.delivery.get(f.principal, send.id)).send.deliveryState, "DELIVERED");
  } finally { await f.close(); }
});

test("stale in-flight recovery preserves uncertainty when the original request later reports rejection", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), reached = gate(), resume = gate(), base = f.providerFor("TEST");
    const provider = Object.assign(Object.create(base), { send: async (context: EmailProviderContext) => {
      await context.beforeRequest("SEND"); reached.resolve(); await resume.promise;
      return { kind: "REJECTED" as const, code: "RATE_LIMITED" as const, retryable: true, retryAfterMs: 1_000 };
    } });
    const delivery = new EmailDeliveryService(f.db, f.auth, f.vault, () => provider, { now: f.now, liveEnabled: false, unsubscribeBaseUrl: "https://launchpad.test/unsubscribe" });
    const { send } = await delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    const pending = delivery.dispatch(f.principal, send.id); await reached.promise;
    f.setNow(new Date(f.now().getTime() + 61_000));
    assert.equal((await delivery.reconcile(f.principal, send.id)).outcome, "UNRESOLVED");
    assert.equal((await delivery.get(f.principal, send.id)).send.status, "UNKNOWN");
    resume.resolve(); await pending;
    const history = await delivery.get(f.principal, send.id);
    assert.equal(history.send.status, "UNKNOWN"); assert.equal(history.attempts[0].outcome, "UNKNOWN");
    assert.equal((await delivery.retry(f.principal, send.id)).outcome, "UNKNOWN");
  } finally { await f.close(); }
});

test("positive reconciliation wins a race against the original uncertain response without rewriting attempt history", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), providerId = randomUUID(), reached = gate(), resume = gate();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = async request => { f.transport.accept(request, providerId); reached.resolve(); await resume.promise; throw new Error("Response lost"); };
    const pending = f.delivery.dispatch(f.principal, send.id); await reached.promise;
    assert.equal((await f.delivery.reconcile(f.principal, send.id, { providerMessageId: providerId })).outcome, "MATCHED");
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: enrolled.membership.id } })).endedAt, null,
      "Actual request remains in flight until the local attempt finishes");
    resume.resolve(); assert.equal((await pending).outcome, "ACCEPTED");
    const history = await f.delivery.get(f.principal, send.id);
    assert.equal(history.send.status, "ACCEPTED"); assert.equal(history.attempts[0].outcome, "UNKNOWN");
    assert.ok((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: enrolled.membership.id } })).endedAt);
    assert.equal(sendRequests(f).length, 1);
  } finally { await f.close(); }
});

test("conflicting acceptance after positive reconciliation preserves the proven mapping and records ambiguity", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), knownId = randomUUID(), conflictingId = randomUUID(), reached = gate(), resume = gate();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    f.transport.onSend = async request => {
      f.transport.accept(request, knownId); reached.resolve(); await resume.promise;
      return Response.json({ id: conflictingId });
    };
    const pending = f.delivery.dispatch(f.principal, send.id); await reached.promise;
    await f.delivery.reconcile(f.principal, send.id, { providerMessageId: knownId });
    const proven = await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } });
    resume.resolve(); const result = await pending;
    assert.equal(result.outcome, "ACCEPTED"); assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
    const current = await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } });
    assert.equal(current.status, "ACCEPTED"); assert.equal(current.providerMessageId, knownId);
    assert.equal(current.providerMessageIdDigest, proven.providerMessageIdDigest); assert.deepEqual(current.acceptedAt, proven.acceptedAt);
    const history = await f.delivery.get(f.principal, send.id);
    assert.equal(history.attempts[0].outcome, "UNKNOWN"); assert.equal(history.attempts[0].code, "INVALID_PROVIDER_RESPONSE");
    assert.equal(sendRequests(f).length, 1);
  } finally { await f.close(); }
});

test("a provider identity already owned by another send remains unbound and uncertain", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.enrolled(), knownId = randomUUID();
    const original = await f.delivery.createIntent(f.principal, { membershipId: first.membership.id });
    f.transport.onSend = request => f.transport.accept(request, knownId);
    await f.delivery.dispatch(f.principal, original.send.id);
    const second = await f.enrolled({ setup: first.setup });
    const next = await f.delivery.createIntent(f.principal, { membershipId: second.membership.id });
    f.transport.onSend = () => Response.json({ id: knownId });
    const result = await f.delivery.dispatch(f.principal, next.send.id);
    assert.equal(result.outcome, "UNKNOWN"); assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
    const current = await f.db.messageSend.findUniqueOrThrow({ where: { id: next.send.id } });
    assert.equal(current.status, "UNKNOWN"); assert.equal(current.providerMessageId, null); assert.equal(current.acceptedAt, null);
    const history = await f.delivery.get(f.principal, next.send.id);
    assert.equal(history.attempts[0].outcome, "UNKNOWN"); assert.equal(history.attempts[0].code, "INVALID_PROVIDER_RESPONSE");
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: original.send.id } })).providerMessageId, knownId);
    assert.equal((await f.delivery.retry(f.principal, next.send.id)).outcome, "UNKNOWN");
  } finally { await f.close(); }
});
