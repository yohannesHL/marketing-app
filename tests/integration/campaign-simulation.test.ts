import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { simulateCampaign } from "../../apps/web/src/server/email/campaignSimulation";
import type { CampaignDefinition, CampaignWait } from "../../apps/web/src/server/email/campaignDefinition";
import { createEmailFixture } from "../support/email-fixture";

const enrolledAt = "2026-10-19T10:00:00Z";
const ready = { consent: true, senderReady: true, dispatchEnabled: true };
function definition(waits: CampaignWait[]): CampaignDefinition {
  return { schemaVersion: 1, senderId: "sample-sender", subscriptionCategory: "consultation", timeZone: "UTC",
    sendWindow: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 },
    steps: waits.map((wait, index) => ({ id: `step-${index}`, subject: "Preview", text: "Sample message", wait, expiresAfterDueSeconds: 60 })) };
}
const eventWait = (anchor: "ENROLLED" | "WAIT_STARTED" = "ENROLLED"): CampaignWait => ({ kind: "EVENT", sourceId: "crm-source",
  type: "custom.booking", anchor, timeoutSeconds: 60, onTimeout: "SKIP_STEP",
  condition: { field: { scope: "EVENT", key: "approved" }, type: "boolean", op: "eq", value: true } });
const evidence = { sourceId: "crm-source", type: "custom.booking", occurredAt: "2026-10-19T10:00:10Z",
  availableAt: "2026-10-19T10:00:20Z", properties: { approved: true }, mode: "LIVE" };
const iso = (value: unknown) => { assert.ok(value instanceof Date); return value.toISOString(); };

test("late simulation uses original duration expiry and never rewinds a successor after a past DATE", () => {
  const draft = definition([{ kind: "DURATION", seconds: 60 }, { kind: "DATE", at: "2026-10-19T09:00:00Z" }, { kind: "DURATION", seconds: 120 }]);
  draft.steps[2].expiresAfterDueSeconds = 86400;
  const result = simulateCampaign(draft, { enrolledAt, now: "2026-10-19T13:00:00Z", eligibility: ready });
  assert.deepEqual(result.history.map(row => row.status), ["SKIPPED", "SKIPPED", "READY"]);
  assert.equal(iso(result.history[0].completedAt), "2026-10-19T10:02:00.000Z");
  assert.equal(iso(result.history[1].completedAt), "2026-10-19T09:01:00.000Z");
  assert.equal(iso(result.history[2].dueAt), "2026-10-19T10:04:00.000Z");
  assert.equal(result.externalEffects, false);
});

test("event samples use LIVE same-subject current-source evidence and an exclusive availability deadline", () => {
  const draft = definition([eventWait()]);
  const preview = (events: unknown[], now = "2026-10-19T10:00:30Z") => simulateCampaign(draft, { enrolledAt, now, eligibility: ready, events }).history[0];
  for (const rejected of [{ ...evidence, mode: "BACKFILL" }, { ...evidence, mode: "REPLAY" }, { ...evidence, sameSubject: false },
    { ...evidence, sourceCurrent: false }, { ...evidence, properties: {} }, { ...evidence, properties: { approved: false } },
    { ...evidence, sourceId: "another-source" }, { ...evidence, type: "another.event" }]) {
    assert.equal(preview([rejected]).status, "WAITING");
  }
  const admitted = preview([{ ...evidence, properties: {} }, evidence]);
  assert.equal(admitted.status, "READY"); assert.equal(admitted.evidenceSample, 2);
  assert.equal(iso(admitted.dueAt), "2026-10-19T10:00:20.000Z");
  assert.equal(iso(admitted.expiresAt), "2026-10-19T10:01:20.000Z");
  for (const atDeadline of [{ ...evidence, availableAt: "2026-10-19T10:01:00Z" }, { ...evidence, occurredAt: "2026-10-19T10:01:00Z", availableAt: "2026-10-19T10:01:00Z" }]) {
    const timedOut = preview([atDeadline], "2026-10-19T10:01:00Z");
    assert.equal(timedOut.status, "SKIPPED"); assert.equal(timedOut.reason, "EVENT_TIMEOUT");
    assert.equal(iso(timedOut.completedAt), "2026-10-19T10:01:00.000Z");
  }
});

