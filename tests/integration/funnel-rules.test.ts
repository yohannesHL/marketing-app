import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { CustomerAuth, digest, type CustomerPrincipal } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { FunnelService } from "../../apps/web/src/server/funnels/funnelService";
import { createFunnelApi } from "../../apps/web/src/server/funnels/funnelApi";
import type { FunnelDefinition, FunnelRoute } from "../../apps/web/src/server/funnels/funnelDefinition";
import { applyConnectionMigrations } from "../support/test-database";
let dir: string, db: PrismaClient, db2: PrismaClient, auth: CustomerAuth, tracking: TrackingService, service: FunnelService, second: FunnelService;
let now = new Date("2026-10-17T12:00:00Z");
const origin = "https://launchpad.test", secret = "fixture-funnel-secret";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "funnel-rules-")); const url = `file:${join(dir, "fixture.db")}`;
  const client = createClient({ url }); await applyConnectionMigrations(client); client.close();
  db = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) }); db2 = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  auth = new CustomerAuth(db, { origin }, () => now);
  const vault = new CredentialVault({ fixture: Buffer.alloc(32, 17).toString("base64") }, "fixture");
  tracking = new TrackingService(db, auth, vault, () => now); service = new FunnelService(db, auth, () => now);
  second = new FunnelService(db2, new CustomerAuth(db2, { origin }, () => now), () => now);
});
after(async () => { await db?.$disconnect(); await db2?.$disconnect(); if (dir) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  now = new Date(now.getTime() + 60_000);
  const id = randomUUID(), token = randomBytes(32).toString("base64url");
  await db.user.create({ data: { id, email: `${id}@example.test`, name: "Owner" } });
  const session = await db.customerSession.create({ data: { userId: id, tokenHash: digest(token), expiresAt: new Date("2028-01-01T00:00:00Z") } });
  const p: CustomerPrincipal = { userId: id, sessionId: session.id };
  const source = (await tracking.createSource(p, { name: "CRM", provider: "API", environment: "TEST", externalAccountId: id,
    credentials: { signingSecret: secret }, config: { allowedEvents: ["enquiry.accepted", "deal.won", "order.paid", "custom.booking", "custom.score", "custom.refund", "custom.checkout"],
      propertyKeys: ["score", "approved", "amount", "currency", "plan"] } })).source;
  return { p, source, cookie: `${auth.cookieName}=${token}` };
}
function route(sourceId: string, id: string, from: string | null, type: string, to: string): FunnelRoute {
  return { id, from, trigger: { kind: "EVENT", sourceId, type }, branches: [{ id: `${id}-yes`, to }], fallback: { kind: "WAIT" } };
}
function definition(sourceId: string): FunnelDefinition {
  return { schemaVersion: 1, stages: [
    { id: "lead", name: "Interested", goal: false, terminal: "NONE" },
    { id: "booked", name: "Call booked", goal: true, terminal: "NONE" },
    { id: "won", name: "Won", goal: true, terminal: "SUCCESS" },
  ], entryStages: ["lead", "booked"], routes: [route(sourceId, "entry", null, "enquiry.accepted", "lead"),
    route(sourceId, "booking", "lead", "custom.booking", "booked"), route(sourceId, "sale", "booked", "deal.won", "won")] };
}
async function published(f: Awaited<ReturnType<typeof fixture>>, def = definition(f.source.id), subjectKind = "SALES") {
  const funnel = await service.create(f.p, { name: "Custom funnel", environment: "TEST", subjectKind, definition: def });
  await service.publish(f.p, funnel.id, { draftRevision: 1 }); return funnel;
}
async function event(f: Awaited<ReturnType<typeof fixture>>, resourceId: string, type = "enquiry.accepted", properties: Record<string, unknown> = {}, occurredAt = now.toISOString(), subjectKind = "SALES") {
  const raw = JSON.stringify({ schemaVersion: 1, type, occurredAt, resource: { kind: subjectKind === "PURCHASE" ? "ORDER" : "ENQUIRY", id: resourceId }, subjectKind,
    contactIdentity: { kind: "CRM_CONTACT", id: "same-contact" }, contact: { email: "maya@example.test" }, properties });
  const t = String(now.getTime() / 1000), requestId = randomUUID();
  const accepted = await tracking.collectApi(f.source.id, new Headers({ "x-launchpad-id": requestId, "x-launchpad-timestamp": t,
    "x-launchpad-signature": createHmac("sha256", secret).update(`${t}.${requestId}.${raw}`).digest("hex") }), raw);
  await tracking.processOnce(); return db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.receipts[0].id } });
}
async function drain() { for (let n = 0; n < 100; n++) if (!await service.processOnce()) return; throw new Error("Queue did not drain"); }
async function journey(funnelId: string, subjectId: string) { return db.funnelJourney.findFirstOrThrow({ where: { funnelId, subjectId }, orderBy: { cycle: "desc" } }); }

