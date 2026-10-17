import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createEmailFixture } from "../support/email-fixture";
import { CampaignStepService, ensureFirstStepTx, ensureCurrentStepTx } from "../../apps/web/src/server/email/campaignStepService";

test("cadence starts only with explicit durable authorization and preserves duration deadline across restart", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DURATION", seconds: 3600 };
    const published = await f.publishedCampaign({ setup, definition }), item = await f.enrolled({ published, journey: false });
    const service = new CampaignStepService(f.db, { now: f.now });
    assert.equal(await service.processOnce(), null);
    assert.equal(await f.db.$transaction(tx => ensureCurrentStepTx(tx, item.membership.id, f.now())), null);
    const authorization = { kind: "MANUAL" as const, actorId: f.principal.userId, requestKey: randomUUID(), requestDigest: "a".repeat(64), reason: "Start agreed follow-up" };
    const first = await f.db.$transaction(tx => ensureFirstStepTx(tx, item.membership.id, authorization, f.now()));
    assert.equal(first.status, "WAITING");
    assert.equal(first.dueAt!.toISOString(), "2026-10-19T11:00:00.000Z");
    assert.equal((await f.db.$transaction(tx => ensureFirstStepTx(tx, item.membership.id, authorization, f.now()))).id, first.id);
    await assert.rejects(f.db.$transaction(tx => ensureFirstStepTx(tx, item.membership.id, { ...authorization, requestDigest: "b".repeat(64) }, f.now())), { code: "IDEMPOTENCY_CONFLICT" });
    f.setNow(new Date("2026-10-19T11:01:00Z"));
    const restarted = new CampaignStepService(f.db, { now: f.now });
    const resolved = await restarted.advance(first.id);
    assert.equal(resolved.status, "READY");
    assert.equal(resolved.dueAt, "2026-10-19T11:00:00.000Z");
    assert.equal(f.requests.filter(request => request.method === "POST").length, 0);
  } finally { await f.close(); }
});

async function authorize(f: Awaited<ReturnType<typeof createEmailFixture>>, membershipId: string) {
  return f.db.$transaction(tx => ensureFirstStepTx(tx, membershipId, { kind: "MANUAL", actorId: f.principal.userId,
    requestKey: randomUUID(), requestDigest: randomUUID().replaceAll("-", "").repeat(2), reason: "Start the approved cadence" }, f.now()));
}

test("late resume skips fixed expiry and anchors the next duration to that expiry rather than worker time", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DURATION", seconds: 60 }; definition.steps[0].expiresAfterDueSeconds = 60;
    definition.steps.push({ ...definition.steps[0], id: "next", wait: { kind: "DURATION", seconds: 120 }, expiresAfterDueSeconds: 86400 });
    const published = await f.publishedCampaign({ setup, definition }), item = await f.enrolled({ published, journey: false });
    const first = await authorize(f, item.membership.id);
    await f.campaigns.controls(f.principal, item.campaign.id, { dispatchEnabled: false });
    f.setNow(new Date("2026-10-19T13:00:00Z"));
    const progress = await new CampaignStepService(f.db, { now: f.now }).processOnce();
    assert.equal(progress!.status, "READY"); assert.equal(progress!.dueAt, "2026-10-19T10:04:00.000Z");
    const history = await new CampaignStepService(f.db, { now: f.now }).advance(first.id);
    assert.equal(history.status, "SKIPPED"); assert.equal(history.reason, "STEP_EXPIRED");
    assert.equal(f.requests.filter(request => request.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("a fixed DATE in the past cannot rewind the following delay, and the final skipped step completes the membership", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DATE", at: "2026-10-19T09:00:00Z" }; definition.steps[0].expiresAfterDueSeconds = 60;
    definition.steps.push({ ...definition.steps[0], id: "later", wait: { kind: "DURATION", seconds: 1800 } });
    const item = await f.enrolled({ published: await f.publishedCampaign({ setup, definition }), journey: false });
    await authorize(f, item.membership.id);
    const service = new CampaignStepService(f.db, { now: f.now });
    const next = await service.processOnce();
    assert.equal(next!.dueAt, "2026-10-19T10:30:00.000Z"); assert.equal(next!.status, "WAITING");
    f.setNow(new Date("2026-10-19T12:00:00Z"));
    assert.equal((await service.processOnce())!.status, "SKIPPED");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.status, "COMPLETED");
    assert.equal(await service.processOnce(), null);
  } finally { await f.close(); }
});


