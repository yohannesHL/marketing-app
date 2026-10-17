import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { StageActionService } from "../../apps/web/src/server/funnels/stageActionService";
import { FunnelReportingService } from "../../apps/web/src/server/funnels/funnelReportingService";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const secret = "subscription-bridge-fixture-signing-secret", active = "custom.fluxsoft.subscription_active";
const renewal = "custom.fluxsoft.invoice_paid", cancelled = "custom.fluxsoft.subscription_cancelled";
async function source(f: EmailFixture, p = f.principal, environment = "TEST") {
  const tracking = environment === "LIVE" ? new TrackingService(f.db, f.auth, f.vault, f.now, true) : f.tracking;
  return (await tracking.createSource(p, { name: "Fluxsoft bridge", provider: "API", environment, externalAccountId: randomUUID(), credentials: { signingSecret: secret },
    config: { allowedEvents: [active, renewal, cancelled, "custom.fluxsoft.observed"], propertyKeys: ["accountId", "workspaceId", "invoiceId", "plan", "status"] } })).source;
}
function payload(f: EmailFixture, id: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, type: active, occurredAt: f.now().toISOString(), subjectKind: "SUBSCRIPTION", resource: { kind: "SUBSCRIPTION", id },
    properties: { accountId: "account-shared", workspaceId: "workspace-shared", plan: "starter" }, ...extra };
}
const person = { contactIdentity: { kind: "FLUXSOFT_CUSTOMER", id: "customer-shared" }, contact: { email: "maya@example.test", name: "Maya" } };
function headers(f: EmailFixture, raw: string, id: string) {
  const seconds = String(Math.floor(f.now().getTime() / 1000));
  return { "content-type": "application/json", "x-launchpad-id": id, "x-launchpad-timestamp": seconds,
    "x-launchpad-signature": createHmac("sha256", secret).update(`${seconds}.${id}.${raw}`).digest("hex") };
}
async function post(f: EmailFixture, sourceId: string, input: unknown, id = randomUUID()) {
  const raw = JSON.stringify(input);
  return createTrackingApi(f.auth, f.tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${sourceId}/events`, { method: "POST", headers: headers(f, raw, id), body: raw }));
}
async function queued(f: EmailFixture, sourceId: string, input: unknown, id?: string) {
  const response = await post(f, sourceId, input, id); assert.equal(response.status, 202, await response.clone().text());
  return (await response.json()).receipts[0].id as string;
}
async function drain(f: EmailFixture) {
  for (let n = 0; n < 50; n++) { if (!await f.tracking.processOnce()) break; if (n === 49) throw new Error("Matcher did not drain"); }
  for (let n = 0; n < 50; n++) { if (!await f.funnels.processOnce()) break; if (n === 49) throw new Error("Evaluator did not drain"); }
}
async function event(f: EmailFixture, sourceId: string, input: unknown, id?: string) {
  const accepted = await queued(f, sourceId, input, id); await drain(f); return f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted } });
}
const tick = (f: EmailFixture) => f.setNow(new Date(f.now().getTime() + 1000));
function definition(sourceId: string, entry = "activated"): FunnelDefinition {
  const route = (id: string, from: string | null, type: string, to: string) => ({ id, from, trigger: { kind: "EVENT" as const, sourceId, type }, branches: [{ id: `${id}-yes`, to }], fallback: { kind: "WAIT" as const } });
  return { schemaVersion: 1, stages: [{ id: "lead", name: "Trial", goal: false, terminal: "NONE" }, { id: "activated", name: "Activated", goal: true, terminal: "NONE" },
    { id: "duplicate", name: "Would repeat acquisition", goal: true, terminal: "NONE" }, { id: "cancelled", name: "Cancelled", goal: false, terminal: "FAILURE" }],
    entryStages: [entry], routes: [route("activation", entry === "activated" ? null : "lead", active, "activated"), route("repeat", "activated", active, "duplicate"), route("cancel", "activated", cancelled, "cancelled")] };
}
async function publish(f: EmailFixture, def: FunnelDefinition) {
  const funnel = await f.funnels.create(f.principal, { name: "Subscriptions", environment: "TEST", subjectKind: "SUBSCRIPTION", definition: def });
  const { version } = await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 }); return { funnel, version };
}

test("signed subscription references keep two subscriptions independent for one customer and account context", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), a = await event(f, s.id, payload(f, "subscription-a", person)), b = await event(f, s.id, payload(f, "subscription-b", person));
    assert.equal(a.status, "MATCHED"); assert.equal(a.contactId, b.contactId); assert.notEqual(a.subjectId, b.subjectId);
    assert.equal(await f.db.funnelContact.count(), 1); assert.equal(await f.db.funnelSubject.count({ where: { kind: "SUBSCRIPTION" } }), 2);
    assert.equal((a.envelope as any).authority, "SERVER_ASSERTED"); assert.equal((a.envelope as any).factKey, active);
    const anonymous = await event(f, s.id, payload(f, "subscription-anonymous")); assert.equal(anonymous.contactId, null); assert.ok(anonymous.subjectId);
    const other = await f.owner(), theirs = await source(f, other.principal), isolated = await event(f, theirs.id, payload(f, "subscription-a", person));
    assert.notEqual(isolated.subjectId, a.subjectId); assert.notEqual(isolated.contactId, a.contactId);
    assert.equal((await f.tracking.subjects(f.principal, "TEST")).length, 3);
    for (const kind of ["CONTACT", "CUSTOMER", "ACCOUNT", "WORKSPACE", "INVOICE", "ORDER"])
      assert.equal((await post(f, s.id, payload(f, "bad", { references: [{ kind, id: "shared" }] }))).status, 400);
    for (const extra of [{ factKey: "chosen" }, { ownerId: "other" }, { authority: "PROVIDER_VERIFIED" }, { subjectKind: "PURCHASE", resource: { kind: "ORDER", id: "bad" } }])
      assert.equal((await post(f, s.id, payload(f, "bad", extra))).status, 400);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("first activation has one canonical fact, journey and stage intent across deliveries, renewals and replay", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), { funnel, version } = await publish(f, definition(s.id)); tick(f);
    const firstBody = payload(f, "subscription-a", person), first = await event(f, s.id, firstBody, "same-delivery-key");
    assert.equal(await queued(f, s.id, firstBody, "same-delivery-key"), first.id);
    tick(f); const repeated = await event(f, s.id, payload(f, "subscription-a", person));
    assert.equal(repeated.factId, first.factId); assert.equal(await f.db.trackingFact.count(), 1);
    let journey = await f.db.funnelJourney.findFirstOrThrow({ where: { subjectId: first.subjectId! } });
    assert.equal(journey.currentStageKey, "activated"); assert.equal(await f.db.funnelStageTransition.count(), 1); assert.equal(await f.db.funnelActionOutbox.count(), 1);
    for (const invoiceId of ["invoice-a", "invoice-b"]) { tick(f); await event(f, s.id, payload(f, "subscription-a", { type: renewal, properties: { invoiceId, workspaceId: "workspace-shared" } })); }
    await f.tracking.replay(f.principal, s.id, first.id); await drain(f);
    assert.equal(await f.db.funnelJourney.count(), 1); assert.equal(await f.db.funnelStageTransition.count(), 1); assert.equal(await f.db.funnelActionOutbox.count(), 1);
    tick(f); await event(f, s.id, payload(f, "subscription-b", person));
    tick(f); const report = await new FunnelReportingService(f.db, f.auth, f.now).report(f.principal, funnel.id, { versionId: version.id, from: "2026-10-19T10:00:00Z", to: f.now().toISOString() });
    assert.equal(report.funnel.subjectKind, "SUBSCRIPTION"); assert.equal(report.totals.journeys, 2); assert.equal(report.totals.distinctSubjects, 2); assert.equal(report.totals.goalJourneys, 2);
    assert.equal(report.money.includedFacts, 0); assert.deepEqual(report.money.currencies, []);
    const board = await f.funnels.journeys(f.principal, funnel.id, undefined, { versionId: version.id }); assert.equal(board.total, 2); assert.equal(board.journeys[0].subject.kind, "SUBSCRIPTION");
    tick(f); await event(f, s.id, payload(f, "subscription-a", { type: cancelled }));
    tick(f); await event(f, s.id, payload(f, "subscription-a", { type: renewal, properties: { invoiceId: "invoice-c" } }));
    journey = await f.db.funnelJourney.findUniqueOrThrow({ where: { id: journey.id } }); assert.equal(journey.status, "FAILED"); assert.equal(journey.cycle, 1);
    assert.equal(await f.db.funnelJourney.count({ where: { subjectId: first.subjectId! } }), 1); assert.equal(await f.db.messageSend.count(), 0); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("qualified subscription handoffs preserve one canonical ID per source and manual matches cannot collapse another subscription", async () => {
  const f = await createEmailFixture(); try {
    const original = await source(f), bridge = await source(f);
    const a = await event(f, original.id, payload(f, "origin-a", person)), b = await event(f, original.id, payload(f, "origin-b", person));
    const ref = (id: string) => ({ sourceId: original.id, kind: "SUBSCRIPTION", id });
    const linked = await event(f, bridge.id, payload(f, "bridge-a", { ...person, references: [ref("origin-a")] }));
    assert.equal(linked.subjectId, a.subjectId); assert.equal(linked.factId, a.factId);
    assert.equal((linked.envelope as any).references[0].sourceGeneration, 1);
    const collision = await event(f, bridge.id, payload(f, "bridge-a2", { ...person, references: [ref("origin-a")] }));
    assert.equal(collision.status, "UNMATCHED"); assert.equal(collision.reason, "SUBSCRIPTION_REFERENCE_CONFLICT");
    assert.equal(await f.db.funnelSubjectReference.count({ where: { externalId: "bridge-a2" } }), 0);
    const conflict = await event(f, bridge.id, payload(f, "ambiguous", { references: [ref("origin-a"), ref("origin-b")] }));
    assert.equal(conflict.status, "UNMATCHED");
    await f.tracking.match(f.principal, bridge.id, conflict.id, { subjectId: a.subjectId, reason: "Attempted manual choice" }); await drain(f);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: conflict.id } })).reason, "SUBSCRIPTION_REFERENCE_CONFLICT");
    const another = await event(f, bridge.id, payload(f, "bridge-b", { references: [ref("origin-b")] })); assert.equal(another.subjectId, b.subjectId);
    const unbound = await event(f, bridge.id, payload(f, "cannot-bind", { references: [ref("origin-a"), { sourceId: original.id, kind: "SUBSCRIPTION", id: "new-origin" }] }));
    assert.equal(unbound.status, "UNMATCHED");
    await f.tracking.match(f.principal, bridge.id, unbound.id, { subjectId: b.subjectId, reason: "Wrong existing subscription" }); await drain(f);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: unbound.id } })).status, "UNMATCHED");
    assert.equal(await f.db.funnelSubjectReference.count({ where: { externalId: { in: ["cannot-bind", "new-origin", "ambiguous"] } } }), 0);
    assert.equal(await f.db.trackingFact.count(), 2);
  } finally { await f.close(); }
});

test("subscription handoffs keep owner, environment and accepted source-generation fences", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), target = await source(f), other = await f.owner(), foreign = await source(f, other.principal), live = await source(f, f.principal, "LIVE");
    for (const targetId of [foreign.id, live.id, "missing"]) assert.equal((await post(f, s.id, payload(f, "bad", { references: [{ sourceId: targetId, kind: "SUBSCRIPTION", id: "a" }] }))).status, 400);
    const body = payload(f, "pending", { references: [{ sourceId: target.id, kind: "SUBSCRIPTION", id: "target-a" }] }), id = await queued(f, s.id, body);
    await f.tracking.updateSource(f.principal, target.id, { credentials: { signingSecret: "new-subscription-source-secret" } }); await drain(f);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id } })).reason, "REFERENCE_SOURCE_CHANGED");
    await f.tracking.replay(f.principal, s.id, id); await drain(f);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id } })).status, "BLOCKED");
    assert.equal(await f.db.funnelSubject.count(), 0); assert.equal(await f.db.funnelIdentity.count(), 0);
  } finally { await f.close(); }
});

test("deleting a shared contact redacts pending qualified subscription evidence and leaves replay tombstones", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), bridge = await source(f), { funnel } = await publish(f, definition(s.id)); tick(f);
    const a = await event(f, s.id, payload(f, "subscription-a", person)); tick(f); const b = await event(f, s.id, payload(f, "subscription-b", person));
    const pending = await queued(f, bridge.id, payload(f, "bridge-a", { references: [{ sourceId: s.id, kind: "SUBSCRIPTION", id: "subscription-a" }] }));
    await f.tracking.deleteContact(f.principal, a.contactId!);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: pending } })).status, "REDACTED");
    assert.equal(await f.db.funnelSubjectReference.count(), 0); assert.equal(await f.db.funnelIdentity.count(), 0);
    assert.equal(await f.db.funnelJourney.count({ where: { funnelId: funnel.id, status: "CANCELLED" } }), 2);
    for (const id of ["subscription-a", "subscription-b"]) { const replay = await event(f, s.id, payload(f, id)); assert.equal(replay.status, "REDACTED"); assert.equal(replay.reason, "DELETED_SUBJECT"); }
    await assert.rejects(f.tracking.replay(f.principal, s.id, a.id), { code: "REPLAY_UNAVAILABLE" });
    assert.deepEqual((await f.db.trackingFact.findUniqueOrThrow({ where: { id: a.factId! } })).attributes, {});
    assert.equal(await f.db.funnelSubject.count(), 2); assert.equal(await f.db.trackingFact.count(), 2);
    const board = await f.funnels.journeys(f.principal, funnel.id); assert.ok(board.journeys.every(j => j.subject.contact === null)); assert.equal(a.contactId, b.contactId);
  } finally { await f.close(); }
});

test("signed BACKFILL is an immutable downgrade and imports never create new acquisition journeys", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), { funnel } = await publish(f, definition(s.id)); tick(f);
    const body = payload(f, "historical", { ingestionMode: "BACKFILL" }), first = await event(f, s.id, body, "backfill-request-key");
    assert.equal(first.ingestionMode, "BACKFILL"); assert.equal(first.processingMode, "BACKFILL"); assert.equal(first.status, "MATCHED");
    assert.equal((await f.db.funnelEvaluationReceipt.findFirstOrThrow({ where: { eventId: first.id } })).mode, "BACKFILL");
    assert.equal((await f.db.funnelEvidenceEffect.findFirstOrThrow({ where: { funnelId: funnel.id } })).outcome, "HISTORY_ONLY_NO_ENTRY");
    const { ingestionMode: _mode, ...upgrade } = body;
    assert.equal((await post(f, s.id, upgrade, "backfill-request-key")).status, 409);
    const persisted = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: first.id } }); assert.equal(persisted.ingestionMode, "BACKFILL"); assert.equal(persisted.conflictCount, 1);
    tick(f); await event(f, s.id, payload(f, "historical")); // A new delivery cannot turn a known old activation into a new acquisition.
    assert.equal(await f.db.funnelJourney.count(), 0); assert.equal(await f.db.funnelActionOutbox.count(), 0); assert.equal(await f.db.messageSend.count(), 0);
    for (const ingestionMode of ["LIVE", "REPLAY", "UNKNOWN", null, false]) assert.equal((await post(f, s.id, payload(f, "bad", { ingestionMode }))).status, 400);
    const raw = JSON.stringify(body), altered = JSON.stringify(upgrade);
    const response = await createTrackingApi(f.auth, f.tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${s.id}/events`, { method: "POST", headers: headers(f, raw, "signed-original-body"), body: altered }));
    assert.equal(response.status, 401);
    const native = (await f.tracking.createSource(f.principal, { name: "Forms", provider: "NATIVE", environment: "TEST", externalAccountId: "website", config: { allowedOrigins: ["https://business.example.test"] } })).source;
    await assert.rejects(f.tracking.collectNative(native.id, "https://business.example.test", JSON.stringify({ schemaVersion: 1, eventId: "browser", type: "page.viewed", ingestionMode: "BACKFILL" }), false), { code: "INVALID_TRACKING_INPUT" });
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("BACKFILL can correct an existing subscription path but its stage intent cannot authorize email enrollment", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), campaign = await f.publishedCampaign(), def = definition(s.id, "lead");
    def.stageActions = [{ id: "welcome", stageId: "activated", kind: "EMAIL_ENROLL", campaignId: campaign.campaign.id, revisionId: campaign.revision.id, delaySeconds: 0,
      expiresAfterDueSeconds: 3600, stopOnStageExit: true, stopOnGoal: false }];
    const { funnel } = await publish(f, def); await f.funnels.controls(f.principal, funnel.id, { automationEnrolmentEnabled: true, automationDispatchEnabled: true });
    tick(f); const observed = await event(f, s.id, payload(f, "existing-trial", { ...person, type: "custom.fluxsoft.observed" }));
    await f.funnels.move(f.principal, funnel.id, { subjectId: observed.subjectId, stageId: "lead", reason: "Existing trial recorded", commandKey: randomUUID() });
    const requests = f.requests.length; tick(f); const activation = await event(f, s.id, payload(f, "existing-trial", { ...person, ingestionMode: "BACKFILL" }));
    const transition = await f.db.funnelStageTransition.findFirstOrThrow({ where: { eventId: activation.id } });
    assert.equal(transition.toStageKey, "activated"); assert.equal(transition.mode, "BACKFILL");
    const outbox = await f.db.funnelActionOutbox.findUniqueOrThrow({ where: { transitionId_kind_actionKey: { transitionId: transition.id, kind: "STAGE_ENTERED", actionKey: "stage-entry" } } });
    assert.equal(outbox.effectEligibility, "CANCELLATION_ONLY"); assert.deepEqual((outbox.payload as any).actions, []);
    const actions = new StageActionService(f.db, { now: f.now }); while (await actions.processOnce()) { /* Empty historical plans cannot enroll. */ }
    assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.funnelActionExecution.count(), 0); assert.equal(await f.db.messageSend.count(), 0); assert.equal(f.requests.length, requests);
  } finally { await f.close(); }
});

