import type { Prisma } from "../../generated/prisma/client";
import { aggregateSocialPostStatus } from "./aggregate";

/** Cancelling local work cannot withdraw a provider request already sent. */
export async function cancelSocialDeliveries(tx: Prisma.TransactionClient, authorizationIds: string[],
  reason: string, now: Date, destinationIds?: string[]) {
  if (!authorizationIds.length) return;
  if (destinationIds && !destinationIds.length) return;
  const where: Prisma.SocialDeliveryWhereInput = { destination: { authorizationId: { in: authorizationIds } },
    ...(destinationIds ? { destinationId: { in: destinationIds } } : {}),
    status: { in: ["QUEUED", "LEASED", "RETRY_WAIT", "FAILED", "BLOCKED", "UNCERTAIN"] } };
  const affected = await tx.socialDelivery.findMany({ where, select: { id: true, postId: true } });
  await tx.socialDelivery.updateMany({ where: { ...where,
    publishStartedAt: null, phase: { not: "PUBLISH" }, status: { not: "UNCERTAIN", in: ["QUEUED", "LEASED", "RETRY_WAIT", "FAILED", "BLOCKED"] } },
    data: { status: "CANCELLED", cancellationRequested: true, errorCode: reason,
      leaseTokenHash: null, leaseUntil: null, completedAt: now } });
  await tx.socialDelivery.updateMany({ where: { ...where,
    OR: [{ publishStartedAt: { not: null } }, { phase: "PUBLISH" }, { status: "UNCERTAIN" }] },
    data: { status: "UNCERTAIN", cancellationRequested: true, errorCode: reason } });
  await tx.socialDeliveryAttempt.updateMany({ where: { status: "RUNNING",
    delivery: { id: { in: affected.map((item) => item.id) }, status: "CANCELLED" } },
    data: { status: "CANCELLED", errorCode: reason, endedAt: now } });
  for (const postId of new Set(affected.map((item) => item.postId))) await aggregateSocialPostStatus(tx, postId);
}
