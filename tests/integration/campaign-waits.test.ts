import assert from "node:assert/strict";
import test from "node:test";
import { validateCampaignDefinition, assertCampaignExecutionSupported } from "../../apps/web/src/server/email/campaignDefinition";

const definition = (wait: unknown) => ({ schemaVersion: 1, senderId: "sender", subscriptionCategory: "consultation", steps: [
  { id: "reminder", subject: "Your booking", text: "See you soon", wait, expiresAfterDueSeconds: 3600 },
] });

test("campaign definitions allow typed EVENT waits and reject unhistorical property predicates", () => {
  const wait = { kind: "EVENT", sourceId: "calendar", type: "booking.created", anchor: "ENROLLED", timeoutSeconds: 86400,
    onTimeout: "SKIP_STEP", condition: { field: { scope: "EVENT", key: "approved" }, type: "boolean", op: "eq", value: true } };
  const valid = validateCampaignDefinition(definition(wait));
  assert.deepEqual(valid.steps[0].wait, wait);
  assert.doesNotThrow(() => assertCampaignExecutionSupported(valid));
  assert.throws(() => validateCampaignDefinition(definition({ ...wait, condition: { ...wait.condition,
    field: { scope: "PROPERTY", sourceId: "crm", type: "custom.score", key: "approved" } } })), { code: "UNSUPPORTED_CAMPAIGN_WAIT_CONDITION" });
  for (const patch of [{ anchor: "ANYTIME" }, { timeoutSeconds: 0 }, { onTimeout: "SEND_ANYWAY" }, { contactId: "arbitrary" }])
    assert.throws(() => validateCampaignDefinition(definition({ ...wait, ...patch })));
});

test("event search anchor does not change timeout and delayed processing cannot reset due or expiry", async () => {
  const { planCampaignWait, eventWaitDecision, resolveEventWaitTiming, successorAnchor } = await import("../../apps/web/src/server/email/campaignWait");
  const enrolled = new Date("2026-10-19T10:00:00Z"), started = new Date("2026-10-21T10:00:00Z");
  const wait = { kind: "EVENT" as const, sourceId: "bookings", type: "booking.created", anchor: "ENROLLED" as const,
    timeoutSeconds: 3600, onTimeout: "SKIP_STEP" as const };
  const plan = planCampaignWait(wait, enrolled, started, 600);
  assert.equal(plan.waitAnchorAt.toISOString(), "2026-10-19T10:00:00.000Z");
  assert.equal(plan.waitDeadlineAt!.toISOString(), "2026-10-21T11:00:00.000Z");
  const evidence = { sourceId: "bookings", type: "booking.created", occurredAt: new Date("2026-10-20T09:00:00Z"),
    availableAt: new Date("2026-10-20T09:01:00Z"), properties: {} };
  assert.equal(eventWaitDecision(wait, plan, evidence).truth, "TRUE");
  assert.equal(eventWaitDecision({ ...wait, anchor: "WAIT_STARTED" }, planCampaignWait({ ...wait, anchor: "WAIT_STARTED" }, enrolled, started, 600), evidence).truth, "FALSE");
  for (const edge of [{ ...evidence, occurredAt: plan.waitDeadlineAt! }, { ...evidence, availableAt: plan.waitDeadlineAt! }])
    assert.equal(eventWaitDecision(wait, plan, edge).truth, "FALSE");
  const resolved = resolveEventWaitTiming(plan, evidence.availableAt, 600);
  assert.equal(resolved.dueAt.toISOString(), "2026-10-21T10:00:00.000Z");
  assert.equal(resolved.expiresAt.toISOString(), "2026-10-21T10:10:00.000Z");
  assert.equal(successorAnchor(started, new Date("2026-10-20T00:00:00Z")).toISOString(), "2026-10-21T10:00:00.000Z");
});
