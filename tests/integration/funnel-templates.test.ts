import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFunnel, validateDefinition, type FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";
import { createFunnelTemplate, type FunnelTemplateKind } from "../../apps/web/src/server/funnels/funnelTemplates";

function evaluate(definition: FunnelDefinition, currentStage: string | null, type: string, sourceId = "primary") {
  return evaluateFunnel(definition, { currentStage, event: { sourceId, type, properties: {}, occurredAt: "2026-10-17T12:00:00Z" }, properties: {}, changedFields: [] });
}

test("each template is a fresh editable definition with explicit source bindings and no alternate engine", () => {
  for (const kind of ["blank", "sales", "ecommerce", "events", "subscription"] as FunnelTemplateKind[]) {
    const definition = createFunnelTemplate(kind, { primarySourceId: "primary", bookingSourceId: "booking" });
    assert.deepEqual(validateDefinition(definition), definition);
    definition.stages[0].name = "A user's custom stage name";
    assert.equal(validateDefinition(definition).stages[0].name, "A user's custom stage name");
    assert.notEqual(createFunnelTemplate(kind, { primarySourceId: "primary", bookingSourceId: "booking" }).stages[0].name, definition.stages[0].name);
  }
  const blank = createFunnelTemplate("blank");
  assert.equal(blank.stages[0].name, "Lead"); assert.deepEqual(blank.entryStages, ["lead"]); assert.deepEqual(blank.routes, []);
  assert.equal(evaluate(blank, null, "enquiry.accepted").outcome, "WAIT");
  assert.throws(() => createFunnelTemplate("sales"), { code: "INVALID_FUNNEL_TEMPLATE" });
  assert.throws(() => createFunnelTemplate("events", { primarySourceId: "" }), { code: "INVALID_FUNNEL_TEMPLATE" });
});

test("sales booking is optional, source-qualified and does not prevent a direct win or explicit loss", () => {
  const sales = createFunnelTemplate("sales", { primarySourceId: "primary", bookingSourceId: "booking" });
  assert.equal(evaluate(sales, null, "enquiry.accepted").to, "enquiry");
  assert.equal(evaluate(sales, "enquiry", "booking.confirmed", "wrong-booking").outcome, "WAIT");
  assert.equal(evaluate(sales, "enquiry", "booking.confirmed", "booking").to, "call");
  assert.equal(evaluate(sales, "enquiry", "deal.won").to, "won");
  assert.equal(evaluate(sales, "call", "deal.lost").to, "lost");
  const withoutBooking = createFunnelTemplate("sales", { primarySourceId: "primary" });
  assert.equal(withoutBooking.stages.some(stage => stage.id === "call"), false);
  assert.equal(evaluate(withoutBooking, "enquiry", "deal.won").to, "won");
});

test("a user can add an optional stage and redirect a template branch through the same evaluator", () => {
  const edited = createFunnelTemplate("sales", { primarySourceId: "primary" });
  edited.stages.push({ id: "approval", name: "Board approval", goal: false, terminal: "NONE" });
  const won = edited.routes.find(route => route.id === "enquiry-won")!;
  won.branches[0].to = "approval";
  edited.routes.push({ id: "approval-confirmed", from: "approval",
    trigger: { kind: "EVENT", sourceId: "primary", type: "custom.approval.confirmed" },
    branches: [{ id: "confirmed", to: "won" }], fallback: { kind: "WAIT" } });
  const definition = validateDefinition(edited);
  assert.equal(evaluate(definition, "enquiry", "deal.won").to, "approval");
  assert.equal(evaluate(definition, "approval", "custom.approval.confirmed").to, "won");
  assert.equal(evaluate(definition, "enquiry", "custom.approval.confirmed").outcome, "WAIT");
});

test("purchase goal remains open for verified refund evidence without treating a partial refund as full failure", () => {
  const commerce = createFunnelTemplate("ecommerce", { primarySourceId: "primary" });
  assert.equal(evaluate(commerce, null, "order.paid").to, "purchased");
  const purchased = commerce.stages.find(stage => stage.id === "purchased")!;
  assert.equal(purchased.goal, true); assert.equal(purchased.terminal, "NONE");
  assert.equal(evaluate(commerce, "purchased", "refund.created").outcome, "WAIT");
  assert.equal(evaluate(commerce, "purchased", "refund.succeeded").to, "refund");
  assert.equal(commerce.stages.find(stage => stage.id === "refund")!.terminal, "NONE");
  assert.equal(evaluate(commerce, "refund", "order.paid").outcome, "WAIT");
});

test("event and subscription templates require their instrumented custom events in sequence", () => {
  const events = createFunnelTemplate("events", { primarySourceId: "primary" });
  assert.equal(evaluate(events, null, "custom.event.registered").to, "registered");
  assert.equal(evaluate(events, "registered", "custom.event.attended").to, "attended");
  assert.equal(evaluate(events, "attended", "custom.event.followed_up").to, "followed-up");
  const subscription = createFunnelTemplate("subscription", { primarySourceId: "primary" });
  assert.equal(evaluate(subscription, null, "custom.trial.started").to, "trial");
  assert.equal(evaluate(subscription, "trial", "custom.subscription.started").outcome, "WAIT");
  assert.equal(evaluate(subscription, "trial", "custom.trial.setup").to, "setup");
  assert.equal(evaluate(subscription, "setup", "custom.trial.feature_used").to, "activated");
  assert.equal(evaluate(subscription, "activated", "custom.subscription.started").to, "subscribed");
  assert.equal(evaluate(subscription, "subscribed", "custom.subscription.cancelled").to, "cancelled");
});
