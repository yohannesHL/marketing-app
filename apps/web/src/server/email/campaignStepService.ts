import type { Prisma, PrismaClient, CampaignMembership, CampaignStep, CampaignStepExecution } from "../../generated/prisma/client";
import type { Scalar } from "../funnels/funnelDefinition";
import { fail } from "../security/errors";
import { emailJson, settleEmailMembership, stopEmailMembership } from "./emailPolicy";
import type { CampaignWait } from "./campaignDefinition";
import { eventWaitDecision, planCampaignWait, resolveEventWaitTiming, successorAnchor } from "./campaignWait";

type Tx = Prisma.TransactionClient;
export type FirstStepAuthorization = { kind: "MANUAL"; requestKey: string; requestDigest: string; actorId: string; reason: string }
  | { kind: "STAGE"; actionExecutionId: string };
export type StepProgress = { executionId: string; membershipId: string; status: string; reason?: string;
  dueAt: string | null; expiresAt: string | null; nextWakeAt: string | null };
const terminal = new Set(["ACCEPTED", "SKIPPED", "CANCELLED", "FAILED"]);
const progress = (step: CampaignStepExecution): StepProgress => ({ executionId: step.id, membershipId: step.membershipId,
  status: step.status, ...(step.reason ? { reason: step.reason } : {}), dueAt: step.dueAt?.toISOString() ?? null,
  expiresAt: step.expiresAt?.toISOString() ?? null, nextWakeAt: step.nextWakeAt?.toISOString() ?? null });
const wake = (now: Date, deadline?: Date | null, delay = 1000) => new Date(Math.min(now.getTime() + delay, deadline?.getTime() ?? Infinity));
const dataScope = (membership: CampaignMembership) => ({ ownerId: membership.ownerId, environment: membership.environment,
  membershipId: membership.id, revisionId: membership.revisionId });

async function context(tx: Tx, executionId: string) {
  const execution = await tx.campaignStepExecution.findUnique({ where: { id: executionId } });
  if (!execution) fail("NOT_FOUND", 404, "Campaign step execution not found.");
  const membership = await tx.campaignMembership.findUniqueOrThrow({ where: { id: execution.membershipId } });
  const step = await tx.campaignStep.findUniqueOrThrow({ where: { id: execution.stepId } });
  if (membership.revisionId !== execution.revisionId || step.revisionId !== execution.revisionId || membership.ownerId !== execution.ownerId ||
    step.ownerId !== execution.ownerId || membership.environment !== execution.environment || step.environment !== execution.environment)
    fail("CAMPAIGN_STEP_BINDING_INVALID", 409, "The execution does not match its pinned campaign.");
  return { execution, membership, step };
}

async function initialize(tx: Tx, membership: CampaignMembership, step: CampaignStep, sequenceAnchorAt: Date,
  authorization: FirstStepAuthorization | { kind: "CONTINUATION"; previousExecutionId: string }, now: Date) {
  const wait = step.wait as CampaignWait, plan = planCampaignWait(wait, membership.startedAt, sequenceAnchorAt, step.expiresAfterDueSeconds);
  const source = wait.kind === "EVENT" ? await tx.trackingSource.findFirst({ where: { id: wait.sourceId, ownerId: membership.ownerId, environment: membership.environment } }) : null;
  if (wait.kind === "EVENT" && (!source || membership.scopeKind !== "SUBJECT" || !membership.subjectId))
    fail("CAMPAIGN_EVENT_SOURCE_UNAVAILABLE", 409, "The pinned event wait needs its owned subject and source.");
  return tx.campaignStepExecution.create({ data: { ...dataScope(membership), stepId: step.id, ...plan,
    authorizationKind: authorization.kind,
    ...(authorization.kind === "MANUAL" ? { authorizationRequestKey: authorization.requestKey, authorizationRequestDigest: authorization.requestDigest,
      authorizationActorId: authorization.actorId, authorizationReason: authorization.reason } : authorization.kind === "STAGE" ?
      { authorizationActionExecutionId: authorization.actionExecutionId } : { previousExecutionId: authorization.previousExecutionId }),
    ...(source ? { waitSourceId: source.id, sourceGeneration: source.generation } : {}),
    status: "WAITING", nextWakeAt: wait.kind === "EVENT" ? now : plan.dueAt, createdAt: now } });
}