test("signed expected source generation rejects stale backlog and duplicate retries without changing any receipt counters", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), body = payload(f, "pinned", { expectedSourceGeneration: 1 });
    const accepted = await event(f, s.id, body, "pinned-delivery-key");
    const before = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.id } });
    await f.tracking.updateSource(f.principal, s.id, { status: "PAUSED" }); await f.tracking.updateSource(f.principal, s.id, { status: "ACTIVE" });
    const sourceNow = await f.db.trackingSource.findUniqueOrThrow({ where: { id: s.id } }); assert.equal(sourceNow.generation, 3);
    const quota = await f.db.trackingRateLimit.findMany({ where: { sourceId: s.id } }), auditCount = await f.db.trackingAudit.count();
    for (const id of ["pinned-delivery-key", "never-submitted-before-reset"]) {
      const response = await post(f, s.id, body, id); assert.equal(response.status, 409); assert.equal((await response.json()).code, "TRACKING_SOURCE_GENERATION_MISMATCH");
    }
    assert.deepEqual(await f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.id } }), before);
    assert.deepEqual(await f.db.trackingRateLimit.findMany({ where: { sourceId: s.id } }), quota);
    assert.equal(await f.db.trackingAudit.count(), auditCount); assert.equal(await f.db.trackingEvent.count(), 1);
    for (const expectedSourceGeneration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null, false])
      assert.equal((await post(f, s.id, payload(f, "invalid", { expectedSourceGeneration }))).status, 400);
    assert.deepEqual(await f.db.trackingRateLimit.findMany({ where: { sourceId: s.id } }), quota);
    const signed = JSON.stringify(body), modified = JSON.stringify({ ...body, expectedSourceGeneration: 3 });
    const altered = await createTrackingApi(f.auth, f.tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${s.id}/events`, { method: "POST", headers: headers(f, signed, "tampered-generation"), body: modified }));
    assert.equal(altered.status, 401);
    const fresh = await event(f, s.id, payload(f, "new-subscription", { expectedSourceGeneration: 3 })); assert.equal(fresh.sourceGeneration, 3); assert.equal(fresh.status, "MATCHED");
    const compatible = await event(f, s.id, payload(f, "legacy-client")); assert.equal(compatible.sourceGeneration, 3); assert.equal(compatible.status, "MATCHED");
    const native = (await f.tracking.createSource(f.principal, { name: "Forms", provider: "NATIVE", environment: "TEST", externalAccountId: "native-generation", config: { allowedOrigins: ["https://business.example.test"] } })).source;
    for (const form of [true, false]) await assert.rejects(f.tracking.collectNative(native.id, "https://business.example.test", JSON.stringify({ schemaVersion: 1, eventId: "browser-generation", ...(form ? { email: "maya@example.test" } : { type: "page.viewed" }), expectedSourceGeneration: 1 }), form), { code: "INVALID_TRACKING_INPUT" });
  } finally { await f.close(); }
});

test("expected generation is checked again inside acceptance before duplicate or quota accounting", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), body = payload(f, "racing", { expectedSourceGeneration: 1 }), accepted = await event(f, s.id, body, "generation-race-key");
    const before = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.id } }), quota = await f.db.trackingRateLimit.findMany({ where: { sourceId: s.id } });
    let boundary = false;
    // Pause/resume through the actual service after the initial authenticated read, before its transaction begins.
    const racedDb = new Proxy(f.db, { get(target, name) {
      if (name === "$transaction") return async (...args: unknown[]) => {
        if (!boundary) { boundary = true; await f.tracking.updateSource(f.principal, s.id, { status: "PAUSED" }); await f.tracking.updateSource(f.principal, s.id, { status: "ACTIVE" }); }
        return (target.$transaction as (...values: unknown[]) => Promise<unknown>).apply(target, args);
      };
      const value = Reflect.get(target, name, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const tracking = new TrackingService(racedDb, f.auth, f.vault, f.now), raw = JSON.stringify(body);
    const response = await createTrackingApi(f.auth, tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${s.id}/events`, { method: "POST", headers: headers(f, raw, "generation-race-key"), body: raw }));
    assert.equal(boundary, true); assert.equal(response.status, 409); assert.equal((await response.json()).code, "TRACKING_SOURCE_GENERATION_MISMATCH");
    assert.deepEqual(await f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.id } }), before);
    assert.deepEqual(await f.db.trackingRateLimit.findMany({ where: { sourceId: s.id } }), quota); assert.equal(await f.db.trackingEvent.count(), 1);
  } finally { await f.close(); }
});

