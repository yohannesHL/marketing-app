import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { StageActionService } from "../../apps/web/src/server/funnels/stageActionService";
import { CampaignStepService } from "../../apps/web/src/server/email/campaignStepService";
import { AutomationRunner } from "../../apps/web/src/server/email/automationRunner";
import { checkEmailEligibility } from "../../apps/web/src/server/email/emailPolicy";
import { createEmailApi } from "../../apps/web/src/server/email/emailApi";
import { createFunnelApi } from "../../apps/web/src/server/funnels/funnelApi";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";
import { SecurityError } from "../../apps/web/src/server/security/errors";

async function scenario(f: EmailFixture, options: { delaySeconds?: number; adjacent?: boolean; membershipScope?: "CONTACT" | "SUBJECT"; waitSeconds?: number; stopCondition?: boolean } = {}) {
  const secret = "automation-fixture-signing-secret", externalId = randomUUID();
  const source = (await f.tracking.createSource(f.principal, { name: "Bookings", provider: "API", environment: "TEST", externalAccountId: randomUUID(),
    credentials: { signingSecret: secret }, config: { allowedEvents: ["custom.identity.created", "custom.lead.created", "custom.lead.engaged", "custom.booking.confirmed"], propertyKeys: ["booked"] } })).source;
  const setup = await f.readyConnection(), draft = f.definition(setup.sender.id);
  if (options.waitSeconds) draft.steps[0].wait = { kind: "DURATION", seconds: options.waitSeconds };
  const published = await f.publishedCampaign({ setup, definition: draft, membershipScope: options.membershipScope });
  const action = (id: string, stageId: string) => ({ id, stageId, kind: "EMAIL_ENROLL" as const, campaignId: published.campaign.id,
    revisionId: published.revision.id, delaySeconds: options.delaySeconds ?? 0, expiresAfterDueSeconds: 3600, stopOnStageExit: true, stopOnGoal: true });
  const route = (id: string, from: string | null, type: string, to: string) => ({ id, from, trigger: { kind: "EVENT" as const, sourceId: source.id, type }, branches: [], fallback: { kind: "MOVE" as const, to } });
  const definition: FunnelDefinition = { schemaVersion: 1, stages: [
    { id: "lead", name: "Interested", goal: false, terminal: "NONE" }, { id: "engaged", name: "Engaged", goal: false, terminal: "NONE" },
    { id: "booked", name: "Booked", goal: true, terminal: "SUCCESS" }], entryStages: ["lead"],
    routes: [route("entry", null, "custom.lead.created", "lead"), route("engage", "lead", "custom.lead.engaged", "engaged"),
      route("book-lead", "lead", "custom.booking.confirmed", "booked"), route("book-engaged", "engaged", "custom.booking.confirmed", "booked")],
    stageActions: [action("nurture", "lead"), ...(options.adjacent ? [action("continue-nurture", "engaged")] : [])] };
  if (options.stopCondition) for (const route of definition.routes.filter(route => route.id.startsWith("book-"))) {
    route.branches = [{ id: "confirmed", to: "booked", when: { field: { scope: "EVENT" as const, key: "booked" }, type: "boolean" as const, op: "eq" as const, value: true } }];
    route.fallback = { kind: "WAIT" as const };
  }
  const funnel = await f.funnels.create(f.principal, { name: "Booking funnel", environment: "TEST", subjectKind: "SALES", definition });
  await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
  await f.funnels.controls(f.principal, funnel.id, { automationEnrolmentEnabled: true, automationDispatchEnabled: true });
  async function emit(type: string, evaluate = true, properties: Record<string, string | boolean> = {}, occurredAt?: Date) {
    f.setNow(new Date(f.now().getTime() + 1000));
    const raw = JSON.stringify({ schemaVersion: 1, type, occurredAt: (occurredAt ?? f.now()).toISOString(), resource: { kind: "ENQUIRY", id: externalId }, subjectKind: "SALES",
      contactIdentity: { kind: "CRM_CONTACT", id: externalId }, contact: { email: "maya@example.test" }, properties });
    const time = String(f.now().getTime() / 1000), id = randomUUID();
    const result = await f.tracking.collectApi(source.id, new Headers({ "x-launchpad-id": id, "x-launchpad-timestamp": time,
      "x-launchpad-signature": createHmac("sha256", secret).update(`${time}.${id}.${raw}`).digest("hex") }), raw);
    while (await f.tracking.processOnce()) { /* Drain only local matching. */ }
    if (evaluate) while (await f.funnels.processOnce()) { /* Drain local routing. */ }
    return f.db.trackingEvent.findUniqueOrThrow({ where: { id: result.receipts[0].id } });
  }
  const identity = await emit("custom.identity.created"); await f.consent(identity.contactId!);
  const actions = new StageActionService(f.db, { now: f.now }), steps = new CampaignStepService(f.db, { now: f.now });
  const runner = new AutomationRunner(f.db, { delivery: f.delivery, connections: f.connections, funnels: f.funnels }, { now: f.now });
  return { ...published, source, definition, funnel, emit, identity, actions, steps, runner };
}

