import assert from "node:assert/strict";
import test from "node:test";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN } from "../support/email-fixture";
import { createFunnelApi } from "../../apps/web/src/server/funnels/funnelApi";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";
import { safeReturnTo } from "../../apps/web/src/components/connections/connectionUi";

test("funnel readiness is scoped, effect-free and separates tracking from current email setup", async () => {
  const f = await createEmailFixture();
  try {
    const published = await f.publishedCampaign();
    const definition: FunnelDefinition = { schemaVersion: 1, stages: [{ id: "lead", name: "Interested", goal: false, terminal: "NONE" }], entryStages: ["lead"], routes: [],
      stageActions: [{ id: "nurture", stageId: "lead", campaignId: published.campaign.id, revisionId: published.revision.id, kind: "EMAIL_ENROLL", delaySeconds: 0, expiresAfterDueSeconds: 604800, stopOnGoal: true, stopOnStageExit: true }] };
    const funnel = await f.funnels.create(f.principal, { name: "Readiness", environment: "TEST", subjectKind: "SALES", definition });
    await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
    const api = createFunnelApi(f.auth, f.funnels), requestsBefore = f.requests.length;
    const request = (cookie: string, suffix = "published") => api(new Request(`${EMAIL_FIXTURE_ORIGIN}/api/funnels/${funnel.id}/readiness?scope=${suffix}`, { headers: { cookie } }));
    const response = await request(f.cookie); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const ready = await response.json(); assert.equal(ready.tracking.configured, true); assert.equal(ready.actions[0].configured, true);
    assert.doesNotMatch(JSON.stringify(ready), /credential|apiKey|webhookSecret|Ciphertext|leaseTokenHash/);
    assert.equal(f.requests.length, requestsBefore); assert.equal(await f.db.messageSend.count(), 0);
    assert.equal((await request("")).status, 401); assert.equal((await request((await f.owner()).cookie)).status, 404); assert.equal((await request(f.cookie, "invalid")).status, 400);
    await f.connections.update(f.principal, published.setup.connection.id, { status: "PAUSED" });
    const blocked = await (await request(f.cookie)).json(); assert.equal(blocked.tracking.configured, true); assert.equal(blocked.actions[0].configured, false);
    assert.ok(blocked.actions[0].blockers.includes("EMAIL_SETUP_REQUIRED")); assert.ok(blocked.actions[0].blockers.includes("EMAIL_READINESS_REQUIRED"));
    const trackingOnly = await f.funnels.create(f.principal, { name: "Tracking only", environment: "TEST", subjectKind: "SALES", definition: { ...definition, stageActions: [] } });
    assert.deepEqual((await f.funnels.readiness(f.principal, trackingOnly.id, "draft")).actions, []);
    await assert.rejects(f.funnels.readiness(f.principal, trackingOnly.id, "published"), { code: "FUNNEL_UNPUBLISHED" });
  } finally { await f.close(); }
});

test("journey inspector uses its exact pinned version beyond the latest version list and exposes only safe evidence", async () => {
  const f = await createEmailFixture();
  try {
    const before = await f.recipient();
    const definition: FunnelDefinition = { schemaVersion: 1, stages: [{ id: "lead", name: "Original milestone", goal: false, terminal: "NONE" }], entryStages: ["lead"], routes: [
      { id: "entry", from: null, trigger: { kind: "EVENT", sourceId: before.source.id, type: "enquiry.accepted" }, branches: [{ id: "yes", to: "lead" }], fallback: { kind: "WAIT" } }] };
    const funnel = await f.funnels.create(f.principal, { name: "Pinned", environment: "TEST", subjectKind: "SALES", definition });
    const first = await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
    f.setNow(new Date(f.now().getTime() + 1000));
    const person = await f.recipient({ contactExternalId: before.contactExternalId, subjectExternalId: "second-enquiry" });
    while (await f.funnels.processOnce()) { /* Consume durable evidence, including earlier source setup. */ }
    const journey = await f.db.funnelJourney.findFirstOrThrow({ where: { funnelId: funnel.id, subjectId: person.subject.id } });
    let revision = 1;
    for (let number = 2; number <= 32; number++) {
      const updated = await f.funnels.updateDraft(f.principal, funnel.id, { draftRevision: revision, definition: { ...definition, stages: [{ ...definition.stages[0], name: `Later ${number}` }] } });
      revision = updated.draftRevision; await f.funnels.publish(f.principal, funnel.id, { draftRevision: revision });
    }
    assert.ok(!(await f.funnels.get(f.principal, funnel.id)).versions.some(version => version.id === first.version.id));
    const history = await f.funnels.history(f.principal, funnel.id, journey.id);
    assert.equal(history.version.id, first.version.id); assert.equal((history.version.definition as unknown as FunnelDefinition).stages[0].name, "Original milestone");
    assert.equal(history.subject.contact?.id, before.contact.id); assert.equal(history.subject.id, person.subject.id);
    assert.equal(history.transitions[0].event?.sourceId, person.source.id); assert.equal(history.transitions[0].event?.authority, "SERVER_ASSERTED");
    assert.equal("envelope" in history.transitions[0].event!, false);
    await assert.rejects(f.funnels.history((await f.owner()).principal, funnel.id, journey.id), { code: "NOT_FOUND" });
  } finally { await f.close(); }
});