test("custom names and concurrent workers preserve one entry transition and one internal intent", async () => {
  const f = await fixture(), def = definition(f.source.id); def.stages[0].name = "Asked about bespoke repairs";
  const funnel = await published(f, def), accepted = await event(f, "enquiry-1");
  assert.equal(await db.funnelEvaluationReceipt.count({ where: { eventId: accepted.id, status: "PENDING" } }), 1);
  await Promise.all([service.processOnce(), second.processOnce()]);
  const j = await journey(funnel.id, accepted.subjectId!); assert.equal(j.currentStageKey, "lead");
  assert.equal(await db.funnelStageTransition.count({ where: { journeyId: j.id } }), 1);
  assert.equal(await db.funnelActionOutbox.count({ where: { journeyId: j.id, effectEligibility: "TRACKING_ONLY", status: "RECORDED" } }), 1);
  assert.deepEqual((await db.funnelActionOutbox.findFirstOrThrow({ where: { journeyId: j.id } })).payload, { schemaVersion: 1, stageId: "lead", versionId: j.versionId, actions: [] });
  await tracking.replay(f.p, f.source.id, accepted.id); await tracking.processOnce(); await drain();
  assert.equal(await db.funnelStageTransition.count({ where: { journeyId: j.id } }), 1);
  assert.equal(await db.funnelEvaluationReceipt.count({ where: { eventId: accepted.id, status: "CONSUMED" } }), 2);
});

test("future-only publication consumes old evidence without historical enrolment; equality qualifies", async () => {
  const f = await fixture(), old = await event(f, "before", "enquiry.accepted", {}, new Date(now.getTime() - 1000).toISOString());
  const funnel = await published(f); await drain();
  assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id } }), 0);
  assert.equal((await db.funnelEvidenceEffect.findFirstOrThrow({ where: { funnelId: funnel.id } })).outcome, "BEFORE_PUBLICATION");
  const current = await event(f, "equal"); await drain(); assert.equal((await journey(funnel.id, current.subjectId!)).currentStageKey, "lead");
  await tracking.replay(f.p, f.source.id, old.id); await tracking.processOnce(); await drain();
  assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id } }), 1);
});

test("draft CAS, immutable published versions and active journey pinning survive republishing", async () => {
  const f = await fixture(), funnel = await published(f), first = await event(f, "first"); await drain();
  const original = await journey(funnel.id, first.subjectId!), edited = definition(f.source.id);
  edited.stages[1].name = "Reserved consultation"; edited.routes[1].branches[0].to = "won";
  await service.updateDraft(f.p, funnel.id, { draftRevision: 1, definition: edited });
  await assert.rejects(service.updateDraft(f.p, funnel.id, { draftRevision: 1, definition: edited }), { code: "DRAFT_CHANGED" });
  now = new Date(now.getTime() + 1000); await service.publish(f.p, funnel.id, { draftRevision: 2 });
  await event(f, "first", "custom.booking"); await drain();
  assert.equal((await journey(funnel.id, first.subjectId!)).currentStageKey, "booked");
  assert.equal((await journey(funnel.id, first.subjectId!)).versionId, original.versionId);
  const other = await event(f, "second"); await drain(); await event(f, "second", "custom.booking"); await drain();
  assert.equal((await journey(funnel.id, other.subjectId!)).currentStageKey, "won");
  assert.notEqual((await journey(funnel.id, other.subjectId!)).versionId, original.versionId);
});