test("ENROLLED evidence can precede a later wait while timeout always begins at the preceding completion", () => {
  const draft = definition([{ kind: "IMMEDIATE" }, eventWait()]);
  draft.steps[0].expiresAfterDueSeconds = 600;
  const input = { enrolledAt, now: "2026-10-19T10:05:30Z", eligibility: ready, acceptedAtByStep: { "step-0": "2026-10-19T10:05:00Z" }, events: [evidence] };
  const result = simulateCampaign(draft, input);
  assert.deepEqual(result.history.map(row => row.status), ["ACCEPTED", "READY"]);
  assert.equal(iso(result.history[1].dueAt), "2026-10-19T10:05:00.000Z");
  assert.equal(iso(result.history[1].waitDeadlineAt), "2026-10-19T10:06:00.000Z");
  draft.steps[1].wait = eventWait("WAIT_STARTED");
  assert.equal(simulateCampaign(draft, input).history[1].status, "WAITING");
  const timeout = simulateCampaign(draft, { ...input, now: "2026-10-19T10:06:00Z" }).history[1];
  assert.equal(timeout.status, "SKIPPED"); assert.equal(iso(timeout.completedAt), "2026-10-19T10:06:00.000Z");
});

test("historical acceptance survives current pause, consent changes and stop, including a response after expiry", () => {
  const draft = definition([{ kind: "IMMEDIATE" }, { kind: "IMMEDIATE" }]);
  const input = { enrolledAt, now: "2026-10-19T10:02:30Z", acceptedAtByStep: { "step-0": "2026-10-19T10:02:00Z" } };
  for (const eligibility of [{ ...ready, dispatchEnabled: false }, { ...ready, consent: false }, { ...ready, senderReady: false }, { ...ready, stopped: true }]) {
    const result = simulateCampaign(draft, { ...input, eligibility });
    assert.equal(result.history[0].status, "ACCEPTED");
    assert.equal(iso(result.history[1].dueAt), "2026-10-19T10:02:00.000Z");
    assert.equal(result.history[1].status, "stopped" in eligibility ? "CANCELLED" : "BLOCKED");
  }
  const afterWindow = simulateCampaign(draft, { enrolledAt: "2026-10-19T16:59:00Z", now: "2026-10-19T17:01:00Z", eligibility: ready,
    acceptedAtByStep: { "step-0": "2026-10-19T17:00:30Z" } });
  assert.equal(afterWindow.history[0].status, "ACCEPTED", "The provider response timestamp does not claim the request happened outside its window");
  for (const sample of ["2026-10-19T09:59:59Z", "2026-10-19T10:03:00Z"]) {
    assert.throws(() => simulateCampaign(draft, { ...input, eligibility: ready, acceptedAtByStep: { "step-0": sample } }), { code: "INVALID_SIMULATION" });
  }
});