test("live stage actions create one authorized cadence and parallel consumers cannot duplicate a send", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f); await s.emit("custom.lead.created");
    const peer = new StageActionService(f.createPeerDb(), { now: f.now });
    await Promise.all([s.actions.processOnce(), peer.processOnce()]);
    assert.equal(await f.db.campaignMembership.count(), 1); assert.equal(await f.db.campaignStepExecution.count(), 1);
    assert.equal(await f.db.funnelActionExecution.count({ where: { status: "APPLIED" } }), 1);
    await s.runner.processOnce(); await s.runner.processOnce();
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    assert.equal((await f.db.campaignMembership.findFirstOrThrow()).status, "COMPLETED");
  } finally { await f.close(); }
});

test("booking matching backlog blocks the local dispatch fence and stage exit cancels before HTTP", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f); await s.emit("custom.lead.created"); await s.actions.processOnce(); await s.steps.processOnce();
    const execution = await f.db.campaignStepExecution.findFirstOrThrow();
    const intent = await f.delivery.createStepIntent(execution.id); assert.ok("sendId" in intent);
    await s.emit("custom.booking.confirmed", false);
    const fence = await f.db.$transaction(tx => checkEmailEligibility(tx, { membershipId: execution.membershipId, purpose: "DISPATCH", liveEnabled: false, now: f.now() }));
    assert.deepEqual(fence, { eligible: false, code: "TRACKING_EVALUATION_PENDING" });
    const lease = await f.delivery.claimSend(intent.sendId); assert.ok(lease);
    await f.delivery.dispatchClaimed(lease); assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    await f.funnels.processOnce(); await s.actions.processOnce();
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.sendId } })).status, "CANCELLED");
    assert.equal((await f.db.campaignMembership.findFirstOrThrow()).status, "STOPPED");
  } finally { await f.close(); }
});

test("adjacent immediate stages replace reasons atomically and keep pinned cadence even with queued transitions", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { adjacent: true, waitSeconds: 300 }); await s.emit("custom.lead.created"); await s.actions.processOnce();
    const membership = await f.db.campaignMembership.findFirstOrThrow(), execution = await f.db.campaignStepExecution.findFirstOrThrow();
    await s.emit("custom.lead.engaged"); await s.actions.processOnce();
    const after = await f.db.campaignMembership.findUniqueOrThrow({ where: { id: membership.id } });
    assert.equal(after.status, "ACTIVE"); assert.equal(after.cycle, 1); assert.equal(after.revisionId, membership.revisionId);
    assert.equal(await f.db.campaignMembership.count(), 1); assert.equal(await f.db.campaignStepExecution.count(), 1);
    assert.equal((await f.db.campaignStepExecution.findFirstOrThrow()).dueAt?.getTime(), execution.dueAt?.getTime());
    const reasons = await f.db.campaignMembershipReason.findMany({ orderBy: { createdAt: "asc" } });
    assert.equal(reasons[0].endReason, "STAGE_EXITED"); assert.equal(reasons[1].endedAt, null);
  } finally { await f.close(); }
});