/** Only an explicit customer start or a newly authorized stage-created member can create the first row. */
export async function ensureFirstStepTx(tx: Tx, membershipId: string, authorization: FirstStepAuthorization, now: Date) {
  const membership = await tx.campaignMembership.findUniqueOrThrow({ where: { id: membershipId } });
  if (authorization.kind === "MANUAL") {
    if (authorization.actorId !== membership.ownerId || !authorization.requestKey || authorization.requestKey.length > 128 ||
      !/^[a-f0-9]{64}$/.test(authorization.requestDigest) || !authorization.reason.trim() || authorization.reason.length > 500)
      fail("INVALID_CAMPAIGN_START", 400, "Record the owned explicit start command and reason.");
    const command = await tx.campaignStepExecution.findFirst({ where: { ownerId: membership.ownerId, environment: membership.environment,
      authorizationRequestKey: authorization.requestKey } });
    if (command) {
      if (command.membershipId !== membershipId || command.authorizationRequestDigest !== authorization.requestDigest)
        fail("IDEMPOTENCY_CONFLICT", 409, "This cadence start key was used for another request.");
      return command;
    }
  } else {
    const action = await tx.funnelActionExecution.findFirst({ where: { id: authorization.actionExecutionId, membershipId,
      ownerId: membership.ownerId, environment: membership.environment, kind: "EMAIL_ENROLL", mode: "LIVE", status: { in: ["PENDING", "APPLIED"] } } });
    if (!action) fail("CAMPAIGN_START_UNAUTHORIZED", 409, "The stage action cannot authorize this cadence.");
  }
  const previous = await tx.campaignStepExecution.findFirst({ where: { membershipId }, orderBy: { createdAt: "asc" } });
  if (previous) {
    if (authorization.kind === "STAGE" && previous.authorizationActionExecutionId === authorization.actionExecutionId) return previous;
    fail("CADENCE_ALREADY_STARTED", 409, "This membership already has an authorized cadence.");
  }
  if (membership.status !== "ACTIVE" || membership.endedAt) fail("MEMBERSHIP_INACTIVE", 409, "Start an active membership; new cycles require explicit enrolment.");
  const first = await tx.campaignStep.findFirst({ where: { revisionId: membership.revisionId, position: 0 } });
  if (!first) fail("EMAIL_STEP_UNAVAILABLE", 409, "This pinned campaign has no first step.");
  let execution = await initialize(tx, membership, first, membership.startedAt, authorization, now);
  const existingSend = await tx.messageSend.findFirst({ where: { membershipId, stepId: first.id, iteration: 1 } });
  if (existingSend) {
    if (!execution.dueAt || !execution.expiresAt || existingSend.dueAt.getTime() !== execution.dueAt.getTime() ||
      existingSend.expiresAt.getTime() !== execution.expiresAt.getTime() || existingSend.revisionId !== execution.revisionId)
      fail("CAMPAIGN_STEP_BINDING_INVALID", 409, "The existing manual send cannot be rebound to a different wait.");
    execution = await tx.campaignStepExecution.update({ where: { id: execution.id }, data: { sendId: existingSend.id, status: "SEND_PENDING",
      resolvedAt: execution.dueAt, nextWakeAt: null, revision: { increment: 1 } } });
    await syncStepFromSendTx(tx, existingSend.id, now);
    return tx.campaignStepExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }
  return execution;
}

async function continueOrComplete(tx: Tx, execution: CampaignStepExecution, now: Date) {
  if (!["ACCEPTED", "SKIPPED"].includes(execution.status) || !execution.completedAt || execution.redactedAt) return;
  const { membership, step } = await context(tx, execution.id);
  if (membership.status !== "ACTIVE" || membership.endedAt) return;
  const next = await tx.campaignStep.findFirst({ where: { revisionId: execution.revisionId, position: step.position + 1 } });
  if (next) {
    if (!await tx.campaignStepExecution.findFirst({ where: { membershipId: membership.id, stepId: next.id, iteration: execution.iteration } }))
      await initialize(tx, membership, next, successorAnchor(execution.sequenceAnchorAt, execution.completedAt),
        { kind: "CONTINUATION", previousExecutionId: execution.id }, now);
    return;
  }
  const steps = await tx.campaignStep.count({ where: { revisionId: execution.revisionId } });
  const finished = await tx.campaignStepExecution.count({ where: { membershipId: membership.id, revisionId: execution.revisionId,
    iteration: 1, status: { in: ["ACCEPTED", "SKIPPED"] } } });
  if (finished === steps) {
    await tx.campaignMembership.update({ where: { id: membership.id }, data: { status: "COMPLETED", revision: { increment: 1 } } });
    await settleEmailMembership(tx, membership.id, now);
  }
}