test("pause cannot move an expiry, unavailable wait sources block timeout, and stopped runs end the preview", () => {
  const draft = definition([{ kind: "IMMEDIATE" }, { kind: "DURATION", seconds: 120 }]);
  draft.steps[1].expiresAfterDueSeconds = 3600;
  const paused = simulateCampaign(draft, { enrolledAt, now: "2026-10-19T10:02:00Z", eligibility: { ...ready, dispatchEnabled: false } });
  assert.deepEqual(paused.history.map(row => row.status), ["SKIPPED", "WAITING"]);
  assert.equal(iso(paused.history[1].dueAt), "2026-10-19T10:03:00.000Z");
  const waiting = definition([eventWait()]);
  const unavailable = simulateCampaign(waiting, { enrolledAt, now: "2026-10-19T11:00:00Z", eligibility: { ...ready, waitSourceCurrent: false }, events: [evidence] }).history[0];
  assert.equal(unavailable.status, "BLOCKED"); assert.equal(unavailable.reason, "WAIT_SOURCE_UNAVAILABLE");
  assert.equal(iso(unavailable.waitDeadlineAt), "2026-10-19T10:01:00.000Z");
  if (waiting.steps[0].wait.kind !== "EVENT") throw new Error("Expected EVENT");
  waiting.steps[0].wait.onTimeout = "STOP_MEMBERSHIP";
  assert.equal(simulateCampaign(waiting, { enrolledAt, now: "2026-10-19T10:01:00Z", eligibility: ready }).history[0].reason, "EVENT_TIMEOUT_STOP");
  const stopped = simulateCampaign(draft, { enrolledAt, now: enrolledAt, eligibility: { ...ready, stopped: true } });
  assert.equal(stopped.history.length, 1); assert.equal(stopped.history[0].status, "CANCELLED");
});

test("send-window preview handles repeated and missing local times without changing fixed due time", () => {
  const draft = definition([{ kind: "IMMEDIATE" }]);
  draft.timeZone = "Europe/London"; draft.sendWindow = { timeZone: "Europe/London", weekdays: [7], startMinute: 90, endMinute: 150 };
  draft.steps[0].expiresAfterDueSeconds = 86400;
  const fold = simulateCampaign(draft, { enrolledAt: "2026-10-25T00:45:00Z", now: "2026-10-25T00:45:00Z", eligibility: ready }).history[0];
  assert.equal(fold.status, "WAITING"); assert.equal(fold.nextWakeAt, "2026-10-25T01:30:00.000Z");
  assert.equal(iso(fold.dueAt), "2026-10-25T00:45:00.000Z");
  const gap = simulateCampaign(draft, { enrolledAt: "2026-03-29T00:45:00Z", now: "2026-03-29T00:45:00Z", eligibility: ready }).history[0];
  assert.equal(gap.nextWakeAt, "2026-03-29T01:00:00.000Z");
  const open = simulateCampaign(draft, { enrolledAt: "2026-10-25T00:45:00Z", now: "2026-10-25T01:30:00Z", eligibility: ready }).history[0];
  assert.equal(open.status, "READY"); assert.equal(open.reason, "AWAITING_SIMULATED_ACCEPTANCE");
});

test("public campaign preview is owner-scoped and makes zero database writes or provider calls", async () => {
  const f = await createEmailFixture();
  try {
    const draft = f.definition(randomUUID()), foreign = await f.owner();
    draft.steps[0].wait = { kind: "DURATION", seconds: 60 };
    const campaign = await f.campaigns.create(f.principal, { name: "Unpublished preview", environment: "TEST", definition: draft });
    const before = await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), requestCount = f.requests.length;
    const input = { enrolledAt, now: enrolledAt, eligibility: ready };
    const result = await f.campaigns.simulate(f.principal, campaign.id, input);
    assert.equal(result.history[0].status, "WAITING");
    const override = structuredClone(draft); override.steps[0].wait = { kind: "IMMEDIATE" };
    assert.equal((await f.campaigns.simulate(f.principal, campaign.id, { ...input, definition: override })).history[0].status, "READY");
    await assert.rejects(f.campaigns.simulate(foreign.principal, campaign.id, input), { code: "NOT_FOUND" });
    await assert.rejects(f.campaigns.simulate(f.principal, campaign.id, { ...input, now: "2026-10-19T09:00:00Z" }), { code: "INVALID_SIMULATION" });
    assert.deepEqual(await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), before);
    assert.equal(f.requests.length, requestCount); assert.equal(await f.db.messageSend.count(), 0);
    assert.equal(await f.db.campaignStepExecution.count(), 0); assert.equal(await f.db.campaignMembership.count(), 0);
    assert.deepEqual((await f.campaigns.get(f.principal, campaign.id)).draft, campaign.draft);
  } finally { await f.close(); }
});