test("dispatch pause preserves shared reasons and duration clocks; unsubscribing during a delay cancels the cadence", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { waitSeconds: 120 }); await s.emit("custom.lead.created"); await s.actions.processOnce();
    const execution = await f.db.campaignStepExecution.findFirstOrThrow();
    await f.funnels.controls(f.principal, s.funnel.id, { automationDispatchEnabled: false });
    f.setNow(new Date(f.now().getTime() + 120_000)); await s.runner.processOnce();
    assert.equal((await f.db.campaignMembershipReason.findFirstOrThrow()).endedAt, null);
    assert.equal((await f.db.campaignStepExecution.findFirstOrThrow()).dueAt?.getTime(), execution.dueAt?.getTime());
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    await f.campaigns.updatePolicy(f.principal, { contactId: s.identity.contactId, category: "consultation", action: "OPT_OUT", reason: "Recipient opted out", requestKey: randomUUID(),
      provenance: { source: "preference-centre", purpose: "consultation", observedAt: f.now().toISOString() } });
    await f.funnels.controls(f.principal, s.funnel.id, { automationDispatchEnabled: true }); await s.runner.processOnce();
    assert.equal((await f.db.campaignStepExecution.findFirstOrThrow()).status, "CANCELLED");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("a manual reason survives a journey cancellation and adding a stage reason cannot start legacy cadence", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f); const manual = await f.campaigns.enrol(f.principal, s.campaign.id, { subjectId: s.identity.subjectId, requestKey: randomUUID(), reason: "Manual association" });
    await s.emit("custom.lead.created"); await s.actions.processOnce();
    assert.equal(await f.db.campaignStepExecution.count(), 0);
    assert.equal((await f.db.funnelActionExecution.findFirstOrThrow()).reason, "MANUAL_CADENCE_REQUIRES_START");
    const journey = await f.db.funnelJourney.findFirstOrThrow({ where: { funnelId: s.funnel.id } });
    await f.funnels.cancelJourney(f.principal, s.funnel.id, journey.id, { reason: "Customer cancelled this enquiry" });
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: manual.membership.id } })).status, "ACTIVE");
    assert.equal((await f.db.campaignMembershipReason.findUniqueOrThrow({ where: { id: manual.reason.id } })).endedAt, null);
    await f.campaigns.start(f.principal, manual.membership.id, { requestKey: randomUUID(), reason: "Explicitly start follow-up" });
    await s.runner.processOnce(); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("entry while enrollment is paused stays future-only and delayed replacement cannot restart a stopped cycle", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { adjacent: true, delaySeconds: 60 });
    await f.funnels.controls(f.principal, s.funnel.id, { automationEnrolmentEnabled: false }); await s.emit("custom.lead.created");
    await f.funnels.controls(f.principal, s.funnel.id, { automationEnrolmentEnabled: true }); await s.actions.processOnce();
    assert.equal(await f.db.campaignMembership.count(), 0);
    await s.emit("custom.lead.engaged"); await s.actions.processOnce();
    const action = await f.db.funnelActionExecution.findFirstOrThrow(); assert.equal(action.status, "PENDING");
    await s.emit("custom.booking.confirmed"); await s.actions.processOnce();
    f.setNow(action.dueAt); await s.actions.processOnce();
    assert.equal((await f.db.funnelActionExecution.findUniqueOrThrow({ where: { id: action.id } })).status, "CANCELLED");
    assert.equal(await f.db.campaignMembership.count(), 0);
  } finally { await f.close(); }
});