test("a source reset fences queued BACKFILL matching until an operator explicitly replays the evidence", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), { funnel } = await publish(f, definition(s.id)); tick(f);
    const id = await queued(f, s.id, payload(f, "queued-history", { ingestionMode: "BACKFILL", expectedSourceGeneration: 1 }));
    await f.tracking.updateSource(f.principal, s.id, { status: "PAUSED" }); await f.tracking.updateSource(f.principal, s.id, { status: "ACTIVE" });
    await drain(f);
    const blocked = await f.db.trackingEvent.findUniqueOrThrow({ where: { id } });
    assert.equal(blocked.status, "BLOCKED"); assert.equal(blocked.reason, "SOURCE_CHANGED"); assert.equal(blocked.sourceGeneration, 1);
    assert.equal(await f.db.funnelSubject.count(), 0); assert.equal(await f.db.trackingFact.count(), 0); assert.equal(await f.db.funnelEvaluationReceipt.count(), 0);
    await f.tracking.replay(f.principal, s.id, id); await drain(f);
    const recovered = await f.db.trackingEvent.findUniqueOrThrow({ where: { id } });
    assert.equal(recovered.status, "MATCHED"); assert.equal(recovered.ingestionMode, "BACKFILL"); assert.equal(recovered.processingMode, "REPLAY"); assert.equal(recovered.sourceGeneration, 1);
    assert.equal((await f.db.funnelEvidenceEffect.findFirstOrThrow({ where: { funnelId: funnel.id } })).outcome, "HISTORY_ONLY_NO_ENTRY");
    assert.equal(await f.db.trackingAudit.count({ where: { eventId: id, action: "HISTORY_REPLAY" } }), 1);
    assert.equal(await f.db.funnelJourney.count(), 0); assert.equal(await f.db.funnelActionOutbox.count(), 0); assert.equal(await f.db.messageSend.count(), 0);
  } finally { await f.close(); }
});