async function eventSetup(f: Awaited<ReturnType<typeof createEmailFixture>>, options: { onTimeout?: "SKIP_STEP" | "STOP_MEMBERSHIP"; next?: boolean } = {}) {
  const person = await f.recipient();
  await f.tracking.updateSource(f.principal, person.source.id, { config: { allowedEvents: ["enquiry.accepted", "custom.booking"], propertyKeys: ["approved"] } });
  const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
  definition.steps[0].wait = { kind: "EVENT", sourceId: person.source.id, type: "custom.booking", anchor: "ENROLLED", timeoutSeconds: 60,
    onTimeout: options.onTimeout ?? "SKIP_STEP", condition: { field: { scope: "EVENT", key: "approved" }, type: "boolean", op: "eq", value: true } };
  definition.steps[0].expiresAfterDueSeconds = 3600;
  if (options.next) definition.steps.push({ ...definition.steps[0], id: "follow-up", wait: { kind: "DURATION", seconds: 120 } });
  const item = await f.enrolled({ recipient: person, published: await f.publishedCampaign({ setup, definition }), journey: false });
  const execution = await authorize(f, item.membership.id);
  return { item, execution };
}
async function booking(f: Awaited<ReturnType<typeof createEmailFixture>>, person: Awaited<ReturnType<typeof eventSetup>>["item"],
  options: { properties?: Record<string, unknown>; occurredAt?: Date; subjectExternalId?: string; process?: boolean } = {}) {
  const raw = JSON.stringify({ schemaVersion: 1, type: "custom.booking", occurredAt: (options.occurredAt ?? f.now()).toISOString(),
    resource: { kind: "ENQUIRY", id: options.subjectExternalId ?? person.subjectExternalId }, subjectKind: "SALES",
    contactIdentity: { kind: "CRM_CONTACT", id: person.contactExternalId }, contact: { email: person.contact.email }, properties: options.properties ?? { approved: true } });
  const time = String(f.now().getTime() / 1000), id = randomUUID();
  const accepted = await f.tracking.collectApi(person.source.id, new Headers({ "x-launchpad-id": id, "x-launchpad-timestamp": time,
    "x-launchpad-signature": createHmac("sha256", "email-fixture-api-signing-secret").update(`${time}.${id}.${raw}`).digest("hex") }), raw);
  if (options.process !== false) await f.tracking.processOnce();
  return accepted.receipts[0].id;
}

test("an original LIVE match releases its event wait after replay without resetting immutable availability", async () => {
  const f = await createEmailFixture();
  try {
    const { item, execution } = await eventSetup(f), service = new CampaignStepService(f.db, { now: f.now });
    f.setNow(new Date("2026-10-19T10:00:10Z"));
    const id = await booking(f, item);
    f.setNow(new Date("2026-10-19T10:00:20Z"));
    await f.tracking.replay(f.principal, item.source.id, id); await f.tracking.processOnce();
    const resolved = await service.advance(execution.id);
    assert.equal(resolved.status, "READY"); assert.equal(resolved.dueAt, "2026-10-19T10:00:10.000Z");
    assert.equal(resolved.expiresAt, "2026-10-19T11:00:10.000Z");
    f.setNow(new Date("2026-10-19T10:00:59Z"));
    assert.deepEqual(await service.advance(execution.id), resolved);
  } finally { await f.close(); }
});

test("identity matching at the deadline loses to timeout even when raw receipt and occurrence were earlier", async () => {
  const f = await createEmailFixture();
  try {
    const { item, execution } = await eventSetup(f, { next: true });
    f.setNow(new Date("2026-10-19T10:00:10Z")); await booking(f, item, { process: false });
    f.setNow(new Date("2026-10-19T10:01:00Z")); await f.tracking.processOnce();
    const service = new CampaignStepService(f.db, { now: f.now });
    assert.equal((await service.advance(execution.id)).reason, "EVENT_TIMEOUT");
    const next = await f.db.$transaction(tx => ensureCurrentStepTx(tx, item.membership.id, f.now()));
    assert.equal(next!.dueAt!.toISOString(), "2026-10-19T10:03:00.000Z");
  } finally { await f.close(); }
});

test("UNKNOWN predicates and another enquiry for the same contact do not release a business-subject wait", async () => {
  const f = await createEmailFixture();
  try {
    const { item, execution } = await eventSetup(f), service = new CampaignStepService(f.db, { now: f.now });
    f.setNow(new Date("2026-10-19T10:00:10Z")); await booking(f, item, { properties: {} });
    assert.equal((await service.advance(execution.id)).reason, "EVENT_CONDITION_UNKNOWN");
    f.setNow(new Date("2026-10-19T10:00:20Z")); await booking(f, item, { subjectExternalId: randomUUID() });
    assert.equal((await service.advance(execution.id)).status, "WAITING");
    f.setNow(new Date("2026-10-19T10:01:00Z"));
    const result = await Promise.all([service.advance(execution.id), new CampaignStepService(f.createPeerDb(), { now: f.now }).advance(execution.id)]);
    assert.ok(result.every(item => item.status === "SKIPPED" && item.reason === "EVENT_TIMEOUT"));
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.status, "COMPLETED");
  } finally { await f.close(); }
});