test("property changes use genuine changes; later scores do not resurrect an old booking", async () => {
  const f = await fixture(), def = definition(f.source.id);
  def.routes[1].branches[0].when = { field: { scope: "PROPERTY", sourceId: f.source.id, type: "custom.score", key: "score" }, type: "number", op: "gte", value: 10 };
  const funnel = await published(f, def), entry = await event(f, "qualified"); await drain();
  await event(f, "qualified", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "lead");
  now = new Date(now.getTime() + 1000); await event(f, "qualified", "custom.score", { score: 20 }); await drain();
  assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "lead");
  await event(f, "qualified", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "booked");
  const changes = definition(f.source.id); changes.routes[1].trigger = { kind: "PROPERTY_CHANGE", sourceId: f.source.id, type: "custom.score", key: "score" };
  changes.routes[1].branches[0].when = { field: { scope: "EVENT", key: "score" }, type: "number", op: "gte", value: 10 };
  const other = await published(f, changes), next = await event(f, "property-change"); await drain();
  now = new Date(now.getTime() + 1000); await event(f, "property-change", "custom.score", { score: 0 }); await drain();
  assert.equal((await journey(other.id, next.subjectId!)).currentStageKey, "lead");
  now = new Date(now.getTime() + 1000); await event(f, "property-change", "custom.score", { score: 11 }); await drain();
  assert.equal((await journey(other.id, next.subjectId!)).currentStageKey, "booked");
});

test("late and equal-time conflicting property observations cannot overwrite current qualification", async () => {
  const f = await fixture(), def = definition(f.source.id);
  def.routes[1].branches[0].when = { field: { scope: "PROPERTY", sourceId: f.source.id, type: "custom.score", key: "score" }, type: "number", op: "gte", value: 10 };
  const funnel = await published(f, def), entry = await event(f, "conflict"); await drain();
  now = new Date(now.getTime() + 2000); const observed = now.toISOString();
  await event(f, "conflict", "custom.score", { score: 20 }); await drain();
  await event(f, "conflict", "custom.score", { score: 1 }, new Date(now.getTime() - 1000).toISOString()); await drain();
  let snapshot = await db.funnelPropertySnapshot.findFirstOrThrow({ where: { subjectId: entry.subjectId!, eventType: "custom.score" } });
  assert.equal((snapshot.fields as Record<string, { value: number }>).score.value, 20);
  await event(f, "conflict", "custom.score", { score: 2 }, observed); await drain();
  snapshot = await db.funnelPropertySnapshot.findFirstOrThrow({ where: { id: snapshot.id } });
  assert.equal((snapshot.fields as Record<string, { state: string }>).score.state, "UNKNOWN");
  await event(f, "conflict", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "lead");
});

test("one canonical payment cause cannot traverse multiple stages; explicit refund preserves the goal", async () => {
  const f = await fixture(), s = f.source.id;
  const def: FunnelDefinition = { schemaVersion: 1, stages: [
    { id: "paid", name: "Purchased", goal: true, terminal: "NONE" }, { id: "processed", name: "Processed", goal: false, terminal: "NONE" },
    { id: "refunded", name: "Refunded", goal: false, terminal: "FAILURE" }], entryStages: ["paid"], routes: [
      route(s, "entry", null, "order.paid", "paid"), route(s, "repeat", "paid", "order.paid", "processed"), route(s, "refund", "paid", "custom.refund", "refunded")] };
  const funnel = await published(f, def, "PURCHASE"), a = await event(f, "order-1", "order.paid", { amount: "100.00", currency: "GBP" }, now.toISOString(), "PURCHASE"); await drain();
  await event(f, "order-1", "order.paid", { amount: "100.00", currency: "GBP" }, now.toISOString(), "PURCHASE"); await drain();
  assert.equal((await journey(funnel.id, a.subjectId!)).currentStageKey, "paid");
  now = new Date(now.getTime() + 1000); await event(f, "order-1", "custom.checkout", {}, new Date(now.getTime() - 500).toISOString(), "PURCHASE"); await drain();
  assert.equal((await journey(funnel.id, a.subjectId!)).currentStageKey, "paid");
  await event(f, "order-1", "custom.refund", {}, now.toISOString(), "PURCHASE"); await drain();
  const j = await journey(funnel.id, a.subjectId!); assert.equal(j.currentStageKey, "refunded"); assert.equal(j.status, "FAILED");
  assert.deepEqual((await service.history(f.p, funnel.id, j.id)).transitions.map(t => t.toStageKey), ["paid", "refunded"]);
  assert.equal(await db.trackingFact.count({ where: { subjectId: a.subjectId! } }), 1);
  const b = await event(f, "order-2", "order.paid", { amount: "30.00", currency: "GBP" }, now.toISOString(), "PURCHASE"); await drain();
  assert.notEqual(a.subjectId, b.subjectId); assert.equal(a.contactId, b.contactId); assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id } }), 2);
});

