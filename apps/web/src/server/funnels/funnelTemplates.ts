import { fail } from "../security/errors";
import { validateDefinition, type FunnelDefinition, type FunnelRoute, type FunnelStage } from "./funnelDefinition";

export type FunnelTemplateKind = "blank" | "sales" | "ecommerce" | "events" | "subscription" | "subscription-activation";
export type FunnelTemplateBindings = { primarySourceId: string; bookingSourceId?: string };

function source(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail("INVALID_FUNNEL_TEMPLATE", 400, "Choose a connected source before creating this template.");
  return value;
}
function stage(id: string, name: string, goal = false, terminal: FunnelStage["terminal"] = "NONE"): FunnelStage {
  return { id, name, goal, terminal };
}
function route(id: string, from: string | null, to: string, sourceId: string, type: string): FunnelRoute {
  return { id, from, trigger: { kind: "EVENT", sourceId, type }, branches: [{ id: `${id}-match`, to }], fallback: { kind: "WAIT" } };
}

/** Fresh editable definitions only. Publication still verifies real owned source capabilities. */
export function createFunnelTemplate(kind: FunnelTemplateKind, bindings?: FunnelTemplateBindings): FunnelDefinition {
  if (kind === "blank") return validateDefinition({ schemaVersion: 1,
    stages: [stage("lead", "Lead")], entryStages: ["lead"], routes: [] });
  if (!["sales", "ecommerce", "events", "subscription", "subscription-activation"].includes(kind))
    fail("INVALID_FUNNEL_TEMPLATE", 400, "Choose a supported funnel template.");
  const primary = source(bindings?.primarySourceId);
  if (kind === "subscription-activation") return validateDefinition({ schemaVersion: 1,
    stages: [stage("active", "Subscription active", true)], entryStages: ["active"],
    routes: [route("subscription-activation-entry", null, "active", primary, "custom.fluxsoft.subscription_active")] });
  if (kind === "sales") {
    const booking = bindings?.bookingSourceId === undefined ? undefined : source(bindings.bookingSourceId);
    const stages = [stage("enquiry", "Enquiry received"), ...(booking ? [stage("call", "Call booked")] : []),
      stage("won", "Deal won", true, "SUCCESS"), stage("lost", "Deal lost", false, "FAILURE")];
    const routes = [route("enquiry-entry", null, "enquiry", primary, "enquiry.accepted")];
    if (booking) routes.push(route("call-booked", "enquiry", "call", booking, "booking.confirmed"));
    for (const from of booking ? ["enquiry", "call"] : ["enquiry"]) {
      routes.push(route(`${from}-won`, from, "won", primary, "deal.won"));
      routes.push(route(`${from}-lost`, from, "lost", primary, "deal.lost"));
    }
    return validateDefinition({ schemaVersion: 1, stages, entryStages: ["enquiry"], routes });
  }
  if (kind === "ecommerce") return validateDefinition({ schemaVersion: 1,
    // A successful partial refund does not establish that the entire purchase failed.
    stages: [stage("purchased", "Purchase confirmed", true), stage("refund", "Refund activity")],
    entryStages: ["purchased"], routes: [route("purchase-entry", null, "purchased", primary, "order.paid"),
      route("refund-recorded", "purchased", "refund", primary, "refund.succeeded")] });
  if (kind === "events") return validateDefinition({ schemaVersion: 1,
    stages: [stage("registered", "Registered"), stage("attended", "Attended", true),
      stage("followed-up", "Follow-up complete", false, "SUCCESS"), stage("missed", "Did not attend", false, "FAILURE")],
    entryStages: ["registered"], routes: [route("registration-entry", null, "registered", primary, "custom.event.registered"),
      route("attendance", "registered", "attended", primary, "custom.event.attended"),
      route("no-show", "registered", "missed", primary, "custom.event.missed"),
      route("follow-up", "attended", "followed-up", primary, "custom.event.followed_up")] });
  return validateDefinition({ schemaVersion: 1,
    stages: [stage("trial", "Trial started"), stage("setup", "Setup complete"), stage("activated", "Key feature used"),
      stage("subscribed", "Subscribed", true), stage("cancelled", "Subscription cancelled", false, "FAILURE")],
    entryStages: ["trial"], routes: [route("trial-entry", null, "trial", primary, "custom.trial.started"),
      route("setup-complete", "trial", "setup", primary, "custom.trial.setup"),
      route("activation", "setup", "activated", primary, "custom.trial.feature_used"),
      route("subscription", "activated", "subscribed", primary, "custom.subscription.started"),
      route("cancellation", "subscribed", "cancelled", primary, "custom.subscription.cancelled")] });
}