test("deletion redacts automation history while preserving already consumed outbox completion", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { waitSeconds: 120 }); await s.emit("custom.lead.created"); await s.actions.processOnce();
    const outbox = await f.db.funnelActionOutbox.findFirstOrThrow({ where: { effectEligibility: "AUTOMATION" } });
    f.setNow(new Date(f.now().getTime() + 1000)); await f.tracking.deleteContact(f.principal, s.identity.contactId!);
    const erased = await f.db.funnelActionOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    assert.equal(erased.completedAt?.getTime(), outbox.completedAt?.getTime()); assert.deepEqual(erased.payload, {});
    assert.ok((await f.db.campaignStepExecution.findFirstOrThrow()).redactedAt);
    await s.runner.processOnce(); assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("explicit start is owner/session/origin protected and command replay retains one durable authorization", async () => {
  const f = await createEmailFixture();
  try {
    const e = await f.enrolled(), api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), key = randomUUID();
    const command = { requestKey: key, reason: "Run this sequence" }, path = `https://launchpad.test/api/email/memberships/${e.membership.id}/start`;
    assert.equal((await api(new Request(path, { method: "POST", headers: { cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify(command) }))).status, 403);
    const first = await f.campaigns.start(f.principal, e.membership.id, command);
    assert.equal((await f.campaigns.start(f.principal, e.membership.id, command)).executionId, first.executionId);
    await assert.rejects(() => f.campaigns.start(f.principal, e.membership.id, { ...command, reason: "Changed intent" }), (error: unknown) => error instanceof SecurityError && error.code === "IDEMPOTENCY_CONFLICT");
    const stranger = await f.owner(); await assert.rejects(() => f.campaigns.start(stranger.principal, e.membership.id, command), (error: unknown) => error instanceof SecurityError && error.code === "NOT_FOUND");
    const funnelsApi = createFunnelApi(f.auth, f.funnels);
    assert.equal((await funnelsApi(new Request(`https://launchpad.test/api/funnels/${e.funnel!.id}/controls`, { method: "PATCH", headers: { cookie: f.cookie }, body: JSON.stringify({ automationDispatchEnabled: true }) }))).status, 403);
  } finally { await f.close(); }
});

test("unknown booking conditions hold dispatch until newer definitive evidence or an audited correction", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { stopCondition: true }); await s.emit("custom.lead.created"); await s.actions.processOnce(); await s.steps.processOnce();
    const membership = await f.db.campaignMembership.findFirstOrThrow();
    const eligibility = () => f.db.$transaction(tx => checkEmailEligibility(tx, { membershipId: membership.id, purpose: "DISPATCH", liveEnabled: false, now: f.now() }));
    const unknown = await s.emit("custom.booking.confirmed", true, { booked: "unavailable" });
    assert.equal(await f.db.funnelEvaluationReceipt.count({ where: { status: "PENDING" } }), 0);
    assert.deepEqual(await eligibility(), { eligible: false, code: "STOP_CONDITION_UNKNOWN" });
    await s.emit("custom.booking.confirmed", true, { booked: false }, new Date(unknown.occurredAt.getTime() - 1000));
    assert.deepEqual(await eligibility(), { eligible: false, code: "STOP_CONDITION_UNKNOWN" });
    await s.emit("custom.booking.confirmed", true, { booked: false }); assert.equal((await eligibility()).eligible, true);
    await s.emit("custom.booking.confirmed", true, { booked: "unavailable" });
    assert.deepEqual(await eligibility(), { eligible: false, code: "STOP_CONDITION_UNKNOWN" });
    await f.funnels.move(f.principal, s.funnel.id, { subjectId: s.identity.subjectId, stageId: "lead", reason: "Reviewed booking record: not booked", commandKey: randomUUID() });
    assert.equal((await eligibility()).eligible, true);
  } finally { await f.close(); }
});

