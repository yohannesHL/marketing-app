import { fail } from "../security/errors";
import { fields, object, properties, timestamp } from "../funnels/trackingValidation";
import { validateCampaignDefinition, type CampaignDefinition } from "./campaignDefinition";
import { eventWaitDecision, planCampaignWait, resolveEventWaitTiming, successorAnchor } from "./campaignWait";
import { nextSendAt } from "./emailTiming";

/** A pure fake-clock preview. Provider acceptance must be supplied explicitly as a sample. */
export function simulateCampaign(definition: CampaignDefinition, value: unknown) {
  const input = object(value); fields(input, ["definition", "enrolledAt", "now", "events", "acceptedAtByStep", "eligibility"]);
  const draft = validateCampaignDefinition(definition), enrolledAt = new Date(timestamp(input.enrolledAt)), now = new Date(timestamp(input.now));
  if (now < enrolledAt) fail("INVALID_SIMULATION", 400, "The preview clock must be at or after enrollment.");
  const eligibility = object(input.eligibility ?? {}); fields(eligibility, ["consent", "senderReady", "dispatchEnabled", "stopped", "waitSourceCurrent"]);
  for (const flag of Object.values(eligibility)) if (typeof flag !== "boolean") fail("INVALID_SIMULATION", 400, "Use explicit eligibility booleans.");
  const accepted = object(input.acceptedAtByStep ?? {});
  if (Object.keys(accepted).some(key => !draft.steps.some(step => step.id === key))) fail("INVALID_SIMULATION", 400, "Acceptance samples must name a configured step.");
  const acceptedAt = new Map(Object.entries(accepted).map(([key, at]) => [key, new Date(timestamp(at))]));
  if (!Array.isArray(input.events ?? []) || (input.events as unknown[] | undefined)?.length! > 100) fail("INVALID_SIMULATION", 400, "Use at most 100 event samples.");
  const events = ((input.events ?? []) as unknown[]).map((value, index) => {
    const e = object(value); fields(e, ["sourceId", "type", "occurredAt", "availableAt", "properties", "mode", "sameSubject", "sourceCurrent"]);
    if (typeof e.sourceId !== "string" || typeof e.type !== "string" || !["LIVE", "BACKFILL", "REPLAY"].includes(String(e.mode ?? "LIVE")) ||
      e.sameSubject !== undefined && typeof e.sameSubject !== "boolean" || e.sourceCurrent !== undefined && typeof e.sourceCurrent !== "boolean")
      fail("INVALID_SIMULATION", 400, "Provide explicit event identity and provenance samples.");
    const values = object(e.properties ?? {});
    return { sourceId: e.sourceId as string, type: e.type as string, occurredAt: new Date(timestamp(e.occurredAt)), availableAt: new Date(timestamp(e.availableAt)),
      properties: properties(values, Object.keys(values)), mode: e.mode ?? "LIVE", sameSubject: e.sameSubject !== false, sourceCurrent: e.sourceCurrent !== false, index };
  }).sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.occurredAt.getTime() - b.occurredAt.getTime() || a.index - b.index);
  const history: Record<string, unknown>[] = []; let anchor = enrolledAt;
  for (const step of draft.steps) {
    const plan = planCampaignWait(step.wait, enrolledAt, anchor, step.expiresAfterDueSeconds);
    const row: Record<string, unknown> = { stepId: step.id, wait: step.wait, ...plan, simulated: true };
    const push = (status: string, reason: string, extra: Record<string, unknown> = {}) => history.push({ ...row, status, reason, ...extra });
    if (eligibility.stopped && !acceptedAt.has(step.id)) { push("CANCELLED", "SIMULATED_STOP"); break; }
    let dueAt = plan.dueAt, expiresAt = plan.expiresAt;
    if (step.wait.kind === "EVENT") {
      if (eligibility.waitSourceCurrent === false && !acceptedAt.has(step.id)) { push("BLOCKED", "WAIT_SOURCE_UNAVAILABLE"); break; }
      const wait = step.wait;
      const evidence = events.find(e => e.mode === "LIVE" && e.sameSubject && e.sourceCurrent && e.availableAt <= now && eventWaitDecision(wait, plan, e).truth === "TRUE");
      if (evidence) {
        ({ dueAt, expiresAt } = resolveEventWaitTiming(plan, evidence.availableAt, step.expiresAfterDueSeconds));
        Object.assign(row, { dueAt, expiresAt, evidenceSample: evidence.index + 1, evidenceAvailableAt: evidence.availableAt });
      } else if (now < plan.waitDeadlineAt!) { push("WAITING", "WAITING_FOR_EVENT"); break; }
      else if (wait.onTimeout === "STOP_MEMBERSHIP") { push("CANCELLED", "EVENT_TIMEOUT_STOP", { completedAt: plan.waitDeadlineAt }); break; }
      else { push("SKIPPED", "EVENT_TIMEOUT", { completedAt: plan.waitDeadlineAt }); anchor = successorAnchor(anchor, plan.waitDeadlineAt!); continue; }
    }
    const acceptance = acceptedAt.get(step.id);
    if (acceptance) {
      if (acceptance < dueAt! || acceptance > now) fail("INVALID_SIMULATION", 400, "Sample acceptance must be at or after the step due time and no later than the preview clock.");
      // Submission is fenced by the window/expiry. A factual acceptance can arrive
      // afterward, including after a stop, and must remain part of history.
      push("ACCEPTED", "SUPPLIED_ACCEPTANCE_SAMPLE", { completedAt: acceptance }); anchor = successorAnchor(anchor, acceptance); continue;
    }
    if (now >= expiresAt!) { push("SKIPPED", "SEND_EXPIRED", { completedAt: expiresAt }); anchor = successorAnchor(anchor, expiresAt!); continue; }
    if (now < dueAt!) { push("WAITING", "WAIT_NOT_DUE"); break; }
    if (!eligibility.consent || !eligibility.senderReady || !eligibility.dispatchEnabled) {
      push("BLOCKED", !eligibility.consent ? "SIMULATED_CONSENT_REQUIRED" : !eligibility.senderReady ? "SIMULATED_SENDER_NOT_READY" : "SIMULATED_DISPATCH_PAUSED"); break;
    }
    const window = nextSendAt(now.toISOString(), draft.sendWindow, expiresAt!.toISOString());
    if ("expired" in window) { push("SKIPPED", "NO_SEND_WINDOW_BEFORE_EXPIRY", { completedAt: expiresAt }); anchor = successorAnchor(anchor, expiresAt!); continue; }
    push(new Date(window.at) > now ? "WAITING" : "READY", new Date(window.at) > now ? "NEXT_SEND_WINDOW" : "AWAITING_SIMULATED_ACCEPTANCE", { nextWakeAt: window.at }); break;
  }
  return { simulated: true, externalEffects: false, now: now.toISOString(), history,
    note: "Sample identity, eligibility and acceptance only. This preview does not check a live provider or create a send." };
}