test("manual entry and corrections require reason, ownership, explicit new cycles and idempotent commands", async () => {
  const f = await fixture(), def = definition(f.source.id); def.routes = [];
  const funnel = await published(f, def), subject = await event(f, "manual"); await drain();
  const command = { subjectId: subject.subjectId, stageId: "lead", reason: "Confirmed at reception", commandKey: "manual-command" };
  const first = await service.move(f.p, funnel.id, command);
  const duplicate = await service.move(f.p, funnel.id, command); assert.equal(first.transition.id, duplicate.transition.id);
  await assert.rejects(service.move(f.p, funnel.id, { ...command, reason: "Different" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(service.move(f.p, funnel.id, { ...command, commandKey: "empty", reason: "" }), { code: "INVALID_TRACKING_INPUT" });
  const other = await fixture(); await assert.rejects(service.move(other.p, funnel.id, command), { code: "NOT_FOUND" });
  await service.move(f.p, funnel.id, { ...command, stageId: "won", commandKey: "complete" });
  await assert.rejects(service.move(f.p, funnel.id, { ...command, commandKey: "accidental" }), { code: "NEW_CYCLE_REQUIRED" });
  const next = await service.move(f.p, funnel.id, { ...command, commandKey: "cycle-2", newCycle: true }); assert.equal(next.journey.cycle, 2);
  await assert.rejects(service.move(f.p, funnel.id, { ...command, commandKey: "cycle-3", newCycle: true }), { code: "ACTIVE_JOURNEY" });
  assert.equal((await db.funnelActionOutbox.findFirstOrThrow({ where: { journeyId: next.journey.id } })).mode, "REPLAY");
});

test("history replay can correct an existing path but cannot enroll old subjects or authorize external work", async () => {
  const f = await fixture(), funnel = await published(f), a = await event(f, "existing"); await drain();
  const booking = await event(f, "existing", "custom.booking");
  await tracking.replay(f.p, f.source.id, booking.id); await tracking.processOnce(); await drain();
  const j = await journey(funnel.id, a.subjectId!); assert.equal(j.currentStageKey, "booked");
  const history = await service.history(f.p, funnel.id, j.id); assert.equal(history.transitions.at(-1)!.mode, "REPLAY");
  assert.equal((await db.funnelActionOutbox.findFirstOrThrow({ where: { transitionId: history.transitions.at(-1)!.id } })).effectEligibility, "TRACKING_ONLY");
  const b = await event(f, "history-only"); await tracking.replay(f.p, f.source.id, b.id); await tracking.processOnce(); await drain();
  assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id, subjectId: b.subjectId } }), 0);
});

test("pausing new entry allows existing progression; source rotation blocks stale queued evidence", async () => {
  const f = await fixture(), funnel = await published(f), a = await event(f, "existing"); await drain();
  await service.setStatus(f.p, funnel.id, { status: "PAUSED" }); await event(f, "new"); await drain();
  await event(f, "existing", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, a.subjectId!)).currentStageKey, "booked");
  assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id } }), 1);
  const stale = await event(f, "existing", "deal.won", { amount: "400", currency: "GBP" });
  await tracking.updateSource(f.p, f.source.id, { status: "PAUSED" }); await drain();
  assert.equal((await db.funnelEvaluationReceipt.findFirstOrThrow({ where: { eventId: stale.id } })).reason, "SOURCE_CHANGED");
  assert.equal((await journey(funnel.id, a.subjectId!)).currentStageKey, "booked");
});