async function finish(tx: Tx, execution: CampaignStepExecution, status: "SKIPPED" | "CANCELLED" | "FAILED", reason: string, completedAt: Date, now: Date) {
  if (terminal.has(execution.status)) return execution;
  const updated = await tx.campaignStepExecution.update({ where: { id: execution.id }, data: { status, reason, completedAt,
    resolvedAt: execution.resolvedAt ?? completedAt, nextWakeAt: null, revision: { increment: 1 } } });
  await continueOrComplete(tx, updated, now); return updated;
}

/** Synchronize factual delivery outcomes; never seed missing authority or retry provider work. */
export async function syncStepFromSendTx(tx: Tx, sendId: string, now: Date): Promise<StepProgress | null> {
  const execution = await tx.campaignStepExecution.findUnique({ where: { sendId } });
  if (!execution) return null;
  if (terminal.has(execution.status)) return progress(execution);
  const send = await tx.messageSend.findUniqueOrThrow({ where: { id: sendId } });
  if (send.status === "ACCEPTED" && send.acceptedAt) {
    const updated = await tx.campaignStepExecution.update({ where: { id: execution.id }, data: { status: "ACCEPTED", reason: "PROVIDER_ACCEPTED",
      completedAt: send.acceptedAt, nextWakeAt: null, revision: { increment: 1 } } });
    await continueOrComplete(tx, updated, now); return progress(updated);
  }
  const uncertain = ["SUBMITTING", "UNKNOWN"].includes(send.status) || !!await tx.deliveryAttempt.findFirst({ where: { sendId, outcome: "IN_FLIGHT" } });
  if (uncertain) return progress(execution);
  if (send.status === "EXPIRED") return progress(await finish(tx, execution, "SKIPPED", "SEND_EXPIRED", send.expiresAt, now));
  if (["CANCELLED", "SUPPRESSED"].includes(send.status)) return progress(await finish(tx, execution, "CANCELLED", "SEND_CANCELLED", send.cancelRequestedAt ?? now, now));
  if (send.status === "FAILED" && !send.nextAttemptAt) return progress(await finish(tx, execution, "FAILED", "SEND_FAILED", now, now));
  return progress(execution);
}

