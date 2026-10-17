import type { FunnelDefinition, FunnelStageAction } from "./funnelDefinition";

/** Used by both committed transitions and dry-run previews. Empty historical plans stay empty. */
export function captureStageActions(definition: FunnelDefinition, stageId: string, mode: string, enrolmentEnabled: boolean, manual = false) {
  const actions = manual ? [] : (definition.stageActions ?? []).filter(action => action.stageId === stageId &&
    (action.kind === "EMAIL_STOP" || mode === "LIVE" && enrolmentEnabled));
  const effectEligibility = manual || !(definition.stageActions?.length) ? "TRACKING_ONLY" as const :
    actions.some(action => action.kind === "EMAIL_ENROLL") ? "AUTOMATION" as const : "CANCELLATION_ONLY" as const;
  return { actions, effectEligibility };
}

export function stageActionTiming(action: FunnelStageAction, recordedAt: Date) {
  const dueAt = new Date(recordedAt.getTime() + (action.kind === "EMAIL_ENROLL" ? action.delaySeconds : 0) * 1000);
  const expiresAt = action.kind === "EMAIL_ENROLL" ? new Date(dueAt.getTime() + action.expiresAfterDueSeconds * 1000) : null;
  return { dueAt, expiresAt };
}