test("contact deletion cancels queued evaluation and journeys, redacts history and prevents replay resurrection", async () => {
  const f = await fixture(), funnel = await published(f), a = await event(f, "delete-me"); await drain();
  const j = await journey(funnel.id, a.subjectId!);
  await service.move(f.p, funnel.id, { subjectId: a.subjectId, stageId: "booked", reason: "Personal customer detail", commandKey: "private-note" });
  const pending = await event(f, "delete-me", "deal.won", { amount: "100", currency: "GBP" });
  await tracking.deleteContact(f.p, a.contactId!); await drain();
  assert.equal((await journey(funnel.id, a.subjectId!)).status, "CANCELLED");
  assert.equal((await db.funnelEvaluationReceipt.findFirstOrThrow({ where: { eventId: pending.id } })).status, "CANCELLED");
  const history = await service.history(f.p, funnel.id, j.id); assert.ok(history.transitions.every(t => t.redactedAt && t.note === null && JSON.stringify(t.evaluationTrace) === "{}"));
  assert.equal(await db.funnelPropertySnapshot.count({ where: { subjectId: a.subjectId! } }), 0);
  assert.ok((await db.funnelActionOutbox.findMany({ where: { journeyId: j.id } })).every(o => o.status === "CANCELLED" && JSON.stringify(o.payload) === "{}"));
  await assert.rejects(tracking.replay(f.p, f.source.id, a.id), { code: "REPLAY_UNAVAILABLE" });
});

test("simulator and real evaluator choose the same stages with zero external effects", async () => {
  const f = await fixture(), funnel = await published(f);
  const simulation = await service.simulate(f.p, funnel.id, { events: [
    { sourceId: f.source.id, type: "enquiry.accepted", properties: {}, occurredAt: now.toISOString() },
    { sourceId: f.source.id, type: "custom.booking", properties: {}, occurredAt: now.toISOString() },
  ] });
  assert.equal(simulation.currentStage, "booked"); assert.equal(simulation.externalEffects, false);
  assert.equal(await db.funnelJourney.count({ where: { funnelId: funnel.id } }), 0);
  const e = await event(f, "real"); await drain(); await event(f, "real", "custom.booking"); await drain();
  assert.equal((await journey(funnel.id, e.subjectId!)).currentStageKey, simulation.currentStage);
});

test("publication rejects cross-owner, wrong-environment and disabled-source rules; tracking-only needs no sender", async () => {
  const a = await fixture(), b = await fixture(); const draft = await service.create(a.p, { name: "Foreign", environment: "TEST", subjectKind: "SALES", definition: definition(b.source.id) });
  await assert.rejects(service.publish(a.p, draft.id, { draftRevision: 1 }), { code: "FUNNEL_SOURCE_UNAVAILABLE" });
  const live = await service.create(a.p, { name: "Live", environment: "LIVE", subjectKind: "SALES", definition: definition(a.source.id) });
  await assert.rejects(service.publish(a.p, live.id, { draftRevision: 1 }), { code: "FUNNEL_SOURCE_UNAVAILABLE" });
  const def = definition(a.source.id); def.routes[1].trigger.type = "custom.unconfigured";
  const wrong = await service.create(a.p, { name: "Unavailable", environment: "TEST", subjectKind: "SALES", definition: def });
  await assert.rejects(service.publish(a.p, wrong.id, { draftRevision: 1 }), { code: "FUNNEL_EVENT_UNAVAILABLE" });
  const manual = definition(a.source.id); manual.routes = []; await published(a, manual);
});

