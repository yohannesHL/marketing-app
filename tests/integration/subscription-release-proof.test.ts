import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import { createFunnelTemplate } from "../../apps/web/src/server/funnels/funnelTemplates";
import { FunnelReportingService } from "../../apps/web/src/server/funnels/funnelReportingService";
import { AutomationRunner } from "../../apps/web/src/server/email/automationRunner";

const secret = "subscription-proof-fixture-secret";
const activation = "custom.fluxsoft.subscription_active";
const identity = "custom.person.observed";
const renewal = "custom.subscription.renewed";
const tick = (f: EmailFixture) => f.setNow(new Date(f.now().getTime() + 1000));

async function source(f: EmailFixture) {
  return (await f.tracking.createSource(f.principal, { name: "Subscription bridge fixture", provider: "API", environment: "TEST",
    externalAccountId: randomUUID(), credentials: { signingSecret: secret },
    config: { allowedEvents: [activation, identity, renewal], propertyKeys: ["workspaceId"] } })).source;
}
function body(f: EmailFixture, id: string, type = activation, backfill = false) {
  return JSON.stringify({ schemaVersion: 1, type, occurredAt: f.now().toISOString(), subjectKind: "SUBSCRIPTION",
    resource: { kind: "SUBSCRIPTION", id }, contactIdentity: { kind: "PRODUCT_USER", id: "one-person" },
    contact: { email: "subscriber@example.test" }, properties: { workspaceId: "one-workspace" },
    ...(backfill ? { ingestionMode: "BACKFILL" } : {}) });
}
async function receive(f: EmailFixture, sourceId: string, raw: string, requestId = randomUUID(), status = 202) {
  const timestamp = String(Math.floor(f.now().getTime() / 1000));
  const response = await createTrackingApi(f.auth, f.tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${sourceId}/events`, {
    method: "POST", headers: { "content-type": "application/json", "x-launchpad-id": requestId, "x-launchpad-timestamp": timestamp,
      "x-launchpad-signature": createHmac("sha256", secret).update(`${timestamp}.${requestId}.${raw}`).digest("hex") }, body: raw,
  }));
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
function runner(f: EmailFixture) {
  return new AutomationRunner(f.db, { tracking: f.tracking, funnels: f.funnels, connections: f.connections, delivery: f.delivery }, { now: f.now });
}
async function drain(worker: AutomationRunner) {
  for (let i = 0; i < 100; i++) if (!await worker.processOnce()) return;
  throw new Error("Subscription proof did not reach a stable state");
}

test("subscription bridge: signed receipts become two acquisitions for one contact without revenue or implicit sends", async () => {
  const f = await createEmailFixture();
  try {
    const from = f.now().toISOString(), s = await source(f), worker = runner(f);
    const funnel = await f.funnels.create(f.principal, { name: "Subscription activation", environment: "TEST", subjectKind: "SUBSCRIPTION",
      definition: createFunnelTemplate("subscription-activation", { primarySourceId: s.id }) });
    const { version } = await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
    tick(f); const raw = body(f, "sub-a"), key = randomUUID();
    const first = await receive(f, s.id, raw, key); await drain(worker);
    tick(f); const duplicate = await receive(f, s.id, raw, key);
    assert.equal(duplicate.receipts[0].id, first.receipts[0].id); assert.equal(duplicate.receipts[0].duplicate, true);
    await receive(f, s.id, raw); await drain(worker);
    tick(f); await receive(f, s.id, body(f, "sub-a", renewal)); await drain(worker);
    tick(f); await receive(f, s.id, body(f, "sub-b")); await drain(worker);
    assert.equal(await f.db.funnelContact.count(), 1);
    assert.equal(await f.db.funnelSubject.count({ where: { kind: "SUBSCRIPTION" } }), 2);
    assert.equal(await f.db.funnelJourney.count(), 2);
    assert.equal(await f.db.funnelStageTransition.count(), 2);
    assert.equal(await f.db.trackingFact.count({ where: { key: activation, authority: "SERVER_ASSERTED" } }), 2);
    assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.messageSend.count(), 0);
    assert.equal(f.requests.length, 0, "Tracking-only flow makes no email-provider requests");
    tick(f);
    const report = await new FunnelReportingService(f.db, f.auth, f.now).report(f.principal, funnel.id,
      { versionId: version.id, from, to: f.now().toISOString() });
    assert.equal(report.funnel.subjectKind, "SUBSCRIPTION");
    assert.deepEqual([report.totals.distinctSubjects, report.totals.goalJourneys, report.totals.repeatCycles], [2, 2, 0]);
    assert.equal(report.money.includedFacts, 0); assert.deepEqual(report.money.currencies, []);
  } finally { await f.close(); }
});

test("subscription bridge: enabled marketing sends once per fresh subscription and never for historical import", async () => {
  const f = await createEmailFixture();
  try {
    const s = await source(f), worker = runner(f), campaign = await f.publishedCampaign({ category: "subscriptions" });
    // Establish the actual person and their opt-in through public services before activation.
    const person = await receive(f, s.id, body(f, "sub-a", identity)); await drain(worker);
    const personEvent = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: person.receipts[0].id } });
    assert.ok(personEvent.contactId); await f.consent(personEvent.contactId, "subscriptions");
    const definition = createFunnelTemplate("subscription-activation", { primarySourceId: s.id });
    definition.stageActions = [{ id: "welcome", stageId: "active", kind: "EMAIL_ENROLL", campaignId: campaign.campaign.id,
      revisionId: campaign.revision.id, delaySeconds: 0, expiresAfterDueSeconds: 3600, stopOnStageExit: true, stopOnGoal: false }];
    const funnel = await f.funnels.create(f.principal, { name: "Optional subscription marketing", environment: "TEST", subjectKind: "SUBSCRIPTION", definition });
    await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
    await f.funnels.controls(f.principal, funnel.id, { automationEnrolmentEnabled: true, automationDispatchEnabled: true });
    tick(f); const fresh = body(f, "sub-a"); await receive(f, s.id, fresh); await drain(worker);
    tick(f); await receive(f, s.id, fresh); await drain(worker);
    tick(f); await receive(f, s.id, body(f, "sub-a", renewal)); await drain(worker);
    assert.equal(await f.db.campaignMembership.count(), 1);
    assert.equal(await f.db.messageSend.count({ where: { status: "ACCEPTED" } }), 1);
    tick(f); await receive(f, s.id, body(f, "sub-b")); await drain(worker);
    assert.equal(await f.db.campaignMembership.count(), 2);
    assert.equal(await f.db.messageSend.count({ where: { status: "ACCEPTED" } }), 2);
    tick(f); const history = body(f, "sub-existing", activation, true), historyKey = randomUUID();
    const imported = await receive(f, s.id, history, historyKey); await drain(worker);
    const event = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: imported.receipts[0].id } });
    assert.equal(event.processingMode, "BACKFILL"); assert.ok(event.subjectId);
    assert.equal(await f.db.funnelJourney.count({ where: { subjectId: event.subjectId } }), 0);
    assert.equal(await f.db.funnelEvidenceEffect.count({ where: { subjectId: event.subjectId, outcome: "HISTORY_ONLY_NO_ENTRY" } }), 1);
    assert.equal(await f.db.campaignMembership.count(), 2);
    assert.equal(await f.db.messageSend.count(), 2);
    // A changed body cannot upgrade the original historical delivery; a new key cannot repeat its activation either.
    const upgraded = { ...JSON.parse(history) }; delete upgraded.ingestionMode;
    await receive(f, s.id, JSON.stringify(upgraded), historyKey, 409);
    await receive(f, s.id, JSON.stringify(upgraded)); await drain(worker);
    assert.equal(await f.db.funnelJourney.count(), 2); assert.equal(await f.db.funnelStageTransition.count(), 2);
    assert.equal(await f.db.campaignMembership.count(), 2); assert.equal(await f.db.messageSend.count(), 2);
    assert.equal(f.requests.filter(r => r.method === "POST" && new URL(r.url).pathname === "/emails").length, 2);
  } finally { await f.close(); }
});