test("a source reset fences already matched BACKFILL evaluation before it can correct an active journey", async () => {
  const f = await createEmailFixture(); try {
    const s = await source(f), { funnel } = await publish(f, definition(s.id, "lead")); tick(f);
    const observed = await event(f, s.id, payload(f, "matched-history", { type: "custom.fluxsoft.observed" }));
    await f.funnels.move(f.principal, funnel.id, { subjectId: observed.subjectId, stageId: "lead", reason: "Existing trial recorded", commandKey: randomUUID() });
    const before = await f.db.funnelJourney.findFirstOrThrow({ where: { funnelId: funnel.id } }); tick(f);
    const id = await queued(f, s.id, payload(f, "matched-history", { ingestionMode: "BACKFILL", expectedSourceGeneration: 1 }));
    await f.tracking.processOnce();
    const pending = await f.db.funnelEvaluationReceipt.findFirstOrThrow({ where: { eventId: id } }); assert.equal(pending.status, "PENDING");
    const effectsBefore = await f.db.funnelEvidenceEffect.count(), outboxesBefore = await f.db.funnelActionOutbox.count();
    await f.tracking.updateSource(f.principal, s.id, { status: "PAUSED" }); await f.tracking.updateSource(f.principal, s.id, { status: "ACTIVE" });
    await f.funnels.processOnce();
    const fenced = await f.db.funnelEvaluationReceipt.findUniqueOrThrow({ where: { id: pending.id } });
    assert.equal(fenced.status, "CANCELLED"); assert.equal(fenced.reason, "SOURCE_CHANGED");
    assert.deepEqual(await f.db.funnelJourney.findUniqueOrThrow({ where: { id: before.id } }), before);
    assert.equal(await f.db.funnelEvidenceEffect.count(), effectsBefore); assert.equal(await f.db.funnelActionOutbox.count(), outboxesBefore);
    await f.tracking.replay(f.principal, s.id, id); await drain(f);
    assert.equal((await f.db.funnelJourney.findUniqueOrThrow({ where: { id: before.id } })).currentStageKey, "activated");
    const transition = await f.db.funnelStageTransition.findFirstOrThrow({ where: { eventId: id } }); assert.equal(transition.mode, "REPLAY");
    const outbox = await f.db.funnelActionOutbox.findFirstOrThrow({ where: { transitionId: transition.id } }); assert.equal(outbox.effectEligibility, "TRACKING_ONLY");
    assert.equal(await f.db.messageSend.count(), 0); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
