import type { Prisma, TrackingEvent } from "../../generated/prisma/client";

/** Matching and dispatch commit together, including matches repaired long after receipt. */
export async function enqueueFunnelEvaluation(tx: Prisma.TransactionClient, event: TrackingEvent, now: Date) {
  if (event.status !== "MATCHED" || !event.subjectId) throw new Error("Only matched evidence can be evaluated.");
  const updated = await tx.trackingEvent.update({ where: { id: event.id }, data: { matchRevision: { increment: 1 } } });
  await tx.funnelEvaluationReceipt.create({ data: { ownerId: event.ownerId, environment: event.environment,
    eventId: event.id, matchRevision: updated.matchRevision, subjectId: event.subjectId, sourceGeneration: event.sourceGeneration,
    mode: event.processingMode, status: "PENDING", createdAt: now } });
  return updated;
}

/** Called inside contact deletion's transaction before the tracking identity fences are removed. */
export async function eraseFunnelSubjects(tx: Prisma.TransactionClient, subjectIds: string[], now: Date) {
  await tx.funnelEvaluationReceipt.updateMany({ where: { subjectId: { in: subjectIds }, status: "PENDING" },
    data: { status: "CANCELLED", reason: "CONTACT_DELETED", completedAt: now } });
  const journeys = await tx.funnelJourney.findMany({ where: { subjectId: { in: subjectIds } }, select: { id: true } });
  const journeyIds = journeys.map(j => j.id);
  await tx.funnelActionExecution.updateMany({ where: { journeyId: { in: journeyIds }, status: "PENDING" },
    data: { status: "CANCELLED", reason: "CONTACT_DELETED", completedAt: now, nextWakeAt: null, revision: { increment: 1 } } });
  await tx.funnelActionExecution.updateMany({ where: { journeyId: { in: journeyIds }, redactedAt: null },
    data: { evaluationTrace: {}, redactedAt: now } });
  await tx.funnelActionOutbox.updateMany({ where: { journeyId: { in: journeyIds }, completedAt: null },
    data: { status: "CANCELLED", payload: {}, completedAt: now } });
  await tx.funnelActionOutbox.updateMany({ where: { journeyId: { in: journeyIds }, completedAt: { not: null } },
    data: { status: "CANCELLED", payload: {} } });
  await tx.funnelJourney.updateMany({ where: { subjectId: { in: subjectIds }, status: "ACTIVE" },
    data: { status: "CANCELLED", endedAt: now, revision: { increment: 1 } } });
  await tx.funnelPropertySnapshot.deleteMany({ where: { subjectId: { in: subjectIds } } });
  await tx.funnelStageTransition.updateMany({ where: { journeyId: { in: journeyIds }, redactedAt: null },
    data: { note: null, evaluationTrace: {}, redactedAt: now } });
}