test("CONTACT-scoped stage membership still waits for its associated booking evaluation", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { membershipScope: "CONTACT" }); await s.emit("custom.lead.created"); await s.actions.processOnce(); await s.steps.processOnce();
    const membership = await f.db.campaignMembership.findFirstOrThrow(); assert.equal(membership.subjectId, null);
    await s.emit("custom.booking.confirmed", false);
    const result = await f.db.$transaction(tx => checkEmailEligibility(tx, { membershipId: membership.id, purpose: "DISPATCH", liveEnabled: false, now: f.now() }));
    assert.deepEqual(result, { eligible: false, code: "TRACKING_EVALUATION_PENDING" });
    await s.runner.processOnce(); assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    assert.equal((await f.db.campaignMembership.findFirstOrThrow()).status, "STOPPED");
  } finally { await f.close(); }
});

test("a delayed stage replacement cannot silently create a new cycle after its last reason ends", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { adjacent: true, delaySeconds: 60, waitSeconds: 300 }); await s.emit("custom.lead.created"); await s.actions.processOnce();
    f.setNow((await f.db.funnelActionExecution.findFirstOrThrow()).dueAt); await s.actions.processOnce();
    const member = await f.db.campaignMembership.findFirstOrThrow();
    await s.emit("custom.lead.engaged"); await s.actions.processOnce();
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: member.id } })).status, "STOPPED");
    const delayed = await f.db.funnelActionExecution.findFirstOrThrow({ where: { status: "PENDING" } });
    f.setNow(delayed.dueAt); await s.actions.processOnce();
    assert.equal((await f.db.funnelActionExecution.findUniqueOrThrow({ where: { id: delayed.id } })).reason, "FINISHED_MEMBERSHIP_REQUIRES_NEW_CYCLE");
    assert.equal(await f.db.campaignMembership.count(), 1);
  } finally { await f.close(); }
});

test("accumulated adjacent entry envelopes create only the current stage's one cadence", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f, { adjacent: true }); await s.emit("custom.lead.created"); await s.emit("custom.lead.engaged");
    await s.actions.processOnce();
    const actions = await f.db.funnelActionExecution.findMany({ orderBy: { dueAt: "asc" } });
    assert.deepEqual(actions.map(action => action.status), ["CANCELLED", "APPLIED"]);
    assert.equal(await f.db.campaignMembership.count(), 1); assert.equal(await f.db.campaignStepExecution.count(), 1);
    await s.runner.processOnce(); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("a queued negative provider callback fences sends even behind an unrelated receipt", async () => {
  const f = await createEmailFixture();
  try {
    const s = await scenario(f); await s.emit("custom.lead.created"); await s.actions.processOnce(); await s.steps.processOnce();
    const execution = await f.db.campaignStepExecution.findFirstOrThrow(), intent = await f.delivery.createStepIntent(execution.id);
    assert.ok("sendId" in intent);
    const older = f.signWebhook({ type: "email.delivered", created_at: f.now().toISOString(), data: { email_id: randomUUID(), from: "hello@example.test", to: ["unrelated@example.test"], subject: "Unrelated" } });
    await f.delivery.ingestWebhook(s.setup.ingressToken, older.headers, older.rawBody);
    f.setNow(new Date(f.now().getTime() + 1000));
    const negative = f.signWebhook({ type: "suppression.added", created_at: f.now().toISOString(), data: { email: "maya@example.test", origin: "manual", source_id: null } });
    await f.delivery.ingestWebhook(s.setup.ingressToken, negative.headers, negative.rawBody);
    assert.equal((await f.delivery.processOnce())?.status, "UNMATCHED");
    const blocked = await f.db.$transaction(tx => checkEmailEligibility(tx, { membershipId: execution.membershipId, purpose: "DISPATCH", now: f.now(), liveEnabled: false }));
    assert.deepEqual(blocked, { eligible: false, code: "EMAIL_POLICY_EVIDENCE_PENDING" });
    const lease = await f.delivery.claimSend(intent.sendId); assert.ok(lease); await f.delivery.dispatchClaimed(lease);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    await f.delivery.processOnce();
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.sendId } })).status, "CANCELLED");
  } finally { await f.close(); }
});