test("an event timeout configured to stop cancels the membership and cannot release its next step", async () => {
  const f = await createEmailFixture();
  try {
    const { item, execution } = await eventSetup(f, { next: true, onTimeout: "STOP_MEMBERSHIP" });
    f.setNow(new Date("2026-10-19T10:02:00Z"));
    const result = await new CampaignStepService(f.db, { now: f.now }).advance(execution.id);
    assert.equal(result.status, "CANCELLED"); assert.equal(result.reason, "EVENT_TIMEOUT_STOP");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.status, "STOPPED");
    assert.equal((await f.db.$transaction(tx => ensureCurrentStepTx(tx, item.membership.id, f.now())))!.id, execution.id);
  } finally { await f.close(); }
});


test("source rotation after EVENT resolution blocks a new intent without replacing its captured evidence", async () => {
  const f = await createEmailFixture();
  try {
    const { item, execution } = await eventSetup(f);
    f.setNow(new Date("2026-10-19T10:00:10Z")); await booking(f, item);
    assert.equal((await new CampaignStepService(f.db, { now: f.now }).advance(execution.id)).status, "READY");
    await f.tracking.updateSource(f.principal, item.source.id, { status: "PAUSED" });
    const intent = await f.delivery.createStepIntent(execution.id);
    assert.equal(intent.kind, "BLOCKED"); assert.ok("code" in intent && intent.code === "WAIT_SOURCE_UNAVAILABLE");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).sends.length, 0);
  } finally { await f.close(); }
});

test("two-step cadence advances from provider acceptance, blocks premature selection and completes after the final acceptance", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps.push({ ...definition.steps[0], id: "reminder", wait: { kind: "DURATION", seconds: 120 } });
    const item = await f.enrolled({ published: await f.publishedCampaign({ setup, definition }), journey: false });
    while (await f.funnels.processOnce()) {}
    await f.campaigns.start(f.principal, item.membership.id, { requestKey: randomUUID(), reason: "Start both reviewed messages" });
    const first = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    assert.equal((await f.delivery.dispatch(f.principal, first.send.id)).outcome, "ACCEPTED");
    const current = await f.campaigns.membership(f.principal, item.membership.id);
    assert.equal(current.membership.status, "ACTIVE"); assert.equal(current.steps.length, 2);
    assert.equal(current.steps[1].dueAt!.toISOString(), "2026-10-19T10:02:00.000Z");
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: item.membership.id }), { code: "STEP_WAITING" });
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: item.membership.id, stepId: current.steps[0].stepId }), { code: "EMAIL_STEP_NOT_CURRENT" });
    f.setNow(new Date("2026-10-19T10:02:00Z"));
    const next = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    assert.notEqual(first.send.id, next.send.id);
    assert.equal((await f.delivery.dispatch(f.principal, next.send.id)).outcome, "ACCEPTED");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.status, "COMPLETED");
    assert.equal(f.requests.filter(request => request.method === "POST").length, 2);
  } finally { await f.close(); }
});

test("explicit start adopts one legacy pending intent; worker execution remains independent of browser session lifetime", async () => {
  const f = await createEmailFixture();
  try {
    const item = await f.enrolled({ journey: false });
    while (await f.funnels.processOnce()) {}
    const old = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    assert.equal(await f.delivery.claimSend(old.send.id), null);
    const started = await f.campaigns.start(f.principal, item.membership.id, { requestKey: randomUUID(), reason: "Schedule the existing request" });
    const adopted = await f.delivery.createStepIntent(started.executionId);
    assert.ok("sendId" in adopted); assert.equal(adopted.sendId, old.send.id); assert.equal(adopted.kind, "EXISTING");
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: item.membership.id }), { code: "UNAUTHENTICATED" });
    const lease = await f.delivery.claimSend(old.send.id); assert.ok(lease);
    assert.equal((await f.delivery.dispatchClaimed(lease)).outcome, "ACCEPTED");
    assert.equal(f.requests.filter(request => request.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("an uncertain first send remains the current step past expiry and cancellation cannot authorize a continuation", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].expiresAfterDueSeconds = 60;
    definition.steps.push({ ...definition.steps[0], id: "never-next", wait: { kind: "IMMEDIATE" } });
    const item = await f.enrolled({ published: await f.publishedCampaign({ setup, definition }), journey: false });
    while (await f.funnels.processOnce()) {}
    const started = await f.campaigns.start(f.principal, item.membership.id, { requestKey: randomUUID(), reason: "Start the reviewed sequence" });
    const intent = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    f.transport.onSend = () => { throw new Error("Fixture loses response"); };
    assert.equal((await f.delivery.dispatch(f.principal, intent.send.id)).outcome, "UNKNOWN");
    f.setNow(new Date("2026-10-19T11:00:00Z"));
    const current = await f.db.$transaction(tx => ensureCurrentStepTx(tx, item.membership.id, f.now()));
    assert.equal(current!.id, started.executionId); assert.equal(current!.status, "SEND_PENDING");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).steps.length, 1);
    await f.campaigns.stop(f.principal, item.membership.id, { reason: "Stop future work" });
    assert.equal((await new CampaignStepService(f.db, { now: f.now }).advance(current!.id)).status, "SEND_PENDING");
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.endedAt, null);
  } finally { await f.close(); }
});