test("funnel workspace sign-in destinations allow local routes without opening redirects", () => {
  for (const path of ["/funnels", "/funnels/create", "/funnels/owned-1", "/funnels/owned-1/journeys/journey_2", "/tracking/source-1", "/email", "/email/connections", "/email/campaigns/c-1", "/email/memberships/m-1"])
    assert.equal(safeReturnTo(path), path);
  for (const path of ["//evil.test", "https://evil.test", "/funnels/../evil", "/funnels/a?redirect=https://evil.test", "/email/connections/../../evil", "/tracking/%2F%2Fevil.test"])
    assert.equal(safeReturnTo(path), "/connections");
});

test("manual inspector corrections fence the displayed cycle and revision without losing command idempotency", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), first = await f.manualJourney(person.subject.id);
    await f.funnels.cancelJourney(f.principal, first.funnel.id, first.journey.id, { reason: "Original enquiry finished" });
    const second = await f.funnels.move(f.principal, first.funnel.id, { subjectId: person.subject.id, stageId: "lead", reason: "Explicit repeat enquiry", newCycle: true, commandKey: "second-cycle" });
    const stale = { subjectId: person.subject.id, stageId: "lead", reason: "Correction from old history", commandKey: "stale-history",
      expectedJourneyId: first.journey.id, expectedRevision: first.journey.revision };
    await assert.rejects(f.funnels.move(f.principal, first.funnel.id, stale), { code: "JOURNEY_CHANGED" });
    assert.equal((await f.db.funnelJourney.findUniqueOrThrow({ where: { id: second.journey.id } })).revision, second.journey.revision);
    const current = { ...stale, commandKey: "current-correction", expectedJourneyId: second.journey.id, expectedRevision: second.journey.revision };
    const moved = await f.funnels.move(f.principal, first.funnel.id, current);
    assert.equal(moved.journey.id, second.journey.id); assert.equal(moved.journey.revision, second.journey.revision + 1);
    const duplicate = await f.funnels.move(f.principal, first.funnel.id, current); assert.equal(duplicate.transition.id, moved.transition.id);
    await assert.rejects(f.funnels.move(f.principal, first.funnel.id, { ...current, commandKey: "outdated-revision" }), { code: "JOURNEY_CHANGED" });
    await assert.rejects(f.funnels.move(f.principal, first.funnel.id, { ...current, commandKey: "incomplete", expectedRevision: undefined }), { code: "INVALID_FUNNEL_INPUT" });
    assert.equal(await f.db.messageSend.count(), 0);
  } finally { await f.close(); }
});


test("automation activation fences the reviewed published version while pausing stays available", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), first = await f.manualJourney(person.subject.id);
    const original = await f.funnels.get(f.principal, first.funnel.id);
    const readiness = await f.funnels.readiness(f.principal, first.funnel.id, "published");
    const draft = original.draft as unknown as FunnelDefinition;
    const updated = await f.funnels.updateDraft(f.principal, first.funnel.id, { draftRevision: original.draftRevision,
      definition: { ...draft, stages: draft.stages.map(stage => ({ ...stage, name: `${stage.name} revised` })) } });
    const next = await f.funnels.publish(f.principal, first.funnel.id, { draftRevision: updated.draftRevision });
    const api = createFunnelApi(f.auth, f.funnels);
    const response = await api(new Request(`${EMAIL_FIXTURE_ORIGIN}/api/funnels/${first.funnel.id}/controls`, {
      method: "PATCH", headers: { cookie: f.cookie, origin: EMAIL_FIXTURE_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ automationEnrolmentEnabled: true, expectedPublishedVersionId: readiness.versionId }),
    }));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "PUBLISHED_VERSION_CHANGED");
    assert.equal((await f.funnels.get(f.principal, first.funnel.id)).automationEnrolmentEnabled, false);
    await f.funnels.controls(f.principal, first.funnel.id, { automationEnrolmentEnabled: true, expectedPublishedVersionId: next.version.id });
    const paused = await f.funnels.controls(f.principal, first.funnel.id, { automationEnrolmentEnabled: false, automationDispatchEnabled: false });
    assert.equal(paused.automationEnrolmentEnabled, false); assert.equal(paused.automationDispatchEnabled, false);
    assert.equal(await f.db.messageSend.count(), 0);
  } finally { await f.close(); }
});