test("HTTP management enforces sessions, exact Origin, ownership and bounded JSON", async () => {
  const f = await fixture(), api = createFunnelApi(auth, service), body = JSON.stringify({ name: "API", environment: "TEST", subjectKind: "SALES", definition: definition(f.source.id) });
  const request = (headers: Record<string, string>, value = body) => new Request(`${origin}/api/funnels`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: value });
  assert.equal((await api(request({ origin }))).status, 401);
  assert.equal((await api(request({ cookie: f.cookie, origin: "https://evil.test" }))).status, 403);
  assert.equal((await api(request({ cookie: f.cookie, origin }, "x".repeat(131073)))).status, 413);
  const response = await api(request({ cookie: f.cookie, origin })); assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
  const created = await response.json();
  const other = await fixture(); assert.equal((await api(new Request(`${origin}/api/funnels/${created.id}`, { headers: { cookie: other.cookie } }))).status, 404);
});

test("native identity repair enqueues every earlier observation atomically as history-only work", async () => {
  const f = await fixture(), site = "https://business.test";
  const source = (await tracking.createSource(f.p, { name: "Website", provider: "NATIVE", environment: "TEST", externalAccountId: randomUUID(), config: { allowedOrigins: [site] } })).source;
  const visitor = await tracking.visitor(source.id, site);
  const page = await tracking.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "anonymous-page", visitorToken: visitor.visitorToken, type: "page.viewed", properties: { path: "/services" } }), false);
  await tracking.processOnce();
  await tracking.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "accepted-form", visitorToken: visitor.visitorToken, name: "Maya", email: "maya@example.test" }), true);
  await tracking.processOnce();
  assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: page.receipts[0].id } })).status, "QUEUED");
  assert.equal(await db.funnelEvaluationReceipt.count({ where: { eventId: page.receipts[0].id } }), 0);
  await tracking.processOnce();
  const receipt = await db.funnelEvaluationReceipt.findFirstOrThrow({ where: { eventId: page.receipts[0].id } });
  assert.equal(receipt.mode, "REPLAY"); assert.equal(receipt.status, "PENDING"); assert.equal(receipt.matchRevision, 1);
  await drain(); assert.equal((await db.funnelEvaluationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status, "CONSUMED");
});

test("matched detail retention waits for evaluation and active journeys while retaining dedupe tombstones", async () => {
  const f = await fixture(), funnel = await published(f), a = await event(f, "retention");
  const clock = now; now = new Date(now.getTime() + 181 * 86_400_000);
  await tracking.prune(); assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: a.id } })).status, "MATCHED");
  await drain(); await tracking.prune(); assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: a.id } })).status, "MATCHED");
  await service.move(f.p, funnel.id, { subjectId: a.subjectId, stageId: "won", reason: "Closed by owner", commandKey: "finish-retention" });
  await tracking.prune(); const redacted = await db.trackingEvent.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(redacted.status, "REDACTED"); assert.deepEqual(redacted.envelope, {}); assert.equal(redacted.rawPayloadDigest, a.rawPayloadDigest);
  assert.equal(await db.funnelEvidenceEffect.count({ where: { funnelId: funnel.id } }), 1);
  now = clock;
});

test("fresh corroboration after credential rotation restores unchanged property evidence without a change trigger", async () => {
  const f = await fixture(), def = definition(f.source.id);
  def.routes[1].branches[0].when = { field: { scope: "PROPERTY", sourceId: f.source.id, type: "custom.score", key: "score" }, type: "number", op: "gte", value: 10 };
  const funnel = await published(f, def), entry = await event(f, "renewed"); await drain();
  now = new Date(now.getTime() + 1000); const observed = now.toISOString();
  await event(f, "renewed", "custom.score", { score: 20 }, observed); await drain();
  await tracking.updateSource(f.p, f.source.id, { credentials: { signingSecret: secret } });
  await event(f, "renewed", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "lead");
  await event(f, "renewed", "custom.score", { score: 20 }, observed); await drain();
  await event(f, "renewed", "custom.booking"); await drain(); assert.equal((await journey(funnel.id, entry.subjectId!)).currentStageKey, "booked");
});

