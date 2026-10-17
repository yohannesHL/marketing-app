import type { Prisma, PrismaClient, FunnelActionExecution } from "../../generated/prisma/client";
import type { FunnelStageAction } from "./funnelDefinition";
import { stageActionTiming } from "./stageActionPlan";
import { sha256 } from "./trackingValidation";
import { checkEmailEligibility, emailAddressDigest, emailJson, endObsoleteStageReasons, settleReasonlessMemberships } from "../email/emailPolicy";
import { ensureFirstStepTx } from "../email/campaignStepService";

type Tx = Prisma.TransactionClient;

/** Local transactions only: one outbox replaces reasons atomically, never calls a provider. */
export class StageActionService {
  constructor(private readonly db: PrismaClient, private readonly options: { now?: () => Date; liveEnabled?: boolean } = {}) {}
  private now() { return this.options.now?.() ?? new Date(); }
  private async finish(tx: Tx, action: FunnelActionExecution, status: "APPLIED" | "SKIPPED" | "CANCELLED", reason: string, now: Date) {
    return tx.funnelActionExecution.update({ where: { id: action.id }, data: { status, reason,
      evaluationTrace: { decision: reason }, completedAt: now, nextWakeAt: null, revision: { increment: 1 } } });
  }
  private async apply(tx: Tx, action: FunnelActionExecution, now: Date, touched: Set<string>) {
    if (action.status !== "PENDING") return action;
    const plan = action.plan as unknown as FunnelStageAction;
    const journey = await tx.funnelJourney.findUniqueOrThrow({ where: { id: action.journeyId }, include: { funnel: true, subject: true } });
    if (journey.status === "CANCELLED" || action.redactedAt) return this.finish(tx, action, "CANCELLED", "JOURNEY_CANCELLED", now);
    if (plan.kind === "EMAIL_STOP") {
      const reasons = await tx.campaignMembershipReason.findMany({ where: { journeyId: journey.id, campaignId: plan.campaignId, kind: "STAGE", endedAt: null } });
      for (const reason of reasons) {
        await tx.campaignMembershipReason.update({ where: { id: reason.id }, data: { endedAt: now, endReason: "STAGE_STOP_ACTION" } });
        touched.add(reason.membershipId);
      }
      return this.finish(tx, action, "APPLIED", reasons.length ? "STAGE_REASONS_STOPPED" : "NO_STAGE_REASON", now);
    }
    if (action.mode !== "LIVE") return this.finish(tx, action, "SKIPPED", "HISTORY_ONLY", now);
    if (action.expiresAt && now >= action.expiresAt) return this.finish(tx, action, "SKIPPED", "ACTION_EXPIRED", now);
    if (plan.stopOnStageExit && journey.currentStageKey !== plan.stageId) return this.finish(tx, action, "CANCELLED", "STAGE_EXITED", now);
    if (plan.stopOnGoal && await tx.funnelStageTransition.findFirst({ where: { journeyId: journey.id, toStage: { goal: true } } }))
      return this.finish(tx, action, "CANCELLED", "GOAL_REACHED", now);
    if (action.dueAt > now) return action;
    const campaign = await tx.marketingCampaign.findUniqueOrThrow({ where: { id: action.campaignId } });
    const defer = (reason: string) => tx.funnelActionExecution.update({ where: { id: action.id }, data: { reason,
      nextWakeAt: new Date(Math.min(now.getTime() + 60_000, action.expiresAt!.getTime())), revision: { increment: 1 } } });
    if (!journey.funnel.automationEnrolmentEnabled || !campaign.enrolmentEnabled) return defer("ENROLMENT_PAUSED");
    if (campaign.status !== "ACTIVE" || campaign.category !== "EMAIL") return this.finish(tx, action, "SKIPPED", "CAMPAIGN_INACTIVE", now);
    const contact = journey.subject.contactId ? await tx.funnelContact.findUnique({ where: { id: journey.subject.contactId } }) : null;
    if (!contact?.email || contact.deletedAt) return this.finish(tx, action, "SKIPPED", "RECIPIENT_UNAVAILABLE", now);
    const owned = { ownerId: action.ownerId, environment: action.environment };
    const scopeKey = `${campaign.membershipScope}:${campaign.membershipScope === "SUBJECT" ? journey.subjectId : contact.id}`;
    const previous = await tx.campaignMembership.findFirst({ where: { campaignId: campaign.id, scopeKey }, orderBy: { cycle: "desc" } });
    if (previous && (previous.endedAt || previous.status !== "ACTIVE")) return this.finish(tx, action, "SKIPPED", "FINISHED_MEMBERSHIP_REQUIRES_NEW_CYCLE", now);
    const addressDigest = emailAddressDigest(action.ownerId, action.environment, contact.email);
    if (previous && (previous.contactId !== contact.id || previous.addressDigest !== addressDigest)) return this.finish(tx, action, "SKIPPED", "RECIPIENT_CHANGED", now);
    const revision = await tx.campaignRevision.findUniqueOrThrow({ where: { id: previous?.revisionId ?? plan.revisionId }, include: { sender: { include: { connection: { include: { source: true } } } } } });
    const source = revision.sender.connection.source;
    if (source.status !== "ACTIVE") return defer("EMAIL_CONNECTION_UNAVAILABLE");
    if (source.environment === "LIVE" && !this.options.liveEnabled) return defer("EMAIL_LIVE_DISABLED");
    const policy = { ...owned, addressDigest };
    if (await tx.emailSuppression.findFirst({ where: { ...policy, active: true, category: { in: ["*", revision.subscriptionCategory] } } }))
      return this.finish(tx, action, "SKIPPED", "RECIPIENT_SUPPRESSED", now);
    if ((await tx.emailSubscription.findFirst({ where: { ...policy, category: revision.subscriptionCategory } }))?.state !== "OPTED_IN")
      return this.finish(tx, action, "SKIPPED", "CONSENT_REQUIRED", now);
    if (!previous && await tx.campaignMembership.count({ where: { ...policy, endedAt: null } }) >= 200)
      return this.finish(tx, action, "SKIPPED", "RECIPIENT_MEMBERSHIP_LIMIT", now);
    if (previous && await tx.campaignMembershipReason.count({ where: { membershipId: previous.id, endedAt: null } }) >= 100)
      return this.finish(tx, action, "SKIPPED", "MEMBERSHIP_REASON_LIMIT", now);
    const membership = previous ?? await tx.campaignMembership.create({ data: { ...owned, campaignId: campaign.id, revisionId: revision.id,
      scopeKind: campaign.membershipScope, scopeKey, subjectId: campaign.membershipScope === "SUBJECT" ? journey.subjectId : null,
      contactId: contact.id, addressDigest, cycle: 1, startedAt: now, createdAt: now } });
    await tx.funnelActionExecution.update({ where: { id: action.id }, data: { membershipId: membership.id } });
    await tx.campaignMembershipReason.create({ data: { ...owned, membershipId: membership.id, campaignId: campaign.id, requestedRevisionId: plan.revisionId,
      kind: "STAGE", requestKey: `stage:${action.id}`, requestDigest: sha256(JSON.stringify([action.id, plan])), actionExecutionId: action.id,
      journeyId: journey.id, transitionId: action.transitionId, versionId: action.versionId, stageKey: action.stageKey,
      stopOnStageExit: plan.stopOnStageExit, stopOnGoal: plan.stopOnGoal, createdAt: now } });
    // This is an assertion after the equivalent preflight, keeping policy drift fail-closed.
    const eligibility = await checkEmailEligibility(tx, { membershipId: membership.id, now, liveEnabled: !!this.options.liveEnabled, purpose: "ENROL_SCHEDULED" });
    if (!eligibility.eligible) throw new Error(`Scheduled enrollment policy mismatch: ${eligibility.code}`);
    touched.add(membership.id);
    if (!previous) await ensureFirstStepTx(tx, membership.id, { kind: "STAGE", actionExecutionId: action.id }, now);
    const automatic = !previous || await tx.campaignStepExecution.findFirst({ where: { membershipId: membership.id } });
    return this.finish(tx, action, "APPLIED", automatic ? previous ? "SHARED_MEMBERSHIP_RETAINED" : "MEMBERSHIP_ENROLLED" : "MANUAL_CADENCE_REQUIRES_START", now);
  }
  async processOnce() {
    const hint = await this.db.funnelActionOutbox.findFirst({ where: { status: "RECORDED", effectEligibility: { in: ["AUTOMATION", "CANCELLATION_ONLY"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (hint) return this.db.$transaction(async tx => {
      const outbox = await tx.funnelActionOutbox.findUniqueOrThrow({ where: { id: hint.id } });
      if (outbox.status !== "RECORDED") return null;
      const now = this.now();
      // Catch up one bounded DAG journey atomically. A newer committed transition may
      // already be current while its predecessor's outbox is still awaiting consumption.
      const envelopes = await tx.funnelActionOutbox.findMany({ where: { journeyId: outbox.journeyId, status: "RECORDED",
        effectEligibility: { in: ["AUTOMATION", "CANCELLATION_ONLY"] } }, include: { transition: true }, orderBy: { transition: { sequence: "asc" } } });
      const touched = await endObsoleteStageReasons(tx, outbox.journeyId, now);
      for (const envelope of envelopes) {
       const transition = envelope.transition, plan = envelope.payload as unknown as { actions: FunnelStageAction[] };
       for (const action of plan.actions) {
        if (action.kind === "EMAIL_ENROLL" && (envelope.effectEligibility !== "AUTOMATION" || envelope.mode !== "LIVE")) continue;
        const timing = stageActionTiming(action, transition.recordedAt);
        const execution = await tx.funnelActionExecution.create({ data: { ownerId: outbox.ownerId, environment: outbox.environment,
          outboxId: envelope.id, journeyId: outbox.journeyId, transitionId: transition.id, versionId: transition.versionId, stageKey: transition.toStageKey,
          actionKey: action.id, kind: action.kind, campaignId: action.campaignId, requestedRevisionId: action.kind === "EMAIL_ENROLL" ? action.revisionId : null,
          plan: emailJson(action), mode: envelope.mode, ...timing, nextWakeAt: timing.dueAt, createdAt: now } });
        await this.apply(tx, execution, now, touched);
       }
       await tx.funnelActionOutbox.update({ where: { id: envelope.id }, data: { status: "CONSUMED", completedAt: now } });
      }
      // Settle only after all immediate incoming reasons have replaced outgoing reasons.
      await settleReasonlessMemberships(tx, touched, now);
      return { outboxId: outbox.id, status: "CONSUMED" };
    });
    const now = this.now();
    const pending = await this.db.funnelActionExecution.findFirst({ where: { status: "PENDING", OR: [{ nextWakeAt: null }, { nextWakeAt: { lte: now } }] }, orderBy: [{ nextWakeAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (!pending) return null;
    return this.db.$transaction(async tx => {
      const action = await tx.funnelActionExecution.findUniqueOrThrow({ where: { id: pending.id } });
      if (action.status !== "PENDING") return null;
      const touched = await endObsoleteStageReasons(tx, action.journeyId, now);
      // A previously delayed replacement cannot revive a scope whose last reason has now ended.
      await settleReasonlessMemberships(tx, touched, now);
      const result = await this.apply(tx, await tx.funnelActionExecution.findUniqueOrThrow({ where: { id: action.id } }), now, touched);
      await settleReasonlessMemberships(tx, touched, now);
      return { actionId: result.id, status: result.status, reason: result.reason };
    });
  }
}