async function resolveEvent(tx: Tx, execution: CampaignStepExecution, membership: CampaignMembership, step: CampaignStep, now: Date) {
  const wait = step.wait as Extract<CampaignWait, { kind: "EVENT" }>;
  const source = await tx.trackingSource.findUnique({ where: { id: execution.waitSourceId! } });
  if (!source || source.status !== "ACTIVE" || source.generation !== execution.sourceGeneration)
    return tx.campaignStepExecution.update({ where: { id: execution.id }, data: { reason: "WAIT_SOURCE_UNAVAILABLE",
      nextWakeAt: wake(now, null, 60_000), revision: { increment: 1 } } });
  let cursor: { createdAt: Date; id: string } | undefined;
  let unknown = false, winner: { receipt: { id: string; eventId: string; matchRevision: number; createdAt: Date }; trace: unknown } | undefined;
  // Search all durable candidates in bounded pages before deciding timeout; a page limit must not invent absence.
  for (;;) {
    const receipts = await tx.funnelEvaluationReceipt.findMany({ where: { ownerId: execution.ownerId, environment: execution.environment,
      subjectId: membership.subjectId!, mode: "LIVE", sourceGeneration: execution.sourceGeneration,
      createdAt: { lt: execution.waitDeadlineAt! },
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
      event: { status: "MATCHED", subjectId: membership.subjectId!, sourceId: wait.sourceId, sourceGeneration: execution.sourceGeneration!,
        type: wait.type, occurredAt: { gte: execution.waitAnchorAt, lt: execution.waitDeadlineAt! } } },
      include: { event: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 });
    for (const receipt of receipts) {
      const properties = (receipt.event.envelope as { properties?: Record<string, Scalar> }).properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      const decision = eventWaitDecision(wait, execution, { sourceId: receipt.event.sourceId, type: receipt.event.type,
        occurredAt: receipt.event.occurredAt, availableAt: receipt.createdAt, properties });
      if (decision.truth === "TRUE") { winner = { receipt, trace: { reason: decision.reason, truth: decision.truth } }; break; }
      if (decision.truth === "UNKNOWN") unknown = true;
    }
    if (winner || receipts.length < 200) break;
    const last = receipts.at(-1)!; cursor = { createdAt: last.createdAt, id: last.id };
  }
  if (winner) {
    const timing = resolveEventWaitTiming(execution, winner.receipt.createdAt, step.expiresAfterDueSeconds);
    return tx.campaignStepExecution.update({ where: { id: execution.id }, data: { ...timing, status: "READY", reason: "EVENT_MATCHED",
      receiptId: winner.receipt.id, eventId: winner.receipt.eventId, matchRevision: winner.receipt.matchRevision,
      evidenceAvailableAt: winner.receipt.createdAt, resolvedAt: timing.dueAt, evaluationTrace: emailJson(winner.trace),
      nextWakeAt: timing.dueAt, revision: { increment: 1 } } });
  }
  if (now >= execution.waitDeadlineAt!) {
    if (wait.onTimeout === "STOP_MEMBERSHIP") {
      // Freeze the timeout outcome before shared cancellation walks the still-pending steps.
      const result = await finish(tx, execution, "CANCELLED", "EVENT_TIMEOUT_STOP", execution.waitDeadlineAt!, now);
      await stopEmailMembership(tx, membership.id, "EVENT_TIMEOUT", now); return result;
    }
    return finish(tx, execution, "SKIPPED", "EVENT_TIMEOUT", execution.waitDeadlineAt!, now);
  }
  return tx.campaignStepExecution.update({ where: { id: execution.id }, data: { reason: unknown ? "EVENT_CONDITION_UNKNOWN" : "WAITING_FOR_EVENT",
    nextWakeAt: wake(now, execution.waitDeadlineAt), revision: { increment: 1 } } });
}

/** Local state only. A dispatch pause does not reset clocks or stop expiry bookkeeping. */
export async function advanceCurrentStepTx(tx: Tx, executionId: string, now: Date): Promise<StepProgress> {
  let { execution, membership, step } = await context(tx, executionId);
  if (terminal.has(execution.status)) return progress(execution);
  if (execution.sendId) { await syncStepFromSendTx(tx, execution.sendId, now); return progress(await tx.campaignStepExecution.findUniqueOrThrow({ where: { id: executionId } })); }
  if (membership.endedAt || membership.status === "STOPPED" || execution.redactedAt)
    return progress(await finish(tx, execution, "CANCELLED", "MEMBERSHIP_INACTIVE", now, now));
  if (membership.status !== "ACTIVE") return progress(await tx.campaignStepExecution.update({ where: { id: executionId },
    data: { reason: "MEMBERSHIP_INACTIVE", nextWakeAt: wake(now, null, 60_000), revision: { increment: 1 } } }));
  if (execution.previousExecutionId) {
    const previous = await tx.campaignStepExecution.findUniqueOrThrow({ where: { id: execution.previousExecutionId } });
    if (!["ACCEPTED", "SKIPPED"].includes(previous.status)) fail("CAMPAIGN_PREDECESSOR_UNRESOLVED", 409, "Resolve the previous campaign step first.");
  }
  if ((step.wait as CampaignWait).kind === "EVENT" && !execution.resolvedAt) execution = await resolveEvent(tx, execution, membership, step, now);
  if (terminal.has(execution.status) || !execution.dueAt || !execution.expiresAt) return progress(execution);
  if (now >= execution.expiresAt) return progress(await finish(tx, execution, "SKIPPED", "STEP_EXPIRED", execution.expiresAt, now));
  if (now < execution.dueAt) return progress(execution);
  if (execution.status === "WAITING") execution = await tx.campaignStepExecution.update({ where: { id: executionId },
    data: { status: "READY", resolvedAt: execution.dueAt, reason: "WAIT_RESOLVED", nextWakeAt: execution.dueAt, revision: { increment: 1 } } });
  return progress(execution);
}

/** Never initializes a manual membership. Advancing a bounded chain cannot reset its anchors. */
export async function ensureCurrentStepTx(tx: Tx, membershipId: string, now: Date, maxLocalAdvances = 10): Promise<CampaignStepExecution | null> {
  let current = await tx.campaignStepExecution.findFirst({ where: { membershipId }, orderBy: { step: { position: "desc" } } });
  for (let count = 0; current && count < Math.min(50, Math.max(1, maxLocalAdvances)); count++) {
    await advanceCurrentStepTx(tx, current.id, now);
    const latest = await tx.campaignStepExecution.findFirstOrThrow({ where: { membershipId }, orderBy: { step: { position: "desc" } } });
    if (latest.id === current.id) return latest;
    current = latest;
  }
  return current;
}

/** Current permission/evidence check reused at the last provider boundary, including already frozen sends. */
export async function checkStepEvidenceTx(tx: Tx, execution: CampaignStepExecution): Promise<{ valid: true } | { valid: false; code: string }> {
  if (!execution.waitSourceId) return { valid: true };
  const source = await tx.trackingSource.findFirst({ where: { id: execution.waitSourceId, ownerId: execution.ownerId,
    environment: execution.environment, status: "ACTIVE", generation: execution.sourceGeneration! } });
  if (!source) return { valid: false, code: "WAIT_SOURCE_UNAVAILABLE" };
  if (!execution.receiptId || !execution.eventId) return { valid: false, code: "WAIT_EVIDENCE_UNRESOLVED" };
  const membership = await tx.campaignMembership.findUniqueOrThrow({ where: { id: execution.membershipId } });
  const receipt = await tx.funnelEvaluationReceipt.findFirst({ where: { id: execution.receiptId, eventId: execution.eventId,
    matchRevision: execution.matchRevision!, ownerId: execution.ownerId, environment: execution.environment,
    mode: "LIVE", sourceGeneration: execution.sourceGeneration!, subjectId: membership.subjectId! } });
  const event = await tx.trackingEvent.findFirst({ where: { id: execution.eventId, ownerId: execution.ownerId, environment: execution.environment,
    sourceId: source.id, sourceGeneration: execution.sourceGeneration!, status: "MATCHED", subjectId: membership.subjectId! } });
  return receipt && event ? { valid: true } : { valid: false, code: "WAIT_EVIDENCE_UNAVAILABLE" };
}

export type ResolvedStepResult = { kind: "READY" | "EXISTING"; execution: CampaignStepExecution; membership: CampaignMembership; step: CampaignStep; dueAt: Date; expiresAt: Date }
  | { kind: "DEFERRED" | "BLOCKED" | "EXPIRED"; code: string; nextWakeAt?: Date };
/** Delivery re-reads this inside the same short transaction that creates/links its one frozen intent. */
export async function readResolvedStepTx(tx: Tx, executionId: string, now: Date): Promise<ResolvedStepResult> {
  await advanceCurrentStepTx(tx, executionId, now);
  const { execution, membership, step } = await context(tx, executionId);
  if (["READY", "SEND_PENDING"].includes(execution.status)) {
    const evidence = await checkStepEvidenceTx(tx, execution);
    if (!evidence.valid) return { kind: "BLOCKED", code: evidence.code };
  }
  if (execution.sendId && execution.dueAt && execution.expiresAt)
    return { kind: "EXISTING", execution, membership, step, dueAt: execution.dueAt, expiresAt: execution.expiresAt };
  if (execution.status === "SKIPPED") return { kind: "EXPIRED", code: execution.reason ?? "STEP_SKIPPED" };
  if (execution.redactedAt || membership.status !== "ACTIVE" || membership.endedAt || ["CANCELLED", "FAILED"].includes(execution.status))
    return { kind: "BLOCKED", code: execution.reason ?? "MEMBERSHIP_INACTIVE" };
  if (execution.status !== "READY" || !execution.dueAt || !execution.expiresAt)
    return { kind: "DEFERRED", code: execution.reason ?? "STEP_WAITING", ...(execution.nextWakeAt ? { nextWakeAt: execution.nextWakeAt } : {}) };
  return { kind: "READY", execution, membership, step, dueAt: execution.dueAt, expiresAt: execution.expiresAt };
}

/** One cadence owner; no sessions, timers, credentials or provider calls. */
export class CampaignStepService {
  private readonly now: () => Date;
  private readonly maximum: number;
  constructor(private readonly db: PrismaClient, options: { now?: () => Date; maxLocalAdvances?: number } = {}) {
    this.now = options.now ?? (() => new Date()); this.maximum = Math.min(50, Math.max(1, options.maxLocalAdvances ?? 10));
  }
  async advance(executionId: string): Promise<StepProgress> {
    return this.db.$transaction(tx => advanceCurrentStepTx(tx, executionId, this.now()));
  }
  async processOnce(): Promise<StepProgress | null> {
    const now = this.now(), hint = await this.db.campaignStepExecution.findFirst({ where: {
      redactedAt: null, OR: [{ status: "WAITING", nextWakeAt: { lte: now } }, { status: "READY", expiresAt: { lte: now } }] }, orderBy: [{ nextWakeAt: "asc" }, { id: "asc" }], select: { id: true, membershipId: true } });
    if (!hint) return null;
    return this.db.$transaction(async tx => {
      const current = await tx.campaignStepExecution.findUnique({ where: { id: hint.id } });
      if (!current || !(current.status === "WAITING" && current.nextWakeAt && current.nextWakeAt <= this.now() ||
        current.status === "READY" && current.expiresAt && current.expiresAt <= this.now())) return null;
      const latest = await ensureCurrentStepTx(tx, hint.membershipId, this.now(), this.maximum);
      return latest ? progress(latest) : null;
    });
  }
}