test("event publication verifies scope, source ownership and configured predicate properties", async () => {
  const f = await createEmailFixture();
  try {
    const { item } = await eventSetup(f);
    const other = await f.owner(), foreign = await f.readyConnection(other.principal);
    const definition = structuredClone(item.definition); definition.senderId = foreign.sender.id;
    const crossOwner = await f.campaigns.create(other.principal, { name: "Foreign event", environment: "TEST", definition });
    await assert.rejects(f.campaigns.publish(other.principal, crossOwner.id, { draftRevision: 1 }), { code: "CAMPAIGN_EVENT_SOURCE_UNAVAILABLE" });
    const contact = await f.campaigns.create(f.principal, { name: "Contact event", environment: "TEST", membershipScope: "CONTACT", definition: item.definition });
    await assert.rejects(f.campaigns.publish(f.principal, contact.id, { draftRevision: 1 }), { code: "CAMPAIGN_EVENT_SCOPE_UNSUPPORTED" });
    const unconfigured = structuredClone(item.definition);
    if (unconfigured.steps[0].wait.kind !== "EVENT") throw new Error("Expected EVENT fixture");
    unconfigured.steps[0].wait.condition = { field: { scope: "EVENT", key: "not-configured" }, type: "string", op: "isKnown" };
    const draft = await f.campaigns.create(f.principal, { name: "Missing property", environment: "TEST", definition: unconfigured });
    await assert.rejects(f.campaigns.publish(f.principal, draft.id, { draftRevision: 1 }), { code: "CAMPAIGN_EVENT_PROPERTY_UNAVAILABLE" });
  } finally { await f.close(); }
});

test("retention pins earlier evidence for a future ENROLLED wait until its authorized membership ends", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient();
    await f.tracking.updateSource(f.principal, person.source.id, { config: { allowedEvents: ["enquiry.accepted", "custom.booking"], propertyKeys: ["approved"] } });
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DURATION", seconds: 181 * 86400 }; definition.steps[0].expiresAfterDueSeconds = 1;
    definition.steps.push({ ...definition.steps[0], id: "future-event", expiresAfterDueSeconds: 86400,
      wait: { kind: "EVENT", sourceId: person.source.id, type: "custom.booking", anchor: "ENROLLED", timeoutSeconds: 86400, onTimeout: "SKIP_STEP" } });
    const item = await f.enrolled({ recipient: person, published: await f.publishedCampaign({ setup, definition }), journey: false });
    const started = await f.campaigns.start(f.principal, item.membership.id, { requestKey: randomUUID(), reason: "Start the long approved sequence" });
    f.setNow(new Date("2026-10-19T10:00:10Z"));
    const eventId = await booking(f, item);
    while (await f.funnels.processOnce()) {}
    const evidence = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(evidence.status, "MATCHED");
    f.setNow(new Date(new Date("2026-10-19T10:00:00Z").getTime() + 181 * 86400_000 + 2000));
    assert.ok(evidence.expiresAt < f.now());
    assert.equal(await f.db.campaignStepExecution.count({ where: { membershipId: item.membership.id } }), 1);
    assert.equal((await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: started.executionId } })).status, "WAITING");
    await f.tracking.prune();
    assert.deepEqual((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: eventId } })).envelope, evidence.envelope);
    const resolved = await new CampaignStepService(f.db, { now: f.now }).processOnce();
    assert.equal(resolved!.status, "READY");
    const current = await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: resolved!.executionId } });
    assert.equal(current.eventId, eventId); assert.equal(current.evidenceAvailableAt!.toISOString(), "2026-10-19T10:00:10.000Z");
    await f.campaigns.stop(f.principal, item.membership.id, { reason: "End this sequence" });
    assert.ok((await f.campaigns.membership(f.principal, item.membership.id)).membership.endedAt);
    await f.tracking.prune();
    const redacted = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(redacted.status, "REDACTED"); assert.deepEqual(redacted.envelope, {});
    assert.equal(redacted.rawPayloadDigest, evidence.rawPayloadDigest, "Dedupe evidence survives payload retention");
  } finally { await f.close(); }
});
