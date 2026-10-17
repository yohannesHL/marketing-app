import { evaluateCondition, type JsonSerializable, type Scalar } from "../funnels/funnelDefinition";
import { fail } from "../security/errors";
import type { CampaignWait } from "./campaignDefinition";

export type CampaignWaitPlan = { sequenceAnchorAt: Date; waitStartedAt: Date; waitAnchorAt: Date;
  waitDeadlineAt: Date | null; dueAt: Date | null; expiresAt: Date | null };
const instant = (date: Date) => {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("INVALID_CAMPAIGN_TIME", 400, "Use a valid fixed campaign timestamp.");
  return new Date(date);
};
const plus = (date: Date, seconds: number) => instant(new Date(instant(date).getTime() + seconds * 1000));

/** All anchors come from persisted business state, never from the worker's late wake time. */
export function planCampaignWait(wait: CampaignWait, enrolledAt: Date, sequenceAnchorAt: Date, ttlSeconds: number): CampaignWaitPlan {
  const anchor = instant(sequenceAnchorAt), waitStartedAt = instant(anchor);
  if (wait.kind === "EVENT") return { sequenceAnchorAt: anchor, waitStartedAt,
    waitAnchorAt: instant(wait.anchor === "ENROLLED" ? enrolledAt : anchor), waitDeadlineAt: plus(anchor, wait.timeoutSeconds), dueAt: null, expiresAt: null };
  const dueAt = wait.kind === "DATE" ? instant(new Date(wait.at)) : wait.kind === "DURATION" ? plus(anchor, wait.seconds) : instant(anchor);
  return { sequenceAnchorAt: anchor, waitStartedAt, waitAnchorAt: instant(anchor), waitDeadlineAt: null, dueAt, expiresAt: plus(dueAt, ttlSeconds) };
}
export function successorAnchor(previousAnchor: Date, completedAt: Date) {
  return instant(new Date(Math.max(instant(previousAnchor).getTime(), instant(completedAt).getTime())));
}
export function resolveEventWaitTiming(plan: CampaignWaitPlan, availableAt: Date, ttlSeconds: number) {
  const dueAt = successorAnchor(plan.waitStartedAt, availableAt);
  return { dueAt, expiresAt: plus(dueAt, ttlSeconds) };
}

/** Identity, generation and LIVE provenance admission are checked by the durable service. */
export function eventWaitDecision(wait: Extract<CampaignWait, { kind: "EVENT" }>, plan: CampaignWaitPlan, evidence: {
  sourceId: string; type: string; occurredAt: Date; availableAt: Date; properties: Record<string, Scalar>;
}): { truth: "TRUE" | "FALSE" | "UNKNOWN"; reason: string; trace: JsonSerializable } {
  const unavailable = (reason: string) => ({ truth: "FALSE" as const, reason, trace: { reason } });
  if (evidence.sourceId !== wait.sourceId || evidence.type !== wait.type) return unavailable("EVENT_NOT_CONFIGURED");
  if (!plan.waitDeadlineAt || evidence.occurredAt < plan.waitAnchorAt || evidence.occurredAt >= plan.waitDeadlineAt || evidence.availableAt >= plan.waitDeadlineAt)
    return unavailable("EVENT_OUTSIDE_WAIT_INTERVAL");
  if (!wait.condition) return { truth: "TRUE", reason: "EVENT_MATCHED", trace: { reason: "EVENT_MATCHED" } };
  const result = evaluateCondition(wait.condition, { currentStage: null, properties: {}, changedFields: [],
    event: { sourceId: evidence.sourceId, type: evidence.type, properties: evidence.properties, occurredAt: evidence.occurredAt.toISOString() } });
  return { ...result, reason: result.truth === "TRUE" ? "EVENT_MATCHED" : result.truth === "UNKNOWN" ? "EVENT_CONDITION_UNKNOWN" : "EVENT_CONDITION_FALSE" };
}