test("a changed property can advance after the payment fact was consumed without repeating its event branch", async () => {
  const f = await fixture(), s = f.source.id;
  const def: FunnelDefinition = { schemaVersion: 1, stages: [
    { id: "paid", name: "Purchased", goal: true, terminal: "NONE" }, { id: "premium", name: "Premium customer", goal: false, terminal: "NONE" },
    { id: "duplicate", name: "Must not be reached", goal: false, terminal: "NONE" }], entryStages: ["paid"], routes: [
      route(s, "entry", null, "order.paid", "paid"), route(s, "repeat", "paid", "order.paid", "duplicate"),
      { ...route(s, "upgrade", "paid", "order.paid", "premium"), trigger: { kind: "PROPERTY_CHANGE", sourceId: s, type: "order.paid", key: "plan" },
        branches: [{ id: "premium-plan", to: "premium", when: { field: { scope: "EVENT", key: "plan" }, type: "string", op: "eq", value: "premium" } }] }] };
  const funnel = await published(f, def, "PURCHASE"), e = await event(f, "order-upgraded", "order.paid", { amount: "100", currency: "GBP", plan: "basic" }, now.toISOString(), "PURCHASE"); await drain();
  now = new Date(now.getTime() + 1000);
  await event(f, "order-upgraded", "order.paid", { amount: "100", currency: "GBP", plan: "premium" }, now.toISOString(), "PURCHASE"); await drain();
  assert.equal((await journey(funnel.id, e.subjectId!)).currentStageKey, "premium");
  assert.equal(await db.trackingFact.count({ where: { subjectId: e.subjectId! } }), 1);
  assert.equal(await db.funnelStageTransition.count({ where: { journeyId: (await journey(funnel.id, e.subjectId!)).id } }), 2);
});

test("a missing property from a disconnected source remains unavailable rather than satisfying isMissing", async () => {
  const f = await fixture();
  const extra = (await tracking.createSource(f.p, { name: "Other", provider: "API", environment: "TEST", externalAccountId: randomUUID(), credentials: { signingSecret: secret },
    config: { allowedEvents: ["custom.score"], propertyKeys: ["score"] } })).source;
  const def = definition(f.source.id); def.routes[1].branches[0].when = { field: { scope: "PROPERTY", sourceId: extra.id, type: "custom.score", key: "score" }, type: "number", op: "isMissing" };
  const funnel = await published(f, def), e = await event(f, "unavailable"); await drain();
  await tracking.updateSource(f.p, extra.id, { status: "DISCONNECTED" });
  await event(f, "unavailable", "custom.booking"); await drain();
  assert.equal((await journey(funnel.id, e.subjectId!)).currentStageKey, "lead");
});

test("simulation honors canonical occurrence identity and provider resource version ordering", async () => {
  const f = await fixture(), def = definition(f.source.id);
  def.routes[1].trigger.type = "enquiry.accepted";
  const funnel = await published(f, def), base = { sourceId: f.source.id, type: "enquiry.accepted", properties: {}, occurredAt: now.toISOString(), evidenceKey: "canonical-enquiry" };
  const duplicate = await service.simulate(f.p, funnel.id, { events: [base, base] });
  assert.equal(duplicate.currentStage, "lead"); assert.equal((duplicate.history[1] as { reason: string }).reason, "DUPLICATE_EVIDENCE");
  const propertyDef = definition(f.source.id);
  propertyDef.routes[1].branches[0].when = { field: { scope: "PROPERTY", sourceId: f.source.id, type: "custom.score", key: "score" }, type: "number", op: "gte", value: 10 };
  const t = now.toISOString(), older = new Date(now.getTime() - 1000).toISOString();
  const result = await service.simulate(f.p, funnel.id, { definition: propertyDef, events: [base,
    { sourceId: f.source.id, type: "custom.score", properties: { score: 20 }, occurredAt: t, resourceUpdatedAt: t },
    { sourceId: f.source.id, type: "custom.score", properties: { score: 1 }, occurredAt: t, resourceUpdatedAt: older },
    { sourceId: f.source.id, type: "custom.booking", properties: {}, occurredAt: t }] });
  assert.equal(result.currentStage, "booked");
});
